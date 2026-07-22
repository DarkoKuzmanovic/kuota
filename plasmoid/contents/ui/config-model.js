.pragma library

// Plasma-independent configuration sanitizer and display-config assembler.
// Owns the read-boundary invariant for plasmoid settings before they reach
// compact/full models. Never imports Plasma executable APIs or touches I/O.

var KNOWN_PROVIDERS = Object.freeze(["claude", "umans", "codex", "grok", "kimi"]);

var DEFAULT_PROVIDER_ORDER = Object.freeze(["claude", "umans", "codex", "grok", "kimi"]);

var DISPLAY_MODES = Object.freeze({
    icons: true,
    text: true,
    "icons+text": true
});

// Static known window IDs per provider (D4). Umans has a single window and
// no selector key — resolveWindow always returns undefined for it.
var KNOWN_WINDOWS = Object.freeze({
    claude: Object.freeze(["session", "weekly-all", "weekly-oauth-apps"]),
    codex: Object.freeze(["primary", "secondary"])
});

// Schema defaults — must stay in lockstep with plasmoid/contents/config/main.xml.
// fontScale is a unit multiplier (1.0 = 100%), not a percent integer.
var DEFAULTS = Object.freeze({
    providerOrder: DEFAULT_PROVIDER_ORDER.slice(),
    claudeVisible: true,
    umansVisible: true,
    codexVisible: true,
    grokVisible: true,
    kimiVisible: true,
    claudeWindow: "",
    codexWindow: "",
    displayMode: "icons+text",
    separator: " · ",
    fontScale: 1.0,
    showCountdown: true,
    refreshIntervalMinutes: 5,
    cautionThreshold: 75,
    criticalThreshold: 90
});

var REFRESH_INTERVAL_FLOOR_MINUTES = 5;
var FONT_SCALE_MIN = 0.5;  // matches configAppearance.qml SpinBox from: 50
var FONT_SCALE_MAX = 3.0;

function createDefaultSettings() {
    return {
        providerOrder: DEFAULTS.providerOrder.slice(),
        claudeVisible: DEFAULTS.claudeVisible,
        umansVisible: DEFAULTS.umansVisible,
        codexVisible: DEFAULTS.codexVisible,
        grokVisible: DEFAULTS.grokVisible,
        kimiVisible: DEFAULTS.kimiVisible,
        claudeWindow: DEFAULTS.claudeWindow,
        codexWindow: DEFAULTS.codexWindow,
        displayMode: DEFAULTS.displayMode,
        separator: DEFAULTS.separator,
        fontScale: DEFAULTS.fontScale,
        showCountdown: DEFAULTS.showCountdown,
        refreshIntervalMinutes: DEFAULTS.refreshIntervalMinutes,
        cautionThreshold: DEFAULTS.cautionThreshold,
        criticalThreshold: DEFAULTS.criticalThreshold
    };
}

/**
 * Read-boundary sanitizer. Accepts a raw config-like object (e.g. values
 * mirrored from plasmoid.configuration) and returns a fully populated
 * settings object with every semantic constraint enforced:
 * - refreshIntervalMinutes ≥ 5 (Claude-safe floor)
 * - thresholds clamped to 0..100 and caution < critical (else 75/90)
 * - garbage/missing/wrong-type → schema defaults
 */
function sanitize(rawConfig) {
    var out = createDefaultSettings();
    if (!isRecord(rawConfig)) {
        return out;
    }

    out.providerOrder = sanitizeProviderOrder(rawConfig.providerOrder);
    out.claudeVisible = sanitizeBool(rawConfig.claudeVisible, DEFAULTS.claudeVisible);
    out.umansVisible = sanitizeBool(rawConfig.umansVisible, DEFAULTS.umansVisible);
    out.codexVisible = sanitizeBool(rawConfig.codexVisible, DEFAULTS.codexVisible);
    out.grokVisible = sanitizeBool(rawConfig.grokVisible, DEFAULTS.grokVisible);
    out.kimiVisible = sanitizeBool(rawConfig.kimiVisible, DEFAULTS.kimiVisible);
    out.claudeWindow = sanitizeWindowSelection("claude", rawConfig.claudeWindow);
    out.codexWindow = sanitizeWindowSelection("codex", rawConfig.codexWindow);
    out.displayMode = sanitizeDisplayMode(rawConfig.displayMode);
    out.separator = sanitizeString(rawConfig.separator, DEFAULTS.separator);
    out.fontScale = sanitizeFontScale(rawConfig.fontScale);
    out.showCountdown = sanitizeBool(rawConfig.showCountdown, DEFAULTS.showCountdown);
    out.refreshIntervalMinutes = sanitizeRefreshInterval(rawConfig.refreshIntervalMinutes);

    var thresholds = sanitizeThresholds(rawConfig.cautionThreshold, rawConfig.criticalThreshold);
    out.cautionThreshold = thresholds.caution;
    out.criticalThreshold = thresholds.critical;

    return out;
}

/**
 * Assemble the displayConfig shape compact-model.js consumes.
 * Hidden providers are omitted from order (empty order when all hidden).
 * Adds a `window` map for selected compact windows (M9.3 will honor it);
 * keeps `metric: {}` for shape compatibility with createDefaultDisplayConfig().
 */
