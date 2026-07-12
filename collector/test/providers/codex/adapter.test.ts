import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexAdapter,
  type CodexAdapterDependencies,
} from "../../../src/providers/codex/adapter.js";
import type { CodexAuthResult, CodexOAuthCredential } from "../../../src/providers/codex/auth.js";
import type { CodexCurlResult } from "../../../src/providers/codex/curl.js";
import type { CodexFetchResult } from "../../../src/providers/codex/fetch.js";
import type { CodexPersistOutcome } from "../../../src/providers/codex/persist.js";
import type { CodexRefreshResult } from "../../../src/providers/codex/refresh.js";
import type { CodexUsageParseResult } from "../../../src/providers/codex/usage.js";
import type { ProviderAdapterContext } from "../../../src/providers/types.js";

const NOW = 1_700_000_000_000;
const AUTH_PATH = "/synthetic-home/.pi/agent/auth.json";
const credential: CodexOAuthCredential = {
  access: "synthetic-original-access",
  accountId: "synthetic-account-id",
  refresh: "synthetic-original-refresh",
  expires: NOW + 60_000,
};
const refreshed = {
  access: "synthetic-refreshed-access",
  refresh: "synthetic-rotated-refresh",
  expires: NOW + 120_000,
};
const payload = { rate_limit: { primary_window: { used_percent: 20 } } };

function availableAuth(value: CodexOAuthCredential = credential): CodexAuthResult {
  return { state: "available", status: "Credential available", credential: value };
}

function expiredAuth(): CodexAuthResult {
  return {
    state: "expired-with-refresh",
    status: "Credential refresh required",
    credential: { ...credential, expires: NOW - 1, refresh: credential.refresh ?? "" },
  };
}

function parseSuccess(observedAt: string): CodexUsageParseResult {
  return {
    ok: true,
    record: {
      id: "codex",
      state: "ok",
      lastSuccessAt: observedAt,
      windows: [{ id: "primary", label: "Primary", usedPercent: 20 }],
    },
  };
}

function context(signal = new AbortController().signal): ProviderAdapterContext {
  return { signal, dependencies: {} };
}

type Scenario = {
  readonly name: string;
  readonly auth: CodexAuthResult;
  readonly native?: readonly CodexFetchResult[];
  readonly curl?: readonly CodexCurlResult[];
  readonly refresh?: CodexRefreshResult;
  readonly persist?: CodexPersistOutcome;
  readonly parse?: CodexUsageParseResult;
  readonly state: "ok" | "auth-needed" | "error";
  readonly nativeCalls: number;
  readonly curlCalls: number;
  readonly refreshCalls: number;
  readonly persistCalls: number;
  readonly parseCalls: number;
  readonly credentialAccesses?: readonly string[];
};

const scenarios: readonly Scenario[] = [
  { name: "available native success", auth: availableAuth(), native: [{ outcome: "ok", value: payload }], state: "ok", nativeCalls: 1, curlCalls: 0, refreshCalls: 0, persistCalls: 0, parseCalls: 1 },
  { name: "native 401 then curl success", auth: availableAuth(), native: [{ outcome: "curl-eligible" }], curl: [{ outcome: "ok", value: payload }], state: "ok", nativeCalls: 1, curlCalls: 1, refreshCalls: 0, persistCalls: 0, parseCalls: 1 },
  { name: "native redirect is auth needed without curl", auth: availableAuth(), native: [{ outcome: "auth-needed" }], state: "auth-needed", nativeCalls: 1, curlCalls: 0, refreshCalls: 0, persistCalls: 0, parseCalls: 0 },
  { name: "native transport error is terminal", auth: availableAuth(), native: [{ outcome: "error", reason: "transport" }], state: "error", nativeCalls: 1, curlCalls: 0, refreshCalls: 0, persistCalls: 0, parseCalls: 0 },
  { name: "curl error is terminal without refresh", auth: availableAuth(), native: [{ outcome: "curl-eligible" }], curl: [{ outcome: "error", reason: "transport" }], state: "error", nativeCalls: 1, curlCalls: 1, refreshCalls: 0, persistCalls: 0, parseCalls: 0 },
  { name: "curl auth needed without refresh token", auth: availableAuth({ access: credential.access, accountId: credential.accountId }), native: [{ outcome: "curl-eligible" }], curl: [{ outcome: "auth-needed" }], state: "auth-needed", nativeCalls: 1, curlCalls: 1, refreshCalls: 0, persistCalls: 0, parseCalls: 0 },
  { name: "curl auth needed refreshes then final native success", auth: availableAuth(), native: [{ outcome: "curl-eligible" }, { outcome: "ok", value: payload }], curl: [{ outcome: "auth-needed" }], refresh: { outcome: "ok", credential: refreshed }, persist: "updated", state: "ok", nativeCalls: 2, curlCalls: 1, refreshCalls: 1, persistCalls: 1, parseCalls: 1, credentialAccesses: [credential.access, credential.access, refreshed.access] },
  { name: "curl auth needed refreshes then final curl success at hard call caps", auth: availableAuth(), native: [{ outcome: "curl-eligible" }, { outcome: "curl-eligible" }], curl: [{ outcome: "auth-needed" }, { outcome: "ok", value: payload }], refresh: { outcome: "ok", credential: refreshed }, persist: "updated", state: "ok", nativeCalls: 2, curlCalls: 2, refreshCalls: 1, persistCalls: 1, parseCalls: 1, credentialAccesses: [credential.access, credential.access, refreshed.access, refreshed.access] },
  { name: "post refresh curl auth needed never refreshes again", auth: availableAuth(), native: [{ outcome: "curl-eligible" }, { outcome: "curl-eligible" }], curl: [{ outcome: "auth-needed" }, { outcome: "auth-needed" }], refresh: { outcome: "ok", credential: refreshed }, persist: "updated", state: "auth-needed", nativeCalls: 2, curlCalls: 2, refreshCalls: 1, persistCalls: 1, parseCalls: 0, credentialAccesses: [credential.access, credential.access, refreshed.access, refreshed.access] },
  { name: "local expiry refreshes then final native success", auth: expiredAuth(), native: [{ outcome: "ok", value: payload }], refresh: { outcome: "ok", credential: refreshed }, persist: "already-current", state: "ok", nativeCalls: 1, curlCalls: 0, refreshCalls: 1, persistCalls: 1, parseCalls: 1, credentialAccesses: [refreshed.access] },
  { name: "post refresh auth needed never refreshes again", auth: expiredAuth(), native: [{ outcome: "auth-needed" }], refresh: { outcome: "ok", credential: refreshed }, persist: "updated", state: "auth-needed", nativeCalls: 1, curlCalls: 0, refreshCalls: 1, persistCalls: 1, parseCalls: 0, credentialAccesses: [refreshed.access] },
  { name: "malformed normalized response is error", auth: availableAuth(), native: [{ outcome: "ok", value: payload }], parse: { ok: false, reason: "malformed-response", status: "Provider unavailable" }, state: "error", nativeCalls: 1, curlCalls: 0, refreshCalls: 0, persistCalls: 0, parseCalls: 1 },
];

