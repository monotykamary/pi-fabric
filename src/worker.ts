#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Value } from "typebox/value";
import type {
  SubagentRunRecord,
  SubagentRunStatus,
  SubagentUsage,
  SubagentWorkerOptions,
} from "./subagents/types.js";

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
  const branch = optional(args, "branch");
  const worktree = optional(args, "worktree");
  return {
    id: required(args, "id"),
    name: required(args, "name"),
    taskFile: required(args, "task-file"),
    statusFile: required(args, "status-file"),
    logFile: required(args, "log-file"),
    ...(schemaFile ? { schemaFile } : {}),
    cwd: required(args, "cwd"),
    piBinary: required(args, "pi-binary"),
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
    ...(branch ? { branch } : {}),
    ...(worktree ? { worktree } : {}),
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

const terminateChild = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {}
};

const parseStructuredValue = (text: string): unknown => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return JSON.parse(fenced?.[1]?.trim() ?? trimmed) as unknown;
};

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
  process.stdout.write(`[pi-fabric] ${options.name}\n${task}\n\n`);
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const logStream = fs.createWriteStream(options.logFile, { flags: "a", mode: 0o600 });

  const piArguments = ["--mode", "rpc"];
  if (options.sessionFile) piArguments.push("--session", options.sessionFile);
  else piArguments.push("--no-session");
  if (!options.extensions) piArguments.push("--no-extensions");
  if (options.fabricExtensionPath) piArguments.push("-e", options.fabricExtensionPath);
  if (options.tools.length > 0) piArguments.push("--tools", options.tools.join(","));
  if (options.model) piArguments.push("--model", options.model);
  if (options.thinking) piArguments.push("--thinking", options.thinking);
  if (options.systemPrompt) piArguments.push("--append-system-prompt", options.systemPrompt);
  if (options.schemaFile) {
    const schema = fs.readFileSync(options.schemaFile, "utf8");
    piArguments.push(
      "--append-system-prompt",
      `Your final response must contain only JSON matching this schema, without Markdown fences:\n${schema}`,
    );
  }

  const child = spawn(options.piBinary, piArguments, {
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
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let outputBuffer = "";
  let terminalStatus: SubagentRunStatus | undefined;
  let terminalError: string | undefined;
  let sawAgentError = false;

  const update = (): void => {
    record.updatedAt = Date.now();
    atomicWrite(options.statusFile, record);
  };

  const processEvent = (line: string): void => {
    if (!line.trim()) return;
    logStream.write(`${line}\n`);
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
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
    if (event.type === "message_end") {
      const message = event.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.role !== "assistant") return;
      const text = extractText(messageRecord);
      if (text) {
        record.text = text.slice(-MAX_TEXT_CHARS);
        process.stdout.write(`\n${text}\n`);
      }
      applyUsage(record, messageRecord);
      if (messageRecord.stopReason === "error") sawAgentError = true;
      update();
      return;
    }
    if (event.type === "agent_settled") {
      child.stdin?.end();
      return;
    }
    if (event.type === "extension_error") {
      const error = typeof event.error === "string" ? event.error : "Extension error";
      stderr = `${stderr}\n${error}`.trim().slice(-MAX_STDERR_CHARS);
      update();
    }
  };

  child.stdin?.on("error", () => {});
  child.stdin?.write(`${JSON.stringify({ type: "prompt", message: task })}\n`);

  child.stdout?.on("data", (chunk: Buffer) => {
    outputBuffer += chunk.toString("utf8");
    while (true) {
      const newline = outputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = outputBuffer.slice(0, newline).replace(/\r$/, "");
      outputBuffer = outputBuffer.slice(newline + 1);
      processEvent(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    logStream.write(text);
    process.stderr.write(text);
    stderr = `${stderr}${text}`.slice(-MAX_STDERR_CHARS);
  });

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

  clearTimeout(timeout);
  if (outputBuffer.trim()) processEvent(outputBuffer);
  record.exitCode = exitCode;
  record.stderr = stderr.slice(-MAX_STDERR_CHARS);
  record.finishedAt = Date.now();
  record.updatedAt = record.finishedAt;
  record.status = terminalStatus ?? (exitCode === 0 && !sawAgentError ? "completed" : "failed");
  if (terminalError) record.error = terminalError;
  if (record.status === "failed" && !record.error) {
    record.error = stderr.trim() || `Pi exited with code ${exitCode ?? "unknown"}`;
  }
  if (record.status === "completed" && options.schemaFile) {
    try {
      const schema = JSON.parse(fs.readFileSync(options.schemaFile, "utf8")) as Record<
        string,
        unknown
      >;
      const value = parseStructuredValue(record.text);
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
      record.error = `Structured agent output was invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  delete record.currentTool;
  atomicWrite(options.statusFile, record);
  process.stdout.write(`\n[pi-fabric] ${record.status}\n`);
  await new Promise<void>((resolve) => logStream.end(resolve));
  process.exitCode = record.status === "completed" ? 0 : 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
