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
                id: "umans",
                state: "ok",
                windows: [Fixtures.validWindow({ usedPercent: undefined, used: 1240, limit: undefined })]
            }
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        var umans = providerEntry(entries, "umans");
        compare(umans.displayValue, "1240");
        compare(umans.thresholdLevel, "none");
    }

    function test_stateOnlyFallbackWithoutWindows() {
        var snapshot = sampleSnapshot([
            Fixtures.validUmansProvider({ windows: undefined })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        var umans = providerEntry(entries, "umans");
        compare(umans.state, "auth-needed");
        compare(umans.displayValue, "Login required");
        compare(umans.thresholdLevel, "none");
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
                id: "umans",
                state: "ok",
                windows: [Fixtures.validWindow({ usedPercent: undefined, used: 500, limit: undefined })]
            }
        ]);
        var umans = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "umans");
        compare(umans.thresholdLevel, "none");
    }

    function test_eachProviderStateProducesEntry() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ state: "ok" }),
            {
                id: "umans",
                state: "stale",
                lastSuccessAt: "2026-07-10T10:00:01.000Z",
                windows: [Fixtures.validWindow({ usedPercent: 10 })]
            },
            Fixtures.validCodexProvider({ state: "error", status: "Provider unavailable" })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        compare(entries.length, 3);
        compare(providerEntry(entries, "claude").state, "ok");
        compare(providerEntry(entries, "umans").state, "stale");
        compare(providerEntry(entries, "umans").displayValue, "10%");
        compare(providerEntry(entries, "codex").state, "error");
        compare(providerEntry(entries, "codex").displayValue, "Provider unavailable");
    }

    function test_authNeededStateUsesStatusWhenPresent() {
        var snapshot = sampleSnapshot([Fixtures.validUmansProvider({ state: "auth-needed" })]);
        var umans = providerEntry(CompactModel.buildCompactEntries(snapshot, defaultConfig()), "umans");
        compare(umans.state, "auth-needed");
        compare(umans.displayValue, "Login required");
    }

    function test_defaultOrderClaudeUmansCodex() {
        var snapshot = sampleSnapshot([
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] }),
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 2 })] }),
            {
                id: "umans",
                state: "ok",
                windows: [Fixtures.validWindow({ used: 3, usedPercent: undefined, limit: undefined })]
            }
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        compare(entries.length, 3);
        compare(entries[0].providerId, "claude");
        compare(entries[1].providerId, "umans");
        compare(entries[2].providerId, "codex");
    }

    function test_customOrderRespected() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            { id: "umans", state: "ok", windows: [Fixtures.validWindow({ used: 1, limit: undefined, usedPercent: undefined })] },
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig({
            order: ["codex", "umans", "claude"]
        }));
        compare(entries[0].providerId, "codex");
        compare(entries[1].providerId, "umans");
        compare(entries[2].providerId, "claude");
    }

    function test_visibilityOmitsHiddenProviders() {
        var snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            { id: "umans", state: "ok", windows: [Fixtures.validWindow({ used: 1, limit: undefined, usedPercent: undefined })] },
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] })
        ]);
        var config = defaultConfig({
            visibility: { claude: true, umans: false, codex: true }
        });
        var entries = CompactModel.buildCompactEntries(snapshot, config);
        compare(entries.length, 2);
        verify(providerEntry(entries, "umans") === null);
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
            { id: "umans", state: "ok", windows: [Fixtures.validWindow({ used: 1, limit: undefined, usedPercent: undefined })] },
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] })
        ]);
        var entries = CompactModel.buildCompactEntries(snapshot, defaultConfig());
        compare(providerEntry(entries, "claude").label, "Claude");
        compare(providerEntry(entries, "umans").label, "Umans");
        compare(providerEntry(entries, "codex").label, "Codex");
    }
}