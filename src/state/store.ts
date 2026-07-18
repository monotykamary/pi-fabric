import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  MeshStore,
  type MeshEvent,
  type MeshIdentity,
  type MeshStateEntry,
} from "../mesh/store.js";
import { countFileComplexity } from "./complexity.js";

// The Fabric state layer is the Schema world-model heart: an append-only
// Timeline of typed, validated transitions stored as mesh events, plus a
// compare-and-swap head pointer that is recomputable from the log. Raw mesh
// calls (mesh.read / mesh.get) can inspect everything here. The typed state
// path validates calls that use it; it is not a gate on direct Pi tools.

export const STATE_TOPIC = "fabric.state";
export const CURRENT_KEY = "state/current";
export const GOAL_KEY = "state/goal";
export const COMPLEXITY_KEY_PREFIX = "state/complexity/";

export type StateTransitionKind = "state" | "representation";
type StateCertificationStatus = "pending" | "certified";

export interface StateTransitionInput {
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind?: StateTransitionKind;
  complexity?: { files: string[] };
  force?: boolean;
}

interface StateComplexityDelta {
  file: string;
  supported: boolean;
  language?: string;
  previous?: number;
  current?: number;
  delta?: number;
  baseline?: boolean;
}

interface StateTransitionComplexity {
  files: StateComplexityDelta[];
  netDelta: number;
}

interface StateComplexityFile {
  file: string;
  supported: boolean;
  language?: string;
  current?: number;
  recorded?: number;
  delta?: number;
  recordedDelta?: number;
}

export interface StateComplexityResult {
  files: StateComplexityFile[];
  netDelta: number;
}

export interface StateComplexitySummary {
  files: number;
  decisionPoints: number;
  lastNetDelta: number;
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
  complexity?: StateTransitionComplexity;
  certificationStatus?: StateCertificationStatus;
  certificate?: StateCertificate;
  ts: number;
}

interface ComplexityLedgerValue {
  file: string;
  language: string;
  count: number;
  lastDelta: number;
  ts: number;
}

interface PreparedComplexity {
  record: StateTransitionComplexity;
  updates: Array<{
    key: string;
    value: ComplexityLedgerValue;
    expectedVersion: number;
  }>;
}

interface StateHeadValue {
  label: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind: StateTransitionKind;
  transitionId: string;
  certificationStatus?: StateCertificationStatus;
  certificate?: StateCertificate;
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

interface VerifyResult {
  claim: string;
  command: string;
  status: VerifyStatus;
  exitCode: number | null;
  output: string;
  error?: string;
}

interface StateCertificationTarget {
  transitionId: string;
  label: string;
  to: string;
}

interface StateCertificationHead {
  transitionId: string;
  label: string;
  to: string;
  version: number;
}

export interface StateCertificate {
  certificateId: string;
  sequence: number;
  certificationStatus: "certified";
  targets: StateCertificationTarget[];
  head: StateCertificationHead | null;
  evidenceDigest: string;
  resultDigest: string;
  ts: number;
  current: boolean;
}

interface VerificationFailure {
  reason: "missing-target" | "missing-evidence" | "nonzero-exit" | "execution-error";
  message: string;
  transitionId?: string;
  label?: string;
  command?: string;
  status?: VerifyStatus;
  exitCode?: number | null;
  error?: string;
}

export interface VerificationReport {
  results: VerifyResult[];
  certified: boolean;
  violated: boolean;
  certificationStatus: "certified" | "failed";
  evidenceDigest: string;
  resultDigest: string;
  failures: VerificationFailure[];
  certificate?: StateCertificate;
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

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

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

const toComplexityRecord = (
  value: unknown,
): StateTransitionComplexity | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { files?: unknown; netDelta?: unknown };
  if (!Array.isArray(raw.files) || typeof raw.netDelta !== "number") {
    return undefined;
  }
  const files: StateComplexityDelta[] = [];
  for (const item of raw.files) {
    if (!item || typeof item !== "object") continue;
    const delta = item as Record<string, unknown>;
    if (typeof delta.file !== "string" || typeof delta.supported !== "boolean") {
      continue;
    }
    files.push({
      file: delta.file,
      supported: delta.supported,
      ...(typeof delta.language === "string" ? { language: delta.language } : {}),
      ...(typeof delta.previous === "number" ? { previous: delta.previous } : {}),
      ...(typeof delta.current === "number" ? { current: delta.current } : {}),
      ...(typeof delta.delta === "number" ? { delta: delta.delta } : {}),
      ...(typeof delta.baseline === "boolean" ? { baseline: delta.baseline } : {}),
    });
  }
  return { files, netDelta: raw.netDelta };
};

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
  const complexity = toComplexityRecord(data.complexity);
  const certificationStatus =
    data.certificationStatus === "pending" ? "pending" : undefined;
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
    ...(complexity !== undefined ? { complexity } : {}),
    ...(certificationStatus !== undefined ? { certificationStatus } : {}),
    ts,
  };
};

