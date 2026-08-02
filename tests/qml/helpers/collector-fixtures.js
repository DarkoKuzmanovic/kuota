.pragma library

// Shared builders for QML collector-contract tests. Keeping these in one
// place avoids duplicating the full TypeScript fixture suite while still
// letting each test express only the field it deliberately breaks.

function shallowMerge(base, overrides) {
    var merged = {};
    var key;
    for (key in base) {
        if (Object.prototype.hasOwnProperty.call(base, key)) {
            merged[key] = base[key];
        }
    }
    if (overrides) {
        for (key in overrides) {
            if (Object.prototype.hasOwnProperty.call(overrides, key)) {
                merged[key] = overrides[key];
            }
        }
    }
    return merged;
}

function validWindow(overrides) {
    return shallowMerge({
        id: "weekly",
        label: "Weekly",
        usedPercent: 42,
        used: 42,
        limit: 100,
        resetAt: "2026-07-14T10:00:00.000Z"
    }, overrides);
}

function validClaudeProvider(overrides) {
    return shallowMerge({
        id: "claude",
        state: "ok",
        status: "Usage is current",
        lastSuccessAt: "2026-07-11T10:00:01.000Z",
        windows: [validWindow()],
        details: { claude: { model: "synthetic-model", tokens: 1200 } }
    }, overrides);
}

function validUmansProvider(overrides) {
    return shallowMerge({
        id: "umans",
        state: "auth-needed",
        status: "Login required"
    }, overrides);
}

function validCodexProvider(overrides) {
    return shallowMerge({
        id: "codex",
        state: "error",
        status: "Provider unavailable"
    }, overrides);
}

function validGrokProvider(overrides) {
    return shallowMerge({
        id: "grok",
        state: "ok",
        status: "Usage is current",
        lastSuccessAt: "2026-07-11T10:00:01.000Z",
        windows: [validWindow()],
        details: { grok: { monthlyUsed: 3669, monthlyLimit: 20000, monthlyResetAt: "2026-08-01T00:00:00.000Z" } }
    }, overrides);
}

function validKimiProvider(overrides) {
    return shallowMerge({
        id: "kimi",
        state: "ok",
        status: "Usage is current",
        lastSuccessAt: "2026-07-11T10:00:01.000Z",
        windows: [validWindow()],
        details: { kimi: { concurrency: 2, concurrencyLimit: 20 } }
    }, overrides);
}

function validCursorProvider(overrides) {
    return shallowMerge({
        id: "cursor",
        state: "ok",
        status: "Usage is current",
        lastSuccessAt: "2026-07-11T10:00:01.000Z",
        windows: [validWindow({ id: "plan", label: "Plan", used: 40, limit: 100, usedPercent: 40 })],
        details: { cursor: { membershipType: "pro", onDemandUsed: 120 } }
    }, overrides);
}

function validStaleClaudeProvider(overrides) {
    return shallowMerge({
        id: "claude",
        state: "stale",
        lastSuccessAt: "2026-07-10T10:00:01.000Z",
        windows: [validWindow()]
    }, overrides);
}

function minimalDocument(overrides) {
    return shallowMerge({
        schemaVersion: 2,
        collectionStartedAt: "2026-07-11T10:00:00.000Z",
        collectionFinishedAt: "2026-07-11T10:00:01.000Z",
        providers: []
    }, overrides);
}

function fullDocument(overrides) {
    return minimalDocument(shallowMerge({
        providers: [validClaudeProvider(), validCodexProvider(), validGrokProvider()]
    }, overrides));
}
