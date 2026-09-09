import { randomUUID } from "node:crypto";
import type * as MontyNative from "@pydantic/monty/node";
import { pythonArgumentsFor } from "./python-arguments.js";

const ROOTS = ["pi", "tools", "mcp", "extensions", "memory", "state", "schema", "components", "compact", "agents", "mesh"];
const DISCOVERY = new Set(["providers", "catalog", "list", "search", "describe", "call", "models", "progress"]);
const FORBIDDEN = new Set(["constructor", "prototype", "__proto__", "arguments", "caller"]);
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
      const args = pythonArgumentsFor(ref, positional, kwargs);
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
