const MAX_VALUE_BYTES = 16 * 1024 * 1024;

/** Strict JSON boundary: never silently stringify bytes, sets, unsafe ints or cycles. */
export function normalizeMontyValue(value: unknown, hostValue = false): unknown {
  let remaining = MAX_VALUE_BYTES;
  let nodes = 0;
  const active = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 48) throw new TypeError("Monty JSON value exceeds the node/depth limit");
    if (typeof item === "string") remaining -= Buffer.byteLength(item, "utf8");
    else remaining -= 8;
    if (remaining < 0) throw new TypeError("Monty JSON value exceeds 16 MiB");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return item;
    if (typeof item !== "object" || item === null) throw new TypeError("Monty boundary requires JSON-compatible values (finite numbers and safe integers)");
    if (active.has(item)) throw new TypeError("Monty boundary cannot serialize cyclic values");
    active.add(item);
    try {
      if (Array.isArray(item)) return Array.from(item, (entry) => visit(entry, depth + 1));
      const plain = Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null;
      if (!(item instanceof Map) && (!plain || (!hostValue && Object.hasOwn(item, "__monty_type__")))) {
        throw new TypeError("Monty boundary requires JSON-compatible values; bytes, sets and class/module objects are unsupported");
      }
      const result: Record<string, unknown> = {};
      for (const [key, entry] of item instanceof Map ? item.entries() : Object.entries(item)) {
        if (typeof key !== "string") throw new TypeError("Monty JSON dictionary keys must be strings");
        visit(key, depth + 1);
        Object.defineProperty(result, key, { value: visit(entry, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return result;
    } finally { active.delete(item); }
  };
  return visit(hostValue && value === undefined ? null : value, 0);
}

/** Maps prevent JSON keys such as __monty_type__ from being interpreted as native markers. */
export function montyInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(montyInput);
  if (value !== null && typeof value === "object") {
    return new Map(Object.entries(value).map(([key, entry]) => [key, montyInput(entry)]));
  }
  return value;
}
