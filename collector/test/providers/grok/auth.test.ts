import assert from "node:assert/strict";
import test from "node:test";

import { JsonFileError } from "../../../src/io/json-file.js";
import {
  readGrokAuth,
  resolveGrokAuthPath,
  type GrokAuthResult,
} from "../../../src/providers/grok/auth.js";

const HOME = "/synthetic-home";
const AUTH_PATH = "/synthetic-home/.pi/agent/auth.json";
const OAUTH_ACCESS = "synthetic-grok-oauth-access-not-real";
const ENV_TOKEN = "synthetic-env-grok-token-not-real";

function readerReturning(value: unknown): (path: string) => Promise<unknown> {
  return async () => value;
}

async function classify(
  value: unknown,
  environment: string | undefined = undefined,
): Promise<GrokAuthResult> {
  return readGrokAuth({
    homeDirectory: HOME,
    readJsonFile: readerReturning(value),
    environment: { GROK_CLI_OAUTH_TOKEN: environment },
  });
}

test("resolves an injected auth path and accepts supported Grok OAuth entries", async () => {
  assert.equal(resolveGrokAuthPath(HOME), AUTH_PATH);

  const xai = await classify({ xai: { type: "oauth", access: OAUTH_ACCESS } });
  const xaiAuth = await classify({ "xai-auth": { type: "oauth", access: OAUTH_ACCESS } });
  const grokCli = await classify({ "grok-cli": { type: "oauth", access: OAUTH_ACCESS } });

  for (const result of [xai, xaiAuth, grokCli]) {
    assert.deepEqual(result, { state: "available", credential: { kind: "oauth", value: OAUTH_ACCESS } });
  }
});

test("tries auth sources in order and uses environment fallback only when no supported file entry", async () => {
  const fileWins = await classify({ xai: { type: "oauth", access: OAUTH_ACCESS } }, ENV_TOKEN);
  const noEntryUsesEnv = await classify({}, ENV_TOKEN);
  const unsupportedUsesEnv = await classify({ xai: { type: "unknown" } }, ENV_TOKEN);

  assert.equal(fileWins.state, "available");
  if (fileWins.state === "available") assert.equal(fileWins.credential.value, OAUTH_ACCESS);
  assert.deepEqual(noEntryUsesEnv, { state: "available", credential: { kind: "oauth", value: ENV_TOKEN } });
  assert.deepEqual(unsupportedUsesEnv, { state: "available", credential: { kind: "oauth", value: ENV_TOKEN } });
});

test("fails closed for malformed or unavailable file state without exposing values", async () => {
  const malformed = await classify({ xai: { type: "oauth", access: "" } }, ENV_TOKEN);
  const hostile = await classify({ xai: { type: "oauth", access: 42 } }, ENV_TOKEN);
  const unsafe = await readGrokAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => { throw new JsonFileError("unsafe-file"); },
    environment: { GROK_CLI_OAUTH_TOKEN: ENV_TOKEN },
  });

  for (const result of [malformed, hostile, unsafe]) {
    assert.notEqual(result.state, "available");
    assert.equal(JSON.stringify(result).includes(ENV_TOKEN), false);
    assert.equal(JSON.stringify(result).includes(OAUTH_ACCESS), false);
  }
});
