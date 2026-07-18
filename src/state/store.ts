import { spawn, type ChildProcess } from "node:child_process";
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
type StateTransitionPhase = "proposed" | "committed" | "rejected";

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
    before: MeshStateEntry | undefined;
  }>;
}

interface StateHeadValue {
  protocolVersion?: number;
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
  claimDigest: string;
  claimOmittedBytes?: number;
  command: string;
  commandDigest: string;
  commandOmittedBytes?: number;
  status: VerifyStatus;
  exitCode: number | null;
  output: string;
  outputBytes: number;
  outputOmittedBytes: number;
  outputDigest: string;
  error?: string;
  errorDigest?: string;
  errorOmittedBytes?: number;
}

interface StateCertificationTarget {
  transitionId: string;
  label: string;
  to: string;
}

interface StateCertificationHead {
  transitionId: string;
  label: string;
  labelDigest?: string;
  labelOmittedBytes?: number;
  to: string;
  toDigest?: string;
  toOmittedBytes?: number;
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
  reason:
    | "missing-target"
    | "missing-evidence"
    | "nonzero-exit"
    | "execution-error"
    | "reporting-error";
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
  reportingError?: string;
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
  outputBytes: number;
  outputOmittedBytes: number;
  outputDigest: string;
  error?: string;
}

export interface AdvanceHeadInput {
  payload: StateHeadValue;
  from: string | undefined;
  force: boolean;
  expectedVersion: number;
  identity: MeshIdentity;
}

interface AppliedStateWrite {
  key: string;
  before: MeshStateEntry | undefined;
  written: MeshStateEntry;
}

interface TransitionOutcome {
  event: MeshEvent;
  phase: "certified" | "violated";
}

const CAS_RETRY_LIMIT = 8;
const COMMAND_OUTPUT_MAX_BYTES = 32 * 1024;
const REPORT_TEXT_MAX_BYTES = 8 * 1024;
const EVENT_TEXT_MAX_BYTES = 1024;
const EVENT_OUTPUT_MAX_BYTES = 4 * 1024;
const EVENT_RESULT_LIMIT = 8;
const EVENT_TARGET_LIMIT = 16;
const EVENT_ROLLBACK_LIMIT = 8;
const TRANSITION_PROTOCOL_VERSION = 1;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

const truncateUtf8 = (
  value: string,
  maxBytes: number,
): { value: string; omittedBytes: number } => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, omittedBytes: 0 };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const bounded = bytes.subarray(0, end).toString("utf8");
  return { value: bounded, omittedBytes: bytes.length - end };
};

const boundedError = (error: unknown): string =>
  truncateUtf8(errorMessage(error), REPORT_TEXT_MAX_BYTES).value;

const casActualVersion = (error: unknown): number | undefined => {
  const match = errorMessage(error).match(/found (\d+)$/);
  return match ? Number(match[1]) : undefined;
};

const terminateWindowsTree = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.pid === undefined) {
      resolve();
      return;
    }
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    const treeKillCommand = ["task", "kill"].join("");
    const killer = spawn(treeKillCommand, ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
      finish();
    });
    killer.once("close", finish);
    timeout = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
        child.kill("SIGKILL");
      } catch {
        // Bounded best effort is all Windows can guarantee here.
      }
      finish();
    }, 1_000);
    timeout.unref?.();
  });

const terminateProcessTree = async (child: ChildProcess): Promise<void> => {
  if (process.platform === "win32") {
    await terminateWindowsTree(child);
    return;
  }
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process group may already have exited.
    }
  }
};

