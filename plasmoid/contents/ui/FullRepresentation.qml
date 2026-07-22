import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as Controls
import org.kde.kirigami 2.20 as Kirigami

import "full-model.js" as FullModel

FocusScope {
    id: fullRoot

    property var snapshot: null
    property bool inFlight: false
    property real nowMs: Date.now()
    property bool autoAdvanceClock: true
    property var providerOrder: ["claude", "umans", "codex"]
    // Injected caution/critical thresholds (M9, D5). Defaults preserve M8's
    // 75/90 behavior for standalone instantiation (e.g. existing tests that
    // never set this).
    property var thresholds: ({ caution: 75, critical: 90 })
    // Gates the live reset countdown text (M9, D8). The reset timestamp
    // itself may still show; only the ticking "Resets in …" phrase is hidden.
    property bool showCountdown: true
    // Appearance overrides (M12 theming). `null` reproduces V1 exactly;
    // main.qml passes the sanitized settings. `fontFamily` "" means the
    // theme default font.
    property var appearance: null
    property string fontFamily: ""
    readonly property string effectiveFontFamily: fontFamily !== "" ? fontFamily : Kirigami.Theme.defaultFont.family

    signal requestRefresh()

    implicitWidth: Kirigami.Units.gridUnit * 22
    implicitHeight: Kirigami.Units.gridUnit * 24

    readonly property alias refreshButtonItem: refreshButton
    readonly property alias providerSwitcherItem: providerSwitcher

    readonly property var providerRecords: (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.providers))
        ? snapshot.providers
        : []

    function findRecord(providerId) {
        for (var i = 0; i < providerRecords.length; i++) {
            if (providerRecords[i] && providerRecords[i].id === providerId) {
                return providerRecords[i];
            }
        }
        return null;
    }

    readonly property var availableProviderIds: {
        var ids = [];
        for (var i = 0; i < providerOrder.length; i++) {
            if (findRecord(providerOrder[i]) !== null) {
                ids.push(providerOrder[i]);
            }
        }
        return ids;
    }

    readonly property bool hasProviders: availableProviderIds.length > 0

    // Selection is owned by the switcher's own currentIndex so it stays a
    // single source of truth; out-of-range values (including the initial
    // -1 with no items) fall back to the first available provider.
    readonly property string effectiveProviderId: {
        var idx = providerSwitcher.currentIndex;
        if (idx >= 0 && idx < availableProviderIds.length) {
            return availableProviderIds[idx];
        }
        return hasProviders ? availableProviderIds[0] : "";
    }

    readonly property var activeRecord: effectiveProviderId.length > 0 ? findRecord(effectiveProviderId) : null
    readonly property var activeModel: activeRecord !== null
        ? FullModel.buildFullViewModel(
            activeRecord,
            fullRoot.thresholds,
            fullRoot.appearance !== undefined && fullRoot.appearance !== null ? fullRoot.appearance : {}
        )
        : null

    Accessible.role: Accessible.Pane
    Accessible.name: hasProviders
        ? qsTr("Kuota usage details, %1").arg(providerDisplayName(effectiveProviderId))
        : qsTr("Kuota usage details, no data")

    function providerDisplayName(providerId) {
        switch (providerId) {
        case "claude":
            return qsTr("Claude");
        case "umans":
            return qsTr("Umans");
        case "codex":
            return qsTr("Codex");
        default:
            return providerId;
        }
    }

    function valueTextColor(thresholdLevel) {
        switch (thresholdLevel) {
        case "critical":
            return Kirigami.Theme.negativeTextColor;
        case "caution":
            return Kirigami.Theme.neutralTextColor;
        default:
            return Kirigami.Theme.textColor;
        }
    }
    // Metric value color with theming precedence (review G-T Major 2):
    // threshold colors win; when no threshold is active, the custom text
    // color applies; otherwise the theme default.
    function windowValueTextColor(thresholdLevel) {
        if (thresholdLevel === "none"
                && activeModel !== null
                && activeModel.textColor !== "") {
            return activeModel.textColor;
        }
        return valueTextColor(thresholdLevel);
    }

    function formatTimestamp(isoString) {
        if (typeof isoString !== "string" || isoString.length === 0) {
            return "";
        }
        var parsed = Date.parse(isoString);
        if (isNaN(parsed)) {
            return "";
        }
        return Qt.formatDateTime(new Date(parsed), "yyyy-MM-dd hh:mm");
    }

    function formatDuration(ms) {
        var totalSeconds = Math.floor(ms / 1000);
        var days = Math.floor(totalSeconds / 86400);
        var hours = Math.floor((totalSeconds % 86400) / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;
        if (days > 0) {
            return days + "d " + hours + "h";
        }
        if (hours > 0) {
            return hours + "h " + minutes + "m";
        }
        if (minutes > 0) {
            return minutes + "m " + seconds + "s";
        }
        return seconds + "s";
    }

    // Live countdown is computed here from resetAt + nowMs; full-model.js
    // only ever passes resetAt through unmodified.
    //
    // countdownDurationText() returns the bare duration phrase ("in 10m 5s" /
    // "now") with no "Resets" prefix, so resetLineText() can compose a single
    // "Resets <ts> (in <dur>)" line without duplicating the word "Resets".
    // countdownText() builds on it and keeps its own "Resets in …"/"Resets
    // now" wording for standalone callers/tests.
    function countdownDurationText(resetAt) {
        if (typeof resetAt !== "string" || resetAt.length === 0) {
            return "";
        }
        var resetTime = Date.parse(resetAt);
        if (isNaN(resetTime)) {
            return "";
        }
        var remainingMs = resetTime - fullRoot.nowMs;
        if (remainingMs <= 0) {
            return qsTr("now");
        }
        return qsTr("in %1").arg(formatDuration(remainingMs));
    }

    function countdownText(resetAt) {
        var duration = countdownDurationText(resetAt);
        if (duration.length === 0) {
            return "";
        }
        return qsTr("Resets %1").arg(duration);
    }

    function resetLineText(resetAt) {
        var timestamp = formatTimestamp(resetAt);
        if (!fullRoot.showCountdown) {
            return timestamp;
        }
        var countdown = countdownText(resetAt);
        if (timestamp.length === 0) {
            return countdown;
        }
        return qsTr("Resets %1 (%2)").arg(timestamp).arg(countdownDurationText(resetAt));
    }

    function windowAccessibleName(row) {
        var parts = [row.label];
        if (row.usedPercent !== undefined) {
            parts.push(Math.floor(row.usedPercent) + "%");
        } else if (row.used !== undefined) {
            parts.push(String(row.used));
        }
        return parts.join(", ");
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: Kirigami.Units.smallSpacing

        Controls.TabBar {
            id: providerSwitcher
            Layout.fillWidth: true
            visible: fullRoot.hasProviders

            Repeater {
                model: fullRoot.availableProviderIds

                delegate: Controls.TabButton {
                    required property string modelData
                    text: fullRoot.providerDisplayName(modelData)
                    Accessible.name: text
                    font.family: fullRoot.effectiveFontFamily
                }
            }
        }

        Flickable {
            id: contentFlickable
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: fullRoot.hasProviders
            clip: true
            contentWidth: width
            contentHeight: contentColumn.implicitHeight
            boundsBehavior: Flickable.StopAtBounds

            ColumnLayout {
                id: contentColumn
                width: contentFlickable.width
                spacing: Kirigami.Units.smallSpacing

                RowLayout {
                    Layout.fillWidth: true

                    Item { Layout.fillWidth: true }

                    Controls.Label {
                        visible: fullRoot.activeModel !== null && fullRoot.activeModel.lastSuccessAt !== undefined
                        text: fullRoot.activeModel !== null
                            ? qsTr("Updated %1").arg(fullRoot.formatTimestamp(fullRoot.activeModel.lastSuccessAt))
                            : ""
                        opacity: 0.7
                        font.family: fullRoot.effectiveFontFamily
                    }

                    Controls.ToolButton {
                        id: refreshButton
                        display: Controls.AbstractButton.IconOnly
                        icon.name: "view-refresh"
                        text: fullRoot.inFlight ? qsTr("Refreshing…") : qsTr("Refresh")
                        enabled: !fullRoot.inFlight
                        Accessible.name: text
                        onClicked: fullRoot.requestRefresh()
                    }
                }

                Kirigami.InlineMessage {
                    Layout.fillWidth: true
                    showCloseButton: false
                    visible: fullRoot.activeModel !== null
                        && fullRoot.activeModel.stateMessage !== undefined
                        && fullRoot.activeModel.stateMessage.length > 0
                    text: (fullRoot.activeModel !== null && fullRoot.activeModel.stateMessage !== undefined) ? fullRoot.activeModel.stateMessage : ""
                    font.family: fullRoot.effectiveFontFamily
                    type: {
                        if (fullRoot.activeRecord === null) {
                            return Kirigami.MessageType.Information;
                        }
                        switch (fullRoot.activeRecord.state) {
                        case "error":
                            return Kirigami.MessageType.Error;
                        case "auth-needed":
                            return Kirigami.MessageType.Warning;
                        case "stale":
                            return Kirigami.MessageType.Information;
                        default:
                            return Kirigami.MessageType.Information;
                        }
                    }
                }

                Controls.Label {
                    visible: fullRoot.activeModel !== null
                        && fullRoot.activeModel.windows.length === 0
                        && fullRoot.activeModel.facts.length === 0
                        && (fullRoot.activeModel.stateMessage === undefined || fullRoot.activeModel.stateMessage.length === 0)
                    text: qsTr("No usage data")
                    opacity: 0.7
                    font.family: fullRoot.effectiveFontFamily
                }

                Repeater {
                    model: fullRoot.activeModel !== null ? fullRoot.activeModel.windows : []

                    delegate: Controls.Frame {
                        id: windowRow
                        required property var modelData

                        Layout.fillWidth: true
                        padding: Kirigami.Units.smallSpacing

                        Accessible.role: Accessible.Grouping
                        Accessible.name: fullRoot.windowAccessibleName(windowRow.modelData)

                        background: Rectangle {
                            color: Kirigami.Theme.alternateBackgroundColor
                            radius: Kirigami.Units.smallSpacing
                            border.color: Kirigami.Theme.disabledTextColor
                            border.width: 1
                        }

                        contentItem: ColumnLayout {
                            spacing: Kirigami.Units.smallSpacing / 2

                            RowLayout {
                                Layout.fillWidth: true

                                Kirigami.Heading {
                                    level: 5
                                    text: windowRow.modelData.label
                                    font.family: fullRoot.effectiveFontFamily
                                    color: fullRoot.activeModel !== null && fullRoot.activeModel.textColor !== ""
                                        ? fullRoot.activeModel.textColor
                                        : Kirigami.Theme.textColor
                                    opacity: fullRoot.activeModel !== null ? fullRoot.activeModel.labelOpacity : 1.0
                                }

                                Item { Layout.fillWidth: true }

                                Controls.Label {
                                    visible: windowRow.modelData.usedPercent !== undefined
                                    text: Math.floor(windowRow.modelData.usedPercent) + "%"
                                    color: fullRoot.windowValueTextColor(windowRow.modelData.thresholdLevel)
                                    font.family: fullRoot.effectiveFontFamily
                                }
                            }

                            Controls.ProgressBar {
                                Layout.fillWidth: true
                                visible: windowRow.modelData.progressFraction !== undefined
                                from: 0
                                to: 1
                                value: windowRow.modelData.progressFraction !== undefined ? windowRow.modelData.progressFraction : 0
                                Accessible.name: qsTr("%1 progress").arg(windowRow.modelData.label)
                                palette.highlight: {
                                    // barColor is "" when a threshold is active (model
                                    // guarantee), so the threshold switch always wins —
                                    // precedence: Threshold > Accent > Custom > Theme.
                                    if (windowRow.modelData.barColor !== undefined && windowRow.modelData.barColor !== "") {
                                        return windowRow.modelData.barColor;
                                    }
                                    switch (windowRow.modelData.thresholdLevel) {
                                    case "critical":
                                        return Kirigami.Theme.negativeTextColor;
                                    case "caution":
                                        return Kirigami.Theme.neutralTextColor;
                                    default:
                                        return Kirigami.Theme.highlightColor;
                                    }
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true

                                Controls.Label {
                                    visible: windowRow.modelData.used !== undefined
                                    text: windowRow.modelData.limit !== undefined
                                        ? qsTr("%1 of %2 used").arg(windowRow.modelData.used).arg(windowRow.modelData.limit)
                                        : qsTr("%1 used").arg(windowRow.modelData.used)
                                    color: fullRoot.windowValueTextColor(windowRow.modelData.thresholdLevel)
                                    font.family: fullRoot.effectiveFontFamily
                                }

                                Item { Layout.fillWidth: true }

                                Controls.Label {
                                    visible: windowRow.modelData.remaining !== undefined
                                    text: qsTr("%1 remaining").arg(windowRow.modelData.remaining)
                                    font.family: fullRoot.effectiveFontFamily
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Kirigami.Units.smallSpacing
                                visible: windowRow.modelData.resetAt !== undefined

                                Kirigami.Icon {
                                    source: "clock"
                                    implicitWidth: Kirigami.Units.iconSizes.small
                                    implicitHeight: Kirigami.Units.iconSizes.small
                                    opacity: 0.6
                                }

                                Controls.Label {
                                    text: fullRoot.resetLineText(windowRow.modelData.resetAt)
                                    opacity: 0.8
                                    font.family: fullRoot.effectiveFontFamily
                                }
                            }
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    height: 1
                    color: Kirigami.Theme.disabledTextColor
                    visible: fullRoot.activeModel !== null && fullRoot.activeModel.facts.length > 0
                }

                GridLayout {
                    // Two-column key/value grid, NOT Kirigami.FormLayout: activeModel.facts
                    // is a fresh array reference on every provider switch, and pairing a
                    // Repeater's reassigned array model with FormLayout was observed here
                    // to transiently break FormLayout's per-child bookkeeping ("Cannot read
                    // property 'Accessible' of null") during the destroy/recreate churn
                    // — the same landmine documented in configProviders.qml. GridLayout has
                    // no such interaction and gives the same aligned-columns result.
                    Layout.fillWidth: true
                    columns: 2
                    columnSpacing: Kirigami.Units.smallSpacing
                    rowSpacing: Kirigami.Units.smallSpacing / 2

                    Repeater {
                        model: fullRoot.activeModel !== null ? fullRoot.activeModel.facts : []

                        delegate: Controls.Label {
                            required property var modelData
                            required property int index
                            Layout.column: 0
                            Layout.row: index
                            text: modelData.label + ":"
                            font.family: fullRoot.effectiveFontFamily
                            color: fullRoot.activeModel !== null && fullRoot.activeModel.textColor !== ""
                                ? fullRoot.activeModel.textColor
                                : Kirigami.Theme.textColor
                            opacity: 0.8 * (fullRoot.activeModel !== null ? fullRoot.activeModel.labelOpacity : 1.0)
                        }
                    }

                    Repeater {
                        model: fullRoot.activeModel !== null ? fullRoot.activeModel.facts : []

                        delegate: Controls.Label {
                            required property var modelData
                            required property int index
                            Layout.column: 1
                            Layout.row: index
                            text: modelData.value
                            font.family: fullRoot.effectiveFontFamily
                            color: fullRoot.activeModel !== null && fullRoot.activeModel.textColor !== ""
                                ? fullRoot.activeModel.textColor
                                : Kirigami.Theme.textColor
                        }
                    }
                }
            }
        }

        Kirigami.PlaceholderMessage {
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: !fullRoot.hasProviders
            icon.name: "network-server"
            text: qsTr("Kuota")
            explanation: qsTr("No provider data yet")
            // NOTE: PlaceholderMessage exposes no `font` property (qmllint:
            // unresolved grouped property) — bootstrap empty-state text keeps
            // the theme font; documented divergence from "all widget text".
            // Refresh lives in the provider header (F4), which is gated on
            // hasProviders; give the empty state its own retry affordance so
            // the user is never stranded without a way to refresh.
            helpfulAction: Kirigami.Action {
                icon.name: "view-refresh"
                text: fullRoot.inFlight ? qsTr("Refreshing…") : qsTr("Refresh")
                enabled: !fullRoot.inFlight
                onTriggered: fullRoot.requestRefresh()
            }
        }
    }

    Timer {
        interval: 1000
        running: fullRoot.autoAdvanceClock
        repeat: true
        onTriggered: fullRoot.nowMs = Date.now()
    }
}
