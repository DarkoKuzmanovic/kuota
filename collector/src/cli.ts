export interface PlaceholderOutput {
  schemaVersion: number;
  collectedAt: string;
  providers: readonly unknown[];
}

function main(): void {
  const output: PlaceholderOutput = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    providers: [],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