const toCertificationTarget = (value: unknown): StateCertificationTarget | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const target = value as Record<string, unknown>;
  if (
    typeof target.transitionId !== "string" ||
    typeof target.label !== "string" ||
    typeof target.to !== "string"
  ) {
    return undefined;
  }
  return {
    transitionId: target.transitionId,
    label: target.label,
    to: target.to,
  };
};

const toCertificationHead = (value: unknown): StateCertificationHead | null => {
  if (value === null) return null;
  if (!value || typeof value !== "object") return null;
  const head = value as Record<string, unknown>;
  if (
    typeof head.transitionId !== "string" ||
    typeof head.label !== "string" ||
    typeof head.to !== "string" ||
    typeof head.version !== "number"
  ) {
    return null;
  }
  return {
    transitionId: head.transitionId,
    label: head.label,
    to: head.to,
    version: head.version,
  };
};

const toCertificate = (
  event: MeshEvent,
  currentHead: StateHead | null,
): StateCertificate | undefined => {
  if (event.kind !== "state.certified") return undefined;
  const data = event.data as Record<string, unknown> | undefined;
  if (
    !data ||
    !Array.isArray(data.targets) ||
    typeof data.evidenceDigest !== "string" ||
    typeof data.resultDigest !== "string"
  ) {
    return undefined;
  }
  const targets = data.targets
    .map(toCertificationTarget)
    .filter((target): target is StateCertificationTarget => target !== undefined);
  if (targets.length === 0) return undefined;
  const head = toCertificationHead(data.head);
  const current =
    head !== null &&
    currentHead !== null &&
    head.transitionId === currentHead.transitionId &&
    head.version === currentHead.version &&
    targets.some((target) => target.transitionId === currentHead.transitionId);
  return {
    certificateId: event.id,
    sequence: event.sequence,
    certificationStatus: "certified",
    targets,
    head,
    evidenceDigest: data.evidenceDigest,
    resultDigest: data.resultDigest,
    ts: typeof data.ts === "number" ? data.ts : event.createdAt,
    current,
  };
};

export class StateStore {
  constructor(readonly store: MeshStore) {}

  toHead(entry: MeshStateEntry): StateHead {
    const value = entry.value as StateHeadValue;
    return { ...value, version: entry.version };
  }

  get(): {
    head: StateHead | null;
    goal: StateGoal | null;
    complexity: StateComplexitySummary;
    certification: {
      current: StateCertificate | null;
      recent: StateCertificate[];
    };
  } {
    const entry = this.store.get(CURRENT_KEY);
    const storedHead = entry ? this.toHead(entry) : null;
    const goalEntry = this.store.get(GOAL_KEY);
    const goal = goalEntry ? (goalEntry.value as StateGoal) : null;
    const ledgers = this.complexityLedgers();
    const history = this.history({});
    const lastComplexity = history.transitions
      .filter((transition) => transition.complexity !== undefined)
      .at(-1)?.complexity;
    const headRecord = storedHead
      ? history.transitions.find(
          (transition) => transition.transitionId === storedHead.transitionId,
        )
      : undefined;
    const head =
      storedHead && headRecord?.certificate
        ? {
            ...storedHead,
            certificationStatus: "certified" as const,
            certificate: headRecord.certificate,
          }
        : storedHead;
    const complexity = {
      files: ledgers.length,
      decisionPoints: ledgers.reduce((total, ledger) => total + ledger.count, 0),
      lastNetDelta: lastComplexity?.netDelta ?? 0,
    };
    return {
      head,
      goal,
      complexity,
      certification: {
        current: history.certifications.find((certificate) => certificate.current) ?? null,
        recent: history.certifications.slice(0, 20),
      },
    };
  }

