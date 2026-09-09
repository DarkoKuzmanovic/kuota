import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CursorSessionCredential {
  readonly kind: "session";
  readonly value: string;
}

export type CursorAuthResult =
  | { readonly state: "available"; readonly credential: CursorSessionCredential }
  | { readonly state: "auth-needed"; readonly reason: "missing-local" | "missing-env" | "empty-token" }
  | { readonly state: "error"; readonly reason: "sqlite-unavailable" | "sqlite-failed" | "db-unreadable" };

export type CursorSqliteRunner = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly terminated?: boolean }>;

export interface CursorAuthOptions {
  readonly signal?: AbortSignal;
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly runSqlite?: CursorSqliteRunner;
  readonly stateDbCandidates?: readonly string[];
}

const ACCESS_TOKEN_QUERY =
  "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1;";

function nonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultStateDbCandidates(homeDirectory: string): readonly string[] {
  return [
    join(homeDirectory, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(homeDirectory, ".config", "cursor", "User", "globalStorage", "state.vscdb"),
  ];
}

const defaultRunSqlite: CursorSqliteRunner = async (args, signal) => {
  if (signal?.aborted) return { code: 1, stdout: "", stderr: "", terminated: true };
  return new Promise((resolve) => {
    const output: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminated = false;
    let failureCode: number | undefined;
    const child = spawn("/usr/bin/sqlite3", args, { stdio: ["ignore", "pipe", "pipe"] });
    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      output.length = 0;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(terminate, 2000);
    signal?.addEventListener("abort", terminate, { once: true });
    // Cover cancellation between the precheck and listener registration.
    if (signal?.aborted) terminate();
    const onStdout = (chunk: Buffer): void => {
      if (terminated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) terminate();
      else output.push(chunk);
    };
    const onStderr = (chunk: Buffer): void => {
      if (terminated) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) terminate();
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      failureCode = error.code === "ENOENT" ? 127 : 1;
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    // close follows error/exit and drained stdio: resolve only after reaping.
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", terminate);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      resolve({ code: failureCode ?? code ?? 1,
        stdout: terminated || failureCode !== undefined ? "" : Buffer.concat(output).toString("utf8"),
        stderr: "", terminated });
    });
  });
};

async function readLocalToken(
  candidates: readonly string[],
  runSqlite: CursorSqliteRunner,
  signal?: AbortSignal,
): Promise<
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "sqlite-unavailable" }
  | { readonly kind: "missing" }
  | { readonly kind: "terminated" }
> {
  let sqliteUnavailable = false;
  for (const dbPath of candidates) {
    if (signal?.aborted) return { kind: "terminated" };
    const result = await runSqlite([
      '-readonly',
      dbPath,
      ACCESS_TOKEN_QUERY,
    ], signal);
    if (signal?.aborted || result.terminated) return { kind: "terminated" };
    if (result.code === 127) {
      sqliteUnavailable = true;
      continue;
    }
    if (result.code !== 0) {
      continue;
    }
    const value = result.stdout.trim();
    if (nonEmptyString(value)) {
      return { kind: "token", value };
    }
  }
  if (sqliteUnavailable) {
    return { kind: "sqlite-unavailable" };
  }
  return { kind: "missing" };
}

/** Reads Cursor session credentials from local state first, then CURSOR_SESSION_TOKEN. */
export async function readCursorAuth(options: CursorAuthOptions = {}): Promise<CursorAuthResult> {
  if (options.signal?.aborted) return { state: "error", reason: "sqlite-failed" };
  const homeDirectory = options.homeDirectory ?? homedir();
  const runSqlite = options.runSqlite ?? defaultRunSqlite;
  const candidates = options.stateDbCandidates ?? defaultStateDbCandidates(homeDirectory);
  const local = await readLocalToken(candidates, runSqlite, options.signal);
  if (options.signal?.aborted || local.kind === "terminated") {
    return { state: "error", reason: "sqlite-failed" };
  }

  if (local.kind === "token") {
    return { state: "available", credential: { kind: "session", value: local.value } };
  }
  const envToken = options.environment?.CURSOR_SESSION_TOKEN;
  if (nonEmptyString(envToken)) {
    return { state: "available", credential: { kind: "session", value: envToken.trim() } };
  }

  if (local.kind === "sqlite-unavailable") {
    return { state: "error", reason: "sqlite-unavailable" };
  }
  return { state: "auth-needed", reason: "missing-local" };
}
