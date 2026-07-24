import type { AgentWorkerOptions } from "../agents/types.js";

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
  const actorId = optional(args, "actor-id");
  const actorName = optional(args, "actor-name");
  const meshRoot = optional(args, "mesh-root");
  const projectRoot = optional(args, "project-root");
  const ownerHostId = optional(args, "owner-host-id");
  const ownerIdentityId = optional(args, "owner-identity-id");
  const runRoot = optional(args, "run-root");
  const steerFile = optional(args, "steer-file");
  const branch = optional(args, "branch");
  const worktree = optional(args, "worktree");
  const maxTokens = optional(args, "max-tokens");
  const runnerSessionId = optional(args, "runner-session-id");
  const mainAgentId = optional(args, "main-agent-id");
  const runner = required(args, "runner");
  if (runner !== "pi" && runner !== "claude") {
    throw new Error(`Unsupported Fabric agent runner: ${runner}`);
  }
  return {
    id: required(args, "id"),
    runner,
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
    timeoutMs: Number(required(args, "timeout-ms")),
    depth: Number(required(args, "depth")),
    fullCodeMode: required(args, "full-code-mode") === "true",
    ...(mainAgentId ? { mainAgentId } : {}),
    extensions: required(args, "extensions") === "true",
    tools: JSON.parse(required(args, "tools")) as string[],
    grantedRisks: JSON.parse(required(args, "granted-risks")) as string[],
    transport: required(args, "transport") as AgentWorkerOptions["transport"],
    ...(fabricExtensionPath ? { fabricExtensionPath } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(actorId ? { actorId } : {}),
    ...(actorName ? { actorName } : {}),
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
  };
};
