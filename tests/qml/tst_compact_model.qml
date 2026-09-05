import QtQuick
import QtTest

import "../../plasmoid/contents/ui/compact-model.js" as CompactModel
import "helpers/collector-fixtures.js" as Fixtures

TestCase {
    name: "CompactModel"

    function sampleSnapshot(providers) {
        return Fixtures.minimalDocument({ providers: providers });
    }

    function defaultConfig(overrides) {
        var config = CompactModel.createDefaultDisplayConfig();
        if (overrides) {
            for (var key in overrides) {
                if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                    config[key] = overrides[key];
                }
            }
        }
        return config;
    }

    function providerEntry(entries, id) {
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].providerId === id) {
                return entries[i];
            }
        }
        return null;
    }

    function test_usedPercentPrimaryPath() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 42, used: 42, limit: 100 })]
            })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        var claude = providerEntry(entries, "claude");
        verify(claude !== null);
        compare(claude.displayValue, "42%");
        compare(claude.thresholdLevel, "none");
        compare(claude.state, "ok");
    }

    function test_metricUsedOverrideForcesCountNotPercent() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 42, used: 99, limit: 100 })]
            })
        ]);
        var config = defaultConfig({ metric: { claude: "used" } });
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, config), "claude");
        verify(claude !== null);
        compare(claude.displayValue, "99");
        compare(claude.thresholdLevel, "none");
    }

    function test_usedCountFallbackWhenNoUsedPercent() {
        var snapshot = sampleSnapshot([
            {
                id: "grok",
                state: "ok",
                windows: [Fixtures.validWindow({ usedPercent: undefined, used: 1240, limit: undefined })]
            }
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        var grok = providerEntry(entries, "grok");
        compare(grok.displayValue, "1240");
        compare(grok.thresholdLevel, "none");
    }

    function test_stateOnlyFallbackWithoutWindows() {
        var snapshot = sampleSnapshot([
            Fixtures.validCodexProvider({ state: "auth-needed", status: "Login required", windows: undefined })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        var codex = providerEntry(entries, "codex");
        compare(codex.state, "auth-needed");
        compare(codex.displayValue, "Login required");
        compare(codex.thresholdLevel, "none");
    }

    function test_opencodePrimaryWindowIsTheFirstRollingWindow() {
        var snapshot = sampleSnapshot([Fixtures.validOpencodeProvider()]);
        var opencode = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "opencode");
        verify(opencode !== null);
        compare(opencode.displayValue, "42%");
        compare(opencode.thresholdLevel, "none");
        compare(opencode.state, "ok");
    }

    function test_commandCodePrimaryWindowIsFiveHour() {
        var snapshot = sampleSnapshot([Fixtures.validCommandCodeProvider()]);
        var commandcode = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "commandcode");
        verify(commandcode !== null);
        compare(commandcode.displayValue, "35%");
        compare(commandcode.thresholdLevel, "none");
    }

    function test_exceededCommandCodeWindowMapsToCritical() {
        var snapshot = sampleSnapshot([
            Fixtures.validCommandCodeProvider({
                windows: [Fixtures.validWindow({ id: "fiveHour", label: "5h", usedPercent: 100, used: 150, limit: 100 })]
            })
        ]);
        var commandcode = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "commandcode");
        compare(commandcode.displayValue, "100%");
        compare(commandcode.thresholdLevel, "critical");
    }

    function test_unavailableOpencodeShowsStatusNotPercent() {
        var snapshot = sampleSnapshot([
            Fixtures.validOpencodeProvider({ state: "auth-needed", status: "Login required", windows: undefined })
        ]);
        var opencode = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "opencode");
        compare(opencode.state, "auth-needed");
        compare(opencode.displayValue, "Login required");
    }

    function test_thresholdBoundary74_9IsNone() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 74.9 })]
            })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.thresholdLevel, "none");
    }

    function test_thresholdDecimalFloorsDisplayButNotThreshold() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 74.9 })]
            })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.displayValue, "74%");
        compare(claude.thresholdLevel, "none");
    }

    function test_thresholdBoundary75IsCaution() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 75 })]
            })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.thresholdLevel, "caution");
    }

    function test_thresholdBoundary89_9IsCaution() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 89.9 })]
            })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.thresholdLevel, "caution");
    }

    function test_thresholdBoundary90IsCritical() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 90 })]
            })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.thresholdLevel, "critical");
    }

    function test_thresholdFromUsedAndLimitAt75() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: undefined, used: 75, limit: 100 })]
            })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.displayValue, "75%");
        compare(claude.thresholdLevel, "caution");
    }

    function test_thresholdFromUsedAndLimitAt90() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: undefined, used: 90, limit: 100 })]
            })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.thresholdLevel, "critical");
    }

    function test_uncappedCountHasNeutralThreshold() {
        var snapshot = sampleSnapshot([
            {
                id: "grok",
                state: "ok",
                windows: [Fixtures.validWindow({ usedPercent: undefined, used: 500, limit: undefined })]
            }
        ]);
        var grok = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "grok");
        compare(grok.thresholdLevel, "none");
    }

    function test_eachProviderStateProducesEntry() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ state: "ok" }),
            {
                id: "grok",
                state: "stale",
                lastSuccessAt: "2026-07-10T10:00:01.000Z",
                windows: [Fixtures.validWindow({ usedPercent: 10 })]
            },
            Fixtures.validCodexProvider({ state: "error", status: "Provider unavailable" })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        compare(entries.length, 3);
        compare(providerEntry(entries, "claude").state, "ok");
        compare(providerEntry(entries, "grok").state, "stale");
        compare(providerEntry(entries, "grok").displayValue, "10%");
        compare(providerEntry(entries, "codex").state, "error");
        compare(providerEntry(entries, "codex").displayValue, "Provider unavailable");
    }

    function test_authNeededStateUsesStatusWhenPresent() {
        var snapshot = sampleSnapshot([
            Fixtures.validCodexProvider({ state: "auth-needed", status: "Login required" })
        ]);
        var codex = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "codex");
        compare(codex.state, "auth-needed");
        compare(codex.displayValue, "Login required");
    }

    function test_defaultOrderClaudeCodexGrokKimi() {
        var snapshot = sampleSnapshot([
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] }),
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 2 })] }),
            Fixtures.validGrokProvider({ windows: [Fixtures.validWindow({ used: 3, usedPercent: undefined, limit: undefined })] })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        compare(entries.length, 3);
        compare(entries[0].providerId, "claude");
        compare(entries[1].providerId, "codex");
        compare(entries[2].providerId, "grok");
    }

    function test_customOrderRespected() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validGrokProvider({ windows: [Fixtures.validWindow({ used: 1, limit: undefined, usedPercent: undefined })] }),
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig({
            order: ["codex", "grok", "claude"]
        }));
        compare(entries[0].providerId, "codex");
        compare(entries[1].providerId, "grok");
        compare(entries[2].providerId, "claude");
    }

    function test_visibilityOmitsHiddenProviders() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validGrokProvider({ windows: [Fixtures.validWindow({ used: 1, limit: undefined, usedPercent: undefined })] }),
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] })
        ]);
        var config = defaultConfig({
            visibility: { claude: true, grok: false, codex: true }
        });
        var entries = CompactModel.buildCompactEntries(snapshot, config);
        compare(entries.length, 2);
        verify(providerEntry(entries, "grok") === null);
    }

    function test_emptyWindowsOnOkUsesStateOnly() {
        var snapshot = sampleSnapshot([
            { id: "claude", state: "ok", windows: [] }
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.displayValue, "");
        compare(claude.thresholdLevel, "none");
    }

    function test_outputContainsNoSecretPatterns() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                status: "Usage is current",
                windows: [Fixtures.validWindow({ usedPercent: 50 })]
            })
        ]);
        var serialized = JSON.stringify(CompactModel.buildCompactEntries(snapshot, defaultConfig()));
        var forbidden = ["oauth", "Bearer", "sk-", "accountId", "refresh", "access", "api_key", "authorization"];
        for (var i = 0; i < forbidden.length; i++) {
            verify(serialized.toLowerCase().indexOf(forbidden[i].toLowerCase()) === -1,
                   "output must not contain '" + forbidden[i] + "'");
        }
    }

    function test_missingProviderInSnapshotIsSkipped() {
        var snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        compare(entries.length, 1);
        compare(entries[0].providerId, "claude");
    }

    function test_labelsAreStableProviderNames() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] }),
            Fixtures.validGrokProvider({ windows: [Fixtures.validWindow({ usedPercent: 1 })] }),
            Fixtures.validKimiProvider({ windows: [Fixtures.validWindow({ usedPercent: 1 })] }),
            Fixtures.validCursorProvider({ windows: [Fixtures.validWindow({ id: "plan", label: "Plan", usedPercent: 1 })] }),
            Fixtures.validOpencodeProvider({ windows: [Fixtures.validWindow({ id: "rolling", label: "5h", usedPercent: 1 })] }),
            Fixtures.validCommandCodeProvider({ windows: [Fixtures.validWindow({ id: "fiveHour", label: "5h", usedPercent: 1 })] })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        compare(providerEntry(entries, "claude").label, "Claude");
        compare(providerEntry(entries, "codex").label, "Codex");
        compare(providerEntry(entries, "grok").label, "Grok");
        compare(providerEntry(entries, "kimi").label, "Kimi");
        compare(providerEntry(entries, "cursor").label, "Cursor");
        compare(providerEntry(entries, "opencode").label, "OpenCode");
        compare(providerEntry(entries, "commandcode").label, "CommandCode");
    }

    function test_selectedWindowHonoredWhenPresent() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [
                    Fixtures.validWindow({ id: "session", usedPercent: 10 }),
                    Fixtures.validWindow({ id: "weekly-all", usedPercent: 88 })
                ]
            })
        ]);
        var config = defaultConfig({ window: { claude: "weekly-all" } });
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, config), "claude");
        verify(claude !== null);
        compare(claude.displayValue, "88%");
        compare(claude.thresholdLevel, "caution");
    }

    // Selection is provider-generic (spec 2026-09-05): regression coverage for
    // the providers that gained selectors after M9.
    function test_selectedWindowHonoredForGrokAndCommandCode() {
        var snapshot = sampleSnapshot([
            Fixtures.validGrokProvider({
                windows: [
                    Fixtures.validWindow({ id: "week", label: "7d", usedPercent: 20 }),
                    Fixtures.validWindow({ id: "month", label: "30d", usedPercent: 91 })
                ]
            }),
            Fixtures.validCommandCodeProvider({
                windows: [
                    Fixtures.validWindow({ id: "fiveHour", label: "5h", usedPercent: 80 }),
                    Fixtures.validWindow({ id: "weekly", label: "Weekly", usedPercent: 12 })
                ]
            })
        ]);
        var config = defaultConfig({ window: { grok: "month", commandcode: "weekly" } });
        var entries = CompactModel.buildCompactEntries(snapshot, config);

        var grok = providerEntry(entries, "grok");
        verify(grok !== null);
        compare(grok.displayValue, "91%");
        compare(grok.thresholdLevel, "critical");

        var commandcode = providerEntry(entries, "commandcode");
        verify(commandcode !== null);
        compare(commandcode.displayValue, "12%");
        compare(commandcode.thresholdLevel, "none");
    }

    function test_selectedWindowFallsBackToPrimaryWhenAbsentForLaterProviders() {
        // 5-hour-only CommandCode accounts never carry the weekly window.
        var snapshot = sampleSnapshot([
            Fixtures.validCommandCodeProvider({
                windows: [Fixtures.validWindow({ id: "fiveHour", label: "5h", usedPercent: 66 })]
            })
        ]);
        var config = defaultConfig({ window: { commandcode: "weekly" } });
        var commandcode = providerEntry(CompactModel.buildCompactEntries(snapshot, config), "commandcode");
        verify(commandcode !== null);
        compare(commandcode.displayValue, "66%");
    }

    function test_selectedWindowFallsBackToPrimaryWhenAbsent() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [
                    Fixtures.validWindow({ id: "session", usedPercent: 10 }),
                    Fixtures.validWindow({ id: "weekly-all", usedPercent: 88 })
                ]
            })
        ]);
        // "weekly-oauth-apps" is not among this provider's live windows.
        var config = defaultConfig({ window: { claude: "weekly-oauth-apps" } });
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, config), "claude");
        verify(claude !== null);
        compare(claude.displayValue, "10%");
        compare(claude.thresholdLevel, "none");
    }

    function test_injectedThresholdCustomBoundaries() {
        var config = defaultConfig({ cautionThreshold: 50, criticalThreshold: 60 });

        var below = providerEntry(CompactModel.buildCompactEntries(
            sampleSnapshot([Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 49 })] })]),
            config
        ), "claude");
        compare(below.thresholdLevel, "none");

        var atCaution = providerEntry(CompactModel.buildCompactEntries(
            sampleSnapshot([Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 50 })] })]),
            config
        ), "claude");
        compare(atCaution.thresholdLevel, "caution");

        var justBelowCritical = providerEntry(CompactModel.buildCompactEntries(
            sampleSnapshot([Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 59 })] })]),
            config
        ), "claude");
        compare(justBelowCritical.thresholdLevel, "caution");

        var atCritical = providerEntry(CompactModel.buildCompactEntries(
            sampleSnapshot([Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 60 })] })]),
            config
        ), "claude");
        compare(atCritical.thresholdLevel, "critical");
    }

    function test_defaultThresholdsApplyWhenDisplayConfigOmitsThem() {
        // defaultConfig() with no threshold overrides must still use 75/90 (unchanged default rule).
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 80 })] })
        ]);
        var claude = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "claude");
        compare(claude.thresholdLevel, "caution");
    }

    // ---- M-T2 theming consumption + precedence ----

    function claudeAt(usedPercent, appearance) {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: usedPercent, used: usedPercent, limit: 100 })] })
        ]);
        return providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig(), appearance), "claude");
    }

    function test_noAppearanceArgReproducesV1() {
        var claude = claudeAt(42, undefined);
        compare(claude.valueColor, "");
        compare(claude.textColor, "");
        compare(claude.iconName, "");
        compare(claude.labelOpacity, 1.0);
        compare(claude.separatorOpacity, 1.0);
    }

    function test_accentTintsValueTextWhenNoThreshold() {
        var claude = claudeAt(42, { claudeAccentColor: "#ff0000" });
        compare(claude.thresholdLevel, "none");
        compare(claude.valueColor, "#ff0000");
        compare(claude.textColor, "");
    }

    function test_thresholdSuppressesAccentAndCustom() {
        var claude = claudeAt(95, {
            claudeAccentColor: "#ff0000",
            customTextColorEnabled: true,
            customTextColor: "#00ff00"
        });
        compare(claude.thresholdLevel, "critical");
        // Threshold color (resolved by the rep from thresholdLevel) always wins.
        compare(claude.valueColor, "");
        compare(claude.textColor, "");
    }

    function test_customTextColorAppliesWhenNoThresholdNoAccent() {
        var claude = claudeAt(42, { customTextColorEnabled: true, customTextColor: "#00ff00" });
        compare(claude.valueColor, "#00ff00");
        compare(claude.textColor, "#00ff00");
    }

    function test_customTextColorDisabledIsIgnored() {
        var claude = claudeAt(42, { customTextColorEnabled: false, customTextColor: "#00ff00" });
        compare(claude.valueColor, "");
        compare(claude.textColor, "");
    }

    function test_accentBeatsCustomOnValueTextOnly() {
        var claude = claudeAt(42, {
            claudeAccentColor: "#ff0000",
            customTextColorEnabled: true,
            customTextColor: "#00ff00"
        });
        compare(claude.valueColor, "#ff0000");
        // Labels/icons follow the custom text color, never the accent.
        compare(claude.textColor, "#00ff00");
    }

    function test_opacityAndCustomIconFields() {
        var claude = claudeAt(42, {
            labelOpacity: 0.5,
            separatorOpacity: 0.25,
            claudeCustomIcon: "network-server"
        });
        compare(claude.labelOpacity, 0.5);
        compare(claude.separatorOpacity, 0.25);
        compare(claude.iconName, "network-server");

        var emptyIcon = claudeAt(42, { claudeCustomIcon: "" });
        compare(emptyIcon.iconName, "");
    }

    function test_accentIsPerProvider() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 42, used: 42, limit: 100 })] }),
            Fixtures.validGrokProvider({ windows: [Fixtures.validWindow({ usedPercent: 42, used: 42, limit: 100 })] })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig(), { claudeAccentColor: "#ff0000" });
        compare(providerEntry(entries, "claude").valueColor, "#ff0000");
        compare(providerEntry(entries, "grok").valueColor, "");
    }
}