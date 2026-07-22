import QtQuick
import QtTest
import org.kde.kirigami 2.20 as Kirigami

import "../../plasmoid/contents/ui/compact-model.js" as CompactModel
import "helpers/collector-fixtures.js" as Fixtures

TestCase {
    id: testCase
    name: "CompactRepresentation"
    when: windowShown
    // TestCase's own `visible` defaults to false; QQuickItem::isVisible() returns
    // *effective* (ancestor-combined) visibility, so without this every descendant
    // reads visible=false regardless of its own binding. Needed because this file
    // is the first to assert on a rendered item's `.visible` property.
    visible: true

    property var compactLoader: null
    property var compact: null
    property var expandSpy: null

    function sampleSnapshot(providers) {
        return Fixtures.minimalDocument({ providers: providers });
    }

    Component {
        id: compactComponent
        Loader {
            source: "../../plasmoid/contents/ui/CompactRepresentation.qml"
        }
    }

    function createCompact(overrides) {
        var loader = compactComponent.createObject(testCase, overrides || {});
        tryCompare(loader, "status", Loader.Ready);
        return loader.item;
    }

    function init() {
        compactLoader = compactComponent.createObject(testCase, { width: 320, height: 32 });
        tryCompare(compactLoader, "status", Loader.Ready);
        compact = compactLoader.item;
        expandSpy = Qt.createQmlObject(
            'import QtTest; SignalSpy { }',
            testCase,
            "expandSpy"
        );
        expandSpy.target = compact;
        expandSpy.signalName = "requestExpand";
    }

    function cleanup() {
        if (compactLoader !== null) {
            compactLoader.destroy();
            compactLoader = null;
            compact = null;
        }
        if (expandSpy !== null) {
            expandSpy.destroy();
            expandSpy = null;
        }
    }

    function test_undefinedSnapshotShowsNeutralPlaceholder() {
        compact.snapshot = null;
        compare(compact.hasEntries, false);
        verify(compact.Accessible.name.indexOf("no data") !== -1);
    }

    function test_emptyProviderListShowsPlaceholder() {
        compact.snapshot = sampleSnapshot([]);
        compare(compact.hasEntries, false);
    }

    // Issue 2 (2026-07-22): "icons" mode hides the provider LABEL (caption)
    // but keeps the VALUE (percentage/count) visible — a product reversal of
    // the prior V1 "icons hides everything" semantics. See AGENTS.md Lessons
    // (2026-07-22, icons-mode semantic change).
    function test_iconsOnlyModeHidesLabelButKeepsValue() {
        compact.compactDisplayMode = "icons";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compare(compact.showIcons, true);
        compare(compact.showLabel, false);
        compare(compact.showValue, true);
        compare(compact.entries.length, 1);
    }

    function test_textOnlyModeHidesIconsButKeepsValue() {
        compact.compactDisplayMode = "text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compare(compact.showIcons, false);
        compare(compact.showLabel, true);
        compare(compact.showValue, true);
    }

    function test_iconsPlusTextModeShowsBoth() {
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compare(compact.showIcons, true);
        compare(compact.showLabel, true);
        compare(compact.showValue, true);
    }

    function test_implicitWidthPositiveAndGrowsWithMoreProviders() {
        compact.width = 480;
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        tryVerify(function () { return compact.implicitWidth > 0; });
        var widthOne = compact.implicitWidth;

        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] }),
            Fixtures.validUmansProvider({ windows: [Fixtures.validWindow({ usedPercent: 20 })] }),
            Fixtures.validCodexProvider({ windows: [Fixtures.validWindow({ usedPercent: 30 })] })
        ]);
        tryVerify(function () { return compact.implicitWidth > widthOne; });
        verify(compact.entries.length === 3);
    }

    function test_wideLayoutKeepsIconsPlusTextMode() {
        compact.width = 320;
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 5 })] })
        ]);
        compare(compact.effectiveDisplayMode, "icons+text");
        compare(compact.showIcons, true);
        compare(compact.showLabel, true);
        compare(compact.showValue, true);
    }

    function test_thresholdColorMappingIsDistinct() {
        var critical = compact.valueTextColor("critical");
        var caution = compact.valueTextColor("caution");
        var none = compact.valueTextColor("none");
        verify(critical !== caution);
        verify(caution !== none);
        verify(critical !== none);
    }

    function test_providerStatesUseConciseIndicators() {
        var auth = compact.stateIndicator({ state: "auth-needed" });
        compare(auth.show, true);
        verify(auth.label.length > 0);
        verify(auth.label.toLowerCase().indexOf("login") !== -1);

        var err = compact.stateIndicator({ state: "error" });
        compare(err.show, true);
        compare(err.label, "Error");

        var stale = compact.stateIndicator({ state: "stale" });
        compare(stale.show, true);
        compare(stale.label, "Stale");

        var ok = compact.stateIndicator({ state: "ok" });
        compare(ok.show, false);
    }

    function test_visibilityConfigHonoredInEntries() {
        compact.displayConfig = CompactModel.createDefaultDisplayConfig();
        compact.displayConfig.visibility.umans = false;
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider(),
            { id: "umans", state: "ok", windows: [Fixtures.validWindow({ used: 1, limit: undefined, usedPercent: undefined })] },
            Fixtures.validCodexProvider({ id: "codex", state: "ok", windows: [Fixtures.validWindow({ usedPercent: 1 })] })
        ]);
        compare(compact.entries.length, 2);
        verify(compact.entries[0].providerId === "claude" || compact.entries[1].providerId === "claude");
        for (var i = 0; i < compact.entries.length; i++) {
            verify(compact.entries[i].providerId !== "umans");
        }
    }

    function test_narrowWidthStillHonorsChosenModeNoBindingLoop() {
        compact.width = 96;
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 5 })] })
        ]);
        compare(compact.effectiveDisplayMode, "icons+text");
        compare(compact.showIcons, true);
        compare(compact.showLabel, true);
        compare(compact.showValue, true);
    }

    function test_narrowWidthExplicitIconsModeHidesLabelButKeepsValue() {
        compact.width = 96;
        compact.compactDisplayMode = "icons";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 5 })] })
        ]);
        compare(compact.effectiveDisplayMode, "icons");
        compare(compact.showIcons, true);
        compare(compact.showLabel, false);
        compare(compact.showValue, true);
    }

    function test_pointerActivationEmitsRequestExpand() {
        compact.requestExpand();
        compare(expandSpy.count, 1);
    }

    function test_keyboardReturnEmitsRequestExpand() {
        expandSpy.clear();
        compact.forceActiveFocus();
        keyClick(Qt.Key_Return);
        compare(expandSpy.count, 1);
    }

    function test_keyboardSpaceEmitsRequestExpand() {
        expandSpy.clear();
        compact.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(expandSpy.count, 1);
    }

    function test_accessibleNamePresentWithData() {
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 12 })] })
        ]);
        verify(compact.Accessible.name.length > 0);
        verify(compact.Accessible.name.indexOf("providers") !== -1);
    }

    function test_renderedSurfaceContainsNoSecretPatterns() {
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                status: "Usage is current",
                windows: [Fixtures.validWindow({ usedPercent: 50 })]
            })
        ]);
        var blob = JSON.stringify(compact.entries) + compact.Accessible.name;
        var forbidden = ["Bearer", "sk-", "accountId", "refresh_token", "api_key", "authorization"];
        for (var i = 0; i < forbidden.length; i++) {
            verify(blob.toLowerCase().indexOf(forbidden[i].toLowerCase()) === -1);
        }
    }

    function findByObjectName(item, objectName) {
        for (var i = 0; i < item.children.length; i++) {
            if (item.children[i].objectName === objectName) {
                return item.children[i];
            }
        }
        return null;
    }

    function twoProviderSnapshot() {
        return sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] }),
            Fixtures.validUmansProvider({ windows: [Fixtures.validWindow({ used: 3, limit: undefined, usedPercent: undefined })] })
        ]);
    }

    function test_separatorRendersBetweenEntriesWithConfiguredGlyph() {
        compact.compactDisplayMode = "icons+text";
        compact.separator = " | ";
        compact.snapshot = twoProviderSnapshot();
        compare(compact.entries.length, 2);

        var firstEntry = compact.entryRepeaterItem.itemAt(0);
        var secondEntry = compact.entryRepeaterItem.itemAt(1);
        var firstSeparator = findByObjectName(firstEntry, "separatorLabel");
        var secondSeparator = findByObjectName(secondEntry, "separatorLabel");

        verify(firstSeparator !== null);
        compare(firstSeparator.visible, false);
        verify(secondSeparator !== null);
        compare(secondSeparator.visible, true);
        compare(secondSeparator.text, " | ");
    }

    function test_emptySeparatorRendersNoVisibleSeparator() {
        compact.compactDisplayMode = "icons+text";
        compact.separator = "";
        compact.snapshot = twoProviderSnapshot();

        var secondEntry = compact.entryRepeaterItem.itemAt(1);
        var secondSeparator = findByObjectName(secondEntry, "separatorLabel");
        verify(secondSeparator !== null);
        compare(secondSeparator.visible, false);
    }

    function test_fontScaleMultipliesEffectivePointSize() {
        compact.fontScale = 1.0;
        var baseline = compact.fontPointSize;
        compact.fontScale = 1.5;
        compare(compact.fontPointSize, baseline * 1.5);
    }

    function test_defaultFontScaleIsUnitMultiplier() {
        compare(compact.fontScale, 1.0);
    }

    // M-T4 wiring: appearance object set on the representation reaches the
    // compact model and shapes the emitted entries (field computation itself
    // is unit-tested in tst_compact_model).
    function test_appearanceFlowsIntoEntries() {
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compact.appearance = {
            claudeAccentColor: "#d97757",
            claudeCustomIcon: "face-cool",
            labelOpacity: 0.5,
            separatorOpacity: 0.25
        };
        verify(compact.entries.length === 1);
        compare(compact.entries[0].valueColor, "#d97757");
        compare(compact.entries[0].iconName, "face-cool");
        compare(compact.entries[0].labelOpacity, 0.5);
        compare(compact.entries[0].separatorOpacity, 0.25);
    }

    function test_localIconPathRendersFullColorFileUrl() {
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compact.appearance = {
            claudeCustomIcon: "/home/user/Pictures/Icons/kuota/claude.png"
        };
        verify(compact.entries.length === 1);
        compare(compact.entries[0].iconName, "/home/user/Pictures/Icons/kuota/claude.png");
        compare(
            compact.iconSourceFor(compact.entries[0]),
            "file:///home/user/Pictures/Icons/kuota/claude.png"
        );
        compare(compact.iconIsMask(compact.entries[0]), false);

        compact.appearance = { claudeCustomIcon: "face-cool" };
        compare(compact.iconSourceFor(compact.entries[0]), "face-cool");
        compare(compact.iconIsMask(compact.entries[0]), true);
    }

    function test_nullAppearanceReproducesV1Defaults() {
        compact.appearance = null;
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        verify(compact.entries.length === 1);
        compare(compact.entries[0].valueColor, "");
        compare(compact.entries[0].textColor, "");
        compare(compact.entries[0].iconName, "");
        compare(compact.entries[0].labelOpacity, 1.0);
        compare(compact.entries[0].separatorOpacity, 1.0);
    }

    function test_fontFamilyOverrideAndDefault() {
        compact.fontFamily = "";
        compare(compact.effectiveFontFamily, Kirigami.Theme.defaultFont.family);
        compact.fontFamily = "Noto Mono";
        compare(compact.effectiveFontFamily, "Noto Mono");
    }

    // Issue 1 (2026-07-22): iconSize tracks the live font point size so custom
    // PNG/SVG icons no longer dwarf the surrounding text. The clamp at
    // Kirigami.Units.iconSizes.small prevents sub-pixel icons at very small
    // fontScale, and the 1.3x multiplier roughly matches heading cap-height.
    function test_iconSizeTracksFontPointSize() {
        compact.fontScale = 1.0;
        var baseline = compact.iconSize;
        verify(baseline >= Kirigami.Units.iconSizes.small);
        compact.fontScale = 1.5;
        compare(compact.iconSize, Math.max(Kirigami.Units.iconSizes.small, Math.round(compact.fontPointSize * 1.3)));
    }

    function test_providerIconWidthMatchesIconSize() {
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        var entry = compact.entryRepeaterItem.itemAt(0);
        var providerIcon = findByObjectName(entry, "providerIcon");
        verify(providerIcon !== null);
        compare(providerIcon.width, compact.iconSize);
        compare(providerIcon.height, compact.iconSize);
    }

    function test_stateIconWidthMatchesIconSize() {
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                state: "auth-needed",
                windows: [Fixtures.validWindow({ usedPercent: 10 })]
            })
        ]);
        var entry = compact.entryRepeaterItem.itemAt(0);
        var stateIcon = findByObjectName(entry, "stateIcon");
        verify(stateIcon !== null);
        verify(stateIcon.visible);
        compare(stateIcon.width, compact.iconSize);
    }

    // Issue 3 (2026-07-22): per-gap spacing between icon → label and
    // label → value is independently settable and consumed by explicit Item
    // spacers in the delegate (Row.spacing alone can't express two values).
    function test_perGapSpacingDefaultsReproduceV1Look() {
        compare(compact.iconLabelSpacing, 2);
        compare(compact.labelValueSpacing, 1);
    }

    function test_perGapSpacingIsSettableAndConsumed() {
        compact.compactDisplayMode = "icons+text";
        compact.iconLabelSpacing = 7;
        compact.labelValueSpacing = 4;
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        var entry = compact.entryRepeaterItem.itemAt(0);
        var iconLabelSpacer = findByObjectName(entry, "iconLabelSpacer");
        var labelValueSpacer = findByObjectName(entry, "labelValueSpacer");
        verify(iconLabelSpacer !== null);
        verify(labelValueSpacer !== null);
        compare(iconLabelSpacer.width, 7);
        compare(labelValueSpacer.width, 4);
    }

    // Per-gap spacer visibility tracks the icon AND the next visible heading, so
    // a hidden icon does not leave a phantom gap, and in icons-only mode the
    // icon → percentage gap uses iconLabelSpacing (the label is hidden but the
    // value is still rendered after the icon). Regression test for the
    // post-feedback tightening of the visibility rule — the earlier rule
    // collapsed this spacer when showLabel was false, which left icons-only
    // mode with no gap between icon and percentage.
    function test_iconLabelSpacerStaysVisibleInIconsOnlyMode() {
        compact.compactDisplayMode = "icons";
        compact.iconLabelSpacing = 9;
        compact.labelValueSpacing = 5;
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        var entry = compact.entryRepeaterItem.itemAt(0);
        var iconLabelSpacer = findByObjectName(entry, "iconLabelSpacer");
        var labelValueSpacer = findByObjectName(entry, "labelValueSpacer");
        verify(iconLabelSpacer !== null);
        verify(labelValueSpacer !== null);
        // icons mode: showIcons=true, showLabel=false, showValue=true.
        // iconLabelSpacer stays visible — it spaces icon → value.
        compare(iconLabelSpacer.visible, true);
        compare(iconLabelSpacer.width, 9);
        // labelValueSpacer stays hidden — label is hidden so nothing to space from.
        compare(labelValueSpacer.visible, false);
    }

    // Edge case: in icons-only mode with an empty displayValue, the iconLabelSpacer
    // collapses (no visible icon → value transition to space). Status must also
    // be cleared so stateOnlyDisplayValue does not produce a fallback string.
    function test_iconLabelSpacerHidesWhenValueIsEmptyInIconsOnlyMode() {
        compact.compactDisplayMode = "icons";
        compact.iconLabelSpacing = 6;
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({
                status: "",
                windows: [Fixtures.validWindow({ used: undefined, usedPercent: undefined })]
            })
        ]);
        var entry = compact.entryRepeaterItem.itemAt(0);
        var iconLabelSpacer = findByObjectName(entry, "iconLabelSpacer");
        verify(iconLabelSpacer !== null);
        compare(iconLabelSpacer.visible, false);
    }

    // text mode: no icon → iconLabelSpacer hidden; label → value still spaced.
    function test_iconLabelSpacerHiddenInTextOnlyMode() {
        compact.compactDisplayMode = "text";
        compact.iconLabelSpacing = 6;
        compact.labelValueSpacing = 4;
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        var entry = compact.entryRepeaterItem.itemAt(0);
        var iconLabelSpacer = findByObjectName(entry, "iconLabelSpacer");
        var labelValueSpacer = findByObjectName(entry, "labelValueSpacer");
        compare(iconLabelSpacer.visible, false);
        compare(labelValueSpacer.visible, true);
        compare(labelValueSpacer.width, 4);
    }

    function test_perGapSpacersVisibleInIconsPlusTextMode() {
        compact.compactDisplayMode = "icons+text";
        compact.iconLabelSpacing = 3;
        compact.labelValueSpacing = 2;
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        var entry = compact.entryRepeaterItem.itemAt(0);
        var iconLabelSpacer = findByObjectName(entry, "iconLabelSpacer");
        var labelValueSpacer = findByObjectName(entry, "labelValueSpacer");
        compare(iconLabelSpacer.visible, true);
        compare(iconLabelSpacer.width, 3);
        compare(labelValueSpacer.visible, true);
        compare(labelValueSpacer.width, 2);
    }
}