for (const scenario of scenarios) {
  test(`Codex adapter: ${scenario.name}`, async () => {
    const nativeCredentials: CodexOAuthCredential[] = [];
    const curlCredentials: CodexOAuthCredential[] = [];
    const usageCredentialAccesses: string[] = [];
    const parseInputs: unknown[] = [];
    let authPathCalls = 0;
    let authCalls = 0;
    let refreshCalls = 0;
    let persistCalls = 0;
    let nativeIndex = 0;
    let curlIndex = 0;
    const dependencies: CodexAdapterDependencies = {
      resolveAuthPath: () => { authPathCalls += 1; return AUTH_PATH; },
      readAuth: async ({ authPath }) => { authCalls += 1; assert.equal(authPath, AUTH_PATH); return scenario.auth; },
      fetchUsage: async ({ credential: input }) => {
        nativeCredentials.push(input);
        usageCredentialAccesses.push(input.access);
        const result = scenario.native?.[nativeIndex];
        nativeIndex += 1;
        if (result === undefined) throw new Error("unexpected native call");
        return result;
      },
      curlUsage: async ({ credential: input }) => {
        curlCredentials.push(input);
        usageCredentialAccesses.push(input.access);
        const result = scenario.curl?.[curlIndex];
        curlIndex += 1;
        if (result === undefined) throw new Error("unexpected curl call");
        return result;
      },
      refresh: async ({ refreshToken }) => {
        refreshCalls += 1;
        assert.equal(refreshToken, credential.refresh);
        return scenario.refresh ?? { outcome: "error" };
      },
      persist: async ({ authPath, initiatingCredential, refreshedCredential }) => {
        persistCalls += 1;
        assert.equal(authPath, AUTH_PATH);
        assert.equal(initiatingCredential, scenario.auth.state === "expired-with-refresh" ? scenario.auth.credential : credential);
        assert.deepEqual(refreshedCredential, refreshed);
        return scenario.persist ?? "error";
      },
      parseUsage: (input, observedAt) => {
        parseInputs.push(input);
        assert.equal(observedAt, new Date(NOW).toISOString());
        return scenario.parse ?? parseSuccess(observedAt);
      },
      now: () => NOW,
    };
    const adapter = createCodexAdapter(dependencies);
    assert.equal(authPathCalls, 0, "creation must not resolve auth paths");

    const result = await adapter.collect(context());

    assert.equal(result.state, scenario.state);
    assert.equal(authPathCalls, 1);
    assert.equal(authCalls, 1);
    assert.equal(nativeCredentials.length, scenario.nativeCalls);
    assert.equal(curlCredentials.length, scenario.curlCalls);
    assert.equal(refreshCalls, scenario.refreshCalls);
    assert.equal(persistCalls, scenario.persistCalls);
    assert.equal(parseInputs.length, scenario.parseCalls);
    assert.deepEqual(
      usageCredentialAccesses,
      scenario.credentialAccesses ?? [...Array(scenario.nativeCalls + scenario.curlCalls)].map(() => credential.access),
    );
    if (scenario.refreshCalls === 1 && scenario.nativeCalls > 0) {
      const finalCredential = nativeCredentials[nativeCredentials.length - 1];
      assert.equal(finalCredential?.accountId, credential.accountId);
      assert.equal(finalCredential?.refresh, refreshed.refresh);
      assert.equal(finalCredential?.expires, refreshed.expires);
    }
  });
}

