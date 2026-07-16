import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as Controls
import org.kde.kirigami 2.20 as Kirigami

Kirigami.FormLayout {
    id: page

    property alias cfg_claudeVisible: claudeVisibleCheck.checked
    property alias cfg_umansVisible: umansVisibleCheck.checked
    property alias cfg_codexVisible: codexVisibleCheck.checked
    property alias cfg_claudeWindow: claudeWindowCombo.currentValue
    property alias cfg_codexWindow: codexWindowCombo.currentValue

    // StringList has no 1:1 widget; the reorder Repeater below reads/writes
    // this plain array directly (matches the compact-model.js entries pattern).
    property var cfg_providerOrder: ["claude", "umans", "codex"]

    function providerLabel(providerId) {
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

    function moveProvider(index, direction) {
        var newIndex = index + direction;
        if (newIndex < 0 || newIndex >= page.cfg_providerOrder.length) {
            return;
        }
        var reordered = page.cfg_providerOrder.slice();
        var swap = reordered[index];
        reordered[index] = reordered[newIndex];
        reordered[newIndex] = swap;
        page.cfg_providerOrder = reordered;
    }

    Kirigami.Heading {
        Kirigami.FormData.isSection: true
        level: 4
        text: qsTr("Visibility")
    }

    Controls.CheckBox {
        id: claudeVisibleCheck
        Kirigami.FormData.label: qsTr("Claude:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("Claude visible")
    }

    Controls.CheckBox {
        id: umansVisibleCheck
        Kirigami.FormData.label: qsTr("Umans:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("Umans visible")
    }

    Controls.CheckBox {
        id: codexVisibleCheck
        Kirigami.FormData.label: qsTr("Codex:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("Codex visible")
    }

    Kirigami.Heading {
        Kirigami.FormData.isSection: true
        level: 4
        text: qsTr("Order")
    }

    Repeater {
        // Fixed count (never changes) rather than binding directly to the
        // cfg_providerOrder array: Repeater treats any array reassignment as
        // an opaque model change and fully destroys+recreates every delegate,
        // which was observed to transiently break Kirigami FormLayout's
        // per-child row bookkeeping ("Cannot read property 'Accessible' of
        // null" etc. during reorder). Each row instead looks up its own
        // provider id reactively via `index`, so reordering only re-evaluates
        // bindings in place — no delegate teardown.
        model: 3

        delegate: RowLayout {
            id: providerOrderRow
            required property int index

            readonly property string providerId: page.cfg_providerOrder[providerOrderRow.index]

            Kirigami.FormData.label: (providerOrderRow.index + 1) + "."

            Controls.Label {
                text: page.providerLabel(providerOrderRow.providerId)
                Layout.preferredWidth: Kirigami.Units.gridUnit * 6
            }

            Controls.Button {
                icon.name: "go-up"
                enabled: providerOrderRow.index > 0
                Accessible.name: qsTr("Move %1 up").arg(page.providerLabel(providerOrderRow.providerId))
                onClicked: page.moveProvider(providerOrderRow.index, -1)
            }

            Controls.Button {
                icon.name: "go-down"
                enabled: providerOrderRow.index < page.cfg_providerOrder.length - 1
                Accessible.name: qsTr("Move %1 down").arg(page.providerLabel(providerOrderRow.providerId))
                onClicked: page.moveProvider(providerOrderRow.index, 1)
            }
        }
    }

    Kirigami.Heading {
        Kirigami.FormData.isSection: true
        level: 4
        text: qsTr("Usage window")
    }

    Controls.ComboBox {
        id: claudeWindowCombo
        Kirigami.FormData.label: qsTr("Claude:")
        Accessible.name: qsTr("Claude usage window")
        textRole: "text"
        valueRole: "value"
        model: [
            { text: qsTr("Default"), value: "" },
            { text: qsTr("Session"), value: "session" },
            { text: qsTr("Weekly (all)"), value: "weekly-all" },
            { text: qsTr("Weekly (OAuth apps)"), value: "weekly-oauth-apps" }
        ]
    }

    Controls.ComboBox {
        id: codexWindowCombo
        Kirigami.FormData.label: qsTr("Codex:")
        Accessible.name: qsTr("Codex usage window")
        textRole: "text"
        valueRole: "value"
        model: [
            { text: qsTr("Default"), value: "" },
            { text: qsTr("Primary"), value: "primary" },
            { text: qsTr("Secondary"), value: "secondary" }
        ]
    }
}
