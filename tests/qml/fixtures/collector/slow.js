// Synthetic collector stand-in that delays before emitting a valid document,
// used to exercise the bridge's production deadline (overridden to a short
// bound in tests) and late-result rejection after timeout. The bridge never
// passes ad hoc flags, so the delay is a fixed constant rather than argv
// configured.
"use strict";

var DELAY_MS = 400;

setTimeout(function () {
  var now = new Date().toISOString();
  var document = {
    schemaVersion: 1,
    collectionStartedAt: now,
    collectionFinishedAt: now,
    providers: [],
  };
  process.stdout.write(JSON.stringify(document));
  process.exit(0);
}, DELAY_MS);
