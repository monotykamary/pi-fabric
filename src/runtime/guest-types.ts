export const GUEST_TYPE_DECLARATIONS = `
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type FabricTransport = "auto" | "process" | "tmux" | "screen" | "localterm" | "herdr";
type FabricAgentRunner = "pi" | "claude";
type FabricThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface FabricAction {
  ref: string;
  provider: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: "read" | "write" | "execute" | "network" | "agent";
  namespace?: string;
}
interface FabricAgentRequest {
  task: string;
  name?: string;
  runner?: FabricAgentRunner;
  transport?: FabricTransport;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  worktree?: boolean;
  schema?: Record<string, unknown>;
}
interface FabricMainAgentInfo {
  id: string;
  name: "Main";
  kind: "main";
  status: "idle" | "running" | "remote";
  runner: "pi";
  transport: "host";
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt?: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: boolean;
}
interface FabricPeerInfo {
  id: string;
  name: string;
  kind: "peer";
  status: "idle" | "running";
  runner: "pi";
  transport: "host";
  cwd: string;
  sessionId: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: false;
}
interface FabricAgentHandle {
  id: string;
  name: string;
  status: string;
  runner: FabricAgentRunner;
  transport: FabricTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  text?: string;
  value?: unknown;
  error?: string;
  logFile?: string;
}
interface FabricAgentResult extends FabricAgentHandle {
  task: string;
  startedAt: number;
  finishedAt?: number;
  turns: number;
  toolCalls: number;
  text: string;
  value?: unknown;
  error?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  pendingMessages?: { steering: string[]; followUp: string[] };
}
interface FabricModelInfo {
  runner?: FabricAgentRunner;
  provider: string;
  id: string;
  name: string;
  key: string;
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}
interface FabricLogLine {
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}
interface FabricSubagentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: FabricAgentResult;
  events: FabricLogLine[];
  hasMore: boolean;
  before?: number;
}
interface FabricActorLog {
  actorId: string;
  actorName: string;
  sessionFile: string;
  logDir: string;
  session: FabricLogLine[];
  sessionHasMore: boolean;
  sessionBefore?: number;
  run?: {
    runId: string;
    eventsFile: string;
    status?: FabricAgentResult;
    events: FabricLogLine[];
    hasMore: boolean;
    before?: number;
  };
  retainedRuns: string[];
}
interface FabricToolsApi {
  providers(): Promise<Array<{ name: string; description: string }>>;
  list(args?: { provider?: string; namespace?: string; query?: string; limit?: number }): Promise<FabricAction[]>;
  search(args: { query: string; limit?: number }): Promise<FabricAction[]>;
  describe(args: { ref: string }): Promise<FabricAction>;
  call(args: { ref: string; args?: Record<string, unknown> }): Promise<unknown>;
  progress(args: { message: string }): Promise<void>;
  models(): Promise<FabricModelInfo[]>;
}
interface FabricCapturedToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  text: string;
  details?: unknown;
  isError: boolean;
  terminate?: boolean;
  source: { path: string; source: string; scope: string; origin: string; baseDir?: string };
}
interface FabricCapturedTool {
  (args?: Record<string, unknown>): Promise<FabricCapturedToolResult>;
}
type FabricExtensionsApi = Record<string, FabricCapturedTool>;
// String-primary tools (read/bash/grep/find/ls) accept a bare string; the
// runtime proxy coerces it to { <primaryField>: string }. Lets the model write
// the natural form (pi.bash("ls")) instead of pi.bash({ command: "ls" }).
// Return shapes differ by tool: read/grep/find/ls return their text as a bare
// string (e.g. const src: string = await pi.read({ path })); bash/edit/write
// return { ok, output, details } (e.g. const { output } = await pi.bash(...)).
// Common alias keys (cmd→command, query→pattern, file→path, dir→path) and a
// flat edit shape ({ path, oldText, newText }) are also accepted; the runtime
// proxy normalizes them to the canonical form before the host validates args.
interface PiToolsApi {
  read(args: string | { path: string; offset?: number; limit?: number; start?: number; max?: number } | { file: string; offset?: number; limit?: number; start?: number; max?: number }): Promise<string>;
  bash(args: string | { command: string; timeout?: number; timeoutMs?: number } | { cmd: string; timeout?: number; timeoutMs?: number } | { shell: string; timeout?: number; timeoutMs?: number }): Promise<{ ok: true; output: string; details: unknown }>;
  edit(args: { path: string; edits: Array<{ oldText: string; newText: string }> } | { file: string; edits: Array<{ oldText: string; newText: string }> } | { path: string; oldText: string; newText: string } | { file: string; oldText: string; newText: string } | { path: string; old: string; new: string } | { path: string; old: string; replacement: string }): Promise<{ ok: true; output: string; details: unknown }>;
  edit(path: string, oldText: string, newText: string): Promise<{ ok: true; output: string; details: unknown }>;
  write(args: { path: string; content: string } | { file: string; content: string } | { path: string; contents: string } | { path: string; body: string } | { path: string; text: string }): Promise<{ ok: true; output: string; details: unknown }>;
  write(path: string, content: string): Promise<{ ok: true; output: string; details: unknown }>;
  grep(args: string | { pattern: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { query: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { regex: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number } | { search: string; path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number }): Promise<string>;
  grep(pattern: string, path?: string, limit?: number): Promise<string>;
  find(args: string | { pattern: string; path?: string; limit?: number; max?: number } | { query: string; path?: string; limit?: number; max?: number } | { regex: string; path?: string; limit?: number; max?: number } | { search: string; path?: string; limit?: number; max?: number }): Promise<string>;
  find(pattern: string, path?: string, limit?: number): Promise<string>;
  ls(args?: string | { path?: string; limit?: number; max?: number } | { dir?: string; limit?: number; max?: number } | { file?: string; limit?: number; max?: number }): Promise<string>;
}
type FabricActorHostEvent = "input" | "turn_end" | "agent_settled" | "tool_error" | "session_compact";
type FabricActorDelivery = "mailbox" | "steer" | "followUp" | "nextTurn";
interface FabricActorRequest {
  name: string;
  instructions: string;
  events?: FabricActorHostEvent[];
  topics?: string[];
  delivery?: FabricActorDelivery;
  responseMode?: "text" | "directive";
  triggerTurn?: boolean;
  coalesce?: boolean;
  runner?: FabricAgentRunner;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  transport?: FabricTransport;
  timeoutMs?: number;
  extensions?: boolean;
}
interface FabricActorInfo {
  id: string;
  name: string;
  status: "idle" | "queued" | "running" | "stopped";
  runner: FabricAgentRunner;
  events: FabricActorHostEvent[];
  topics: string[];
  delivery: FabricActorDelivery;
  responseMode: "text" | "directive";
  triggerTurn: boolean;
  coalesce: boolean;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  extensions?: boolean;
  queued: number;
  messages: number;
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastError?: string;
  sessionFile?: string;
  logDir?: string;
}
interface FabricActorMessage {
  id: string;
  actorId: string;
  actorName: string;
  direction: "in" | "out";
  source: string;
  createdAt: number;
  text?: string;
  data?: unknown;
  action?: "silent" | "message" | "stop";
  runId?: string;
  error?: string;
}
interface FabricAgentsApi {
  run(args: FabricAgentRequest): Promise<FabricAgentResult>;
  spawn(args: FabricAgentRequest): Promise<FabricAgentHandle>;
  wait(args: { id: string }): Promise<FabricAgentResult>;
  status(args: { id: string }): Promise<FabricAgentResult | FabricAgentHandle | FabricMainAgentInfo>;
  list(): Promise<Array<FabricAgentResult | FabricAgentHandle>>;
  main(): Promise<FabricMainAgentInfo>;
  peers(): Promise<FabricPeerInfo[]>;
  models(args?: { runner?: FabricAgentRunner; refresh?: boolean }): Promise<FabricModelInfo[]>;
  stop(args: { id: string }): Promise<FabricAgentResult>;
  cleanup(args: { id: string; deleteBranch?: boolean }): Promise<{ cleaned: boolean }>;
  create(args: FabricActorRequest): Promise<FabricActorInfo>;
  setTools(args: { id: string; tools: string[]; scope?: "project" | "global" }): Promise<FabricActorInfo>;
  setEvents(args: { id: string; events: FabricActorHostEvent[] }): Promise<FabricActorInfo>;
  setInstructions(args: {
    id: string;
    instructions: string;
    scope?: "project" | "global";
  }): Promise<FabricActorInfo>;
  ask(args: { id: string; message: string; data?: unknown }): Promise<FabricActorMessage>;
  tell(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string }>;
  steer(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string; routed?: "local" | "main" | "mesh" }>;
  followUp(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string; routed?: "local" | "main" | "mesh" }>;
  setSteeringMode(args: { id: string; mode: "all" | "one-at-a-time" }): Promise<{ queued: true; messageId: string }>;
  setFollowUpMode(args: { id: string; mode: "all" | "one-at-a-time" }): Promise<{ queued: true; messageId: string }>;
  actorStatus(args: { id: string }): Promise<FabricActorInfo>;
  actors(): Promise<FabricActorInfo[]>;
  messages(args: { id: string; limit?: number }): Promise<FabricActorMessage[]>;
  remove(args: { id: string }): Promise<{ removed: boolean }>;
  log(args: {
    id: string;
    type?: "session" | "run" | "all";
    lines?: number;
    before?: number;
    runId?: string;
  }): Promise<FabricActorLog | FabricSubagentLog>;
}
interface FabricMcpResult {
  text: string;
  content: unknown[];
  structuredContent: unknown;
}
interface FabricMcpTool {
  (args?: Record<string, unknown>): Promise<FabricMcpResult | unknown>;
}
interface FabricMcpServer {
  [tool: string]: FabricMcpTool;
}
type FabricMcpApi = Record<string, FabricMcpServer> & {
  servers(): Promise<Array<{ name: string; description: string | null; transport: "http" | "stdio" }>>;
  reload(): Promise<{ servers: string[] }>;
  register(args: {
    name: string;
    description?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    overwrite?: boolean;
  }): Promise<{ registered: string }>;
  call(args: { server: string; tool: string; args?: Record<string, unknown> }): Promise<unknown>;
};
interface FabricCouncilRunOptions {
  task: string;
  roles: string[];
  runner?: FabricAgentRunner;
  transport?: FabricTransport;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  timeoutMs?: number;
  worktree?: boolean;
}
interface FabricCouncilApi {
  run(args: FabricCouncilRunOptions & { synthesize?: true }): Promise<FabricAgentResult>;
  run(args: FabricCouncilRunOptions & { synthesize: false }): Promise<FabricAgentResult[]>;
}
interface FabricMeshIdentity {
  id: string;
  name: string;
  kind: "main" | "actor" | "agent";
  sessionId?: string;
}
interface FabricMeshEvent {
  id: string;
  sequence: number;
  topic: string;
  kind: string;
  from: FabricMeshIdentity;
  to?: string;
  text?: string;
  data?: unknown;
  createdAt: number;
}
interface FabricMeshStateEntry<T = unknown> {
  key: string;
  value: T;
  version: number;
  updatedAt: number;
  updatedBy: FabricMeshIdentity;
}
interface FabricMeshApi {
  self(): Promise<FabricMeshIdentity>;
  publish(args: { topic: string; kind?: string; to?: string; text?: string; data?: unknown }): Promise<FabricMeshEvent>;
  read(args?: { after?: number; topic?: string; to?: string; limit?: number }): Promise<FabricMeshEvent[]>;
  members(args?: { limit?: number }): Promise<Array<FabricMeshStateEntry<FabricActorInfo>>>;
  get<T = unknown>(args: { key: string }): Promise<FabricMeshStateEntry<T> | null>;
  list<T = unknown>(args?: { prefix?: string; limit?: number }): Promise<Array<FabricMeshStateEntry<T>>>;
  put<T = unknown>(args: { key: string; value: T; ifVersion?: number }): Promise<FabricMeshStateEntry<T>>;
  delete(args: { key: string; ifVersion?: number }): Promise<{ deleted: boolean; version?: number }>;
}
type FabricMemoryBranches = "active" | "all";
interface FabricMemoryEntryRange {
  first: number;
  last: number;
}
interface FabricMemoryRecallArgs {
  query?: string;
  queryMode?: "literal" | "regex";
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: FabricMemoryBranches;
  scope?: string;
  page?: number;
  pageSize?: number;
  role?: string;
  tool?: string;
  since?: number;
  until?: number;
  entryRange?: FabricMemoryEntryRange;
}
interface FabricMemoryRecallResult {
  scope?: string;
  branches?: FabricMemoryBranches;
  query?: string | null;
  queryMode?: "literal" | "regex";
  matchedCount?: number;
  totalMatches?: number;
  totalItems?: number;
  segmentCount?: number;
  segments?: unknown[];
  digestHits?: unknown[];
  items?: unknown[];
  page?: number;
  pageSize?: number;
  hasNext?: boolean;
  coverage?: unknown;
  text?: string;
  error?: { code: string; message: string; [key: string]: unknown };
}
interface FabricMemoryExpandArgs {
  session: string;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: FabricMemoryBranches;
  indices?: number[];
  entryIds?: string[];
  operationAddresses?: string[];
  entryRange?: FabricMemoryEntryRange;
}
interface FabricMemoryExpandResult {
  session?: string;
  sourceHash?: string;
  branches?: FabricMemoryBranches;
  lineageFingerprint?: string;
  expanded?: unknown[];
  error?: { code: string; message: string; [key: string]: unknown };
}
interface FabricMemorySessionInfo {
  id: string;
  file: string;
  cwd: string;
  mtime: number;
  entryCount: number;
  tier: "hot" | "cold";
  branches: FabricMemoryBranches;
  lineageFingerprint: string | null;
}
interface FabricMemoryApi {
  recall(args?: FabricMemoryRecallArgs): Promise<FabricMemoryRecallResult>;
  expand(args: FabricMemoryExpandArgs): Promise<FabricMemoryExpandResult>;
  sessions(args?: { scope?: string; branches?: FabricMemoryBranches }): Promise<{
    scope?: string;
    branches?: FabricMemoryBranches;
    sessions?: FabricMemorySessionInfo[];
    error?: { code: string; message: string; [key: string]: unknown };
  }>;
}
interface FabricStateTransitionArgs {
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind?: "state" | "representation";
  complexity?: { files: string[] };
  force?: boolean;
}
interface FabricStateComplexityFile {
  file: string;
  supported: boolean;
  language?: string;
  current?: number;
  recorded?: number;
  delta?: number;
  recordedDelta?: number;
}
interface FabricStateVerificationResult {
  certified: boolean;
  violated: boolean;
  certificationStatus: "certified" | "failed";
  results: unknown[];
  failures: unknown[];
  certificate?: unknown;
  reportingError?: string;
  evidenceDigest: string;
  resultDigest: string;
}
interface FabricStateApi {
  transition(args: FabricStateTransitionArgs): Promise<{ event: FabricMeshEvent; head: unknown }>;
  get(): Promise<{
    head: unknown | null;
    goal: { check: string; description?: string } | null;
    complexity: { files: number; decisionPoints: number; lastNetDelta: number };
    certification: { current: unknown | null; recent: unknown[] };
    recentLabels: string[];
  }>;
  history(args?: { label?: string; limit?: number; includeArchived?: boolean }): Promise<{
    transitions: unknown[];
    labels: string[];
    certifications: unknown[];
  }>;
  complexity(args?: { files?: string[] }): Promise<{ files: FabricStateComplexityFile[]; netDelta: number }>;
  verify(args?: { labels?: string[]; includeArchived?: boolean; timeoutMs?: number }): Promise<FabricStateVerificationResult>;
  goal(args: { check: string; description?: string }): Promise<FabricMeshStateEntry<{ check: string; description?: string }>>;
  checkGoal(args?: { timeoutMs?: number }): Promise<{
    passed: boolean;
    output: string;
    exitCode: number | null;
    error?: string;
  }>;
}
type FabricSchemaEvidence =
  | { kind: "file_exists"; path: string }
  | { kind: "file_absent"; path: string }
  | { kind: "file_contains"; path: string; literal: string }
  | { kind: "file_sha256"; path: string; sha256: string }
  | { kind: "trusted_command"; name: string };
type FabricSchemaFileOperation =
  | { kind: "write"; path: string; content: string; expected: { absent: true } | { sha256: string } }
  | { kind: "edit"; path: string; oldText: string; newText: string; expectedSha256: string }
  | { kind: "delete"; path: string; expectedSha256: string };
interface FabricSchemaEvidenceResult {
  evidence: FabricSchemaEvidence;
  status: "confirmed" | "nonconfirmed" | "error";
  detail: string;
  exitCode?: number | null;
  output?: string;
  observedSha256?: string;
}
interface FabricSchemaStatus {
  mode: "off" | "audit" | "enforce";
  certificateTtlMs: number;
  maxFiles: number;
  maxBytes: number;
  trustedCommands: string[];
  generation: number;
  lastOutcome: "committed" | "rolled_back" | "quarantined" | null;
  hypotheses: Array<{
    id: string;
    label: string;
    status: string;
    generation: number;
    updatedAt: number;
  }>;
}
interface FabricSchemaVerificationResult {
  verified: boolean;
  hypothesisId: string;
  certificate?: string;
  issuedAt?: number;
  expiresAt?: number;
  reason?: string;
  results: FabricSchemaEvidenceResult[];
}
interface FabricSchemaCommitResult {
  outcome: "committed" | "rolled_back" | "quarantined";
  transactionId: string;
  generation?: number;
  paths?: string[];
  postconditions?: FabricSchemaEvidenceResult[];
  complexityReductionCertified?: boolean;
  stateTransition?: unknown;
  error?: string;
  rollbackError?: string;
}
interface FabricSchemaApi {
  status(): Promise<FabricSchemaStatus>;
  hypothesize(args: {
    label: string;
    summary: string;
    evidence: FabricSchemaEvidence[];
    complexityReduction?: boolean;
  }): Promise<{
    hypothesisId: string;
    status: string;
    state: unknown;
    fingerprint: string;
    generation: number;
  }>;
  verify(args: { hypothesisId: string }): Promise<FabricSchemaVerificationResult>;
  commit(args: {
    hypothesisId: string;
    certificate: string;
    operations: FabricSchemaFileOperation[];
    postconditions: FabricSchemaEvidence[];
  }): Promise<FabricSchemaCommitResult>;
  abort(args: { hypothesisId: string; certificate?: string }): Promise<{
    aborted: true;
    hypothesisId: string;
  }>;
}
interface FabricCompactPendingIntent {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy: string;
  requestedAt: number;
}
interface FabricCompactLastCommit {
  at: number;
  requestedBy: string;
  status: "committed" | "failed";
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
}
interface FabricCompactApi {
  request(args?: {
    reason?: string;
    instructions?: string;
    preserve?: string[];
    requestedBy?: string;
  }): Promise<{ requested: true; intent: FabricCompactPendingIntent }>;
  status(): Promise<{ pending?: FabricCompactPendingIntent; last?: FabricCompactLastCommit }>;
  cancel(): Promise<{ cancelled: true }>;
}

interface FabricWorkflowAgentOptions extends Omit<FabricAgentRequest, "task"> {
  label?: string;
}
type FabricActivityStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";
type FabricActivityKind = "agent" | "actor" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";
interface FabricWorkflowDisplay {
  name?: string;
  description?: string;
}
interface FabricWorkflowPhaseOptions {
  id?: string;
  description?: string;
  total?: number;
}
interface FabricWorkflowPhaseInput extends FabricWorkflowPhaseOptions {
  name: string;
}
interface FabricWorkflowItem {
  id: string;
  label: string;
  status?: FabricActivityStatus;
  phase?: string;
  detail?: string;
  kind?: FabricActivityKind;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
}
interface FabricWorkflowApi {
  agent<T = string>(prompt: string, options?: FabricWorkflowAgentOptions): Promise<T>;
  parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
  parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
  pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
  configure(display: FabricWorkflowDisplay): Promise<FabricWorkflowDisplay>;
  phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
  phase(input: FabricWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
  item(item: FabricWorkflowItem): Promise<FabricWorkflowItem>;
  event(event: { message: string; level?: "info" | "success" | "warning" | "error"; data?: unknown }): Promise<void>;
  log(...values: unknown[]): void;
  budget: { total: number; spent(): number; remaining(): number };
}
declare const tools: FabricToolsApi;
declare const pi: PiToolsApi;
declare const extensions: FabricExtensionsApi;
declare const agents: FabricAgentsApi;
declare const mesh: FabricMeshApi;
declare const mcp: FabricMcpApi;
declare const memory: FabricMemoryApi;
declare const state: FabricStateApi;
declare const schema: FabricSchemaApi;
declare const compact: FabricCompactApi;
declare const council: FabricCouncilApi;
declare const workflow: FabricWorkflowApi;
declare function agent<T = string>(prompt: string, options?: FabricWorkflowAgentOptions): Promise<T>;
declare function parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
declare function parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
declare function pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
declare function phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
declare function phase(input: FabricWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
declare function log(...values: unknown[]): void;
declare const budget: FabricWorkflowApi["budget"];
type FabricRlmRequest = Omit<FabricAgentRequest, "runner" | "recursive"> & { runner?: "pi" };
declare const rlm: { query(args: FabricRlmRequest): Promise<FabricAgentResult> };
interface FabricConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
declare const console: FabricConsole;
declare const π: Readonly<Record<string, string>>;
declare function print(...args: unknown[]): void;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearTimeout(handle: number): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearInterval(handle: number): void;
`;

const FULL_CODE_GLOBAL_DECLARATIONS = [
  "declare const pi: PiToolsApi;\n",
  "declare const extensions: FabricExtensionsApi;\n",
];

export const guestTypeDeclarations = (fullCodeMode: boolean): string =>
  fullCodeMode
    ? GUEST_TYPE_DECLARATIONS
    : FULL_CODE_GLOBAL_DECLARATIONS.reduce(
        (declarations, declaration) => declarations.replace(declaration, ""),
        GUEST_TYPE_DECLARATIONS,
      );
