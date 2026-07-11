import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collect,
  type CollectOptions,
} from "./collect/collect.js";

export const CLI_FAILURE_DIAGNOSTIC = "Kuota collector failed";
const CLI_FAILURE_OUTPUT = `${CLI_FAILURE_DIAGNOSTIC}\n`;

export interface CliWriter {
  write(chunk: string): void;
}

export interface CliOptions extends CollectOptions {
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

function collectionOptions(options: CliOptions): CollectOptions {
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
    const document = await collect(collectionOptions(options));
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

export async function main(options?: CliOptions): Promise<number> {
  if (options === undefined && process.argv.length > 2) {
    if (directInvocationActive) {
      return terminateDirectFailure();
    }
    return writeFailure(process.stderr);
  }
  return runCli(options);
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
