import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as Controls
import org.kde.kirigami 2.20 as Kirigami

Kirigami.FormLayout {
    id: page

    property alias cfg_claudeVisible: claudeVisibleCheck.checked
    property alias cfg_codexVisible: codexVisibleCheck.checked
    property alias cfg_grokVisible: grokVisibleCheck.checked
    property alias cfg_kimiVisible: kimiVisibleCheck.checked
    property alias cfg_cursorVisible: cursorVisibleCheck.checked
    property alias cfg_opencodeVisible: opencodeVisibleCheck.checked
    property alias cfg_commandcodeVisible: commandcodeVisibleCheck.checked
    property alias cfg_claudeWindow: claudeWindowCombo.currentValue
    property alias cfg_codexWindow: codexWindowCombo.currentValue
    property alias cfg_grokWindow: grokWindowCombo.currentValue
    property alias cfg_kimiWindow: kimiWindowCombo.currentValue
    property alias cfg_opencodeWindow: opencodeWindowCombo.currentValue
    property alias cfg_commandcodeWindow: commandcodeWindowCombo.currentValue

    // StringList has no 1:1 widget; the reorder Repeater below reads/writes
    // this plain array directly (matches the compact-model.js entries pattern).
    property var cfg_providerOrder: ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]

    function providerLabel(providerId) {
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
        id: codexVisibleCheck
        Kirigami.FormData.label: qsTr("Codex:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("Codex visible")
    }

    Controls.CheckBox {
        id: grokVisibleCheck
        Kirigami.FormData.label: qsTr("Grok:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("Grok visible")
    }

    Controls.CheckBox {
        id: kimiVisibleCheck
        Kirigami.FormData.label: qsTr("Kimi:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("Kimi visible")
    }

    Controls.CheckBox {
        id: cursorVisibleCheck
        Kirigami.FormData.label: qsTr("Cursor:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("Cursor visible")
    }

    Controls.CheckBox {
        id: opencodeVisibleCheck
        Kirigami.FormData.label: qsTr("OpenCode:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("OpenCode visible")
    }

    Controls.CheckBox {
        id: commandcodeVisibleCheck
        Kirigami.FormData.label: qsTr("CommandCode:")
        text: qsTr("Show in widget")
        Accessible.name: qsTr("CommandCode visible")
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
        model: 7

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

    // One selector per provider with more than one genuinely meaningful usage
    // window (D4, amended 2026-09-05). Cursor shows a single "plan" window and
    // deliberately has no combo: a control that cannot change anything is a
    // dead control. Catalog values must match KNOWN_WINDOWS in
    // config-model.js; "Default" (empty) defers to the primary window.
    Controls.ComboBox {
        id: claudeWindowCombo
        objectName: "claudeWindowCombo"
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
        objectName: "codexWindowCombo"
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

    Controls.ComboBox {
        id: grokWindowCombo
        objectName: "grokWindowCombo"
        Kirigami.FormData.label: qsTr("Grok:")
        Accessible.name: qsTr("Grok usage window")
        textRole: "text"
        valueRole: "value"
        model: [
            { text: qsTr("Default"), value: "" },
            { text: qsTr("7d"), value: "week" },
            { text: qsTr("30d"), value: "month" }
        ]
    }

    Controls.ComboBox {
        id: kimiWindowCombo
        objectName: "kimiWindowCombo"
        Kirigami.FormData.label: qsTr("Kimi:")
        Accessible.name: qsTr("Kimi usage window")
        textRole: "text"
        valueRole: "value"
        model: [
            { text: qsTr("Default"), value: "" },
            { text: qsTr("Week"), value: "week" },
            // Kimi's short window is duration-derived; ids cover every label
            // the collector can emit. Ones the account lacks fall back to the
            // primary window.
            { text: qsTr("5h"), value: "5h" },
            { text: qsTr("Daily"), value: "daily" },
            { text: qsTr("Month"), value: "month" }
        ]
    }

    Controls.ComboBox {
        id: opencodeWindowCombo
        objectName: "opencodeWindowCombo"
        Kirigami.FormData.label: qsTr("OpenCode:")
        Accessible.name: qsTr("OpenCode usage window")
        textRole: "text"
        valueRole: "value"
        model: [
            { text: qsTr("Default"), value: "" },
            { text: qsTr("5h"), value: "rolling" },
            { text: qsTr("Weekly"), value: "weekly" },
            { text: qsTr("Monthly"), value: "monthly" }
        ]
    }

    Controls.ComboBox {
        id: commandcodeWindowCombo
        objectName: "commandcodeWindowCombo"
        Kirigami.FormData.label: qsTr("CommandCode:")
        Accessible.name: qsTr("CommandCode usage window")
        textRole: "text"
        valueRole: "value"
        model: [
            { text: qsTr("Default"), value: "" },
            { text: qsTr("5h"), value: "fiveHour" },
            { text: qsTr("Weekly"), value: "weekly" }
        ]
    }
}
