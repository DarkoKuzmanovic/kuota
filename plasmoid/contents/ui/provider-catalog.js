.pragma library

// Bundled presentation facts, not a configurable registry or validation policy.
var PROVIDER_IDS = Object.freeze(["claude", "codex", "grok", "kimi", "cursor", "opencode", "commandcode"]);
var PROVIDER_LABELS = Object.freeze({
    claude: "Claude",
    codex: "Codex",
    grok: "Grok",
    kimi: "Kimi",
    cursor: "Cursor",
    opencode: "OpenCode",
    commandcode: "CommandCode"
});

// Static known window IDs per selectable provider (M15). Cursor exposes a
// single "plan" window and is deliberately absent — a selector with one choice
// is a dead control. Kimi's short window id is duration-derived
// (windowLabelFromMinutes), so its catalog carries every stable id the adapter
// can emit; compact falls back to the primary window when a selection is
// absent from the live record.
var SELECTABLE_WINDOWS = Object.freeze({
    claude: Object.freeze(["session", "weekly-all", "weekly-oauth-apps"]),
    codex: Object.freeze(["primary", "secondary"]),
    grok: Object.freeze(["week", "month"]),
    kimi: Object.freeze(["week", "5h", "daily", "month"]),
    opencode: Object.freeze(["rolling", "weekly", "monthly"]),
    commandcode: Object.freeze(["fiveHour", "weekly"])
});

function defaultVisibility() {
    var visibility = {};
    for (var i = 0; i < PROVIDER_IDS.length; i++) visibility[PROVIDER_IDS[i]] = true;
    return visibility;
}
