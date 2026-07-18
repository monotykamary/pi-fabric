#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Value } from "typebox/value";
import type {
  SubagentRunRecord,
  SubagentRunStatus,
  SubagentUsage,
  SubagentWorkerOptions,
} from "./subagents/types.js";

type ClaudeCliModule = typeof import("./subagents/claude-cli.js");
type CompactControlModule = typeof import("./subagents/compact-control.js");

const loadCompactControl = async (): Promise<CompactControlModule> => {
  if (!import.meta.url.endsWith(".ts")) return import("./subagents/compact-control.js");
  const sourceModulePath = "./subagents/compact-control.ts";
  return import(sourceModulePath) as Promise<CompactControlModule>;
};

const loadClaudeCli = async (): Promise<ClaudeCliModule> => {
  if (!import.meta.url.endsWith(".ts")) return import("./subagents/claude-cli.js");
  const sourceModulePath = "./subagents/claude-cli.ts";
  return import(sourceModulePath) as Promise<ClaudeCliModule>;
};

const MAX_STDERR_CHARS = 20_000;
const MAX_TEXT_CHARS = 100_000;
const KILL_GRACE_MS = 5_000;

const argumentMap = (): Map<string, string> => {
  const result = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
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

const parseOptions = (): SubagentWorkerOptions => {
  const args = argumentMap();
  const model = optional(args, "model");
  const thinking = optional(args, "thinking");
  const fabricExtensionPath = optional(args, "fabric-extension");
  const schemaFile = optional(args, "schema-file");
  const systemPrompt = optional(args, "system-prompt");
  const sessionFile = optional(args, "session-file");
  const actorId = optional(args, "actor-id");
  const actorName = optional(args, "actor-name");
  const meshRoot = optional(args, "mesh-root");
  const runRoot = optional(args, "run-root");
  const steerFile = optional(args, "steer-file");
  const branch = optional(args, "branch");
  const worktree = optional(args, "worktree");
  const maxTokens = optional(args, "max-tokens");
  const runnerSessionId = optional(args, "runner-session-id");
  const runner = required(args, "runner");
  if (runner !== "pi" && runner !== "claude") {
    throw new Error(`Unsupported Fabric agent runner: ${runner}`);
  }
  return {
    id: required(args, "id"),
    runner,
    name: required(args, "name"),
    taskFile: required(args, "task-file"),
    statusFile: required(args, "status-file"),
    logFile: required(args, "log-file"),
    ...(schemaFile ? { schemaFile } : {}),
    cwd: required(args, "cwd"),
    piBinary: required(args, "pi-binary"),
    claudeBinary: required(args, "claude-binary"),
    timeoutMs: Number(required(args, "timeout-ms")),
    depth: Number(required(args, "depth")),
    fullCodeMode: required(args, "full-code-mode") === "true",
    extensions: required(args, "extensions") === "true",
    tools: JSON.parse(required(args, "tools")) as string[],
    grantedRisks: JSON.parse(required(args, "granted-risks")) as string[],
    transport: required(args, "transport") as SubagentWorkerOptions["transport"],
    ...(fabricExtensionPath ? { fabricExtensionPath } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(actorId ? { actorId } : {}),
    ...(actorName ? { actorName } : {}),
    ...(meshRoot ? { meshRoot } : {}),
    ...(runnerSessionId ? { runnerSessionId } : {}),
    ...(runRoot ? { runRoot } : {}),
    ...(steerFile ? { steerFile } : {}),
    ...(branch ? { branch } : {}),
    ...(worktree ? { worktree } : {}),
    ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
  };
};

const emptyUsage = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

const atomicWrite = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
};

const extractText = (message: Record<string, unknown>): string => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("");
};

const numberField = (value: unknown): number => (typeof value === "number" ? value : 0);

