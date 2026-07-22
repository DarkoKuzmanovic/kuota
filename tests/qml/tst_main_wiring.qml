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

        root.configOverride = { claudeVisible: false, umansVisible: false, codexVisible: false, grokVisible: false, kimiVisible: false };

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

        root.configOverride = { separator: " @@ ", fontScale: 2.5, showCountdown: false };

        var compactItem = root.compactRepresentation.createObject(root, {});
        compare(compactItem.separator, " @@ ");
        compare(compactItem.fontScale, 2.5);

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
        compare(JSON.stringify(root.compactDisplayConfig.order), JSON.stringify(["claude", "umans", "codex", "grok", "kimi"]));

        loader.destroy();
    }
}
