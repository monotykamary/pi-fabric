import { randomUUID } from "node:crypto";
import type * as MontyNative from "@pydantic/monty/node";
import { normalizeMontyValue } from "./monty-values.js";

const ROOTS = ["pi", "tools", "mcp", "extensions", "memory", "state", "schema", "components", "compact", "agents", "mesh"];
const DISCOVERY = new Set(["providers", "catalog", "list", "search", "describe", "call", "models", "progress"]);
const FORBIDDEN = new Set(["constructor", "prototype", "__proto__", "arguments", "caller"]);
const PRIMARY: Record<string, string> = { read: "path", ls: "path", bash: "command", powershell: "command", grep: "pattern", find: "pattern" };
const POSITIONAL: Record<string, string[]> = {
  read: ["path", "offset", "limit"], ls: ["path", "limit"], grep: ["pattern", "path", "limit"],
  find: ["pattern", "path", "limit"], write: ["path", "content"], edit: ["path", "oldText", "newText"], bash: ["command"], powershell: ["command"],
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function argumentsFor(ref: string, positional: unknown[], kwargs: Record<string, unknown>): Record<string, unknown> {
  let args = normalizeMontyValue(kwargs) as Record<string, unknown>;
  const values = normalizeMontyValue(positional) as unknown[];
  if (values.length === 1 && record(values[0])) {
    if (Object.keys(values[0]).some((key) => Object.hasOwn(args, key))) throw new TypeError("Duplicate Fabric argument keys");
    args = { ...values[0], ...args };
  } else if (ref === "tools.search" && values.length === 1 && typeof values[0] === "string") {
    args = { ...args, query: values[0] };
  } else if (values.length) {
    const name = ref.startsWith("pi.") ? ref.slice(3) : "";
    const primary = Object.hasOwn(PRIMARY, name) ? PRIMARY[name] : undefined;
    const fields = Object.hasOwn(POSITIONAL, name) ? POSITIONAL[name]! : [];
    if (primary && values.length === 2 && typeof values[0] === "string" && record(values[1])) {
      args = { ...values[1], ...args, [primary]: values[0] };
    } else if (fields.length && values.length <= fields.length) {
      for (let index = 0; index < values.length; index++) args[fields[index]!] = values[index];
    } else throw new TypeError("Fabric calls accept a dictionary or keyword arguments; Pi tools also accept documented positional arguments");
  }
  if (ref === "pi.edit" && !Object.hasOwn(args, "edits") && (Object.hasOwn(args, "oldText") || Object.hasOwn(args, "newText"))) {
    const edit: Record<string, unknown> = {};
    for (const key of ["oldText", "newText"]) if (Object.hasOwn(args, key)) { edit[key] = args[key]; delete args[key]; }
    args.edits = [edit];
  }
  return args;
}

/** Explicit capability wrappers, not arbitrary host objects or guest magic methods. */
export function montyBindings(
  native: typeof MontyNative,
  call: (ref: string, args: Record<string, unknown>) => Promise<unknown>,
): Record<string, unknown> {
  const wrappers = new Map<string, MontyNative.ClassType>();
  class Capability {}
  class CapabilityWrapper extends native.ClassType {
    constructor(readonly ref: string) {
      // ClassType otherwise shares an id per JS constructor, conflating unrelated refs.
      super(Capability, { id: randomUUID(), name: "FabricCapability", init: true });
    }
    private child(name: string): string {
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || name.startsWith("__") || FORBIDDEN.has(name)) {
        throw Object.assign(new Error("Fabric capability attribute is not exposed: " + name), { name: "AttributeError" });
      }
      if (this.ref.length + name.length > 510) throw new TypeError("Fabric host reference exceeds 512 characters");
      return this.ref + "." + name;
    }
    override lookupLazyAttr(name: string): unknown { return wrapper(this.child(name)); }
    override callMethod(name: string, positional: unknown[], kwargs: Record<string, unknown>): unknown {
      let ref = name === "__call__" ? this.ref : this.child(name);
      const args = argumentsFor(ref, positional, kwargs);
      if (ref.startsWith("tools.")) {
        const action = ref.slice(6);
        if (!DISCOVERY.has(action)) throw new TypeError("tools is discovery/generic calls only; use pi for core tools");
        ref = "fabric.$" + action;
      }
      if (!ref.includes(".")) throw new TypeError("Call a Fabric provider action, not a namespace");
      return call(ref, args);
    }
  }
  const wrapper = (ref: string): MontyNative.ClassType => {
    let value = wrappers.get(ref);
    if (!value) {
      if (wrappers.size >= 1024) throw new TypeError("Too many Monty Fabric capability references");
      value = new CapabilityWrapper(ref);
      wrappers.set(ref, value);
    }
    return value;
  };
  return Object.fromEntries(ROOTS.map((name) => [name, wrapper(name)]));
}