const applyUsage = (record: SubagentRunRecord, message: Record<string, unknown>): void => {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return;
  const values = usage as Record<string, unknown>;
  record.usage.input += numberField(values.input);
  record.usage.output += numberField(values.output);
  record.usage.cacheRead += numberField(values.cacheRead);
  record.usage.cacheWrite += numberField(values.cacheWrite);
  const cost = values.cost;
  if (typeof cost === "number") record.usage.cost += cost;
  if (typeof cost === "object" && cost !== null) {
    record.usage.cost += numberField((cost as Record<string, unknown>).total);
  }
};

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const assistantError = (message: Record<string, unknown>): string => {
  const details: string[] = [];
  const direct = stringField(message.errorMessage) ?? stringField(message.error);
  if (direct) details.push(direct);
  if (Array.isArray(message.diagnostics)) {
    for (const diagnostic of message.diagnostics) {
      if (typeof diagnostic !== "object" || diagnostic === null || Array.isArray(diagnostic)) continue;
      const record = diagnostic as Record<string, unknown>;
      const nested =
        typeof record.error === "object" && record.error !== null && !Array.isArray(record.error)
          ? (record.error as Record<string, unknown>)
          : undefined;
      const detail = stringField(nested?.message) ?? stringField(record.message);
      if (detail) details.push(detail);
    }
  }
  const unique = [...new Set(details)];
  const provider = stringField(message.provider);
  const model = stringField(message.model);
  const source = [provider, model].filter((value): value is string => Boolean(value)).join("/");
  const summary = unique.join(" · ") || "Pi agent reported an error";
  return `${source ? `${source}: ` : ""}${summary}`.slice(0, MAX_STDERR_CHARS);
};

const terminateChild = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch { /* child process group already exited */ }
};

