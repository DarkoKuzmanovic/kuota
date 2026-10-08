import QtQuick
import QtTest

TestCase {
    id: testCase
    name: "ConfigProviders"
    when: windowShown
    visible: true

    function checkboxes(item) {
        var result = [];
        if (typeof item.checked === "boolean" &&
                (item.text === "Show in widget" || item.text === "Show and collect usage")) result.push(item);
        var children = item.children || [];
        for (var i = 0; i < children.length; i++) result = result.concat(checkboxes(children[i]));
        return result;
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
}
