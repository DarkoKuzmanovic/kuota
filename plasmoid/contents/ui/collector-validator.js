.pragma library

// Plasma-independent whole-document validator for the collector contract
// (schema version 2). This module must never import the Plasma executable
// data-source plugin, touch the filesystem/network/process APIs, or read
// Qt/QML settings. It only parses and validates plain JS values so it
// stays testable and reusable from the executable bridge added in a later
// milestone.
//
// It mirrors collector/src/contract/validate.ts semantics but returns only
// constant, value-free failure codes -- never a rejected raw value, parse
// exception, or field-path detail -- because this boundary is reachable
// from process output that must never be echoed back verbatim.

var SCHEMA_VERSION = 2;
var PROVIDER_IDS = ["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"];
var PROVIDER_STATES = ["ok", "stale", "auth-needed", "error"];
var MAX_INPUT_LENGTH = 262144; // 256 KiB of QML string content.

var DOCUMENT_KEYS = ["schemaVersion", "collectionStartedAt", "collectionFinishedAt", "providers"];
var PROVIDER_KEYS = ["id", "state", "status", "lastSuccessAt", "windows", "details"];
var WINDOW_KEYS = ["id", "label", "usedPercent", "used", "limit", "resetAt"];
var CLAUDE_DETAIL_KEYS = [
    "model",
    "tokens",
    "extraUsageEnabled",
    "extraUsageUsedCredits",
    "extraUsageMonthlyLimit",
    "extraUsageCurrency",
    "extraUsageDecimalPlaces",
    "extraUsageDisabledReason"
];
var CODEX_DETAIL_KEYS = ["plan", "credits", "cost", "tokens"];
var GROK_DETAIL_KEYS = ["monthlyUsed", "monthlyLimit", "monthlyResetAt"];
var KIMI_DETAIL_KEYS = ["concurrency", "concurrencyLimit"];
var CURSOR_DETAIL_KEYS = [
    "membershipType",
    "onDemandUsed",
    "onDemandLimit",
    "autoPercentUsed",
    "apiPercentUsed",
    "totalPercentUsed"
];
var COMMANDCODE_DETAIL_KEYS = [
    "monthlyCredits",
    "purchasedCredits",
    "freeCredits",
    "planName",
    "exceeded",
    "weeklyExceeded"
];

var UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
var WINDOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

var VALIDATION_FAILURE = Object.freeze({
    EMPTY_INPUT: "empty-input",
    INVALID_INPUT_TYPE: "invalid-input-type",
    OVERSIZED_INPUT: "oversized-input",
    MALFORMED_JSON: "malformed-json",
    SCHEMA_INVALID: "schema-invalid"
});

function validateCollectorResponse(rawText) {
    if (typeof rawText !== "string") {
        return failure(VALIDATION_FAILURE.INVALID_INPUT_TYPE);
    }
    if (rawText.length === 0) {
        return failure(VALIDATION_FAILURE.EMPTY_INPUT);
    }
    if (rawText.length > MAX_INPUT_LENGTH) {
        return failure(VALIDATION_FAILURE.OVERSIZED_INPUT);
    }

    var parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (parseError) {
        return failure(VALIDATION_FAILURE.MALFORMED_JSON);
    }

    return validateCollectorDocument(parsed);
}

function shallowCopy(input) {
    var copy = {};
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) {
        copy[keys[i]] = input[keys[i]];
    }
    return copy;
}

function validateCollectorDocument(parsed) {
    var state = { invalid: false };

    if (!isRecord(parsed)) {
        return failure(VALIDATION_FAILURE.SCHEMA_INVALID);
    }

    var document = parsed;
    if (parsed.schemaVersion === 1) {
        var rawProviders = Array.isArray(parsed.providers) ? parsed.providers : undefined;
        document = shallowCopy(parsed);
        document.schemaVersion = SCHEMA_VERSION;
        if (rawProviders !== undefined) {
            document.providers = [];
            for (var m = 0; m < rawProviders.length; m++) {
                var rawProvider = rawProviders[m];
                if (isRecord(rawProvider) && rawProvider.id === "umans") {
                    continue;
                }
                document.providers.push(rawProvider);
            }
        }
    }

    validateObjectKeys(document, DOCUMENT_KEYS, state);

    if (document.schemaVersion !== SCHEMA_VERSION) {
        state.invalid = true;
    }

    var collectionStartedAt = parseRequiredTimestamp(document, "collectionStartedAt", state);
    var collectionFinishedAt = parseRequiredTimestamp(document, "collectionFinishedAt", state);
    if (
        collectionStartedAt !== undefined &&
        collectionFinishedAt !== undefined &&
        Date.parse(collectionStartedAt) > Date.parse(collectionFinishedAt)
    ) {
        state.invalid = true;
    }

    var providers = [];
    var seenProviderIds = {};
    if (!Array.isArray(document.providers)) {
        state.invalid = true;
    } else {
        for (var i = 0; i < document.providers.length; i++) {
            var provider = parseProvider(document.providers[i], state);
            if (provider === undefined) {
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(seenProviderIds, provider.id)) {
                state.invalid = true;
                continue;
            }
            seenProviderIds[provider.id] = true;
            providers.push(provider);
        }
    }

    if (state.invalid || collectionStartedAt === undefined || collectionFinishedAt === undefined) {
        return failure(VALIDATION_FAILURE.SCHEMA_INVALID);
    }

    return {
        ok: true,
        value: {
            schemaVersion: SCHEMA_VERSION,
            collectionStartedAt: collectionStartedAt,
            collectionFinishedAt: collectionFinishedAt,
            providers: providers
        }
    };
}

