// Synthetic collector stand-in that exits with a nonzero status and no
// output, used to prove the bridge treats an unclean exit as a process
// failure regardless of stdout content.
"use strict";

process.stdout.write("irrelevant");
process.exit(3);
