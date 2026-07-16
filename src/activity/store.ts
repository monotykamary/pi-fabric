import { randomUUID } from "node:crypto";
import { headlineArg } from "../core/call-preview.js";
import type { FabricInvocationActivityUpdate } from "../protocol.js";
import type {
  FabricActivityCall,
  FabricActivityEventInput,
  FabricActivityItem,
  FabricActivityItemInput,
  FabricActivityKind,
  FabricActivityMetrics,
  FabricActivityPhase,
  FabricActivityRun,
  FabricActivityStatus,
  FabricPhaseInput,
  FabricRunDisplay,
} from "./types.js";

const MAX_RUNS = 24;
const MAX_CALLS = 1_000;
const MAX_ITEMS = 1_000;
const MAX_EVENTS = 200;
const MAX_NAME_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_DETAIL_CHARS = 1_000;
const MAX_DATA_CHARS = 8_000;
const MAX_CALL_SUMMARY_CHARS = 120;

const terminalStatuses = new Set<FabricActivityStatus>([
  "completed",
  "failed",
  "stopped",
]);

const cleanText = (value: unknown, maxChars: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, maxChars);
};

const cleanId = (value: unknown, fallback: string): string => {
  const text = cleanText(value, 160);
  if (!text) return fallback;
  const safe = text.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback;
};

const boundedData = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? String(nested) : nested,
    );
    if (serialized === undefined) return undefined;
    if (serialized.length <= MAX_DATA_CHARS) return JSON.parse(serialized) as unknown;
    return {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, MAX_DATA_CHARS - 100),
    };
  } catch {
    return cleanText(String(value), MAX_DATA_CHARS);
  }
};

const kindForRef = (ref: string): FabricActivityKind => {
  if (ref.startsWith("agents.")) {
    return ["agents.create", "agents.ask", "agents.tell", "agents.actorStatus"].includes(ref)
      ? "actor"
      : "agent";
  }
  if (ref.startsWith("mcp.")) return "mcp";
  if (ref.startsWith("extensions.")) return "extension";
  if (ref.startsWith("mesh.")) return ref === "mesh.put" ? "task" : "mesh";
  return "tool";
};

const summarizeCallResult = (result: unknown): string | undefined => {
  let text: string | undefined;
  if (typeof result === "string") text = result;
  else if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.output === "string") text = record.output;
    else if (typeof record.content === "string") text = record.content;
    else if (typeof record.text === "string") text = record.text;
  }
  if (!text) return undefined;
  return cleanText(text.replace(/\s+/g, " "), MAX_CALL_SUMMARY_CHARS);
};

const labelForCall = (ref: string, args: Record<string, unknown>): string => {
  const explicit =
    cleanText(args.label, MAX_NAME_CHARS) ??
    cleanText(args.name, MAX_NAME_CHARS) ??
    cleanText(args.title, MAX_NAME_CHARS);
  if (explicit) return explicit;

  const target = headlineArg(args, MAX_NAME_CHARS);
  return target ? `${ref} · ${target}` : ref;
};

