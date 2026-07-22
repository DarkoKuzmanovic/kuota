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
    readonly property bool showText: effectiveDisplayMode === "text" || effectiveDisplayMode === "icons+text"

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
                }

                Kirigami.Icon {
                    visible: compactRoot.showIcons
                    width: Kirigami.Units.iconSizes.smallMedium
                    height: width
                    source: modelData.iconName !== "" ? modelData.iconName : compactRoot.providerIconName(modelData.providerId)
                    // Monochrome mask only when theming is active (custom icon or
                    // text color): preserves V1's full-color theme icons by default.
                    isMask: modelData.textColor !== "" || modelData.iconName !== ""
                    color: modelData.textColor !== "" ? modelData.textColor : Kirigami.Theme.textColor
                }

                Kirigami.Heading {
                    visible: compactRoot.showText
                    level: 5
                    font.pointSize: compactRoot.fontPointSize
                    font.family: compactRoot.effectiveFontFamily
                    color: modelData.textColor !== "" ? modelData.textColor : Kirigami.Theme.textColor
                    opacity: 0.7 * modelData.labelOpacity
                    text: modelData.label
                }

                Kirigami.Heading {
                    visible: compactRoot.showText && modelData.displayValue.length > 0
                    level: 5
                    font.pointSize: compactRoot.fontPointSize
                    font.family: compactRoot.effectiveFontFamily
                    font.weight: Font.DemiBold
                    color: modelData.valueColor !== "" ? modelData.valueColor : compactRoot.valueTextColor(modelData.thresholdLevel)
                    text: modelData.displayValue
                }

                Rectangle {
                    width: Kirigami.Units.smallSpacing
                    height: width
                    radius: width / 2
                    antialiasing: true
                    anchors.verticalCenter: parent.verticalCenter
                    color: modelData.valueColor !== "" ? modelData.valueColor : compactRoot.valueTextColor(modelData.thresholdLevel)
                    visible: compactRoot.showText && modelData.displayValue.length > 0
                }

                Kirigami.Icon {
                    visible: stateInfo.show && compactRoot.showIcons
                    width: Kirigami.Units.iconSizes.small
                    height: width
                    source: stateInfo.icon
                }

                Kirigami.Heading {
                    visible: stateInfo.show && compactRoot.showText
                    level: 5
                    font.pointSize: compactRoot.fontPointSize - 1
                    font.family: compactRoot.effectiveFontFamily
                    opacity: 0.85
                    text: stateInfo.label
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