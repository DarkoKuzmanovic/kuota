// Synthetic, non-secret collector stand-in used only by real DataSource
// bridge tests. Emits one valid schema-v2 document, reflecting the
// `--enabled-providers=<csv>` argument if present, defaulting to the
// canonical five providers otherwise. No credentials, network, or
// filesystem access.
"use strict";

var CANONICAL_PROVIDER_IDS = ["claude", "codex", "grok", "kimi", "cursor"];

function enabledProviderIds(argv) {
  for (var i = 0; i < argv.length; i++) {
    var prefix = "--enabled-providers=";
    if (argv[i].indexOf(prefix) === 0) {
      var csv = argv[i].slice(prefix.length);
      return csv.length === 0 ? [] : csv.split(",");
    }
  }
  return CANONICAL_PROVIDER_IDS.slice();
}

var providerIds = enabledProviderIds(process.argv.slice(2));
var now = new Date().toISOString();
var document = {
  schemaVersion: 2,
  collectionStartedAt: now,
  collectionFinishedAt: now,
  providers: providerIds.map(function (id) {
    return { id: id, state: "ok" };
  }),
};

process.stdout.write(JSON.stringify(document));
process.exit(0);