const extractBalancedJson = (text: string, start: number): string | null => {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

const parseStructuredValue = (text: string): unknown => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Whole text is not JSON; try extraction below.
  }
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fenced block is not JSON; try balanced extraction below.
    }
  }
  const start = trimmed.search(/[{\[]/);
  if (start >= 0) {
    const balanced = extractBalancedJson(trimmed, start);
    if (balanced) return JSON.parse(balanced);
  }
  return JSON.parse(trimmed);
};

let crashContext: { statusFile: string; record: SubagentRunRecord } | undefined;
let terminalWritten = false;
const writeCrashStatus = (error: unknown): void => {
  if (!crashContext || terminalWritten) return;
  const reason = error instanceof Error ? error.message : String(error);
  const crashed: SubagentRunRecord = {
    ...crashContext.record,
    status: "failed",
    error: `Worker crashed before reporting a result: ${reason}`.slice(0, MAX_STDERR_CHARS),
    finishedAt: Date.now(),
    updatedAt: Date.now(),
  };
  delete crashed.currentTool;
  try {
    atomicWrite(crashContext.statusFile, crashed);
  } catch {
    // Best effort: if the crash-status write itself fails, #monitor falls back
    // to "Subagent transport exited without a result".
  }
};
process.on("uncaughtException", (error) => {
  writeCrashStatus(error);
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  writeCrashStatus(error);
  process.stderr.write(`Unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exit(1);
});

const main = async (): Promise<void> => {
  const options = parseOptions();
  const thinking =
    options.thinking === "off" ||
    options.thinking === "minimal" ||
    options.thinking === "low" ||
    options.thinking === "medium" ||
    options.thinking === "high" ||
    options.thinking === "xhigh" ||
    options.thinking === "max"
      ? options.thinking
      : undefined;
  const task = fs.readFileSync(options.taskFile, "utf8");
  const startedAt = Date.now();
  const record: SubagentRunRecord = {
    id: options.id,
    name: options.name,
    task,
    status: "running",
    runner: options.runner,
    transport: options.transport,
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
    ...(options.actorName ? { actorName: options.actorName } : {}),
    startedAt,
    updatedAt: startedAt,
    turns: 0,
    toolCalls: 0,
    text: "",
    usage: emptyUsage(),
    logFile: options.logFile,
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.worktree ? { worktree: options.worktree } : {}),
  };
  atomicWrite(options.statusFile, record);
  crashContext = { statusFile: options.statusFile, record };
  process.stdout.write(`[pi-fabric] ${options.name}\n${task}\n\n`);
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const logStream = fs.createWriteStream(options.logFile, { flags: "a", mode: 0o600 });
  logStream.on("error", () => {});
  const sessionStream =
    options.runner === "claude" && options.sessionFile
      ? fs.createWriteStream(options.sessionFile, { flags: "a", mode: 0o600 })
      : undefined;
  sessionStream?.on("error", () => {});

  const schema = options.schemaFile
    ? fs.readFileSync(options.schemaFile, "utf8")
    : undefined;
  const piArguments = ["--mode", "rpc"];
  if (options.sessionFile) piArguments.push("--session", options.sessionFile);
  else piArguments.push("--no-session");
  if (!options.extensions) piArguments.push("--no-extensions");
  if (options.fabricExtensionPath) piArguments.push("-e", options.fabricExtensionPath);
  if (options.tools.length > 0) piArguments.push("--tools", options.tools.join(","));
  if (options.model) piArguments.push("--model", options.model);
  if (thinking) piArguments.push("--thinking", thinking);
  if (options.systemPrompt) piArguments.push("--append-system-prompt", options.systemPrompt);
  if (schema) {
    piArguments.push(
      "--append-system-prompt",
      `Your final response must contain only JSON matching this schema, without Markdown fences:\n${schema}`,
    );
  }
  const claudeCli = options.runner === "claude" ? await loadClaudeCli() : undefined;
  const childArguments =
    options.runner === "claude"
      ? claudeCli!.buildClaudeArguments({
          tools: options.tools,
          extensions: options.extensions,
          persistentSession: Boolean(options.sessionFile),
          ...(options.model ? { model: options.model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
          ...(schema ? { schema } : {}),
          ...(options.runnerSessionId ? { runnerSessionId: options.runnerSessionId } : {}),
          name: options.name,
        })
      : piArguments;
  const childBinary = options.runner === "claude" ? options.claudeBinary : options.piBinary;

  const child = spawn(childBinary, childArguments, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      PI_FABRIC_DEPTH: String(options.depth),
      PI_FABRIC_PARENT_RUN: options.id,
      PI_FABRIC_GRANTED_RISKS: options.grantedRisks.join(","),
      PI_FABRIC_FULL_CODE_MODE: String(options.fullCodeMode),
      ...(options.actorId ? { PI_FABRIC_ACTOR_ID: options.actorId } : {}),
      ...(options.actorName ? { PI_FABRIC_ACTOR_NAME: options.actorName } : {}),
      ...(options.meshRoot ? { PI_FABRIC_MESH_ROOT: options.meshRoot } : {}),
      ...(options.runRoot ? { PI_FABRIC_RUN_ROOT: options.runRoot } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let outputBuffer = "";
  const outputDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let terminalStatus: SubagentRunStatus | undefined;
  let terminalError: string | undefined;
  let sawAgentError = false;
  let retryPending = false;

  const update = (): void => {
    record.updatedAt = Date.now();
    atomicWrite(options.statusFile, record);
  };

  const { ChildCompactControl } = await loadCompactControl();
  const compactControl = new ChildCompactControl(options.id, {
    send(frame) {
      if (!child.stdin || child.stdin.writableEnded || child.stdin.destroyed) {
        throw new Error("Child Pi stdin closed before compaction could start");
      }
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    close() {
      child.stdin?.end();
    },
    update(status) {
      record.compaction = status;
      update();
    },
  });

  // Preemptive per-child token guard. timeoutMs bounds wall time and budgetUsd
  // bounds cost, but a single runaway child can still blow its own context
  // before Pi core compacts. When maxTokens is set and the child's cumulative
  // token usage crosses it, terminate the child like a timeout so the run
  // settles with a terminal status instead of burning to the hour deadline.
  const enforceTokenLimit = (): void => {
    if (terminalStatus || !options.maxTokens || options.maxTokens <= 0) return;
    const total =
      record.usage.input +
      record.usage.output +
      record.usage.cacheRead +
      record.usage.cacheWrite;
    if (total <= options.maxTokens) return;
    terminalStatus = "timed_out";
    terminalError = `Fabric token limit reached: ${total} tokens (limit ${options.maxTokens}); terminating child`;
    terminateChild(child, "SIGTERM");
    setTimeout(() => terminateChild(child, "SIGKILL"), KILL_GRACE_MS).unref();
    child.stdin?.end();
  };

  type ClaudeInputKind = "initial" | "steer" | "follow_up";
  const claudeTools = new Map<string, string>();
  const claudeCompletedUsage = emptyUsage();
  const claudeCurrentUsage = emptyUsage();
  const syncClaudeUsage = (): void => {
    record.usage = {
      input: claudeCompletedUsage.input + claudeCurrentUsage.input,
      output: claudeCompletedUsage.output + claudeCurrentUsage.output,
      cacheRead: claudeCompletedUsage.cacheRead + claudeCurrentUsage.cacheRead,
      cacheWrite: claudeCompletedUsage.cacheWrite + claudeCurrentUsage.cacheWrite,
      cost: claudeCompletedUsage.cost,
    };
  };

  const claudeSentInputs: Array<{ kind: ClaudeInputKind; message: string }> = [];
  const claudeSteering: string[] = [];
  const claudeFollowUps: string[] = [];
  let claudeSteeringMode: "all" | "one-at-a-time" = "one-at-a-time";
  let claudeFollowUpMode: "all" | "one-at-a-time" = "one-at-a-time";
  let claudeCanFollowUp = false;
  let claudeResultSeen = false;
  let claudeCloseTimer: NodeJS.Timeout | undefined;

  const updateClaudeQueue = (): void => {
    const sentSteering = claudeSentInputs
      .filter((entry) => entry.kind === "steer")
      .map((entry) => entry.message);
    const sentFollowUps = claudeSentInputs
      .filter((entry) => entry.kind === "follow_up")
      .map((entry) => entry.message);
    record.pendingMessages = {
      steering: [...sentSteering, ...claudeSteering],
      followUp: [...sentFollowUps, ...claudeFollowUps],
    };
    update();
  };

  const writeClaudeInput = (kind: ClaudeInputKind, message: string): void => {
    if (claudeCloseTimer) clearTimeout(claudeCloseTimer);
    claudeCloseTimer = undefined;
    if (!child.stdin || child.stdin.writableEnded || child.stdin.destroyed) return;
    claudeSentInputs.push({ kind, message });
    if (kind === "follow_up") claudeCanFollowUp = false;
    child.stdin.write(`${JSON.stringify(claudeCli!.claudeUserMessage(message))}\n`);
    updateClaudeQueue();
  };

  const flushClaudeSteering = (): void => {
    if (claudeSteering.length === 0) return;
    const alreadySent = claudeSentInputs.some((entry) => entry.kind === "steer");
    if (claudeSteeringMode === "one-at-a-time" && alreadySent) return;
    const count = claudeSteeringMode === "all" ? claudeSteering.length : 1;
    for (const message of claudeSteering.splice(0, count)) {
      writeClaudeInput("steer", message);
    }
  };

  const flushClaudeFollowUps = (): void => {
    if (claudeFollowUps.length === 0 || claudeSteering.length > 0) return;
    if (claudeSentInputs.some((entry) => entry.kind === "steer")) return;
    const alreadySent = claudeSentInputs.some((entry) => entry.kind === "follow_up");
    if (claudeFollowUpMode === "one-at-a-time" && alreadySent) return;
    const count = claudeFollowUpMode === "all" ? claudeFollowUps.length : 1;
    for (const message of claudeFollowUps.splice(0, count)) {
      writeClaudeInput("follow_up", message);
    }
  };

  const scheduleClaudeClose = (): void => {
    if (claudeCloseTimer || terminalStatus) return;
    claudeCloseTimer = setTimeout(() => {
      claudeCloseTimer = undefined;
      if (
        claudeSentInputs.length === 0 &&
        claudeSteering.length === 0 &&
        claudeFollowUps.length === 0
      ) {
        child.stdin?.end();
      }
    }, 300);
    claudeCloseTimer.unref();
  };

  const processClaudeEvent = (event: Record<string, unknown>): void => {
    if (event.type === "system" && event.subtype === "init") {
      const sessionId = stringField(event.session_id);
      if (sessionId) record.runnerSessionId = sessionId;
      const model = stringField(event.model);
      if (model && !record.model) record.model = model;
      update();
      return;
    }
    if (event.type === "assistant") {
      const message = event.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const assistant = message as Record<string, unknown>;
      const text = extractText(assistant);
      if (text) {
        record.text = Array.from(text).slice(-MAX_TEXT_CHARS).join("");
        process.stdout.write(`\n${text}\n`);
      }
      const content = assistant.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
          const part = block as Record<string, unknown>;
          if (part.type !== "tool_use") continue;
          const id = stringField(part.id);
          const name = stringField(part.name);
          if (!id || !name || claudeTools.has(id)) continue;
          claudeTools.set(id, name);
          record.toolCalls++;
          record.currentTool = name;
          process.stdout.write(`→ ${name}\n`);
        }
      }
      const usage = assistant.usage;
      if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
        const values = usage as Record<string, unknown>;
        claudeCurrentUsage.input += numberField(values.input_tokens);
        claudeCurrentUsage.output += numberField(values.output_tokens);
        claudeCurrentUsage.cacheRead += numberField(values.cache_read_input_tokens);
        claudeCurrentUsage.cacheWrite += numberField(values.cache_creation_input_tokens);
        syncClaudeUsage();
      }
      if (typeof event.error === "string") {
        sawAgentError = true;
        terminalError = event.error;
      }
      enforceTokenLimit();
      update();
      return;
    }
    if (event.type === "user") {
      const message = event.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
        const part = block as Record<string, unknown>;
        if (part.type !== "tool_result") continue;
        const id = stringField(part.tool_use_id);
        if (id) claudeTools.delete(id);
      }
      const current = [...claudeTools.values()].at(-1);
      if (current) record.currentTool = current;
      else delete record.currentTool;
      update();
      return;
    }
    if (event.type === "stream_event") {
      const streamEvent = event.event;
      if (typeof streamEvent !== "object" || streamEvent === null || Array.isArray(streamEvent)) return;
      const stream = streamEvent as Record<string, unknown>;
      if (stream.type !== "content_block_start") return;
      const contentBlock = stream.content_block;
      if (typeof contentBlock !== "object" || contentBlock === null || Array.isArray(contentBlock)) return;
      const block = contentBlock as Record<string, unknown>;
      const name = stringField(block.name);
      if (block.type === "tool_use" && name) {
        record.currentTool = name;
        update();
      }
      return;
    }
    if (event.type !== "result") return;
    claudeResultSeen = true;
    const sessionId = stringField(event.session_id);
    if (sessionId) record.runnerSessionId = sessionId;
    const resultText = typeof event.result === "string" ? event.result : "";
    if (resultText) record.text = Array.from(resultText).slice(-MAX_TEXT_CHARS).join("");
    if (event.structured_output !== undefined) record.value = event.structured_output;
    record.turns += Math.max(0, Math.floor(numberField(event.num_turns)));
    const resultUsage =
      typeof event.usage === "object" && event.usage !== null && !Array.isArray(event.usage)
        ? (event.usage as Record<string, unknown>)
        : undefined;
    claudeCompletedUsage.input += resultUsage
      ? numberField(resultUsage.input_tokens)
      : claudeCurrentUsage.input;
    claudeCompletedUsage.output += resultUsage
      ? numberField(resultUsage.output_tokens)
      : claudeCurrentUsage.output;
    claudeCompletedUsage.cacheRead += resultUsage
      ? numberField(resultUsage.cache_read_input_tokens)
      : claudeCurrentUsage.cacheRead;
    claudeCompletedUsage.cacheWrite += resultUsage
      ? numberField(resultUsage.cache_creation_input_tokens)
      : claudeCurrentUsage.cacheWrite;
    claudeCompletedUsage.cost += Math.max(0, numberField(event.total_cost_usd));
    claudeCurrentUsage.input = 0;
    claudeCurrentUsage.output = 0;
    claudeCurrentUsage.cacheRead = 0;
    claudeCurrentUsage.cacheWrite = 0;
    syncClaudeUsage();
    enforceTokenLimit();
    const failed = event.is_error === true || event.subtype !== "success";
    if (failed) {
      sawAgentError = true;
      const errors = Array.isArray(event.errors)
        ? event.errors.filter((value): value is string => typeof value === "string").join(" · ")
        : "";
      terminalError = errors || resultText || `Claude returned ${String(event.subtype ?? "an error")}`;
      claudeSteering.splice(0);
      claudeFollowUps.splice(0);
    } else {
      sawAgentError = false;
      if (!terminalStatus) terminalError = undefined;
    }
    if (failed || terminalStatus) claudeSentInputs.splice(0);
    else claudeSentInputs.shift();
    claudeCanFollowUp = !failed && !terminalStatus;
    delete record.currentTool;
    updateClaudeQueue();
    if (failed || terminalStatus) {
      child.stdin?.end();
      return;
    }
    flushClaudeSteering();
    if (claudeSentInputs.length === 0 && claudeSteering.length === 0) {
      flushClaudeFollowUps();
    }
    if (
      claudeSentInputs.length === 0 &&
      claudeSteering.length === 0 &&
      claudeFollowUps.length === 0
    ) {
      scheduleClaudeClose();
    }
  };

  const processEvent = (line: string): void => {
    if (process.env.PI_FABRIC_INJECT_CRASH === "stream") throw new Error("simulated stream crash");
    if (!line.trim()) return;
    logStream.write(`${line}\n`);
    sessionStream?.write(`${line}\n`);
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (options.runner === "claude") {
      processClaudeEvent(event);
      return;
    }
    compactControl.observe(event);
    if (event.type === "agent_start") {
      retryPending = false;
      sawAgentError = false;
      terminalError = undefined;
      return;
    }
    if (event.type === "response" && event.command === "prompt" && event.success === false) {
      sawAgentError = true;
      terminalError = typeof event.error === "string" ? event.error : "Pi rejected the prompt";
      child.stdin?.end();
      return;
    }
    if (event.type === "extension_ui_request") {
      const method = event.method;
      if (
        typeof event.id === "string" &&
        (method === "select" || method === "confirm" || method === "input" || method === "editor")
      ) {
        child.stdin?.write(
          `${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`,
        );
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      record.toolCalls++;
      if (typeof event.toolName === "string") {
        record.currentTool = event.toolName;
        process.stdout.write(`→ ${event.toolName}\n`);
      }
      update();
      return;
    }
    if (event.type === "tool_execution_end") {
      delete record.currentTool;
      update();
      return;
    }
    if (event.type === "turn_end") {
      record.turns++;
      update();
      return;
    }
    if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering)
        ? event.steering.filter((value): value is string => typeof value === "string")
        : [];
      const followUp = Array.isArray(event.followUp)
        ? event.followUp.filter((value): value is string => typeof value === "string")
        : [];
      record.pendingMessages = { steering, followUp };
      update();
      return;
    }
    if (event.type === "message_end") {
      const message = event.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.role !== "assistant") return;
      const text = extractText(messageRecord);
      if (text) {
        record.text = Array.from(text).slice(-MAX_TEXT_CHARS).join("");
        process.stdout.write(`\n${text}\n`);
      }
      applyUsage(record, messageRecord);
      enforceTokenLimit();
      if (messageRecord.stopReason === "error") {
        sawAgentError = true;
        terminalError = assistantError(messageRecord);
      } else {
        sawAgentError = false;
        // Once a terminal cause is set (e.g. the per-child token guard), keep it;
        // a later non-error message_end must not clobber the reason we are
        // terminating for.
        if (!terminalStatus) terminalError = undefined;
      }
      update();
      return;
    }
    if (event.type === "agent_end") {
      retryPending = event.willRetry === true;
      return;
    }
    if (event.type === "agent_settled") {
      if (!retryPending) {
        // Pull controls that landed with the final stream events before deciding
        // whether this one-shot child can close. A queued compact keeps stdin
        // open until its correlated response and compaction_end are observed.
        pollSteer();
        compactControl.childSettled();
      }
      return;
    }
    if (event.type === "extension_error") {
      const error = typeof event.error === "string" ? event.error : "Extension error";
      stderr = `${stderr}\n${error}`.trim().slice(-MAX_STDERR_CHARS);
      update();
    }
  };

  child.stdin?.on("error", () => {});
  if (options.runner === "claude") writeClaudeInput("initial", task);
  else child.stdin?.write(`${JSON.stringify({ type: "prompt", message: task })}\n`);

  // Tail a control file (steer.jsonl) the parent appends to and forward each
  // queued command to the child pi over its RPC stdin. This is the fabric
  // steering channel: the orchestrator (or any peer via the mesh relay) can
  // interject a steer / follow_up / queue-mode command between the child's
  // turns without stopping and respawning it, preserving its context. The
  // poller is best-effort: a closed or ended stdin (settled/stopped child) is
  // swallowed so a late steer never crashes the worker.
  let steerOffset = 0;
  let steerRemainder = Buffer.alloc(0);
  const pollSteer = (): void => {
    if (!options.steerFile || terminalStatus) return;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(options.steerFile, "r");
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(descriptor).size;
      if (size < steerOffset) {
        steerOffset = 0;
        steerRemainder = Buffer.alloc(0);
      }
      if (size <= steerOffset) return;
      const length = size - steerOffset;
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(descriptor, buffer, 0, length, steerOffset);
      steerOffset += bytesRead;
      const combined = Buffer.concat([steerRemainder, buffer.subarray(0, bytesRead)]);
      const newline = combined.lastIndexOf(0x0a);
      if (newline < 0) {
        steerRemainder = combined;
        return;
      }
      steerRemainder = Buffer.from(combined.subarray(newline + 1));
      for (const raw of combined.subarray(0, newline + 1).toString("utf8").split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        let command: { type?: string; message?: string; mode?: string; instructions?: string };
        try {
          command = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          if (options.runner === "claude") {
            if (claudeCloseTimer) clearTimeout(claudeCloseTimer);
            claudeCloseTimer = undefined;
            if (command.type === "steer" && typeof command.message === "string") {
              claudeSteering.push(command.message);
              flushClaudeSteering();
            } else if (command.type === "follow_up" && typeof command.message === "string") {
              claudeFollowUps.push(command.message);
              if (claudeCanFollowUp && claudeSentInputs.length === 0) flushClaudeFollowUps();
            } else if (
              command.type === "set_steering_mode" &&
              (command.mode === "all" || command.mode === "one-at-a-time")
            ) {
              claudeSteeringMode = command.mode;
              flushClaudeSteering();
            } else if (
              command.type === "set_follow_up_mode" &&
              (command.mode === "all" || command.mode === "one-at-a-time")
            ) {
              claudeFollowUpMode = command.mode;
              if (claudeCanFollowUp && claudeSentInputs.length === 0) flushClaudeFollowUps();
            }
            updateClaudeQueue();
          } else if (command.type === "steer" && typeof command.message === "string") {
            child.stdin?.write(JSON.stringify({ type: "steer", message: command.message }) + "\n");
          } else if (command.type === "follow_up" && typeof command.message === "string") {
            child.stdin?.write(JSON.stringify({ type: "follow_up", message: command.message }) + "\n");
          } else if (command.type === "set_steering_mode" && typeof command.mode === "string") {
            child.stdin?.write(JSON.stringify({ type: "set_steering_mode", mode: command.mode }) + "\n");
          } else if (command.type === "set_follow_up_mode" && typeof command.mode === "string") {
            child.stdin?.write(JSON.stringify({ type: "set_follow_up_mode", mode: command.mode }) + "\n");
          } else if (command.type === "compact") {
            compactControl.queue(command.instructions);
          }
        } catch {
          /* stdin closed (settled/stopped child); a late steer is dropped */
        }
      }
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const steerTimer = options.steerFile ? setInterval(pollSteer, 200) : undefined;
  steerTimer?.unref?.();

  child.stdout?.on("data", (chunk: Buffer) => {
    outputBuffer += outputDecoder.write(chunk);
    while (true) {
      const newline = outputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = outputBuffer.slice(0, newline).replace(/\r$/, "");
      outputBuffer = outputBuffer.slice(newline + 1);
      processEvent(line);
    }
  });
  const recordStderr = (text: string): void => {
    if (!text) return;
    logStream.write(`${JSON.stringify({ type: "worker_stderr", text })}\n`);
    process.stderr.write(text);
    stderr = `${stderr}${text}`.slice(-MAX_STDERR_CHARS);
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    recordStderr(stderrDecoder.write(chunk));
  });
  child.stderr?.on("error", () => {});

  const timeout = setTimeout(() => {
    terminalStatus = "timed_out";
    terminalError = `Subagent timed out after ${options.timeoutMs}ms`;
    terminateChild(child, "SIGTERM");
    setTimeout(() => terminateChild(child, "SIGKILL"), KILL_GRACE_MS).unref();
  }, options.timeoutMs);
  timeout.unref();

  const stop = (): void => {
    if (terminalStatus) return;
    terminalStatus = "stopped";
    terminalError = "Subagent stopped";
    terminateChild(child, "SIGTERM");
    setTimeout(() => terminateChild(child, "SIGKILL"), KILL_GRACE_MS).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      terminalStatus = "failed";
      terminalError = error.message;
      resolve(null);
    });
    child.once("close", (code) => resolve(code));
  });

  if (steerTimer) clearInterval(steerTimer);
  if (claudeCloseTimer) clearTimeout(claudeCloseTimer);
  clearTimeout(timeout);
  if (process.env.PI_FABRIC_INJECT_CRASH === "close") throw new Error("simulated close crash");
  outputBuffer += outputDecoder.end();
  recordStderr(stderrDecoder.end());
  if (outputBuffer.trim()) processEvent(outputBuffer);
  record.exitCode = exitCode;
  record.stderr = stderr.slice(-MAX_STDERR_CHARS);
  if (
    record.compaction?.status === "queued" ||
    record.compaction?.status === "in_flight"
  ) {
    const error = terminalError ?? "Child Pi exited before the queued compaction completed";
    record.compaction = {
      ...record.compaction,
      status: "failed",
      updatedAt: Date.now(),
      finishedAt: Date.now(),
      error,
    };
    if (!terminalStatus) {
      terminalStatus = "failed";
      terminalError = error;
    }
  }
  record.finishedAt = Date.now();
  record.updatedAt = record.finishedAt;
  const childCompleted =
    exitCode === 0 &&
    !sawAgentError &&
    (options.runner === "pi" ||
      (claudeResultSeen &&
        claudeSentInputs.length === 0 &&
        claudeSteering.length === 0 &&
        claudeFollowUps.length === 0));
  record.status = terminalStatus ?? (childCompleted ? "completed" : "failed");
  if (terminalError) record.error = terminalError;
  if (record.status === "failed" && !record.error) {
    record.error =
      stderr.trim() ||
      (exitCode === 0
        ? `${options.runner === "claude" ? "Claude" : "Pi"} agent reported an error before exiting`
        : `${options.runner === "claude" ? "Claude" : "Pi"} exited with code ${exitCode ?? "unknown"}`);
  }
  if (record.status === "completed" && options.schemaFile) {
    try {
      const schema = JSON.parse(fs.readFileSync(options.schemaFile, "utf8")) as Record<
        string,
        unknown
      >;
      const value = record.value ?? parseStructuredValue(record.text);
      if (!Value.Check(schema, value)) {
        const errors = [...Value.Errors(schema, value)]
          .slice(0, 5)
          .map((error) => error.message)
          .join("; ");
        throw new Error(errors || "value does not match schema");
      }
      record.value = value;
    } catch (error) {
      record.status = "failed";
      const reason = error instanceof Error ? error.message : String(error);
      const output = record.text.trim();
      const snippet = output.slice(0, 200);
      record.error = `Structured agent output was invalid: ${reason}${snippet ? ` (output: ${snippet}${output.length > 200 ? "…" : ""})` : ""}`;
    }
  }
  delete record.currentTool;
  atomicWrite(options.statusFile, record);
  terminalWritten = true;
  process.stdout.write(`\n[pi-fabric] ${record.status}\n`);
  await Promise.all([
    new Promise<void>((resolve) => logStream.end(resolve)),
    sessionStream
      ? new Promise<void>((resolve) => sessionStream.end(resolve))
      : Promise.resolve(),
  ]);
  process.exitCode = record.status === "completed" ? 0 : 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  writeCrashStatus(error);
  process.exit(1);
});
