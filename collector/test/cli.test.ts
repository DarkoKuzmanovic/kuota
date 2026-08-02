import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  collect,
  type CollectionClock,
  type CollectionTimers,
} from "../src/collect/collect.js";
import {
  createNormalizedProviderResult,
  ProviderAdapterError,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderNormalizedResult,
  type ProviderStaleRecordFor,
} from "../src/providers/types.js";
import {
  createProviderRegistration,
  createProviderRegistry,
  type ConfiguredProvider,
  type ProviderRegistration,
} from "../src/providers/registry.js";
import type { ProviderId } from "../src/contract/schema-v1.js";

const FIXED_NOW = Date.parse("2026-07-11T12:00:00.000Z");

const fixedClock: CollectionClock = {
  now: () => FIXED_NOW,
};

class ManualTimers implements CollectionTimers {
  private readonly callbacks: Array<() => void> = [];

  setTimeout(callback: () => void, _delayMs: number): unknown {
    this.callbacks.push(callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle !== "function") return;
    const callback = handle as () => void;
    const index = this.callbacks.indexOf(callback);
    if (index >= 0) this.callbacks.splice(index, 1);
  }

  fireAll(): void {
    const callbacks = this.callbacks.splice(0);
    for (const callback of callbacks) callback();
  }
}

function adapterFor<TId extends ProviderId>(
  id: TId,
  collectAdapter: (
    context: ProviderAdapterContext,
  ) => Promise<ProviderNormalizedResult<TId>>,
): ProviderAdapter<TId> {
  return { id, collect: collectAdapter };
}

function registryFor(
  adapters: readonly [
    ProviderAdapter<"claude">,
    ProviderAdapter<"codex">,
    ProviderAdapter<"grok">,
  ],
) {
  return createProviderRegistry([
    createProviderRegistration(adapters[0]),
    createProviderRegistration(adapters[1]),
    createProviderRegistration(adapters[2]),
  ] as ProviderRegistration[]);
}

function okResult<TId extends ProviderId>(id: TId): ProviderNormalizedResult<TId> {
  return createNormalizedProviderResult(id, { id, state: "ok" });
}

function enabledProviders(): readonly ConfiguredProvider[] {
  return [
    { id: "claude", enabled: true },
    { id: "codex", enabled: true },
    { id: "grok", enabled: true },
  ];
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("collects enabled providers concurrently and returns canonical order once", async () => {
  const started: ProviderId[] = [];
  const completion = new Map<ProviderId, () => void>();
  const invocationCounts = new Map<ProviderId, number>();

  function delayed<TId extends ProviderId>(id: TId): ProviderAdapter<TId> {
    return adapterFor(id, async () => {
      started.push(id);
      invocationCounts.set(id, (invocationCounts.get(id) ?? 0) + 1);
      await new Promise<void>((resolve) => completion.set(id, resolve));
      return okResult(id);
    });
  }

  const registry = registryFor([
    delayed("claude"),
    delayed("codex"),
    delayed("grok"),
  ]);
  const pending = collect({
    registry,
    config: { providers: enabledProviders(), timeoutMs: 100 },
    clock: fixedClock,
    timers: new ManualTimers(),
  });

  await nextTurn();
  assert.deepEqual(started, ["claude", "codex", "grok"]);
  assert.deepEqual(
    [...invocationCounts.entries()],
    [
      ["claude", 1],
      ["codex", 1],
      ["grok", 1],
    ],
  );

  completion.get("codex")?.();
  completion.get("claude")?.();
  completion.get("grok")?.();
  const document = await pending;

  assert.deepEqual(
    document.providers.map((provider) => provider.id),
    ["claude", "codex", "grok"],
  );
  assert.deepEqual(
    document.providers.map((provider) => provider.state),
    ["ok", "ok", "ok"],
  );
});

test("bounds an abort-ignoring provider and consumes its late rejection", async () => {
  const timers = new ManualTimers();
  let rejectLate: ((reason?: unknown) => void) | undefined;
  let aborted = false;
  const adapter = adapterFor("claude", ({ signal }) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise<ProviderNormalizedResult<"claude">>((_resolve, reject) => {
      rejectLate = reject;
    });
  });
  const registry = registryFor([
    adapter,
    adapterFor("codex", async () => okResult("codex")),
    adapterFor("grok", async () => okResult("grok")),
  ]);

  const pending = collect({
    registry,
    config: {
      providers: [{ id: "claude", enabled: true }],
      timeoutMs: 25,
    },
    clock: fixedClock,
    timers,
  });
  await nextTurn();
  timers.fireAll();
  const document = await pending;

  assert.equal(aborted, true);
  assert.deepEqual(document.providers.map((provider) => provider.state), ["error"]);
  rejectLate?.(new Error("synthetic late failure"));
  await nextTurn();
});

