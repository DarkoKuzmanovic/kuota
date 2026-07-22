import QtQuick
import QtTest

import "../../plasmoid/contents/ui/full-model.js" as FullModel
import "helpers/collector-fixtures.js" as Fixtures

TestCase {
    name: "FullModel"

    function windowRow(model, index) {
        if (!model.windows || model.windows.length <= index) {
            return null;
        }
        return model.windows[index];
    }

    function factValue(model, label) {
        for (var i = 0; i < model.facts.length; i++) {
            if (model.facts[i].label === label) {
                return model.facts[i].value;
            }
        }
        return null;
    }

    function test_progressFractionFromUsedPercent() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: 42, used: 42, limit: 100 })]
        });
        var model = FullModel.buildFullViewModel(record);
        var row = windowRow(model, 0);
        verify(row !== null);
        compare(row.progressFraction, 0.42);
        compare(row.usedPercent, 42);
    }

    function test_progressFractionFromUsedAndLimit() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: undefined, used: 25, limit: 100 })]
        });
        var model = FullModel.buildFullViewModel(record);
        compare(windowRow(model, 0).progressFraction, 0.25);
    }

    function test_progressFractionClampedAboveOne() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: 150, used: 150, limit: 100 })]
        });
        var model = FullModel.buildFullViewModel(record);
        compare(windowRow(model, 0).progressFraction, 1);
    }

    function test_progressFractionClampedBelowZero() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: -5, used: 0, limit: 100 })]
        });
        var model = FullModel.buildFullViewModel(record);
        compare(windowRow(model, 0).progressFraction, 0);
    }

    function test_progressFractionOmittedWhenNeitherPercentNorRatio() {
        var record = {
            id: "umans",
            state: "ok",
            windows: [Fixtures.validWindow({
                usedPercent: undefined,
                used: 500,
                limit: undefined
            })]
        };
        var model = FullModel.buildFullViewModel(record);
        var row = windowRow(model, 0);
        verify(row.progressFraction === undefined);
    }

    function test_remainingDerivedFromLimitAndUsed() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ used: 30, limit: 100, usedPercent: 30 })]
        });
        var model = FullModel.buildFullViewModel(record);
        compare(windowRow(model, 0).remaining, 70);
    }

    function test_remainingOmittedWhenNotDerivable() {
        var record = {
            id: "umans",
            state: "ok",
            windows: [Fixtures.validWindow({ used: 12, limit: undefined, usedPercent: undefined })]
        };
        var model = FullModel.buildFullViewModel(record);
        verify(windowRow(model, 0).remaining === undefined);
    }

    function test_resetAtPassedThroughNotCountdown() {
        var resetAt = "2026-07-14T10:00:00.000Z";
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ resetAt: resetAt })]
        });
        var model = FullModel.buildFullViewModel(record);
        compare(windowRow(model, 0).resetAt, resetAt);
        var serialized = JSON.stringify(model);
        verify(serialized.toLowerCase().indexOf("countdown") === -1);
        verify(serialized.toLowerCase().indexOf("time left") === -1);
    }

    function test_thresholdBoundary74_9IsNone() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: 74.9 })]
        });
        compare(windowRow(FullModel.buildFullViewModel(record), 0).thresholdLevel, "none");
    }

    function test_thresholdBoundary75IsCaution() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: 75 })]
        });
        compare(windowRow(FullModel.buildFullViewModel(record), 0).thresholdLevel, "caution");
    }

    function test_thresholdBoundary89_9IsCaution() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: 89.9 })]
        });
        compare(windowRow(FullModel.buildFullViewModel(record), 0).thresholdLevel, "caution");
    }

    function test_thresholdBoundary90IsCritical() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: 90 })]
        });
        compare(windowRow(FullModel.buildFullViewModel(record), 0).thresholdLevel, "critical");
    }

    function test_thresholdFromUsedAndLimitAt75() {
        var record = Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ usedPercent: undefined, used: 75, limit: 100 })]
        });
        compare(windowRow(FullModel.buildFullViewModel(record), 0).thresholdLevel, "caution");
    }

    function test_claudeFactsFullDetails() {
        var record = Fixtures.validClaudeProvider({
            details: {
                claude: {
                    model: "opus",
                    tokens: 9000,
                    extraUsageEnabled: true,
                    extraUsageUsedCredits: 1250,
                    extraUsageMonthlyLimit: 10000,
                    extraUsageCurrency: "USD",
                    extraUsageDecimalPlaces: 2,
                    extraUsageDisabledReason: "Plan limit"
                }
            }
        });
        var model = FullModel.buildFullViewModel(record);
        compare(factValue(model, "Model"), "opus");
        compare(factValue(model, "Tokens"), "9000");
        compare(factValue(model, "Extra usage"), "Enabled");
        compare(factValue(model, "Extra usage used"), "$12.50");
        compare(factValue(model, "Extra usage limit"), "$100.00");
        compare(factValue(model, "Extra usage disabled reason"), "Plan limit");
    }

    function test_claudeCreditsMinorUnitScaling() {
        // decimal_places present => credits are minor units, scaled by 10^dp for display.
        var scaled = FullModel.buildFullViewModel(Fixtures.validClaudeProvider({
            details: { claude: { extraUsageEnabled: true, extraUsageUsedCredits: 4, extraUsageMonthlyLimit: 500, extraUsageCurrency: "EUR", extraUsageDecimalPlaces: 3 } }
        }));
        compare(factValue(scaled, "Extra usage used"), "0.004 EUR");
        compare(factValue(scaled, "Extra usage limit"), "0.500 EUR");

        // No decimal_places hint => units unknown, show the raw integer count as-is.
        var raw = FullModel.buildFullViewModel(Fixtures.validClaudeProvider({
            details: { claude: { extraUsageEnabled: true, extraUsageUsedCredits: 1250, extraUsageCurrency: "USD" } }
        }));
        compare(factValue(raw, "Extra usage used"), "$1250");
    }

    function test_claudeFactsPartialDetailsOmitAbsent() {
        var record = Fixtures.validClaudeProvider({
            details: { claude: { model: "sonnet" } }
        });
        var model = FullModel.buildFullViewModel(record);
        compare(model.facts.length, 1);
        compare(factValue(model, "Model"), "sonnet");
        verify(factValue(model, "Tokens") === null);
    }

    function test_claudeFactsEmptyDetails() {
        var record = Fixtures.validClaudeProvider({ details: { claude: {} } });
        compare(FullModel.buildFullViewModel(record).facts.length, 0);
    }

    function test_umansFactsFullAndPartial() {
        var full = {
            id: "umans",
            state: "ok",
            windows: [Fixtures.validWindow()],
            details: { umans: { plan: "Pro", requests: 42, concurrency: 2, concurrencyLimit: 5 } }
        };
        var modelFull = FullModel.buildFullViewModel(full);
        compare(factValue(modelFull, "Plan"), "Pro");
        compare(factValue(modelFull, "Requests"), "42");
        compare(factValue(modelFull, "Concurrency"), "2");
        compare(factValue(modelFull, "Concurrency limit"), "5");

        var partial = {
            id: "umans",
            state: "ok",
            windows: [],
            details: { umans: { requests: 7 } }
        };
        var modelPartial = FullModel.buildFullViewModel(partial);
        compare(modelPartial.facts.length, 1);
        compare(factValue(modelPartial, "Requests"), "7");
    }

    function test_codexFactsExtraction() {
        var record = {
            id: "codex",
            state: "ok",
            windows: [Fixtures.validWindow({ usedPercent: 10 })],
            details: { codex: { plan: "Plus", credits: 3, cost: 1.25, tokens: 500 } }
        };
        var model = FullModel.buildFullViewModel(record);
        compare(factValue(model, "Plan"), "Plus");
        compare(factValue(model, "Credits"), "3");
        compare(factValue(model, "Cost"), "1.25");
        compare(factValue(model, "Tokens"), "500");
    }

    function test_grokFactsExtraction() {
        var record = {
            id: "grok",
            state: "ok",
            windows: [Fixtures.validWindow()],
            details: { grok: { monthlyUsed: 250, monthlyLimit: 1000, monthlyResetAt: "2026-08-01T00:00:00.000Z" } }
        };
        var model = FullModel.buildFullViewModel(record);
        compare(factValue(model, "Monthly used"), "250");
        compare(factValue(model, "Monthly limit"), "1000");
        // monthlyResetAt is surfaced via the window countdown, never as a raw fact.
        compare(model.facts.length, 2);
    }

    function test_kimiFactsFullAndPartial() {
        var full = {
            id: "kimi",
            state: "ok",
            windows: [Fixtures.validWindow()],
            details: { kimi: { concurrency: 2, concurrencyLimit: 5 } }
        };
        var modelFull = FullModel.buildFullViewModel(full);
        compare(factValue(modelFull, "Concurrency"), "2");
        compare(factValue(modelFull, "Concurrency limit"), "5");

        var partial = {
            id: "kimi",
            state: "ok",
            windows: [],
            details: { kimi: { concurrency: 3 } }
        };
        var modelPartial = FullModel.buildFullViewModel(partial);
        compare(modelPartial.facts.length, 1);
        compare(factValue(modelPartial, "Concurrency"), "3");
    }

    function test_unlimitedUmansWindowNoInventedPercent() {
        var record = {
            id: "umans",
            state: "ok",
            windows: [{
                id: "rolling",
                label: "Rolling window",
                used: 1200,
                resetAt: "2026-07-15T00:00:00.000Z"
            }],
            details: { umans: { requests: 1200 } }
        };
        var model = FullModel.buildFullViewModel(record);
        var row = windowRow(model, 0);
        compare(row.used, 1200);
        verify(row.usedPercent === undefined);
        verify(row.limit === undefined);
        verify(row.progressFraction === undefined);
        compare(row.thresholdLevel, "none");
        compare(row.resetAt, "2026-07-15T00:00:00.000Z");
    }

    function test_stateOkOmitsOrEmptyStateMessage() {
        var record = Fixtures.validClaudeProvider({ state: "ok" });
        var model = FullModel.buildFullViewModel(record);
        compare(model.state, "ok");
        verify(model.stateMessage === undefined || model.stateMessage === "");
    }

    function test_stateStaleMessage() {
        var record = Fixtures.validStaleClaudeProvider();
        var model = FullModel.buildFullViewModel(record);
        compare(model.state, "stale");
        compare(model.stateMessage, "Stale data");
    }

    function test_stateAuthNeededMessage() {
        var record = Fixtures.validUmansProvider({ state: "auth-needed" });
        var model = FullModel.buildFullViewModel(record);
        compare(model.state, "auth-needed");
        compare(model.stateMessage, "Login needed");
    }

    function test_stateErrorMessage() {
        var record = Fixtures.validCodexProvider({ state: "error" });
        var model = FullModel.buildFullViewModel(record);
        compare(model.state, "error");
        compare(model.stateMessage, "Error");
    }

    function test_lastSuccessAtPassthrough() {
        var ts = "2026-07-11T10:00:01.000Z";
        var record = Fixtures.validClaudeProvider({ lastSuccessAt: ts });
        compare(FullModel.buildFullViewModel(record).lastSuccessAt, ts);
    }

    function test_missingWindowsEmptyArray() {
        var record = Fixtures.validUmansProvider({ windows: undefined });
        compare(FullModel.buildFullViewModel(record).windows.length, 0);
    }

    function test_nonRecordInputSafeEmptyModel() {
        var model = FullModel.buildFullViewModel(null);
        compare(model.windows.length, 0);
        compare(model.facts.length, 0);
        verify(model.providerId === "" || model.providerId === undefined);
    }

    function test_outputContainsNoSecretPatterns() {
        var record = Fixtures.validClaudeProvider({
            status: "Usage is current",
            windows: [Fixtures.validWindow({ usedPercent: 50 })]
        });
        var serialized = JSON.stringify(FullModel.buildFullViewModel(record));
        var forbidden = ["oauth", "Bearer", "sk-", "accountId", "refresh", "access", "api_key", "authorization"];
        for (var i = 0; i < forbidden.length; i++) {
            verify(serialized.toLowerCase().indexOf(forbidden[i].toLowerCase()) === -1,
                   "output must not contain '" + forbidden[i] + "'");
        }
    }

    function test_multipleWindowsPreserveOrder() {
        var record = Fixtures.validClaudeProvider({
            windows: [
                Fixtures.validWindow({ id: "a", label: "A", usedPercent: 10 }),
                Fixtures.validWindow({ id: "b", label: "B", usedPercent: 20 })
            ]
        });
        var model = FullModel.buildFullViewModel(record);
        compare(model.windows.length, 2);
        compare(model.windows[0].label, "A");
        compare(model.windows[1].label, "B");
    }

    function test_injectedThresholdBoundariesOverrideDefaults() {
        var thresholds = { caution: 50, critical: 60 };

        var below = windowRow(FullModel.buildFullViewModel(
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 49 })] }),
            thresholds
        ), 0);
        compare(below.thresholdLevel, "none");

        var atCaution = windowRow(FullModel.buildFullViewModel(
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 50 })] }),
            thresholds
        ), 0);
        compare(atCaution.thresholdLevel, "caution");

        var justBelowCritical = windowRow(FullModel.buildFullViewModel(
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 59 })] }),
            thresholds
        ), 0);
        compare(justBelowCritical.thresholdLevel, "caution");

        var atCritical = windowRow(FullModel.buildFullViewModel(
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 60 })] }),
            thresholds
        ), 0);
        compare(atCritical.thresholdLevel, "critical");
    }

    function test_omittedThresholdsStillDefaultTo75And90() {
        var record = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 80 })] });
        var row = windowRow(FullModel.buildFullViewModel(record), 0);
        compare(row.thresholdLevel, "caution");
    }

    function test_invertedInjectedThresholdsFallBackToDefaults() {
        var record = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 80 })] });
        var row = windowRow(FullModel.buildFullViewModel(record, { caution: 90, critical: 50 }), 0);
        // Invalid (caution >= critical) → falls back to the 75/90 default rule.
        compare(row.thresholdLevel, "caution");
    }

    // ---- M-T2 theming consumption + precedence ----

    function test_fullNoAppearanceArgReproducesV1() {
        var record = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 42 })] });
        var model = FullModel.buildFullViewModel(record);
        compare(model.textColor, "");
        compare(model.iconName, "");
        compare(model.labelOpacity, 1.0);
        compare(windowRow(model, 0).barColor, "");
    }

    function test_fullAccentOnProgressBarYieldsToThresholdPerRow() {
        var record = Fixtures.validClaudeProvider({
            windows: [
                Fixtures.validWindow({ usedPercent: 95 }),
                Fixtures.validWindow({ usedPercent: 10 })
            ]
        });
        var model = FullModel.buildFullViewModel(record, undefined, { claudeAccentColor: "#123456" });
        // Critical row: threshold color (rep-resolved) wins → no accent override.
        compare(windowRow(model, 0).thresholdLevel, "critical");
        compare(windowRow(model, 0).barColor, "");
        // Calm row: accent tints the progress-bar fill.
        compare(windowRow(model, 1).thresholdLevel, "none");
        compare(windowRow(model, 1).barColor, "#123456");
    }

    function test_fullCustomTextColorAndIcon() {
        var record = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 95 })] });
        var model = FullModel.buildFullViewModel(record, undefined, {
            customTextColorEnabled: true,
            customTextColor: "#00ff00",
            claudeCustomIcon: "utilities-terminal",
            labelOpacity: 0.6
        });
        // Facts/labels are never threshold-tinted, so the custom text color applies
        // even with a critical row present; the bar still yields to the threshold.
        compare(model.textColor, "#00ff00");
        compare(model.iconName, "utilities-terminal");
        compare(model.labelOpacity, 0.6);
        compare(windowRow(model, 0).barColor, "");
    }

    function test_fullCustomTextColorDisabledIsIgnored() {
        var record = Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 42 })] });
        var model = FullModel.buildFullViewModel(record, undefined, {
            customTextColorEnabled: false,
            customTextColor: "#00ff00"
        });
        compare(model.textColor, "");
    }
}