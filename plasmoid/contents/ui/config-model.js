.pragma library
.import "provider-catalog.js" as ProviderCatalog

// Plasma-independent configuration sanitizer and display-config assembler.
// Owns the read-boundary invariant for plasmoid settings before they reach
// compact/full models. Never imports Plasma executable APIs or touches I/O.

var KNOWN_PROVIDERS = ProviderCatalog.PROVIDER_IDS;

var DEFAULT_PROVIDER_ORDER = ProviderCatalog.PROVIDER_IDS;

var DISPLAY_MODES = Object.freeze({
    icons: true,
    text: true,
    "icons+text": true
});

// Static known window IDs per provider (D4); the catalog owns the facts.
var KNOWN_WINDOWS = ProviderCatalog.SELECTABLE_WINDOWS;

// Schema defaults — must stay in lockstep with plasmoid/contents/config/main.xml.
// fontScale is a unit multiplier (1.0 = 100%), not a percent integer.
var DEFAULTS = buildDefaults();

function buildDefaults() {
    var defaults = {
        providerOrder: DEFAULT_PROVIDER_ORDER,
        claudeWindow: "",
        codexWindow: "",
        grokWindow: "",
        kimiWindow: "",
        opencodeWindow: "",
        commandcodeWindow: "",
        displayMode: "icons+text",
        separator: " · ",
        fontScale: 1.0,
        showCountdown: true,
        refreshIntervalMinutes: 5,
        cautionThreshold: 75,
        criticalThreshold: 90,
        fontFamily: "",
        customTextColorEnabled: false,
        customTextColor: "",
        labelOpacity: 1.0,
        separatorOpacity: 1.0,
        iconLabelSpacing: 2,
        labelValueSpacing: 1
    };
    for (var i = 0; i < KNOWN_PROVIDERS.length; i++) {
        var id = KNOWN_PROVIDERS[i];
        defaults[id + "Visible"] = true;
        defaults[id + "AccentColor"] = "";
        defaults[id + "CustomIcon"] = "";
    }
    return Object.freeze(defaults);
}

var REFRESH_INTERVAL_FLOOR_MINUTES = 5;
var FONT_SCALE_MIN = 0.5;  // matches configAppearance.qml SpinBox from: 50
var FONT_SCALE_MAX = 3.0;

function createDefaultSettings() {
    var settings = {};
    var keys = Object.keys(DEFAULTS);
    for (var i = 0; i < keys.length; i++) {
        var value = DEFAULTS[keys[i]];
        settings[keys[i]] = Array.isArray(value) ? value.slice() : value;
    }
    return settings;
}

/**
 * Read-boundary sanitizer. Accepts a raw config-like object (e.g. values
 * mirrored from plasmoid.configuration) and returns a fully populated
 * settings object with every semantic constraint enforced:
 * - refreshIntervalMinutes ≥ 5 (Claude-safe floor)
 * - thresholds clamped to 0..100 and caution < critical (else 75/90)
 * - opacities clamped to 0.0..1.0 (garbage → 1.0)
 * - color/icon strings validated (garbage → "" = theme/provider default)
 * - garbage/missing/wrong-type → schema defaults
 */
function sanitize(rawConfig) {
    var out = createDefaultSettings();
    if (!isRecord(rawConfig)) {
        return out;
    }

    out.providerOrder = sanitizeProviderOrder(rawConfig.providerOrder);
    for (var v = 0; v < KNOWN_PROVIDERS.length; v++) {
        var key = KNOWN_PROVIDERS[v] + "Visible";
        out[key] = sanitizeBool(rawConfig[key], DEFAULTS[key]);
    }
    out.claudeWindow = sanitizeWindowSelection("claude", rawConfig.claudeWindow);
    out.codexWindow = sanitizeWindowSelection("codex", rawConfig.codexWindow);
    out.grokWindow = sanitizeWindowSelection("grok", rawConfig.grokWindow);
    out.kimiWindow = sanitizeWindowSelection("kimi", rawConfig.kimiWindow);
    out.opencodeWindow = sanitizeWindowSelection("opencode", rawConfig.opencodeWindow);
    out.commandcodeWindow = sanitizeWindowSelection("commandcode", rawConfig.commandcodeWindow);
    out.displayMode = sanitizeDisplayMode(rawConfig.displayMode);
    out.separator = sanitizeString(rawConfig.separator, DEFAULTS.separator);
    out.fontScale = sanitizeFontScale(rawConfig.fontScale);
    out.showCountdown = sanitizeBool(rawConfig.showCountdown, DEFAULTS.showCountdown);
    out.refreshIntervalMinutes = sanitizeRefreshInterval(rawConfig.refreshIntervalMinutes);

    var thresholds = sanitizeThresholds(rawConfig.cautionThreshold, rawConfig.criticalThreshold);
    out.cautionThreshold = thresholds.caution;
    out.criticalThreshold = thresholds.critical;
    out.fontFamily = sanitizeString(rawConfig.fontFamily, DEFAULTS.fontFamily);
    out.customTextColorEnabled = sanitizeBool(rawConfig.customTextColorEnabled, DEFAULTS.customTextColorEnabled);
    out.customTextColor = sanitizeColorString(rawConfig.customTextColor);
    out.labelOpacity = sanitizeOpacity(rawConfig.labelOpacity);
    out.separatorOpacity = sanitizeOpacity(rawConfig.separatorOpacity);
    out.iconLabelSpacing = sanitizeSpacing(rawConfig.iconLabelSpacing, DEFAULTS.iconLabelSpacing);
    out.labelValueSpacing = sanitizeSpacing(rawConfig.labelValueSpacing, DEFAULTS.labelValueSpacing);
    for (var p = 0; p < KNOWN_PROVIDERS.length; p++) {
        var providerId = KNOWN_PROVIDERS[p];
        out[providerId + "AccentColor"] = sanitizeColorString(rawConfig[providerId + "AccentColor"]);
        out[providerId + "CustomIcon"] = sanitizeIconName(rawConfig[providerId + "CustomIcon"]);
    }
    return out;
}

