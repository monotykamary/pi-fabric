// Persistence for the compiled entropy surface: <agent dir>/fabric/entropy/
// compiled.json, locked across Pi processes sharing the agent directory.
// A damaged artifact surfaces as an error and blocks compiles from
// overwriting it — the same discipline as the repair table. The artifact is
// clock-free, so saving byte-identical content is a no-op.

import fs from "node:fs";
import { isNormalFormPlan, MAX_NORMAL_FORM_PLANS } from "./normal-form.js";
import path from "node:path";
import { writeJsonAtomic, writeJsonAtomicAsync } from "../core/atomic-write.js";
import { withExclusiveFileLock, withExclusiveFileLockAsync } from "../core/file-lock.js";
import {
  COMPILED_SURFACE_VERSION,
  MAX_COMPILED_SURFACE_PROPOSALS,
  type CompiledSurfaceAppliedProposal,
  type CompiledSurfaceFile,
  type CompiledSurfaceGateRecord,
  type CompiledSurfaceOverlayEntry,
  type CompiledSurfaceQuarantineEntry,
} from "./compiled-surface.js";

const COMPILED_LOCK_ATTEMPTS = 50;
const COMPILED_LOCK_DELAY_MS = 5;
const COMPILED_STALE_LOCK_MS = 30_000;

export const compiledSurfaceDirectory = (agentDir: string): string =>
  path.join(agentDir, "fabric", "entropy");

const compiledPath = (directory: string): string => path.join(directory, "compiled.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

const parseOverlayEntry = (value: unknown): CompiledSurfaceOverlayEntry | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string" || !value.ref.trim()) return undefined;
  if (!isRecord(value.inputSchema)) return undefined;
  if (typeof value.baseSchemaDigest !== "string" || !value.baseSchemaDigest.trim()) {
    return undefined;
  }
  return {
    ref: value.ref.trim(),
    inputSchema: value.inputSchema,
    baseSchemaDigest: value.baseSchemaDigest.trim(),
  };
};

const parseQuarantineEntry = (value: unknown): CompiledSurfaceQuarantineEntry | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string" || !value.ref.trim()) return undefined;
  if (typeof value.baseSchemaDigest !== "string" || !value.baseSchemaDigest.trim()) {
    return undefined;
  }
  return { ref: value.ref.trim(), baseSchemaDigest: value.baseSchemaDigest.trim() };
};

const parseAppliedProposal = (value: unknown): CompiledSurfaceAppliedProposal | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.kind !== "string" || !value.kind.trim()) return undefined;
  if (typeof value.ref !== "string" || !value.ref.trim()) return undefined;
  if (typeof value.detail !== "string" || !value.detail.trim()) return undefined;
  return {
    kind: value.kind.trim() as CompiledSurfaceAppliedProposal["kind"],
    ref: value.ref.trim(),
    detail: value.detail.trim(),
  };
};

const parseGateRecord = (value: unknown): CompiledSurfaceGateRecord | undefined => {
  if (!isRecord(value) || typeof value.passed !== "boolean") return undefined;
  if (typeof value.beforeScore !== "number" || typeof value.afterScore !== "number" ||
      !Number.isFinite(value.beforeScore) || !Number.isFinite(value.afterScore)) {
    return undefined;
  }
  if (!Array.isArray(value.reasons) || !value.reasons.every((r) => typeof r === "string")) {
    return undefined;
  }
  return {
    passed: value.passed,
    beforeScore: value.beforeScore,
    afterScore: value.afterScore,
    reasons: value.reasons,
  };
};

// Version 1 is accepted only as inert migration data. Version 2 cannot carry
// restrictions. Its bounded plans are re-proved against live schemas at use;
// a persisted gate flag or metric version never grants execution authority.
const parseCompiledSurfaceFile = (value: unknown): CompiledSurfaceFile | undefined => {
  if (!isRecord(value) || (value.version !== 1 && value.version !== COMPILED_SURFACE_VERSION)) return undefined;
  if (value.version === COMPILED_SURFACE_VERSION) {
    if (!Array.isArray(value.normalizations) || value.normalizations.length > MAX_NORMAL_FORM_PLANS ||
        !value.normalizations.every(isNormalFormPlan) ||
        new Set(value.normalizations.map((plan) => plan.ref)).size !== value.normalizations.length) return undefined;
    if (!Array.isArray(value.actions) || value.actions.length !== 0 ||
        !Array.isArray(value.quarantined) || value.quarantined.length !== 0) return undefined;
  }
  if (!Number.isSafeInteger(value.metricVersion) || (value.metricVersion as number) < 1) {
    return undefined;
  }
  if (!Array.isArray(value.actions) || !value.actions.every((entry) => parseOverlayEntry(entry))) {
    return undefined;
  }
  if (
    !Array.isArray(value.quarantined) ||
    !value.quarantined.every((entry) => parseQuarantineEntry(entry))
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.applied) ||
    value.applied.length > MAX_COMPILED_SURFACE_PROPOSALS ||
    !value.applied.every((entry) => parseAppliedProposal(entry))
  ) {
    return undefined;
  }
  if (!parseGateRecord(value.gate)) return undefined;
  if (typeof value.evidenceDigest !== "string" || !value.evidenceDigest.trim()) return undefined;
  const overlaySeen = new Set<string>();
  for (const entry of value.actions) {
    const parsed = parseOverlayEntry(entry)!;
    if (overlaySeen.has(parsed.ref)) return undefined;
    overlaySeen.add(parsed.ref);
  }
  return {
    version: value.version,
    ...(value.version === COMPILED_SURFACE_VERSION ? { normalizations: value.normalizations as import("./normal-form.js").NormalFormPlan[] } : {}),
    metricVersion: value.metricVersion as number,
    actions: value.actions.map((entry) => parseOverlayEntry(entry)!),
    quarantined: value.quarantined.map((entry) => parseQuarantineEntry(entry)!),
    applied: value.applied.map((entry) => parseAppliedProposal(entry)!),
    gate: parseGateRecord(value.gate)!,
    evidenceDigest: value.evidenceDigest.trim(),
  };
};

