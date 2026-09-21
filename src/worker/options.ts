import type { AgentRunCarryOver, AgentWorkerOptions } from "../agents/types.js";

const argumentMap = (argv: readonly string[]): Map<string, string> => {
  const result = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid worker argument near ${key ?? "<end>"}`);
    }
    result.set(key.slice(2), value);
  }
  return result;
};

const required = (args: Map<string, string>, name: string): string => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing worker argument: --${name}`);
  return value;
};

const optional = (args: Map<string, string>, name: string): string | undefined =>
  args.get(name) || undefined;

const nonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Cumulative totals a relaunched attempt seeds its fresh run record with. */
const carryOverTotals = (value: unknown): AgentRunCarryOver | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage =
    typeof source.usage === "object" && source.usage !== null && !Array.isArray(source.usage)
      ? (source.usage as Record<string, unknown>)
      : undefined;
  const turns = nonNegative(source.turns);
  const toolCalls = nonNegative(source.toolCalls);
  const input = usage ? nonNegative(usage.input) : undefined;
  const output = usage ? nonNegative(usage.output) : undefined;
  const cacheRead = usage ? nonNegative(usage.cacheRead) : undefined;
  const cacheWrite = usage ? nonNegative(usage.cacheWrite) : undefined;
  const cost = usage ? nonNegative(usage.cost) : undefined;
  if (
    turns === undefined ||
    toolCalls === undefined ||
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cost === undefined
  ) {
    return undefined;
  }
  return {
    turns: Math.floor(turns),
    toolCalls: Math.floor(toolCalls),
    usage: { input, output, cacheRead, cacheWrite, cost },
  };
};

