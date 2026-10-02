import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeCredentialEntry } from "../../src/credentials/store.js";
import { chatgptAccountId, runAccountCommand, type FetchSeam } from "../../src/login/command.js";
import { scanForSecrets } from "../../src/security/redact.js";

// Spec: docs/specs/2026-10-02-standalone-credentials-design.md (Login entry point, OAuth flows, API keys).
const KEY = "synthetic-api-key-not-real";
const ACCESS = "synthetic-access-not-real";
const REFRESH = "synthetic-refresh-not-real";
const NOW = 1_700_000_000_000;

function jwt(claims: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}
const CODEX_ACCESS = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-acct" } });

interface Harness {
  readonly storePath: string;
  readonly out: string[];
  readonly err: string[];
  readonly urls: string[];
  run(argv: readonly string[], extra?: { fetch?: FetchSeam; readSecret?: () => Promise<string>; signal?: AbortSignal; environment?: Record<string, string> }): Promise<number>;
  store(): Promise<unknown>;
}

async function withHarness(callback: (h: Harness) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "kuota-login-synthetic-"));
  try {
    await mkdir(join(home, ".config"), { mode: 0o700 });
    const storePath = join(home, ".config", "kuota", "credentials.json");
    const out: string[] = [];
    const err: string[] = [];
    const urls: string[] = [];
    await callback({
      storePath, out, err, urls,
      run: (argv, extra = {}) => runAccountCommand(argv, {
        stdout: { write: (c) => { out.push(c); } },
        stderr: { write: (c) => { err.push(c); } },
        storePath,
        environment: extra.environment ?? {},
        now: () => NOW,
        sleep: async () => {},
        ...(extra.signal === undefined ? {} : { signal: extra.signal }),
        ...(extra.readSecret === undefined ? {} : { readSecret: extra.readSecret }),
        ...(extra.fetch === undefined ? {} : {
          fetch: async (url: string, init: RequestInit) => {
            urls.push(url);
            return (extra.fetch as FetchSeam)(url, init);
          },
        }),
      }),
      store: async () => {
        try { return JSON.parse(await readFile(storePath, "utf8")); } catch { return undefined; }
      },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function scripted(replies: readonly Response[]): FetchSeam {
  let index = 0;
  return async () => {
    const next = replies[index];
    index += 1;
    if (next === undefined) throw new Error("unexpected request");
    return next;
  };
}

test("an API key from the hidden prompt is stored 0600 as api_key; it is never echoed", async () => {
  await withHarness(async (h) => {
    assert.equal(await h.run(["login", "opencode"], { readSecret: async () => `  ${KEY}\n` }), 0);
    assert.deepEqual(await h.store(), { opencode: { type: "api_key", key: KEY } });
    assert.equal((await stat(h.storePath)).mode & 0o777, 0o600);
    assert.equal([...h.out, ...h.err].join("").includes(KEY), false);
    assert.equal(await h.run(["login", "kimi", "--api-key"], { readSecret: async () => KEY }), 0);
    assert.deepEqual(await h.store(), { opencode: { type: "api_key", key: KEY }, kimi: { type: "api_key", key: KEY } });
  });
});

test("a key passed as an argument is refused without saving or echoing it", async () => {
  await withHarness(async (h) => {
    let prompted = 0;
    const readSecret = async (): Promise<string> => { prompted += 1; return KEY; };
    assert.equal(await h.run(["login", "opencode", KEY], { readSecret }), 2);
    assert.equal(await h.run(["login", "commandcode", "--key", KEY], { readSecret }), 2);
    assert.equal(prompted, 0);
    assert.equal(await h.store(), undefined);
    assert.equal([...h.out, ...h.err].join("").includes(KEY), false);
  });
});

test("blank or whitespace-containing keys are rejected and nothing is saved", async () => {
  await withHarness(async (h) => {
    for (const bad of ["", "   ", "two words", "x".repeat(5000)]) {
      assert.equal(await h.run(["login", "commandcode"], { readSecret: async () => bad }), 1);
    }
    assert.equal(await h.store(), undefined);
  });
});

test("RFC 8628 device login polls through pending and slow_down, then stores the Grok login", async () => {
  await withHarness(async (h) => {
    const code = await h.run(["login", "grok"], {
      fetch: scripted([
        reply(200, { device_code: "synthetic-dc", user_code: "ABCD-EFGH", verification_uri: "https://accounts.x.ai/device", interval: 1, expires_in: 600 }),
        reply(400, { error: "authorization_pending" }),
        reply(400, { error: "slow_down" }),
        reply(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }),
      ]),
    });
    assert.equal(code, 0);
    assert.deepEqual(await h.store(), { grok: { type: "oauth", access: ACCESS, refresh: REFRESH, expires: NOW + 3_600_000 } });
    assert.ok(h.err.join("").includes("https://accounts.x.ai/device"));
    assert.ok(h.err.join("").includes("ABCD-EFGH"));
    assert.deepEqual(h.urls, [
      "https://auth.x.ai/oauth2/device/code",
      "https://auth.x.ai/oauth2/token",
      "https://auth.x.ai/oauth2/token",
      "https://auth.x.ai/oauth2/token",
    ]);
    assert.equal([...h.out, ...h.err].join("").includes(ACCESS), false);
  });
});

test("denied, expired, non-https, and server-error device logins save nothing and echo no body", async () => {
  await withHarness(async (h) => {
    const start = reply(200, { device_code: "dc", user_code: "U", verification_uri: "https://auth.kimi.com/device", interval: 1, expires_in: 600 });
    const cases: Response[][] = [
      [start.clone(), reply(400, { error: "access_denied" })],
      [start.clone(), reply(400, { error: "expired_token" })],
      [reply(200, { device_code: "dc", user_code: "U", verification_uri: "javascript:alert(1)" })],
      [reply(500, { error_description: `leak ${REFRESH}` })],
      [start.clone(), reply(200, { access_token: ACCESS })],
    ];
    for (const replies of cases) {
      assert.equal(await h.run(["login", "kimi"], { fetch: scripted(replies) }), 1);
    }
    assert.equal(await h.store(), undefined);
    const printed = [...h.out, ...h.err].join("");
    assert.equal(printed.includes(REFRESH), false);
    assert.equal(printed.includes(ACCESS), false);
  });
});

test("a non-https verification address is refused before it is shown or polled", async () => {
  await withHarness(async (h) => {
    const code = await h.run(["login", "kimi"], {
      fetch: scripted([
        reply(200, { device_code: "dc", user_code: "U", verification_uri: "javascript:alert(1)" }),
        reply(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 60 }),
      ]),
    });
    assert.equal(code, 1);
    assert.equal(h.urls.length, 1);
    assert.equal(h.err.join("").includes("javascript:"), false);
    assert.equal(await h.store(), undefined);
  });
});

test("a cancelled device login saves nothing", async () => {
  await withHarness(async (h) => {
    const controller = new AbortController();
    controller.abort();
    const code = await h.run(["login", "grok"], {
      signal: controller.signal,
      fetch: scripted([reply(200, { device_code: "dc", user_code: "U", verification_uri: "https://x.invalid/d" })]),
    });
    assert.notEqual(code, 0);
    assert.equal(await h.store(), undefined);
  });
});

test("Codex device login exchanges the approval code and stores the ChatGPT account id", async () => {
  await withHarness(async (h) => {
    const code = await h.run(["login", "codex"], {
      fetch: scripted([
        reply(200, { device_auth_id: "synthetic-dai", user_code: "CODE-1", interval: "1" }),
        reply(403, {}),
        reply(200, { authorization_code: "synthetic-ac", code_verifier: "synthetic-cv" }),
        reply(200, { access_token: CODEX_ACCESS, refresh_token: REFRESH, expires_in: 864000 }),
      ]),
    });
    assert.equal(code, 0);
    assert.deepEqual(await h.store(), {
      codex: { type: "oauth", access: CODEX_ACCESS, refresh: REFRESH, expires: NOW + 864_000_000, accountId: "synthetic-acct" },
    });
    assert.equal(h.urls[3], "https://auth.openai.com/oauth/token");
    assert.ok(h.err.join("").includes("https://auth.openai.com/codex/device"));
  });
});

test("Codex login without a ChatGPT account id or with device code disabled saves nothing", async () => {
  await withHarness(async (h) => {
    assert.equal(await h.run(["login", "codex"], {
      fetch: scripted([
        reply(200, { device_auth_id: "dai", user_code: "C" }),
        reply(200, { authorization_code: "ac", code_verifier: "cv" }),
        reply(200, { access_token: jwt({}), refresh_token: REFRESH, expires_in: 1 }),
      ]),
    }), 1);
    assert.equal(await h.run(["login", "codex"], { fetch: scripted([reply(404, {})]) }), 1);
    assert.ok(h.err.join("").includes("device-code sign-in is not available"));
    assert.equal(await h.store(), undefined);
  });
});

test("logout removes only that provider; status prints sources but never values", async () => {
  await withHarness(async (h) => {
    await writeCredentialEntry(h.storePath, "codex", { type: "oauth", access: ACCESS, refresh: REFRESH, expires: NOW + 1000, accountId: "synthetic-acct" });
    await writeCredentialEntry(h.storePath, "opencode", { type: "api_key", key: KEY });
    assert.equal(await h.run(["status"], { environment: { COMMANDCODE_API_KEY: KEY } }), 0);
    const printed = h.out.join("");
    for (const secret of [ACCESS, REFRESH, KEY, "synthetic-acct"]) assert.equal(printed.includes(secret), false);
    assert.match(printed, /codex: kuota login; expires /);
    assert.match(printed, /opencode: kuota api key/);
    assert.match(printed, /commandcode: COMMANDCODE_API_KEY set/);
    assert.match(printed, /grok: not signed in/);

    assert.equal(await h.run(["logout", "codex"]), 0);
    assert.deepEqual(await h.store(), { opencode: { type: "api_key", key: KEY } });
  });
});

test("unknown providers and Claude/Cursor get guidance instead of a login", async () => {
  await withHarness(async (h) => {
    assert.equal(await h.run(["login", "claude"]), 2);
    assert.match(h.err.join(""), /Claude Code's own login/);
    assert.equal(await h.run(["login", "nope"]), 2);
    assert.equal(await h.run(["logout"]), 2);
    assert.equal(await h.store(), undefined);
  });
});

test("chatgptAccountId reads only the ChatGPT account claim", () => {
  assert.equal(chatgptAccountId(CODEX_ACCESS), "synthetic-acct");
  assert.equal(chatgptAccountId("not-a-jwt"), undefined);
  assert.equal(chatgptAccountId(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: 7 } })), undefined);
});

