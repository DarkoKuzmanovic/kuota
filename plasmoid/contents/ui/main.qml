import QtQuick
import org.kde.plasma.plasmoid 2.1
import org.kde.kirigami 2.20 as Kirigami

import "snapshot-state.js" as SnapshotState
import "compact-model.js" as CompactModel
import "config-model.js" as ConfigModel

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

    // Test seam (M9.3): `plasmoid` is null whenever this file is loaded
    // outside a real Applet host (e.g. the offscreen Loader-based Qt Test
    // harness — verified empirically, kf.plasma.quick logs "PlasmoidItem
    // which is not the root QML item"). Production leaves this null so live
    // plasmoid.configuration applies; tests set it to inject fake settings.
    property var configOverride: null

    readonly property var rawConfig: configOverride !== null
        ? configOverride
        : ((plasmoid !== null && plasmoid !== undefined) ? plasmoid.configuration : null)

    // Read-boundary sanitization (D6): every semantic constraint (refresh
    // floor, threshold clamp/order, garbage fallback) is enforced once here
    // via config-model.js before any value reaches the compact/full models.
    readonly property var sanitizedSettings: ConfigModel.sanitize(root.rawConfig)

    readonly property string compactDisplayMode: root.sanitizedSettings.displayMode

    readonly property var compactDisplayConfig: {
        var assembled = ConfigModel.assembleDisplayConfig(root.sanitizedSettings);
        return {
            order: assembled.order,
            visibility: assembled.visibility,
            metric: assembled.metric,
            window: assembled.window,
            cautionThreshold: root.sanitizedSettings.cautionThreshold,
            criticalThreshold: root.sanitizedSettings.criticalThreshold
        };
    }

    readonly property var fullThresholds: {
        return {
            caution: root.sanitizedSettings.cautionThreshold,
            critical: root.sanitizedSettings.criticalThreshold
        };
    }

    // Test-only visibility into the live-bound timer interval.
    readonly property alias refreshTimerInterval: _refreshTimer.interval

    Timer {
        id: _refreshTimer
        interval: root.sanitizedSettings.refreshIntervalMinutes * 60 * 1000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: root.refresh()
    }

    compactRepresentation: CompactRepresentation {
        snapshot: root.snapshot
        displayConfig: root.compactDisplayConfig
        compactDisplayMode: root.compactDisplayMode
        separator: root.sanitizedSettings.separator
        fontScale: root.sanitizedSettings.fontScale
        appearance: root.sanitizedSettings
        fontFamily: root.sanitizedSettings.fontFamily
        iconLabelSpacing: root.sanitizedSettings.iconLabelSpacing
        labelValueSpacing: root.sanitizedSettings.labelValueSpacing
        onRequestExpand: root.expanded = true
    }

    fullRepresentation: FullRepresentation {
        snapshot: root.snapshot
        inFlight: root.inFlight
        providerOrder: root.compactDisplayConfig.order
        thresholds: root.fullThresholds
        showCountdown: root.sanitizedSettings.showCountdown
        appearance: root.sanitizedSettings
        fontFamily: root.sanitizedSettings.fontFamily
        onRequestRefresh: root.refresh()
    }
}
