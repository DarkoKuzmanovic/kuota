.pragma library

// Plasma-independent compact panel model. Maps an already-validated
// CollectorDocument plus display config to ordered compact entries.
// Never imports Plasma executable APIs or touches I/O.

var DEFAULT_ORDER = ["claude", "codex", "grok", "kimi"];

var PROVIDER_LABELS = Object.freeze({
    claude: "Claude",
    codex: "Codex",
    grok: "Grok",
    kimi: "Kimi"
});

var THRESHOLD_LEVEL = Object.freeze({
    NONE: "none",
    CAUTION: "caution",
    CRITICAL: "critical"
});

var DEFAULT_CAUTION_THRESHOLD = 75;
var DEFAULT_CRITICAL_THRESHOLD = 90;

function createDefaultDisplayConfig() {
    return {
        order: DEFAULT_ORDER.slice(),
        visibility: {
            claude: true,
            codex: true,
            grok: true,
            kimi: true
        },
        metric: {},
        window: {},
        cautionThreshold: DEFAULT_CAUTION_THRESHOLD,
        criticalThreshold: DEFAULT_CRITICAL_THRESHOLD
    };
}

function buildCompactEntries(snapshot, displayConfig, appearance) {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.providers)) {
        return [];
    }

    var config = normalizeDisplayConfig(displayConfig);
    var providersById = indexProviders(snapshot.providers);
    var entries = [];

    for (var i = 0; i < config.order.length; i++) {
        var providerId = config.order[i];
        if (!config.visibility[providerId]) {
            continue;
        }
        var record = providersById[providerId];
        if (record === undefined) {
            continue;
        }
        entries.push(buildEntry(record, config, normalizeAppearance(appearance)));
    }

    return entries;
}

function normalizeDisplayConfig(displayConfig) {
    var base = createDefaultDisplayConfig();
    if (!isRecord(displayConfig)) {
        return base;
    }

    if (Array.isArray(displayConfig.order)) {
        base.order = displayConfig.order.slice();
    }

    if (isRecord(displayConfig.visibility)) {
        for (var id in base.visibility) {
            if (Object.prototype.hasOwnProperty.call(base.visibility, id)) {
                if (Object.prototype.hasOwnProperty.call(displayConfig.visibility, id)) {
                    base.visibility[id] = displayConfig.visibility[id] === true;
                }
            }
        }
    }

    if (isRecord(displayConfig.metric)) {
        base.metric = displayConfig.metric;
    }

    if (isRecord(displayConfig.window)) {
        base.window = displayConfig.window;
    }

    base.cautionThreshold = sanitizeThresholdNumber(displayConfig.cautionThreshold, base.cautionThreshold);
    base.criticalThreshold = sanitizeThresholdNumber(displayConfig.criticalThreshold, base.criticalThreshold);
    if (!(base.cautionThreshold < base.criticalThreshold)) {
        base.cautionThreshold = DEFAULT_CAUTION_THRESHOLD;
        base.criticalThreshold = DEFAULT_CRITICAL_THRESHOLD;
    }

    return base;
}

// Defensive reader for the sanitized theming settings (config-model.js owns
// validation; this only guards absence/type so older callers and tests keep
// working). "" / 1.0 reproduce the V1 look.
function normalizeAppearance(appearance) {
    var source = isRecord(appearance) ? appearance : {};
    return {
        customTextColor: source.customTextColorEnabled === true && typeof source.customTextColor === "string"
            ? source.customTextColor
            : "",
        labelOpacity: typeof source.labelOpacity === "number" && isFinite(source.labelOpacity)
            ? source.labelOpacity
            : 1.0,
        separatorOpacity: typeof source.separatorOpacity === "number" && isFinite(source.separatorOpacity)
            ? source.separatorOpacity
            : 1.0,
        accentFor: function (providerId) {
            var value = source[providerId + "AccentColor"];
            return typeof value === "string" ? value : "";
        },
        iconFor: function (providerId) {
            var value = source[providerId + "CustomIcon"];
            return typeof value === "string" ? value : "";
        }
    };
}

function sanitizeThresholdNumber(value, fallback) {
    if (typeof value !== "number" || !isFinite(value)) {
        return fallback;
    }
    return value;
}

function indexProviders(providers) {
    var map = {};
    for (var i = 0; i < providers.length; i++) {
        var record = providers[i];
        if (isRecord(record) && typeof record.id === "string") {
            map[record.id] = record;
        }
    }
    return map;
}

