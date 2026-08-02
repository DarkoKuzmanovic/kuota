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
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export interface CursorAuthOptions {
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

async function defaultRunSqlite(
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnFailed = false;
    const child = spawn("/usr/bin/sqlite3", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = true;
      if (error.code === "ENOENT") {
        resolve({ code: 127, stdout: "", stderr: "sqlite3 unavailable" });
        return;
      }
      resolve({ code: 1, stdout: "", stderr: "sqlite spawn failed" });
    });
    child.on("close", (code) => {
      if (spawnFailed) {
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readLocalToken(
  candidates: readonly string[],
  runSqlite: CursorSqliteRunner,
): Promise<
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "sqlite-unavailable" }
  | { readonly kind: "missing" }
> {
  let sqliteUnavailable = false;
  for (const dbPath of candidates) {
    const result = await runSqlite([
      `file:${dbPath}?mode=ro&immutable=1`,
      ACCESS_TOKEN_QUERY,
    ]);
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
  const homeDirectory = options.homeDirectory ?? homedir();
  const runSqlite = options.runSqlite ?? defaultRunSqlite;
  const candidates = options.stateDbCandidates ?? defaultStateDbCandidates(homeDirectory);
  const local = await readLocalToken(candidates, runSqlite);

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
