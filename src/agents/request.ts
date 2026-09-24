import type { AgentRunRequest } from "./types.js";
import { isFabricThinking } from "../thinking.js";
import { aliasThinking, type FabricModelAliases } from "../core/model-resolution.js";

const stringArray = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
const checkedKernel = (value: unknown): AgentRunRequest["kernel"] => {
  if (value === undefined || value === "inherit" || value === "typescript" || value === "python") return value;
  throw new Error(`Invalid Fabric agent kernel: ${String(value)}`);
};

export const normalizeAgentRunRequest = (
  args: Record<string, unknown>,
  defaults: {runner: NonNullable<AgentRunRequest["runner"]>; model?: string; timeoutMs: number; inheritedModel?: {provider: string; id: string}; models?: {aliases?: FabricModelAliases}},
  options: {allowCwd?: boolean} = {},
): AgentRunRequest => {
  const transport =
    args.transport === "auto" ||
    args.transport === "process" ||
    args.transport === "tmux" ||
    args.transport === "screen" ||
    args.transport === "localterm" ||
    args.transport === "herdr"
      ? args.transport
      : undefined;
  // An explicit call or actor level always wins; otherwise an alias can carry
  // the intended effort for the model it selects (e.g. a "cheap" alias that is
  // both cheaper and shallower), and the global agents.thinking default applies
  // last, inside the manager.
  const requestedModel =
    typeof args.model === "string"
      ? args.model
      : typeof defaults.model === "string"
        ? defaults.model
        : undefined;
  const thinking = isFabricThinking(args.thinking)
    ? args.thinking
    : aliasThinking(defaults.models?.aliases, requestedModel ?? "");
  const tools = stringArray(args.tools);
  const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > defaults.timeoutMs ? args.timeoutMs : undefined;
  const runner =
    args.runner === "pi" || args.runner === "claude" || args.runner === "veda"
      ? args.runner
      : defaults.runner;
  const inheritedModel =
    runner === "pi" && !defaults.model && defaults.inheritedModel
      ? `${defaults.inheritedModel.provider}/${defaults.inheritedModel.id}`
      : undefined;
  const kernel = checkedKernel(args.kernel);
  if (args.recursive === true && args.extensions === false) {
    throw new Error("Recursive Fabric requires extensions enabled; omit recursive or extensions: false");
  }
  return {
    task: String(args.task),
    runner,
    ...(kernel !== undefined ? { kernel } : {}),
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(transport ? { transport } : {}),
    ...(typeof args.model === "string"
      ? { model: args.model }
      : inheritedModel
        ? { model: inheritedModel }
        : {}),
    ...(typeof args.persona === "string" && args.persona.trim()
      ? { persona: args.persona.trim() }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof args.extensions === "boolean"
      ? { extensions: args.extensions }
      : args.recursive === true ? { extensions: true } : {}),
    ...(typeof args.recursive === "boolean" ? { recursive: args.recursive } : {}),
    ...(options.allowCwd !== false && typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    ...(typeof args.worktree === "boolean" ? { worktree: args.worktree } : {}),
    ...(args.residency === "session" || args.residency === "durable"
      ? { residency: args.residency }
      : {}),
    ...(typeof args.persistSession === "boolean"
      ? { persistSession: args.persistSession }
      : {}),
    ...(typeof args.schema === "object" && args.schema !== null && !Array.isArray(args.schema)
      ? { schema: args.schema as Record<string, unknown> }
      : {}),
    ...(typeof args.systemPrompt === "string" && args.systemPrompt.trim()
      ? { systemPrompt: args.systemPrompt }
      : {}),
  };
};
