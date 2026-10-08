import QtQuick
import QtTest

TestCase {
    name: "MainWiring"
    when: windowShown

    Component {
        id: mainComponent
        Loader {
            source: "../../plasmoid/contents/ui/main.qml"
        }
    }


    // D-R7: this seam changes only the bundled collector fixture path, never
    // selection. Every real root refresh still consumes sanitized settings.
    function selectedSettings(ids) {
        var raw = { providerOrder: ids.slice().reverse() };
        var all = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"];
        for (var i = 0; i < all.length; i++) raw[all[i] + "Visible"] = ids.indexOf(all[i]) !== -1;
        return raw;
    }
    function createSelectionRoot(ids) {
        var component = Qt.createComponent("../../plasmoid/contents/ui/main.qml");
        compare(component.status, Component.Ready, component.errorString());
        // Preserve the JS array through createObject's QVariant boundary, as
        // the existing configOverride assignment tests do after construction.
        var settings = selectedSettings(ids);
        var root = component.createObject(null, {
            configOverride: Qt.binding(function() { return settings; }),
            collectorPathOverride: Qt.resolvedUrl("fixtures/collector/success.js").toString().replace("file://", "")
        });
        verify(root !== null);
        return root;
    }
    function waitForSelection(root, expected) {
        tryVerify(function() { return !root.inFlight && root.snapshot !== null; }, 5000);
        compare(root.snapshot.providers.map(function(p) { return p.id; }), expected);
    }
    function test_startupManualAndTimerUseCanonicalSelectedArgv() {
        var root = createSelectionRoot(["claude", "commandcode"]);
        try {
            waitForSelection(root, ["claude", "commandcode"]);
            compare(root.compactDisplayConfig.order, ["commandcode", "claude"]);
            var bridge = findChild(root, "collectorBridge");
            verify(bridge !== null);
            compare(bridge._requestState.nextSourceId, 2);
            root.refresh();
            verify(bridge._requestState.activeToken.indexOf(" --enabled-providers=claude,commandcode # ") !== -1);
            waitForSelection(root, ["claude", "commandcode"]);
            var timer = findChild(root, "refreshTimer");
            verify(timer !== null);
            timer.triggered();
            verify(bridge._requestState.activeToken.indexOf(" --enabled-providers=claude,commandcode # ") !== -1);
            waitForSelection(root, ["claude", "commandcode"]);
            compare(bridge._requestState.nextSourceId, 4);
        } finally { root.destroy(); }
    }
    function test_emptyStartupManualTimerViewsAndReenable() {
        var root = createSelectionRoot([]);
        try {
            var bridge = findChild(root, "collectorBridge");
            verify(bridge !== null);
            wait(100);
            compare(bridge._requestState.nextSourceId, 1);
            root.refresh();
            findChild(root, "refreshTimer").triggered();
            compare(bridge._requestState.nextSourceId, 1);
            compare(root.inFlight, false);
            compare(root.snapshot, null);
            compare(root.snapshotAgeMs(), undefined);
            var compact = root.compactRepresentation.createObject(root);
            var full = root.fullRepresentation.createObject(root);
            compare(compact.hasEntries, false);
            compare(full.hasProviders, false);
            root.configOverride = selectedSettings(["codex"]);
            waitForSelection(root, ["codex"]);
            compare(bridge._requestState.nextSourceId, 2);
            root.configOverride = selectedSettings([]);
            compare(root.snapshot, null);
            compare(root.snapshotAgeMs(), undefined);
            compare(compact.hasEntries, false);
            compare(full.hasProviders, false);
            compare(bridge._requestState.nextSourceId, 2);
        } finally { root.destroy(); }
    }
    function test_membershipRefreshesButOrderAndAppearanceDoNot() {
        var root = createSelectionRoot(["claude", "grok"]);
        try {
            waitForSelection(root, ["claude", "grok"]);
            var bridge = findChild(root, "collectorBridge");
            var prior = root.snapshot;
            var raw = selectedSettings(["claude", "grok"]);
            raw.providerOrder = ["claude", "grok"];
            raw.fontScale = 2;
            raw.separator = "synthetic separator";
            raw.claudeWindow = "weekly-all";
            root.configOverride = raw;
            wait(100);
            compare(bridge._requestState.nextSourceId, 2);
            compare(root.snapshot, prior);
            compare(root.compactDisplayConfig.order, ["claude", "grok"]);
            root.configOverride = selectedSettings(["kimi"]);
            compare(root.snapshot, null);
            waitForSelection(root, ["kimi"]);
            compare(bridge._requestState.nextSourceId, 3);
        } finally { root.destroy(); }
    }

    function test_activeRootChangesKeepOwnershipAndCollectOnlyLatestSettings() {
        var root = createSelectionRoot([]);
        try {
            var bridge = findChild(root, "collectorBridge");
            root.collectorPathOverride = Qt.resolvedUrl("fixtures/collector/slow.js").toString().replace("file://", "");
            root.configOverride = selectedSettings(["claude"]);
            verify(root.inFlight);
            var old = bridge._requestState.activeToken;
            root.configOverride = selectedSettings([]);
            compare(root.snapshot, null);
            compare(bridge._requestState.activeToken, old);
            root.collectorPathOverride = Qt.resolvedUrl("fixtures/collector/success.js").toString().replace("file://", "");
            root.configOverride = selectedSettings(["cursor"]);
            root.configOverride = selectedSettings(["opencode", "commandcode"]);
            compare(bridge._requestState.activeToken, old);
            compare(bridge._requestState.nextSourceId, 2);
            waitForSelection(root, ["opencode", "commandcode"]);
            compare(bridge._requestState.nextSourceId, 3);
        } finally { root.destroy(); }
    }

    function test_exposesOnlyTheSafeRootRefreshLifecycleSurface() {
        var loader = mainComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var root = loader.item;

        compare(typeof root.refresh, "function");
        compare(typeof root.inFlight, "boolean");
        compare(typeof root.lifecycleStatus, "string");
        compare(typeof root.snapshotAgeMs, "function");
        // No snapshot has been accepted yet at first load.
        compare(root.snapshot, null);

        loader.destroy();
    }

    function test_configFlowsIntoSanitizedSettingsAndTimerFloor() {
        var loader = mainComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var root = loader.item;

        root.configOverride = { refreshIntervalMinutes: 1, displayMode: "text" };

        compare(root.sanitizedSettings.refreshIntervalMinutes, 5);
        compare(root.refreshTimerInterval, 5 * 60 * 1000);
        compare(root.compactDisplayMode, "text");

        loader.destroy();
    }

    function test_allProvidersHiddenYieldsEmptyDisplayConfigOrder() {
        var loader = mainComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var root = loader.item;

        root.configOverride = { claudeVisible: false, codexVisible: false, grokVisible: false, kimiVisible: false, cursorVisible: false, opencodeVisible: false, commandcodeVisible: false };

        compare(root.compactDisplayConfig.order.length, 0);

        loader.destroy();
    }

    function test_customThresholdsFlowToCompactAndFullConfig() {
        var loader = mainComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var root = loader.item;

        root.configOverride = { cautionThreshold: 50, criticalThreshold: 60 };

        compare(root.compactDisplayConfig.cautionThreshold, 50);
        compare(root.compactDisplayConfig.criticalThreshold, 60);
        compare(root.fullThresholds.caution, 50);
        compare(root.fullThresholds.critical, 60);

        loader.destroy();
    }

    // compactRepresentation/fullRepresentation are Component-typed properties
    // (Plasma's PlasmoidItem contract): instantiate them to verify live
    // sanitizedSettings pass-through rather than the representation's own
    // internal QML-declared defaults (M9.2, D8 render-consumer wiring).
    function test_presentationSettingsFlowIntoRepresentations() {
        var loader = mainComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var root = loader.item;

        root.configOverride = { separator: " @@ ", fontScale: 2.5, showCountdown: false,
                                 iconLabelSpacing: 11, labelValueSpacing: 9 };

        var compactItem = root.compactRepresentation.createObject(root, {});
        compare(compactItem.separator, " @@ ");
        compare(compactItem.fontScale, 2.5);
        compare(compactItem.iconLabelSpacing, 11);
        compare(compactItem.labelValueSpacing, 9);

        var fullItem = root.fullRepresentation.createObject(root, {});
        compare(fullItem.showCountdown, false);

        loader.destroy();
    }

    function test_defaultConfigWithNoOverrideUsesSchemaDefaults() {
        var loader = mainComponent.createObject(null);
        tryCompare(loader, "status", Loader.Ready);
        var root = loader.item;

        // No configOverride set (root.plasmoid is null in this harness, so
        // rawConfig falls back to null → ConfigModel.sanitize(null) → schema defaults).
        compare(root.sanitizedSettings.refreshIntervalMinutes, 5);
        compare(root.refreshTimerInterval, 5 * 60 * 1000);
        compare(root.compactDisplayMode, "icons+text");
        compare(JSON.stringify(root.compactDisplayConfig.order), JSON.stringify(["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]));

        loader.destroy();
    }
}