test("parent abort cancels every independent provider budget", async () => {
  const parent = new AbortController();
  const timers = new ManualTimers();
  const aborted: ProviderId[] = [];
  function abortIgnoring<TId extends ProviderId>(id: TId): ProviderAdapter<TId> {
    return adapterFor(id, ({ signal }) => {
      signal.addEventListener("abort", () => aborted.push(id));
      return new Promise<ProviderNormalizedResult<TId>>(() => undefined);
    });
  }

  const pending = collect({
    registry: registryFor([
      abortIgnoring("claude"),
      abortIgnoring("codex"),
      abortIgnoring("grok"),
    ]),
    config: { providers: enabledProviders(), timeoutMs: 100 },
    signal: parent.signal,
    clock: fixedClock,
    timers,
  });
  await nextTurn();
  parent.abort();
  const document = await pending;

  assert.deepEqual(aborted, ["claude", "codex", "grok"]);
  assert.deepEqual(
    document.providers.map((provider) => provider.state),
    ["error", "error", "error"],
  );
});


test("does not invoke providers when the parent is already aborted", async () => {
  const parent = new AbortController();
  parent.abort();
  const timers = new ManualTimers();
  const invoked: ProviderId[] = [];
  const adapter = <TId extends ProviderId>(id: TId): ProviderAdapter<TId> =>
    adapterFor(id, async () => {
      invoked.push(id);
      return okResult(id);
    });

  const document = await collect({
    registry: registryFor([adapter("claude"), adapter("codex"), adapter("grok")]),
    config: { providers: enabledProviders(), timeoutMs: 100 },
    signal: parent.signal,
    clock: fixedClock,
    timers,
  });

  assert.deepEqual(invoked, []);
  assert.deepEqual(document.providers.map((provider) => provider.state), [
    "error",
    "error",
    "error",
  ]);
});


test("does not invoke providers after the collection deadline has expired", async () => {
  const invoked: ProviderId[] = [];
  const adapter = <TId extends ProviderId>(id: TId): ProviderAdapter<TId> =>
    adapterFor(id, async () => {
      invoked.push(id);
      return okResult(id);
    });

  const document = await collect({
    registry: registryFor([adapter("claude"), adapter("codex"), adapter("grok")]),
    config: {
      providers: enabledProviders(),
      timeoutMs: 100,
      deadlineAt: "2026-07-11T11:59:59.999Z",
    },
    clock: fixedClock,
    timers: new ManualTimers(),
  });

  assert.deepEqual(invoked, []);
  assert.deepEqual(document.providers.map((provider) => provider.state), [
    "error",
    "error",
    "error",
  ]);
});

test("converts thrown adapter failures and invalid results into safe provider errors", async () => {
  const invalidAdapter = adapterFor(
    "claude",
    async () =>
      ({ id: "claude", state: "ok", credentials: { access: "synthetic" } }) as unknown as ProviderNormalizedResult<"claude">,
  );
  const throwingAdapter = adapterFor(
    "grok",
    async () => {
      throw new Error("Bearer should never be echoed");
    },
  );
  const document = await collect({
    registry: registryFor([
      invalidAdapter,
      adapterFor("codex", async () => okResult("codex")),
      throwingAdapter,
    ]),
    config: { providers: enabledProviders(), timeoutMs: 100 },
    clock: fixedClock,
    timers: new ManualTimers(),
  });

  assert.deepEqual(
    document.providers.map((provider) => ({ id: provider.id, state: provider.state, status: provider.status })),
    [
      { id: "claude", state: "error", status: "Provider unavailable" },
      { id: "codex", state: "ok", status: undefined },
      { id: "grok", state: "error", status: "Provider unavailable" },
    ],
  );
});

