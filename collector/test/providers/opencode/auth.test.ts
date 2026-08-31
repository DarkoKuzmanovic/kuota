import assert from "node:assert/strict";
import test from "node:test";

import { JsonFileError } from "../../../src/io/json-file.js";
import {
  readOpencodeAuth,
  resolveOpencodeAuthPath,
  type OpencodeAuthResult,
} from "../../../src/providers/opencode/auth.js";

const HOME = "/synthetic-home";
const AUTH_PATH = "/synthetic-home/.pi/agent/auth.json";
const CLI_KEY = "synthetic-opencode-go-api-key-not-real";
const ALIAS_KEY = "synthetic-opencode-alias-key-not-real";
const OAUTH_ACCESS = "synthetic-opencode-oauth-access-not-real";
const ENV_KEY = "synthetic-opencode-env-key-not-real";

function readerReturning(value: unknown): (path: string) => Promise<unknown> {
  return async () => value;
}

async function classify(
  value: unknown,
  environment: string | undefined = undefined,
): Promise<OpencodeAuthResult> {
  return readOpencodeAuth({
    homeDirectory: HOME,
    readJsonFile: readerReturning(value),
    environment: { OPENCODE_API_KEY: environment },
  });
}

test("resolves an injected auth path and accepts opencode-go api, api_key, and oauth shapes", async () => {
  assert.equal(resolveOpencodeAuthPath(HOME), AUTH_PATH);
  const cliShape = await classify({ "opencode-go": { type: "api", key: CLI_KEY } });
  const apiKeyShape = await classify({ "opencode-go": { type: "api_key", key: CLI_KEY } });
  const oauthShape = await classify({ "opencode-go": { type: "oauth", access: OAUTH_ACCESS } });
  assert.deepEqual(cliShape, { state: "available", credential: { kind: "api-key", value: CLI_KEY } });
  assert.deepEqual(apiKeyShape, { state: "available", credential: { kind: "api-key", value: CLI_KEY } });
  assert.deepEqual(oauthShape, { state: "available", credential: { kind: "oauth", value: OAUTH_ACCESS } });
});

test("prefers opencode-go, then the opencode alias, then OPENCODE_API_KEY", async () => {
  const goWins = await classify({ "opencode-go": { type: "api", key: CLI_KEY } }, ENV_KEY);
  const alias = await classify({ opencode: { type: "api", key: ALIAS_KEY } }, ENV_KEY);
  const aliasLosesToGo = await classify(
    { "opencode-go": { type: "api", key: CLI_KEY }, opencode: { type: "api", key: ALIAS_KEY } },
    ENV_KEY,
  );
  const noEntryUsesEnvironment = await classify({}, ENV_KEY);
  const unsupportedUsesEnvironment = await classify({ "opencode-go": { type: "unknown" } }, ENV_KEY);
  assert.equal(goWins.state, "available");
  if (goWins.state === "available") assert.equal(goWins.credential.value, CLI_KEY);
  assert.equal(alias.state, "available");
  if (alias.state === "available") assert.equal(alias.credential.value, ALIAS_KEY);
  assert.equal(aliasLosesToGo.state, "available");
  if (aliasLosesToGo.state === "available") assert.equal(aliasLosesToGo.credential.value, CLI_KEY);
  assert.deepEqual(noEntryUsesEnvironment, { state: "available", credential: { kind: "api-key", value: ENV_KEY } });
  assert.deepEqual(unsupportedUsesEnvironment, { state: "available", credential: { kind: "api-key", value: ENV_KEY } });
});

test("fails closed for malformed or unsafe file state without exposing values", async () => {
  const malformedGo = await classify({ "opencode-go": { type: "api", key: "" } }, ENV_KEY);
  const hostile = await classify({ "opencode-go": { type: "oauth", access: 42 } }, ENV_KEY);
  const unsafe = await readOpencodeAuth({
    authPath: AUTH_PATH,
    readJsonFile: async () => { throw new JsonFileError("unsafe-file"); },
    environment: { OPENCODE_API_KEY: ENV_KEY },
  });
  for (const result of [malformedGo, hostile, unsafe]) {
    assert.notEqual(result.state, "available");
    assert.equal(JSON.stringify(result).includes(ENV_KEY), false);
    assert.equal(JSON.stringify(result).includes(CLI_KEY), false);
    assert.equal(JSON.stringify(result).includes(OAUTH_ACCESS), false);
  }
});
