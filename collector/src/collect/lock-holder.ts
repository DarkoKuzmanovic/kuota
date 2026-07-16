import { writeSync } from "node:fs";

const READY_FRAME = "KUOTA_LOCK_READY\n";

try {
  writeSync(3, READY_FRAME, null, "utf8");
} catch {
  process.exitCode = 1;
}

process.stdin.resume();
process.stdin.once("end", () => undefined);