function assembleDisplayConfig(sanitized) {
    var settings = isRecord(sanitized) ? sanitized : createDefaultSettings();
    var visibility = {
        claude: settings.claudeVisible === true,
        umans: settings.umansVisible === true,
        codex: settings.codexVisible === true,
        grok: settings.grokVisible === true,
        kimi: settings.kimiVisible === true
    };

    var orderSource = Array.isArray(settings.providerOrder)
        ? settings.providerOrder
        : DEFAULT_PROVIDER_ORDER.slice();
    var order = [];
    for (var i = 0; i < orderSource.length; i++) {
        var id = orderSource[i];
        if (typeof id !== "string") {
            continue;
        }
        if (KNOWN_PROVIDERS.indexOf(id) === -1) {
            continue;
        }
        if (visibility[id] !== true) {
            continue;
        }
        if (order.indexOf(id) !== -1) {
            continue;
        }
        order.push(id);
    }

    var windowMap = {};
    if (typeof settings.claudeWindow === "string" && settings.claudeWindow.length > 0) {
        windowMap.claude = settings.claudeWindow;
    }
    if (typeof settings.codexWindow === "string" && settings.codexWindow.length > 0) {
        windowMap.codex = settings.codexWindow;
    }

    return {
        order: order,
        visibility: visibility,
        metric: {},
        window: windowMap
    };
}

/**
 * Resolve a per-provider compact window selection.
 * Returns the selected id only when it is in the static known catalog AND
 * present in availableWindowIds; otherwise undefined so the caller applies
 * the Q10 primary-window default.
 */
function resolveWindow(providerId, sanitized, availableWindowIds) {
    if (typeof providerId !== "string") {
        return undefined;
    }
    var known = KNOWN_WINDOWS[providerId];
    if (known === undefined) {
        return undefined;
    }
    if (!Array.isArray(availableWindowIds)) {
        return undefined;
    }

    var settings = isRecord(sanitized) ? sanitized : createDefaultSettings();
    var selected;
    if (providerId === "claude") {
        selected = settings.claudeWindow;
    } else if (providerId === "codex") {
        selected = settings.codexWindow;
    } else {
        return undefined;
    }

    if (typeof selected !== "string" || selected.length === 0) {
        return undefined;
    }
    if (known.indexOf(selected) === -1) {
        return undefined;
    }
    if (availableWindowIds.indexOf(selected) === -1) {
        return undefined;
    }
    return selected;
}

function sanitizeProviderOrder(value) {
    if (!Array.isArray(value)) {
        return DEFAULT_PROVIDER_ORDER.slice();
    }
    var order = [];
    for (var i = 0; i < value.length; i++) {
        var id = value[i];
        if (typeof id !== "string") {
            continue;
        }
        if (KNOWN_PROVIDERS.indexOf(id) === -1) {
            continue;
        }
        if (order.indexOf(id) !== -1) {
            continue;
        }
        order.push(id);
    }
    if (order.length === 0) {
        return DEFAULT_PROVIDER_ORDER.slice();
    }
    // Append any known providers the user omitted so visibility keys stay addressable.
    for (var k = 0; k < KNOWN_PROVIDERS.length; k++) {
        var knownId = KNOWN_PROVIDERS[k];
        if (order.indexOf(knownId) === -1) {
            order.push(knownId);
        }
    }
    return order;
}

function sanitizeBool(value, fallback) {
    if (value === true || value === false) {
        return value;
    }
    return fallback;
}

function sanitizeString(value, fallback) {
    if (typeof value === "string") {
        return value;
    }
    return fallback;
}

function sanitizeDisplayMode(value) {
    if (typeof value === "string" && DISPLAY_MODES[value] === true) {
        return value;
    }
    return DEFAULTS.displayMode;
}

function sanitizeFontScale(value) {
    if (typeof value !== "number" || !isFinite(value) || value <= 0) {
        return DEFAULTS.fontScale;
    }
    if (value < FONT_SCALE_MIN) {
        return FONT_SCALE_MIN;
    }
    if (value > FONT_SCALE_MAX) {
        return FONT_SCALE_MAX;
    }
    return value;
}

function sanitizeRefreshInterval(value) {
    if (typeof value !== "number" || !isFinite(value) || !isIntegerNumber(value)) {
        return DEFAULTS.refreshIntervalMinutes;
    }
    if (value < REFRESH_INTERVAL_FLOOR_MINUTES) {
        return REFRESH_INTERVAL_FLOOR_MINUTES;
    }
    return value;
}

function sanitizeWindowSelection(providerId, value) {
    if (typeof value !== "string") {
        return "";
    }
    if (value.length === 0) {
        return "";
    }
    var known = KNOWN_WINDOWS[providerId];
    if (known === undefined || known.indexOf(value) === -1) {
        // Keep only catalog ids; unknown strings fall back to empty (default window).
        return "";
    }
    return value;
}

function sanitizeThresholds(cautionRaw, criticalRaw) {
    var caution = parseThreshold(cautionRaw, DEFAULTS.cautionThreshold);
    var critical = parseThreshold(criticalRaw, DEFAULTS.criticalThreshold);

    // Clamp into 0..100 after type validation.
    caution = clampInt(caution, 0, 100);
    critical = clampInt(critical, 0, 100);

    if (!(caution < critical)) {
        return {
            caution: DEFAULTS.cautionThreshold,
            critical: DEFAULTS.criticalThreshold
        };
    }
    return { caution: caution, critical: critical };
}

function parseThreshold(value, fallback) {
    if (typeof value !== "number" || !isFinite(value) || !isIntegerNumber(value)) {
        return fallback;
    }
    return value;
}

function clampInt(value, min, max) {
    if (value < min) {
        return min;
    }
    if (value > max) {
        return max;
    }
    return value;
}

function isIntegerNumber(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function isRecord(input) {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}
