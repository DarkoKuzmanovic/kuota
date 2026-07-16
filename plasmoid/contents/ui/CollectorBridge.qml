import QtQuick
import org.kde.plasma.plasma5support as Plasma5Support

import "collector-command.js" as CollectorCommand
import "bridge-lifecycle.js" as BridgeLifecycle
import "collector-validator.js" as CollectorValidator
import "snapshot-state.js" as SnapshotState

// The only production component allowed to import the Plasma executable
// compatibility plugin. It launches the bundled collector as a short-lived
// process, tracks exactly one in-flight request by an exact source token so
// a timed-out prior run can never satisfy a later refresh, and hands the
// bounded, whole-document-validated result to the Plasma-independent
// snapshot-state model. It never reads stderr and never exposes anything
// but the accepted/retained snapshot state.
QtObject {
    id: root

    // Bounded dependency overrides for tests only. Production code must
    // never set these; the fixed node runtime path is never configurable.
    property string collectorPathOverride: ""
    property int bridgeTimeoutMsOverride: 0

    readonly property string collectorPath: collectorPathOverride.length > 0
        ? collectorPathOverride
        : _defaultCollectorPath()
    readonly property int bridgeTimeoutMs: bridgeTimeoutMsOverride > 0 ? bridgeTimeoutMsOverride : 15000

    readonly property bool inFlight: BridgeLifecycle.isInFlight(_requestState)
    property var snapshotState: SnapshotState.createInitialSnapshotState()

    property var _requestState: BridgeLifecycle.createRequestState()

    function _defaultCollectorPath() {
        var url = Qt.resolvedUrl("../code/collector/cli.js").toString();
        return url.indexOf("file://") === 0 ? url.slice("file://".length) : url;
    }

    // enabledProviders: undefined selects collector defaults (all
    // providers, no argument); an array selects exactly that allowlisted,
    // canonically ordered subset (which may be empty).
    function refresh(enabledProviders) {
        var attempt = BridgeLifecycle.beginRequest(_requestState);
        if (!attempt.started) {
            return false;
        }

        var built = CollectorCommand.buildCollectorCommand({
            collectorPath: collectorPath,
            enabledProviders: enabledProviders,
            sourceId: attempt.sourceId
        });
        if (!built.ok) {
            _requestState = BridgeLifecycle.advanceSourceCounter(_requestState, attempt.sourceId);
            snapshotState = SnapshotState.retainOnProcessError(snapshotState);
            return false;
        }

        _requestState = BridgeLifecycle.activate(_requestState, attempt.sourceId, built.value);
        _deadlineTimer.interval = bridgeTimeoutMs;
        _deadlineTimer.restart();
        _executable.connectSource(built.value);
        return true;
    }

    function _handleNewData(sourceName, data) {
        if (!BridgeLifecycle.isActiveToken(_requestState, sourceName)) {
            _executable.disconnectSource(sourceName);
            return;
        }
        _deadlineTimer.stop();
        _executable.disconnectSource(sourceName);
        _requestState = BridgeLifecycle.clearIfActive(_requestState, sourceName);
        _settle(data);
    }

    function _settle(data) {
        var interpreted = BridgeLifecycle.interpretProcessResult(data);
        if (interpreted.outcome === BridgeLifecycle.PROCESS_OUTCOME.PROCESS_FAILURE) {
            snapshotState = SnapshotState.retainOnProcessError(snapshotState);
            return;
        }
        if (interpreted.outcome === BridgeLifecycle.PROCESS_OUTCOME.OVERSIZED_STDOUT) {
            snapshotState = SnapshotState.retainOnInvalidDocument(snapshotState);
            return;
        }

        var validated = CollectorValidator.validateCollectorResponse(interpreted.stdout);
        if (!validated.ok) {
            snapshotState = SnapshotState.retainOnInvalidDocument(snapshotState);
            return;
        }
        snapshotState = SnapshotState.acceptSnapshot(snapshotState, validated.value, Date.now());
    }

    function _handleTimeout() {
        var token = _requestState.activeToken;
        if (token === null || !BridgeLifecycle.isActiveToken(_requestState, token)) {
            return;
        }
        _executable.disconnectSource(token);
        _requestState = BridgeLifecycle.clearIfActive(_requestState, token);
        snapshotState = SnapshotState.retainOnTimeout(snapshotState);
    }

    // QtObject has no default child-list property, so the executable
    // engine and deadline timer are held as ordinary properties rather
    // than declared as implicit children.
    property var _executable: Plasma5Support.DataSource {
        engine: "executable"
        onNewData: function (sourceName, data) {
            root._handleNewData(sourceName, data);
        }
    }

    property var _deadlineTimer: Timer {
        repeat: false
        onTriggered: root._handleTimeout()
    }
}
