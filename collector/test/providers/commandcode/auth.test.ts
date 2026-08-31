import assert from "node:assert/strict";
import test from "node:test";

import { JsonFileError } from "../../../src/io/json-file.js";
import {
  readCommandCodeAuth,
  resolveCommandCodeAuthPath,
  type CommandCodeAuthResult,
} from "../../../src/providers/commandcode/auth.js";

const HOME = "/synthetic-home";
const AUTH_PATH = "/synthetic-home/.pi/agent/auth.json";
const OAUTH_ACCESS = "synthetic-commandcode-oauth-access-not-real";
const API_KEY = "synthetic-commandcode-api-key-not-real";
const ENV_KEY = "synthetic-commandcode-env-key-not-real";

function readerReturning(value: unknown): (path: string) => Promise<unknown> {
  return async () => value;
}

async function classify(
  value: unknown,
  environment: string | undefined = undefined,
): Promise<CommandCodeAuthResult> {
  return readCommandCodeAuth({
    homeDirectory: HOME,
    readJsonFile: readerReturning(value),
    environment: { COMMANDCODE_API_KEY: environment },
  });
}

test("resolves an injected auth path and accepts commandcode oauth or api-key entries", async () => {
  assert.equal(resolveCommandCodeAuthPath(HOME), AUTH_PATH);
  const oauth = await classify({ commandcode: { type: "oauth", access: OAUTH_ACCESS } });
  const apiKey = await classify({ commandcode: { type: "api_key", key: API_KEY } });
  assert.deepEqual(oauth, { state: "available", credential: { kind: "oauth", value: OAUTH_ACCESS } });
  assert.deepEqual(apiKey, { state: "available", credential: { kind: "api-key", value: API_KEY } });
});

test("uses COMMANDCODE_API_KEY only when no supported file entry exists", async () => {
  const fileWins = await classify({ commandcode: { type: "oauth", access: OAUTH_ACCESS } }, ENV_KEY);
  const noEntryUsesEnvironment = await classify({}, ENV_KEY);
  const unsupportedUsesEnvironment = await classify({ commandcode: { type: "unknown" } }, ENV_KEY);
  assert.equal(fileWins.state, "available");
  if (fileWins.state === "available") assert.equal(fileWins.credential.value, OAUTH_ACCESS);
  assert.deepEqual(noEntryUsesEnvironment, { state: "available", credential: { kind: "api-key", value: ENV_KEY } });
  assert.deepEqual(unsupportedUsesEnvironment, { state: "available", credential: { kind: "api-key", value: ENV_KEY } });
});

test("fails closed for malformed or unsafe file state without exposing values", async () => {
  const malformed = await classify({ commandcode: { type: "oauth", access: "" } }, ENV_KEY);
  const hostile = await classify({ commandcode: { type: "api_key", key: 42 } }, ENV_KEY);
  const unsafe = await readCommandCodeAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => { throw new JsonFileError("unsafe-file"); },
    environment: { COMMANDCODE_API_KEY: ENV_KEY },
  });
  for (const result of [malformed, hostile, unsafe]) {
    assert.notEqual(result.state, "available");
    assert.equal(JSON.stringify(result).includes(ENV_KEY), false);
    assert.equal(JSON.stringify(result).includes(OAUTH_ACCESS), false);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
  }
});

test("ignores refresh and expires fields while extracting the access credential", async () => {
  const oauth = await classify({
    commandcode: { type: "oauth", access: OAUTH_ACCESS, refresh: "synthetic-refresh-not-real", expires: 9999999999 },
  });
  assert.equal(oauth.state, "available");
  if (oauth.state === "available") {
    assert.equal(oauth.credential.value, OAUTH_ACCESS);
    assert.equal(JSON.stringify(oauth).includes("refresh"), false);
  }
});
