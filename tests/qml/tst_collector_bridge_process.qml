import QtQuick
import QtTest

import "../../plasmoid/contents/ui" as Bridge
import "../../plasmoid/contents/ui/snapshot-state.js" as SnapshotState

TestCase {
    id: testCase
    name: "CollectorBridgeProcess"
    when: windowShown

    property string fixtureDir: Qt.resolvedUrl("fixtures/collector/").toString().replace("file://", "")
    property var bridge: null
    property var spy: null

    function fixturePath(name) {
        return fixtureDir + name;
    }

    Component {
        id: bridgeComponent
        Bridge.CollectorBridge {}
    }

    function init() {
        bridge = bridgeComponent.createObject(testCase);
        spy = Qt.createQmlObject(
            'import QtTest; SignalSpy { }',
            testCase,
            "dynamicSpy"
        );
        spy.target = bridge;
        spy.signalName = "snapshotStateChanged";
    }

    function cleanup() {
        if (bridge !== null) {
            bridge.destroy();
            bridge = null;
        }
        spy = null;
    }

    function readLocalFile(path) {
        var request = new XMLHttpRequest();
        request.open("GET", "file://" + path, false);
        request.send(null);
        return request.status;
    }

    // --- Default packaged path -------------------------------------------

    function test_defaultCollectorPathResolvesToPackagedLocation() {
        verify(bridge.collectorPath.length > 0);
        verify(bridge.collectorPath.indexOf("contents/code/collector/cli.js") !== -1);
    }

    // --- Real process success paths ---------------------------------------

    function test_successfulRunAcceptsCanonicalSnapshot() {
        bridge.collectorPathOverride = fixturePath("success.js");
        bridge.bridgeTimeoutMsOverride = 5000;

        verify(bridge.refresh());
        compare(bridge.inFlight, true);
        spy.wait(5000);

        compare(bridge.inFlight, false);
        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.ACCEPTED);
        compare(bridge.snapshotState.snapshot.providers.length, 4);
    }

    function test_partialProviderSuccessReflectsRequestedSubset() {
        bridge.collectorPathOverride = fixturePath("success.js");
        bridge.bridgeTimeoutMsOverride = 5000;

        verify(bridge.refresh(["claude"]));
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.ACCEPTED);
        compare(bridge.snapshotState.snapshot.providers.length, 1);
        compare(bridge.snapshotState.snapshot.providers[0].id, "claude");
    }

    function test_emptyProviderSetSucceedsWithNoProviders() {
        bridge.collectorPathOverride = fixturePath("success.js");
        bridge.bridgeTimeoutMsOverride = 5000;

        verify(bridge.refresh([]));
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.ACCEPTED);
        compare(bridge.snapshotState.snapshot.providers.length, 0);
    }

    // --- Real process failure paths retain the prior snapshot ---------------

    function acceptOnceSuccessfully() {
        bridge.collectorPathOverride = fixturePath("success.js");
        bridge.bridgeTimeoutMsOverride = 5000;
        verify(bridge.refresh());
        spy.wait(5000);
        return bridge.snapshotState.snapshot;
    }

    function test_nonzeroExitRetainsPriorSnapshotAsProcessError() {
        var priorSnapshot = acceptOnceSuccessfully();

        spy.clear();
        bridge.collectorPathOverride = fixturePath("nonzero-exit.js");
        verify(bridge.refresh());
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_ERROR);
        compare(bridge.snapshotState.snapshot, priorSnapshot);
    }

    function test_crashRetainsPriorSnapshotAsProcessError() {
        var priorSnapshot = acceptOnceSuccessfully();

        spy.clear();
        bridge.collectorPathOverride = fixturePath("crash.js");
        verify(bridge.refresh());
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_ERROR);
        compare(bridge.snapshotState.snapshot, priorSnapshot);
    }

    function test_malformedOutputRetainsPriorSnapshotAsInvalid() {
        var priorSnapshot = acceptOnceSuccessfully();

        spy.clear();
        bridge.collectorPathOverride = fixturePath("malformed-output.js");
        verify(bridge.refresh());
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_INVALID);
        compare(bridge.snapshotState.snapshot, priorSnapshot);
    }

    function test_oversizedStdoutRetainsPriorSnapshotWithoutValidating() {
        var priorSnapshot = acceptOnceSuccessfully();

        spy.clear();
        bridge.collectorPathOverride = fixturePath("oversized-output.js");
        verify(bridge.refresh());
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_INVALID);
        compare(bridge.snapshotState.snapshot, priorSnapshot);
    }

    // --- Non-overlap -------------------------------------------------------

    function test_secondRefreshIsIgnoredWhileFirstIsInFlight() {
        bridge.collectorPathOverride = fixturePath("slow.js");
        bridge.bridgeTimeoutMsOverride = 5000;

        verify(bridge.refresh());
        compare(bridge.refresh(), false);
        compare(bridge.inFlight, true);

        spy.wait(5000);
        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.ACCEPTED);
    }

    // --- Timeout, late-result rejection, and retry --------------------------

    function test_timeoutRetainsSnapshotAndIgnoresLateResultThenAllowsRetry() {
        bridge.collectorPathOverride = fixturePath("slow.js");
        bridge.bridgeTimeoutMsOverride = 100;

        verify(bridge.refresh());
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_TIMEOUT);
        compare(bridge.inFlight, false);
        var afterTimeoutState = bridge.snapshotState;

        // Wait past the fixture's own real completion time (400ms). Even if
        // the now-disconnected process still finished, its result must never
        // reach this stale request.
        spy.clear();
        wait(700);
        compare(spy.count, 0);
        compare(bridge.snapshotState, afterTimeoutState);
        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_TIMEOUT);

        // Retry must be permitted and must succeed cleanly.
        spy.clear();
        bridge.collectorPathOverride = fixturePath("success.js");
        bridge.bridgeTimeoutMsOverride = 5000;
        verify(bridge.refresh());
        spy.wait(5000);

        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.ACCEPTED);
    }

    // --- Command injection safety through the real bridge -------------------

    function test_injectionAttemptInCollectorPathNeverExecutes() {
        var markerPath = fixtureDir + "pwned-marker-should-never-exist.txt";
        bridge.collectorPathOverride = fixtureDir + "success.js'; touch " + markerPath + "; echo '.js";
        bridge.bridgeTimeoutMsOverride = 5000;

        verify(bridge.refresh());
        spy.wait(5000);

        // Node fails to find the (nonexistent, literally single-quoted)
        // path, which must surface as a safe process failure -- never a
        // schema acceptance -- and the injected shell command must never
        // have executed.
        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_ERROR);
        compare(bridge.snapshotState.snapshot, null);
        verify(readLocalFile(markerPath) !== 200, "injected command must not have created a marker file");
    }

    function test_bridgeFailsClosedForControlCharacterPathWithoutLaunchingProcess() {
        bridge.collectorPathOverride = "/tmp/kuota-does-not-matter\n.js";
        bridge.bridgeTimeoutMsOverride = 5000;

        compare(bridge.refresh(), false);
        compare(bridge.inFlight, false);
        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_ERROR);
    }
}
