.pragma library

// Plasma-independent snapshot-state model for the collector bridge. This
// module never imports the Plasma executable data-source plugin and never touches
// the filesystem/network/process/settings APIs. It only holds the most
// recently accepted, already-validated CollectorDocument and tracks safe,
// constant lifecycle status -- it never parses raw text or fabricates
// provider data.
//
// Callers are expected to validate a raw response with
// collector-validator.js first, then call acceptSnapshot() with the
// resulting document, or one of the retainOn*() functions when validation,
// the process, or a deadline failed. Each transition returns a new,
// immutable state object; it never mutates its input.

var LIFECYCLE_STATUS = Object.freeze({
    INITIAL: "initial",
    ACCEPTED: "accepted",
    RETAINED_INVALID: "retained-invalid",
    RETAINED_ERROR: "retained-error",
    RETAINED_TIMEOUT: "retained-timeout"
});

function createInitialSnapshotState() {
    return Object.freeze({
        snapshot: null,
        acceptedAtMs: null,
        lifecycleStatus: LIFECYCLE_STATUS.INITIAL
    });
}

function acceptSnapshot(previousState, document, nowMs) {
    return Object.freeze({
        snapshot: document,
        acceptedAtMs: nowMs,
        lifecycleStatus: LIFECYCLE_STATUS.ACCEPTED
    });
}

function retainOnInvalidDocument(previousState) {
    return retain(previousState, LIFECYCLE_STATUS.RETAINED_INVALID);
}

function retainOnProcessError(previousState) {
    return retain(previousState, LIFECYCLE_STATUS.RETAINED_ERROR);
}

function retainOnTimeout(previousState) {
    return retain(previousState, LIFECYCLE_STATUS.RETAINED_TIMEOUT);
}

function retain(previousState, lifecycleStatus) {
    return Object.freeze({
        snapshot: previousState.snapshot,
        acceptedAtMs: previousState.acceptedAtMs,
        lifecycleStatus: lifecycleStatus
    });
}

function getSnapshotAgeMs(state, nowMs) {
    if (state.snapshot === null || state.acceptedAtMs === null) {
        return undefined;
    }
    var age = nowMs - state.acceptedAtMs;
    return age < 0 ? 0 : age;
}