const metricsFrom = (value: unknown): FabricActivityMetrics | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage =
    typeof record.usage === "object" && record.usage !== null && !Array.isArray(record.usage)
      ? (record.usage as Record<string, unknown>)
      : undefined;
  const input = typeof usage?.input === "number" ? usage.input : 0;
  const output = typeof usage?.output === "number" ? usage.output : 0;
  const tokens = input + output;
  const toolCalls = typeof record.toolCalls === "number" ? record.toolCalls : undefined;
  const cost = typeof usage?.cost === "number" ? usage.cost : undefined;
  if (tokens <= 0 && toolCalls === undefined && cost === undefined) return undefined;
  return {
    ...(tokens > 0 ? { tokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
};

const isFailedResult = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = (value as Record<string, unknown>).status;
  return status === "failed" || status === "stopped" || status === "timed_out";
};

export class FabricActivityStore {
  readonly #runs = new Map<string, FabricActivityRun>();
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): void {
    if (this.#runs.size === 0) return;
    this.#runs.clear();
    this.#emit();
  }

  start(id: string, display: FabricRunDisplay = {}): FabricActivityRun {
    const now = Date.now();
    const name = cleanText(display.name, MAX_NAME_CHARS) ?? "Fabric program";
    const description = cleanText(display.description, MAX_DESCRIPTION_CHARS);
    const run: FabricActivityRun = {
      id,
      name,
      status: "running",
      phases: [],
      calls: [],
      items: [],
      events: [],
      startedAt: now,
      updatedAt: now,
      ...(description ? { description } : {}),
    };
    this.#runs.delete(id);
    this.#runs.set(id, run);
    this.#prune();
    this.#emit();
    return structuredClone(run);
  }

  configure(runId: string, display: FabricRunDisplay): FabricActivityRun {
    const run = this.#require(runId);
    const name = cleanText(display.name, MAX_NAME_CHARS);
    const description = cleanText(display.description, MAX_DESCRIPTION_CHARS);
    if (name) run.name = name;
    if (description) run.description = description;
    run.updatedAt = Date.now();
    this.#emit();
    return structuredClone(run);
  }

  phase(runId: string, input: FabricPhaseInput): FabricActivityPhase {
    const run = this.#require(runId);
    const name = cleanText(input.name, MAX_NAME_CHARS);
    if (!name) throw new Error("Workflow phase name must not be empty");
    const requestedId = cleanId(input.id, cleanId(name.toLowerCase(), `phase-${run.phases.length + 1}`));
    let phase = run.phases.find(
      (candidate) => candidate.id === requestedId || (!input.id && candidate.name === name),
    );
    const now = Date.now();

    if (run.currentPhaseId && run.currentPhaseId !== phase?.id) {
      const previous = run.phases.find((candidate) => candidate.id === run.currentPhaseId);
      if (previous?.status === "running") {
        previous.status = "completed";
        previous.updatedAt = now;
        previous.finishedAt = now;
      }
    }

    if (!phase) {
      let id = requestedId;
      let suffix = 2;
      while (run.phases.some((candidate) => candidate.id === id)) id = `${requestedId}-${suffix++}`;
      const description = cleanText(input.description, MAX_DESCRIPTION_CHARS);
      const total =
        typeof input.total === "number" && Number.isFinite(input.total)
          ? Math.max(0, Math.floor(input.total))
          : undefined;
      phase = {
        id,
        name,
        status: "running",
        startedAt: now,
        updatedAt: now,
        ...(description ? { description } : {}),
        ...(total !== undefined ? { total } : {}),
      };
      run.phases.push(phase);
    } else {
      phase.name = name;
      phase.status = "running";
      phase.updatedAt = now;
      delete phase.finishedAt;
      const description = cleanText(input.description, MAX_DESCRIPTION_CHARS);
      if (description) phase.description = description;
      if (typeof input.total === "number" && Number.isFinite(input.total)) {
        phase.total = Math.max(0, Math.floor(input.total));
      }
    }

    run.currentPhaseId = phase.id;
    run.updatedAt = now;
    if (run.name === "Fabric program" && run.phases.length === 1) run.name = name;
    this.#emit();
    return structuredClone(phase);
  }

  upsertItem(runId: string, input: FabricActivityItemInput): FabricActivityItem {
    const run = this.#require(runId);
    const id = cleanId(input.id, `item-${run.items.length + 1}`);
    const label = cleanText(input.label, MAX_NAME_CHARS);
    if (!label) throw new Error("Workflow activity item label must not be empty");
    const now = Date.now();
    const status = input.status ?? "running";
    let item = run.items.find((candidate) => candidate.id === id);
    const phaseId = this.#resolvePhaseId(run, input.phase);
    const detail = cleanText(input.detail, MAX_DETAIL_CHARS);
    const current = cleanText(input.current, MAX_DETAIL_CHARS);
    const total =
      typeof input.total === "number" && Number.isFinite(input.total)
        ? Math.max(0, Math.floor(input.total))
        : undefined;
    const completed =
      typeof input.completed === "number" && Number.isFinite(input.completed)
        ? Math.max(0, Math.floor(input.completed))
        : undefined;
    const data = boundedData(input.data);

    if (!item) {
      if (run.items.length >= MAX_ITEMS) run.items.splice(0, run.items.length - MAX_ITEMS + 1);
      item = {
        id,
        label,
        status,
        kind: input.kind ?? "custom",
        createdAt: now,
        updatedAt: now,
        ...(phaseId ? { phaseId } : {}),
        ...(detail ? { detail } : {}),
        ...(current ? { current } : {}),
        ...(total !== undefined ? { total } : {}),
        ...(completed !== undefined ? { completed } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(terminalStatuses.has(status) ? { finishedAt: now } : {}),
      };
      run.items.push(item);
    } else {
      item.label = label;
      item.status = status;
      item.kind = input.kind ?? item.kind;
      item.updatedAt = now;
      if (phaseId) item.phaseId = phaseId;
      if (detail) item.detail = detail;
      if (current) item.current = current;
      if (total !== undefined) item.total = total;
      if (completed !== undefined) item.completed = completed;
      if (data !== undefined) item.data = data;
      if (terminalStatuses.has(status)) item.finishedAt = now;
      else delete item.finishedAt;
    }

    run.updatedAt = now;
    this.#emit();
    return structuredClone(item);
  }

  event(runId: string, input: FabricActivityEventInput): void {
    const run = this.#require(runId);
    const message = cleanText(input.message, MAX_DETAIL_CHARS);
    if (!message) throw new Error("Workflow activity event message must not be empty");
    const data = boundedData(input.data);
    run.events.push({
      id: randomUUID(),
      message,
      level: input.level ?? "info",
      createdAt: Date.now(),
      ...(data !== undefined ? { data } : {}),
    });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    run.updatedAt = Date.now();
    this.#emit();
  }

  beginCall(
    runId: string,
    input: { callId: string; ref: string; args: Record<string, unknown> },
  ): void {
    const run = this.#require(runId);
    const now = Date.now();
    if (run.calls.length >= MAX_CALLS) run.calls.splice(0, run.calls.length - MAX_CALLS + 1);
    run.calls.push({
      id: input.callId,
      ref: input.ref,
      label: labelForCall(input.ref, input.args),
      kind: kindForRef(input.ref),
      status: "running",
      ...(run.currentPhaseId ? { phaseId: run.currentPhaseId } : {}),
      startedAt: now,
      updatedAt: now,
    });
    run.updatedAt = now;
    this.#emit();
  }

  updateCall(runId: string, callId: string, update: FabricInvocationActivityUpdate): void {
    const run = this.#require(runId);
    const call = run.calls.find((candidate) => candidate.id === callId);
    if (!call) return;
    const now = Date.now();
    if (update.type === "progress") {
      const message = cleanText(update.message, MAX_DETAIL_CHARS);
      if (message) call.progress = message;
    } else if (update.type === "entity") {
      call.entityId = cleanId(update.id, update.id);
      call.entityKind = update.kind;
      const name = cleanText(update.name, MAX_NAME_CHARS);
      if (name) call.label = name;
    } else if (update.type === "metrics") {
      call.metrics = {
        ...(call.metrics ?? {}),
        ...(typeof update.tokens === "number" ? { tokens: Math.max(0, update.tokens) } : {}),
        ...(typeof update.toolCalls === "number"
          ? { toolCalls: Math.max(0, update.toolCalls) }
          : {}),
        ...(typeof update.cost === "number" ? { cost: Math.max(0, update.cost) } : {}),
      };
    }
    call.updatedAt = now;
    run.updatedAt = now;
    this.#emit();
  }

  finishCall(
    runId: string,
    callId: string,
    input: { success: boolean; result?: unknown; error?: string },
  ): void {
    const run = this.#require(runId);
    const call = run.calls.find((candidate) => candidate.id === callId);
    if (!call) return;
    const now = Date.now();
    const resultFailed = isFailedResult(input.result);
    call.status = input.success && !resultFailed ? "completed" : "failed";
    call.updatedAt = now;
    call.finishedAt = now;
    const error = cleanText(input.error, MAX_DETAIL_CHARS);
    if (error) call.error = error;
    const metrics = metricsFrom(input.result);
    if (metrics) call.metrics = { ...(call.metrics ?? {}), ...metrics };
    if (call.status === "completed") {
      const detail = summarizeCallResult(input.result);
      if (detail) call.detail = detail;
    }
    if (typeof input.result === "object" && input.result !== null && !Array.isArray(input.result)) {
      const record = input.result as Record<string, unknown>;
      if (typeof record.id === "string") call.entityId = cleanId(record.id, record.id);
      if (call.kind === "agent") call.entityKind = "agent";
      if (call.kind === "actor") call.entityKind = "actor";
      if (!error && typeof record.error === "string") {
        const resultError = cleanText(record.error, MAX_DETAIL_CHARS);
        if (resultError) call.error = resultError;
      }
    }
    run.updatedAt = now;
    this.#emit();
  }

  finish(runId: string, success: boolean, error?: string): void {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running") return;
    const now = Date.now();
    const cancelled = Boolean(error && /cancel(?:led|ed)/i.test(error));
    run.status = success ? "completed" : cancelled ? "cancelled" : "failed";
    run.updatedAt = now;
    run.finishedAt = now;
    const cleanError = cleanText(error, MAX_DETAIL_CHARS);
    if (cleanError) run.error = cleanError;

    for (const phase of run.phases) {
      if (phase.status !== "running") continue;
      phase.status = success ? "completed" : "failed";
      phase.updatedAt = now;
      phase.finishedAt = now;
    }
    for (const call of run.calls) {
      if (call.status !== "running") continue;
      call.status = success ? "completed" : "failed";
      call.updatedAt = now;
      call.finishedAt = now;
    }
    for (const item of run.items) {
      if (item.status !== "running") continue;
      item.status = success ? "completed" : "failed";
      item.updatedAt = now;
      item.finishedAt = now;
    }
    this.#emit();
  }

  runs(): FabricActivityRun[] {
    return [...this.#runs.values()]
      .sort((left, right) => {
        if (left.status === "running" && right.status !== "running") return -1;
        if (right.status === "running" && left.status !== "running") return 1;
        return right.updatedAt - left.updatedAt;
      })
      .map((run) => structuredClone(run));
  }

  get(id: string): FabricActivityRun | undefined {
    const run = this.#runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  #resolvePhaseId(run: FabricActivityRun, phase: string | undefined): string | undefined {
    if (!phase) return run.currentPhaseId;
    return run.phases.find((candidate) => candidate.id === phase || candidate.name === phase)?.id;
  }

  #require(id: string): FabricActivityRun {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Unknown Fabric activity run: ${id}`);
    return run;
  }

  #prune(): void {
    if (this.#runs.size <= MAX_RUNS) return;
    const removable = [...this.#runs.values()]
      .filter((run) => run.status !== "running")
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.#runs.size > MAX_RUNS && removable.length > 0) {
      const run = removable.shift();
      if (run) this.#runs.delete(run.id);
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch { /* a listener throwing must not break the others */ }
    }
  }
}
