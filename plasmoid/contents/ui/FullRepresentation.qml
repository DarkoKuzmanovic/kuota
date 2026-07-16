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
    readonly property var activeModel: activeRecord !== null ? FullModel.buildFullViewModel(activeRecord, fullRoot.thresholds) : null

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
    function countdownText(resetAt) {
        if (typeof resetAt !== "string" || resetAt.length === 0) {
            return "";
        }
        var resetTime = Date.parse(resetAt);
        if (isNaN(resetTime)) {
            return "";
        }
        var remainingMs = resetTime - fullRoot.nowMs;
        if (remainingMs <= 0) {
            return qsTr("Resets now");
        }
        return qsTr("Resets in %1").arg(formatDuration(remainingMs));
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
        return qsTr("Resets %1 (%2)").arg(timestamp).arg(countdown);
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

                    Kirigami.Heading {
                        level: 3
                        text: fullRoot.providerDisplayName(fullRoot.effectiveProviderId)
                    }

                    Item { Layout.fillWidth: true }

                    Controls.Label {
                        visible: fullRoot.activeModel !== null && fullRoot.activeModel.lastSuccessAt !== undefined
                        text: fullRoot.activeModel !== null
                            ? qsTr("Updated %1").arg(fullRoot.formatTimestamp(fullRoot.activeModel.lastSuccessAt))
                            : ""
                        opacity: 0.7
                    }
                }

                Controls.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    visible: fullRoot.activeModel !== null
                        && fullRoot.activeModel.stateMessage !== undefined
                        && fullRoot.activeModel.stateMessage.length > 0
                    text: (fullRoot.activeModel !== null && fullRoot.activeModel.stateMessage !== undefined) ? fullRoot.activeModel.stateMessage : ""
                    color: Kirigami.Theme.neutralTextColor
                }

                Controls.Label {
                    visible: fullRoot.activeModel !== null
                        && fullRoot.activeModel.windows.length === 0
                        && fullRoot.activeModel.facts.length === 0
                        && (fullRoot.activeModel.stateMessage === undefined || fullRoot.activeModel.stateMessage.length === 0)
                    text: qsTr("No usage data")
                    opacity: 0.7
                }

                Repeater {
                    model: fullRoot.activeModel !== null ? fullRoot.activeModel.windows : []

                    delegate: ColumnLayout {
                        id: windowRow
                        required property var modelData

                        Layout.fillWidth: true
                        spacing: Kirigami.Units.smallSpacing / 2

                        Accessible.role: Accessible.Grouping
                        Accessible.name: fullRoot.windowAccessibleName(windowRow.modelData)

                        RowLayout {
                            Layout.fillWidth: true

                            Kirigami.Heading {
                                level: 5
                                text: windowRow.modelData.label
                            }

                            Item { Layout.fillWidth: true }

                            Controls.Label {
                                visible: windowRow.modelData.usedPercent !== undefined
                                text: Math.floor(windowRow.modelData.usedPercent) + "%"
                                color: fullRoot.valueTextColor(windowRow.modelData.thresholdLevel)
                            }
                        }

                        Controls.ProgressBar {
                            Layout.fillWidth: true
                            visible: windowRow.modelData.progressFraction !== undefined
                            from: 0
                            to: 1
                            value: windowRow.modelData.progressFraction !== undefined ? windowRow.modelData.progressFraction : 0
                            Accessible.name: qsTr("%1 progress").arg(windowRow.modelData.label)
                        }

                        RowLayout {
                            Layout.fillWidth: true

                            Controls.Label {
                                visible: windowRow.modelData.used !== undefined
                                text: windowRow.modelData.limit !== undefined
                                    ? qsTr("%1 of %2 used").arg(windowRow.modelData.used).arg(windowRow.modelData.limit)
                                    : qsTr("%1 used").arg(windowRow.modelData.used)
                                color: fullRoot.valueTextColor(windowRow.modelData.thresholdLevel)
                            }

                            Item { Layout.fillWidth: true }

                            Controls.Label {
                                visible: windowRow.modelData.remaining !== undefined
                                text: qsTr("%1 remaining").arg(windowRow.modelData.remaining)
                            }
                        }

                        Controls.Label {
                            visible: windowRow.modelData.resetAt !== undefined
                            text: fullRoot.resetLineText(windowRow.modelData.resetAt)
                            opacity: 0.8
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    height: 1
                    color: Kirigami.Theme.disabledTextColor
                    visible: fullRoot.activeModel !== null && fullRoot.activeModel.facts.length > 0
                }

                Repeater {
                    model: fullRoot.activeModel !== null ? fullRoot.activeModel.facts : []

                    delegate: RowLayout {
                        required property var modelData
                        Layout.fillWidth: true

                        Controls.Label {
                            text: modelData.label + ":"
                            opacity: 0.8
                        }

                        Item { Layout.fillWidth: true }

                        Controls.Label {
                            text: modelData.value
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
        }

        RowLayout {
            Layout.fillWidth: true

            Item { Layout.fillWidth: true }

            Controls.Button {
                id: refreshButton
                text: fullRoot.inFlight ? qsTr("Refreshing…") : qsTr("Refresh")
                enabled: !fullRoot.inFlight
                Accessible.name: text
                onClicked: fullRoot.requestRefresh()
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