export const parseWorkerOptions = (
  argv: readonly string[] = process.argv,
): AgentWorkerOptions => {
  const args = argumentMap(argv);
  const model = optional(args, "model");
  const thinking = optional(args, "thinking");
  const fabricExtensionPath = optional(args, "fabric-extension");
  const schemaFile = optional(args, "schema-file");
  const imagesFile = optional(args, "images-file");
  const systemPrompt = optional(args, "system-prompt");
  const sessionFile = optional(args, "session-file");
  const persistSessionSource = optional(args, "persist-session");
  if (persistSessionSource !== undefined && persistSessionSource !== "true" && persistSessionSource !== "false") {
    throw new Error("Invalid worker persist-session flag");
  }
  const persistSession = persistSessionSource === "true";
  const sessionExportFile = optional(args, "session-export-file");
  const actorId = optional(args, "actor-id");
  const actorName = optional(args, "actor-name");
  const capabilityRequirementsSource = optional(args, "capability-requirements");
  const capabilityDigest = optional(args, "capability-digest");
  const capabilityRequirements = capabilityRequirementsSource
    ? JSON.parse(capabilityRequirementsSource) as unknown
    : undefined;
  if (
    capabilityRequirements !== undefined &&
    (!Array.isArray(capabilityRequirements) ||
      capabilityRequirements.length > 128 ||
      capabilityRequirements.some((ref) => typeof ref !== "string" || ref.length > 256 || !ref.includes(".")))
  ) {
    throw new Error("Invalid worker capability requirements");
  }
  const meshRoot = optional(args, "mesh-root");
  const projectRoot = optional(args, "project-root");
  const ownerHostId = optional(args, "owner-host-id");
  const ownerIdentityId = optional(args, "owner-identity-id");
  const runRoot = optional(args, "run-root");
  const steerFile = optional(args, "steer-file");
  const branch = optional(args, "branch");
  const worktree = optional(args, "worktree");
  const maxTokens = optional(args, "max-tokens");
  const carryOverSource = optional(args, "carry-over");
  const runnerSessionId = optional(args, "runner-session-id");
  const inheritedSessionPinsSource = optional(args, "inherited-session-pins");
  const inheritedSessionPins = inheritedSessionPinsSource
    ? JSON.parse(inheritedSessionPinsSource) as AgentWorkerOptions["inheritedSessionPins"]
    : undefined;
  if (
    inheritedSessionPinsSource !== undefined &&
    (!Array.isArray(inheritedSessionPins) ||
      inheritedSessionPins.length === 0 ||
      inheritedSessionPins.some((pin) => typeof pin?.pool !== "string" || pin.pool.trim() === ""))
  ) {
    throw new Error("Invalid worker inherited session pins");
  }
  let carryOver: AgentRunCarryOver | undefined;
  if (carryOverSource) {
    try {
      carryOver = carryOverTotals(JSON.parse(carryOverSource));
    } catch {
      carryOver = undefined;
    }
    if (!carryOver) throw new Error("Invalid worker carry-over");
  }
  const mainAgentId = optional(args, "main-agent-id");
  const fabricSessionId = optional(args, "fabric-session-id");
  const runner = required(args, "runner");
  if (runner !== "pi" && runner !== "claude" && runner !== "veda") {
    throw new Error(`Unsupported Fabric agent runner: ${runner}`);
  }
  if (persistSession && runner !== "claude") {
    throw new Error("Worker persist-session requires the Claude runner");
  }
  const extensions = required(args, "extensions") === "true";
  const selectedKernel = args.get("kernel");
  const pythonRuntime = args.get("python-runtime") ?? "monty";
  if (pythonRuntime !== "cpython" && pythonRuntime !== "monty") {
    throw new Error(`Invalid worker Python runtime: ${pythonRuntime}`);
  }
  if (selectedKernel !== undefined && selectedKernel !== "typescript" && selectedKernel !== "python") {
    throw new Error(`Invalid worker kernel: ${selectedKernel}`);
  }
  if (selectedKernel !== undefined && (runner !== "pi" || !extensions)) {
    throw new Error("Explicit worker kernel requires the Pi runner with Fabric extensions enabled");
  }
  // Old launchers had no flag and always used TypeScript, regardless of ambient env.
  const kernel = runner === "pi" && extensions ? selectedKernel ?? "typescript" : undefined;
  return {
    id: required(args, "id"),
    runner,
    ...(kernel ? { kernel, pythonRuntime } : {}),
    name: required(args, "name"),
    taskFile: required(args, "task-file"),
    ...(imagesFile ? { imagesFile } : {}),
    statusFile: required(args, "status-file"),
    lifecycleFile: required(args, "lifecycle-file"),
    logFile: required(args, "log-file"),
    ...(schemaFile ? { schemaFile } : {}),
    cwd: required(args, "cwd"),
    piBinary: required(args, "pi-binary"),
    claudeBinary: required(args, "claude-binary"),
    vedaBinary: required(args, "veda-binary"),
    vedaBackend: required(args, "veda-backend"),
    vedaPersona: required(args, "veda-persona"),
    timeoutMs: Number(required(args, "timeout-ms")),
    depth: Number(required(args, "depth")),
    fullCodeMode: required(args, "full-code-mode") === "true",
    ...(mainAgentId ? { mainAgentId } : {}),
    ...(fabricSessionId ? { fabricSessionId } : {}),
    extensions,
    tools: JSON.parse(required(args, "tools")) as string[],
    grantedRisks: JSON.parse(required(args, "granted-risks")) as string[],
    transport: required(args, "transport") as AgentWorkerOptions["transport"],
    ...(fabricExtensionPath ? { fabricExtensionPath } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(persistSession ? { persistSession: true } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionExportFile ? { sessionExportFile } : {}),
    ...(actorId ? { actorId } : {}),
    ...(actorName ? { actorName } : {}),
    ...(capabilityRequirements
      ? { capabilityRequirements: [...new Set(capabilityRequirements as string[])] }
      : {}),
    ...(capabilityDigest ? { capabilityDigest } : {}),
    ...(meshRoot ? { meshRoot } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(ownerHostId ? { ownerHostId } : {}),
    ...(ownerIdentityId ? { ownerIdentityId } : {}),
    ...(runnerSessionId ? { runnerSessionId } : {}),
    ...(runRoot ? { runRoot } : {}),
    ...(steerFile ? { steerFile } : {}),
    ...(branch ? { branch } : {}),
    ...(worktree ? { worktree } : {}),
    ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
    ...(carryOver ? { carryOver } : {}),
    ...(inheritedSessionPins && inheritedSessionPins.length > 0 ? { inheritedSessionPins } : {}),
  };
};
