import type { CollectorDocument } from "./contract/schema-v1.js";

function main(): void {
  const collectionStartedAt = new Date().toISOString();
  const output: CollectorDocument = {
    schemaVersion: 1,
    collectionStartedAt,
    collectionFinishedAt: new Date().toISOString(),
    providers: [],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
