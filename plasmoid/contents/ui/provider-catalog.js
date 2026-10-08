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

// Only the public release's existing compact-window selectors.
var SELECTABLE_WINDOWS = Object.freeze({
    claude: Object.freeze(["session", "weekly-all", "weekly-oauth-apps"]),
    codex: Object.freeze(["primary", "secondary"])
});

function defaultVisibility() {
    var visibility = {};
    for (var i = 0; i < PROVIDER_IDS.length; i++) visibility[PROVIDER_IDS[i]] = true;
    return visibility;
}