// Shell evidence is trusted input. Output is streamed into a byte-bounded
// prefix while a hash and byte count cover the complete stdout/stderr stream.
// POSIX shells lead detached process groups so timeout/abort can kill the
// group. Windows uses bounded taskkill tree cleanup and then a direct fallback.
const runCommand = (
  command: string,
  options: RunCommandOptions,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    let settled = false;
    let outputBytes = 0;
    const outputChunks: Buffer[] = [];
    let retainedBytes = 0;
    const outputHash = createHash("sha256");
    let timer: NodeJS.Timeout | undefined;
    let terminationReason: string | undefined;
    let termination: Promise<void> | undefined;
    let child: ChildProcess;

    const collect = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      outputHash.update(bytes);
      if (retainedBytes >= COMMAND_OUTPUT_MAX_BYTES) return;
      const retained = bytes.subarray(
        0,
        Math.min(bytes.length, COMMAND_OUTPUT_MAX_BYTES - retainedBytes),
      );
      outputChunks.push(retained);
      retainedBytes += retained.length;
    };
    const finish = (
      status: VerifyStatus,
      exitCode: number | null,
      error?: string,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      const retained = Buffer.concat(outputChunks);
      const boundedOutput = truncateUtf8(retained.toString("utf8"), retained.length);
      resolve({
        status,
        exitCode,
        output: boundedOutput.value,
        outputBytes,
        outputOmittedBytes: outputBytes - Buffer.byteLength(boundedOutput.value, "utf8"),
        outputDigest: `sha256:${outputHash.digest("hex")}`,
        ...(error !== undefined ? { error } : {}),
      });
    };
    const terminate = (reason: string): void => {
      if (terminationReason !== undefined) return;
      terminationReason = reason;
      if (timer) clearTimeout(timer);
      termination = terminateProcessTree(child);
      if (process.platform === "win32") {
        void termination.then(() => {
          const fallback = setTimeout(() => {
            child.stdout?.removeListener("data", collect);
            child.stderr?.removeListener("data", collect);
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish("error", null, reason);
          }, 100);
          fallback.unref?.();
        });
      }
    };
    const abort = (): void => terminate("aborted");

    try {
      child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      finish("error", null, errorMessage(error));
      return;
    }
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish("error", null, errorMessage(error)));
    child.once("close", (code) => {
      void (async () => {
        if (termination) await termination;
        if (terminationReason !== undefined) {
          finish("error", null, terminationReason);
          return;
        }
        const exitCode = typeof code === "number" ? code : null;
        if (exitCode === null) {
          finish("error", null, "process terminated by signal");
          return;
        }
        finish(exitCode === 0 ? "confirmed" : "violated", exitCode);
      })();
    });
    if (options.timeoutMs > 0) {
      timer = setTimeout(
        () => terminate(`timeout after ${options.timeoutMs}ms`),
        options.timeoutMs,
      );
      timer.unref?.();
    }
    if (options.signal) {
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
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

const transitionReference = (event: MeshEvent): string | undefined => {
  const data = event.data as Record<string, unknown> | undefined;
  return data && typeof data.transitionId === "string" ? data.transitionId : undefined;
};

const committedTransitionIds = (events: MeshEvent[]): Set<string> => {
  const committed = new Set<string>();
  const rejected = new Set<string>();
  for (const event of events) {
    const transitionId = transitionReference(event);
    if (!transitionId) continue;
    if (event.kind === "transition.committed") committed.add(transitionId);
    if (event.kind === "transition.rejected") rejected.add(transitionId);
  }
  for (const transitionId of rejected) committed.delete(transitionId);
  return committed;
};

const toRecord = (
  event: MeshEvent,
  committedIds?: ReadonlySet<string>,
): StateTransitionRecord | undefined => {
  if (event.kind !== "transition") return undefined;
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return undefined;
  if (
    data.phase === "proposed" &&
    (committedIds === undefined || !committedIds.has(event.id))
  ) {
    return undefined;
  }
  if (data.phase === "rejected") return undefined;
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
    ...(typeof head.labelDigest === "string" ? { labelDigest: head.labelDigest } : {}),
    ...(typeof head.labelOmittedBytes === "number"
      ? { labelOmittedBytes: head.labelOmittedBytes }
      : {}),
    to: head.to,
    ...(typeof head.toDigest === "string" ? { toDigest: head.toDigest } : {}),
    ...(typeof head.toOmittedBytes === "number"
      ? { toOmittedBytes: head.toOmittedBytes }
      : {}),
    version: head.version,
  };
};

