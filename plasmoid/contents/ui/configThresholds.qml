import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import org.kde.kirigami 2.20 as Kirigami

Kirigami.FormLayout {
    id: page

    property alias cfg_cautionThreshold: cautionSpin.value
    property alias cfg_criticalThreshold: criticalSpin.value
    property alias cfg_refreshIntervalMinutes: refreshIntervalSpin.value

    Controls.SpinBox {
        id: cautionSpin
        objectName: "cautionThresholdSpin"
        Kirigami.FormData.label: qsTr("Caution at:")
        Accessible.name: qsTr("Caution threshold percent")
        from: 0
        to: 100
        stepSize: 1
        textFromValue: function (value) { return value + "%"; }
        valueFromText: function (text) { return parseInt(text, 10); }
        onValueModified: {
            if (value >= criticalSpin.value) {
                criticalSpin.value = Math.min(100, value + 1);
            }
        }
    }

    Controls.SpinBox {
        id: criticalSpin
        objectName: "criticalThresholdSpin"
        Kirigami.FormData.label: qsTr("Critical at:")
        Accessible.name: qsTr("Critical threshold percent")
        from: 0
        to: 100
        stepSize: 1
        textFromValue: function (value) { return value + "%"; }
        valueFromText: function (text) { return parseInt(text, 10); }
        onValueModified: {
            if (value <= cautionSpin.value) {
                cautionSpin.value = Math.max(0, value - 1);
            }
        }
    }

    Controls.Label {
        Kirigami.FormData.label: ""
        visible: cautionSpin.value >= criticalSpin.value
        text: qsTr("Caution must stay lower than critical. Adjusting values to keep the pair valid.")
        color: Kirigami.Theme.neutralTextColor
        wrapMode: Text.WordWrap
        Layout.fillWidth: true
    }

    Controls.SpinBox {
        id: refreshIntervalSpin
        Kirigami.FormData.label: qsTr("Refresh every:")
        Accessible.name: qsTr("Refresh interval in minutes")
        from: 5
        to: 240
        stepSize: 1
        textFromValue: function (value) { return value + " " + qsTr("min"); }
        valueFromText: function (text) { return parseInt(text, 10); }
    }
}