function parseProvider(input, state) {
    if (!isRecord(input)) {
        state.invalid = true;
        return undefined;
    }

    var startInvalid = state.invalid;
    validateObjectKeys(input, PROVIDER_KEYS, state);

    var id = parseProviderId(input.id, state);
    var providerState = parseProviderState(input.state, state);
    var status = parseOptionalSafeText(input, "status", 200, state);
    var lastSuccessAt = parseOptionalTimestamp(input, "lastSuccessAt", state);

    var windows;
    if (hasOwn(input, "windows") && input.windows !== undefined) {
        if (!Array.isArray(input.windows)) {
            state.invalid = true;
        } else {
            windows = [];
            var allowExceeded = id === "commandcode";
            for (var i = 0; i < input.windows.length; i++) {
                var window = parseWindow(input.windows[i], state, allowExceeded);
                if (window !== undefined) {
                    windows.push(window);
                }
            }
        }
    }

    var details;
    if (id !== undefined && hasOwn(input, "details") && input.details !== undefined) {
        details = parseProviderDetails(input.details, id, state);
    }

    if (providerState === "stale") {
        if (lastSuccessAt === undefined) {
            state.invalid = true;
        }
        if (!hasRetainedData(windows, details)) {
            state.invalid = true;
        }
    }

    if (state.invalid !== startInvalid || id === undefined || providerState === undefined) {
        return undefined;
    }

    var provider = { id: id, state: providerState };
    if (status !== undefined) {
        provider.status = status;
    }
    if (lastSuccessAt !== undefined) {
        provider.lastSuccessAt = lastSuccessAt;
    }
    if (windows !== undefined) {
        provider.windows = windows;
    }
    if (details !== undefined) {
        provider.details = details;
    }
    return provider;
}

function parseWindow(input, state, allowExceeded) {
    if (!isRecord(input)) {
        state.invalid = true;
        return undefined;
    }

    var startInvalid = state.invalid;
    validateObjectKeys(input, WINDOW_KEYS, state);

    var id = parseRequiredSafeText(input, "id", 80, state);
    if (id !== undefined && !WINDOW_ID.test(id)) {
        state.invalid = true;
    }
    var label = parseRequiredSafeText(input, "label", 100, state);
    var usedPercent = parseOptionalPercent(input, "usedPercent", state);
    var used = parseOptionalCount(input, "used", state);
    var limit = parseOptionalCount(input, "limit", state);
    var resetAt = parseOptionalTimestamp(input, "resetAt", state);

    if (!allowExceeded && used !== undefined && limit !== undefined && used > limit) {
        state.invalid = true;
    }
    if (limit === 0 && usedPercent !== undefined && usedPercent !== 0) {
        state.invalid = true;
    }

    if (state.invalid !== startInvalid || id === undefined || label === undefined) {
        return undefined;
    }

    var window = { id: id, label: label };
    if (usedPercent !== undefined) window.usedPercent = usedPercent;
    if (used !== undefined) window.used = used;
    if (limit !== undefined) window.limit = limit;
    if (resetAt !== undefined) window.resetAt = resetAt;
    return window;
}

function parseProviderDetails(input, id, state) {
    if (!isRecord(input)) {
        state.invalid = true;
        return undefined;
    }

    var startInvalid = state.invalid;
    validateObjectKeys(input, [id], state);
    if (!hasOwn(input, id)) {
        state.invalid = true;
        return undefined;
    }

    var detailKeys = id === "claude" ? CLAUDE_DETAIL_KEYS
        : id === "codex" ? CODEX_DETAIL_KEYS
        : id === "grok" ? GROK_DETAIL_KEYS
        : id === "kimi" ? KIMI_DETAIL_KEYS
        : id === "commandcode" ? COMMANDCODE_DETAIL_KEYS
        : id === "opencode" ? null
        : CURSOR_DETAIL_KEYS;
    if (detailKeys === null) {
        // OpenCode records are windows-only by design (nothing usable on the wire).
        state.invalid = true;
        return undefined;
    }
    var details = parseDetailFields(input[id], detailKeys, id, state);
    if (state.invalid !== startInvalid && details === undefined) {
        return undefined;
    }
    if (details === undefined) {
        return undefined;
    }
    var namespaced = {};
    namespaced[id] = details;
    return namespaced;
}

