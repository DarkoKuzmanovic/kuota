import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

import { parseCollectorConfig } from "./collect/config.js";
import { collectIntegrated, type IntegratedCollectOptions } from "./collect/integrated-collect.js";

export const CLI_FAILURE_DIAGNOSTIC = "Kuota collector failed";
const CLI_FAILURE_OUTPUT = `${CLI_FAILURE_DIAGNOSTIC}\n`;

export interface CliWriter {
  write(chunk: string): void;
}

export interface CliOptions extends IntegratedCollectOptions {
  readonly stdout?: CliWriter;
  readonly stderr?: CliWriter;
}

function writeFailure(stderr: CliWriter): number {
  if (directInvocationActive && stderr === process.stderr) {
    return terminateDirectFailure();
  }
  try {
    stderr.write(CLI_FAILURE_OUTPUT);
  } catch {
    // A failing diagnostic writer cannot safely be retried or inspected.
  }
  return 1;
}

let directInvocationActive = false;
let directFailureReported = false;

/**
 * End a direct collector process without allowing Node to print the error or
 * resume after an uncaught exception. The fixed descriptor and synchronous
 * write keep the diagnostic intact before the immediate exit.
 */
function terminateDirectFailure(): never {
  if (!directFailureReported) {
    directFailureReported = true;
    try {
      writeSync(2, CLI_FAILURE_OUTPUT, null, "utf8");
    } catch {
      // There is no safe recovery if stderr itself is unavailable.
    }
  }
  process.exit(1);
}

function handleUncaughtException(
  _error: Error,
  _origin: NodeJS.UncaughtExceptionOrigin,
): never {
  return terminateDirectFailure();
}

function handleUnhandledRejection(
  _reason: unknown,
  _promise: Promise<unknown>,
): never {
  return terminateDirectFailure();
}

function installDirectProcessHandlers(): void {
  process.once("uncaughtException", handleUncaughtException);
  process.once("unhandledRejection", handleUnhandledRejection);
}

function collectionOptions(options: CliOptions): IntegratedCollectOptions {
  const {
    stdout: _stdout,
    stderr: _stderr,
    ...optionsWithoutStreams
  } = options;
  return optionsWithoutStreams;
}

export async function runCli(options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const document = await collectIntegrated(collectionOptions(options));
    const serialized = JSON.stringify(document);
    if (typeof serialized !== "string") {
      return writeFailure(stderr);
    }
    await new Promise<void>((resolveAfterPendingFailures) => {
      setImmediate(resolveAfterPendingFailures);
    });
    stdout.write(`${serialized}\n`);
    return 0;
  } catch {
    return writeFailure(stderr);
  }
}

const ENABLED_PROVIDERS_PREFIX = "--enabled-providers=";

/** CLI argv shape failures are value-free; the caller reports one constant diagnostic. */
export class CliArgvParseError extends Error {
  constructor() {
    super("Invalid collector CLI arguments");
    this.name = "CliArgvParseError";
  }
}

function invalidArgv(): never {
  throw new CliArgvParseError();
}

/**
 * Reads argv as plain data only. Reflect/property-descriptor access avoids
 * invoking hostile getters, and only a genuine Array with contiguous own
 * index/length data properties is accepted.
 */
function argvProperties(argv: unknown): Map<PropertyKey, unknown> {
  try {
    if (typeof argv !== "object" || argv === null) invalidArgv();
    if (types.isProxy(argv)) invalidArgv();
    if (Object.getPrototypeOf(argv) !== Array.prototype) invalidArgv();
    const descriptors = Object.getOwnPropertyDescriptors(argv);
    const properties = new Map<PropertyKey, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") invalidArgv();
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) invalidArgv();
      properties.set(key, descriptor.value);
    }
    return properties;
  } catch (error: unknown) {
    if (error instanceof CliArgvParseError) throw error;
    return invalidArgv();
  }
}

/**
 * Parses only the owner-approved CLI transport surface: no arguments, or
 * exactly one `--enabled-providers=<csv>` argument. The result is fed into
 * the existing secret-free `parseCollectorConfig`; provider-ID semantics
 * (duplicates, unknown IDs, canonical order) are not duplicated here.
 */
export function parseCliArgv(argv: unknown): unknown {
  const properties = argvProperties(argv);
  const length = properties.get("length");
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    invalidArgv();
  }
  if (properties.size !== length + 1) invalidArgv();
  if (length === 0) return undefined;
  if (length !== 1) invalidArgv();

  const only = properties.get("0");
  if (typeof only !== "string") invalidArgv();
  if (!only.startsWith(ENABLED_PROVIDERS_PREFIX)) invalidArgv();

  const csv = only.slice(ENABLED_PROVIDERS_PREFIX.length);
  const enabledProviders = csv === "" ? [] : csv.split(",");
  return { enabledProviders };
}

export async function main(options?: CliOptions): Promise<number> {
  if (options !== undefined) {
    return runCli(options);
  }
  try {
    const config = parseCollectorConfig(parseCliArgv(process.argv.slice(2)));
    return await runCli({ config });
  } catch {
    if (directInvocationActive) {
      return terminateDirectFailure();
    }
    return writeFailure(process.stderr);
  }
}

function isDirectInvocation(): boolean {
  const entryPoint = process.argv[1];
  return (
    entryPoint !== undefined &&
    resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))
  );
}

if (isDirectInvocation()) {
  directInvocationActive = true;
  installDirectProcessHandlers();
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      terminateDirectFailure();
    },
  );
}
