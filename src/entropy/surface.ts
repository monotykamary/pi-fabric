// Live surface snapshots for the entropy meter. Discovery is Fabric's
// authorization-free read path (read-only, no approval budget, no side
// effects): providers answer `list` from static descriptors, in-memory
// catalogs, or the MCP descriptor cache, so a minimal synthetic invocation
// context is safe for command-time surface listing.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricInvocationContext } from "../protocol.js";
import { stableJsonHash } from "../core/stable-hash.js";
import { compareCodeUnits, roundMetric, staticFreedomFromSchema } from "./fingerprint.js";
import type { EntropySurfaceSnapshot } from "./types.js";

const SURFACE_LIST_LIMIT = 1_000;

export interface EntropySurfaceListAction {
  ref: string;
  inputSchema: unknown;
}

export interface EntropySurfaceRegistry {
  list(
    request: { limit?: number; declared?: boolean },
    context: FabricInvocationContext,
  ): Promise<readonly EntropySurfaceListAction[]>;
}

const surfaceInvocationContext = (input: {
  extensionContext: ExtensionContext;
  cwd: string;
}): FabricInvocationContext => ({
  cwd: input.cwd,
  signal: undefined,
  parentToolCallId: "fabric-entropy-surface",
  nestedToolCallId: "fabric-entropy-surface",
  extensionContext: input.extensionContext,
  update: () => {},
});

// Snapshot the live action surface (ref + input schema per action) through
// the registry's discovery path. Sorted by ref so the snapshot hashes and
// diffs deterministically.
export const liveSurfaceSnapshot = async (input: {
  registry: EntropySurfaceRegistry;
  extensionContext: ExtensionContext;
  cwd: string;
}): Promise<EntropySurfaceSnapshot> => {
  // Snapshot the declaration, which remains the public capability contract.
  // Normal forms live behind it and never remove actions or enum members.
  const actions = await input.registry.list(
    { limit: SURFACE_LIST_LIMIT, declared: true },
    surfaceInvocationContext(input),
  );
  return {
    version: 1,
    actions: actions
      .map((action) => ({ ref: action.ref, inputSchema: action.inputSchema }))
      .sort((left, right) => compareCodeUnits(left.ref, right.ref)),
  };
};

export const entropySurfaceHash = (surface: EntropySurfaceSnapshot): string =>
  stableJsonHash(surface);

export interface EntropySurfaceFreedomEntry {
  ref: string;
  freedom: number;
}

export interface EntropySurfaceFreedomReport {
  actions: EntropySurfaceFreedomEntry[];
  total: number;
  mean: number;
}

// Static freedom of a whole surface: per-action scores sorted worst-first,
// with the total and mean the ratchet tracks. Computable with no corpus at
// all, which is what lets a candidate surface be scored before any session
// runs against it.
export const surfaceFreedomReport = (
  surface: EntropySurfaceSnapshot,
): EntropySurfaceFreedomReport => {
  const actions = surface.actions
    .map((action) => ({ ref: action.ref, freedom: staticFreedomFromSchema(action.inputSchema) }))
    .sort((left, right) => right.freedom - left.freedom || compareCodeUnits(left.ref, right.ref));
  const total = roundMetric(actions.reduce((sum, entry) => sum + entry.freedom, 0));
  return {
    actions,
    total,
    mean: actions.length > 0 ? roundMetric(total / actions.length) : 0,
  };
};
