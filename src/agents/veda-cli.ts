import type { FabricThinking } from "../thinking.js";

// Well-known Veda backends per the CLI registry: agy, codex, claude-code,
// droid, pi. The configured value passes through unchanged so backends
// registered by a custom Veda build keep working.

// Fabric portable tool allowlist → Veda tool ids. find/ls both map to Veda's
// glob tool (the same convention the Claude runner uses). The Veda CLI passes
// these through to the backend; the agy backend treats them as advisory in the
// system prompt because agy has no per-run tool allowlist.
const VEDA_TOOL_NAMES: Readonly<Record<string, string>> = {
  read: "read",
  grep: "grep",
  find: "glob",
  ls: "glob",
  bash: "bash",
  edit: "edit",
  write: "write",
};

export interface VedaRunArguments {
  backend: string;
  persona: string;
  model?: string;
  thinking?: FabricThinking;
  tools: string[];
  session: string;
}

export const mapVedaTools = (tools: readonly string[]): string[] => {
  const mapped: string[] = [];
  for (const tool of tools) {
    const vedaTool = Object.hasOwn(VEDA_TOOL_NAMES, tool) ? VEDA_TOOL_NAMES[tool] : undefined;
    if (!vedaTool) {
      throw new Error(
        `Veda runner does not support Fabric tool ${JSON.stringify(tool)}. Supported tools: ${Object.keys(
          VEDA_TOOL_NAMES,
        ).join(", ")}`,
      );
    }
    if (!mapped.includes(vedaTool)) mapped.push(vedaTool);
  }
  return mapped;
};

/** Strip a `veda/` routing prefix; everything else passes through because -b
 *  pins the backend and -m is forwarded literally. */
export const normalizeVedaModel = (model: string): string => {
  const trimmed = model.trim();
  const normalized = trimmed.startsWith("veda/") ? trimmed.slice("veda/".length) : trimmed;
  if (!normalized) throw new Error("Veda model must include a model value");
  return normalized;
};

/** FabricThinking → Veda reasoning level. Veda has no "off" level; the closest
 *  supported value is minimal. */
export const vedaReasoning = (thinking: FabricThinking): string =>
  thinking === "off" || thinking === "minimal" ? "minimal" : thinking;

/** Headless run arguments: veda -b <backend> -p <persona> [model/reasoning/
 *  tools] --json --no-sel -S <session> --no-notify. The task itself is
 *  delivered over stdin by the worker so arbitrarily long prompts never hit
 *  ARG_MAX. */
export const buildVedaArguments = (options: VedaRunArguments): string[] => {
  const tools = mapVedaTools(options.tools);
  const args = ["-b", options.backend, "-p", options.persona];
  if (options.model) args.push("-m", normalizeVedaModel(options.model));
  if (options.thinking) args.push("-r", vedaReasoning(options.thinking));
  if (tools.length > 0) args.push("--tools", tools.join(","));
  else args.push("--no-tools");
  args.push("--json", "--no-sel", "-S", options.session, "--no-notify");
  return args;
};