test("Codex adapter maps auth classification and every persistence failure to safe terminal states", async () => {
  const authStates: readonly [CodexAuthResult, "auth-needed" | "error"][] = [
    [{ state: "auth-needed", reason: "missing-entry", status: "Authentication required" }, "auth-needed"],
    [{ state: "expired-without-refresh", status: "Authentication required" }, "auth-needed"],
    [{ state: "error", reason: "auth-file-read", status: "Provider unavailable" }, "error"],
  ];
  for (const [auth, expected] of authStates) {
    const result = await createCodexAdapter({
      resolveAuthPath: () => AUTH_PATH,
      readAuth: async () => auth,
    }).collect(context());
    assert.equal(result.state, expected);
  }

  for (const outcome of ["conflict", "error", "indeterminate"] as const) {
    let usageCalls = 0;
    const result = await createCodexAdapter({
      resolveAuthPath: () => AUTH_PATH,
      readAuth: async () => expiredAuth(),
      refresh: async () => ({ outcome: "ok", credential: refreshed }),
      persist: async () => outcome,
      fetchUsage: async () => { usageCalls += 1; return { outcome: "ok", value: payload }; },
    }).collect(context());
    assert.equal(result.state, "error");
    assert.equal(usageCalls, 0, `${outcome} must not use refreshed access`);
  }
});

test("Codex adapter maps local refresh failures without a usage call", async () => {
  for (const refreshResult of [
    { outcome: "auth-needed" } as const,
    { outcome: "error" } as const,
  ]) {
    let usageCalls = 0;
    const result = await createCodexAdapter({
      resolveAuthPath: () => AUTH_PATH,
      readAuth: async () => expiredAuth(),
      refresh: async () => refreshResult,
      fetchUsage: async () => { usageCalls += 1; return { outcome: "ok", value: payload }; },
    }).collect(context());
    assert.equal(result.state, refreshResult.outcome === "auth-needed" ? "auth-needed" : "error");
    assert.equal(usageCalls, 0);
  }
});

test("Codex adapter uses only persistence-guaranteed refresh and expiry fallbacks", async () => {
  let usageCredential: CodexOAuthCredential | undefined;
  const result = await createCodexAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => expiredAuth(),
    refresh: async () => ({ outcome: "ok", credential: { access: "synthetic-fallback-access" } }),
    persist: async () => "updated",
    fetchUsage: async ({ credential: input }) => {
      usageCredential = input;
      return { outcome: "ok", value: payload };
    },
  }).collect(context());
  assert.equal(result.state, "ok");
  assert.deepEqual(usageCredential, {
    access: "synthetic-fallback-access",
    accountId: credential.accountId,
    refresh: credential.refresh,
    expires: NOW - 1,
  });
});

test("Codex adapter turns thrown seams, invalid clocks, and abort into safe errors", async () => {
  const cases: readonly CodexAdapterDependencies[] = [
    { resolveAuthPath: () => { throw new Error("path"); } },
    { resolveAuthPath: () => AUTH_PATH, readAuth: async () => { throw new Error("auth"); } },
    { resolveAuthPath: () => AUTH_PATH, readAuth: async () => availableAuth(), fetchUsage: async () => { throw new Error("native"); } },
    { resolveAuthPath: () => AUTH_PATH, readAuth: async () => availableAuth(), fetchUsage: async () => ({ outcome: "curl-eligible" }), curlUsage: async () => { throw new Error("curl"); } },
    { resolveAuthPath: () => AUTH_PATH, readAuth: async () => expiredAuth(), refresh: async () => { throw new Error("refresh"); } },
    { resolveAuthPath: () => AUTH_PATH, readAuth: async () => expiredAuth(), refresh: async () => ({ outcome: "ok", credential: refreshed }), persist: async () => { throw new Error("persist"); } },
    { resolveAuthPath: () => AUTH_PATH, readAuth: async () => availableAuth(), fetchUsage: async () => ({ outcome: "ok", value: payload }), parseUsage: () => { throw new Error("parse"); } },
    { resolveAuthPath: () => AUTH_PATH, readAuth: async () => availableAuth(), fetchUsage: async () => ({ outcome: "ok", value: payload }), now: () => Number.NaN },
  ];
  for (const dependencies of cases) {
    const result = await createCodexAdapter(dependencies).collect(context());
    assert.equal(result.state, "error");
  }

  const controller = new AbortController();
  controller.abort();
  const aborted = await createCodexAdapter({
    resolveAuthPath: () => AUTH_PATH,
    readAuth: async () => availableAuth(),
    fetchUsage: async ({ signal }) => ({ outcome: "error", reason: signal.aborted ? "aborted" : "transport" }),
  }).collect(context(controller.signal));
  assert.equal(aborted.state, "error");
});
