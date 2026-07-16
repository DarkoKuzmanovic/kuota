import QtQuick
import org.kde.plasma.plasmoid 2.1
import org.kde.kirigami 2.20 as Kirigami

import "snapshot-state.js" as SnapshotState
import "compact-model.js" as CompactModel

PlasmoidItem {
    id: root

    readonly property var snapshot: _bridge.snapshotState.snapshot
    readonly property string lifecycleStatus: _bridge.snapshotState.lifecycleStatus
    readonly property bool inFlight: _bridge.inFlight

    function refresh() {
        _bridge.refresh();
    }

    function snapshotAgeMs() {
        return SnapshotState.getSnapshotAgeMs(_bridge.snapshotState, Date.now());
    }

    CollectorBridge {
        id: _bridge
    }

    Timer {
        id: _refreshTimer
        interval: 5 * 60 * 1000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: root.refresh()
    }

    property string compactDisplayMode: "icons+text"
    property var compactDisplayConfig: CompactModel.createDefaultDisplayConfig()

    compactRepresentation: CompactRepresentation {
        snapshot: root.snapshot
        displayConfig: root.compactDisplayConfig
        compactDisplayMode: root.compactDisplayMode
        onRequestExpand: root.expanded = true
    }

    fullRepresentation: FullRepresentation {
        snapshot: root.snapshot
        inFlight: root.inFlight
        onRequestRefresh: root.refresh()
    }
}
