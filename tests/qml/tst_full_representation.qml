import QtQuick
import QtTest
import org.kde.kirigami 2.20 as Kirigami

import "helpers/collector-fixtures.js" as Fixtures

TestCase {
    id: testCase
    name: "FullRepresentation"
    when: windowShown

    property var fullLoader: null
    property var full: null
    property var refreshSpy: null

    function sampleSnapshot(providers) {
        return Fixtures.minimalDocument({ providers: providers });
    }

    Component {
        id: fullComponent
        Loader {
            source: "../../plasmoid/contents/ui/FullRepresentation.qml"
        }
    }

    function init() {
        fullLoader = fullComponent.createObject(testCase, { width: 360, height: 420 });
        tryCompare(fullLoader, "status", Loader.Ready);
        full = fullLoader.item;
        full.autoAdvanceClock = false;
        refreshSpy = Qt.createQmlObject(
            'import QtTest; SignalSpy { }',
            testCase,
            "refreshSpy"
        );
        refreshSpy.target = full;
        refreshSpy.signalName = "requestRefresh";
    }

    function cleanup() {
        if (fullLoader !== null) {
            fullLoader.destroy();
            fullLoader = null;
            full = null;
        }
        if (refreshSpy !== null) {
            refreshSpy.destroy();
            refreshSpy = null;
        }
    }

    function test_undefinedSnapshotShowsNoProviders() {
        full.snapshot = null;
        compare(full.hasProviders, false);
        verify(full.Accessible.name.indexOf("no data") !== -1);
    }

    function test_emptyProviderListShowsNoProviders() {
        full.snapshot = sampleSnapshot([]);
        compare(full.hasProviders, false);
        compare(full.availableProviderIds.length, 0);
    }

    function test_singleProviderIsAutoSelected() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        compare(full.availableProviderIds.length, 1);
        compare(full.effectiveProviderId, "claude");
        compare(full.activeModel.providerId, "claude");
    }

    function test_missingProvidersAreNotOfferedInSwitcher() {
        full.snapshot = sampleSnapshot([
            Fixtures.validCodexProvider(),
            Fixtures.validGrokProvider()
        ]);
        compare(full.availableProviderIds.indexOf("claude"), -1);
        compare(full.availableProviderIds.length, 2);
        compare(full.providerSwitcherItem.count, 2);
    }

    function test_switchingProvidersViaSwitcherCurrentIndexShowsCorrectModel() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validGrokProvider({ state: "ok", windows: [Fixtures.validWindow({ used: 5, limit: undefined, usedPercent: undefined })] }),
            Fixtures.validCodexProvider({ state: "ok", windows: [Fixtures.validWindow({ usedPercent: 3 })] })
        ]);
        compare(full.effectiveProviderId, "claude");

        full.providerSwitcherItem.currentIndex = 1;
        compare(full.effectiveProviderId, "codex");
        compare(full.activeModel.providerId, "codex");

        full.providerSwitcherItem.currentIndex = 2;
        compare(full.effectiveProviderId, "grok");
        compare(full.activeModel.providerId, "grok");
    }

    function test_claudeProviderRendersWindowAndFacts() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 42, used: 42, limit: 100 })],
                details: { claude: { model: "opus", tokens: 900 } }
            })
        ]);
        compare(full.activeModel.windows[0].progressFraction, 0.42);
        compare(full.activeModel.windows[0].remaining, 58);
        var hasModelFact = false;
        for (var i = 0; i < full.activeModel.facts.length; i++) {
            if (full.activeModel.facts[i].label === "Model" && full.activeModel.facts[i].value === "opus") {
                hasModelFact = true;
            }
        }
        verify(hasModelFact);
    }

    function test_unlimitedGrokOmitsPercentAndProgress() {
        full.snapshot = sampleSnapshot([
            {
                id: "grok",
                state: "ok",
                windows: [{ id: "rolling", label: "Rolling window", used: 1200, resetAt: "2026-07-15T00:00:00.000Z" }],
                details: { grok: { monthlyUsed: 1200 } }
            }
        ]);
        var row = full.activeModel.windows[0];
        verify(row.usedPercent === undefined);
        verify(row.progressFraction === undefined);
        verify(row.limit === undefined);
        compare(row.used, 1200);
    }

    function test_thresholdColorMappingIsDistinct() {
        var critical = full.valueTextColor("critical");
        var caution = full.valueTextColor("caution");
        var none = full.valueTextColor("none");
        verify(critical !== caution);
        verify(caution !== none);
        verify(critical !== none);
    }

    function test_countdownForFutureResetShowsRemainingTime() {
        full.nowMs = Date.parse("2026-07-14T09:00:00.000Z");
        var text = full.countdownText("2026-07-14T10:00:00.000Z");
        verify(text.indexOf("Resets in") !== -1);
        verify(text.indexOf("-") === -1);
    }

    function test_countdownForPastResetShowsSettledState() {
        full.nowMs = Date.parse("2026-07-14T11:00:00.000Z");
        var text = full.countdownText("2026-07-14T10:00:00.000Z");
        compare(text, "Resets now");
        verify(text.indexOf("-") === -1);
    }

    function test_countdownAdvancesWhenNowMsChanges() {
        var resetAt = "2026-07-14T10:00:00.000Z";
        full.nowMs = Date.parse("2026-07-14T09:00:00.000Z");
        var first = full.countdownText(resetAt);

        full.nowMs = Date.parse("2026-07-14T09:59:00.000Z");
        var second = full.countdownText(resetAt);

        verify(first !== second);
    }

    function test_countdownOmittedWhenResetAtAbsent() {
        compare(full.countdownText(undefined), "");
        compare(full.resetLineText(undefined), "");
    }

    function test_staleStateShowsStaleMessage() {
        full.snapshot = sampleSnapshot([Fixtures.validStaleClaudeProvider()]);
        compare(full.activeModel.state, "stale");
        compare(full.activeModel.stateMessage, "Stale data");
    }

    function test_authNeededStateShowsLoginMessage() {
        full.snapshot = sampleSnapshot([Fixtures.validCodexProvider({ state: "auth-needed" })]);
        compare(full.activeModel.stateMessage, "Login needed");
    }

    function test_errorStateShowsErrorMessage() {
        full.snapshot = sampleSnapshot([Fixtures.validCodexProvider({ state: "error" })]);
        compare(full.activeModel.stateMessage, "Error");
    }

    function test_partialSuccessSnapshotDisplaysPerProviderState() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ state: "ok" }),
            Fixtures.validCodexProvider({ state: "error" })
        ]);

        full.providerSwitcherItem.currentIndex = 0;
        compare(full.effectiveProviderId, "claude");
        verify(full.activeModel.stateMessage === undefined || full.activeModel.stateMessage === "");

        full.providerSwitcherItem.currentIndex = 1;
        compare(full.effectiveProviderId, "codex");
        compare(full.activeModel.stateMessage, "Error");
    }

    function test_noWindowsOrFactsShowsNeutralPlaceholder() {
        full.snapshot = sampleSnapshot([
            { id: "claude", state: "ok", windows: [], details: {} }
        ]);
        compare(full.activeModel.windows.length, 0);
        compare(full.activeModel.facts.length, 0);
        verify(full.activeModel.stateMessage === undefined);
    }

    function test_refreshButtonEmitsRequestRefresh() {
        full.refreshButtonItem.clicked();
        compare(refreshSpy.count, 1);
    }

    function test_refreshButtonDisabledWhileInFlight() {
        compare(full.refreshButtonItem.enabled, true);
        full.inFlight = true;
        compare(full.refreshButtonItem.enabled, false);
    }

    function test_keyboardActivatesRefreshButton() {
        full.refreshButtonItem.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(refreshSpy.count, 1);
    }

    function test_keyboardActivatesProviderSwitchTab() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validGrokProvider({ state: "ok" })
        ]);
        var secondTab = full.providerSwitcherItem.itemAt(1);
        secondTab.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(full.providerSwitcherItem.currentIndex, 1);
        compare(full.effectiveProviderId, "grok");
    }

    function test_accessibleNamesPresent() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        verify(full.Accessible.name.length > 0);
        verify(full.refreshButtonItem.Accessible.name.length > 0);
        verify(full.providerSwitcherItem.itemAt(0).Accessible.name.length > 0);
    }

    function test_lastSuccessAtOmittedWhenAbsent() {
        full.snapshot = sampleSnapshot([
            { id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 5 })] }
        ]);
        verify(full.activeModel.lastSuccessAt === undefined);
        compare(full.formatTimestamp(undefined), "");
    }

    function test_multipleWindowsPreserveOrder() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [
                    Fixtures.validWindow({ id: "a", label: "A", usedPercent: 10 }),
                    Fixtures.validWindow({ id: "b", label: "B", usedPercent: 20 })
                ]
            })
        ]);
        compare(full.activeModel.windows.length, 2);
        compare(full.activeModel.windows[0].label, "A");
        compare(full.activeModel.windows[1].label, "B");
    }

    function test_malformedProviderRecordDoesNotCrash() {
        full.snapshot = sampleSnapshot([
            { id: "claude", state: "ok" }
        ]);
        compare(full.activeModel.windows.length, 0);
        compare(full.activeModel.facts.length, 0);
    }

    function test_renderedSurfaceContainsNoSecretPatterns() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                status: "Usage is current",
                windows: [Fixtures.validWindow({ usedPercent: 50 })],
                details: { claude: { model: "opus", tokens: 500 } }
            })
        ]);
        var blob = JSON.stringify(full.activeModel)
            + full.Accessible.name
            + full.refreshButtonItem.text;
        var forbidden = ["oauth", "Bearer", "sk-", "accountId", "refresh_token", "api_key", "authorization"];
        for (var i = 0; i < forbidden.length; i++) {
            verify(blob.toLowerCase().indexOf(forbidden[i].toLowerCase()) === -1);
        }
    }

    function test_defaultShowCountdownIsTrue() {
        compare(full.showCountdown, true);
    }

    function test_showCountdownFalseHidesCountdownButKeepsTimestamp() {
        full.nowMs = Date.parse("2026-07-14T09:00:00.000Z");

        full.showCountdown = true;
        var withCountdown = full.resetLineText("2026-07-14T10:00:00.000Z");
        verify(withCountdown.indexOf("(in ") !== -1);

        full.showCountdown = false;
        var withoutCountdown = full.resetLineText("2026-07-14T10:00:00.000Z");
        verify(withoutCountdown.indexOf("(in ") === -1);
        verify(withoutCountdown.length > 0);
    }

    function test_showCountdownFalseWithNoResetAtYieldsEmpty() {
        full.showCountdown = false;
        compare(full.resetLineText(undefined), "");
    }

    // M-T4 wiring: appearance object set on the representation reaches the
    // full model and shapes the emitted view-model (field computation itself
    // is unit-tested in tst_full_model).
    function test_appearanceFlowsIntoActiveModel() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10, limit: 100, used: 10 })] })
        ]);
        full.appearance = {
            claudeAccentColor: "#d97757",
            customTextColorEnabled: true,
            customTextColor: "#123456",
            labelOpacity: 0.5
        };
        verify(full.activeModel !== null);
        compare(full.activeModel.textColor, "#123456");
        compare(full.activeModel.labelOpacity, 0.5);
        compare(full.activeModel.windows[0].barColor, "#d97757");
    }

    function test_nullAppearanceReproducesV1Defaults() {
        full.appearance = null;
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10, limit: 100, used: 10 })] })
        ]);
        verify(full.activeModel !== null);
        compare(full.activeModel.textColor, "");
        compare(full.activeModel.labelOpacity, 1.0);
        compare(full.activeModel.windows[0].barColor, "");
    }

    function test_fontFamilyOverrideAndDefault() {
        full.fontFamily = "";
        compare(full.effectiveFontFamily, Kirigami.Theme.defaultFont.family);
        full.fontFamily = "Noto Mono";
        compare(full.effectiveFontFamily, "Noto Mono");
    }

    // Review G-T Major 2: full-rep metric values consume the custom text
    // color when no threshold is active; threshold colors always win.
    function test_windowValueTextColorPrecedence() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10, limit: 100, used: 10 })] })
        ]);
        full.appearance = { customTextColorEnabled: true, customTextColor: "#123456" };
        verify(full.activeModel !== null);
        compare(full.activeModel.textColor, "#123456");

        // No threshold → custom text color.
        compare(full.windowValueTextColor("none"), "#123456");
        // Threshold active → threshold color wins over custom.
        compare(full.windowValueTextColor("caution"), Kirigami.Theme.neutralTextColor);
        compare(full.windowValueTextColor("critical"), Kirigami.Theme.negativeTextColor);
    }

    function test_windowValueTextColorFallsBackToThemeWithoutCustom() {
        full.appearance = null;
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10, limit: 100, used: 10 })] })
        ]);
        compare(full.windowValueTextColor("none"), Kirigami.Theme.textColor);
        compare(full.windowValueTextColor("caution"), Kirigami.Theme.neutralTextColor);
    }

    // All four V1 providers must render with a capitalized display name in
    // the full-view tab bar.
    function test_providerDisplayNameCapitalizesAllProviders() {
        compare(full.providerDisplayName("claude"), "Claude");
        compare(full.providerDisplayName("codex"), "Codex");
        compare(full.providerDisplayName("grok"), "Grok");
        compare(full.providerDisplayName("kimi"), "Kimi");
    }

    function test_tabButtonsUseCapitalizedDisplayNames() {
        full.providerOrder = ["claude", "codex", "grok", "kimi"];
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validCodexProvider(),
            Fixtures.validGrokProvider(),
            Fixtures.validKimiProvider()
        ]);
        var tabBar = full.providerSwitcherItem;
        verify(tabBar !== null);
        var labels = [];
        for (var i = 0; i < tabBar.count; i++) {
            labels.push(tabBar.itemAt(i).text);
        }
        compare(labels.length, 4);
        compare(labels[0], "Claude");
        compare(labels[1], "Codex");
        compare(labels[2], "Grok");
        compare(labels[3], "Kimi");
    }
}