interface CapturedOutput {
  readonly chunks: string[];
  write(chunk: string): void;
}

function capturedOutput(): CapturedOutput {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk) => chunks.push(chunk),
  };
}

test("CLI writes one schema-valid JSON document and no normal diagnostics", async () => {
  const stdout = capturedOutput();
  const stderr = capturedOutput();
  const { runCli } = await import("../src/cli.js");
  const exitCode = await runCli({
    registry: registryFor([
      adapterFor("claude", async () => okResult("claude")),
      adapterFor("codex", async () => okResult("codex")),
      adapterFor("grok", async () => okResult("grok")),
    ]),
    config: { providers: enabledProviders(), timeoutMs: 100 },
    clock: fixedClock,
    timers: new ManualTimers(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.chunks.length, 1);
  assert.equal(stderr.chunks.length, 0);
  assert.equal(stdout.chunks[0]?.endsWith("\n"), true);
  const parsed: unknown = JSON.parse(stdout.chunks[0] ?? "");
  const validation = (await import("../src/contract/validate.js")).validateCollectorDocument(parsed);
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.equal(validation.value.collectionStartedAt, "2026-07-11T12:00:00.000Z");
    assert.equal(validation.value.collectionFinishedAt, "2026-07-11T12:00:00.000Z");
  }
});

test("CLI keeps partial and all-provider failures in the JSON contract", async () => {
  const { runCli } = await import("../src/cli.js");
  for (const adapters of [
    [
      adapterFor("claude", async () => okResult("claude")),
      adapterFor("codex", async () => okResult("codex")),
      adapterFor("grok", async () => {
        throw new Error("synthetic provider failure");
      }),
    ],
    [
      adapterFor("claude", async () => {
        throw new Error("synthetic provider failure");
      }),
      adapterFor("codex", async () => {
        throw new Error("synthetic provider failure");
      }),
      adapterFor("grok", async () => {
        throw new Error("synthetic provider failure");
      }),
    ],
  ] as const) {
    const stdout = capturedOutput();
    const stderr = capturedOutput();
    const exitCode = await runCli({
      registry: registryFor(adapters),
      config: { providers: enabledProviders(), timeoutMs: 100 },
      clock: fixedClock,
      timers: new ManualTimers(),
      stdout,
      stderr,
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout.chunks.length, 1);
    assert.equal(stderr.chunks.length, 0);
    const parsed: unknown = JSON.parse(stdout.chunks[0] ?? "");
    const providers = (await import("../src/contract/validate.js")).validateCollectorDocument(parsed);
    assert.equal(providers.ok, true);
  }
});

test("CLI emits one constant redacted diagnostic for catastrophic configuration", async () => {
  const stdout = capturedOutput();
  const stderr = capturedOutput();
  const { CLI_FAILURE_DIAGNOSTIC, runCli } = await import("../src/cli.js");
  const exitCode = await runCli({
    config: {
      providers: [{ id: "account-secret-123", enabled: true }],
      timeoutMs: 0,
    },
    clock: fixedClock,
    timers: new ManualTimers(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(stdout.chunks, []);
  assert.deepEqual(stderr.chunks, [`${CLI_FAILURE_DIAGNOSTIC}\n`]);
  assert.equal(stderr.chunks.join("").includes("account-secret-123"), false);
});

test("direct CLI converts a throwing native abort listener into one safe failure", () => {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceCli = resolve(sourceDirectory, "../src/cli.js");
  const registryModule = pathToFileURL(
    resolve(sourceDirectory, "../src/providers/registry.js"),
  ).href;
  const temporaryHome = mkdtempSync(join(tmpdir(), "kuota-cli-"));
  mkdirSync(join(temporaryHome, ".cache"), { mode: 0o700 });
  const hookPath = join(temporaryHome, "abort-hook.mjs");
  writeFileSync(
    hookPath,
    `const originalSetTimeout = globalThis.setTimeout;
const registry = await import(${JSON.stringify(registryModule)});
globalThis.setTimeout = (callback, delay, ...args) =>
  originalSetTimeout(callback, Math.min(delay, 5), ...args);
for (const adapter of registry.PLACEHOLDER_ADAPTERS) {
  adapter.collect = ({ signal }) => new Promise(() => {
    signal.addEventListener("abort", () => {
      throw new Error("synthetic abort-listener marker");
    }, { once: true });
  });
}
    `,
    "utf8",
  );
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: temporaryHome };
  delete env.UMANS_API_KEY;

  try {
    const child = spawnSync(process.execPath, ["--import", hookPath, sourceCli], {
      encoding: "utf8",
      env,
    });
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "Kuota collector failed\n");
    assert.equal(child.stderr.includes("synthetic abort-listener marker"), false);
    assert.equal(child.stderr.includes("    at "), false);
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("CLI reports serializer failure before attempting stdout", async () => {
  const stdout = capturedOutput();
  const stderr = capturedOutput();
  const originalStringify = JSON.stringify;
  Object.defineProperty(JSON, "stringify", {
    configurable: true,
    value: () => {
      throw new Error("synthetic serializer failure");
    },
  });

  try {
    const { runCli } = await import("../src/cli.js");
    const exitCode = await runCli({
      config: { providers: [], timeoutMs: 100 },
      clock: fixedClock,
      timers: new ManualTimers(),
      stdout,
      stderr,
    });
    assert.equal(exitCode, 1);
  } finally {
    Object.defineProperty(JSON, "stringify", {
      configurable: true,
      writable: true,
      value: originalStringify,
    });
  }

  assert.deepEqual(stdout.chunks, []);
  assert.deepEqual(stderr.chunks, ["Kuota collector failed\n"]);
});

test("CLI makes one pre-serialized stdout write and handles a pre-write failure", async () => {
  const stderr = capturedOutput();
  let writeAttempts = 0;
  const writes: string[] = [];
  const stdout = {
    write(chunk: string): void {
      writeAttempts += 1;
      void chunk;
      throw new Error("synthetic writer failure before write");
    },
  };
  const { runCli } = await import("../src/cli.js");
  const exitCode = await runCli({
    config: { providers: [], timeoutMs: 100 },
    clock: fixedClock,
    timers: new ManualTimers(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.equal(writeAttempts, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(stderr.chunks, ["Kuota collector failed\n"]);
});

test("source CLI exposes callable library entry points without direct process handlers", async () => {
  const uncaughtBefore = process.listenerCount("uncaughtException");
  const rejectionBefore = process.listenerCount("unhandledRejection");
  const { main, runCli } = await import("../src/cli.js");
  assert.equal(typeof main, "function");
  assert.equal(typeof runCli, "function");
  assert.equal(process.listenerCount("uncaughtException"), uncaughtBefore);
  assert.equal(process.listenerCount("unhandledRejection"), rejectionBefore);
});

test("maps auth and stale failures safely, degrading invalid retention to error", async () => {
  const stale: ProviderStaleRecordFor<"claude"> = {
    id: "claude",
    state: "stale",
    lastSuccessAt: "2026-07-10T12:00:00.000Z",
    windows: [{ id: "weekly", label: "Weekly", used: 4 }],
  };
  const invalidStale = {
    id: "grok",
    state: "stale",
    lastSuccessAt: "2026-07-10T12:00:00.000Z",
  } as ProviderStaleRecordFor<"grok">;
  const document = await collect({
    registry: registryFor([
      adapterFor("claude", async () => {
        throw new ProviderAdapterError("stale");
      }),
      adapterFor("codex", async () => {
        throw new ProviderAdapterError("auth-needed");
      }),
      adapterFor("grok", async () => {
        throw new ProviderAdapterError("stale");
      }),
    ]),
    config: {
      providers: enabledProviders(),
      timeoutMs: 25,
      retainedStaleRecords: { claude: stale, grok: invalidStale },
    },
    clock: fixedClock,
    timers: new ManualTimers(),
  });

  assert.deepEqual(
    document.providers.map((provider) => ({ id: provider.id, state: provider.state })),
    [
      { id: "claude", state: "stale" },
      { id: "codex", state: "auth-needed" },
      { id: "grok", state: "error" },
    ],
  );
  assert.equal(document.providers[0]?.status, "Using last known data");
});

test("passes bounded UTC deadline context to each provider", async () => {
  const contexts: Array<{ timeoutMs: number | undefined; deadlineAt: string | undefined }> = [];
  const capture = <TId extends ProviderId>(id: TId): ProviderAdapter<TId> =>
    adapterFor(id, async (context) => {
      contexts.push({ timeoutMs: context.timeoutMs, deadlineAt: context.deadlineAt });
      return okResult(id);
    });
  await collect({
    registry: registryFor([capture("claude"), capture("codex"), capture("grok")]),
    config: { providers: enabledProviders(), timeoutMs: 25 },
    clock: fixedClock,
    timers: new ManualTimers(),
  });

  assert.deepEqual(contexts, [
    { timeoutMs: 25, deadlineAt: "2026-07-11T12:00:00.025Z" },
    { timeoutMs: 25, deadlineAt: "2026-07-11T12:00:00.025Z" },
    { timeoutMs: 25, deadlineAt: "2026-07-11T12:00:00.025Z" },
  ]);
});

const CLI_ARGV_SECRET = "synthetic-cli-argv-secret-value";

async function importCliArgv(): Promise<{
  parseCliArgv: (argv: unknown) => unknown;
  CliArgvParseError: new () => Error;
}> {
  return import("../src/cli.js") as Promise<{
    parseCliArgv: (argv: unknown) => unknown;
    CliArgvParseError: new () => Error;
  }>;
}

function assertValueFreeArgvError(
  action: () => unknown,
  errorClass: new () => Error,
): void {
  assert.throws(action, (error: unknown) => {
    if (!(error instanceof errorClass)) return false;
    assert.equal((error as Error).message.includes(CLI_ARGV_SECRET), false);
    return true;
  });
}

test("parseCliArgv accepts no arguments and returns no configuration input", async () => {
  const { parseCliArgv } = await importCliArgv();
  assert.equal(parseCliArgv([]), undefined);
});

test("parseCliArgv parses a single enabled-providers option including the empty set", async () => {
  const { parseCliArgv } = await importCliArgv();
  assert.deepEqual(parseCliArgv(["--enabled-providers=claude"]), {
    enabledProviders: ["claude"],
  });
  assert.deepEqual(parseCliArgv(["--enabled-providers=claude,umans,codex"]), {
    enabledProviders: ["claude", "umans", "codex"],
  });
  assert.deepEqual(parseCliArgv(["--enabled-providers="]), { enabledProviders: [] });
});

test("parseCliArgv rejects missing equals, extra arguments, positionals, and secret-shaped options", async () => {
  const { parseCliArgv, CliArgvParseError } = await importCliArgv();
  for (const argv of [
    ["--enabled-providers"],
    ["--enabled-providers=claude", "extra"],
    ["extra", "--enabled-providers=claude"],
    ["claude"],
    [`--access-token=${CLI_ARGV_SECRET}`],
    [`--enabled-providers=claude`, `--access-token=${CLI_ARGV_SECRET}`],
  ]) {
    assertValueFreeArgvError(() => parseCliArgv(argv), CliArgvParseError);
  }
});

test("parseCliArgv rejects hostile arrays, proxies, and accessor-shaped argv without invoking them", async () => {
  const { parseCliArgv, CliArgvParseError } = await importCliArgv();

  const proxyArgv = new Proxy(["--enabled-providers=claude"], {});
  const arrayLike = { 0: "--enabled-providers=claude", length: 1 };
  const accessorArgv: string[] = ["--enabled-providers=claude"];
  Object.defineProperty(accessorArgv, "0", {
    configurable: true,
    enumerable: true,
    get: (): string => {
      throw new Error(CLI_ARGV_SECRET);
    },
  });
  const symbolArgv: unknown[] = ["--enabled-providers=claude"];
  (symbolArgv as unknown as Record<PropertyKey, unknown>)[Symbol("synthetic")] = CLI_ARGV_SECRET;
  const sparseArgv: unknown[] = [];
  sparseArgv.length = 1;

  for (const argv of [
    undefined,
    null,
    "--enabled-providers=claude",
    42,
    proxyArgv,
    arrayLike,
    accessorArgv,
    symbolArgv,
    sparseArgv,
  ]) {
    assertValueFreeArgvError(() => parseCliArgv(argv), CliArgvParseError);
  }
});

test("CLI transport composes with parseCollectorConfig for canonical order and rejects semantic violations", async () => {
  const { parseCliArgv } = await importCliArgv();
  const { parseCollectorConfig, DEFAULT_COLLECTOR_CONFIG, CollectorConfigParseError } = await import(
    "../src/collect/config.js"
  );

  assert.deepEqual(parseCollectorConfig(parseCliArgv([])), DEFAULT_COLLECTOR_CONFIG);
  assert.deepEqual(
    parseCollectorConfig(parseCliArgv(["--enabled-providers=codex,claude"])),
    parseCollectorConfig({ enabledProviders: ["claude", "codex"] }),
  );
  const allDisabled = parseCollectorConfig(parseCliArgv(["--enabled-providers="]));
  assert.deepEqual(
    allDisabled.providers.map((provider) => provider.enabled),
    [false, false, false, false, false],
  );

  for (const argv of [
    ["--enabled-providers=claude,claude"],
    ["--enabled-providers=unknown-provider"],
    ["--enabled-providers= claude"],
    ["--enabled-providers=claude, codex"],
    ["--enabled-providers=claude,,codex"],
    ["--enabled-providers=claude,"],
  ]) {
    assertValueFreeArgvError(
      () => parseCollectorConfig(parseCliArgv(argv)),
      CollectorConfigParseError,
    );
  }
});

test("direct CLI accepts a safe enabled-providers subset with no live credentials or network", () => {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceCli = resolve(sourceDirectory, "../src/cli.js");
  const temporaryHome = mkdtempSync(join(tmpdir(), "kuota-cli-transport-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: temporaryHome };
  delete env.UMANS_API_KEY;

  try {
    const child = spawnSync(process.execPath, [sourceCli, "--enabled-providers=claude"], {
      encoding: "utf8",
      env,
    });
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout.endsWith("\n"), true);
    const parsed: unknown = JSON.parse(child.stdout);
    assert.deepEqual(
      (parsed as { providers: Array<{ id: string }> }).providers.map((provider) => provider.id),
      ["claude"],
    );
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("direct CLI rejects malformed transport with one constant diagnostic and no leaked argument", () => {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceCli = resolve(sourceDirectory, "../src/cli.js");
  const temporaryHome = mkdtempSync(join(tmpdir(), "kuota-cli-transport-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: temporaryHome };
  delete env.UMANS_API_KEY;

  try {
    for (const args of [
      ["--enabled-providers=claude", "extra"],
      [`--access-token=${CLI_ARGV_SECRET}`],
      ["--enabled-providers=unknown-provider"],
    ]) {
      const child = spawnSync(process.execPath, [sourceCli, ...args], {
        encoding: "utf8",
        env,
      });
      assert.equal(child.status, 1);
      assert.equal(child.stdout, "");
      assert.equal(child.stderr, "Kuota collector failed\n");
      assert.equal(child.stderr.includes(CLI_ARGV_SECRET), false);
    }
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});