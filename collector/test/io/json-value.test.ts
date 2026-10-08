import assert from "node:assert/strict";
import test from "node:test";
import { isJsonValue as fileGuard, type JsonValue, type JsonPrimitive, type JsonObject } from "../../src/io/json-file.js";
import { isJsonValue as atomicGuard, atomicWriteJson, AtomicWriteError, type AtomicFileSystem } from "../../src/io/atomic-write.js";
import { readCollectorCache, writeCollectorCache } from "../../src/collect/cache.js";
import { isJsonValue as pureGuard, type JsonValue as PureJsonValue, type JsonObject as PureJsonObject, type JsonPrimitive as PureJsonPrimitive } from "../../src/io/json-value.js";
import { deepJsonGraph, jsonValueCorpus } from "./json-value-corpus.js";

for (const fixture of jsonValueCorpus) {
  test(`JSON guard characterization: ${fixture.name}`, () => {
    const observations = [fileGuard, atomicGuard, pureGuard].map(guard => {
      const { value, calls } = fixture.create();
      assert.equal(guard(value), fixture.expected);
      assert.ok(!calls.includes("getter"));
      return calls;
    });
    assert.deepEqual(observations[0], observations[1]);
    assert.deepEqual(observations[0], observations[2]);
  });
}

test("legacy JSON guards are the same function object", () => {
  assert.equal(fileGuard, atomicGuard);
  assert.equal(fileGuard, pureGuard);
});

test("legacy JSON types and predicate narrowing remain usable", () => {
  const primitive: JsonPrimitive = "synthetic";
  const object: JsonObject = { primitive };
  const candidate: unknown = object;
  if (!fileGuard(candidate)) assert.fail("valid object rejected");
  const narrowed: JsonValue = candidate;
  const callable: (value: unknown) => boolean = atomicGuard;
  const purePrimitive: PureJsonPrimitive = primitive;
  const pureObject: PureJsonObject = object;
  const pureValue: PureJsonValue = narrowed;
  assert.equal(callable(pureValue), true);
  assert.equal(pureGuard({ purePrimitive, pureObject }), true);
});

test("accepted deep graph serialization fails before every filesystem mechanism", async () => {
  const value = deepJsonGraph();
  assert.equal(fileGuard(value), true);
  assert.throws(() => JSON.stringify(value), RangeError);
  const calls: string[] = [];
  const fail = (): never => { calls.push("filesystem"); throw new Error("synthetic unexpected I/O"); };
  const fs: AtomicFileSystem = {
    lstat: fail, open: fail, chmod: fail, rename: fail, unlink: fail,
    openDirectory: fail, getEffectiveUserId: fail,
  };
  await assert.rejects(atomicWriteJson("/synthetic/never-accessed.json", value, {
    fs, random: { randomBytes: fail },
  }), (error: unknown) => {
    assert.ok(error instanceof AtomicWriteError);
    assert.equal(error.stage, "serialize");
    assert.equal(error.message, "Atomic write failed during serialize");
    return true;
  });
  assert.deepEqual(calls, []);
});

test("cache rejects accessor graph without evaluating getters or reaching filesystem options", async () => {
  let calls = 0;
  const value = Object.defineProperty({}, "records", { enumerable: true, get() { calls += 1; throw new Error("synthetic getter"); } });
  assert.deepEqual(await readCollectorCache({ cachePath: "/synthetic/cache.json", readJsonFile: async () => value }), { state: "missing" });
  assert.deepEqual(await writeCollectorCache(value, {
    get cachePath(): string { calls += 1; throw new Error("synthetic filesystem options"); },
  }), { state: "error", reason: "cache-invalid" });
  assert.equal(calls, 0);
});