// Collection membership is independent of display order. Call only with the
// read-boundary sanitizer result; return allowlisted, secret-free IDs only.
function enabledProviders(sanitized) {
    var selected = [];
    for (var i = 0; i < KNOWN_PROVIDERS.length; i++) {
        var id = KNOWN_PROVIDERS[i];
        if (sanitized[id + "Visible"] === true) selected.push(id);
    }
    return selected;
}

/**
 * Assemble the displayConfig shape compact-model.js consumes.
 * Hidden providers are omitted from order (empty order when all hidden).
 * Adds a `window` map for selected compact windows (M9.3 will honor it);
 * keeps `metric: {}` for shape compatibility with createDefaultDisplayConfig().
 */
function assembleDisplayConfig(sanitized) {
    var settings = isRecord(sanitized) ? sanitized : createDefaultSettings();
    var visibility = {};
    for (var p = 0; p < KNOWN_PROVIDERS.length; p++) {
        var providerId = KNOWN_PROVIDERS[p];
        visibility[providerId] = settings[providerId + "Visible"] === true;
    }

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
    // `<id>Window` naming is uniform across the catalog (claudeWindow, ...,
    // commandcodeWindow); KNOWN_WINDOWS defines exactly the selectable set.
    for (var providerKey in KNOWN_WINDOWS) {
        if (!Object.prototype.hasOwnProperty.call(KNOWN_WINDOWS, providerKey)) {
            continue;
        }
        var selection = settings[providerKey + "Window"];
        if (typeof selection === "string" && selection.length > 0) {
            windowMap[providerKey] = selection;
        }
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
    var selected = settings[providerId + "Window"];

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

// Opacity slider guard: clamp into [0.0, 1.0]; garbage/missing → 1.0 (V1 look).
function sanitizeOpacity(value) {
    if (typeof value !== "number" || !isFinite(value)) {
        return DEFAULTS.labelOpacity;
    }
    if (value < 0) {
        return 0.0;
    }
    if (value > 1) {
        return 1.0;
    }
    return value;
}
// Compact layout spacing (pixels). Guard to non-negative small ints.
function sanitizeSpacing(value, fallback) {
    if (typeof value !== "number" || !isFinite(value)) {
        return fallback;
    }
    var v = Math.floor(value);
    if (v < 0) return 0;
    if (v > 64) return 64;
    return v;
}

// Accepts #rgb / #rgba / #rrggbb / #rrggbbaa hex or a Qt named color (letters
// only, e.g. "red"). Anything else → "" (theme/provider default).
var COLOR_HEX_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
var COLOR_NAME_PATTERN = /^[a-zA-Z]+$/;

function sanitizeColorString(value) {
    if (typeof value !== "string" || value.length === 0) {
        return "";
    }
    if (COLOR_HEX_PATTERN.test(value) || COLOR_NAME_PATTERN.test(value)) {
        return value;
    }
    return "";
}

// Freedesktop icon name: starts alphanumeric, then letters/digits/dot/underscore/
// hyphen. "" stays "" (provider default icon).
// Absolute local image paths (IconDialog "Other icons" / Browse…) are also accepted
// so custom PNG/SVG picks survive the D6 boundary. Relative paths, ".." segments,
// and non-image extensions are rejected → "".
var ICON_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var ICON_PATH_PATTERN = /^\/(?:[^/\0]+\/)*[^/\0]+\.(?:png|svg|svgz|jpe?g|webp|xpm|ico|gif)$/i;

function pathHasDotDot(path) {
    var parts = path.split("/");
    for (var i = 0; i < parts.length; i++) {
        if (parts[i] === "..") {
            return true;
        }
    }
    return false;
}

function sanitizeIconName(value) {
    if (typeof value !== "string" || value.length === 0) {
        return "";
    }
    if (ICON_NAME_PATTERN.test(value)) {
        return value;
    }
    // IconDialog may return a bare absolute path or a file:// URL for custom files.
    var path = value;
    if (path.indexOf("file://") === 0) {
        path = path.slice(7);
        // file:///home/... → /home/... (three slashes); file://localhost/home → skip host form
        if (path.indexOf("/") !== 0 && path.indexOf("localhost/") === 0) {
            path = path.slice("localhost".length);
        }
    }
    // Reject URL-significant characters. The accepted path is later embedded in
    // a `file://` URL, where Qt percent-decodes at load time: `%2e%2e` would
    // resolve to `..` and bypass pathHasDotDot, and `%`, `#`, `?` break URL
    // parsing even for literal filenames. Rejecting at sanitize is cheaper
    // than percent-encoding every accepted path at the iconSourceFor site and
    // matches the V1 contract that custom-icon paths are filesystem-safe
    // absolutes. Not a security boundary (the cfg value is the user's own
    // KConfig and any absolute path is already accepted by design); this is
    // hygiene against percent-decoded traversal and broken filenames.
    if (/[%#?]/.test(path)) {
        return "";
    }
    if (path.charAt(0) === "/" && !pathHasDotDot(path) && ICON_PATH_PATTERN.test(path)) {
        return path;
    }
    return "";
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
