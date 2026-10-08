import { runInNewContext } from "node:vm";

// Synthetic factories: each invocation owns its graph and trap/getter counters.
export interface GuardFixture {
  readonly value: unknown;
  readonly calls: string[];
}
export interface GuardCase {
  readonly name: string;
  readonly expected: boolean;
  readonly create: () => GuardFixture;
}
const simple = (name: string, expected: boolean, make: () => unknown): GuardCase => ({
  name, expected, create: () => ({ value: make(), calls: [] }),
});
export function deepJsonGraph(): unknown {
  let value: unknown = null;
  for (let i = 0; i < 20000; i += 1) value = { child: value };
  return value;
}
function accessor(array: boolean): GuardFixture {
  const calls: string[] = [];
  const value = array ? [] : {};
  Object.defineProperty(value, array ? "0" : "value", {
    enumerable: true, get() { calls.push("getter"); throw new Error("synthetic getter"); },
  });
  return { value, calls };
}
function proxyCase(name: string, expected: boolean, target: () => object,
  overrides: ProxyHandler<object> = {}): GuardCase {
  return { name, expected, create() {
    const calls: string[] = [];
    const value = new Proxy(target(), {
      getPrototypeOf(object) { calls.push("prototype"); return Reflect.getPrototypeOf(object); },
      ownKeys(object) { calls.push("keys"); return Reflect.ownKeys(object); },
      getOwnPropertyDescriptor(object, key) {
        calls.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(object, key);
      },
      ...overrides,
    });
    return { value, calls };
  } };
}
export const jsonValueCorpus: readonly GuardCase[] = [
  ...[null, true, false, "", "synthetic", 0, -0, 0.5, Number.MAX_VALUE, Number.MIN_VALUE]
    .map((value, index) => simple(`primitive ${index}`, true, () => value)),
  ...[undefined, NaN, Infinity, -Infinity, 1n, Symbol("synthetic"), () => null]
    .map((value, index) => simple(`invalid primitive ${index}`, false, () => value)),
  simple("plain", true, () => ({ a: [1, null, false] })),
  simple("null prototype", true, () => Object.assign(Object.create(null), { a: 1 })),
  simple("frozen", true, () => Object.freeze({ a: Object.freeze([1]) })),
  simple("deep", true, deepJsonGraph),
  simple("shared DAG", true, () => { const child = { a: [1] }; return { a: child, b: child }; }),
  simple("self cycle", false, () => { const value: Record<string, unknown> = {}; value.self = value; return value; }),
  simple("indirect cycle", false, () => { const value: unknown[] = []; value.push({ back: value }); return value; }),
  simple("sparse", true, () => { const value = new Array(8); value[4] = null; return value; }),
  simple("undefined entry", false, () => [undefined]),
  simple("undefined property", false, () => ({ a: undefined })),
  ...["", "01", "-0", "-1", "1.0", "1e0", " 0", "+0", "NaN", "Infinity", "4294967295", "extra"]
    .map(key => simple(`array key ${JSON.stringify(key)}`, false,
      () => Object.defineProperty([0], key, { value: 1, enumerable: true }))),
  ...[false, true].flatMap(array => [
    simple(`hidden ${array}`, false, () => Object.defineProperty(array ? [] : {}, array ? "0" : "a", { value: 1 })),
    simple(`symbol ${array}`, false, () => Object.defineProperty(array ? [] : {}, Symbol("synthetic"), { value: 1, enumerable: true })),
    { name: `accessor ${array}`, expected: false, create: () => accessor(array) },
  ]),
  simple("custom object prototype", false, () => Object.create({ a: 1 })),
  simple("custom array prototype", false, () => Object.setPrototypeOf([], {})),
  simple("null array prototype", false, () => Object.setPrototypeOf([], null)),
  simple("class", false, () => new class { a = 1; }()),
  ...[() => new Date(0), () => new Map(), () => new Set(), () => /synthetic/, () => new Number(1), () => new Uint8Array(1)]
    .map((make, index) => simple(`builtin ${index}`, false, make)),
  simple("cross realm object", false, () => runInNewContext("({a:1})")),
  simple("cross realm array", false, () => runInNewContext("[1]")),
  simple("cross realm null prototype", true, () => runInNewContext("Object.assign(Object.create(null), {a:1})")),
  proxyCase("transparent object", true, () => ({ a: 1 })),
  proxyCase("transparent array", true, () => [1]),
  simple("revoked", false, () => { const value = Proxy.revocable({}, {}); value.revoke(); return value.proxy; }),
  ...["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"].map(trap => proxyCase(
    `throwing ${trap}`, false, () => ({ a: 1 }), { [trap]: () => { throw new Error("synthetic trap"); } })),
  proxyCase("missing descriptor", false, () => ({ a: 1 }), { getOwnPropertyDescriptor: () => undefined }),
  proxyCase("throwing array length", false, () => [], { getOwnPropertyDescriptor: () => { throw new Error("synthetic length"); } }),
  proxyCase("duplicate keys invariant", false, () => ({}), { ownKeys: () => ["a", "a"] }),
  proxyCase("missing frozen key invariant", false, () => Object.freeze({ a: 1 }), { ownKeys: () => [] }),
  proxyCase("prototype invariant", false, () => Object.preventExtensions({}), { getPrototypeOf: () => null }),
  proxyCase("descriptor invariant", false, () => Object.freeze({ a: 1 }), {
    getOwnPropertyDescriptor: () => ({ value: 2, configurable: false, enumerable: true, writable: false }),
  }),
];
