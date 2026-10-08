import QtQuick
import QtTest
import "../../plasmoid/contents/ui/provider-catalog.js" as Catalog
import "../../plasmoid/contents/ui/config-model.js" as Config
import "../../plasmoid/contents/ui/compact-model.js" as Compact
import "../../plasmoid/contents/ui/collector-command.js" as Command
import "../../plasmoid/contents/ui/collector-validator.js" as Validator

TestCase {
    id: testCase
    name: "ProviderConsistency"
    when: windowShown
    visible: true

    function read(path) {
        var request = new XMLHttpRequest();
        request.open("GET", Qt.resolvedUrl(path), false);
        request.send(null);
        verify(request.status === 0 || request.status === 200, path);
        verify(request.responseText.length > 0, path);
        return request.responseText;
    }
    function expectedDefaults() {
        var fixture = JSON.parse(read("../fixtures/settings-defaults.json"));
        var defaults = {};
        Object.keys(fixture).forEach(function(key) { defaults[key] = fixture[key].default; });
        return defaults;
    }
    function assertDefaults(actual) {
        var expected = expectedDefaults();
        compare(Object.keys(actual).sort(), Object.keys(expected).sort());
        Object.keys(expected).forEach(function(key) { compare(actual[key], expected[key], key); });
    }
    function test_completeKConfigABI() {
        var expected = JSON.parse(read("../fixtures/settings-defaults.json"));
        var xml = read("../../plasmoid/contents/config/main.xml");
        var entries = /<entry name="([^"]+)" type="([^"]+)">[\s\S]*?<default>([\s\S]*?)<\/default>[\s\S]*?<\/entry>/g;
        var actual = {}, entry;
        while ((entry = entries.exec(xml)) !== null) {
            verify(!Object.prototype.hasOwnProperty.call(actual, entry[1]), "unique key");
            var value = entry[3];
            switch (entry[2]) {
            case "Bool": verify(value === "true" || value === "false"); value = value === "true"; break;
            case "Int": value = Number(value); verify(isFinite(value) && Math.floor(value) === value); break;
            case "Double": value = Number(value); verify(isFinite(value)); break;
            case "StringList": value = value.split(","); break;
            case "String": break;
            default: fail("unknown KConfig type");
            }
            actual[entry[1]] = { type: entry[2], default: value };
        }
        compare(Object.keys(actual).sort(), Object.keys(expected).sort());
        Object.keys(expected).forEach(function(key) { compare(actual[key], expected[key], key); });
    }
    function test_defaultsOwnerIncludesEveryPersistedKey() { assertDefaults(Config.DEFAULTS); }
    function test_completeFactoryAndSanitizerFallbackParity() {
        assertDefaults(Config.createDefaultSettings());
        [undefined, null, [], true, 12, "synthetic", {}].forEach(function(raw) { assertDefaults(Config.sanitize(raw)); });
        var defaults = expectedDefaults();
        Object.keys(defaults).forEach(function(key) {
            [null, undefined, {}, []].forEach(function(bad) {
                var raw = {}; raw[key] = bad;
                assertDefaults(Config.sanitize(raw));
            });
        });
        var additive = Config.sanitize({ syntheticUnknown: true, umansVisible: true });
        assertDefaults(additive);
    }
    function test_allSettingsRetainValidNonDefaults() {
        var schema = JSON.parse(read("../fixtures/settings-defaults.json"));
        var raw = {};
        Object.keys(schema).forEach(function(key) {
            switch (schema[key].type) {
            case "StringList": raw[key] = Catalog.PROVIDER_IDS.slice().reverse(); break;
            case "Bool": raw[key] = !schema[key].default; break;
            case "Int": raw[key] = 20; break;
            case "Double": raw[key] = 0.75; break;
            case "String": raw[key] = "synthetic"; break;
            }
        });
        raw.cautionThreshold = 30; raw.criticalThreshold = 60;
        raw.claudeWindow = "weekly-oauth-apps"; raw.codexWindow = "secondary";
        raw.displayMode = "text"; raw.customTextColor = "#123456";
        Catalog.PROVIDER_IDS.forEach(function(id) { raw[id + "AccentColor"] = "#abcdef"; });
        var actual = Config.sanitize(raw);
        compare(Object.keys(actual).sort(), Object.keys(raw).sort());
        Object.keys(raw).forEach(function(key) { compare(actual[key], raw[key], key); });
    }
    function test_sharedContractCorpus_data() {
        return JSON.parse(read("../fixtures/contract-parity.json"));
    }
    function test_sharedContractCorpus(row) {
        var result = Validator.validateCollectorResponse(JSON.stringify(row.document));
        compare(result.ok, row.valid, row.tag);
        if (row.valid) {
            compare(result.value.schemaVersion, 2);
            var ids = row.document.providers.filter(function(p) { return p.id !== "umans"; }).map(function(p) { return p.id; });
            compare(result.value.providers.map(function(p) { return p.id; }), ids);
        }
    }
    function test_defensiveSettingsAndDisplayArrays() {
        var a = Config.createDefaultSettings(), b = Config.createDefaultSettings();
        a.providerOrder.reverse(); a.providerOrder.push("synthetic-unknown");
        assertDefaults(b); assertDefaults(Config.sanitize(null));
        var raw = { providerOrder: ["codex", "claude"] };
        var sanitized = Config.sanitize(raw);
        raw.providerOrder.push("synthetic-unknown");
        compare(sanitized.providerOrder[0], "codex");
        compare(sanitized.providerOrder.length, 7);
        var display = Config.assembleDisplayConfig(sanitized);
        display.order.pop();
        compare(sanitized.providerOrder.length, 7);
        var compact = Compact.createDefaultDisplayConfig();
        compact.order.pop(); compact.visibility.claude = false;
        compare(Compact.createDefaultDisplayConfig().order, Catalog.PROVIDER_IDS);
        compare(Compact.createDefaultDisplayConfig().visibility.claude, true);
        compare(Config.DEFAULTS.providerOrder, Catalog.PROVIDER_IDS);
    }
    function test_sameRuntimeMetadataConsumers() {
        var ids = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"];
        compare(Catalog.PROVIDER_IDS, ids);
        compare(Config.KNOWN_PROVIDERS, ids);
        compare(Config.DEFAULT_PROVIDER_ORDER, ids);
        compare(Command.CANONICAL_PROVIDER_IDS, ids);
        compare(Validator.PROVIDER_IDS, ids);
        compare(Compact.DEFAULT_ORDER, ids);
        compare(Compact.PROVIDER_LABELS, Catalog.PROVIDER_LABELS);
        compare(Config.enabledProviders(Config.sanitize(null)), ids);
        compare(Object.keys(Compact.createDefaultDisplayConfig().visibility).sort(), ids.slice().sort());
        var windows = { claude: ["session", "weekly-all", "weekly-oauth-apps"], codex: ["primary", "secondary"] };
        compare(Catalog.SELECTABLE_WINDOWS, windows);
        compare(Config.KNOWN_WINDOWS, windows);
    }
    function test_translatedNamesAndStandaloneThemingOrder() {
        // Keep qsTr literals in their original QML contexts; compare English
        // source labels here rather than changing translation lookup semantics.
        ["configTheming.qml", "FullRepresentation.qml"].forEach(function(file) {
            var component = Qt.createComponent("../../plasmoid/contents/ui/" + file);
            compare(component.status, Component.Ready, component.errorString());
            var item = component.createObject(testCase);
            try {
                for (var i = 0; i < Catalog.PROVIDER_IDS.length; i++) {
                    var id = Catalog.PROVIDER_IDS[i];
                    compare(file === "configTheming.qml" ? item.providerLabel(id) : item.providerDisplayName(id), Catalog.PROVIDER_LABELS[id]);
                }
                if (file === "configTheming.qml") compare(item.providerIds, Catalog.PROVIDER_IDS);
                else compare(item.providerOrder, Catalog.PROVIDER_IDS);
            } finally { item.destroy(); }
        });
    }
    function controls(item, predicate) {
        var result = predicate(item) ? [item] : [];
        var children = item.children || [];
        for (var i = 0; i < children.length; i++) result = result.concat(controls(children[i], predicate));
        return result;
    }
    function test_windowControlsAndStableDelegates() {
        var component = Qt.createComponent("../../plasmoid/contents/ui/configProviders.qml");
        compare(component.status, Component.Ready, component.errorString());
        var page = component.createObject(testCase);
        try {
            var combos = controls(page, function(item) { return item.valueRole === "value"; });
            compare(combos.length, 2); // no unpublished M15 selectors
            var ids = ["claude", "codex"];
            var expectedTexts = [["Default", "Session", "Weekly (all)", "Weekly (OAuth apps)"], ["Default", "Primary", "Secondary"]];
            for (var i = 0; i < ids.length; i++) {
                var expected = [""].concat(Config.KNOWN_WINDOWS[ids[i]]);
                compare(combos[i].count, expected.length);
                for (var j = 0; j < expected.length; j++) {
                    compare(combos[i].model[j].value, expected[j]);
                    compare(combos[i].model[j].text, expectedTexts[i][j]);
                    combos[i].currentIndex = j;
                    compare(page["cfg_" + ids[i] + "Window"], expected[j]);
                    var raw = {}; raw[ids[i] + "Window"] = expected[j];
                    compare(Config.sanitize(raw)[ids[i] + "Window"], expected[j]);
                }
            }
            var rows = controls(page, function(item) { return typeof item.providerId === "string" && typeof item.index === "number"; });
            compare(rows.length, Catalog.PROVIDER_IDS.length);
            var beforeIds = rows.map(function(row) { return row.providerId; });
            compare(beforeIds, Catalog.PROVIDER_IDS);
            page.moveProvider(0, 1); wait(0);
            var after = controls(page, function(item) { return typeof item.providerId === "string" && typeof item.index === "number"; });
            compare(after.length, rows.length);
            for (var r = 0; r < rows.length; r++) compare(after[r], rows[r]);
            compare(after[0].providerId, "codex");
            for (var p = 0; p < Catalog.PROVIDER_IDS.length; p++) compare(page.providerLabel(Catalog.PROVIDER_IDS[p]), Catalog.PROVIDER_LABELS[Catalog.PROVIDER_IDS[p]]);
            compare(page.providerLabel("synthetic-unknown"), "synthetic-unknown");
        } finally { page.destroy(); }
    }
}
