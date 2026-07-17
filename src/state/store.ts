import { spawn } from "node:child_process";
import {
  MeshStore,
  type MeshEvent,
  type MeshIdentity,
  type MeshStateEntry,
} from "../mesh/store.js";

// The Fabric state layer is the Schema world-model heart: an append-only
// Timeline of typed, validated transitions stored as mesh events, plus a
// compare-and-swap head pointer that is recomputable from the log. Raw mesh
// calls (mesh.read / mesh.get) can inspect everything here — storage is
// transparent, the typed WRITE path is the only enforced surface.

export const STATE_TOPIC = "fabric.state";
export const CURRENT_KEY = "state/current";
export const GOAL_KEY = "state/goal";

export type StateTransitionKind = "state" | "representation";

export interface StateTransitionInput {
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind?: StateTransitionKind;
  force?: boolean;
}

export interface StateTransitionRecord {
  transitionId: string;
  sequence: number;
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind: StateTransitionKind;
  ts: number;
}

interface StateHeadValue {
  label: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind: StateTransitionKind;
  transitionId: string;
  ts: number;
}

export interface StateHead extends StateHeadValue {
  version: number;
}

export interface StateGoal {
  check: string;
  description?: string;
}

type VerifyStatus = "confirmed" | "violated" | "error";

export interface VerifyResult {
  claim: string;
  command: string;
  status: VerifyStatus;
  exitCode: number | null;
  output: string;
  error?: string;
}

interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

interface CommandResult {
  status: VerifyStatus;
  exitCode: number | null;
  output: string;
  error?: string;
}

export interface AdvanceHeadInput {
  payload: StateHeadValue;
  from: string | undefined;
  force: boolean;
  expectedVersion: number;
  identity: MeshIdentity;
}

const CAS_RETRY_LIMIT = 8;

const isCasError = (error: unknown): boolean =>
  error instanceof Error && /compare-and-swap failed/.test(error.message);

const toStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) items.push(item);
  }
  return items.length > 0 ? items : undefined;
};

// Run a single evidence/goal shell command with a per-command timeout. Exit 0
// is confirmed; non-zero is violated; spawn failure or timeout is error. The
// optional AbortSignal cancels an in-flight command (verify/checkGoal honour
// the fabric_exec signal so a cancelled execution cannot leak a child).
const runCommand = (
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (
      status: VerifyStatus,
      exitCode: number | null,
      error?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status,
        exitCode,
        output,
        ...(error !== undefined ? { error } : {}),
      });
    };
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      finish(
        "error",
        null,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited; the close handler resolves.
        }
        finish("error", null, `timeout after ${options.timeoutMs}ms`);
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      finish("error", null, error.message);
    });
    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : null;
      if (exitCode === null) {
        finish("error", null, "process terminated by signal");
        return;
      }
      finish(exitCode === 0 ? "confirmed" : "violated", exitCode, undefined);
    });
    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited; close handler resolves.
          }
          finish("error", null, "aborted");
        },
        { once: true },
      );
    }
  });

const toRecord = (event: MeshEvent): StateTransitionRecord | undefined => {
  if (event.kind !== "transition") return undefined;
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return undefined;
  const label = typeof data.label === "string" ? data.label : "";
  const to = typeof data.to === "string" ? data.to : "";
  const summary = typeof data.summary === "string" ? data.summary : "";
  const kind =
    data.kind === "representation" ? "representation" : "state";
  const ts = typeof data.ts === "number" ? data.ts : event.createdAt;
  const from = typeof data.from === "string" ? data.from : undefined;
  const evidence = toStringArray(data.evidence);
  const tags = toStringArray(data.tags);
  if (!label || !to) return undefined;
  return {
    transitionId: event.id,
    sequence: event.sequence,
    label,
    ...(from !== undefined ? { from } : {}),
    to,
    summary,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(tags !== undefined ? { tags } : {}),
    kind,
    ts,
  };
};

export class StateStore {
  constructor(readonly store: MeshStore) {}

  toHead(entry: MeshStateEntry): StateHead {
    const value = entry.value as StateHeadValue;
    return { ...value, version: entry.version };
  }

  get(): { head: StateHead | null; goal: StateGoal | null } {
    const entry = this.store.get(CURRENT_KEY);
    const head = entry ? this.toHead(entry) : null;
    const goalEntry = this.store.get(GOAL_KEY);
    const goal = goalEntry ? (goalEntry.value as StateGoal) : null;
    return { head, goal };
  }

  getHead(): StateHead | null {
    const entry = this.store.get(CURRENT_KEY);
    return entry ? this.toHead(entry) : null;
  }

  async transition(
    input: StateTransitionInput,
    identity: MeshIdentity,
  ): Promise<{ event: MeshEvent; head: StateHead }> {
    const current = this.store.get(CURRENT_KEY);
    const expectedVersion = current ? current.version : 0;
    const currentTo = current ? (current.value as StateHeadValue).to : undefined;
    const force = input.force === true;
    if (!force && current && currentTo !== undefined && input.from !== undefined) {
      if (input.from !== currentTo) {
        throw new Error(
          `State from-mismatch: head is at "${currentTo}", but transition declares from "${input.from}"`,
        );
      }
    }
    const ts = Date.now();
    const kind: StateTransitionKind = input.kind ?? "state";
    const data: Record<string, unknown> = {
      label: input.label,
      to: input.to,
      summary: input.summary,
      kind,
      ts,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    };
    const event = await this.store.publish({
      topic: STATE_TOPIC,
      kind: "transition",
      from: identity,
      text: input.summary,
      data,
    });
    const payload: StateHeadValue = {
      label: input.label,
      to: input.to,
      summary: input.summary,
      kind,
      transitionId: event.id,
      ts,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    };
    const entry = await this.advanceHead({
      payload,
      from: input.from,
      force,
      expectedVersion,
      identity,
    });
    return { event, head: this.toHead(entry) };
  }

