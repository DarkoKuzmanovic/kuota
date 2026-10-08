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
        compare(bridge.snapshotState.snapshot.providers.length, 5);
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

    // D-R7.3 replaces the old empty-process success expectation: no observation
    // was made, so even a valid empty collector response must not be fabricated.
    function test_emptyProviderSetNeverLaunchesOrInventsObservation() {
        bridge.collectorPathOverride = fixturePath("success.js");
        var nextSourceId = bridge._requestState.nextSourceId;
        compare(bridge.refresh([]), false);
        compare(bridge.inFlight, false);
        compare(bridge._requestState.nextSourceId, nextSourceId);
        compare(bridge._executable.connectedSources.length, 0);
        compare(bridge.snapshotState.snapshot, null);
        compare(bridge.snapshotState.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.INITIAL);
        wait(100);
        compare(bridge.snapshotState.snapshot, null);
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

    // D-R7: real Plasma executable completions, with no auth/network work.
    function test_selectionChangesCoalesceAcrossRealProcessOutcomes_data() {
        return [
            {tag: "success", fixture: "slow.js", timeout: 5000},
            {tag: "failure", fixture: "nonzero-exit.js", timeout: 5000},
            {tag: "invalid", fixture: "malformed-output.js", timeout: 5000},
            {tag: "timeout", fixture: "slow.js", timeout: 50}
        ];
    }
    function test_selectionChangesCoalesceAcrossRealProcessOutcomes(data) {
        bridge.collectorPathOverride = fixturePath(data.fixture);
        bridge.bridgeTimeoutMsOverride = data.timeout;
        verify(bridge.refresh(["claude"]));
        var old = bridge._requestState.activeToken;
        bridge.collectorPathOverride = fixturePath("success.js");
        bridge.bridgeTimeoutMsOverride = 5000;
        compare(bridge.refresh(["codex"]), false);
        compare(bridge.refresh([]), false);
        compare(bridge.refresh(["commandcode", "grok"]), false);
        compare(bridge._requestState.activeToken, old);
        compare(bridge._requestState.nextSourceId, 2);
        tryVerify(function() { return !bridge.inFlight && bridge.snapshotState.snapshot !== null; }, 5000);
        compare(bridge.snapshotState.snapshot.providers.map(function(p) { return p.id; }), ["grok", "commandcode"]);
        compare(bridge._requestState.nextSourceId, 3);
        // Exactly the new selection was published, never an intermediate result.
        compare(spy.count, 1);
        if (data.tag === "timeout") wait(600);
        compare(spy.count, 1);
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
