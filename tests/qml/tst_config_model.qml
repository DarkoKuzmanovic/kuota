import QtQuick
import QtTest

import "../../plasmoid/contents/ui/config-model.js" as ConfigModel

TestCase {
    name: "ConfigModel"

    function test_collectionMembershipUsesSanitizedVisibilityNotDisplayOrder() {
        var settings = ConfigModel.sanitize({
            providerOrder: ["commandcode", "claude"],
            claudeVisible: true, codexVisible: false, grokVisible: false,
            kimiVisible: false, cursorVisible: false, opencodeVisible: false,
            commandcodeVisible: true
        });
        compare(ConfigModel.enabledProviders(settings), ["claude", "commandcode"]);
        compare(ConfigModel.assembleDisplayConfig(settings).order, ["commandcode", "claude"]);
        settings.claudeVisible = false;
        settings.commandcodeVisible = false;
        compare(ConfigModel.enabledProviders(settings), []);
        var garbage = ConfigModel.sanitize({ claudeVisible: "false", providerOrder: ["synthetic-unknown"] });
        compare(ConfigModel.enabledProviders(garbage), ConfigModel.KNOWN_PROVIDERS);
        compare(ConfigModel.enabledProviders(ConfigModel.sanitize(null)), ConfigModel.KNOWN_PROVIDERS);
    }

    function test_knownProvidersExcludeUmans() {
        compare(ConfigModel.KNOWN_PROVIDERS, ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]);
    }

    function test_sanitizeDropsUmansFromOrder() {
        var settings = ConfigModel.sanitize({
            providerOrder: ["claude", "umans", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"],
            umansVisible: true
        });
        verify(settings.providerOrder.indexOf("umans") === -1);
        compare(settings.providerOrder, ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]);
        verify(!("umansVisible" in settings));
    }

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

    function test_fontScaleClampAndGarbage() {
        var tooBig = ConfigModel.sanitize({ fontScale: 5.0 });
        compare(tooBig.fontScale, 3.0);

        var tooSmall = ConfigModel.sanitize({ fontScale: 0.25 });
        compare(tooSmall.fontScale, 0.5);

        var valid = ConfigModel.sanitize({ fontScale: 2.5 });
        compare(valid.fontScale, 2.5);

        var atMax = ConfigModel.sanitize({ fontScale: 3.0 });
        compare(atMax.fontScale, 3.0);

        var atMin = ConfigModel.sanitize({ fontScale: 0.5 });
        compare(atMin.fontScale, 0.5);

        // 1.0 is no longer the floor (0.5 is); it passes through unchanged.
        var oneZero = ConfigModel.sanitize({ fontScale: 1.0 });
        compare(oneZero.fontScale, 1.0);

        var garbage = ConfigModel.sanitize({ fontScale: "big" });
        compare(garbage.fontScale, 1.0);

        var nanValue = ConfigModel.sanitize({ fontScale: NaN });
        compare(nanValue.fontScale, 1.0);

        var negative = ConfigModel.sanitize({ fontScale: -2.0 });
        compare(negative.fontScale, 1.0);
    }

    function test_invertedThresholdsFallBackToDefaults() {
        var inverted = ConfigModel.sanitize({ cautionThreshold: 90, criticalThreshold: 75 });
        compare(inverted.cautionThreshold, 75);
        compare(inverted.criticalThreshold, 90);

        var equal = ConfigModel.sanitize({ cautionThreshold: 80, criticalThreshold: 80 });
        compare(equal.cautionThreshold, 75);
        compare(equal.criticalThreshold, 90);
    }

    function test_thresholdReadBoundaryStillDefaultsInvalidPair() {
        // Read-boundary sanitize remains the authoritative guard (D6).
        var inverted = ConfigModel.sanitize({ cautionThreshold: 95, criticalThreshold: 90 });
        compare(inverted.cautionThreshold, 75);
        compare(inverted.criticalThreshold, 90);
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
        compare(empty.codexVisible, true);
        compare(empty.grokVisible, true);
        compare(empty.kimiVisible, true);
        compare(empty.cursorVisible, true);
        compare(empty.opencodeVisible, true);
        compare(empty.commandcodeVisible, true);
        compare(empty.claudeWindow, "");
        compare(empty.codexWindow, "");
        compare(JSON.stringify(empty.providerOrder), JSON.stringify(["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]));

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
            codexVisible: undefined,
            claudeWindow: 12,
            codexWindow: false,
            grokVisible: "yes",
            kimiVisible: 7,
            opencodeVisible: "true",
            commandcodeVisible: undefined
        });
        compare(garbage.refreshIntervalMinutes, 5);
        compare(garbage.cautionThreshold, 75);
        compare(garbage.criticalThreshold, 90);
        compare(garbage.displayMode, "icons+text");
        compare(garbage.separator, " · ");
        compare(garbage.fontScale, 1.0);
        compare(garbage.showCountdown, true);
        compare(JSON.stringify(garbage.providerOrder), JSON.stringify(["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]));
        compare(garbage.claudeVisible, true);
        compare(garbage.codexVisible, true);
        compare(garbage.grokVisible, true);
        compare(garbage.kimiVisible, true);
        compare(garbage.cursorVisible, true);
        compare(garbage.opencodeVisible, true);
        compare(garbage.commandcodeVisible, true);
        compare(garbage.claudeWindow, "");
        compare(garbage.codexWindow, "");

        var nullInput = ConfigModel.sanitize(null);
        compare(nullInput.refreshIntervalMinutes, 5);
        compare(JSON.stringify(nullInput.providerOrder), JSON.stringify(["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]));
    }

    function test_displayConfigAssemblyCustomOrderAndVisibility() {
        var sanitized = ConfigModel.sanitize({
            providerOrder: ["codex", "claude", "grok"],
            claudeVisible: true,
            grokVisible: false,
            codexVisible: true
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);

        compare(JSON.stringify(displayConfig.order), JSON.stringify(["codex", "claude", "kimi", "cursor", "opencode", "commandcode"]));
        compare(displayConfig.visibility.claude, true);
        compare(displayConfig.visibility.codex, true);
        compare(displayConfig.visibility.grok, false);
        compare(displayConfig.visibility.kimi, true);
        compare(displayConfig.visibility.cursor, true);
        compare(displayConfig.visibility.opencode, true);
        compare(displayConfig.visibility.commandcode, true);
        verify(isRecord(displayConfig.metric));
        verify(isRecord(displayConfig.window));
    }

    function test_displayConfigAssemblyAllVisible() {
        var sanitized = ConfigModel.sanitize({
            providerOrder: ["grok", "codex", "claude"],
            claudeVisible: true,
            codexVisible: true
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);
        compare(JSON.stringify(displayConfig.order), JSON.stringify(["grok", "codex", "claude", "kimi", "cursor", "opencode", "commandcode"]));
        compare(displayConfig.visibility.claude, true);
        compare(displayConfig.visibility.codex, true);
        compare(displayConfig.visibility.grok, true);
        compare(displayConfig.visibility.kimi, true);
        compare(displayConfig.visibility.cursor, true);
        compare(displayConfig.visibility.opencode, true);
        compare(displayConfig.visibility.commandcode, true);
    }

    function test_displayConfigAllHiddenYieldsEmptyOrder() {
        var sanitized = ConfigModel.sanitize({
            claudeVisible: false,
            codexVisible: false,
            grokVisible: false,
            kimiVisible: false,
            cursorVisible: false,
            opencodeVisible: false,
            commandcodeVisible: false
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);
        compare(displayConfig.order.length, 0);
        compare(displayConfig.visibility.claude, false);
        compare(displayConfig.visibility.codex, false);
        compare(displayConfig.visibility.grok, false);
        compare(displayConfig.visibility.kimi, false);
        compare(displayConfig.visibility.cursor, false);
        compare(displayConfig.visibility.opencode, false);
        compare(displayConfig.visibility.commandcode, false);
    }

    function test_displayConfigIncludesSelectedWindows() {
        var sanitized = ConfigModel.sanitize({
            claudeWindow: "weekly-all",
            codexWindow: "secondary"
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);
        compare(displayConfig.window.claude, "weekly-all");
        compare(displayConfig.window.codex, "secondary");
        verify(!Object.prototype.hasOwnProperty.call(displayConfig.window, "grok"));
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

    function test_resolveWindowUnknownProviderIsUndefined() {
        var sanitized = ConfigModel.sanitize({ claudeWindow: "session", codexWindow: "primary" });
        compare(ConfigModel.resolveWindow("unknown", sanitized, ["session"]), undefined);
        // Selected id outside static known catalog → undefined even if present in available.
        var bogus = ConfigModel.sanitize({ claudeWindow: "not-a-window" });
        compare(ConfigModel.resolveWindow("claude", bogus, ["not-a-window"]), undefined);
    }

    // --- Per-provider window selectors for all multi-window providers ---
    // Spec: docs/specs/2026-09-05-window-selector-all-providers-design.md

    function test_allWindowSelectionsDefaultToEmpty() {
        var empty = ConfigModel.sanitize({});
        compare(empty.claudeWindow, "");
        compare(empty.codexWindow, "");
        compare(empty.grokWindow, "");
        compare(empty.kimiWindow, "");
        compare(empty.opencodeWindow, "");
        compare(empty.commandcodeWindow, "");
        // Cursor exposes exactly one window ("plan") — no selector, no key
        // (dead-control gate; D4 single-window precedent).
        verify(!("cursorWindow" in empty));
    }

    function test_windowSelectionGarbageFallsBackToEmpty() {
        var garbage = ConfigModel.sanitize({
            grokWindow: 12,
            kimiWindow: false,
            opencodeWindow: null,
            commandcodeWindow: "monthly"
        });
        compare(garbage.grokWindow, "");
        compare(garbage.kimiWindow, "");
        compare(garbage.opencodeWindow, "");
        // "monthly" is not a CommandCode window (credits API has no monthly
        // usage window) → catalog rejection, same as wrong-type values.
        compare(garbage.commandcodeWindow, "");
    }

    function test_windowSelectionCatalogMembership() {
        var valid = ConfigModel.sanitize({
            grokWindow: "month",
            kimiWindow: "daily",
            opencodeWindow: "monthly",
            commandcodeWindow: "weekly"
        });
        compare(valid.grokWindow, "month");
        compare(valid.kimiWindow, "daily");
        compare(valid.opencodeWindow, "monthly");
        compare(valid.commandcodeWindow, "weekly");

        // Each provider accepts only its own catalog.
        var crossed = ConfigModel.sanitize({
            grokWindow: "primary",
            kimiWindow: "monthX",
            opencodeWindow: "fiveHour",
            commandcodeWindow: "rolling"
        });
        compare(crossed.grokWindow, "");
        compare(crossed.kimiWindow, "");
        compare(crossed.opencodeWindow, "");
        compare(crossed.commandcodeWindow, "");

        // Kimi short window id is duration-derived; the catalog carries all
        // stable ids the adapter can emit.
        var kimiIds = ["week", "5h", "daily", "month"];
        for (var i = 0; i < kimiIds.length; i++) {
            var picked = ConfigModel.sanitize({ kimiWindow: kimiIds[i] });
            compare(picked.kimiWindow, kimiIds[i]);
        }
    }

    function test_displayConfigWindowMapCoversAllSelectableProviders() {
        var sanitized = ConfigModel.sanitize({
            grokWindow: "week",
            kimiWindow: "5h",
            opencodeWindow: "monthly",
            commandcodeWindow: "fiveHour"
        });
        var displayConfig = ConfigModel.assembleDisplayConfig(sanitized);
        compare(displayConfig.window.grok, "week");
        compare(displayConfig.window.kimi, "5h");
        compare(displayConfig.window.opencode, "monthly");
        compare(displayConfig.window.commandcode, "fiveHour");
        // Empty selections stay out of the map (primary-window default).
        verify(!Object.prototype.hasOwnProperty.call(displayConfig.window, "claude"));
        verify(!Object.prototype.hasOwnProperty.call(displayConfig.window, "cursor"));
    }

    function test_resolveWindowHonorsNewProviderCatalogs() {
        var grok = ConfigModel.sanitize({ grokWindow: "month" });
        compare(ConfigModel.resolveWindow("grok", grok, ["week", "month"]), "month");

        var kimi = ConfigModel.sanitize({ kimiWindow: "daily" });
        compare(ConfigModel.resolveWindow("kimi", kimi, ["week", "daily"]), "daily");
        // Selected id absent from the live snapshot → primary-window fallback.
        compare(ConfigModel.resolveWindow("kimi", kimi, ["week", "5h"]), undefined);

        var opencode = ConfigModel.sanitize({ opencodeWindow: "weekly" });
        compare(ConfigModel.resolveWindow("opencode", opencode, ["rolling", "weekly", "monthly"]), "weekly");

        var commandcode = ConfigModel.sanitize({ commandcodeWindow: "weekly" });
        compare(ConfigModel.resolveWindow("commandcode", commandcode, ["fiveHour", "weekly"]), "weekly");
        // Weekly is optional live (not every account reports it) — absent → primary fallback.
        compare(ConfigModel.resolveWindow("commandcode", commandcode, ["fiveHour"]), undefined);

        // Cursor has no selector: a hand-injected key must not resolve.
        var cursor = ConfigModel.sanitize({ cursorWindow: "plan" });
        compare(ConfigModel.resolveWindow("cursor", cursor, ["plan"]), undefined);
    }

    function test_knownWindowsKeysMatchSelectableProviderKeys() {
        // Every KNOWN_WINDOWS entry maps to exactly one <id>Window key and to
        // a selectable provider; Cursor deliberately has no entry.
        var selectable = ["claude", "codex", "grok", "kimi", "opencode", "commandcode"];
        selectable.sort();
        var listed = [];
        for (var id in ConfigModel.KNOWN_WINDOWS) {
            if (Object.prototype.hasOwnProperty.call(ConfigModel.KNOWN_WINDOWS, id)) {
                listed.push(id);
                // Each catalog provider owns a <id>Window default in DEFAULTS.
                verify(Object.prototype.hasOwnProperty.call(ConfigModel.DEFAULTS, id + "Window"), id);
            }
        }
        listed.sort();
        compare(listed, selectable);
        verify(ConfigModel.KNOWN_WINDOWS.cursor === undefined);
    }

    function test_providerOrderFiltersUnknownIds() {
        var sanitized = ConfigModel.sanitize({
            providerOrder: ["claude", "bogus", "codex", "claude", "codex"]
        });
        // sanitize keeps a clean unique order of known providers only,
        // appending every remaining known provider in canonical order.
        compare(JSON.stringify(sanitized.providerOrder), JSON.stringify(["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]));
    }

    // ---- M-T1 theming schema ----

    function test_themingDefaultsReproduceV1() {
        var empty = ConfigModel.sanitize({});
        compare(empty.fontFamily, "");
        compare(empty.customTextColorEnabled, false);
        compare(empty.customTextColor, "");
        compare(empty.labelOpacity, 1.0);
        compare(empty.separatorOpacity, 1.0);
        var providers = ["claude", "codex", "grok", "kimi", "cursor"];
        for (var i = 0; i < providers.length; i++) {
            compare(empty[providers[i] + "AccentColor"], "");
            compare(empty[providers[i] + "CustomIcon"], "");
        }

        var nullInput = ConfigModel.sanitize(null);
        compare(nullInput.fontFamily, "");
        compare(nullInput.labelOpacity, 1.0);
        compare(nullInput.separatorOpacity, 1.0);
    }

    function test_opacityClampingBoundariesAndGarbage() {
        var low = ConfigModel.sanitize({ labelOpacity: -0.5, separatorOpacity: -1 });
        compare(low.labelOpacity, 0.0);
        compare(low.separatorOpacity, 0.0);

        var high = ConfigModel.sanitize({ labelOpacity: 1.5, separatorOpacity: 99 });
        compare(high.labelOpacity, 1.0);
        compare(high.separatorOpacity, 1.0);

        var mid = ConfigModel.sanitize({ labelOpacity: 0.25, separatorOpacity: 0 });
        compare(mid.labelOpacity, 0.25);
        compare(mid.separatorOpacity, 0.0);

        var garbage = ConfigModel.sanitize({ labelOpacity: "high", separatorOpacity: null });
        compare(garbage.labelOpacity, 1.0);
        compare(garbage.separatorOpacity, 1.0);
    }

    function test_colorStringValidation() {
        var valid = ConfigModel.sanitize({
            customTextColor: "#ff0000",
            claudeAccentColor: "#abc",
            codexAccentColor: "#a1b2c3",
            grokAccentColor: "#a1b2c3d4",
            kimiAccentColor: "red"
        });
        compare(valid.customTextColor, "#ff0000");
        compare(valid.claudeAccentColor, "#abc");
        compare(valid.codexAccentColor, "#a1b2c3");
        compare(valid.grokAccentColor, "#a1b2c3d4");
        compare(valid.kimiAccentColor, "red");

        var garbage = ConfigModel.sanitize({
            customTextColor: "not a color!",
            claudeAccentColor: "#12",
            codexAccentColor: 42,
            grokAccentColor: "#xyzxyz",
            kimiAccentColor: "has space"
        });
        compare(garbage.customTextColor, "");
        compare(garbage.claudeAccentColor, "");
        compare(garbage.codexAccentColor, "");
        compare(garbage.grokAccentColor, "");
        compare(garbage.kimiAccentColor, "");
    }

    function test_customTextColorEnabledSanitizesBool() {
        compare(ConfigModel.sanitize({ customTextColorEnabled: true }).customTextColorEnabled, true);
        compare(ConfigModel.sanitize({ customTextColorEnabled: "yes" }).customTextColorEnabled, false);
        compare(ConfigModel.sanitize({ customTextColorEnabled: 1 }).customTextColorEnabled, false);
    }

    function test_iconNameValidation() {
        var valid = ConfigModel.sanitize({
            claudeCustomIcon: "network-server",
            codexCustomIcon: "emblem-favorite",
            grokCustomIcon: "x.icon_2",
            kimiCustomIcon: ""
        });
        compare(valid.claudeCustomIcon, "network-server");
        compare(valid.codexCustomIcon, "emblem-favorite");
        compare(valid.grokCustomIcon, "x.icon_2");
        compare(valid.kimiCustomIcon, "");

        // Absolute local image paths from IconDialog "Other icons" must survive
        // sanitize — otherwise custom PNG/SVG selections fall back to defaults.
        var paths = ConfigModel.sanitize({
            claudeCustomIcon: "/home/user/Pictures/Icons/kuota/claude.png",
            codexCustomIcon: "file:///home/user/icons/codex.webp",
            grokCustomIcon: "/tmp/logo.JPEG",
            kimiCustomIcon: "/opt/icons/kimi.ico"
        });
        compare(paths.claudeCustomIcon, "/home/user/Pictures/Icons/kuota/claude.png");
        compare(paths.codexCustomIcon, "/home/user/icons/codex.webp");
        compare(paths.grokCustomIcon, "/tmp/logo.JPEG");
        compare(paths.kimiCustomIcon, "/opt/icons/kimi.ico");

        var garbage = ConfigModel.sanitize({
            claudeCustomIcon: "../escape",
            codexCustomIcon: "slash/name",
            grokCustomIcon: 7,
            kimiCustomIcon: "-leading-dash"
        });
        compare(garbage.claudeCustomIcon, "");
        compare(garbage.codexCustomIcon, "");
        compare(garbage.grokCustomIcon, "");
        compare(garbage.kimiCustomIcon, "");

        // Path-shaped garbage: relative, traversal, non-image extension.
        var badPaths = ConfigModel.sanitize({
            claudeCustomIcon: "relative/path.png",
            codexCustomIcon: "/tmp/not-an-image.txt",
            grokCustomIcon: "/tmp/noext",
            kimiCustomIcon: "file://localhost/tmp/evil.exe"
        });
        compare(badPaths.claudeCustomIcon, "");
        compare(badPaths.codexCustomIcon, "");
        compare(badPaths.grokCustomIcon, "");
        compare(badPaths.kimiCustomIcon, "");

        // URL-significant characters in the accepted path. The path is later
        // embedded in a `file://` URL that Qt percent-decodes at load time, so
        // `%2e%2e` resolves to `..` and bypasses pathHasDotDot. `%`, `#`, `?`
        // break URL parsing even for literal filenames. Reject at sanitize so
        // a bare `/tmp/x%23y.png` (which would still pass the literal-path
        // checks) is normalised to "" before reaching iconSourceFor.
        var encoded = ConfigModel.sanitize({
            claudeCustomIcon: "/tmp/icons/%2e%2e/private/logo.png",
            codexCustomIcon: "/tmp/logo%00.png",
            grokCustomIcon: "/tmp/has%23hash.png",
            kimiCustomIcon: "/tmp/has%3Fquestion.png"
        });
        compare(encoded.claudeCustomIcon, "");
        compare(encoded.codexCustomIcon, "");
        compare(encoded.grokCustomIcon, "");
        compare(encoded.kimiCustomIcon, "");

        // Bare `#` and `?` in the value (after file:// strip) must also be
        // rejected — the sanitizer treats them as URL-significant in any
        // position, not only after decoding.
        var urlSigns = ConfigModel.sanitize({
            claudeCustomIcon: "/tmp/icons/hash#fragment.png",
            codexCustomIcon: "/tmp/icons/query?param.png"
        });
        compare(urlSigns.claudeCustomIcon, "");
        compare(urlSigns.codexCustomIcon, "");
    }

    function test_fontFamilyFreeStringWithGarbageFallback() {
        compare(ConfigModel.sanitize({ fontFamily: "Inter" }).fontFamily, "Inter");
        compare(ConfigModel.sanitize({ fontFamily: "Noto Sans Mono" }).fontFamily, "Noto Sans Mono");
        compare(ConfigModel.sanitize({ fontFamily: "" }).fontFamily, "");
        compare(ConfigModel.sanitize({ fontFamily: 12 }).fontFamily, "");
        compare(ConfigModel.sanitize({ fontFamily: null }).fontFamily, "");
    }

    // ---- M13 compact layout spacing (issue 3) ----

    function test_spacingDefaultsReproduceV1Look() {
        // Empty input must yield the V1 smallSpacing/2 look (iconLabelSpacing=2,
        // labelValueSpacing=1). Sanitize is the authoritative guard; createDefaultSettings
        // is its fallback for missing/garbage keys.
        var empty = ConfigModel.sanitize({});
        compare(empty.iconLabelSpacing, 2);
        compare(empty.labelValueSpacing, 1);

        var defaults = ConfigModel.createDefaultSettings();
        compare(defaults.iconLabelSpacing, 2);
        compare(defaults.labelValueSpacing, 1);
    }

    function test_spacingClampsAndFloatsIntegers() {
        var low = ConfigModel.sanitize({ iconLabelSpacing: -5, labelValueSpacing: -100 });
        compare(low.iconLabelSpacing, 0);
        compare(low.labelValueSpacing, 0);

        var high = ConfigModel.sanitize({ iconLabelSpacing: 999, labelValueSpacing: 1024 });
        compare(high.iconLabelSpacing, 64);
        compare(high.labelValueSpacing, 64);

        // Fractional values must floor to integer pixels; 3.9 → 3, 0.5 → 0.
        var fraction = ConfigModel.sanitize({ iconLabelSpacing: 3.9, labelValueSpacing: 0.5 });
        compare(fraction.iconLabelSpacing, 3);
        compare(fraction.labelValueSpacing, 0);

        var boundaries = ConfigModel.sanitize({ iconLabelSpacing: 0, labelValueSpacing: 64 });
        compare(boundaries.iconLabelSpacing, 0);
        compare(boundaries.labelValueSpacing, 64);
    }

    function test_spacingGarbageFallsBackToDefaults() {
        // Garbage/missing/wrong-type per-key: each falls back independently to
        // its own DEFAULTS value (not 0). This is the same per-key fallback
        // contract as opacity / color / icon.
        var s1 = ConfigModel.sanitize({ iconLabelSpacing: "5px", labelValueSpacing: undefined });
        compare(s1.iconLabelSpacing, 2);
        compare(s1.labelValueSpacing, 1);

        var s2 = ConfigModel.sanitize({ iconLabelSpacing: null, labelValueSpacing: NaN });
        compare(s2.iconLabelSpacing, 2);
        compare(s2.labelValueSpacing, 1);

        var s3 = ConfigModel.sanitize({ iconLabelSpacing: Infinity, labelValueSpacing: -Infinity });
        compare(s3.iconLabelSpacing, 2);
        compare(s3.labelValueSpacing, 1);

        // A valid number in one key does NOT save the other; each is sanitized
        // independently and a sibling garbage key still falls back to its
        // default. (Regression guard against accidentally sharing state.)
        var s4 = ConfigModel.sanitize({ iconLabelSpacing: 7, labelValueSpacing: "oops" });
        compare(s4.iconLabelSpacing, 7);
        compare(s4.labelValueSpacing, 1);
    }

    function isRecord(input) {
        return typeof input === "object" && input !== null && !Array.isArray(input);
    }
}