// Review G-17 follow-ups.
test("an oversized sign-in response is rejected while streaming and saves nothing", async () => {
  await withHarness(async (h) => {
    const huge = new Response("x".repeat(200 * 1024), { status: 200 });
    assert.equal(await h.run(["login", "grok"], { fetch: scripted([huge]) }), 1);
    assert.match(h.err.join(""), /oversized/);
    assert.equal(await h.store(), undefined);
  });
});

test("--api-key is accepted for every key provider", async () => {
  await withHarness(async (h) => {
    assert.equal(await h.run(["login", "opencode", "--api-key"], { readSecret: async () => KEY }), 0);
    assert.deepEqual(await h.store(), { opencode: { type: "api_key", key: KEY } });
  });
});

test("status on a malformed store fails closed with a constant message", async () => {
  await withHarness(async (h) => {
    await mkdir(join(h.storePath, ".."), { mode: 0o700 });
    await writeFile(h.storePath, `{"codex":"${ACCESS}"`, { mode: 0o600 });
    assert.equal(await h.run(["status"]), 1);
    assert.equal([...h.out, ...h.err].join("").includes(ACCESS), false);
  });
});

test("every login/status output passes the central secret scanner", async () => {
  await withHarness(async (h) => {
    await h.run(["login", "opencode"], { readSecret: async () => KEY });
    await h.run(["login", "grok"], {
      fetch: scripted([
        reply(200, { device_code: "dc", user_code: "U-1", verification_uri: "https://accounts.x.ai/device", interval: 1, expires_in: 60 }),
        reply(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }),
      ]),
    });
    await h.run(["login", "kimi"], { fetch: scripted([reply(500, { error: "server_error", error_description: REFRESH })]) });
    await h.run(["status"], { environment: { KIMI_API_KEY: KEY } });
    assert.deepEqual(scanForSecrets({ out: h.out.join(""), err: h.err.join("") }), []);
    for (const secret of [KEY, ACCESS, REFRESH]) assert.equal([...h.out, ...h.err].join("").includes(secret), false);
  });
});