  getHead(): StateHead | null {
    const entry = this.store.get(CURRENT_KEY);
    return entry ? this.toHead(entry) : null;
  }

  async transition(
    input: StateTransitionInput,
    identity: MeshIdentity,
    cwd = process.cwd(),
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
    const preparedComplexity = input.complexity
      ? this.prepareComplexity(input.complexity.files, cwd, ts)
      : undefined;
    const isComplexityReduction =
      preparedComplexity !== undefined && preparedComplexity.record.netDelta < 0;
    if (
      isComplexityReduction &&
      !input.evidence?.some((command) => command.trim().length > 0)
    ) {
      throw new Error(
        `State complexity reduction rejected: net decision-point delta is ${preparedComplexity.record.netDelta}. Reducing branches is also achievable by deleting error handling; attach at least one replayable behavior-preservation evidence command to separate abstraction from vandalism. The reduction remains pending until a later state.verify() succeeds.`,
      );
    }
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
      ...(preparedComplexity ? { complexity: preparedComplexity.record } : {}),
      ...(isComplexityReduction ? { certificationStatus: "pending" } : {}),
    };
    const event = await this.store.publish({
      topic: STATE_TOPIC,
      kind: "transition",
      from: identity,
      text: input.summary,
      data,
    });
    for (const update of preparedComplexity?.updates ?? []) {
      await this.store.put({
        key: update.key,
        value: update.value,
        ifVersion: update.expectedVersion,
        identity,
      });
    }
    const payload: StateHeadValue = {
      label: input.label,
      to: input.to,
      summary: input.summary,
      kind,
      transitionId: event.id,
      ts,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(isComplexityReduction ? { certificationStatus: "pending" } : {}),
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

  history(input: {
    label?: string;
    limit?: number;
    includeArchived?: boolean;
  } = {}): {
    transitions: StateTransitionRecord[];
    labels: string[];
    certifications: StateCertificate[];
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
    let lastRepresentation = -1;
    for (let index = records.length - 1; index >= 0; index--) {
      if (records[index]?.kind === "representation") {
        lastRepresentation = index;
        break;
      }
    }
    const visibleRecords =
      input.includeArchived || lastRepresentation < 0
        ? records
        : records.slice(lastRepresentation);
    const visibleIds = new Set(visibleRecords.map((record) => record.transitionId));
    const currentEntry = this.store.get(CURRENT_KEY);
    const currentHead = currentEntry ? this.toHead(currentEntry) : null;
    const certifications = events
      .map((event) => toCertificate(event, currentHead))
      .filter((certificate): certificate is StateCertificate => certificate !== undefined)
      .filter((certificate) =>
        certificate.targets.every((target) => visibleIds.has(target.transitionId)),
      )
      .reverse();
    const latestCertificate = new Map<string, StateCertificate>();
    for (const certificate of certifications) {
      for (const target of certificate.targets) {
        if (!latestCertificate.has(target.transitionId)) {
          latestCertificate.set(target.transitionId, certificate);
        }
      }
    }
    const archiveBoundaryId =
      input.includeArchived !== true && lastRepresentation > 0
        ? records[lastRepresentation]?.transitionId
        : undefined;
    const filtered = (input.label
      ? visibleRecords.filter(
          (record) =>
            record.label === input.label ||
            record.to === input.label ||
            (record.from === input.label &&
              record.transitionId !== archiveBoundaryId),
        )
      : visibleRecords
    ).map((record) => {
      const certificate = latestCertificate.get(record.transitionId);
      return certificate
        ? { ...record, certificationStatus: "certified" as const, certificate }
        : record;
    });
    const limited =
      input.limit !== undefined && input.limit > 0
        ? filtered.slice(0, input.limit)
        : filtered;
    const labelSet = new Set<string>();
    const limitedIds = new Set<string>();
    for (const record of limited) {
      limitedIds.add(record.transitionId);
      if (record.from && record.transitionId !== archiveBoundaryId) {
        labelSet.add(record.from);
      }
      labelSet.add(record.to);
      labelSet.add(record.label);
    }
    return {
      transitions: limited,
      labels: [...labelSet],
      certifications: certifications.filter((certificate) =>
        certificate.targets.some((target) => limitedIds.has(target.transitionId)),
      ),
    };
  }

  complexity(input: { files?: string[]; cwd: string }): StateComplexityResult {
    const requestedFiles = input.files ?? this.complexityLedgers().map((entry) => entry.file);
    const files: StateComplexityFile[] = [];
    let netDelta = 0;
    for (const file of this.normalizeComplexityFiles(requestedFiles, input.cwd)) {
      const measured = countFileComplexity(path.resolve(input.cwd, file));
      if (!measured) {
        files.push({ file, supported: false });
        continue;
      }
      const ledger = this.readComplexityLedger(file);
      const delta = ledger ? measured.count - ledger.count : 0;
      netDelta += delta;
      files.push({
        file,
        supported: true,
        language: measured.language,
        current: measured.count,
        ...(ledger
          ? {
              recorded: ledger.count,
              delta,
              recordedDelta: ledger.lastDelta,
            }
          : { delta: 0 }),
      });
    }
    return { files, netDelta };
  }

  private prepareComplexity(
    files: string[],
    cwd: string,
    ts: number,
  ): PreparedComplexity {
    const deltas: StateComplexityDelta[] = [];
    const updates: PreparedComplexity["updates"] = [];
    let netDelta = 0;
    for (const file of this.normalizeComplexityFiles(files, cwd)) {
      const measured = countFileComplexity(path.resolve(cwd, file));
      if (!measured) {
        deltas.push({ file, supported: false });
        continue;
      }
      const entry = this.store.get(this.complexityKey(file));
      const previous = entry ? (entry.value as ComplexityLedgerValue).count : undefined;
      const delta = previous === undefined ? 0 : measured.count - previous;
      netDelta += delta;
      deltas.push({
        file,
        supported: true,
        language: measured.language,
        ...(previous !== undefined ? { previous } : {}),
        current: measured.count,
        delta,
        baseline: previous === undefined,
      });
      updates.push({
        key: this.complexityKey(file),
        value: {
          file,
          language: measured.language,
          count: measured.count,
          lastDelta: delta,
          ts,
        },
        expectedVersion: entry?.version ?? 0,
      });
    }
    return { record: { files: deltas, netDelta }, updates };
  }

  private complexityLedgers(): ComplexityLedgerValue[] {
    return this.store
      .list(COMPLEXITY_KEY_PREFIX, this.store.maxReadEvents)
      .map((entry) => entry.value as ComplexityLedgerValue)
      .filter(
        (value) =>
          typeof value.file === "string" &&
          typeof value.language === "string" &&
          typeof value.count === "number" &&
          typeof value.lastDelta === "number",
      );
  }

  private readComplexityLedger(file: string): ComplexityLedgerValue | undefined {
    const entry = this.store.get(this.complexityKey(file));
    return entry ? (entry.value as ComplexityLedgerValue) : undefined;
  }

  private complexityKey(file: string): string {
    return `${COMPLEXITY_KEY_PREFIX}${file}`;
  }

  private normalizeComplexityFiles(files: string[], cwd: string): string[] {
    const normalized = new Set<string>();
    for (const file of files) {
      if (!file.trim()) continue;
      const relative = path.relative(cwd, path.resolve(cwd, file));
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`State complexity file must be inside the project cwd: ${file}`);
      }
      normalized.add(relative.split(path.sep).join("/"));
    }
    return [...normalized];
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
    includeArchived?: boolean;
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal | undefined;
    identity: MeshIdentity;
  }): Promise<VerificationReport> {
    const verificationHead = this.getHead();
    const headIdentity: StateCertificationHead | null = verificationHead
      ? {
          transitionId: verificationHead.transitionId,
          label: verificationHead.label,
          to: verificationHead.to,
          version: verificationHead.version,
        }
      : null;
    let targets: StateTransitionRecord[];
    if (input.labels !== undefined) {
      const matches = new Map<string, StateTransitionRecord>();
      for (const label of input.labels.filter((item) => item.trim().length > 0)) {
        const { transitions } = this.history({
          label,
          includeArchived: input.includeArchived === true,
        });
        for (const transition of transitions) {
          matches.set(transition.transitionId, transition);
        }
      }
      targets = [...matches.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );
    } else if (verificationHead) {
      const { transitions } = this.history({
        includeArchived: input.includeArchived === true,
      });
      const match = transitions.find(
        (record) => record.transitionId === verificationHead.transitionId,
      );
      targets = match ? [match] : [];
    } else {
      targets = [];
    }

    const certificationTargets: StateCertificationTarget[] = targets.map((target) => ({
      transitionId: target.transitionId,
      label: target.label,
      to: target.to,
    }));
    const evidenceDigest = digest(
      targets.map((target) => ({
        transitionId: target.transitionId,
        label: target.label,
        to: target.to,
        evidence: target.evidence ?? [],
      })),
    );
    const results: VerifyResult[] = [];
    const failures: VerificationFailure[] = [];
    if (targets.length === 0) {
      failures.push({
        reason: "missing-target",
        message:
          input.labels === undefined
            ? "No current state transition is available to verify"
            : "No active state transitions matched the requested labels",
      });
    }

    for (const target of targets) {
      const evidence = target.evidence ?? [];
      if (evidence.length === 0) {
        failures.push({
          reason: "missing-evidence",
          message: `Transition "${target.label}" has no executable evidence`,
          transitionId: target.transitionId,
          label: target.label,
        });
      }
      for (const command of evidence) {
        const result: CommandResult = input.signal?.aborted
          ? {
              status: "error",
              exitCode: null,
              output: "",
              error: "aborted before execution",
            }
          : await runCommand(command, {
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

    for (const result of results) {
      if (result.status === "confirmed") continue;
      failures.push({
        reason: result.status === "violated" ? "nonzero-exit" : "execution-error",
        message:
          result.status === "violated"
            ? `Evidence exited nonzero (${result.exitCode ?? "unknown"}): ${result.command}`
            : `Evidence could not be confirmed: ${result.command}${result.error ? ` (${result.error})` : ""}`,
        command: result.command,
        status: result.status,
        exitCode: result.exitCode,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    }

    const certified =
      results.length > 0 &&
      failures.length === 0 &&
      results.every((result) => result.status === "confirmed");
    const violated = !certified;
    const resultDigest = digest({ results, failures });
    if (!certified) {
      await this.store.publish({
        topic: STATE_TOPIC,
        kind: "state.violated",
        from: input.identity,
        text: "state certification blocked",
        data: {
          certified,
          evidenceDigest,
          resultDigest,
          targets: certificationTargets,
          results: results.filter((result) => result.status !== "confirmed"),
          reasons: failures,
        },
      });
      return {
        results,
        certified,
        violated,
        certificationStatus: "failed",
        evidenceDigest,
        resultDigest,
        failures,
      };
    }

    const ts = Date.now();
    const event = await this.store.publish({
      topic: STATE_TOPIC,
      kind: "state.certified",
      from: input.identity,
      text: "state certified",
      data: {
        certificationStatus: "certified",
        targets: certificationTargets,
        head: headIdentity,
        evidenceDigest,
        resultDigest,
        ts,
      },
    });
    const certificate = toCertificate(event, this.getHead());
    if (!certificate) throw new Error("State certificate event was malformed");
    return {
      results,
      certified,
      violated,
      certificationStatus: "certified",
      evidenceDigest,
      resultDigest,
      failures,
      certificate,
    };
  }
}
