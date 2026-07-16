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

    readonly property alias clickTarget: clickCapture
    readonly property alias entryRepeaterItem: entryRepeater

    signal requestExpand()

    readonly property var entries: CompactModel.buildCompactEntries(
        snapshot,
        displayConfig !== undefined && displayConfig !== null ? displayConfig : defaultDisplayConfig
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
        spacing: Kirigami.Units.smallSpacing

        Kirigami.Icon {
            visible: !compactRoot.hasEntries
            width: Kirigami.Units.iconSizes.smallMedium
            height: width
            source: "network-server"
        }

        Kirigami.Heading {
            visible: !compactRoot.hasEntries
            level: 5
            opacity: 0.7
            text: qsTr("Kuota")
        }

        Repeater {
            id: entryRepeater
            model: compactRoot.hasEntries ? compactRoot.entries : []

            delegate: Row {
                id: entryRow
                spacing: Kirigami.Units.smallSpacing

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
                    opacity: 0.6
                    font.pointSize: compactRoot.fontPointSize
                    text: compactRoot.separator
                }

                Kirigami.Icon {
                    visible: compactRoot.showIcons
                    width: Kirigami.Units.iconSizes.smallMedium
                    height: width
                    source: compactRoot.providerIconName(modelData.providerId)
                }

                Kirigami.Heading {
                    visible: compactRoot.showText
                    level: 5
                    font.pointSize: compactRoot.fontPointSize
                    color: Kirigami.Theme.highlightColor
                    text: modelData.label
                }

                Kirigami.Heading {
                    visible: compactRoot.showText && modelData.displayValue.length > 0
                    level: 5
                    font.pointSize: compactRoot.fontPointSize
                    color: compactRoot.valueTextColor(modelData.thresholdLevel)
                    text: modelData.displayValue
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