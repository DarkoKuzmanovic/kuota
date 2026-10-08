import QtQuick
import QtTest

TestCase {
    id: testCase
    name: "ConfigProviders"
    when: windowShown
    visible: true

    Component {
        id: pageComponent
        Loader {
            source: "../../plasmoid/contents/ui/configProviders.qml"
        }
    }

    // Provider ids with more than one genuinely meaningful usage window get a
    // selector; Cursor (single "plan" window) deliberately has none.
    // Spec: docs/specs/2026-09-05-window-selector-all-providers-design.md
    readonly property var selectableProviders: ["claude", "codex", "grok", "kimi", "opencode", "commandcode"]

    function checkboxes(item) {
        var result = [];
        if (typeof item.checked === "boolean" &&
                (item.text === "Show in widget" || item.text === "Show and collect usage")) result.push(item);
        var children = item.children || [];
        for (var i = 0; i < children.length; i++) result = result.concat(checkboxes(children[i]));
        return result;
    }

    function findChildByObjectName(parent, name) {
        if (!parent || !parent.children) {
            return null;
        }
        for (var i = 0; i < parent.children.length; i++) {
            var child = parent.children[i];
            if (child.objectName === name) {
                return child;
            }
            var found = findChildByObjectName(child, name);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }

    function comboValues(combo) {
        var values = [];
        for (var i = 0; i < combo.model.length; i++) {
            values.push(combo.model[i].value);
        }
        return values;
    }

    function test_existingVisibilityKeysEnableDisplayAndCollection() {
        var component = Qt.createComponent("../../plasmoid/contents/ui/configProviders.qml");
        compare(component.status, Component.Ready, component.errorString());
        var page = component.createObject(testCase);
        try {
            var ids = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"];
            var names = ["Claude", "Codex", "Grok", "Kimi", "Cursor", "OpenCode", "CommandCode"];
            var checks = checkboxes(page);
            compare(checks.length, 7);
            for (var i = 0; i < checks.length; i++) {
                compare(checks[i].text, "Show and collect usage");
                compare(checks[i].Accessible.name, names[i] + " display and collection enabled");
                page["cfg_" + ids[i] + "Visible"] = true;
                compare(checks[i].checked, true);
                checks[i].checked = false;
                compare(page["cfg_" + ids[i] + "Visible"], false);
            }
            page.moveProvider(0, 1);
            wait(0);
            var after = checkboxes(page);
            compare(after.length, checks.length);
            for (var j = 0; j < checks.length; j++) compare(after[j], checks[j]);
        } finally { page.destroy(); }
    }

    function test_everySelectableProviderHasACombo() {
        var loader = pageComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var page = loader.item;
        verify(page !== null);

        for (var i = 0; i < selectableProviders.length; i++) {
            var id = selectableProviders[i];
            var combo = findChildByObjectName(page, id + "WindowCombo");
            verify(combo !== null, id + "WindowCombo exists");
            // Every combo defaults to "Default" (value ""), never to a hard-picked window.
            compare(combo.model[0].value, "", id + " Default option first");
            // The cfg_ alias exists and defaults to "" like the KConfigXT key.
            verify(page["cfg_" + id + "Window"] !== undefined, "cfg_" + id + "Window exists");
            compare(page["cfg_" + id + "Window"], "");
        }

        // Cursor has exactly one window — no selector, no alias (dead-control gate).
        verify(findChildByObjectName(page, "cursorWindowCombo") === null);
        verify(page.cfg_cursorWindow === undefined);

        loader.destroy();
    }

    function test_comboCatalogsMatchKnownWindowIds() {
        var loader = pageComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var page = loader.item;
        verify(page !== null);

        var expected = {
            claude: ["", "session", "weekly-all", "weekly-oauth-apps"],
            codex: ["", "primary", "secondary"],
            grok: ["", "week", "month"],
            kimi: ["", "week", "5h", "daily", "month"],
            opencode: ["", "rolling", "weekly", "monthly"],
            commandcode: ["", "fiveHour", "weekly"]
        };
        for (var id in expected) {
            if (!Object.prototype.hasOwnProperty.call(expected, id)) {
                continue;
            }
            var combo = findChildByObjectName(page, id + "WindowCombo");
            verify(combo !== null, id + "WindowCombo exists");
            compare(JSON.stringify(comboValues(combo)), JSON.stringify(expected[id]), id + " catalog");
        }

        loader.destroy();
    }

    function test_comboSelectionWritesBackThroughAlias() {
        var loader = pageComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var page = loader.item;
        verify(page !== null);

        var grokCombo = findChildByObjectName(page, "grokWindowCombo");
        verify(grokCombo !== null);
        grokCombo.currentIndex = 2; // "30d"
        compare(page.cfg_grokWindow, "month");

        var ccCombo = findChildByObjectName(page, "commandcodeWindowCombo");
        verify(ccCombo !== null);
        ccCombo.currentIndex = 1; // "5h" (explicitly the primary, not Default)
        compare(page.cfg_commandcodeWindow, "fiveHour");
        ccCombo.currentIndex = 0; // back to Default
        compare(page.cfg_commandcodeWindow, "");

        loader.destroy();
    }
}
