// Synthetic collector stand-in that exits cleanly but writes far more than
// 256 KiB of output, used to prove the bridge rejects oversized stdout
// before ever attempting to parse or validate it.
"use strict";

var filler = new Array(300001).join("a");
var now = new Date().toISOString();
var document = {
  schemaVersion: 1,
  collectionStartedAt: now,
  collectionFinishedAt: now,
  providers: [],
  filler: filler,
};

process.stdout.write(JSON.stringify(document));
process.exit(0);
