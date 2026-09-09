// Runtime-only compatibility policy. No schema or discovery entry changes.
import type { CompiledSurfaceFile } from "./compiled-surface.js";
import { applyNormalFormPlan, deriveNormalFormPlan, type NormalFormResult } from "./normal-form.js";

let active: CompiledSurfaceFile | undefined;
let enabled = false;
export const setActiveCompiledSurface = (file: CompiledSurfaceFile | undefined, enable = file !== undefined): void => {
  active = file;
  enabled = enable;
};
export const clearActiveCompiledSurface = (): void => { active = undefined; enabled = false; };
export const effectiveInputSchema = (_ref: string, liveSchema: unknown): unknown => liveSchema;
export const activeQuarantinedRefNames = (): ReadonlySet<string> => new Set();
export const isActiveQuarantine = (_provider: string, _actionName: string, _liveSchema: unknown): boolean => false;

export const normalizeActiveArguments = (ref: string, schema: unknown, args: Record<string, unknown>): NormalFormResult => {
  if (!enabled) return { args };
  const stored = active?.version === 2 ? active.normalizations?.find((plan) => plan.ref === ref) : undefined;
  // New actions gain the same statically proven rules on their first call,
  // without waiting for session evidence or a background persistence tick.
  // A stored stale/forged plan is refused, never silently substituted.
  return applyNormalFormPlan(ref, schema, args, stored ?? deriveNormalFormPlan(ref, schema));
};
