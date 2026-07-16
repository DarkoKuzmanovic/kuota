.pragma library

// Plasma-independent compact panel model. Maps an already-validated
// CollectorDocument plus display config to ordered compact entries.
// Never imports Plasma executable APIs or touches I/O.

var DEFAULT_ORDER = ["claude", "umans", "codex"];

var PROVIDER_LABELS = Object.freeze({
    claude: "Claude",
    umans: "Umans",
    codex: "Codex"
});

var THRESHOLD_LEVEL = Object.freeze({
    NONE: "none",
    CAUTION: "caution",
    CRITICAL: "critical"
});

function createDefaultDisplayConfig() {
    return {
        order: DEFAULT_ORDER.slice(),
        visibility: {
            claude: true,
            umans: true,
            codex: true
        },
        metric: {}
    };
}

function buildCompactEntries(snapshot, displayConfig) {
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
        entries.push(buildEntry(record, config));
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

    return base;
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

function buildEntry(record, config) {
    var providerId = record.id;
    var primaryWindow = primaryUsageWindow(record);
    var utilization = primaryWindow ? utilizationPercent(primaryWindow) : undefined;
    var displayValue = resolveDisplayValue(record, primaryWindow, config, utilization);

    return {
        providerId: providerId,
        label: PROVIDER_LABELS[providerId] || providerId,
        displayValue: displayValue,
        thresholdLevel: thresholdLevelFromUtilization(utilization),
        state: record.state
    };
}

function primaryUsageWindow(record) {
    if (!Array.isArray(record.windows) || record.windows.length === 0) {
        return undefined;
    }
    var window = record.windows[0];
    return isRecord(window) ? window : undefined;
}

function resolveDisplayValue(record, primaryWindow, config, utilization) {
    var metricChoice = config.metric[record.id];

    if (primaryWindow !== undefined) {
        if (metricChoice === "used" && typeof primaryWindow.used === "number") {
            return formatUsedCount(primaryWindow.used);
        }
        if (typeof primaryWindow.usedPercent === "number") {
            return formatPercent(primaryWindow.usedPercent);
        }
        if (typeof primaryWindow.used === "number") {
            if (typeof primaryWindow.limit === "number" && primaryWindow.limit > 0 && utilization !== undefined) {
                return formatPercent(utilization);
            }
            return formatUsedCount(primaryWindow.used);
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

function thresholdLevelFromUtilization(utilization) {
    if (typeof utilization !== "number" || !isFinite(utilization)) {
        return THRESHOLD_LEVEL.NONE;
    }
    if (utilization >= 90) {
        return THRESHOLD_LEVEL.CRITICAL;
    }
    if (utilization >= 75) {
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