// Static normal-form compilation. Observations diagnose friction but cannot
// authorize capability loss. Rule derivation preserves the declared surface
// for every input, rather than only preserving a retained replay window.
import { stableJsonHash } from "../core/stable-hash.js";
import { measureEntropy, measureEntropyAsync } from "./meter.js";
import { proposeEntropyReductions, type EntropyProposalInput } from "./passes.js";
import {
  COMPILED_SURFACE_VERSION, MAX_COMPILED_SURFACE_PROPOSALS,
  emptyCompiledSurface, type CompiledSurfaceFile,
} from "./compiled-surface.js";
import { deriveNormalFormPlan, MAX_NORMAL_FORM_PLANS, type NormalFormPlan } from "./normal-form.js";
import { entropySurfaceHash } from "./surface.js";
import type {
  EntropyAuditCall, EntropyGateResult, EntropyProposal, EntropyRepairRowInput,
  EntropyReport, EntropySurfaceSnapshot, EntropyTraceInput, EntropyValueObservation,
} from "./types.js";

export const AUTO_APPLY_PROPOSAL_KINDS: readonly string[] = ["normal-form"];
export const entropyReviewSignals = (input: EntropyProposalInput): EntropyProposal[] =>
  proposeEntropyReductions(input).filter((proposal) =>
    ["declare-enum", "overload-split", "sequence-fuse"].includes(proposal.kind));
export const formatEntropyReviewSignal = (proposal: EntropyProposal): string => {
  if (proposal.kind === "declare-enum") {
    const values = proposal.values.slice(0, 4).map(String).join(", ");
    return `declare-enum ${proposal.ref}.${proposal.key} (${values}${proposal.values.length > 4 ? ", ..." : ""})`;
  }
  if (proposal.kind === "overload-split") return `overload-split ${proposal.ref} (${proposal.clusters.length} key-set clusters)`;
  if (proposal.kind === "sequence-fuse") return `sequence-fuse ${proposal.sequence.join(" -> ")}`;
  return `${proposal.kind} ${proposal.ref}`;
};
export interface CompileEntropyInput {
  traces: readonly EntropyTraceInput[];
  surface: EntropySurfaceSnapshot;
  repairs?: readonly EntropyRepairRowInput[];
  valueObservations?: readonly EntropyValueObservation[];
  auditCalls?: readonly EntropyAuditCall[];
  artifact?: CompiledSurfaceFile;
  catalogDigest?: string;
}
export type CompileEntropyStatus = "compiled" | "converged" | "rejected";
export interface CompileEntropyOutcome {
  status: CompileEntropyStatus;
  artifact?: CompiledSurfaceFile;
  report: EntropyReport;
  after?: EntropyReport;
  proposals: EntropyProposal[];
  gate?: EntropyGateResult;
}
const sortedActions = (surface: EntropySurfaceSnapshot) =>
  [...surface.actions].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
const finishCompile = (input: CompileEntropyInput, report: EntropyReport, plans: NormalFormPlan[]): CompileEntropyOutcome => {
  const review = entropyReviewSignals({ ...input, report });
  const previous = input.artifact;
  const current = previous?.version === COMPILED_SURFACE_VERSION &&
    previous.actions.length === 0 && previous.quarantined.length === 0 &&
    stableJsonHash(previous.normalizations ?? []) === stableJsonHash(plans);
  if (current || (!previous && plans.length === 0)) {
    return { status: "converged", ...(previous ? { artifact: previous } : {}), report, proposals: review };
  }
  const proposals: EntropyProposal[] = plans.map((plan) => ({
    kind: "normal-form", ref: plan.ref, baseSchemaDigest: plan.baseSchemaDigest, rules: plan.rules,
  }));
  // Historical outcomes are not rewritten into counterfactual successes.
  // A static proof preserves capability; future witness counts measure use.
  const gate: EntropyGateResult = { passed: true, beforeScore: report.score, afterScore: report.score, delta: 0, reasons: [] };
  const artifact: CompiledSurfaceFile = {
    ...emptyCompiledSurface(), normalizations: plans,
    applied: plans.slice(0, MAX_COMPILED_SURFACE_PROPOSALS).map((plan) => ({ kind: "normal-form", ref: plan.ref, detail: `${plan.rules.length} proven rules` })),
    gate: { passed: true, beforeScore: report.score, afterScore: report.score, reasons: [] },
    evidenceDigest: stableJsonHash({ surface: entropySurfaceHash(input.surface), plans }),
  };
  return { status: "compiled", artifact, report, after: report, proposals: [...proposals, ...review], gate };
};
export const compileEntropySurface = (input: CompileEntropyInput): CompileEntropyOutcome => {
  const report = measureEntropy({ ...input, catalogDigest: input.catalogDigest ?? entropySurfaceHash(input.surface) });
  const plans: NormalFormPlan[] = [];
  for (const action of sortedActions(input.surface)) {
    const plan = deriveNormalFormPlan(action.ref, action.inputSchema);
    if (plan && plans.length < MAX_NORMAL_FORM_PLANS) plans.push(plan);
  }
  return finishCompile(input, report, plans);
};
export const compileEntropySurfaceAsync = async (input: CompileEntropyInput): Promise<CompileEntropyOutcome> => {
  const report = await measureEntropyAsync({ ...input, catalogDigest: input.catalogDigest ?? entropySurfaceHash(input.surface) });
  const plans: NormalFormPlan[] = [];
  let processed = 0;
  for (const action of sortedActions(input.surface)) {
    const plan = deriveNormalFormPlan(action.ref, action.inputSchema);
    if (plan && plans.length < MAX_NORMAL_FORM_PLANS) plans.push(plan);
    if (++processed % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return finishCompile(input, report, plans);
};
