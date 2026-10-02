.pragma library

// Plasma-independent full-view model. Maps one already-validated provider
// record to window rows, provider facts, and state messaging. Never imports
// Plasma executable APIs or touches I/O. Live countdown is computed in QML.

var THRESHOLD_LEVEL = Object.freeze({
    NONE: "none",
    CAUTION: "caution",
    CRITICAL: "critical"
});

var STATE_MESSAGES = Object.freeze({
    stale: "Stale data",
    "auth-needed": "Login needed",
    error: "Error"
});

var DEFAULT_CAUTION_THRESHOLD = 75;
var DEFAULT_CRITICAL_THRESHOLD = 90;

// Injected thresholds (M9, D5) override the 75/90 default. Malformed or
// inverted (caution >= critical) input falls back to the default pair —
// same semantics as config-model.js's own threshold sanitizer.
function normalizeThresholds(thresholds) {
    var caution = DEFAULT_CAUTION_THRESHOLD;
    var critical = DEFAULT_CRITICAL_THRESHOLD;
    if (isRecord(thresholds)) {
        if (typeof thresholds.caution === "number" && isFinite(thresholds.caution)) {
            caution = thresholds.caution;
        }
        if (typeof thresholds.critical === "number" && isFinite(thresholds.critical)) {
            critical = thresholds.critical;
        }
    }
    if (!(caution < critical)) {
        return { caution: DEFAULT_CAUTION_THRESHOLD, critical: DEFAULT_CRITICAL_THRESHOLD };
    }
    return { caution: caution, critical: critical };
}

function buildFullViewModel(record, thresholds, appearance) {
    var resolvedThresholds = normalizeThresholds(thresholds);
    var resolvedAppearance = normalizeAppearance(appearance);
    if (!isRecord(record) || typeof record.id !== "string") {
        return emptyModel();
    }

    var providerId = record.id;
    var state = typeof record.state === "string" ? record.state : "error";

    return {
        providerId: providerId,
        state: state,
        lastSuccessAt: optionalString(record.lastSuccessAt),
        windows: buildWindowRows(record, resolvedThresholds, resolvedAppearance.accentFor(providerId)),
        facts: buildFacts(record),
        stateMessage: stateMessageFor(state, providerId),
        textColor: resolvedAppearance.customTextColor,
        // iconName is exposed for API symmetry with the compact model; the
        // compact representation is the only current visual consumer — the
        // full representation has no per-provider icon slot (by design, icon
        // customization is compact-rep-only). Not a bug.
        iconName: resolvedAppearance.iconFor(providerId),
        labelOpacity: resolvedAppearance.labelOpacity
    };
}

function emptyModel() {
    return {
        providerId: "",
        state: "error",
        windows: [],
        facts: [],
        stateMessage: STATE_MESSAGES.error,
        // Theming fields present with V1 defaults so a representation never
        // reads `undefined` (undefined !== "" would misbehave in color guards).
        textColor: "",
        iconName: "",
        labelOpacity: 1.0
    };
}

