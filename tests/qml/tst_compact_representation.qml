import QtQuick
import QtTest

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

    function test_iconsOnlyModeHidesText() {
        compact.compactDisplayMode = "icons";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compare(compact.showIcons, true);
        compare(compact.showText, false);
        compare(compact.entries.length, 1);
    }

    function test_textOnlyModeHidesIcons() {
        compact.compactDisplayMode = "text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compare(compact.showIcons, false);
        compare(compact.showText, true);
    }

    function test_iconsPlusTextModeShowsBoth() {
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 10 })] })
        ]);
        compare(compact.showIcons, true);
        compare(compact.showText, true);
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
        compare(compact.showText, true);
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

    function test_narrowWidthDegradesToIcons() {
        compact.width = 96;
        compact.compactDisplayMode = "icons+text";
        compact.snapshot = sampleSnapshot([
            Fixtures.validClaudeProvider({ windows: [Fixtures.validWindow({ usedPercent: 5 })] })
        ]);
        compare(compact.effectiveDisplayMode, "icons");
        compare(compact.showIcons, true);
        compare(compact.showText, false);
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
}