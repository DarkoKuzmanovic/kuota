import QtQuick
import QtQuick.Controls as Controls
import org.kde.kirigami 2.20 as Kirigami

Kirigami.FormLayout {
    id: page

    property alias cfg_displayMode: displayModeCombo.currentValue
    property alias cfg_separator: separatorField.text
    property alias cfg_showCountdown: showCountdownCheck.checked

    // fontScale (KConfigXT Double, unit multiplier: 1.0 = 100%) has no direct
    // QQC2.SpinBox equivalent (SpinBox.value is int-only), so it is a plain
    // (non-alias) cfg_ property with an explicit percent<->multiplier bridge.
    // `value:` stays a live binding so external changes (load, Defaults)
    // flow in; `onValueModified` (user-interaction-only, no feedback loop)
    // flows edits back out.
    property real cfg_fontScale: 1.0

    Controls.ComboBox {
        id: displayModeCombo
        Kirigami.FormData.label: qsTr("Display mode:")
        Accessible.name: qsTr("Display mode")
        textRole: "text"
        valueRole: "value"
        model: [
            { text: qsTr("Icons and text"), value: "icons+text" },
            { text: qsTr("Icons only"), value: "icons" },
            { text: qsTr("Text only"), value: "text" }
        ]
    }

    Controls.TextField {
        id: separatorField
        Kirigami.FormData.label: qsTr("Separator:")
        Accessible.name: qsTr("Separator between compact provider entries")
        placeholderText: qsTr("e.g. \u00b7")
    }

    Controls.SpinBox {
        id: fontScaleSpin
        Kirigami.FormData.label: qsTr("Font scale:")
        Accessible.name: qsTr("Compact view font scale percent")
        from: 50
        to: 300
        stepSize: 5
        value: Math.round(page.cfg_fontScale * 100)
        textFromValue: function (value) { return value + "%"; }
        valueFromText: function (text) { return parseInt(text, 10); }
        onValueModified: page.cfg_fontScale = value / 100
    }

    Controls.CheckBox {
        id: showCountdownCheck
        Kirigami.FormData.label: qsTr("Countdown:")
        text: qsTr("Show live reset countdown in the detail view")
        Accessible.name: text
    }
}
