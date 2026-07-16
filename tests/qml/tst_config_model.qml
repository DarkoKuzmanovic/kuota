import QtQuick
import QtTest

import "../../plasmoid/contents/ui/config-model.js" as ConfigModel

TestCase {
    name: "ConfigModel"

    function test_intervalFloorClamp() {
        compare(ConfigModel.sanitize({ refreshIntervalMinutes: 4 }).refreshIntervalMinutes, 5);
        compare(ConfigModel.sanitize({ refreshIntervalMinutes: 0 }).refreshIntervalMinutes, 5);
        compare(ConfigModel.sanitize({ refreshIntervalMinutes: -3 }).refreshIntervalMinutes, 5);
        compare(ConfigModel.sanitize({ refreshIntervalMinutes: 10 }).refreshIntervalMinutes, 10);
        compare(ConfigModel.sanitize({ refreshIntervalMinutes: 5 }).refreshIntervalMinutes, 5);
    }

    function test_thresholdClampAndOrder() {
        var highClamp = ConfigModel.sanitize({ cautionThreshold: 150, criticalThreshold: 200 });
        compare(highClamp.cautionThreshold, 75);
        compare(highClamp.criticalThreshold, 90);

        var lowClamp = ConfigModel.sanitize({ cautionThreshold: -5, criticalThreshold: -1 });
        compare(lowClamp.cautionThreshold, 75);
        compare(lowClamp.criticalThreshold, 90);

        var valid = ConfigModel.sanitize({ cautionThreshold: 60, criticalThreshold: 85 });
        compare(valid.cautionThreshold, 60);
        compare(valid.criticalThreshold, 85);

        var boundary = ConfigModel.sanitize({ cautionThreshold: 0, criticalThreshold: 100 });
        compare(boundary.cautionThreshold, 0);
        compare(boundary.criticalThreshold, 100);
    }

    function test_invertedThresholdsFallBackToDefaults() {
        var inverted = ConfigModel.sanitize({ cautionThreshold: 90, criticalThreshold: 75 });
        compare(inverted.cautionThreshold, 75);
        compare(inverted.criticalThreshold, 90);

        var equal = ConfigModel.sanitize({ cautionThreshold: 80, criticalThreshold: 80 });
        compare(equal.cautionThreshold, 75);
        compare(equal.criticalThreshold, 90);
    }

    function test_garbageAndMissingFallBackToDefaults() {
        var empty = ConfigModel.sanitize({});
        compare(empty.refreshIntervalMinutes, 5);
        compare(empty.cautionThreshold, 75);
        compare(empty.criticalThreshold, 90);
        compare(empty.displayMode, "icons+text");
        compare(empty.separator, " · ");
        compare(empty.fontScale, 1.0);
        compare(empty.showCountdown, true);
        compare(empty.claudeVisible, true);
        compare(empty.umansVisible, true);
        compare(empty.codexVisible, true);
        compare(empty.claudeWindow, "");
        compare(empty.codexWindow, "");
        compare(JSON.stringify(empty.providerOrder), JSON.stringify(["claude", "umans", "codex"]));

        var garbage = ConfigModel.sanitize({
            refreshIntervalMinutes: "soon",
            cautionThreshold: "high",
            criticalThreshold: null,
            displayMode: "sparkles",
            separator: 42,
            fontScale: "big",
            showCountdown: 1,
            providerOrder: "claude",
            claudeVisible: "true",
            umansVisible: null,
            codexVisible: undefined,
            claudeWindow: 12,
            codexWindow: false
        });
        compare(garbage.refreshIntervalMinutes, 5);
        compare(garbage.cautionThreshold, 75);
        compare(garbage.criticalThreshold, 90);
        compare(garbage.displayMode, "icons+text");
        compare(garbage.separator, " · ");
        compare(garbage.fontScale, 1.0);
        compare(garbage.showCountdown, true);
        compare(JSON.stringify(garbage.providerOrder), JSON.stringify(["claude", "umans", "codex"]));
        compare(garbage.claudeVisible, true);
        compare(garbage.umansVisible, true);
        compare(garbage.codexVisible, true);
        compare(garbage.claudeWindow, "");
        compare(garbage.codexWindow, "");

        var nullInput = ConfigModel.sanitize(null);
        compare(nullInput.refreshIntervalMinutes, 5);
        compare(JSON.stringify(nullInput.providerOrder), JSON.stringify(["claude", "umans", "codex"]));
    }

    function test_displayConfigAssemblyCustomOrderAndVisibility() {
        var sanitized = ConfigModel.sanitize({
            providerOrder: ["codex", "claude", "umans"],
            claudeVisible: true,
            umansVisible: false,
            codexVisible: true
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);

        compare(JSON.stringify(displayConfig.order), JSON.stringify(["codex", "claude"]));
        compare(displayConfig.visibility.claude, true);
        compare(displayConfig.visibility.umans, false);
        compare(displayConfig.visibility.codex, true);
        verify(isRecord(displayConfig.metric));
        verify(isRecord(displayConfig.window));
    }

    function test_displayConfigAssemblyAllVisible() {
        var sanitized = ConfigModel.sanitize({
            providerOrder: ["umans", "codex", "claude"],
            claudeVisible: true,
            umansVisible: true,
            codexVisible: true
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);
        compare(JSON.stringify(displayConfig.order), JSON.stringify(["umans", "codex", "claude"]));
        compare(displayConfig.visibility.claude, true);
        compare(displayConfig.visibility.umans, true);
        compare(displayConfig.visibility.codex, true);
    }

    function test_displayConfigAllHiddenYieldsEmptyOrder() {
        var sanitized = ConfigModel.sanitize({
            claudeVisible: false,
            umansVisible: false,
            codexVisible: false
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);
        compare(displayConfig.order.length, 0);
        compare(displayConfig.visibility.claude, false);
        compare(displayConfig.visibility.umans, false);
        compare(displayConfig.visibility.codex, false);
    }

    function test_displayConfigIncludesSelectedWindows() {
        var sanitized = ConfigModel.sanitize({
            claudeWindow: "weekly-all",
            codexWindow: "secondary"
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);
        compare(displayConfig.window.claude, "weekly-all");
        compare(displayConfig.window.codex, "secondary");
        // Umans has no window selector key.
        verify(!Object.prototype.hasOwnProperty.call(displayConfig.window, "umans"));
    }

    function test_resolveWindowHonorsPresentId() {
        var sanitized = ConfigModel.sanitize({ claudeWindow: "session", codexWindow: "primary" });
        compare(
            ConfigModel.resolveWindow("claude", sanitized, ["session", "weekly-all"]),
            "session"
        );
        compare(
            ConfigModel.resolveWindow("codex", sanitized, ["primary", "secondary"]),
            "primary"
        );
    }

    function test_resolveWindowAbsentIdFallsBackUndefined() {
        var sanitized = ConfigModel.sanitize({ claudeWindow: "weekly-oauth-apps" });
        compare(
            ConfigModel.resolveWindow("claude", sanitized, ["session", "weekly-all"]),
            undefined
        );
        // Empty selection → undefined (caller uses Q10 primary-window default).
        var empty = ConfigModel.sanitize({ claudeWindow: "" });
        compare(ConfigModel.resolveWindow("claude", empty, ["session"]), undefined);
    }

    function test_resolveWindowUnknownProviderOrUmansIsUndefined() {
        var sanitized = ConfigModel.sanitize({ claudeWindow: "session", codexWindow: "primary" });
        compare(ConfigModel.resolveWindow("umans", sanitized, ["requests"]), undefined);
        compare(ConfigModel.resolveWindow("unknown", sanitized, ["session"]), undefined);
        // Selected id outside static known catalog → undefined even if present in available.
        var bogus = ConfigModel.sanitize({ claudeWindow: "not-a-window" });
        compare(ConfigModel.resolveWindow("claude", bogus, ["not-a-window"]), undefined);
    }

    function test_providerOrderFiltersUnknownIds() {
        var sanitized = ConfigModel.sanitize({
            providerOrder: ["claude", "bogus", "umans", "claude", "codex"]
        });
        // sanitize keeps a clean unique order of known providers only.
        compare(JSON.stringify(sanitized.providerOrder), JSON.stringify(["claude", "umans", "codex"]));
    }

    function isRecord(input) {
        return typeof input === "object" && input !== null && !Array.isArray(input);
    }
}
