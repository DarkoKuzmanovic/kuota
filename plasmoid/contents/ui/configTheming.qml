import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as Controls
import org.kde.kirigami 2.20 as Kirigami
import org.kde.iconthemes as Iconthemes

Kirigami.FormLayout {
    id: page

    property alias cfg_fontFamily: fontFamilyField.text
    property alias cfg_customTextColorEnabled: customTextColorCheck.checked
    property string cfg_customTextColor: ""
    property alias cfg_labelOpacity: labelOpacitySlider.value
    property alias cfg_separatorOpacity: separatorOpacitySlider.value

    // Per-provider theming keys (flat KConfigXT entries, read/written by the
    // repeater rows below via dynamic property access).
    property string cfg_claudeAccentColor: ""
    property string cfg_umansAccentColor: ""
    property string cfg_codexAccentColor: ""
    property string cfg_grokAccentColor: ""
    property string cfg_kimiAccentColor: ""
    property string cfg_claudeCustomIcon: ""
    property string cfg_umansCustomIcon: ""
    property string cfg_codexCustomIcon: ""
    property string cfg_grokCustomIcon: ""
    property string cfg_kimiCustomIcon: ""

    readonly property var providerIds: ["claude", "umans", "codex", "grok", "kimi"]

    function providerLabel(providerId) {
        switch (providerId) {
        case "claude":
            return qsTr("Claude");
        case "umans":
            return qsTr("Umans");
        case "codex":
            return qsTr("Codex");
        case "grok":
            return qsTr("Grok");
        case "kimi":
            return qsTr("Kimi");
        default:
            return providerId;
        }
    }

    function providerDefaultIcon(providerId) {
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

    function isLocalIconPath(value) {
        return typeof value === "string" && value.length > 0 && value.charAt(0) === "/";
    }

    function providerIconName(providerId) {
        var custom = page["cfg_" + providerId + "CustomIcon"];
        if (custom !== "" && !isLocalIconPath(custom)) {
            return custom;
        }
        return providerDefaultIcon(providerId);
    }

    function providerIconSource(providerId) {
        var custom = page["cfg_" + providerId + "CustomIcon"];
        if (isLocalIconPath(custom)) {
            return "file://" + custom;
        }
        return "";
    }

    // Mirrors the sanitize boundary's accepted shapes so the preview swatch
    // never assigns an unparseable color (QML warns on invalid color strings).
    function isValidColorString(value) {
        return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
            || /^[a-zA-Z]+$/.test(value);
    }

    Kirigami.Heading {
        Kirigami.FormData.isSection: true
        level: 4
        text: qsTr("Font")
    }

    Controls.TextField {
        id: fontFamilyField
        Kirigami.FormData.label: qsTr("Font family:")
        Accessible.name: qsTr("Widget font family override")
        placeholderText: qsTr("Plasma system font")
    }

    Kirigami.Heading {
        Kirigami.FormData.isSection: true
        level: 4
        text: qsTr("Text color")
    }

    Controls.CheckBox {
        id: customTextColorCheck
        Kirigami.FormData.label: qsTr("Custom text color:")
        text: qsTr("Override Plasma theme text color")
        Accessible.name: qsTr("Custom text color enabled")
    }

    RowLayout {
        Kirigami.FormData.label: qsTr("Color:")
        enabled: customTextColorCheck.checked

        Controls.TextField {
            id: customTextColorField
            Accessible.name: qsTr("Custom text color value")
            placeholderText: qsTr("#rrggbb or color name")
            // KConfig may load/reset the value externally; reflect that.
            Binding on text {
                value: page.cfg_customTextColor
                when: !customTextColorField.activeFocus
            }
            onTextEdited: page.cfg_customTextColor = text
        }

        Rectangle {
            Layout.preferredWidth: Kirigami.Units.gridUnit
            Layout.preferredHeight: Kirigami.Units.gridUnit
            radius: 2
            border.width: 1
            border.color: Kirigami.Theme.disabledTextColor
            color: page.isValidColorString(customTextColorField.text)
                ? customTextColorField.text
                : "transparent"
        }
    }

    Kirigami.Heading {
        Kirigami.FormData.isSection: true
        level: 4
        text: qsTr("Opacity")
    }

    RowLayout {
        Kirigami.FormData.label: qsTr("Labels:")

        Controls.Slider {
            id: labelOpacitySlider
            value: 1.0  // schema default; KConfig overwrites on load
            Layout.fillWidth: true
            from: 0.0
            to: 1.0
            stepSize: 0.05
            Accessible.name: qsTr("Label opacity")
        }

        Controls.Label {
            text: Math.round(labelOpacitySlider.value * 100) + "%"
        }
    }

    RowLayout {
        Kirigami.FormData.label: qsTr("Separators:")

        Controls.Slider {
            id: separatorOpacitySlider
            value: 1.0  // schema default; KConfig overwrites on load
            Layout.fillWidth: true
            from: 0.0
            to: 1.0
            stepSize: 0.05
            Accessible.name: qsTr("Separator opacity")
        }

        Controls.Label {
            text: Math.round(separatorOpacitySlider.value * 100) + "%"
        }
    }

    Kirigami.Heading {
        Kirigami.FormData.isSection: true
        level: 4
        text: qsTr("Per-provider accent and icon")
    }

    Repeater {
        model: page.providerIds

        delegate: RowLayout {
            id: providerRow
            required property string modelData

            readonly property string providerId: modelData

            Kirigami.FormData.label: page.providerLabel(providerRow.providerId) + ":"

            Controls.TextField {
                id: accentField
                Layout.fillWidth: true
                Accessible.name: qsTr("%1 accent color").arg(page.providerLabel(providerRow.providerId))
                placeholderText: qsTr("Accent color (optional)")
                Binding on text {
                    value: page["cfg_" + providerRow.providerId + "AccentColor"]
                    when: !accentField.activeFocus
                }
                onTextEdited: page["cfg_" + providerRow.providerId + "AccentColor"] = text
            }

            Rectangle {
                Layout.preferredWidth: Kirigami.Units.gridUnit
                Layout.preferredHeight: Kirigami.Units.gridUnit
                radius: 2
                border.width: 1
                border.color: Kirigami.Theme.disabledTextColor
                color: page.isValidColorString(accentField.text) ? accentField.text : "transparent"
            }

            Controls.Button {
                // Theme names go through icon.name; absolute image paths need
                // icon.source (icon.name cannot load /path/to/file.png).
                icon.name: page.providerIconName(providerRow.providerId)
                icon.source: page.providerIconSource(providerRow.providerId)
                text: qsTr("Change…")
                Accessible.name: qsTr("Change %1 icon").arg(page.providerLabel(providerRow.providerId))
                onClicked: {
                    iconDialog.targetProvider = providerRow.providerId;
                    iconDialog.open();
                }
            }

            Controls.ToolButton {
                icon.name: "edit-clear"
                Accessible.name: qsTr("Reset %1 icon").arg(page.providerLabel(providerRow.providerId))
                visible: page["cfg_" + providerRow.providerId + "CustomIcon"] !== ""
                onClicked: page["cfg_" + providerRow.providerId + "CustomIcon"] = ""
            }
        }
    }

    Iconthemes.IconDialog {
        id: iconDialog
        property string targetProvider: ""
        onIconNameChanged: {
            if (targetProvider !== "" && iconName !== "") {
                page["cfg_" + targetProvider + "CustomIcon"] = iconName;
            }
        }
    }
}