// Public guarded parse for artifact files that did not come from this
// agent dir: exported artifacts being imported, or certification fixtures.
// The same validation the store applies to its own file, so nothing trusts
// an artifact shape the store would refuse to load.
export const parseCompiledSurfaceArtifact = (
  value: unknown,
): CompiledSurfaceFile | undefined => parseCompiledSurfaceFile(value);

export interface LoadedCompiledSurface {
  file?: CompiledSurfaceFile;
  error?: string;
}

export const loadCompiledSurface = (agentDir: string): LoadedCompiledSurface => {
  const file = compiledPath(compiledSurfaceDirectory(agentDir));
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // A missing artifact means the surface was never compiled; anything
    // else is damage that callers must surface, not silently rebuild.
    if (errorCode(error) === "ENOENT") return {};
    return { error: `compiled surface is unreadable: ${errorText(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "compiled surface is malformed JSON" };
  }
  const parsedFile = parseCompiledSurfaceFile(parsed);
  if (!parsedFile) return { error: "compiled surface is invalid" };
  return { file: parsedFile };
};

export const loadCompiledSurfaceAsync = async (
  agentDir: string,
): Promise<LoadedCompiledSurface> => {
  const file = compiledPath(compiledSurfaceDirectory(agentDir));
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    return { error: `compiled surface is unreadable: ${errorText(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "compiled surface is malformed JSON" };
  }
  const parsedFile = parseCompiledSurfaceFile(parsed);
  return parsedFile ? { file: parsedFile } : { error: "compiled surface is invalid" };
};

export interface SavedCompiledSurface {
  file: CompiledSurfaceFile;
  written: boolean;
}

export const saveCompiledSurface = (
  agentDir: string,
  file: CompiledSurfaceFile,
): SavedCompiledSurface =>
  withExclusiveFileLock(
    {
      directory: compiledSurfaceDirectory(agentDir),
      lockName: "compiled.lock",
      timeoutMessage: "Timed out waiting for the compiled entropy surface lock",
      attempts: COMPILED_LOCK_ATTEMPTS,
      delayMs: COMPILED_LOCK_DELAY_MS,
      staleMs: COMPILED_STALE_LOCK_MS,
    },
    () => {
      // A damaged artifact must never be silently rebuilt; fail so the
      // compile records the rejection and leaves the file for recovery.
      const loaded = loadCompiledSurface(agentDir);
      if (loaded.error) throw new Error(loaded.error);
      const target = compiledPath(compiledSurfaceDirectory(agentDir));
      const serialized = `${JSON.stringify(file, null, 2)}\n`;
      try {
        if (fs.readFileSync(target, "utf8") === serialized) return { file, written: false };
      } catch {
        // Missing file: proceed to write.
      }
      writeJsonAtomic(target, file, { space: 2, newline: true, mode: 0o600, dirMode: 0o700 });
      return { file, written: true };
    },
  );

export const saveCompiledSurfaceAsync = async (
  agentDir: string,
  file: CompiledSurfaceFile,
): Promise<SavedCompiledSurface> =>
  withExclusiveFileLockAsync(
    {
      directory: compiledSurfaceDirectory(agentDir),
      lockName: "compiled.lock",
      timeoutMessage: "Timed out waiting for the compiled entropy surface lock",
      attempts: COMPILED_LOCK_ATTEMPTS,
      delayMs: COMPILED_LOCK_DELAY_MS,
      staleMs: COMPILED_STALE_LOCK_MS,
    },
    async () => {
      const loaded = await loadCompiledSurfaceAsync(agentDir);
      if (loaded.error) throw new Error(loaded.error);
      const target = compiledPath(compiledSurfaceDirectory(agentDir));
      const serialized = `${JSON.stringify(file, null, 2)}\n`;
      try {
        if (await fs.promises.readFile(target, "utf8") === serialized) {
          return { file, written: false };
        }
      } catch {
        // Missing file: proceed to write.
      }
      await writeJsonAtomicAsync(target, file, {
        space: 2,
        newline: true,
        mode: 0o600,
        dirMode: 0o700,
      });
      return { file, written: true };
    },
  );
