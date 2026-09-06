import type { FabricExecutorRuntime } from "../config.js";
import type { FabricGuestTypeSources } from "../protocol.js";
import type { FabricKernelRuntime, FabricHostCall, FabricSandboxOptions } from "./kernel.js";
import { QuickJsRuntime } from "./quickjs-runtime.js";
import { BunProcessRuntime, NodeProcessRuntime } from "./node-process-runtime.js";
import { repairFabricGuestCode } from "./guest-code-repair.js";
import { typeCheckFabricCode } from "./type-checker.js";
import { guestTypeDeclarations } from "./guest-types.js";
import { buildDynamicGuestDeclarations } from "./dynamic-guest-types.js";
import { buildCoreOverrideGuestDeclarations, type FabricCoreOverrideTypeSource } from "./core-override-guest-types.js";

// TypeScript is one kernel, with several JavaScript execution engines.
// Keep compiler and guest declaration dependencies behind this lazy boundary.
export class TypeScriptKernelRuntime implements FabricKernelRuntime {
  readonly #runtime: FabricKernelRuntime;

  constructor(runtime: FabricExecutorRuntime) {
    this.#runtime = runtime === "node-process"
      ? new NodeProcessRuntime()
      : runtime === "bun-process"
        ? new BunProcessRuntime()
        : new QuickJsRuntime();
  }

  prepare(
    source: string,
    fullCodeMode: boolean,
    unavailable: string[],
    sources: FabricGuestTypeSources,
    overrides: FabricCoreOverrideTypeSource[],
  ) {
    const code = repairFabricGuestCode(source);
    const coreOverrides = fullCodeMode
      ? buildCoreOverrideGuestDeclarations(overrides)
      : undefined;
    const checked = typeCheckFabricCode(code, guestTypeDeclarations(fullCodeMode, {
      excludeGlobals: unavailable,
      dynamic: buildDynamicGuestDeclarations(sources),
      ...(coreOverrides ? { coreOverrides } : {}),
    }));
    return { code, checked };
  }

  execute(code: string, hostCall: FabricHostCall, options: FabricSandboxOptions) {
    return this.#runtime.execute(code, hostCall, options);
  }
}
