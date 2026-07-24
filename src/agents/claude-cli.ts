import type { ImageContent } from "@earendil-works/pi-ai";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import crossSpawn from "cross-spawn";
import type { FabricThinking } from "../thinking.js";

const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

const spawnCli = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess => NODE_SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase())
  ? crossSpawn(process.execPath, [command, ...args], options)
  : crossSpawn(command, [...args], options);

const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_DISCOVERY_MAX_CHARS = 2_000_000;

const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
};

export interface ClaudeModelInfo {
  value: string;
  resolvedModel: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

interface ClaudeRunArguments {
  model?: string;
  thinking?: FabricThinking;
  tools: string[];
  extensions: boolean;
  systemPrompt?: string;
  schema?: string;
  runnerSessionId?: string;
  persistentSession: boolean;
  name?: string;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asClaudeModel = (value: unknown): ClaudeModelInfo | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const modelValue = nonEmptyString(record.value);
  if (!modelValue) return undefined;
  const resolvedModel = nonEmptyString(record.resolvedModel) ?? modelValue;
  const displayName = nonEmptyString(record.displayName) ?? modelValue;
  const description = nonEmptyString(record.description) ?? resolvedModel;
  const supportedEffortLevels = Array.isArray(record.supportedEffortLevels)
    ? record.supportedEffortLevels.filter(
        (level): level is string => typeof level === "string" && Boolean(level.trim()),
      )
    : undefined;
  return {
    value: modelValue,
    resolvedModel,
    displayName,
    description,
    ...(typeof record.supportsEffort === "boolean"
      ? { supportsEffort: record.supportsEffort }
      : {}),
    ...(supportedEffortLevels && supportedEffortLevels.length > 0
      ? { supportedEffortLevels }
      : {}),
    ...(typeof record.supportsAdaptiveThinking === "boolean"
      ? { supportsAdaptiveThinking: record.supportsAdaptiveThinking }
      : {}),
    ...(typeof record.supportsFastMode === "boolean"
      ? { supportsFastMode: record.supportsFastMode }
      : {}),
    ...(typeof record.supportsAutoMode === "boolean"
      ? { supportsAutoMode: record.supportsAutoMode }
      : {}),
  };
};

export const mapClaudeTools = (tools: readonly string[]): string[] => {
  const mapped: string[] = [];
  for (const tool of tools) {
    const claudeTool = Object.hasOwn(CLAUDE_TOOL_NAMES, tool)
      ? CLAUDE_TOOL_NAMES[tool]
      : undefined;
    if (!claudeTool) {
      throw new Error(
        `Claude runner does not support Fabric tool ${JSON.stringify(tool)}. Supported tools: ${Object.keys(
          CLAUDE_TOOL_NAMES,
        ).join(", ")}`,
      );
    }
    if (!mapped.includes(claudeTool)) mapped.push(claudeTool);
  }
  return mapped;
};

export const normalizeClaudeModel = (model: string): string => {
  const trimmed = model.trim();
  const normalized = trimmed.startsWith("claude/")
    ? trimmed.slice("claude/".length)
    : trimmed.startsWith("anthropic/")
      ? trimmed.slice("anthropic/".length)
      : trimmed;
  if (!normalized) throw new Error("Claude model must include a runtime model value");
  return normalized;
};

export const claudeEffort = (thinking: FabricThinking): string =>
  thinking === "off" || thinking === "minimal" ? "low" : thinking;

export const buildClaudeArguments = (options: ClaudeRunArguments): string[] => {
  const tools = mapClaudeTools(options.tools);
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.join(","),
  ];
  if (tools.length > 0) args.push("--allowedTools", tools.join(","));
  if (!options.extensions) args.push("--safe-mode");
  if (!options.persistentSession) args.push("--no-session-persistence");
  if (options.runnerSessionId) args.push("--resume", options.runnerSessionId);
  if (options.model) args.push("--model", normalizeClaudeModel(options.model));
  if (options.thinking) args.push("--effort", claudeEffort(options.thinking));
  if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);
  if (options.schema) args.push("--json-schema", options.schema);
  if (options.name) args.push("--name", options.name);
  return args;
};

export const claudeUserMessage = (
  message: string,
  images: readonly ImageContent[] = [],
): Record<string, unknown> => ({
  type: "user",
  message: {
    role: "user",
    content: images.length === 0
      ? message
      : [
          { type: "text", text: message },
          ...images.map((image) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mimeType,
              data: image.data,
            },
          })),
        ],
  },
  parent_tool_use_id: null,
  session_id: "",
  uuid: randomUUID(),
});

export const discoverClaudeModels = async (
  binary: string,
  cwd: string,
  timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
): Promise<ClaudeModelInfo[]> =>
  new Promise<ClaudeModelInfo[]>((resolve, reject) => {
    const requestId = `fabric-models-${randomUUID()}`;
    const child = spawnCli(
      binary,
      [
        "-p",
        "--safe-mode",
        "--no-session-persistence",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "",
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const finish = (error: Error | undefined, models?: ClaudeModelInfo[]): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const inspectLines = (): void => {
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const event = parsed as Record<string, unknown>;
        if (event.type !== "control_response") continue;
        const response = event.response;
        if (typeof response !== "object" || response === null || Array.isArray(response)) continue;
        const envelope = response as Record<string, unknown>;
        if (envelope.request_id !== requestId) continue;
        if (envelope.subtype !== "success") {
          finish(new Error(nonEmptyString(envelope.error) ?? "Claude model discovery failed"));
          return;
        }
        const payload = envelope.response;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          finish(new Error("Claude model discovery returned an invalid response"));
          return;
        }
        const rawModels = (payload as Record<string, unknown>).models;
        const models = Array.isArray(rawModels)
          ? rawModels.map(asClaudeModel).filter((model): model is ClaudeModelInfo => Boolean(model))
          : [];
        finish(undefined, models);
        return;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MODEL_DISCOVERY_MAX_CHARS) {
        finish(new Error("Claude model discovery output exceeded its safety limit"));
        return;
      }
      inspectLines();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (forceKill) clearTimeout(forceKill);
      if (settled) return;
      inspectLines();
      const detail = stderr.trim();
      finish(
        new Error(
          detail ||
            `Claude model discovery exited with code ${code ?? "unknown"} before initialization`,
        ),
      );
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      })}\n`,
    );
    timeout = setTimeout(() => {
      finish(new Error(`Claude model discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
  });
