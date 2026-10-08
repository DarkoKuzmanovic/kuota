export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

function isArrayIndexKey(key: string, length: number): boolean {
  if (key === "") {
    return false;
  }
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * Checks the object graph without invoking property accessors. The active set
 * rejects cycles while allowing a shared, non-cyclic subtree to be serialized
 * as the duplicate JSON subtree that JSON.stringify would produce.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  type Work =
    | { readonly value: unknown; readonly exit: false }
    | { readonly value: object; readonly exit: true };
  const work: Work[] = [{ value, exit: false }];
  const active = new WeakSet<object>();

  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) {
      return false;
    }
    if (item.exit) {
      active.delete(item.value);
      continue;
    }

    const current = item.value;
    if (current === null) {
      continue;
    }
    if (typeof current === "string" || typeof current === "boolean") {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return false;
      }
      continue;
    }
    if (typeof current !== "object") {
      return false;
    }
    if (active.has(current)) {
      return false;
    }

    let prototype: object | null;
    let keys: readonly (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(current);
      keys = Reflect.ownKeys(current);
    } catch {
      return false;
    }
    active.add(current);
    work.push({ value: current, exit: true });

    let arrayValue = false;
    try {
      arrayValue = Array.isArray(current);
    } catch {
      return false;
    }
    if (arrayValue) {
      if (prototype !== Array.prototype) {
        return false;
      }
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
      } catch {
        return false;
      }
      if (
        lengthDescriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.enumerable
      ) {
        return false;
      }
      const length = lengthDescriptor.value;
      for (const key of keys) {
        if (typeof key === "symbol") {
          return false;
        }
        if (key === "length") {
          continue;
        }
        if (!isArrayIndexKey(key, length)) {
          return false;
        }
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, key);
        } catch {
          return false;
        }
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          return false;
        }
        work.push({ value: descriptor.value, exit: false });
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const key of keys) {
      if (typeof key === "symbol") {
        return false;
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key);
      } catch {
        return false;
      }
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return false;
      }
      work.push({ value: descriptor.value, exit: false });
    }
  }
  return true;
}
