import QtQuick
import QtTest
import "../../plasmoid/contents/ui" as Bridge

// D-R7.4/5: deterministic event scheduling at the existing executable seam.
// Real argv/process coverage remains in tst_collector_bridge_process.qml.
TestCase {
    id: testCase
    name: "CollectorBridgeSelection"
    when: windowShown
    property var bridge
    property var source

    Component { id: bridgeComponent; Bridge.CollectorBridge {} }
    Component {
        id: sourceComponent
        QtObject {
            property var launches: []
            property var disconnects: []
            function connectSource(token) { launches = launches.concat([token]); }
            function disconnectSource(token) { disconnects = disconnects.concat([token]); }
        }
    }
    function init() {
        source = sourceComponent.createObject(testCase);
        bridge = bridgeComponent.createObject(testCase, { _executable: source });
    }
    function cleanup() { bridge.destroy(); source.destroy(); }
    function result(ids) {
        return { "exit code": 0, "exit status": 0, stdout: JSON.stringify({
            schemaVersion: 2,
            collectionStartedAt: "2026-09-09T00:00:00.000Z",
            collectionFinishedAt: "2026-09-09T00:00:00.000Z",
            providers: ids.map(function(id) { return { id: id, state: "auth-needed" }; })
        }) };
    }
    function ids() { return bridge.snapshotState.snapshot.providers.map(function(p) { return p.id; }); }

    function test_idleChangeClearsIncompatibleSnapshotAndSameSelectionRetainsFailure() {
        verify(bridge.refresh(["claude"]));
        bridge._handleNewData(source.launches[0], result(["claude"]));
        compare(ids(), ["claude"]);
        verify(bridge.refresh(["codex"]));
        compare(bridge.snapshotState.snapshot, null);
        compare(bridge.snapshotState.acceptedAtMs, null);
        bridge._handleNewData(source.launches[1], result(["codex"]));
        var prior = bridge.snapshotState.snapshot;
        verify(bridge.refresh(["codex"]));
        compare(bridge.refresh(["codex"]), false);
        bridge._handleNewData(source.launches[2], { "exit code": 1 });
        compare(bridge.snapshotState.snapshot, prior);
        compare(source.launches.length, 3);
    }

    function test_changesWaitForOwnershipThenCoalesce_data() {
        return [{tag: "success"}, {tag: "failure"}, {tag: "invalid"}, {tag: "timeout"}];
    }
    function test_changesWaitForOwnershipThenCoalesce(data) {
        verify(bridge.refresh(["claude"]));
        var old = source.launches[0];
        var deadlineRunning = bridge._deadlineTimer.running;
        compare(bridge.refresh(["codex"]), false);
        compare(bridge.refresh([]), false);
        compare(bridge.refresh(["grok", "codex"]), false);
        compare(bridge._requestState.activeToken, old);
        compare(bridge.inFlight, true);
        compare(bridge._deadlineTimer.running, deadlineRunning);
        compare(source.disconnects.length, 0);
        compare(source.launches.length, 1);
        if (data.tag === "timeout") bridge._handleTimeout();
        else bridge._handleNewData(old, data.tag === "success" ? result(["claude"])
                                  : data.tag === "invalid" ? {"exit code": 0, "exit status": 0, stdout: "not synthetic JSON"}
                                  : {"exit code": 1});
        compare(source.launches.length, 2);
        verify(source.launches[1].indexOf(" --enabled-providers=codex,grok # ") !== -1);
        compare(bridge.snapshotState.snapshot, null);
        compare(bridge.snapshotState.acceptedAtMs, null);
        compare(bridge.inFlight, true);
        var latest = bridge._requestState.activeToken;
        bridge._handleNewData(old, result(["claude"]));
        compare(bridge._requestState.activeToken, latest);
        compare(bridge._deadlineTimer.running, true);
        compare(bridge.snapshotState.snapshot, null);
        bridge._handleNewData(latest, result(["codex", "grok"]));
        compare(ids(), ["codex", "grok"]);
        compare(source.launches.length, 2);
        compare(bridge.inFlight, false);
    }

    function test_returningToAStillRejectsOriginalA() {
        bridge.refresh(["claude"]);
        var old = source.launches[0];
        bridge.refresh(["codex"]);
        bridge.refresh(["claude"]);
        bridge._handleNewData(old, result(["claude"]));
        compare(bridge.snapshotState.snapshot, null);
        compare(source.launches.length, 2);
        verify(source.launches[1] !== old);
        bridge._handleNewData(source.launches[1], result(["claude"]));
        compare(ids(), ["claude"]);
    }

    function test_disableActiveSettlesWithoutNewProcessThenReenable() {
        bridge.refresh(["claude"]);
        var old = source.launches[0];
        bridge.refresh([]);
        compare(bridge.inFlight, true);
        compare(source.disconnects.length, 0);
        bridge._handleNewData(old, result(["claude"]));
        compare(source.launches.length, 1);
        compare(bridge.inFlight, false);
        compare(bridge.snapshotState.snapshot, null);
        compare(bridge.snapshotState.acceptedAtMs, null);
        compare(bridge.refresh([]), false);
        verify(bridge.refresh(["codex"]));
        compare(source.launches.length, 2);
    }

    function test_reorderDoesNotInvalidateOrScheduleOrdinaryRefresh() {
        bridge.refresh(["grok", "claude"]);
        var old = source.launches[0];
        compare(bridge.refresh(["claude", "grok"]), false);
        bridge._handleNewData(old, result(["claude", "grok"]));
        compare(ids(), ["claude", "grok"]);
        compare(source.launches.length, 1);
    }

    function test_independentInstancesKeepTheirOwnSelectionAndSourceOwnership() {
        var otherSource = sourceComponent.createObject(testCase);
        var other = bridgeComponent.createObject(testCase, { _executable: otherSource });
        try {
            bridge.refresh(["claude"]);
            other.refresh(["codex"]);
            bridge.refresh([]);
            other._handleNewData(otherSource.launches[0], result(["codex"]));
            bridge._handleNewData(source.launches[0], result(["claude"]));
            compare(other.snapshotState.snapshot.providers[0].id, "codex");
            compare(bridge.snapshotState.snapshot, null);
            compare(source.launches.length, 1);
            compare(otherSource.launches.length, 1);
        } finally { other.destroy(); otherSource.destroy(); }
    }
}