function parseDetailFields(input, allowedKeys, id, state) {
    if (!isRecord(input)) {
        state.invalid = true;
        return undefined;
    }
    var startInvalid = state.invalid;
    validateObjectKeys(input, allowedKeys, state);

    var details = {};
    if (id === "claude") {
        assignIfDefined(details, "model", parseOptionalSafeText(input, "model", 100, state));
        assignIfDefined(details, "tokens", parseOptionalCount(input, "tokens", state));
        assignIfDefined(details, "extraUsageEnabled", parseOptionalBoolean(input, "extraUsageEnabled", state));
        assignIfDefined(
            details,
            "extraUsageUsedCredits",
            parseOptionalCount(input, "extraUsageUsedCredits", state)
        );
        assignIfDefined(
            details,
            "extraUsageMonthlyLimit",
            parseOptionalCount(input, "extraUsageMonthlyLimit", state)
        );
        assignIfDefined(
            details,
            "extraUsageCurrency",
            parseOptionalSafeText(input, "extraUsageCurrency", 16, state)
        );
        assignIfDefined(
            details,
            "extraUsageDecimalPlaces",
            parseOptionalCount(input, "extraUsageDecimalPlaces", state)
        );
        assignIfDefined(
            details,
            "extraUsageDisabledReason",
            parseOptionalSafeText(input, "extraUsageDisabledReason", 100, state)
        );
    } else if (id === "codex") {
        assignIfDefined(details, "plan", parseOptionalSafeText(input, "plan", 100, state));
        assignIfDefined(details, "credits", parseOptionalNonNegativeNumber(input, "credits", state));
        assignIfDefined(details, "cost", parseOptionalNonNegativeNumber(input, "cost", state));
        assignIfDefined(details, "tokens", parseOptionalCount(input, "tokens", state));
    } else if (id === "grok") {
        assignIfDefined(details, "monthlyUsed", parseOptionalNonNegativeNumber(input, "monthlyUsed", state));
        assignIfDefined(details, "monthlyLimit", parseOptionalNonNegativeNumber(input, "monthlyLimit", state));
        assignIfDefined(details, "monthlyResetAt", parseOptionalTimestamp(input, "monthlyResetAt", state));
    } else if (id === "kimi") {
        assignIfDefined(details, "concurrency", parseOptionalCount(input, "concurrency", state));
        assignIfDefined(details, "concurrencyLimit", parseOptionalCount(input, "concurrencyLimit", state));
    } else if (id === "commandcode") {
        assignIfDefined(details, "monthlyCredits", parseOptionalNonNegativeNumber(input, "monthlyCredits", state));
        assignIfDefined(details, "purchasedCredits", parseOptionalNonNegativeNumber(input, "purchasedCredits", state));
        assignIfDefined(details, "freeCredits", parseOptionalNonNegativeNumber(input, "freeCredits", state));
        assignIfDefined(details, "planName", parseOptionalSafeText(input, "planName", 50, state));
        assignIfDefined(details, "exceeded", parseOptionalBoolean(input, "exceeded", state));
        assignIfDefined(details, "weeklyExceeded", parseOptionalBoolean(input, "weeklyExceeded", state));
    } else {
        assignIfDefined(details, "membershipType", parseOptionalSafeText(input, "membershipType", 100, state));
        assignIfDefined(details, "onDemandUsed", parseOptionalCount(input, "onDemandUsed", state));
        assignIfDefined(details, "onDemandLimit", parseOptionalCount(input, "onDemandLimit", state));
        assignIfDefined(details, "autoPercentUsed", parseOptionalPercent(input, "autoPercentUsed", state));
        assignIfDefined(details, "apiPercentUsed", parseOptionalPercent(input, "apiPercentUsed", state));
        assignIfDefined(details, "totalPercentUsed", parseOptionalPercent(input, "totalPercentUsed", state));
    }

    if (state.invalid !== startInvalid) {
        return undefined;
    }
    return details;
}

function assignIfDefined(target, key, value) {
    if (value !== undefined) {
        target[key] = value;
    }
}

function parseProviderId(input, state) {
    if (typeof input !== "string" || PROVIDER_IDS.indexOf(input) === -1) {
        state.invalid = true;
        return undefined;
    }
    return input;
}