  // Advance the compare-and-swap head pointer. Appends are already durable in
  // the topic; this only moves the recomputable head. On CAS contention we
  // re-read, re-validate `from` against the new head, and retry — a bounded
  // number of times. If `from` no longer chains from the current head, the
  // transition is rejected with the actual current label (Schema's surprise:
  // the plan's assumed state was voided by a concurrent writer).
  async advanceHead(input: AdvanceHeadInput): Promise<MeshStateEntry> {
    let version = input.expectedVersion;
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt++) {
      try {
        return await this.store.put({
          key: CURRENT_KEY,
          value: input.payload,
          ifVersion: version,
          identity: input.identity,
        });
      } catch (error) {
        if (!isCasError(error)) throw error;
        const current = this.store.get(CURRENT_KEY);
        const actualTo = current
          ? (current.value as StateHeadValue).to
          : undefined;
        if (!input.force) {
          if (current && input.from !== undefined && actualTo !== undefined) {
            if (input.from !== actualTo) {
              throw new Error(
                `State contention: head is at "${actualTo}", cannot transition from "${input.from}"`,
              );
            }
          } else if (current && input.from === undefined) {
            throw new Error(
              `State contention: head advanced to "${actualTo ?? "<unknown>"}" before transition`,
            );
          }
        }
        version = current ? current.version : 0;
      }
    }
    throw new Error(
      `State contention: compare-and-swap retries exhausted after ${CAS_RETRY_LIMIT} attempts`,
    );
  }

  history(input: { label?: string; limit?: number } = {}): {
    transitions: StateTransitionRecord[];
    labels: string[];
  } {
    const events = this.store.read({
      topic: STATE_TOPIC,
      limit: this.store.maxReadEvents,
    });
    const records: StateTransitionRecord[] = [];
    for (const event of events) {
      const record = toRecord(event);
      if (record) records.push(record);
    }
    const filtered = input.label
      ? records.filter(
          (record) =>
            record.label === input.label ||
            record.to === input.label ||
            record.from === input.label,
        )
      : records;
    const limited =
      input.limit !== undefined && input.limit > 0
        ? filtered.slice(0, input.limit)
        : filtered;
    const labelSet = new Set<string>();
    for (const record of limited) {
      if (record.from) labelSet.add(record.from);
      labelSet.add(record.to);
      labelSet.add(record.label);
    }
    return { transitions: limited, labels: [...labelSet] };
  }

  async goal(
    input: { check: string; description?: string },
    identity: MeshIdentity,
  ): Promise<MeshStateEntry> {
    const value: StateGoal = {
      check: input.check,
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    return this.store.put({
      key: GOAL_KEY,
      value,
      identity,
    });
  }

  async checkGoal(input: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal | undefined;
    identity: MeshIdentity;
  }): Promise<{
    passed: boolean;
    output: string;
    exitCode: number | null;
    error?: string;
  }> {
    const entry = this.store.get(GOAL_KEY);
    if (!entry) throw new Error("No goal set");
    const goal = entry.value as StateGoal;
    const result = await runCommand(goal.check, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const passed = result.status === "confirmed";
    if (passed) {
      await this.store.publish({
        topic: STATE_TOPIC,
        kind: "state.goal.met",
        from: input.identity,
        text: "goal met",
        data: {
          check: goal.check,
          output: result.output,
          exitCode: result.exitCode,
        },
      });
    }
    return {
      passed,
      output: result.output,
      exitCode: result.exitCode,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  async verify(input: {
    labels?: string[];
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal | undefined;
    identity: MeshIdentity;
  }): Promise<{ results: VerifyResult[]; violated: boolean }> {
    let targets: StateTransitionRecord[];
    if (input.labels && input.labels.length > 0) {
      const set = new Set(input.labels);
      const { transitions } = this.history({});
      targets = transitions.filter(
        (record) =>
          set.has(record.label) ||
          set.has(record.to) ||
          (record.from !== undefined && set.has(record.from)),
      );
    } else {
      const head = this.getHead();
      if (!head) return { results: [], violated: false };
      const { transitions } = this.history({});
      const match = transitions.find(
        (record) => record.transitionId === head.transitionId,
      );
      targets = match ? [match] : [];
    }
    const results: VerifyResult[] = [];
    for (const target of targets) {
      const evidence = target.evidence ?? [];
      for (const command of evidence) {
        const result = await runCommand(command, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? 30_000,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        results.push({
          claim: target.summary,
          command,
          status: result.status,
          exitCode: result.exitCode,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
      }
    }
    const violated = results.some((result) => result.status === "violated");
    if (violated) {
      await this.store.publish({
        topic: STATE_TOPIC,
        kind: "state.violated",
        from: input.identity,
        text: "state violation",
        data: {
          results: results.filter((result) => result.status === "violated"),
        },
      });
    }
    return { results, violated };
  }
}
