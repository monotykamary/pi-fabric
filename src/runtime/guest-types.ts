export const GUEST_TYPE_DECLARATIONS = `
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type FabricTransport = "auto" | "process" | "tmux" | "screen" | "localterm";
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
interface FabricAgentHandle {
  id: string;
  name: string;
  status: string;
  transport: FabricTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  sessionId?: string;
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
}
interface FabricToolsApi {
  providers(): Promise<Array<{ name: string; description: string }>>;
  list(args?: { provider?: string; namespace?: string; query?: string; limit?: number }): Promise<FabricAction[]>;
  search(args: { query: string; limit?: number }): Promise<FabricAction[]>;
  describe(args: { ref: string }): Promise<FabricAction>;
  call(args: { ref: string; args?: Record<string, unknown> }): Promise<unknown>;
  progress(args: { message: string }): Promise<void>;
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
  read(args: string | { path: string; offset?: number; limit?: number } | { file: string; offset?: number; limit?: number }): Promise<string>;
  bash(args: string | { command: string; timeout?: number } | { cmd: string; timeout?: number }): Promise<{ ok: true; output: string; details: unknown }>;
  edit(args: { path: string; edits: Array<{ oldText: string; newText: string }> } | { file: string; edits: Array<{ oldText: string; newText: string }> } | { path: string; oldText: string; newText: string } | { file: string; oldText: string; newText: string }): Promise<{ ok: true; output: string; details: unknown }>;
  write(args: { path: string; content: string } | { file: string; content: string }): Promise<{ ok: true; output: string; details: unknown }>;
  grep(args: string | { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number } | { query: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
  find(args: string | { pattern: string; path?: string; limit?: number } | { query: string; path?: string; limit?: number }): Promise<string>;
  ls(args?: string | { path?: string; limit?: number } | { dir?: string; limit?: number } | { file?: string; limit?: number }): Promise<string>;
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
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  transport?: FabricTransport;
  timeoutMs?: number;
}
interface FabricActorInfo {
  id: string;
  name: string;
  status: "idle" | "queued" | "running" | "stopped";
  events: FabricActorHostEvent[];
  topics: string[];
  delivery: FabricActorDelivery;
  responseMode: "text" | "directive";
  triggerTurn: boolean;
  coalesce: boolean;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  queued: number;
  messages: number;
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastError?: string;
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
  status(args: { id: string }): Promise<FabricAgentResult | FabricAgentHandle>;
  list(): Promise<Array<FabricAgentResult | FabricAgentHandle>>;
  stop(args: { id: string }): Promise<FabricAgentResult>;
  cleanup(args: { id: string; deleteBranch?: boolean }): Promise<{ cleaned: boolean }>;
  create(args: FabricActorRequest): Promise<FabricActorInfo>;
  ask(args: { id: string; message: string; data?: unknown }): Promise<FabricActorMessage>;
  tell(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string }>;
  actorStatus(args: { id: string }): Promise<FabricActorInfo>;
  actors(): Promise<FabricActorInfo[]>;
  messages(args: { id: string; limit?: number }): Promise<FabricActorMessage[]>;
  remove(args: { id: string }): Promise<{ removed: boolean }>;
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
  parallel<T>(thunks: Array<() => Promise<T> | T>, options?: { concurrency?: number }): Promise<T[]>;
  pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
  configure(display: FabricWorkflowDisplay): Promise<FabricWorkflowDisplay>;
  phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
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
declare const council: FabricCouncilApi;
declare const workflow: FabricWorkflowApi;
declare function agent<T = string>(prompt: string, options?: FabricWorkflowAgentOptions): Promise<T>;
declare function parallel<T>(thunks: Array<() => Promise<T> | T>, options?: { concurrency?: number }): Promise<T[]>;
declare function pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
declare function phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
declare function log(...values: unknown[]): void;
declare const budget: FabricWorkflowApi["budget"];
declare const rlm: { query(args: FabricAgentRequest): Promise<FabricAgentResult> };
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
