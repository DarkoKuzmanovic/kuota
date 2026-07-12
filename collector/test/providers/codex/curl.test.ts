import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import type { CodexOAuthCredential } from "../../../src/providers/codex/auth.js";
import {
  CODEX_CURL_STATUS_MARKER,
  curlCodexUsage,
  type CodexCurlChild,
  type CodexCurlOptions,
  type CodexCurlReadable,
  type CodexCurlResult,
  type CodexCurlSpawn,
  type CodexCurlWritable,
} from "../../../src/providers/codex/curl.js";

const ACCESS = "synthetic-codex-curl-access-not-real";
const ACCOUNT_ID = "synthetic-codex-curl-account-not-real";
const CREDENTIAL: CodexOAuthCredential = { access: ACCESS, accountId: ACCOUNT_ID };

type Listener = (...args: readonly unknown[]) => void;

class FakeEvents {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly onceOriginals = new WeakMap<Listener, Listener>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    this.onceOriginals.set(wrapped, listener);
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener);
    if (listeners !== undefined) {
      for (const candidate of listeners) {
        if (this.onceOriginals.get(candidate) === listener) listeners.delete(candidate);
      }
    }
    return this;
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }

  emit(event: string, ...args: readonly unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

class FakeReadable extends FakeEvents implements CodexCurlReadable {
  emitData(value: string): void {
    this.emit("data", Buffer.from(value));
  }

  emitEnd(): void {
    this.emit("end");
  }

  emitError(): void {
    this.emit("error", new Error(`synthetic stream failure ${ACCESS} ${ACCOUNT_ID}`));
  }
}

class FakeWritable extends FakeEvents implements CodexCurlWritable {
  readonly writes: string[] = [];
  ended = false;

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  emitError(): void {
    this.emit("error", new Error(`synthetic stdin failure ${ACCESS} ${ACCOUNT_ID}`));
  }
}

class FakeChild extends FakeEvents implements CodexCurlChild {
  readonly stdin: FakeWritable | null = new FakeWritable();
  readonly stdout: FakeReadable | null = new FakeReadable();
  readonly stderr: FakeReadable | null = new FakeReadable();
  kills = 0;

  kill(): boolean {
    this.kills += 1;
    return true;
  }

  emitClose(code: number | null): void {
    this.emit("close", code, null);
  }

  emitError(): void {
    this.emit("error", new Error(`synthetic spawn failure ${ACCESS} ${ACCOUNT_ID}`));
  }
}

interface Capture {
  calls: number;
  command?: string;
  args?: readonly string[];
  options?: unknown;
}

function spawnFor(child: FakeChild): { readonly spawn: CodexCurlSpawn; readonly capture: Capture } {
  const capture: Capture = { calls: 0 };
  return {
    capture,
    spawn: (command, args, options): CodexCurlChild => {
      capture.calls += 1;
      capture.command = command;
      capture.args = args;
      capture.options = options;
      return child;
    },
  };
}

function run(
  spawn: CodexCurlSpawn,
  extra: Omit<CodexCurlOptions, "credential" | "spawn" | "signal"> & { readonly signal?: AbortSignal } = {},
): Promise<CodexCurlResult> {
  return curlCodexUsage({
    credential: CREDENTIAL,
    signal: extra.signal ?? new AbortController().signal,
    spawn,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    ...(extra.maxResponseBytes === undefined ? {} : { maxResponseBytes: extra.maxResponseBytes }),
    ...(extra.maxStderrBytes === undefined ? {} : { maxStderrBytes: extra.maxStderrBytes }),
  });
}

function framed(status: number, body: string): string {
  return `${body}${CODEX_CURL_STATUS_MARKER}${status}\n`;
}

function assertError(result: CodexCurlResult, reason: string): void {
  assert.equal(result.outcome, "error");
  if (result.outcome === "error") assert.equal(result.reason, reason);
}

function assertValueFree(result: CodexCurlResult): void {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ACCESS), false);
  assert.equal(serialized.includes(ACCOUNT_ID), false);
}

