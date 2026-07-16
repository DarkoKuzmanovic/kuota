import QtQuick
import QtTest

import "../../plasmoid/contents/ui/snapshot-state.js" as SnapshotState

TestCase {
    name: "SnapshotState"

    function sampleDocument(overrides) {
        var document = {
            schemaVersion: 1,
            collectionStartedAt: "2026-07-11T10:00:00.000Z",
            collectionFinishedAt: "2026-07-11T10:00:01.000Z",
            providers: []
        };
        if (overrides) {
            for (var key in overrides) {
                if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                    document[key] = overrides[key];
                }
            }
        }
        return document;
    }

    function test_initialStateHasNoSnapshot() {
        var state = SnapshotState.createInitialSnapshotState();
        compare(state.snapshot, null);
        compare(state.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.INITIAL);
    }

    function test_acceptSnapshotReplacesStateAndRecordsAcceptedTime() {
        var initial = SnapshotState.createInitialSnapshotState();
        var document = sampleDocument();
        var next = SnapshotState.acceptSnapshot(initial, document, 1000);
        compare(next.snapshot, document);
        compare(next.acceptedAtMs, 1000);
        compare(next.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.ACCEPTED);
    }

    function test_secondAcceptReplacesPriorSnapshotEntirely() {
        var initial = SnapshotState.createInitialSnapshotState();
        var first = SnapshotState.acceptSnapshot(initial, sampleDocument({ providers: [{ id: "claude", state: "ok" }] }), 1000);
        var second = SnapshotState.acceptSnapshot(first, sampleDocument({ providers: [{ id: "umans", state: "ok" }] }), 2000);
        compare(second.snapshot.providers.length, 1);
        compare(second.snapshot.providers[0].id, "umans");
        compare(second.acceptedAtMs, 2000);
    }

    function test_retainOnInvalidKeepsExactPriorSnapshotReference() {
        var initial = SnapshotState.createInitialSnapshotState();
        var document = sampleDocument();
        var accepted = SnapshotState.acceptSnapshot(initial, document, 1000);
        var retained = SnapshotState.retainOnInvalidDocument(accepted);
        compare(retained.snapshot, document);
        compare(retained.acceptedAtMs, 1000);
        compare(retained.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_INVALID);
    }

    function test_retainOnProcessErrorKeepsExactPriorSnapshotReference() {
        var initial = SnapshotState.createInitialSnapshotState();
        var document = sampleDocument();
        var accepted = SnapshotState.acceptSnapshot(initial, document, 1000);
        var retained = SnapshotState.retainOnProcessError(accepted);
        compare(retained.snapshot, document);
        compare(retained.acceptedAtMs, 1000);
        compare(retained.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_ERROR);
    }

    function test_retainOnTimeoutKeepsExactPriorSnapshotReference() {
        var initial = SnapshotState.createInitialSnapshotState();
        var document = sampleDocument();
        var accepted = SnapshotState.acceptSnapshot(initial, document, 1000);
        var retained = SnapshotState.retainOnTimeout(accepted);
        compare(retained.snapshot, document);
        compare(retained.acceptedAtMs, 1000);
        compare(retained.lifecycleStatus, SnapshotState.LIFECYCLE_STATUS.RETAINED_TIMEOUT);
    }

    function test_retainFunctionsNeverInventSnapshotWhenNoneExisted() {
        var initial = SnapshotState.createInitialSnapshotState();
        var retained = SnapshotState.retainOnInvalidDocument(initial);
        compare(retained.snapshot, null);
        compare(retained.acceptedAtMs, null);
    }

    function test_lifecycleStatusValuesAreConstantStrings() {
        var statuses = SnapshotState.LIFECYCLE_STATUS;
        for (var key in statuses) {
            if (Object.prototype.hasOwnProperty.call(statuses, key)) {
                compare(typeof statuses[key], "string");
            }
        }
    }

    // --- Stale age with injectable time ------------------------------------

    function test_snapshotAgeIsUndefinedWithoutASnapshot() {
        var initial = SnapshotState.createInitialSnapshotState();
        var age = SnapshotState.getSnapshotAgeMs(initial, 5000);
        compare(age, undefined);
    }

    function test_snapshotAgeProgressesWithInjectedNow() {
        var initial = SnapshotState.createInitialSnapshotState();
        var accepted = SnapshotState.acceptSnapshot(initial, sampleDocument(), 1000);
        compare(SnapshotState.getSnapshotAgeMs(accepted, 1000), 0);
        compare(SnapshotState.getSnapshotAgeMs(accepted, 4500), 3500);
    }

    function test_snapshotAgeClampsAtZeroForNowBeforeAccepted() {
        var initial = SnapshotState.createInitialSnapshotState();
        var accepted = SnapshotState.acceptSnapshot(initial, sampleDocument(), 5000);
        compare(SnapshotState.getSnapshotAgeMs(accepted, 1000), 0);
    }

    function test_snapshotAgeSurvivesRetentionAcrossFailures() {
        var initial = SnapshotState.createInitialSnapshotState();
        var accepted = SnapshotState.acceptSnapshot(initial, sampleDocument(), 1000);
        var retained = SnapshotState.retainOnTimeout(accepted);
        compare(SnapshotState.getSnapshotAgeMs(retained, 6000), 5000);
    }
}
