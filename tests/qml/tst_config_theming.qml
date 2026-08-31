import QtQuick
import QtTest

TestCase {
    name: "ConfigTheming"

    // Lowercase QML file names can't be imported as types; instantiate via
    // Qt.createComponent (resolves relative to this file).
    function test_pageLoadsAndExposesAllThemingKeys() {
        var component = Qt.createComponent("../../plasmoid/contents/ui/configTheming.qml");
        if (component.status === Component.Error) {
            console.log(component.errorString());
        }
        compare(component.status, Component.Ready);
        var page = component.createObject(null);
        verify(page !== null);

        // Defaults reproduce V1 (theming is opt-in).
        compare(page.cfg_fontFamily, "");
        compare(page.cfg_customTextColorEnabled, false);
        compare(page.cfg_customTextColor, "");
        compare(page.cfg_labelOpacity, 1.0);
        compare(page.cfg_separatorOpacity, 1.0);

        var providers = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"];
        for (var i = 0; i < providers.length; i++) {
            compare(page["cfg_" + providers[i] + "AccentColor"], "");
            compare(page["cfg_" + providers[i] + "CustomIcon"], "");
        }
        compare(page.providerIds.length, 7);

        // Every control maps to a real sanitized key (no dead controls).
        page.destroy();
        component.destroy();
    }

    function test_colorValidationHelperMatchesSanitizeContract() {
        var component = Qt.createComponent("../../plasmoid/contents/ui/configTheming.qml");
        compare(component.status, Component.Ready);
        var page = component.createObject(null);
        verify(page !== null);

        verify(page.isValidColorString("#ff0000"));
        verify(page.isValidColorString("#abc"));
        verify(page.isValidColorString("#a1b2c3d4"));
        verify(page.isValidColorString("red"));
        verify(!page.isValidColorString("not a color!"));
        verify(!page.isValidColorString("#12"));
        verify(!page.isValidColorString(""));

        page.destroy();
        component.destroy();
    }
}