test("spawns exactly curl --config - and supplies the bounded approved request only through stdin", async () => {
  const child = new FakeChild();
  const { spawn, capture } = spawnFor(child);
  const resultPromise = run(spawn);

  child.stdout?.emitData(framed(200, '{"rate_limit":{}}'));
  child.stdout?.emitEnd();
  child.stderr?.emitEnd();
  child.emitClose(0);
  const result = await resultPromise;

  assert.deepEqual(result, { outcome: "ok", value: { rate_limit: {} } });
  assert.equal(capture.calls, 1);
  assert.equal(capture.command, "curl");
  assert.deepEqual(capture.args, ["--config", "-"]);
  assert.deepEqual(capture.options, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(capture.args?.join(" ").includes(ACCESS), false);
  assert.equal(capture.args?.join(" ").includes(ACCOUNT_ID), false);

  const config = child.stdin?.writes.join("") ?? "";
  assert.equal(child.stdin?.ended, true);
  assert.equal(config.includes(ACCESS), true);
  assert.equal(config.includes(ACCOUNT_ID), true);
  assert.equal(config.includes("https://chatgpt.com/backend-api/wham/usage"), true);
  assert.equal(config.includes('request = "GET"'), true);
  assert.equal(config.includes('max-time = "15"'), true);
  assert.equal(config.includes('header = "Authorization: Bearer '), true);
  assert.equal(config.includes('header = "chatgpt-account-id: '), true);
  assert.equal(config.includes('header = "OpenAI-Beta: responses=experimental"'), true);
  assert.equal(config.includes('header = "User-Agent: '), true);
  assert.equal(config.includes("\\\\n__KUOTA_CURL_HTTP_STATUS__"), true);
});

test("exercises the production spawn adapter through an executable curl stub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kuota-codex-curl-stub-"));
  const executable = join(directory, "curl");
  const output = framed(200, '{"rate_limit":{"allowed":true}}');
  const script = [
    "#!/usr/bin/env node",
    'let config = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { config += chunk; });',
    'process.stdin.on("end", () => {',
    '  const validArgs = process.argv[2] === "--config" && process.argv[3] === "-" && process.argv.length === 4;',
    '  const validConfig = config.includes("Authorization: Bearer") && config.includes("__KUOTA_CURL_HTTP_STATUS__");',
    '  if (!validArgs || !validConfig) process.exit(9);',
    `  process.stdout.write(${JSON.stringify(output)});`,
    "});",
    "",
  ].join("\n");
  await writeFile(executable, script, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
  try {
    const result = await curlCodexUsage({
      credential: CREDENTIAL,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    assert.deepEqual(result, {
      outcome: "ok",
      value: { rate_limit: { allowed: true } },
    });
    assertValueFree(result);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps only framed 401 and 403 responses to auth-needed", async () => {
  for (const status of [401, 403]) {
    const child = new FakeChild();
    const resultPromise = run(spawnFor(child).spawn);
    child.stdout?.emitData(framed(status, ""));
    child.stdout?.emitEnd();
    child.stderr?.emitEnd();
    child.emitClose(0);
    const result = await resultPromise;
    assert.deepEqual(result, { outcome: "auth-needed" });
    assertValueFree(result);
  }
});

test("uses only the final status frame when a valid JSON body contains marker text", async () => {
  const child = new FakeChild();
  const resultPromise = run(spawnFor(child).spawn);
  const payload = { note: `${CODEX_CURL_STATUS_MARKER}200\n` };
  child.stdout?.emitData(framed(200, JSON.stringify(payload)));
  child.emitClose(0);

  assert.deepEqual(await resultPromise, { outcome: "ok", value: payload });
});

test("rejects control-bearing credentials before spawning", async () => {
  const child = new FakeChild();
  const { spawn, capture } = spawnFor(child);
  const result = await curlCodexUsage({
    credential: { access: `${ACCESS}\nnext`, accountId: ACCOUNT_ID },
    signal: new AbortController().signal,
    spawn,
  });

  assertError(result, "invalid-config");
  assert.equal(capture.calls, 0);
  assertValueFree(result);
});

test("makes malformed framing, malformed JSON, nonzero exits, and spawn errors value-free failures", async () => {
  const cases: readonly {
    readonly output?: string;
    readonly exit?: number;
    readonly spawnError?: boolean;
    readonly reason: string;
  }[] = [
    { output: '{"rate_limit":{}}', exit: 0, reason: "malformed-response" },
    { output: framed(200, "not json"), exit: 0, reason: "malformed-response" },
    { output: framed(200, '{"rate_limit":{}}'), exit: 22, reason: "nonzero-exit" },
    { spawnError: true, reason: "unavailable" },
  ];

  for (const entry of cases) {
    const child = new FakeChild();
    const resultPromise = run(spawnFor(child).spawn);
    if (entry.spawnError) {
      child.emitError();
    } else {
      child.stdout?.emitData(entry.output ?? "");
      child.stdout?.emitEnd();
      child.stderr?.emitEnd();
      child.emitClose(entry.exit ?? 0);
    }
    const result = await resultPromise;
    assertError(result, entry.reason);
    assertValueFree(result);
  }
});

test("bounds stdout and stderr, terminates once, and never returns child diagnostics", async () => {
  for (const mode of ["stdout", "stderr"] as const) {
    const child = new FakeChild();
    const resultPromise = run(spawnFor(child).spawn, {
      maxResponseBytes: 8,
      maxStderrBytes: 8,
    });
    if (mode === "stdout") child.stdout?.emitData("x".repeat(64));
    else child.stderr?.emitData(`${ACCESS}${ACCOUNT_ID}`);
    const result = await resultPromise;
    assertError(result, "oversized-output");
    assert.equal(child.kills, 1);
    assertValueFree(result);
  }
});

test("handles timeout, caller abort, and stdin error races with one termination and one constant outcome", async () => {
  const timedChild = new FakeChild();
  const timed = run(spawnFor(timedChild).spawn, { timeoutMs: 1 });
  const timedResult = await timed;
  assertError(timedResult, "timeout");
  assert.equal(timedChild.kills, 1);
  timedChild.emitClose(1);
  assert.equal(timedChild.listenerCount(), 0);
  assert.equal(timedChild.stdin?.listenerCount(), 0);
  assert.equal(timedChild.stdout?.listenerCount(), 0);
  assert.equal(timedChild.stderr?.listenerCount(), 0);

  const controller = new AbortController();
  const abortedChild = new FakeChild();
  const aborted = run(spawnFor(abortedChild).spawn, { signal: controller.signal });
  controller.abort();
  abortedChild.stdin?.emitError();
  abortedChild.emitClose(1);
  const abortedResult = await aborted;
  assertError(abortedResult, "aborted");
  assert.equal(abortedChild.kills, 1);
  assertValueFree(abortedResult);
  assert.equal(abortedChild.listenerCount(), 0);
  assert.equal(abortedChild.stdin?.listenerCount(), 0);
  assert.equal(abortedChild.stdout?.listenerCount(), 0);
  assert.equal(abortedChild.stderr?.listenerCount(), 0);
});
