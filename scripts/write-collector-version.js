import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error("Invalid package version");
}
writeFileSync(new URL("../dist/collector/build-info.json", import.meta.url), `${JSON.stringify({ version: pkg.version })}\n`);
