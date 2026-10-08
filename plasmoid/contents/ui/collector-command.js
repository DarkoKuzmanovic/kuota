.pragma library
.import "provider-catalog.js" as ProviderCatalog

// Plasma-independent builder for the one shell command the executable
// compatibility bridge launches. This module never imports the executable
// compatibility plugin and never touches the filesystem/network/settings
// APIs; it only builds and validates a plain string from bounded inputs.
//
// The provider list must already be an allowlisted subset (or the full
// canonical set) chosen by trusted in-process code -- never raw
// settings/user text -- because rigorous single-quoting is the only thing
// standing between arbitrary text and a shell command string. Control
// characters are rejected outright as defense in depth even though single
// quoting alone already neutralizes shell metacharacters.

var NODE_PATH = "/usr/bin/node";
var CANONICAL_PROVIDER_IDS = ProviderCatalog.PROVIDER_IDS;
var MAX_PATH_LENGTH = 4096;

var COMMAND_BUILD_FAILURE = Object.freeze({
    INVALID_COLLECTOR_PATH: "invalid-collector-path",
    INVALID_PROVIDER_LIST: "invalid-provider-list",
    INVALID_SOURCE_ID: "invalid-source-id"
});

function buildCollectorCommand(options) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
        return failure(COMMAND_BUILD_FAILURE.INVALID_COLLECTOR_PATH);
    }

    var collectorPath = validateCollectorPath(options.collectorPath);
    if (collectorPath === undefined) {
        return failure(COMMAND_BUILD_FAILURE.INVALID_COLLECTOR_PATH);
    }

    var providerToken = buildProviderToken(options.enabledProviders);
    if (providerToken === undefined) {
        return failure(COMMAND_BUILD_FAILURE.INVALID_PROVIDER_LIST);
    }

    if (!isSafeNonNegativeInteger(options.sourceId)) {
        return failure(COMMAND_BUILD_FAILURE.INVALID_SOURCE_ID);
    }

    var command = NODE_PATH + " " + quotePosixSingle(collectorPath) + providerToken +
        " # " + String(options.sourceId);

    return { ok: true, value: command };
}

function validateCollectorPath(path) {
    if (typeof path !== "string") {
        return undefined;
    }
    if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
        return undefined;
    }
    if (/[\u0000-\u001f\u007f]/.test(path)) {
        return undefined;
    }
    return path;
}

function buildProviderToken(enabledProviders) {
    if (enabledProviders === undefined || enabledProviders === null) {
        return "";
    }
    if (!Array.isArray(enabledProviders)) {
        return undefined;
    }

    var seen = {};
    for (var i = 0; i < enabledProviders.length; i++) {
        var id = enabledProviders[i];
        if (typeof id !== "string") {
            return undefined;
        }
        if (id === "umans") {
            continue;
        }
        if (CANONICAL_PROVIDER_IDS.indexOf(id) === -1) {
            return undefined;
        }
        if (Object.prototype.hasOwnProperty.call(seen, id)) {
            return undefined;
        }
        seen[id] = true;
    }

    var canonicalOrder = [];
    for (var c = 0; c < CANONICAL_PROVIDER_IDS.length; c++) {
        if (Object.prototype.hasOwnProperty.call(seen, CANONICAL_PROVIDER_IDS[c])) {
            canonicalOrder.push(CANONICAL_PROVIDER_IDS[c]);
        }
    }
    return " --enabled-providers=" + canonicalOrder.join(",");
}

function quotePosixSingle(text) {
    return "'" + text.split("'").join("'\\''") + "'";
}

function isSafeNonNegativeInteger(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value &&
        value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function failure(code) {
    return { ok: false, code: code };
}
