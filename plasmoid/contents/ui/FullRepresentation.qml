import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as Controls
import org.kde.kirigami 2.20 as Kirigami

import "full-model.js" as FullModel
import "provider-catalog.js" as ProviderCatalog

FocusScope {
    id: fullRoot

    property var snapshot: null
    property bool inFlight: false
    property real nowMs: Date.now()
    property bool autoAdvanceClock: true
    // Enabled providers in the user's configured order (main.qml passes the
    // sanitized visible order). Standalone default: every supported provider.
    property var providerOrder: ProviderCatalog.PROVIDER_IDS.slice()
    // Injected caution/critical thresholds (M9, D5). Defaults preserve M8's
    // 75/90 behavior for standalone instantiation (e.g. existing tests that
    // never set this).
    property var thresholds: ({ caution: 75, critical: 90 })
    // Gates the live reset countdown text (M9, D8). The reset timestamp
    // itself may still show; only the ticking "in …" phrase is hidden.
    property bool showCountdown: true
    // Appearance overrides (M12 theming). `null` reproduces V1 exactly;
    // main.qml passes the sanitized settings. `fontFamily` "" means the
    // theme default font.
    property var appearance: null
    property string fontFamily: ""
    readonly property string effectiveFontFamily: fontFamily !== "" ? fontFamily : Kirigami.Theme.defaultFont.family

    signal requestRefresh()
    signal requestConfigure()

    implicitWidth: Kirigami.Units.gridUnit * 22
    implicitHeight: Kirigami.Units.gridUnit * 24

    readonly property alias refreshButtonItem: refreshButton
    readonly property alias providerSwitcherItem: providerSwitcher
    readonly property alias overviewRowsItem: overviewRepeater
    readonly property alias noProvidersMessageItem: noProvidersMessage

    readonly property var providerRecords: (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.providers))
        ? snapshot.providers
        : []
    readonly property var resolvedAppearance: appearance !== undefined && appearance !== null ? appearance : ({})

    // All overview rows: one per enabled provider, user order, pending rows
    // included. Every data decision (tightest window, reset ordering) lives in
    // full-model.js; this file only applies the live clock.
    readonly property var overviewModel: FullModel.buildOverviewModel(
        fullRoot.providerOrder, fullRoot.providerRecords, fullRoot.thresholds, fullRoot.resolvedAppearance)
    // Depends only on providerOrder, so a snapshot refresh never rebuilds the
    // tabs (which would disturb the selected tab).
    readonly property var enabledProviderIds: FullModel.enabledProviderOrder(providerOrder)
    readonly property bool hasEnabledProviders: enabledProviderIds.length > 0

    function findRecord(providerId) {
        return FullModel.findProviderRecord(providerRecords, providerId);
    }

    readonly property var availableProviderIds: {
        var ids = [];
        for (var i = 0; i < enabledProviderIds.length; i++) {
            if (findRecord(enabledProviderIds[i]) !== null) {
                ids.push(enabledProviderIds[i]);
            }
        }
        return ids;
    }

    readonly property bool hasProviders: availableProviderIds.length > 0

    // Selection is owned by the switcher's own currentIndex so it stays a
    // single source of truth. Tab 0 is All (the default); tab i ≥ 1 is
    // enabledProviderIds[i - 1]. Anything out of range falls back to All.
    readonly property string effectiveProviderId: {
        var idx = providerSwitcher.currentIndex - 1;
        if (idx >= 0 && idx < enabledProviderIds.length) {
            return enabledProviderIds[idx];
        }
        return "";
    }
    readonly property bool overviewActive: effectiveProviderId.length === 0

    readonly property var activeRecord: effectiveProviderId.length > 0 ? findRecord(effectiveProviderId) : null
    readonly property var activeModel: activeRecord !== null
        ? FullModel.buildFullViewModel(activeRecord, fullRoot.thresholds, fullRoot.resolvedAppearance)
        : null

    Accessible.role: Accessible.Pane
    Accessible.name: {
        if (!hasEnabledProviders) {
            return qsTr("Kuota, no providers enabled");
        }
        if (overviewActive) {
            return hasProviders ? qsTr("Kuota usage overview") : qsTr("Kuota usage overview, no data yet");
        }
        return qsTr("Kuota usage details, %1").arg(providerDisplayName(effectiveProviderId));
    }

    function openProvider(providerId) {
        var idx = enabledProviderIds.indexOf(providerId);
        if (idx === -1) {
            return;
        }
        providerSwitcher.currentIndex = idx + 1;
        // Keep keyboard focus on a visible control: the activated row is
        // hidden with the overview.
        var tab = providerSwitcher.itemAt(idx + 1);
        if (tab) {
            tab.forceActiveFocus();
        }
    }

    function openOverview() {
        providerSwitcher.currentIndex = 0;
    }

    function focusOverviewRow(index) {
        var row = overviewRepeater.itemAt(index);
        if (row) {
            row.forceActiveFocus(Qt.TabFocusReason);
        }
    }

    function providerDisplayName(providerId) {
        switch (providerId) {
        case "claude":
            return qsTr("Claude");
        case "codex":
            return qsTr("Codex");
        case "grok":
            return qsTr("Grok");
        case "kimi":
            return qsTr("Kimi");
        case "cursor":
            return qsTr("Cursor");
        case "opencode":
            return qsTr("OpenCode");
        case "commandcode":
            return qsTr("CommandCode");
        case "mistral":
            return qsTr("Mistral");
        case "opendesign":
            return qsTr("OpenDesign");
        default:
            return providerId;
        }
    }

    // ---- Colors: theme roles only, so light and dark both stay legible ----

    readonly property color hairlineColor: Kirigami.ColorUtils.linearInterpolation(
        Kirigami.Theme.backgroundColor, Kirigami.Theme.textColor, 0.12)
    readonly property color cardColor: Kirigami.ColorUtils.linearInterpolation(
        Kirigami.Theme.backgroundColor, Kirigami.Theme.textColor, 0.03)
    readonly property color trackColor: Kirigami.ColorUtils.linearInterpolation(
        Kirigami.Theme.backgroundColor, Kirigami.Theme.textColor, 0.15)

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
    function thresholdTextColor(thresholdLevel, customColor) {
        if (thresholdLevel === "none" && typeof customColor === "string" && customColor !== "") {
            return customColor;
        }
        return valueTextColor(thresholdLevel);
    }
    function windowValueTextColor(thresholdLevel) {
        return thresholdTextColor(thresholdLevel, activeModel !== null ? activeModel.textColor : "");
    }
    function labelTextColor(customColor) {
        return typeof customColor === "string" && customColor !== "" ? customColor : Kirigami.Theme.textColor;
    }
    // Precedence: Threshold > Accent > Theme highlight. barColor is "" when a
    // threshold is active (model guarantee), so the threshold always wins.
    function barFillColor(row) {
        if (row.barColor !== undefined && row.barColor !== "") {
            return row.barColor;
        }
        switch (row.thresholdLevel) {
        case "critical":
            return Kirigami.Theme.negativeTextColor;
        case "caution":
            return Kirigami.Theme.neutralTextColor;
        default:
            return Kirigami.Theme.highlightColor;
        }
    }
    function stateColor(state) {
        switch (state) {
        case "error":
            return Kirigami.Theme.negativeTextColor;
        case "auth-needed":
            return Kirigami.Theme.neutralTextColor;
        default:
            return Kirigami.Theme.textColor;
        }
    }

    // ---- Time: the live clock (nowMs) is only ever applied here ----

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

    // countdownDurationText() returns the bare duration phrase ("in 10m 5s" /
    // "now") with no "Resets" prefix, so callers can compose it.
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

    // Elapsed share of a window's TIME, from the reported reset and reported
    // duration only, clamped to the bar. -1 means "no marker": either value
    // missing or invalid. Never inferred from a label.
    function paceFraction(resetAt, durationSeconds) {
        if (typeof durationSeconds !== "number" || !isFinite(durationSeconds) || durationSeconds <= 0) {
            return -1;
        }
        if (typeof resetAt !== "string" || resetAt.length === 0) {
            return -1;
        }
        var resetMs = Date.parse(resetAt);
        if (isNaN(resetMs)) {
            return -1;
        }
        var durationMs = durationSeconds * 1000;
        var elapsed = (fullRoot.nowMs - (resetMs - durationMs)) / durationMs;
        return Math.max(0, Math.min(1, elapsed));
    }

    function paceAccessibleText(pace) {
        return pace >= 0 ? qsTr("%1% of window time elapsed").arg(Math.round(pace * 100)) : "";
    }

    // The model sorts resets earliest-first; the soonest one still ahead of the
    // live clock wins. When every reset has passed, the earliest reads "now".
    // Repeater model data can expose nested arrays as QVariantList, not JS arrays.
    function soonestReset(resets) {
        if (!resets || resets.length === 0) {
            return null;
        }
        for (var i = 0; i < resets.length; i++) {
            var time = Date.parse(resets[i].resetAt);
            if (!isNaN(time) && time > fullRoot.nowMs) {
                return resets[i];
            }
        }
        return resets[0];
    }

    // ---- Overview row text ----

    function overviewUsedText(row) {
        if (row.pending) {
            return fullRoot.inFlight ? qsTr("Refreshing…") : qsTr("Waiting for data…");
        }
        var primary = row.primary;
        if (primary === undefined) {
            return "";
        }
        if (primary.usedPercent !== undefined) {
            return qsTr("%1% used").arg(Math.floor(primary.usedPercent));
        }
        if (primary.limit !== undefined) {
            return qsTr("%1 / %2").arg(primary.used).arg(primary.limit);
        }
        return qsTr("%1 used").arg(primary.used);
    }

    function overviewLeftText(row) {
        if (row.pending || row.primary === undefined || row.primary.remainingPercent === undefined) {
            return "";
        }
        // Complements the floored used figure so the two always sum to 100.
        return qsTr("%1% left").arg(Math.ceil(row.primary.remainingPercent));
    }

    function overviewMetricText(row) {
        var used = overviewUsedText(row);
        var left = overviewLeftText(row);
        if (left.length === 0) {
            return used;
        }
        return qsTr("%1 · %2").arg(used).arg(left);
    }

    function overviewResetText(row) {
        var reset = soonestReset(row.resets);
        if (reset === null) {
            return "";
        }
        var when = fullRoot.showCountdown ? countdownDurationText(reset.resetAt) : formatTimestamp(reset.resetAt);
        if (when.length === 0) {
            return "";
        }
        if (reset.isPrimary) {
            return qsTr("resets %1").arg(when);
        }
        // A different window resets first: name it, never borrow the label
        // of the window displayed on the row.
        if (typeof reset.label === "string" && reset.label.length > 0) {
            return qsTr("%1 resets %2").arg(reset.label).arg(when);
        }
        return qsTr("another window resets %1").arg(when);
    }

    function capitalizeFirst(text) {
        return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    }

    function overviewAccessibleName(row) {
        var parts = [providerDisplayName(row.providerId)];
        if (row.stateBadge.length > 0) {
            parts.push(row.stateBadge);
        }
        if (row.loginHint !== undefined) {
            parts.push(row.loginHint);
        }
        if (row.primary !== undefined && row.primary.label.length > 0) {
            parts.push(qsTr("%1 window").arg(row.primary.label));
        }
        var used = overviewUsedText(row);
        if (used.length > 0) {
            parts.push(used);
        }
        var left = overviewLeftText(row);
        if (left.length > 0) {
            parts.push(left);
        }
        var reset = overviewResetText(row);
        if (reset.length > 0) {
            parts.push(reset);
        }
        if (row.primary !== undefined && row.primary.progressFraction !== undefined) {
            var pace = paceAccessibleText(paceFraction(row.primary.resetAt, row.primary.durationSeconds));
            if (pace.length > 0) {
                parts.push(pace);
            }
        }
        return parts.join(", ");
    }

    // ---- Detail card text ----

    function windowCountsText(row) {
        if (row.used === undefined) {
            return "";
        }
        var text = row.limit !== undefined
            ? qsTr("%1 of %2 used").arg(row.used).arg(row.limit)
            : qsTr("%1 used").arg(row.used);
        if (row.remaining !== undefined) {
            text = qsTr("%1 · %2 remaining").arg(text).arg(row.remaining);
        }
        return text;
    }

    function windowAccessibleName(row) {
        var parts = [row.label];
        if (row.usedPercent !== undefined) {
            parts.push(qsTr("%1% used").arg(Math.floor(row.usedPercent)));
        }
        var counts = windowCountsText(row);
        if (counts.length > 0) {
            parts.push(counts);
        }
        var reset = resetLineText(row.resetAt);
        if (reset.length > 0) {
            parts.push(reset);
        }
        if (row.progressFraction !== undefined) {
            var pace = paceAccessibleText(paceFraction(row.resetAt, row.durationSeconds));
            if (pace.length > 0) {
                parts.push(pace);
            }
        }
        return parts.join(", ");
    }

    // Aligned overview columns: widest enabled provider name / displayed
    // window label, capped so narrow popups keep room for the values.
    FontMetrics {
        id: nameMetrics
        font.family: fullRoot.effectiveFontFamily
        font.weight: Font.DemiBold
    }
    FontMetrics {
        id: labelMetrics
        font.family: fullRoot.effectiveFontFamily
    }
    readonly property real overviewNameWidth: {
        var widest = 0;
        for (var i = 0; i < enabledProviderIds.length; i++) {
            widest = Math.max(widest, nameMetrics.advanceWidth(providerDisplayName(enabledProviderIds[i])));
        }
        // +2 px absorbs subpixel rounding so the widest name never elides.
        return Math.min(Math.ceil(widest) + 2, Kirigami.Units.gridUnit * 6);
    }
    readonly property real overviewWindowLabelWidth: {
        var widest = 0;
        var rows = overviewModel.rows;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].primary !== undefined) {
                widest = Math.max(widest, labelMetrics.advanceWidth(rows[i].primary.label));
            }
        }
        return Math.min(Math.ceil(widest) + 2, Kirigami.Units.gridUnit * 5);
    }

    // Pace marker: a narrow tick over a bar, in the text color so it reads on
    // both the fill and the track in light and dark themes.
    component PaceTick: Rectangle {
        property real fraction: -1
        visible: fraction >= 0
        width: 2
        x: Math.round(Math.max(0, Math.min(parent.width - width, fraction * parent.width - width / 2)))
        y: -2
        height: parent.height + 4
        radius: 1
        color: Kirigami.Theme.textColor
        opacity: 0.8
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: Kirigami.Units.smallSpacing

        RowLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing
            visible: fullRoot.hasEnabledProviders

            Controls.TabBar {
                id: providerSwitcher
                Layout.fillWidth: true

                Controls.TabButton {
                    text: qsTr("All")
                    Accessible.name: qsTr("All providers overview")
                    font.family: fullRoot.effectiveFontFamily
                }

                Repeater {
                    model: fullRoot.enabledProviderIds

                    delegate: Controls.TabButton {
                        required property string modelData
                        text: fullRoot.providerDisplayName(modelData)
                        Accessible.name: text
                        font.family: fullRoot.effectiveFontFamily
                    }
                }
            }

            Controls.ToolButton {
                id: refreshButton
                display: Controls.AbstractButton.IconOnly
                icon.name: "view-refresh"
                text: fullRoot.inFlight ? qsTr("Refreshing…") : qsTr("Refresh")
                enabled: fullRoot.hasEnabledProviders && !fullRoot.inFlight
                Accessible.name: text
                Controls.ToolTip.text: text
                Controls.ToolTip.visible: hovered
                Controls.ToolTip.delay: Kirigami.Units.toolTipDelay
                onClicked: fullRoot.requestRefresh()
            }
        }

        // ---- All overview ----
        Controls.ScrollView {
            id: overviewScroll
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: fullRoot.hasEnabledProviders && fullRoot.overviewActive
            contentWidth: availableWidth
            Controls.ScrollBar.horizontal.policy: Controls.ScrollBar.AlwaysOff

            function ensureVisible(item) {
                var flickable = overviewScroll.contentItem;
                var top = item.mapToItem(overviewColumn, 0, 0).y;
                if (top < flickable.contentY) {
                    flickable.contentY = top;
                } else if (top + item.height > flickable.contentY + flickable.height) {
                    flickable.contentY = top + item.height - flickable.height;
                }
            }

            ColumnLayout {
                id: overviewColumn
                width: overviewScroll.availableWidth
                spacing: 0

                Repeater {
                    id: overviewRepeater
                    model: fullRoot.overviewModel.rows

                    delegate: Controls.ItemDelegate {
                        id: overviewRow
                        required property var modelData
                        required property int index
                        readonly property var primary: modelData.primary !== undefined ? modelData.primary : null
                        readonly property bool hasBar: primary !== null && primary.progressFraction !== undefined
                        readonly property real pace: hasBar ? fullRoot.paceFraction(primary.resetAt, primary.durationSeconds) : -1
                        readonly property string resetText: fullRoot.overviewResetText(modelData)

                        objectName: "overviewRow_" + modelData.providerId
                        Layout.fillWidth: true
                        topPadding: Kirigami.Units.smallSpacing
                        bottomPadding: Kirigami.Units.smallSpacing
                        leftPadding: Kirigami.Units.smallSpacing
                        rightPadding: Kirigami.Units.smallSpacing
                        text: fullRoot.providerDisplayName(modelData.providerId)

                        Accessible.role: Accessible.Button
                        Accessible.name: fullRoot.overviewAccessibleName(modelData)
                        Accessible.description: qsTr("Opens %1 details").arg(text)

                        onClicked: fullRoot.openProvider(modelData.providerId)
                        Keys.onReturnPressed: fullRoot.openProvider(modelData.providerId)
                        Keys.onEnterPressed: fullRoot.openProvider(modelData.providerId)
                        Keys.onUpPressed: fullRoot.focusOverviewRow(index - 1)
                        Keys.onDownPressed: fullRoot.focusOverviewRow(index + 1)
                        onActiveFocusChanged: {
                            if (activeFocus) {
                                overviewScroll.ensureVisible(overviewRow);
                            }
                        }

                        contentItem: ColumnLayout {
                            spacing: Kirigami.Units.smallSpacing / 2

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Kirigami.Units.smallSpacing

                                Controls.Label {
                                    Layout.fillWidth: true
                                    Layout.preferredWidth: fullRoot.overviewNameWidth
                                    Layout.maximumWidth: fullRoot.overviewNameWidth
                                    Layout.minimumWidth: Math.min(fullRoot.overviewNameWidth, Kirigami.Units.gridUnit * 2.5)
                                    text: overviewRow.text
                                    elide: Text.ElideRight
                                    font.family: fullRoot.effectiveFontFamily
                                    font.weight: Font.DemiBold
                                    color: fullRoot.labelTextColor(overviewRow.modelData.textColor)
                                }

                                Controls.Label {
                                    visible: overviewRow.primary !== null && overviewRow.primary.label.length > 0
                                    Layout.fillWidth: true
                                    Layout.preferredWidth: fullRoot.overviewWindowLabelWidth
                                    Layout.maximumWidth: fullRoot.overviewWindowLabelWidth
                                    Layout.minimumWidth: Kirigami.Units.gridUnit * 1.5
                                    text: overviewRow.primary !== null ? overviewRow.primary.label : ""
                                    elide: Text.ElideRight
                                    font.family: fullRoot.effectiveFontFamily
                                    color: fullRoot.labelTextColor(overviewRow.modelData.textColor)
                                    opacity: 0.7 * overviewRow.modelData.labelOpacity
                                }

                                // Usage and remaining share one elidable label so a
                                // narrow popup trims it instead of overflowing.
                                Controls.Label {
                                    id: usedLabel
                                    text: fullRoot.overviewMetricText(overviewRow.modelData)
                                    visible: text.length > 0
                                    Layout.fillWidth: true
                                    Layout.minimumWidth: Math.min(implicitWidth, Kirigami.Units.gridUnit * 3)
                                    elide: Text.ElideRight
                                    font.family: fullRoot.effectiveFontFamily
                                    color: overviewRow.primary !== null
                                        ? fullRoot.thresholdTextColor(overviewRow.primary.thresholdLevel, overviewRow.modelData.textColor)
                                        : fullRoot.labelTextColor(overviewRow.modelData.textColor)
                                    opacity: overviewRow.modelData.pending ? 0.7 : 1.0
                                }

                                Item {
                                    visible: !usedLabel.visible
                                    Layout.fillWidth: true
                                }

                                // Explicit state badge, shown alongside any retained data.
                                Controls.Label {
                                    visible: overviewRow.modelData.stateBadge.length > 0
                                    text: overviewRow.modelData.stateBadge
                                    font.family: fullRoot.effectiveFontFamily
                                    font.pointSize: Kirigami.Theme.smallFont.pointSize
                                    color: fullRoot.stateColor(overviewRow.modelData.state)
                                    leftPadding: Kirigami.Units.smallSpacing
                                    rightPadding: Kirigami.Units.smallSpacing
                                    background: Rectangle {
                                        radius: height / 2
                                        color: "transparent"
                                        border.width: 1
                                        border.color: Kirigami.ColorUtils.linearInterpolation(
                                            Kirigami.Theme.backgroundColor, fullRoot.stateColor(overviewRow.modelData.state), 0.5)
                                    }
                                }

                                Kirigami.Icon {
                                    source: overviewRow.mirrored ? "go-previous" : "go-next"
                                    implicitWidth: Kirigami.Units.iconSizes.small
                                    implicitHeight: Kirigami.Units.iconSizes.small
                                    opacity: 0.5
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Kirigami.Units.smallSpacing
                                visible: overviewRow.hasBar || overviewRow.resetText.length > 0

                                Item {
                                    visible: overviewRow.hasBar
                                    Layout.fillWidth: true
                                    Layout.alignment: Qt.AlignVCenter
                                    implicitHeight: Math.max(3, Math.round(Kirigami.Units.smallSpacing))

                                    Rectangle {
                                        anchors.fill: parent
                                        radius: height / 2
                                        color: fullRoot.trackColor
                                    }
                                    Rectangle {
                                        width: overviewRow.hasBar ? parent.width * overviewRow.primary.progressFraction : 0
                                        height: parent.height
                                        radius: height / 2
                                        color: overviewRow.primary !== null ? fullRoot.barFillColor(overviewRow.primary) : "transparent"
                                    }
                                    PaceTick {
                                        fraction: overviewRow.pace
                                    }
                                }

                                Item {
                                    visible: !overviewRow.hasBar
                                    Layout.fillWidth: true
                                }

                                Controls.Label {
                                    visible: overviewRow.resetText.length > 0
                                    text: overviewRow.resetText
                                    Layout.maximumWidth: overviewRow.availableWidth * 0.6
                                    elide: Text.ElideRight
                                    font.family: fullRoot.effectiveFontFamily
                                    font.pointSize: Kirigami.Theme.smallFont.pointSize
                                    color: fullRoot.labelTextColor(overviewRow.modelData.textColor)
                                    opacity: 0.8
                                }
                            }

                            // Existing provider-specific login guidance (closed list).
                            Controls.Label {
                                visible: overviewRow.modelData.loginHint !== undefined
                                Layout.fillWidth: true
                                text: overviewRow.modelData.loginHint !== undefined
                                    ? fullRoot.capitalizeFirst(overviewRow.modelData.loginHint)
                                    : ""
                                wrapMode: Text.Wrap
                                font.family: fullRoot.effectiveFontFamily
                                font.pointSize: Kirigami.Theme.smallFont.pointSize
                                color: Kirigami.Theme.neutralTextColor
                            }
                        }
                    }
                }
            }
        }

        // ---- Provider detail ----
        Controls.ScrollView {
            id: detailScroll
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: fullRoot.hasEnabledProviders && !fullRoot.overviewActive
            contentWidth: availableWidth
            Controls.ScrollBar.horizontal.policy: Controls.ScrollBar.AlwaysOff

            ColumnLayout {
                id: contentColumn
                width: detailScroll.availableWidth
                spacing: Kirigami.Units.smallSpacing

                Controls.Label {
                    Layout.fillWidth: true
                    visible: fullRoot.activeModel !== null && fullRoot.activeModel.lastSuccessAt !== undefined
                    text: fullRoot.activeModel !== null
                        ? qsTr("Updated %1").arg(fullRoot.formatTimestamp(fullRoot.activeModel.lastSuccessAt))
                        : ""
                    horizontalAlignment: Text.AlignRight
                    opacity: 0.7
                    font.family: fullRoot.effectiveFontFamily
                    font.pointSize: Kirigami.Theme.smallFont.pointSize
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
                        default:
                            return Kirigami.MessageType.Information;
                        }
                    }
                }

                // Enabled, but no record for this provider yet.
                Controls.Label {
                    visible: fullRoot.activeRecord === null
                    text: fullRoot.inFlight ? qsTr("Refreshing…") : qsTr("Waiting for data…")
                    opacity: 0.7
                    font.family: fullRoot.effectiveFontFamily
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
                        readonly property real pace: modelData.progressFraction !== undefined
                            ? fullRoot.paceFraction(modelData.resetAt, modelData.durationSeconds)
                            : -1
                        readonly property string countdown: fullRoot.showCountdown
                            ? fullRoot.countdownDurationText(modelData.resetAt)
                            : ""
                        readonly property string countsText: fullRoot.windowCountsText(modelData)
                        readonly property string timestampText: fullRoot.formatTimestamp(modelData.resetAt)

                        Layout.fillWidth: true
                        padding: Kirigami.Units.smallSpacing

                        Accessible.role: Accessible.Grouping
                        Accessible.name: fullRoot.windowAccessibleName(windowRow.modelData)

                        background: Rectangle {
                            color: fullRoot.cardColor
                            radius: Kirigami.Units.smallSpacing
                            border.color: fullRoot.hairlineColor
                            border.width: 1
                        }

                        contentItem: ColumnLayout {
                            spacing: Kirigami.Units.smallSpacing / 2

                            // Label, value and countdown share one line.
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Kirigami.Units.smallSpacing

                                Controls.Label {
                                    Layout.fillWidth: true
                                    text: windowRow.modelData.label
                                    elide: Text.ElideRight
                                    font.family: fullRoot.effectiveFontFamily
                                    font.weight: Font.DemiBold
                                    color: fullRoot.activeModel !== null
                                        ? fullRoot.labelTextColor(fullRoot.activeModel.textColor)
                                        : Kirigami.Theme.textColor
                                    opacity: fullRoot.activeModel !== null ? fullRoot.activeModel.labelOpacity : 1.0
                                }

                                Controls.Label {
                                    visible: windowRow.modelData.usedPercent !== undefined
                                    text: Math.floor(windowRow.modelData.usedPercent) + "%"
                                    color: fullRoot.windowValueTextColor(windowRow.modelData.thresholdLevel)
                                    font.family: fullRoot.effectiveFontFamily
                                    font.weight: Font.DemiBold
                                }

                                Controls.Label {
                                    visible: windowRow.countdown.length > 0
                                    text: windowRow.modelData.usedPercent !== undefined
                                        ? qsTr("· %1").arg(windowRow.countdown)
                                        : windowRow.countdown
                                    font.family: fullRoot.effectiveFontFamily
                                    opacity: 0.8
                                }
                            }

                            Item {
                                Layout.fillWidth: true
                                visible: windowRow.modelData.progressFraction !== undefined
                                implicitHeight: windowBar.implicitHeight

                                Controls.ProgressBar {
                                    id: windowBar
                                    anchors.fill: parent
                                    from: 0
                                    to: 1
                                    value: windowRow.modelData.progressFraction !== undefined ? windowRow.modelData.progressFraction : 0
                                    Accessible.name: qsTr("%1 progress").arg(windowRow.modelData.label)
                                    palette.highlight: fullRoot.barFillColor(windowRow.modelData)
                                }
                                PaceTick {
                                    fraction: windowRow.pace
                                }
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Kirigami.Units.smallSpacing
                                visible: windowRow.countsText.length > 0 || windowRow.timestampText.length > 0

                                Controls.Label {
                                    Layout.fillWidth: true
                                    text: windowRow.countsText
                                    elide: Text.ElideRight
                                    color: fullRoot.windowValueTextColor(windowRow.modelData.thresholdLevel)
                                    font.family: fullRoot.effectiveFontFamily
                                    font.pointSize: Kirigami.Theme.smallFont.pointSize
                                }

                                Controls.Label {
                                    visible: windowRow.timestampText.length > 0
                                    text: qsTr("Resets %1").arg(windowRow.timestampText)
                                    elide: Text.ElideLeft
                                    Layout.maximumWidth: windowRow.availableWidth * 0.6
                                    opacity: 0.7
                                    font.family: fullRoot.effectiveFontFamily
                                    font.pointSize: Kirigami.Theme.smallFont.pointSize
                                }
                            }
                        }
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.topMargin: Kirigami.Units.smallSpacing / 2
                    implicitHeight: 1
                    color: fullRoot.hairlineColor
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
                            color: fullRoot.activeModel !== null
                                ? fullRoot.labelTextColor(fullRoot.activeModel.textColor)
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
                            Layout.fillWidth: true
                            text: modelData.value
                            wrapMode: Text.Wrap
                            font.family: fullRoot.effectiveFontFamily
                            color: fullRoot.activeModel !== null
                                ? fullRoot.labelTextColor(fullRoot.activeModel.textColor)
                                : Kirigami.Theme.textColor
                        }
                    }
                }
            }
        }

        // No providers enabled is a configuration state, distinct from enabled
        // providers still waiting for data (those get pending overview rows).
        Kirigami.PlaceholderMessage {
            id: noProvidersMessage
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: !fullRoot.hasEnabledProviders
            icon.name: "configure"
            text: qsTr("No providers enabled")
            explanation: qsTr("Turn on at least one provider in Kuota's settings to see its usage here.")
            // NOTE: PlaceholderMessage exposes no `font` property (qmllint:
            // unresolved grouped property) — this text keeps the theme font;
            // documented divergence from "all widget text". There is nothing
            // to refresh, so the only action is opening the settings.
            helpfulAction: Kirigami.Action {
                icon.name: "configure"
                text: qsTr("Configure Kuota…")
                onTriggered: fullRoot.requestConfigure()
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
