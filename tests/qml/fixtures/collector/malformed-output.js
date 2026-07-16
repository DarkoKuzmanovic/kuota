// Synthetic collector stand-in that exits cleanly but writes text that is
// not valid JSON, used to prove malformed output retains the prior snapshot.
"use strict";

process.stdout.write("{not json");
process.exit(0);
