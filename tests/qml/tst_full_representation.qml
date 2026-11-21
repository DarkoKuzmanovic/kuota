import QtQuick
import QtTest
import QtQuick.Controls as Controls
import org.kde.kirigami 2.20 as Kirigami

import "helpers/collector-fixtures.js" as Fixtures

TestCase {
    id: testCase
    name: "FullRepresentation"
    when: windowShown
    // TestCase's own `visible` defaults to false and isVisible() is effective
    // visibility; the overview/no-providers assertions below read `.visible`.
    visible: true

    property var fullLoader: null
    property var full: null
    property var refreshSpy: null
    property var configureSpy: null

    readonly property real nineUtc: Date.parse("2026-07-14T09:00:00.000Z")

    function sampleSnapshot(providers) {
        return Fixtures.minimalDocument({ providers: providers });
    }

    Component {
        id: fullComponent
        Loader {
            source: "../../plasmoid/contents/ui/FullRepresentation.qml"
        }
    }

    function createSpy(signalName) {
        var spy = Qt.createQmlObject('import QtTest; SignalSpy { }', testCase, signalName + "Spy");
        spy.target = full;
        spy.signalName = signalName;
        return spy;
    }

    function init() {
        fullLoader = fullComponent.createObject(testCase, { width: 360, height: 420 });
        tryCompare(fullLoader, "status", Loader.Ready);
        full = fullLoader.item;
        full.autoAdvanceClock = false;
        refreshSpy = createSpy("requestRefresh");
        configureSpy = createSpy("requestConfigure");
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
        if (configureSpy !== null) {
            configureSpy.destroy();
            configureSpy = null;
        }
    }

    function show(providerId) {
        full.openProvider(providerId);
        compare(full.effectiveProviderId, providerId);
    }

    function overviewRow(providerId) {
        var rows = full.overviewModel.rows;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].providerId === providerId) {
                return rows[i];
            }
        }
        return null;
    }

    // ---- Tabs and selection ----

    function test_standaloneOffersEverySupportedProvider() {
        var ids = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode", "mistral", "opendesign", "muse"];
        full.snapshot = sampleSnapshot(ids.map(function(id) { return { id: id, state: "auth-needed" }; }));
        compare(full.providerOrder, ids);
        compare(full.enabledProviderIds, ids);
        compare(full.availableProviderIds, ids);
        compare(full.providerSwitcherItem.count, ids.length + 1);
        for (var i = 0; i < ids.length; i++) {
            full.providerSwitcherItem.currentIndex = i + 1;
            compare(full.activeModel.providerId, ids[i]);
        }
    }

    function test_tabsStayReachableAndRefreshNeverOverlaps() {
        var bar = full.providerSwitcherItem;
        for (var widthIndex = 0; widthIndex < 2; widthIndex++) {
            fullLoader.width = widthIndex === 0 ? 360 : 240;
            tryVerify(function() {
                return bar.width > 0 && bar.mapToItem(full, 0, 0).x + bar.width
                    <= full.refreshButtonItem.mapToItem(full, 0, 0).x;
            });
            verify(bar.clip, "overflowing tab content must not paint over Refresh");
            verify(full.refreshButtonItem.mapToItem(full, 0, 0).x + full.refreshButtonItem.width <= full.width);
            compare(bar.count, 11);
            bar.currentIndex = 0;
            bar.itemAt(0).forceActiveFocus();
            for (var i = 1; i < bar.count; i++) {
                keyClick(Qt.Key_Right);
                compare(bar.currentIndex, i);
            }
            compare(full.effectiveProviderId, "muse");
            tryVerify(function() {
                var tab = bar.itemAt(bar.count - 1);
                var x = tab.mapToItem(bar, 0, 0).x;
                return x >= -1 && x + tab.width <= bar.width + 1;
            });
        }
    }

    function test_allTabIsFirstAndDefault() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        compare(full.providerSwitcherItem.currentIndex, 0);
        compare(full.providerSwitcherItem.itemAt(0).text, "All");
        compare(full.effectiveProviderId, "");
        compare(full.overviewActive, true);
        verify(full.activeModel === null);
        compare(full.Accessible.name, "Kuota usage overview");
    }

    function test_openOverviewReturnsToAll() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        show("claude");
        full.openOverview();
        compare(full.overviewActive, true);
    }

    function test_undefinedSnapshotShowsNoData() {
        full.snapshot = null;
        compare(full.hasProviders, false);
        compare(full.hasEnabledProviders, true);
        verify(full.Accessible.name.indexOf("no data") !== -1);
    }

    function test_emptyProviderListShowsNoProviders() {
        full.snapshot = sampleSnapshot([]);
        compare(full.hasProviders, false);
        compare(full.availableProviderIds.length, 0);
    }

    function test_openingAProviderShowsItsModel() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        show("claude");
        compare(full.activeModel.providerId, "claude");
        compare(full.providerSwitcherItem.currentIndex, 1);
        compare(full.Accessible.name, "Kuota usage details, Claude");
    }

    function test_enabledProvidersWithoutRecordsKeepTabsAndPendingRows() {
        full.providerOrder = ["claude", "codex", "grok"];
        full.snapshot = sampleSnapshot([
            Fixtures.validCodexProvider(),
            Fixtures.validGrokProvider()
        ]);
        compare(full.availableProviderIds, ["codex", "grok"]);
        compare(full.providerSwitcherItem.count, 4);
        compare(overviewRow("claude").pending, true);
        compare(overviewRow("codex").pending, false);

        show("claude");
        verify(full.activeRecord === null);
        verify(full.activeModel === null);
    }

    function test_switchingProvidersViaSwitcherCurrentIndexShowsCorrectModel() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validGrokProvider({ state: "ok", windows: [Fixtures.validWindow({ used: 5, limit: undefined, usedPercent: undefined })] }),
            Fixtures.validCodexProvider({ state: "ok", windows: [Fixtures.validWindow({ usedPercent: 3 })] })
        ]);
        full.providerSwitcherItem.currentIndex = 1;
        compare(full.effectiveProviderId, "claude");

        full.providerSwitcherItem.currentIndex = 2;
        compare(full.effectiveProviderId, "codex");
        compare(full.activeModel.providerId, "codex");

        full.providerSwitcherItem.currentIndex = 3;
        compare(full.effectiveProviderId, "grok");
        compare(full.activeModel.providerId, "grok");
    }

    // ---- No providers enabled vs waiting ----

    function test_noProvidersEnabledIsADistinctConfigurationState() {
        full.providerOrder = [];
        full.snapshot = null;
        compare(full.hasEnabledProviders, false);
        compare(full.overviewModel.rows.length, 0);
        compare(full.refreshButtonItem.enabled, false);
        compare(full.noProvidersMessageItem.visible, true);
        compare(full.noProvidersMessageItem.text, "No providers enabled");
        compare(full.providerSwitcherItem.visible, false);
        verify(full.Accessible.name.indexOf("no providers enabled") !== -1);

        full.noProvidersMessageItem.helpfulAction.trigger();
        compare(configureSpy.count, 1);
        compare(refreshSpy.count, 0);
    }

    function test_enabledProvidersWaitingForDataAreNotCalledDisabled() {
        full.providerOrder = ["claude", "codex"];
        full.snapshot = null;
        compare(full.hasEnabledProviders, true);
        compare(full.noProvidersMessageItem.visible, false);
        compare(full.refreshButtonItem.enabled, true);
        compare(full.overviewRowsItem.count, 2);
        compare(overviewRow("claude").pending, true);
        compare(full.overviewMetricText(overviewRow("claude")), "Waiting for data…");
        full.inFlight = true;
        compare(full.overviewMetricText(overviewRow("claude")), "Refreshing…");
        verify(full.Accessible.name.indexOf("no data yet") !== -1);
    }

    // ---- Overview rows ----

    function test_overviewRowsFollowConfiguredOrder() {
        full.providerOrder = ["grok", "claude", "codex"];
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 95 })] }),
            Fixtures.validGrokProvider({ windows: [Fixtures.validWindow({ usedPercent: 5 })] })
        ]);
        compare(full.overviewRowsItem.count, 3);
        compare(full.overviewRowsItem.itemAt(0).objectName, "overviewRow_grok");
        compare(full.overviewRowsItem.itemAt(1).objectName, "overviewRow_claude");
        compare(full.overviewRowsItem.itemAt(2).objectName, "overviewRow_codex");
    }

    function test_overviewShowsTightestWindowUsageAndRemaining() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [
                Fixtures.validWindow({ id: "session", label: "Session", usedPercent: 30 }),
                Fixtures.validWindow({ id: "weekly", label: "Weekly", usedPercent: 79.4 })
            ]
        })]);
        var row = overviewRow("claude");
        compare(row.primary.label, "Weekly");
        compare(full.overviewUsedText(row), "79% used");
        compare(full.overviewLeftText(row), "21% left");
        compare(full.overviewMetricText(row), "79% used · 21% left");
    }

    function test_overviewShowsGenuineCountsWithoutPercent() {
        full.providerOrder = ["grok", "kimi"];
        full.snapshot = sampleSnapshot([
            { id: "grok", state: "ok", windows: [{ id: "rolling", label: "Rolling window", used: 1200 }] },
            { id: "kimi", state: "ok", windows: [{ id: "week", label: "Weekly", used: 21, limit: 100 }] }
        ]);
        compare(full.overviewMetricText(overviewRow("grok")), "1200 used");
        compare(full.overviewMetricText(overviewRow("kimi")), "21 / 100");
        compare(full.overviewLeftText(overviewRow("kimi")), "", "no remaining percent without a reported percent");
    }

    function test_overviewResetBelongsToDisplayedWindow() {
        full.nowMs = nineUtc;
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [
                Fixtures.validWindow({ id: "weekly", label: "Weekly", usedPercent: 80, resetAt: "2026-07-20T00:00:00.000Z" }),
                Fixtures.validWindow({ id: "session", label: "Session", usedPercent: 20, resetAt: "2026-07-14T12:00:00.000Z" })
            ]
        })]);
        var row = overviewRow("claude");
        compare(row.primary.label, "Weekly");
        compare(full.overviewResetText(row), "resets in 5d 15h");
        verify(full.overviewAccessibleName(row).indexOf("resets in 5d 15h") !== -1);
    }

    function test_overviewResetOfTheTightestWindowNeedsNoName() {
        full.nowMs = nineUtc;
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ label: "Weekly", usedPercent: 80, resetAt: "2026-07-20T00:00:00.000Z" })]
        })]);
        compare(full.overviewResetText(overviewRow("claude")), "resets in 5d 15h");
    }

    function test_overviewResetStaysWithDisplayedWindowAfterItPasses() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [
                Fixtures.validWindow({ id: "weekly", label: "Weekly", usedPercent: 80, resetAt: "2026-07-20T00:00:00.000Z" }),
                Fixtures.validWindow({ id: "session", label: "Session", usedPercent: 20, resetAt: "2026-07-14T12:00:00.000Z" })
            ]
        })]);
        var row = overviewRow("claude");
        full.nowMs = Date.parse("2026-07-14T13:00:00.000Z");
        compare(full.overviewResetText(row), "resets in 5d 11h");
        full.nowMs = Date.parse("2026-07-21T00:00:00.000Z");
        compare(full.overviewResetText(row), "resets now");
    }

    function test_overviewResetWithoutCountdownShowsTimestamp() {
        full.nowMs = nineUtc;
        full.showCountdown = false;
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ label: "Weekly", usedPercent: 80, resetAt: "2026-07-20T00:00:00.000Z" })]
        })]);
        var text = full.overviewResetText(overviewRow("claude"));
        compare(text, "resets " + full.formatTimestamp("2026-07-20T00:00:00.000Z"));
        verify(text.indexOf(" in ") === -1);
    }

    function test_overviewMissingResetStaysAbsent() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ resetAt: undefined })]
        })]);
        compare(full.overviewResetText(overviewRow("claude")), "");
    }

    function test_overviewDoesNotBorrowAnotherWindowsReset() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [
                Fixtures.validWindow({ id: "weekly", usedPercent: 80, resetAt: undefined }),
                Fixtures.validWindow({ id: "session", usedPercent: 20, resetAt: "2026-07-14T12:00:00.000Z" })
            ]
        })]);
        compare(full.overviewResetText(overviewRow("claude")), "");
    }

    function test_overviewStateBadgesAndLoginHint() {
        full.providerOrder = ["claude", "codex", "grok"];
        full.snapshot = sampleSnapshot([
            Fixtures.validStaleClaudeProvider(),
            Fixtures.validCodexProvider({ state: "auth-needed" }),
            Fixtures.validGrokProvider({ state: "error", windows: undefined, details: undefined, lastSuccessAt: undefined })
        ]);
        var stale = full.overviewAccessibleName(overviewRow("claude"));
        verify(stale.indexOf("Stale data") !== -1);
        verify(stale.indexOf("42% used") !== -1, "retained data stays visible");

        var auth = full.overviewAccessibleName(overviewRow("codex"));
        verify(auth.indexOf("Login needed") !== -1);
        verify(auth.indexOf("run in a terminal: kuota login codex") !== -1);
        compare(full.capitalizeFirst(overviewRow("codex").loginHint), "Run in a terminal: kuota login codex");

        verify(full.overviewAccessibleName(overviewRow("grok")).indexOf("Error") !== -1);
        compare(full.stateColor("error"), Kirigami.Theme.negativeTextColor);
        compare(full.stateColor("auth-needed"), Kirigami.Theme.neutralTextColor);
    }

    function test_overviewRowClickOpensProviderTab() {
        full.providerOrder = ["claude", "grok"];
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider(), Fixtures.validGrokProvider()]);
        full.overviewRowsItem.itemAt(1).clicked();
        compare(full.effectiveProviderId, "grok");
        compare(full.activeModel.providerId, "grok");
    }

    function test_keyboardReturnOnOverviewRowOpensProviderAndMovesFocus() {
        full.providerOrder = ["claude", "grok"];
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider(), Fixtures.validGrokProvider()]);
        full.overviewRowsItem.itemAt(0).forceActiveFocus();
        keyClick(Qt.Key_Return);
        compare(full.effectiveProviderId, "claude");
        verify(full.providerSwitcherItem.itemAt(1).activeFocus);
    }

    function test_keyboardSpaceOnOverviewRowOpensProvider() {
        full.providerOrder = ["claude", "grok"];
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider(), Fixtures.validGrokProvider()]);
        full.overviewRowsItem.itemAt(1).forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(full.effectiveProviderId, "grok");
    }

    function test_arrowKeysMoveBetweenOverviewRows() {
        full.providerOrder = ["claude", "codex", "grok"];
        full.snapshot = null;
        var rows = full.overviewRowsItem;
        rows.itemAt(0).forceActiveFocus();
        keyClick(Qt.Key_Down);
        verify(rows.itemAt(1).activeFocus);
        keyClick(Qt.Key_Down);
        verify(rows.itemAt(2).activeFocus);
        keyClick(Qt.Key_Down);
        verify(rows.itemAt(2).activeFocus, "stays on the last row");
        keyClick(Qt.Key_Up);
        verify(rows.itemAt(1).activeFocus);
    }

    function test_overviewRowsHaveCompleteAccessibleNames() {
        full.nowMs = nineUtc;
        full.providerOrder = ["claude", "codex"];
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider({
            windows: [Fixtures.validWindow({ label: "Weekly", usedPercent: 79, resetAt: "2026-07-14T12:00:00.000Z" })]
        })]);
        var item = full.overviewRowsItem.itemAt(0);
        compare(full.overviewAccessibleName(overviewRow("claude")), "Claude, Weekly window, 79% used, 21% left, resets in 3h 0m");
        compare(full.overviewResetText(item.modelData), "resets in 3h 0m");
        compare(item.resetText, "resets in 3h 0m");
        tryCompare(item.Accessible, "name", "Claude, Weekly window, 79% used, 21% left, resets in 3h 0m");
        compare(item.Accessible.role, Accessible.Button);
        verify(item.Accessible.description.indexOf("Claude") !== -1);
        compare(full.overviewRowsItem.itemAt(1).Accessible.name, "Codex, Waiting for data…");
    }

    function test_narrowWidthKeepsRowsWithinThePopup() {
        full.providerOrder = ["claude", "commandcode", "opendesign"];
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ label: "Weekly (all models)", usedPercent: 79 })] }),
            Fixtures.validCommandCodeProvider({ state: "stale" }),
            { id: "opendesign", state: "auth-needed" }
        ]);
        fullLoader.width = Kirigami.Units.gridUnit * 12;
        for (var i = 0; i < 3; i++) {
            var row = full.overviewRowsItem.itemAt(i);
            tryVerify(function() { return row.width > 0 && row.width <= full.width; });
            verify(row.Accessible.name.length > 0);
        }
    }

    // ---- Pace marker ----

    function test_paceFractionBoundariesFromReportedValuesOnly() {
        var resetAt = "2026-07-14T10:00:00.000Z";
        var duration = 5 * 3600;
        full.nowMs = Date.parse("2026-07-14T05:00:00.000Z");
        compare(full.paceFraction(resetAt, duration), 0);
        full.nowMs = Date.parse("2026-07-14T07:30:00.000Z");
        compare(full.paceFraction(resetAt, duration), 0.5);
        full.nowMs = Date.parse("2026-07-14T10:00:00.000Z");
        compare(full.paceFraction(resetAt, duration), 1);
        full.nowMs = Date.parse("2026-07-14T04:00:00.000Z");
        compare(full.paceFraction(resetAt, duration), 0, "clamped before window start");
        full.nowMs = Date.parse("2026-07-14T11:00:00.000Z");
        compare(full.paceFraction(resetAt, duration), 1, "clamped after reset");
    }

    function test_paceFractionUnavailableWithoutValidInputs() {
        full.nowMs = nineUtc;
        compare(full.paceFraction("2026-07-14T10:00:00.000Z", undefined), -1);
        compare(full.paceFraction("2026-07-14T10:00:00.000Z", 0), -1);
        compare(full.paceFraction("2026-07-14T10:00:00.000Z", -3600), -1);
        compare(full.paceFraction("2026-07-14T10:00:00.000Z", NaN), -1);
        compare(full.paceFraction(undefined, 3600), -1);
        compare(full.paceFraction("not a time", 3600), -1);
        compare(full.paceAccessibleText(-1), "");
    }

    function test_paceMarkerOnlyWhenDurationIsReported() {
        full.nowMs = Date.parse("2026-07-14T07:30:00.000Z");
        full.providerOrder = ["codex", "claude"];
        full.snapshot = sampleSnapshot([
            { id: "codex", state: "ok", windows: [{ id: "primary", label: "5h", usedPercent: 40, resetAt: "2026-07-14T10:00:00.000Z", durationSeconds: 18000 }] },
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ label: "5h", usedPercent: 40, resetAt: "2026-07-14T10:00:00.000Z" })] })
        ]);
        verify(full.overviewAccessibleName(overviewRow("codex")).indexOf("50% of window time elapsed") !== -1);
        verify(full.overviewAccessibleName(overviewRow("claude")).indexOf("elapsed") === -1);
        compare(full.overviewRowsItem.itemAt(0).pace, 0.5);
        compare(full.overviewRowsItem.itemAt(1).pace, -1);
        var overviewBar = findChild(full.overviewRowsItem.itemAt(0), "overviewProgressBar");
        verify(overviewBar !== null);
        compare(overviewBar.Accessible.description, "40% used · 50% of window time elapsed");
        compare(overviewBar.Controls.ToolTip.text, overviewBar.Accessible.description);

        show("codex");
        var detailBar = findChild(full, "detailProgressBar");
        verify(detailBar !== null);
        compare(detailBar.Accessible.description, "40% used · 50% of window time elapsed");
        compare(detailBar.Controls.ToolTip.text, detailBar.Accessible.description);
        var row = full.activeModel.windows[0];
        compare(row.durationSeconds, 18000);
        verify(full.windowAccessibleName(row).indexOf("50% of window time elapsed") !== -1);
        full.nowMs = Date.parse("2026-07-14T08:45:00.000Z");
        verify(full.windowAccessibleName(row).indexOf("75% of window time elapsed") !== -1, "advances with the clock");
    }

    // ---- Detail cards ----

    function test_claudeProviderRendersWindowAndFacts() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                windows: [Fixtures.validWindow({ usedPercent: 42, used: 42, limit: 100 })],
                details: { claude: { model: "opus", tokens: 900 } }
            })
        ]);
        show("claude");
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

    function test_windowCountsTextCombinesGenuineCounts() {
        compare(full.windowCountsText({ used: 42, limit: 100, remaining: 58 }), "42 of 100 used · 58 remaining");
        compare(full.windowCountsText({ used: 1200 }), "1200 used");
        compare(full.windowCountsText({ usedPercent: 10 }), "");
    }

    function test_windowAccessibleNameCarriesValueCountsAndReset() {
        full.nowMs = nineUtc;
        var name = full.windowAccessibleName({ label: "Weekly", usedPercent: 42.7, used: 42, limit: 100, remaining: 58, resetAt: "2026-07-14T10:00:00.000Z", progressFraction: 0.427 });
        verify(name.indexOf("Weekly") === 0);
        verify(name.indexOf("42% used") !== -1);
        verify(name.indexOf("42 of 100 used") !== -1);
        verify(name.indexOf("(in 1h 0m)") !== -1);
        verify(name.indexOf("elapsed") === -1, "no duration, no pace");
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
        show("grok");
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

    function test_barFillColorPrecedence() {
        compare(full.barFillColor({ thresholdLevel: "critical", barColor: "" }), Kirigami.Theme.negativeTextColor);
        compare(full.barFillColor({ thresholdLevel: "caution", barColor: "" }), Kirigami.Theme.neutralTextColor);
        compare(full.barFillColor({ thresholdLevel: "none", barColor: "#d97757" }), "#d97757");
        compare(full.barFillColor({ thresholdLevel: "none", barColor: "" }), Kirigami.Theme.highlightColor);
    }

    function test_countdownForFutureResetShowsRemainingTime() {
        full.nowMs = nineUtc;
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
        full.nowMs = nineUtc;
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
        show("claude");
        compare(full.activeModel.state, "stale");
        compare(full.activeModel.stateMessage, "Stale data");
    }

    function test_authNeededStateShowsLoginMessage() {
        full.snapshot = sampleSnapshot([Fixtures.validCodexProvider({ state: "auth-needed" })]);
        show("codex");
        compare(full.activeModel.stateMessage, "Login needed — run in a terminal: kuota login codex");
    }

    function test_errorStateShowsErrorMessage() {
        full.snapshot = sampleSnapshot([Fixtures.validCodexProvider({ state: "error" })]);
        show("codex");
        compare(full.activeModel.stateMessage, "Error");
    }

    function test_partialSuccessSnapshotDisplaysPerProviderState() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ state: "ok" }),
            Fixtures.validCodexProvider({ state: "error" })
        ]);

        show("claude");
        verify(full.activeModel.stateMessage === undefined || full.activeModel.stateMessage === "");

        show("codex");
        compare(full.activeModel.stateMessage, "Error");

        compare(overviewRow("claude").stateBadge, "");
        compare(overviewRow("codex").stateBadge, "Error");
    }

    function test_noWindowsOrFactsShowsNeutralPlaceholder() {
        full.snapshot = sampleSnapshot([
            { id: "claude", state: "ok", windows: [], details: {} }
        ]);
        show("claude");
        compare(full.activeModel.windows.length, 0);
        compare(full.activeModel.facts.length, 0);
        verify(full.activeModel.stateMessage === undefined);
        compare(full.overviewMetricText(overviewRow("claude")), "");
    }

    // ---- Refresh ----

    function test_refreshButtonEmitsRequestRefresh() {
        full.refreshButtonItem.clicked();
        compare(refreshSpy.count, 1);
    }

    function test_refreshButtonDisabledWhileInFlight() {
        compare(full.refreshButtonItem.enabled, true);
        full.inFlight = true;
        compare(full.refreshButtonItem.enabled, false);
    }

    function test_refreshButtonStaysReachableOnDetailTabs() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        show("claude");
        compare(full.refreshButtonItem.visible, true);
        compare(full.refreshButtonItem.enabled, true);
    }

    function test_keyboardActivatesRefreshButton() {
        full.refreshButtonItem.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(refreshSpy.count, 1);
    }

    function test_keyboardActivatesProviderSwitchTab() {
        full.providerOrder = ["claude", "grok"];
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validGrokProvider({ state: "ok" })
        ]);
        var grokTab = full.providerSwitcherItem.itemAt(2);
        grokTab.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(full.providerSwitcherItem.currentIndex, 2);
        compare(full.effectiveProviderId, "grok");
    }

    function test_accessibleNamesPresent() {
        full.snapshot = sampleSnapshot([Fixtures.validClaudeProvider()]);
        verify(full.Accessible.name.length > 0);
        verify(full.refreshButtonItem.Accessible.name.length > 0);
        compare(full.providerSwitcherItem.itemAt(0).Accessible.name, "All providers overview");
        compare(full.providerSwitcherItem.itemAt(1).Accessible.name, "Claude");
    }

    function test_lastSuccessAtOmittedWhenAbsent() {
        full.snapshot = sampleSnapshot([
            { id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 5 })] }
        ]);
        show("codex");
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
        show("claude");
        compare(full.activeModel.windows.length, 2);
        compare(full.activeModel.windows[0].label, "A");
        compare(full.activeModel.windows[1].label, "B");
    }

    function test_malformedProviderRecordDoesNotCrash() {
        full.snapshot = sampleSnapshot([
            { id: "claude", state: "ok" }
        ]);
        show("claude");
        compare(full.activeModel.windows.length, 0);
        compare(full.activeModel.facts.length, 0);
        verify(overviewRow("claude").primary === undefined);
    }

    function test_renderedSurfaceContainsNoSecretPatterns() {
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                status: "Usage is current",
                windows: [Fixtures.validWindow({ usedPercent: 50 })],
                details: { claude: { model: "opus", tokens: 500 } }
            })
        ]);
        var overviewBlob = JSON.stringify(full.overviewModel) + full.overviewAccessibleName(overviewRow("claude"));
        show("claude");
        var blob = overviewBlob
            + JSON.stringify(full.activeModel)
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
        full.nowMs = nineUtc;

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

    // ---- Theming ----

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
        compare(overviewRow("claude").textColor, "#123456");
        compare(overviewRow("claude").primary.barColor, "#d97757");
        show("claude");
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
        show("claude");
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
        show("claude");
        compare(full.activeModel.textColor, "#123456");

        // No threshold → custom text color.
        compare(full.windowValueTextColor("none"), "#123456");
        // Threshold active → threshold color wins over custom.
        compare(full.windowValueTextColor("caution"), Kirigami.Theme.neutralTextColor);
        compare(full.windowValueTextColor("critical"), Kirigami.Theme.negativeTextColor);
        // Same precedence for overview rows.
        compare(full.thresholdTextColor("none", "#123456"), "#123456");
        compare(full.thresholdTextColor("critical", "#123456"), Kirigami.Theme.negativeTextColor);
        compare(full.labelTextColor("#123456"), "#123456");
        compare(full.labelTextColor(""), Kirigami.Theme.textColor);
    }

    function test_windowValueTextColorFallsBackToThemeWithoutCustom() {
        full.appearance = null;
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10, limit: 100, used: 10 })] })
        ]);
        show("claude");
        compare(full.windowValueTextColor("none"), Kirigami.Theme.textColor);
        compare(full.windowValueTextColor("caution"), Kirigami.Theme.neutralTextColor);
    }

    // Light and dark: card/track/hairline colors are derived from the active
    // theme's own background and text, never hard-coded.
    function test_derivedColorsFollowLightAndDarkThemes() {
        var palettes = [
            { background: "#fcfcfc", text: "#232629" },
            { background: "#202326", text: "#fcfcfc" }
        ];
        var hairlines = [];
        full.Kirigami.Theme.inherit = false;
        for (var i = 0; i < palettes.length; i++) {
            full.Kirigami.Theme.backgroundColor = palettes[i].background;
            full.Kirigami.Theme.textColor = palettes[i].text;
            verify(!Qt.colorEqual(full.hairlineColor, palettes[i].background));
            verify(!Qt.colorEqual(full.hairlineColor, palettes[i].text));
            verify(!Qt.colorEqual(full.trackColor, palettes[i].background));
            compare(full.labelTextColor(""), full.Kirigami.Theme.textColor);
            hairlines.push(full.hairlineColor.toString());
        }
        verify(hairlines[0] !== hairlines[1]);
    }

    // All supported providers render with a capitalized display name in the
    // full-view tab bar, after the All tab.
    function test_providerDisplayNameCapitalizesAllProviders() {
        compare(full.providerDisplayName("claude"), "Claude");
        compare(full.providerDisplayName("codex"), "Codex");
        compare(full.providerDisplayName("grok"), "Grok");
        compare(full.providerDisplayName("kimi"), "Kimi");
        compare(full.providerDisplayName("cursor"), "Cursor");
        compare(full.providerDisplayName("opencode"), "OpenCode");
        compare(full.providerDisplayName("commandcode"), "CommandCode");
    }

    function test_tabButtonsUseCapitalizedDisplayNames() {
        full.providerOrder = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"];
        full.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            Fixtures.validCodexProvider(),
            Fixtures.validGrokProvider(),
            Fixtures.validKimiProvider(),
            Fixtures.validCursorProvider(),
            Fixtures.validOpencodeProvider(),
            Fixtures.validCommandCodeProvider()
        ]);
        var tabBar = full.providerSwitcherItem;
        verify(tabBar !== null);
        var labels = [];
        for (var i = 0; i < tabBar.count; i++) {
            labels.push(tabBar.itemAt(i).text);
        }
        compare(labels, ["All", "Claude", "Codex", "Grok", "Kimi", "Cursor", "OpenCode", "CommandCode"]);
    }
}
