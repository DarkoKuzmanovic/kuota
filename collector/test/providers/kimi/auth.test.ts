import assert from "node:assert/strict";
import test from "node:test";

import { JsonFileError } from "../../../src/io/json-file.js";
import {
  readKimiAuth,
  resolveKimiAuthPath,
  type KimiAuthResult,
} from "../../../src/providers/kimi/auth.js";

const HOME = "/synthetic-home";
const AUTH_PATH = "/synthetic-home/.config/kuota/credentials.json";
const OAUTH_ACCESS = "synthetic-kimi-oauth-access-not-real";
const API_KEY = "synthetic-kimi-api-key-not-real";
const ENV_KEY = "synthetic-env-api-key-not-real";

function readerReturning(value: unknown): (path: string) => Promise<unknown> {
  return async () => value;
}

async function classify(
  value: unknown,
  environment: string | undefined = undefined,
): Promise<KimiAuthResult> {
  return readKimiAuth({
    homeDirectory: HOME,
    readJsonFile: readerReturning(value),
    environment: { KIMI_API_KEY: environment },
  });
}

test("resolves an injected auth path and accepts supported Kimi OAuth or API-key entries", async () => {
  assert.equal(resolveKimiAuthPath(HOME, {}), AUTH_PATH);
  const oauth = await classify({ kimi: { type: "oauth", access: OAUTH_ACCESS } });
  const apiKey = await classify({ kimi: { type: "api_key", key: API_KEY } });
  assert.deepEqual(oauth, { state: "available", credential: { kind: "oauth", value: OAUTH_ACCESS } });
  assert.deepEqual(apiKey, { state: "available", credential: { kind: "api-key", value: API_KEY } });
});

test("uses KIMI_API_KEY only when no supported file entry exists", async () => {
  const fileWins = await classify({ kimi: { type: "oauth", access: OAUTH_ACCESS } }, ENV_KEY);
  const noEntryUsesEnvironment = await classify({}, ENV_KEY);
  const unsupportedUsesEnvironment = await classify({ kimi: { type: "unknown" } }, ENV_KEY);
  assert.equal(fileWins.state, "available");
  if (fileWins.state === "available") assert.equal(fileWins.credential.value, OAUTH_ACCESS);
  assert.deepEqual(noEntryUsesEnvironment, { state: "available", credential: { kind: "api-key", value: ENV_KEY } });
  assert.deepEqual(unsupportedUsesEnvironment, { state: "available", credential: { kind: "api-key", value: ENV_KEY } });
});

test("fails closed for malformed or unavailable file state without exposing values", async () => {
  const malformed = await classify({ kimi: { type: "oauth", access: "" } }, ENV_KEY);
  const hostile = await classify({ kimi: { type: "api_key", key: 42 } }, ENV_KEY);
  const unsafe = await readKimiAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => { throw new JsonFileError("unsafe-file"); },
    environment: { KIMI_API_KEY: ENV_KEY },
  });
  for (const result of [malformed, hostile, unsafe]) {
    assert.notEqual(result.state, "available");
    assert.equal(JSON.stringify(result).includes(ENV_KEY), false);
    assert.equal(JSON.stringify(result).includes(OAUTH_ACCESS), false);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
  }
});