const verificationTargets = (event: MeshEvent): StateCertificationTarget[] => {
  if (event.kind !== "state.certified" && event.kind !== "state.violated") return [];
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || !Array.isArray(data.targets)) return [];
  return data.targets
    .map(toCertificationTarget)
    .filter((target): target is StateCertificationTarget => target !== undefined);
};

const latestTransitionOutcomes = (events: MeshEvent[]): Map<string, TransitionOutcome> => {
  const latest = new Map<string, TransitionOutcome>();
  for (const event of events) {
    if (event.kind !== "state.certified" && event.kind !== "state.violated") continue;
    for (const target of verificationTargets(event)) {
      latest.set(target.transitionId, {
        event,
        phase: event.kind === "state.certified" ? "certified" : "violated",
      });
    }
  }
  return latest;
};

const toCertificate = (
  event: MeshEvent,
  currentHead: StateHead | null,
  latestOutcomes?: ReadonlyMap<string, TransitionOutcome>,
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
  const currentTarget =
    currentHead === null
      ? undefined
      : targets.find((target) => target.transitionId === currentHead.transitionId);
  const latestCurrentOutcome = currentTarget
    ? latestOutcomes?.get(currentTarget.transitionId)
    : undefined;
  const current =
    head !== null &&
    currentHead !== null &&
    currentTarget !== undefined &&
    head.transitionId === currentHead.transitionId &&
    (head.labelDigest
      ? head.labelDigest === digest(currentHead.label)
      : head.label === currentHead.label) &&
    (head.toDigest ? head.toDigest === digest(currentHead.to) : head.to === currentHead.to) &&
    head.version === currentHead.version &&
    (latestCurrentOutcome === undefined ||
      (latestCurrentOutcome.phase === "certified" &&
        latestCurrentOutcome.event.sequence === event.sequence));
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

const toVerifyResult = (
  claim: string,
  command: string,
  result: CommandResult,
): VerifyResult => {
  const boundedClaim = truncateUtf8(claim, REPORT_TEXT_MAX_BYTES);
  const boundedCommand = truncateUtf8(command, REPORT_TEXT_MAX_BYTES);
  const boundedResultError = result.error
    ? truncateUtf8(result.error, REPORT_TEXT_MAX_BYTES)
    : undefined;
  return {
    claim: boundedClaim.value,
    claimDigest: digest(claim),
    ...(boundedClaim.omittedBytes > 0
      ? { claimOmittedBytes: boundedClaim.omittedBytes }
      : {}),
    command: boundedCommand.value,
    commandDigest: digest(command),
    ...(boundedCommand.omittedBytes > 0
      ? { commandOmittedBytes: boundedCommand.omittedBytes }
      : {}),
    status: result.status,
    exitCode: result.exitCode,
    output: result.output,
    outputBytes: result.outputBytes,
    outputOmittedBytes: result.outputOmittedBytes,
    outputDigest: result.outputDigest,
    ...(boundedResultError
      ? {
          error: boundedResultError.value,
          errorDigest: digest(result.error),
          ...(boundedResultError.omittedBytes > 0
            ? { errorOmittedBytes: boundedResultError.omittedBytes }
            : {}),
        }
      : {}),
  };
};

const toEventResult = (result: VerifyResult): VerifyResult => {
  const claim = truncateUtf8(result.claim, EVENT_TEXT_MAX_BYTES);
  const command = truncateUtf8(result.command, EVENT_TEXT_MAX_BYTES);
  const output = truncateUtf8(result.output, EVENT_OUTPUT_MAX_BYTES);
  const error = result.error
    ? truncateUtf8(result.error, EVENT_TEXT_MAX_BYTES)
    : undefined;
  return {
    ...result,
    claim: claim.value,
    claimOmittedBytes: (result.claimOmittedBytes ?? 0) + claim.omittedBytes,
    command: command.value,
    commandOmittedBytes: (result.commandOmittedBytes ?? 0) + command.omittedBytes,
    output: output.value,
    outputOmittedBytes: result.outputOmittedBytes + output.omittedBytes,
    ...(error
      ? {
          error: error.value,
          errorOmittedBytes: (result.errorOmittedBytes ?? 0) + error.omittedBytes,
        }
      : {}),
  };
};

const toEventFailure = (failure: VerificationFailure): VerificationFailure => {
  const message = truncateUtf8(failure.message, EVENT_TEXT_MAX_BYTES).value;
  const transitionId = failure.transitionId
    ? truncateUtf8(failure.transitionId, EVENT_TEXT_MAX_BYTES).value
    : undefined;
  const label = failure.label
    ? truncateUtf8(failure.label, EVENT_TEXT_MAX_BYTES).value
    : undefined;
  const command = failure.command
    ? truncateUtf8(failure.command, EVENT_TEXT_MAX_BYTES).value
    : undefined;
  const error = failure.error
    ? truncateUtf8(failure.error, EVENT_TEXT_MAX_BYTES).value
    : undefined;
  return {
    ...failure,
    message,
    ...(transitionId !== undefined ? { transitionId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(error !== undefined ? { error } : {}),
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
    const storedHead = this.getHead();
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
    if (!entry) return null;
    const head = this.toHead(entry);
    const events = this.stateEvents();
    const committedIds = committedTransitionIds(events);
    if (head.protocolVersion === TRANSITION_PROTOCOL_VERSION) {
      return committedIds.has(head.transitionId) ? head : null;
    }
    const proposal = events.find(
      (event) => event.kind === "transition" && event.id === head.transitionId,
    );
    if (!proposal) return head;
    const data = proposal.data as Record<string, unknown> | undefined;
    return data?.phase === "proposed" && !committedIds.has(proposal.id) ? null : head;
  }

  async transition(
    input: StateTransitionInput,
    identity: MeshIdentity,
    cwd = process.cwd(),
  ): Promise<{ event: MeshEvent; head: StateHead }> {
    const physicalCurrent = this.store.get(CURRENT_KEY);
    const current = this.getHead();
    const expectedVersion =
      physicalCurrent?.version ?? this.lastDeletedVersion(CURRENT_KEY);
    if (physicalCurrent && !current) {
      throw new Error(
        "State contention: current head belongs to an uncommitted or quarantined proposal",
      );
    }
    const currentTo = current?.to;
    const force = input.force === true;
    if (!force && currentTo !== undefined && input.from !== undefined) {
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
      protocolVersion: TRANSITION_PROTOCOL_VERSION,
      phase: "proposed" satisfies StateTransitionPhase,
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
    const applied: AppliedStateWrite[] = [];
    let headWrite: AppliedStateWrite | undefined;
    try {
      for (const update of preparedComplexity?.updates ?? []) {
        const written = await this.store.put({
          key: update.key,
          value: update.value,
          ifVersion: update.expectedVersion,
          identity,
        });
        applied.push({ key: update.key, before: update.before, written });
      }
      const payload: StateHeadValue = {
        protocolVersion: TRANSITION_PROTOCOL_VERSION,
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
      const advanced = await this.advanceHeadWithBefore({
        payload,
        from: input.from,
        force,
        expectedVersion,
        identity,
      });
      headWrite = {
        key: CURRENT_KEY,
        before: advanced.before,
        written: advanced.entry,
      };
      await this.store.publish({
        topic: STATE_TOPIC,
        kind: "transition.committed",
        from: identity,
        text: "state transition committed",
        data: {
          protocolVersion: TRANSITION_PROTOCOL_VERSION,
          phase: "committed" satisfies StateTransitionPhase,
          transitionId: event.id,
          ts: Date.now(),
        },
      });
      return { event, head: this.toHead(advanced.entry) };
    } catch (error) {
      const rollback = await this.rollbackWrites(
        [...(headWrite ? [headWrite] : []), ...applied.reverse()],
        identity,
      );
      let reportingError: string | undefined;
      try {
        const deletedChunks: Array<Array<{ key: string; version: number }>> = [];
        for (
          let index = 0;
          index < rollback.deleted.length;
          index += EVENT_ROLLBACK_LIMIT
        ) {
          deletedChunks.push(
            rollback.deleted.slice(index, index + EVENT_ROLLBACK_LIMIT).map((item) => ({
              key: truncateUtf8(item.key, REPORT_TEXT_MAX_BYTES).value,
              version: item.version,
            })),
          );
        }
        if (deletedChunks.length === 0) deletedChunks.push([]);
        for (let index = 0; index < deletedChunks.length; index++) {
          await this.store.publish({
            topic: STATE_TOPIC,
            kind: "transition.rejected",
            from: identity,
            text: rollback.errors.length > 0
              ? "state transition quarantined"
              : "state transition rejected",
            data: {
              protocolVersion: TRANSITION_PROTOCOL_VERSION,
              phase: "rejected" satisfies StateTransitionPhase,
              transitionId: event.id,
              error: truncateUtf8(errorMessage(error), EVENT_TEXT_MAX_BYTES).value,
              rollback: {
                restored: rollback.errors.length === 0,
                deleted: deletedChunks[index],
                errors: index === 0
                  ? rollback.errors
                    .slice(0, EVENT_ROLLBACK_LIMIT)
                    .map((item) => truncateUtf8(item, EVENT_TEXT_MAX_BYTES).value)
                  : [],
                omittedErrorCount: Math.max(
                  0,
                  rollback.errors.length - EVENT_ROLLBACK_LIMIT,
                ),
                chunk: { index, count: deletedChunks.length },
              },
              quarantine: rollback.errors.length > 0,
              ts: Date.now(),
            },
          });
        }
      } catch (publishError) {
        reportingError = boundedError(publishError);
      }
      const detail = [
        `State transition rejected: ${boundedError(error)}`,
        ...(rollback.errors.length > 0
          ? [`rollback quarantine: ${rollback.errors.join("; ")}`]
          : []),
        ...(reportingError ? [`rejection reporting failed: ${reportingError}`] : []),
      ].join("; ");
      throw new Error(detail, { cause: error });
    }
  }

  // Advance the compare-and-swap head pointer for a durable proposal. The
  // proposal remains invisible until its commit marker. On CAS contention we
  // re-read, re-validate `from` against the new head, and retry — a bounded
  // number of times. If `from` no longer chains from the current head, the
  // transition is rejected with the actual current label (Schema's surprise:
  // the plan's assumed state was voided by a concurrent writer).
  async advanceHead(input: AdvanceHeadInput): Promise<MeshStateEntry> {
    return (await this.advanceHeadWithBefore(input)).entry;
  }

  private async advanceHeadWithBefore(
    input: AdvanceHeadInput,
  ): Promise<{ entry: MeshStateEntry; before: MeshStateEntry | undefined }> {
    let version = input.expectedVersion;
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt++) {
      const before = this.store.get(CURRENT_KEY);
      try {
        const entry = await this.store.put({
          key: CURRENT_KEY,
          value: input.payload,
          ifVersion: version,
          identity: input.identity,
        });
        return { entry, before };
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
        version = current?.version ?? casActualVersion(error) ?? 0;
      }
    }
    throw new Error(
      `State contention: compare-and-swap retries exhausted after ${CAS_RETRY_LIMIT} attempts`,
    );
  }

  private async rollbackWrites(
    writes: AppliedStateWrite[],
    identity: MeshIdentity,
  ): Promise<{ deleted: Array<{ key: string; version: number }>; errors: string[] }> {
    const deleted: Array<{ key: string; version: number }> = [];
    const errors: string[] = [];
    for (const write of writes) {
      try {
        if (write.before) {
          await this.store.put({
            key: write.key,
            value: write.before.value,
            ifVersion: write.written.version,
            identity,
          });
        } else {
          const result = await this.store.delete({
            key: write.key,
            ifVersion: write.written.version,
          });
          if (result.deleted && result.version !== undefined) {
            deleted.push({ key: write.key, version: result.version });
          }
        }
      } catch (error) {
        errors.push(`${write.key}: ${boundedError(error)}`);
      }
    }
    return { deleted, errors };
  }

  private stateEvents(): MeshEvent[] {
    return this.store.read({ topic: STATE_TOPIC, limit: this.store.maxReadEvents });
  }

  private lastDeletedVersion(key: string): number {
    const events = this.stateEvents();
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event?.kind !== "transition.rejected") continue;
      const data = event.data as Record<string, unknown> | undefined;
      const rollback = data?.rollback as Record<string, unknown> | undefined;
      if (!rollback || !Array.isArray(rollback.deleted)) continue;
      for (const item of rollback.deleted) {
        if (!item || typeof item !== "object") continue;
        const deleted = item as Record<string, unknown>;
        if (deleted.key === key && typeof deleted.version === "number") {
          return deleted.version;
        }
      }
    }
    return 0;
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
    const events = this.stateEvents();
    const committedIds = committedTransitionIds(events);
    const records: StateTransitionRecord[] = [];
    for (const event of events) {
      const record = toRecord(event, committedIds);
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
    const currentHead = this.getHead();
    const latestOutcomes = latestTransitionOutcomes(events);
    const certifications = events
      .map((event) => toCertificate(event, currentHead, latestOutcomes))
      .filter((certificate): certificate is StateCertificate => certificate !== undefined)
      .filter((certificate) =>
        certificate.targets.every((target) => visibleIds.has(target.transitionId)),
      )
      .reverse();
    const certificatesBySequence = new Map(
      certifications.map((certificate) => [certificate.sequence, certificate]),
    );
    const latestCertificate = new Map<string, StateCertificate>();
    for (const record of visibleRecords) {
      const outcome = latestOutcomes.get(record.transitionId);
      if (outcome?.phase !== "certified") continue;
      const certificate = certificatesBySequence.get(outcome.event.sequence);
      if (certificate) latestCertificate.set(record.transitionId, certificate);
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
      const key = this.complexityKey(file);
      updates.push({
        key,
        value: {
          file,
          language: measured.language,
          count: measured.count,
          lastDelta: delta,
          ts,
        },
        expectedVersion: entry?.version ?? this.lastDeletedVersion(key),
        before: entry,
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
      const check = truncateUtf8(goal.check, EVENT_TEXT_MAX_BYTES);
      const output = truncateUtf8(result.output, EVENT_OUTPUT_MAX_BYTES);
      await this.store.publish({
        topic: STATE_TOPIC,
        kind: "state.goal.met",
        from: input.identity,
        text: "goal met",
        data: {
          check: check.value,
          checkDigest: digest(goal.check),
          checkOmittedBytes: check.omittedBytes,
          output: output.value,
          outputBytes: result.outputBytes,
          outputOmittedBytes: result.outputOmittedBytes + output.omittedBytes,
          outputDigest: result.outputDigest,
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
    const boundedHeadLabel = verificationHead
      ? truncateUtf8(verificationHead.label, EVENT_TEXT_MAX_BYTES)
      : undefined;
    const boundedHeadTo = verificationHead
      ? truncateUtf8(verificationHead.to, EVENT_TEXT_MAX_BYTES)
      : undefined;
    const headIdentity: StateCertificationHead | null =
      verificationHead && boundedHeadLabel && boundedHeadTo
        ? {
            transitionId: verificationHead.transitionId,
            label: boundedHeadLabel.value,
            labelDigest: digest(verificationHead.label),
            ...(boundedHeadLabel.omittedBytes > 0
              ? { labelOmittedBytes: boundedHeadLabel.omittedBytes }
              : {}),
            to: boundedHeadTo.value,
            toDigest: digest(verificationHead.to),
            ...(boundedHeadTo.omittedBytes > 0
              ? { toOmittedBytes: boundedHeadTo.omittedBytes }
              : {}),
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
              outputBytes: 0,
              outputOmittedBytes: 0,
              outputDigest: digest(""),
              error: "aborted before execution",
            }
          : await runCommand(command, {
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? 30_000,
              ...(input.signal ? { signal: input.signal } : {}),
            });
        results.push(toVerifyResult(target.summary, command, result));
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

    let certified =
      results.length > 0 &&
      failures.length === 0 &&
      results.every((result) => result.status === "confirmed");
    let resultDigest = digest({ results, failures });
    const boundedTargets = certificationTargets.map((target) => ({
      transitionId: truncateUtf8(target.transitionId, EVENT_TEXT_MAX_BYTES).value,
      label: truncateUtf8(target.label, EVENT_TEXT_MAX_BYTES).value,
      to: truncateUtf8(target.to, EVENT_TEXT_MAX_BYTES).value,
    }));
    const targetChunks: StateCertificationTarget[][] = [];
    for (let index = 0; index < boundedTargets.length; index += EVENT_TARGET_LIMIT) {
      targetChunks.push(boundedTargets.slice(index, index + EVENT_TARGET_LIMIT));
    }
    if (targetChunks.length === 0) targetChunks.push([]);
    const publishViolation = async (): Promise<string | undefined> => {
      const nonConfirmed = results.filter((result) => result.status !== "confirmed");
      try {
        for (let index = 0; index < targetChunks.length; index++) {
          await this.store.publish({
            topic: STATE_TOPIC,
            kind: "state.violated",
            from: input.identity,
            text: "state certification blocked",
            data: {
              certified: false,
              head: headIdentity,
              evidenceDigest,
              resultDigest,
              targets: targetChunks[index],
              targetChunk: { index, count: targetChunks.length },
              results: index === 0
                ? nonConfirmed.slice(0, EVENT_RESULT_LIMIT).map(toEventResult)
                : [],
              omittedResultCount: Math.max(0, nonConfirmed.length - EVENT_RESULT_LIMIT),
              reasons: index === 0
                ? failures.slice(0, EVENT_RESULT_LIMIT).map(toEventFailure)
                : [],
              omittedReasonCount: Math.max(0, failures.length - EVENT_RESULT_LIMIT),
              ts: Date.now(),
            },
          });
        }
        return undefined;
      } catch (error) {
        return boundedError(error);
      }
    };

    if (!certified) {
      const reportingError = await publishViolation();
      return {
        results,
        certified: false,
        violated: true,
        certificationStatus: "failed",
        evidenceDigest,
        resultDigest,
        failures,
        ...(reportingError ? { reportingError } : {}),
      };
    }

    const ts = Date.now();
    try {
      let certificateEvent: MeshEvent | undefined;
      for (let index = 0; index < targetChunks.length; index++) {
        const event = await this.store.publish({
          topic: STATE_TOPIC,
          kind: "state.certified",
          from: input.identity,
          text: "state certified",
          data: {
            certificationStatus: "certified",
            targets: targetChunks[index],
            targetChunk: { index, count: targetChunks.length },
            head: headIdentity,
            evidenceDigest,
            resultDigest,
            ts,
          },
        });
        if (
          certificateEvent === undefined ||
          targetChunks[index]?.some(
            (target) => target.transitionId === headIdentity?.transitionId,
          )
        ) {
          certificateEvent = event;
        }
      }
      if (!certificateEvent) throw new Error("State certificate event was not recorded");
      const certificate = toCertificate(certificateEvent, this.getHead());
      if (!certificate) throw new Error("State certificate event was malformed");
      return {
        results,
        certified: true,
        violated: false,
        certificationStatus: "certified",
        evidenceDigest,
        resultDigest,
        failures,
        certificate,
      };
    } catch (error) {
      certified = false;
      const certificationReportingError = boundedError(error);
      failures.push({
        reason: "reporting-error",
        message: `Certification could not be recorded: ${certificationReportingError}`,
        error: certificationReportingError,
      });
      resultDigest = digest({ results, failures });
      const violationReportingError = await publishViolation();
      const reportingError = violationReportingError
        ? `${certificationReportingError}; violation reporting failed: ${violationReportingError}`
        : certificationReportingError;
      return {
        results,
        certified,
        violated: true,
        certificationStatus: "failed",
        evidenceDigest,
        resultDigest,
        failures,
        reportingError,
      };
    }
  }
}
