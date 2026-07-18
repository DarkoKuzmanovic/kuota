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
            // Keep caution < critical. Default: nudge critical up to preserve the
            // user's edited caution value. Only when nudging critical would
            // overflow past 100 (caution pushed to 100, critical would need 101)
            // does the pair stay equal — fall back to clamping caution down to
            // critical-1 so the invariant holds at the boundary.
            if (value >= criticalSpin.value) {
                if (value < 100) {
                    criticalSpin.value = value + 1;
                } else {
                    value = criticalSpin.value - 1;
                    cautionSpin.value = value;
                }
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
            // Keep critical > caution. Default: nudge caution down to preserve
            // the user's edited critical value. Only when nudging caution would
            // underflow below 0 (critical pushed to 0, caution would need -1)
            // does the pair stay equal — fall back to clamping critical up to
            // caution+1 so the invariant holds at the boundary.
            if (value <= cautionSpin.value) {
                if (value > 0) {
                    cautionSpin.value = value - 1;
                } else {
                    value = cautionSpin.value + 1;
                    criticalSpin.value = value;
                }
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
