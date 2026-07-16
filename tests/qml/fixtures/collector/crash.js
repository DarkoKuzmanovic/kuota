// Synthetic collector stand-in that terminates itself with an uncatchable
// signal to exercise the crash (non-normal exit status) path distinct from
// an ordinary nonzero exit code.
"use strict";

process.kill(process.pid, "SIGKILL");