function buildEntry(record, config, appearance) {
    var providerId = record.id;
    var displayWindow = resolveDisplayWindow(record, config);
    var utilization = displayWindow ? utilizationPercent(displayWindow) : undefined;
    var displayValue = resolveDisplayValue(record, displayWindow, config, utilization);
    var thresholdLevel = thresholdLevelFromUtilization(utilization, config);

    // Color precedence (D-theming): threshold color always wins (rep resolves it
    // from thresholdLevel — the model emits "" so the V1 path is untouched);
    // otherwise accent tints the VALUE text only; otherwise the enabled custom
    // text color; otherwise "" (Plasma theme). Labels/icons follow the custom
    // text color, never the accent, and yield to an active threshold.
    var thresholdActive = thresholdLevel !== THRESHOLD_LEVEL.NONE;
    var accent = appearance.accentFor(providerId);
    var custom = thresholdActive ? "" : appearance.customTextColor;
    var valueColor = thresholdActive ? "" : (accent !== "" ? accent : custom);

    return {
        providerId: providerId,
        label: PROVIDER_LABELS[providerId] || providerId,
        displayValue: displayValue,
        thresholdLevel: thresholdLevel,
        state: record.state,
        valueColor: valueColor,
        textColor: custom,
        iconName: appearance.iconFor(providerId),
        labelOpacity: appearance.labelOpacity,
        separatorOpacity: appearance.separatorOpacity
    };
}

// Resolves the window this compact entry displays (D4): honor the
// configured per-provider window selection when it names a window ID that
// is actually PRESENT in this record's live windows; otherwise fall back to
// the Q10 primary-window default (windows[0]). config-model.js already
// restricts window[providerId] to the static known catalog at sanitize
// time; this is purely the live-availability check.
function resolveDisplayWindow(record, config) {
    if (!Array.isArray(record.windows) || record.windows.length === 0) {
        return undefined;
    }

    var selectedId = isRecord(config.window) ? config.window[record.id] : undefined;
    if (typeof selectedId === "string" && selectedId.length > 0) {
        for (var i = 0; i < record.windows.length; i++) {
            var candidate = record.windows[i];
            if (isRecord(candidate) && candidate.id === selectedId) {
                return candidate;
            }
        }
    }

    var primary = record.windows[0];
    return isRecord(primary) ? primary : undefined;
}

function resolveDisplayValue(record, displayWindow, config, utilization) {
    var metricChoice = config.metric[record.id];

    if (displayWindow !== undefined) {
        if (metricChoice === "used" && typeof displayWindow.used === "number") {
            return formatUsedCount(displayWindow.used);
        }
        if (typeof displayWindow.usedPercent === "number") {
            return formatPercent(displayWindow.usedPercent);
        }
        if (typeof displayWindow.used === "number") {
            if (typeof displayWindow.limit === "number" && displayWindow.limit > 0 && utilization !== undefined) {
                return formatPercent(utilization);
            }
            return formatUsedCount(displayWindow.used);
        }
    }

    return stateOnlyDisplayValue(record);
}

function stateOnlyDisplayValue(record) {
    if (typeof record.status === "string" && record.status.length > 0) {
        return record.status;
    }
    return "";
}

function utilizationPercent(window) {
    if (typeof window.usedPercent === "number") {
        return window.usedPercent;
    }
    if (typeof window.used === "number" && typeof window.limit === "number" && window.limit > 0) {
        return (window.used / window.limit) * 100;
    }
    return undefined;
}

function thresholdLevelFromUtilization(utilization, config) {
    if (typeof utilization !== "number" || !isFinite(utilization)) {
        return THRESHOLD_LEVEL.NONE;
    }
    var critical = (config && typeof config.criticalThreshold === "number") ? config.criticalThreshold : DEFAULT_CRITICAL_THRESHOLD;
    var caution = (config && typeof config.cautionThreshold === "number") ? config.cautionThreshold : DEFAULT_CAUTION_THRESHOLD;
    if (utilization >= critical) {
        return THRESHOLD_LEVEL.CRITICAL;
    }
    if (utilization >= caution) {
        return THRESHOLD_LEVEL.CAUTION;
    }
    return THRESHOLD_LEVEL.NONE;
}

function formatPercent(value) {
    return String(Math.floor(value)) + "%";
}

function formatUsedCount(value) {
    return String(value);
}

function isRecord(input) {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}