function parseProviderState(input, state) {
    if (typeof input !== "string" || PROVIDER_STATES.indexOf(input) === -1) {
        state.invalid = true;
        return undefined;
    }
    return input;
}

function parseRequiredTimestamp(input, key, state) {
    if (!hasOwn(input, key)) {
        state.invalid = true;
        return undefined;
    }
    return parseTimestamp(input[key], state);
}

function parseOptionalTimestamp(input, key, state) {
    if (!hasOwn(input, key) || input[key] === undefined) {
        return undefined;
    }
    return parseTimestamp(input[key], state);
}

function parseTimestamp(input, state) {
    if (typeof input !== "string" || !UTC_TIMESTAMP.test(input)) {
        state.invalid = true;
        return undefined;
    }
    var parsed = new Date(input);
    var fractionalMatch = /\.(\d{3})Z$/.exec(input);
    var canonical;
    if (fractionalMatch === null) {
        canonical = input.slice(0, -1) + ".000Z";
    } else {
        var fractional = fractionalMatch[1];
        canonical = input.slice(0, -(fractional.length + 2)) + "." + padEnd(fractional, 3, "0") + "Z";
    }
    if (isNaN(parsed.getTime()) || parsed.toISOString() !== canonical) {
        state.invalid = true;
        return undefined;
    }
    return input;
}

function padEnd(text, length, pad) {
    var result = text;
    while (result.length < length) {
        result += pad;
    }
    return result;
}

function parseRequiredSafeText(input, key, maxLength, state) {
    if (!hasOwn(input, key)) {
        state.invalid = true;
        return undefined;
    }
    return parseSafeText(input[key], maxLength, state);
}

function parseOptionalSafeText(input, key, maxLength, state) {
    if (!hasOwn(input, key) || input[key] === undefined) {
        return undefined;
    }
    return parseSafeText(input[key], maxLength, state);
}

function parseSafeText(input, maxLength, state) {
    if (typeof input !== "string") {
        state.invalid = true;
        return undefined;
    }
    if (input.length === 0 || input.length > maxLength) {
        state.invalid = true;
        return undefined;
    }
    if (/[\u0000-\u001f\u007f]/.test(input)) {
        state.invalid = true;
        return undefined;
    }
    if (looksLikeCredential(input)) {
        state.invalid = true;
        return undefined;
    }
    return input;
}

function parseOptionalPercent(input, key, state) {
    if (!hasOwn(input, key) || input[key] === undefined) {
        return undefined;
    }
    var value = input[key];
    if (typeof value !== "number" || !isFinite(value) || value < 0 || value > 100) {
        state.invalid = true;
        return undefined;
    }
    return value;
}

function parseOptionalCount(input, key, state) {
    if (!hasOwn(input, key) || input[key] === undefined) {
        return undefined;
    }
    var value = input[key];
    if (typeof value !== "number" || !isSafeInteger(value) || value < 0) {
        state.invalid = true;
        return undefined;
    }
    return value;
}

function parseOptionalBoolean(input, key, state) {
    if (!hasOwn(input, key) || input[key] === undefined) {
        return undefined;
    }
    var value = input[key];
    if (typeof value !== "boolean") {
        state.invalid = true;
        return undefined;
    }
    return value;
}

function parseOptionalNonNegativeNumber(input, key, state) {
    if (!hasOwn(input, key) || input[key] === undefined) {
        return undefined;
    }
    var value = input[key];
    if (typeof value !== "number" || !isFinite(value) || value < 0) {
        state.invalid = true;
        return undefined;
    }
    return value;
}

function isSafeInteger(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value &&
        Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function validateObjectKeys(input, allowedKeys, state) {
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) {
        if (allowedKeys.indexOf(keys[i]) === -1) {
            state.invalid = true;
        }
    }
}


function looksLikeCredential(input) {
    return (
        /bearer\s+[a-z0-9._~+/=-]+/i.test(input) ||
        /(?:sk-(?:ant|proj|live)-[a-z0-9_-]{8,}|sk-[a-z0-9]{8,}|AIza[a-z0-9_-]{20,})/i.test(input) ||
        /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/.test(input) ||
        /eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/i.test(input) ||
        /(?:access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[:=]/i.test(input)
    );
}

function hasOwn(input, key) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

function isRecord(input) {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasRetainedData(windows, details) {
    if (windows !== undefined && windows.length > 0) {
        return true;
    }
    if (details === undefined) {
        return false;
    }
    var namespaceKey = Object.keys(details)[0];
    if (namespaceKey === undefined) {
        return false;
    }
    return Object.keys(details[namespaceKey]).length > 0;
}

function failure(code) {
    return { ok: false, code: code };
}
