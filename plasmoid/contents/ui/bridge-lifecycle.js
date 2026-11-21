.pragma library
.import "collector-command.js" as CollectorCommand

// Plasma-independent request tracking and process-result normalization for
// the executable compatibility bridge. This module never imports the
// executable compatibility plugin and never touches the
// filesystem/network/settings APIs; it only manages plain request-state
// objects and interprets a plain result object already handed to it.
//
// Non-overlap and late-result rejection both come from the same rule: at
// most one request token is ever "active" at a time, and only an exact
// match against that token may clear it. A stale token -- one superseded by
// a later request, or one cleared by a timeout -- can never again be
// mistaken for the active request, which is what keeps a slow prior run
// from satisfying a later refresh.

var EXIT_STATUS_NORMAL = 0;
var MAX_STDOUT_LENGTH = 262144; // 256 KiB; matches the whole-document validator's bound.

var PROCESS_OUTCOME = Object.freeze({
    SUCCESS: "success",
    PROCESS_FAILURE: "process-failure",
    OVERSIZED_STDOUT: "oversized-stdout"
});

function createRequestState() {
    return { activeToken: null, nextSourceId: 1 };
}

function isInFlight(state) {
    return state.activeToken !== null;
}

function beginRequest(state) {
    if (state.activeToken !== null) {
        return { started: false, state: state, sourceId: undefined };
    }
    return { started: true, state: state, sourceId: state.nextSourceId };
}

function activate(state, sourceId, token) {
    return { activeToken: token, nextSourceId: sourceId + 1 };
}

function advanceSourceCounter(state, sourceId) {
    return { activeToken: state.activeToken, nextSourceId: sourceId + 1 };
}

function isActiveToken(state, token) {
    return state.activeToken !== null && state.activeToken === token;
}

function clearIfActive(state, token) {
    if (!isActiveToken(state, token)) {
        return state;
    }
    return { activeToken: null, nextSourceId: state.nextSourceId };
}

function interpretProcessResult(data) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return { outcome: PROCESS_OUTCOME.PROCESS_FAILURE };
    }

    var exitCode = readNumericKey(data, "exit code", "exitCode");
    var exitStatus = readNumericKey(data, "exit status", "exitStatus");
    var stdout = readStringKey(data, "stdout");

    if (exitCode === undefined || exitStatus === undefined || stdout === undefined) {
        return { outcome: PROCESS_OUTCOME.PROCESS_FAILURE };
    }
    if (exitStatus !== EXIT_STATUS_NORMAL || exitCode !== 0) {
        return { outcome: PROCESS_OUTCOME.PROCESS_FAILURE };
    }
    // stderr is intentionally never read here: it must never enter a
    // signal, status, or diagnostic surface.
    if (stdout.length > MAX_STDOUT_LENGTH) {
        return { outcome: PROCESS_OUTCOME.OVERSIZED_STDOUT };
    }

    return { outcome: PROCESS_OUTCOME.SUCCESS, stdout: stdout };
}

function readNumericKey(data, spacedKey, camelKey) {
    var value = Object.prototype.hasOwnProperty.call(data, spacedKey)
        ? data[spacedKey]
        : (Object.prototype.hasOwnProperty.call(data, camelKey) ? data[camelKey] : undefined);
    if (typeof value !== "number" || !isFinite(value)) {
        return undefined;
    }
    return value;
}

function readStringKey(data, key) {
    var value = data[key];
    return typeof value === "string" ? value : undefined;
}

// --- Provider selection state -------------------------------------------
//
// The bridge's collection selection (which providers are collected) lives
// here so the QML bridge stays a thin view over pure state transitions,
// the same rule the request state above follows. A selection is keyed by
// its canonical comma-joined ID list — recovered from the provider list
// itself, never by re-parsing an argv token. While a request is in flight,
// a membership change discards the active result and schedules one
// refresh with the new selection once that run settles or times out;
// an empty selection discards but schedules nothing.

function createSelectionState() {
    return { selectionKey: null, enabledProviders: undefined, discardActiveResult: false, pendingRefresh: false };
}

function updateSelection(state, enabledProviders, inFlight) {
    var canonical = CollectorCommand.canonicalizeProviders(enabledProviders);
    if (canonical === undefined) {
        return { state: state, changed: false, selectionKey: undefined };
    }
    var selectionKey = canonical.defaultAll
        ? CollectorCommand.CANONICAL_PROVIDER_IDS.join(",")
        : canonical.ids.join(",");
    if (selectionKey === state.selectionKey) {
        return { state: state, changed: false, selectionKey: selectionKey };
    }
    var nextState = {
        selectionKey: selectionKey,
        enabledProviders: canonical.defaultAll ? undefined : canonical.ids.slice(),
        discardActiveResult: inFlight ? true : state.discardActiveResult,
        pendingRefresh: inFlight ? (selectionKey.length > 0) : state.pendingRefresh
    };
    return { state: nextState, changed: true, selectionKey: selectionKey };
}

function clearRefreshGate(state) {
    return {
        selectionKey: state.selectionKey,
        enabledProviders: state.enabledProviders,
        discardActiveResult: false,
        pendingRefresh: false
    };
}
