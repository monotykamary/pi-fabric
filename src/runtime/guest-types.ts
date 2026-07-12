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
}
interface FabricAgentHandle {
  id: string;
  name: string;
  status: string;
  transport: FabricTransport;
  cwd: string;
  sessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}
interface FabricAgentResult extends FabricAgentHandle {
  task: string;
  startedAt: number;
  finishedAt?: number;
  turns: number;
  toolCalls: number;
  text: string;
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
interface PiToolsApi {
  read(args: { path: string; offset?: number; limit?: number }): Promise<string>;
  bash(args: { command: string; timeout?: number }): Promise<{ ok: true; output: string; details: unknown }>;
  edit(args: { path: string; edits: Array<{ oldText: string; newText: string }> }): Promise<{ ok: true; output: string; details: unknown }>;
  write(args: { path: string; content: string }): Promise<{ ok: true; output: string; details: unknown }>;
  grep(args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
  find(args: { pattern: string; path?: string; limit?: number }): Promise<string>;
  ls(args?: { path?: string; limit?: number }): Promise<string>;
}
interface FabricAgentsApi {
  run(args: FabricAgentRequest): Promise<FabricAgentResult>;
  spawn(args: FabricAgentRequest): Promise<FabricAgentHandle>;
  wait(args: { id: string }): Promise<FabricAgentResult>;
  status(args: { id: string }): Promise<FabricAgentResult | FabricAgentHandle>;
  list(): Promise<Array<FabricAgentResult | FabricAgentHandle>>;
  stop(args: { id: string }): Promise<FabricAgentResult>;
  cleanup(args: { id: string; deleteBranch?: boolean }): Promise<{ cleaned: boolean }>;
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
interface FabricCouncilApi {
  run(args: {
    task: string;
    roles: string[];
    transport?: FabricTransport;
    model?: string;
    thinking?: FabricThinking;
    tools?: string[];
    timeoutMs?: number;
    worktree?: boolean;
    synthesize?: boolean;
  }): Promise<FabricAgentResult[] | FabricAgentResult>;
}
declare const tools: FabricToolsApi;
declare const pi: PiToolsApi;
declare const agents: FabricAgentsApi;
declare const mcp: FabricMcpApi;
declare const council: FabricCouncilApi;
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
`;