// Defensive reader for the sanitized theming settings (same contract as
// compact-model.js): custom text color only when enabled, "" / 1.0 = V1 look.
function normalizeAppearance(appearance) {
    var source = isRecord(appearance) ? appearance : {};
    return {
        customTextColor: source.customTextColorEnabled === true && typeof source.customTextColor === "string"
            ? source.customTextColor
            : "",
        labelOpacity: typeof source.labelOpacity === "number" && isFinite(source.labelOpacity)
            ? source.labelOpacity
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

function buildWindowRows(record, thresholds, accentColor) {
    if (!Array.isArray(record.windows)) {
        return [];
    }

    var rows = [];
    for (var i = 0; i < record.windows.length; i++) {
        var window = record.windows[i];
        if (!isRecord(window)) {
            continue;
        }
        rows.push(buildWindowRow(window, thresholds, accentColor));
    }
    return rows;
}

function buildWindowRow(window, thresholds, accentColor) {
    var row = {
        label: typeof window.label === "string" ? window.label : "",
        thresholdLevel: THRESHOLD_LEVEL.NONE
    };

    if (typeof window.usedPercent === "number") {
        row.usedPercent = window.usedPercent;
    }
    if (typeof window.used === "number") {
        row.used = window.used;
    }
    if (typeof window.limit === "number") {
        row.limit = window.limit;
    }
    if (typeof window.resetAt === "string" && window.resetAt.length > 0) {
        row.resetAt = window.resetAt;
    }

    var utilization = utilizationPercent(window);
    row.thresholdLevel = thresholdLevelFromUtilization(utilization, thresholds);
    // Accent tints the bar only when no threshold is active; "" = rep default.
    row.barColor = row.thresholdLevel !== THRESHOLD_LEVEL.NONE ? "" : (typeof accentColor === "string" ? accentColor : "");

    var fraction = progressFractionFromWindow(window);
    if (fraction !== undefined) {
        row.progressFraction = fraction;
    }

    var remaining = remainingFromWindow(window);
    if (remaining !== undefined) {
        row.remaining = remaining;
    }

    return row;
}

function progressFractionFromWindow(window) {
    if (typeof window.usedPercent === "number" && isFinite(window.usedPercent)) {
        return clamp01(window.usedPercent / 100);
    }
    if (typeof window.used === "number" && typeof window.limit === "number" && window.limit > 0) {
        return clamp01(window.used / window.limit);
    }
    return undefined;
}

function remainingFromWindow(window) {
    if (typeof window.used === "number" && typeof window.limit === "number") {
        return window.limit - window.used;
    }
    return undefined;
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

function thresholdLevelFromUtilization(utilization, thresholds) {
    if (typeof utilization !== "number" || !isFinite(utilization)) {
        return THRESHOLD_LEVEL.NONE;
    }
    var resolved = isRecord(thresholds) ? thresholds : normalizeThresholds(undefined);
    if (utilization >= resolved.critical) {
        return THRESHOLD_LEVEL.CRITICAL;
    }
    if (utilization >= resolved.caution) {
        return THRESHOLD_LEVEL.CAUTION;
    }
    return THRESHOLD_LEVEL.NONE;
}

function clamp01(value) {
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}

function buildFacts(record) {
    var details = record.details;
    if (!isRecord(details)) {
        return [];
    }

    var id = record.id;
    if (id === "claude" && isRecord(details.claude)) {
        return claudeFacts(details.claude);
    }
    if (id === "codex" && isRecord(details.codex)) {
        return codexFacts(details.codex);
    }
    if (id === "grok" && isRecord(details.grok)) {
        return grokFacts(details.grok);
    }
    if (id === "kimi" && isRecord(details.kimi)) {
        return kimiFacts(details.kimi);
    }
    if (id === "cursor" && isRecord(details.cursor)) {
        return cursorFacts(details.cursor);
    }
    if (id === "commandcode" && isRecord(details.commandcode)) {
        return commandCodeFacts(details.commandcode);
    }
    return [];
}

function claudeFacts(d) {
    var facts = [];
    pushStringFact(facts, "Model", d.model);
    pushNumberFact(facts, "Tokens", d.tokens);
    if (typeof d.extraUsageEnabled === "boolean") {
        facts.push({ label: "Extra usage", value: d.extraUsageEnabled ? "Enabled" : "Disabled" });
    }
    pushCreditFact(facts, "Extra usage used", d.extraUsageUsedCredits, d);
    pushCreditFact(facts, "Extra usage limit", d.extraUsageMonthlyLimit, d);
    pushStringFact(facts, "Extra usage disabled reason", d.extraUsageDisabledReason);
    return facts;
}

function codexFacts(d) {
    var facts = [];
    pushStringFact(facts, "Plan", d.plan);
    pushNumberFact(facts, "Credits", d.credits);
    pushNumberFact(facts, "Cost", d.cost);
    pushNumberFact(facts, "Tokens", d.tokens);
    return facts;
}

function grokFacts(d) {
    var facts = [];
    pushNumberFact(facts, "Monthly used", d.monthlyUsed);
    pushNumberFact(facts, "Monthly limit", d.monthlyLimit);
    return facts;
}

function kimiFacts(d) {
    var facts = [];
    pushNumberFact(facts, "Concurrency", d.concurrency);
    pushNumberFact(facts, "Concurrency limit", d.concurrencyLimit);
    return facts;
}

function cursorFacts(d) {
    var facts = [];
    pushStringFact(facts, "Membership", d.membershipType);
    pushDollarCentsFact(facts, "On-demand used", d.onDemandUsed);
    pushDollarCentsFact(facts, "On-demand limit", d.onDemandLimit);
    pushPercentFact(facts, "Auto usage", d.autoPercentUsed);
    pushPercentFact(facts, "API usage", d.apiPercentUsed);
    pushPercentFact(facts, "Total usage", d.totalPercentUsed);
    return facts;
}

// Closed allowlist over details.commandcode (design V14): plan name, credit
// allowance counts (caps, not spend), and the exceeded flags.
function commandCodeFacts(d) {
    var facts = [];
    pushStringFact(facts, "Plan", d.planName);
    pushNumberFact(facts, "Monthly credits", d.monthlyCredits);
    pushNumberFact(facts, "Purchased credits", d.purchasedCredits);
    pushNumberFact(facts, "Free credits", d.freeCredits);
    pushFlagFact(facts, "5-hour window exceeded", d.exceeded);
    pushFlagFact(facts, "Weekly window exceeded", d.weeklyExceeded);
    return facts;
}

function pushFlagFact(facts, label, value) {
    if (typeof value === "boolean") {
        facts.push({ label: label, value: value ? "Yes" : "No" });
    }
}

function pushStringFact(facts, label, value) {
    if (typeof value === "string" && value.length > 0) {
        facts.push({ label: label, value: value });
    }
}

function pushNumberFact(facts, label, value) {
    if (typeof value === "number" && isFinite(value)) {
        facts.push({ label: label, value: formatNumber(value) });
    }
}

function pushCreditFact(facts, label, amount, details) {
    if (typeof amount !== "number" || !isFinite(amount)) {
        return;
    }
    facts.push({ label: label, value: formatCreditAmount(amount, details) });
}

function pushDollarCentsFact(facts, label, cents) {
    if (typeof cents !== "number" || !isFinite(cents)) {
        return;
    }
    facts.push({ label: label, value: "$" + (cents / 100).toFixed(2) });
}

function pushPercentFact(facts, label, value) {
    if (typeof value !== "number" || !isFinite(value)) {
        return;
    }
    facts.push({ label: label, value: String(value) + "%" });
}

function formatCreditAmount(amount, details) {
    var currency = typeof details.extraUsageCurrency === "string" ? details.extraUsageCurrency : "";
    var formatted;
    if (typeof details.extraUsageDecimalPlaces === "number" && isFinite(details.extraUsageDecimalPlaces)) {
        var decimals = Math.max(0, Math.floor(details.extraUsageDecimalPlaces));
        // Credit counts are encoded in minor units; scale to major units for display.
        formatted = (amount / Math.pow(10, decimals)).toFixed(decimals);
    } else {
        // No decimal-places hint: units are unknown, show the raw integer count as-is.
        formatted = String(amount);
    }
    if (currency === "USD") {
        return "$" + formatted;
    }
    if (currency.length > 0) {
        return formatted + " " + currency;
    }
    return formatted;
}

function formatNumber(value) {
    if (Math.floor(value) === value) {
        return String(value);
    }
    return String(value);
}

// Spec 2026-10-02-standalone-credentials-design.md: auth-needed names the fix.
// Fixed strings keyed by a closed provider list; nothing from the record is echoed.
var LOGIN_HINTS = Object.freeze({
    claude: "sign in to Claude Code",
    cursor: "sign in to the Cursor app",
    codex: "run in a terminal: kuota login codex",
    grok: "run in a terminal: kuota login grok",
    kimi: "run in a terminal: kuota login kimi",
    opencode: "run in a terminal: kuota login opencode",
    commandcode: "run in a terminal: kuota login commandcode"
});

function stateMessageFor(state, providerId) {
    if (state === "ok") {
        return undefined;
    }
    if (state === "auth-needed" && Object.prototype.hasOwnProperty.call(LOGIN_HINTS, providerId)) {
        return STATE_MESSAGES["auth-needed"] + " — " + LOGIN_HINTS[providerId];
    }
    if (Object.prototype.hasOwnProperty.call(STATE_MESSAGES, state)) {
        return STATE_MESSAGES[state];
    }
    return STATE_MESSAGES.error;
}

function optionalString(value) {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    return undefined;
}

function isRecord(input) {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}