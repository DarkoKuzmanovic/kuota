import QtQuick
import QtQuick.Layouts
import org.kde.kirigami 2.20 as Kirigami

import "compact-model.js" as CompactModel

FocusScope {
    id: compactRoot

    readonly property var defaultDisplayConfig: CompactModel.createDefaultDisplayConfig()

    property var snapshot: null
    property var displayConfig: defaultDisplayConfig
    property string compactDisplayMode: "icons+text"
    property string separator: " · "
    property real fontScale: 1.0
    // Appearance overrides (M12 theming). `null` reproduces V1 exactly;
    // main.qml passes the sanitized settings. `fontFamily` "" means the
    // theme default font.
    property var appearance: null
    property string fontFamily: ""

    // Per-gap spacing tunables (issue 3). Pixels, integer, clamped 0..64 at the
    // sanitize boundary. Defaults roughly reproduce the V1 smallSpacing/2 look
    // for icon→label (2px) with a tighter label→value (1px); users widen or
    // collapse them independently.
    property int iconLabelSpacing: 2
    property int labelValueSpacing: 1

    readonly property real contentMargin: Kirigami.Units.smallSpacing
    // Size to the Row positioner's own implicit content size (reliable) rather
    // than childrenRect, which under-reports width to the panel and let the
    // widget overlap its neighbor. Expose Layout hints so a horizontal panel
    // allocates the full content width (bare implicitWidth is not honored for
    // panel width allocation — Layout.preferredWidth is). Panel controls height.
    implicitWidth: contentRow.implicitWidth + 2 * contentMargin
    implicitHeight: contentRow.implicitHeight + 2 * contentMargin
    Layout.minimumWidth: implicitWidth
    Layout.preferredWidth: implicitWidth
    property real fontPointSize: Kirigami.Theme.defaultFont.pointSize * fontScale
    readonly property string effectiveFontFamily: fontFamily !== "" ? fontFamily : Kirigami.Theme.defaultFont.family

    // Icon size tuned to current font so custom PNG/SVG don't dwarf the text (issue 1).
    readonly property int iconSize: Math.max(Kirigami.Units.iconSizes.small, Math.round(fontPointSize * 1.3))

    readonly property alias clickTarget: clickCapture
    readonly property alias entryRepeaterItem: entryRepeater

    signal requestExpand()

    readonly property var entries: CompactModel.buildCompactEntries(
        snapshot,
        displayConfig !== undefined && displayConfig !== null ? displayConfig : defaultDisplayConfig,
        appearance !== undefined && appearance !== null ? appearance : {}
    )

    readonly property bool hasEntries: entries.length > 0
    // Honors the user's explicit displayMode (M9 config) rather than reading own
    // width: a width-based auto-degrade previously created a binding loop
    // (implicitWidth -> childrenRect -> text visibility -> showText ->
    // effectiveDisplayMode -> width -> implicitWidth) that froze the panel in
    // icons-only mode. See AGENTS.md Lessons (2026-07-16, M7 sizing gotcha superseded).
    readonly property string effectiveDisplayMode: compactDisplayMode

    readonly property bool showIcons: effectiveDisplayMode === "icons" || effectiveDisplayMode === "icons+text"
    // Issue 2 (2026-07-22): "icons" mode hides the provider LABEL (caption) but
    // keeps the VALUE (percentage/count) visible — previously the mode hid both.
    // See AGENTS.md Lessons (2026-07-22, icons-mode semantic change).
    readonly property bool showLabel: effectiveDisplayMode === "text" || effectiveDisplayMode === "icons+text"
    readonly property bool showValue: true

    activeFocusOnTab: true
    Accessible.role: Accessible.Button
    Accessible.name: hasEntries
        ? qsTr("Kuota usage summary, %1 providers").arg(entries.length)
        : qsTr("Kuota usage summary, no data")

    Keys.onReturnPressed: compactRoot.requestExpand()
    Keys.onSpacePressed: compactRoot.requestExpand()

    function providerIconName(providerId) {
        switch (providerId) {
        case "claude":
            return "assistant";
        case "umans":
            return "applications-development";
        case "codex":
            return "utilities-terminal";
        default:
            return "network-server";
        }
    }

    // Absolute path custom icons (PNG/SVG from IconDialog "Other icons") must
    // render as full-color images — isMask monochrome is only for theme names.
    function isLocalIconPath(value) {
        return typeof value === "string" && value.length > 0 && value.charAt(0) === "/";
    }

    function iconSourceFor(entry) {
        if (entry.iconName === "") {
            return providerIconName(entry.providerId);
        }
        if (isLocalIconPath(entry.iconName)) {
            return "file://" + entry.iconName;
        }
        return entry.iconName;
    }

    function iconIsMask(entry) {
        if (isLocalIconPath(entry.iconName)) {
            return false;
        }
        return entry.textColor !== "" || entry.iconName !== "";
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

    function stateIndicator(entry) {
        if (entry.state === "auth-needed") {
            return { icon: "object-locked", label: qsTr("Login needed"), show: true };
        }
        if (entry.state === "error") {
            return { icon: "dialog-warning", label: qsTr("Error"), show: true };
        }
        if (entry.state === "stale") {
            return { icon: "view-refresh", label: qsTr("Stale"), show: true };
        }
        return { icon: "", label: "", show: false };
    }


    Row {
        id: contentRow
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        anchors.margins: contentMargin
        spacing: Kirigami.Units.largeSpacing

        Kirigami.Icon {
            visible: !compactRoot.hasEntries
            width: Kirigami.Units.iconSizes.smallMedium
            height: width
            source: "network-server"
        }

        Kirigami.Heading {
            visible: !compactRoot.hasEntries
            level: 5
            font.family: compactRoot.effectiveFontFamily
            opacity: 0.7
            text: qsTr("Kuota")
        }

        Repeater {
            id: entryRepeater
            model: compactRoot.hasEntries ? compactRoot.entries : []

            delegate: Row {
                id: entryRow
                spacing: Kirigami.Units.smallSpacing / 2

                required property var modelData
                required property int index

                property var stateInfo: compactRoot.stateIndicator(modelData)
                // Computed on entryRow itself (reading its own required `index`
                // directly) rather than in the nested Heading's binding below —
                // a nested child reading a parent delegate's required property
                // directly was observed to capture a stale pre-injection value
                // with no reactive re-trigger. Mirrors the stateInfo pattern above.
                property bool showSeparator: index > 0 && compactRoot.separator.length > 0

                Accessible.role: Accessible.StaticText
                Accessible.name: modelData.label + ", " + modelData.displayValue
                    + (stateInfo.show ? ", " + stateInfo.label : "")

                Kirigami.Heading {
                    objectName: "separatorLabel"
                    level: 5
                    visible: showSeparator
                    opacity: 0.6 * modelData.separatorOpacity
                    font.pointSize: compactRoot.fontPointSize
                    font.family: compactRoot.effectiveFontFamily
                    text: compactRoot.separator
                    anchors.verticalCenter: parent.verticalCenter
                }

                // Inner group: spacing 0 so the two configured spacers below are
                // the ONLY gaps between icon / label / value. As direct entryRow
                // children they picked up entryRow.spacing (smallSpacing/2) on
                // both sides, so a configured 0 could never collapse a gap (it
                // floored at smallSpacing). The outer entryRow.spacing is
                // intentionally retained for the separator / valueDot / state
                // siblings that still need their V1 small/2 look.
                Row {
                    id: iconLabelValueGroup
                    spacing: 0
                    anchors.verticalCenter: parent.verticalCenter

                    Kirigami.Icon {
                        objectName: "providerIcon"
                        visible: compactRoot.showIcons
                        width: compactRoot.iconSize
                        height: width
                        source: compactRoot.iconSourceFor(modelData)
                        // Monochrome mask for theme icon names when theming is active;
                        // local image paths keep full color so custom PNG/SVG logos show.
                        isMask: compactRoot.iconIsMask(modelData)
                        color: modelData.textColor !== "" ? modelData.textColor : Kirigami.Theme.textColor
                        anchors.verticalCenter: parent.verticalCenter
                    }

                    // Per-gap spacing for issue 3 (icon → next visible thing). Explicit Item
                    // spacer instead of Row.spacing lets two unrelated per-gap
                    // values coexist with the entryRow's default small/2 spacing;
                    // visibility tracks the icon and the NEXT visible heading so
                    // a hidden icon does not leave a phantom gap, and in
                    // icons-only mode the icon → percentage gap uses the same
                    // iconLabelSpacing value (the label heading is hidden but the
                    // value heading is still rendered after the icon).
                    Item {
                        objectName: "iconLabelSpacer"
                        width: compactRoot.iconLabelSpacing
                        height: 1
                        visible: compactRoot.showIcons && (compactRoot.showLabel || (compactRoot.showValue && modelData.displayValue.length > 0))
                    }

                    Kirigami.Heading {
                        objectName: "labelHeading"
                        visible: compactRoot.showLabel
                        level: 5
                        font.pointSize: compactRoot.fontPointSize
                        font.family: compactRoot.effectiveFontFamily
                        color: modelData.textColor !== "" ? modelData.textColor : Kirigami.Theme.textColor
                        opacity: 0.7 * modelData.labelOpacity
                        text: modelData.label
                        anchors.verticalCenter: parent.verticalCenter
                    }

                    // Per-gap spacing for issue 3 (label → value). Visibility
                    // tracks the label and value so a hidden label does not waste
                    // a gap before the value (icons mode keeps value, drops label).
                    Item {
                        objectName: "labelValueSpacer"
                        width: compactRoot.labelValueSpacing
                        height: 1
                        visible: compactRoot.showLabel && compactRoot.showValue && modelData.displayValue.length > 0
                    }

                    Kirigami.Heading {
                        objectName: "valueHeading"
                        visible: compactRoot.showValue && modelData.displayValue.length > 0
                        level: 5
                        font.pointSize: compactRoot.fontPointSize
                        font.family: compactRoot.effectiveFontFamily
                        font.weight: Font.DemiBold
                        color: modelData.valueColor !== "" ? modelData.valueColor : compactRoot.valueTextColor(modelData.thresholdLevel)
                        text: modelData.displayValue
                        anchors.verticalCenter: parent.verticalCenter
                    }
                }

                Rectangle {
                    objectName: "valueDot"
                    width: Kirigami.Units.smallSpacing
                    height: width
                    radius: width / 2
                    antialiasing: true
                    anchors.verticalCenter: parent.verticalCenter
                    color: modelData.valueColor !== "" ? modelData.valueColor : compactRoot.valueTextColor(modelData.thresholdLevel)
                    visible: compactRoot.showValue && modelData.displayValue.length > 0
                }

                Kirigami.Icon {
                    objectName: "stateIcon"
                    visible: stateInfo.show && compactRoot.showIcons
                    width: compactRoot.iconSize
                    height: width
                    source: stateInfo.icon
                    anchors.verticalCenter: parent.verticalCenter
                }

                Kirigami.Heading {
                    objectName: "stateLabel"
                    visible: stateInfo.show && compactRoot.showLabel
                    level: 5
                    font.pointSize: compactRoot.fontPointSize - 1
                    font.family: compactRoot.effectiveFontFamily
                    opacity: 0.85
                    text: stateInfo.label
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }
    }

    MouseArea {
        id: clickCapture
        z: 1
        anchors.fill: parent
        hoverEnabled: true
        onClicked: compactRoot.requestExpand()
    }
}