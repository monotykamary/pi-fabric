import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const statusFile = args.get("status-file");
const taskFile = args.get("task-file");
const logFile = args.get("log-file");
const sessionFile = args.get("session-file");
const schemaFile = args.get("schema-file");
const schema = schemaFile ? JSON.parse(fs.readFileSync(schemaFile, "utf8")) : undefined;
const task = fs.readFileSync(taskFile, "utf8");

if (task.includes("HANG")) {
  // Write a non-terminal "running" status so the SubagentManager monitor keeps
  // waiting, then stay alive until the transport kills this process (abort/stop).
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(
    statusFile,
    JSON.stringify({
      id: args.get("id"),
      name: args.get("name"),
      task,
      status: "running",
      transport: args.get("transport"),
      cwd: args.get("cwd"),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      turns: 0,
      toolCalls: 0,
      text: "",
      exitCode: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    }),
  );
  const stay = () => setTimeout(stay, 1_000);
  stay();
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
} else {
  const fail = task.includes("FAIL_DIRECTIVE");
  const directive = schema?.properties?.action
    ? { action: "message", message: "fake actor advice" }
    : undefined;
  const now = Date.now();
  const text = directive && !fail ? JSON.stringify(directive) : "fake worker complete";
  const record = {
    id: args.get("id"),
    name: args.get("name"),
    task,
    status: fail ? "failed" : "completed",
    transport: args.get("transport"),
    fullCodeMode: args.get("full-code-mode"),
    tools: JSON.parse(args.get("tools") ?? "[]"),
    extensions: args.get("extensions"),
    cwd: args.get("cwd"),
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    turns: 1,
    toolCalls: 0,
    text,
    ...(directive && !fail ? { value: directive } : {}),
    ...(fail ? { error: "Structured agent output was invalid: Unexpected token (output: not json)" } : {}),
    exitCode: 0,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ...(args.has("model") ? { model: args.get("model") } : {}),
  };
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify(record));

  // Emit a per-run event stream so agents.log / readLog can inspect the run.
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const events = [
      { type: "agent_start" },
      { type: "tool_execution_start", toolName: "read" },
      { type: "tool_execution_end", toolName: "read" },
      { type: "turn_end" },
      {
        type: "message_end",
        message: { role: "assistant", content: text, usage: { input: 1, output: 2 } },
      },
      { type: "agent_end", willRetry: false },
      { type: "agent_settled" },
    ];
    fs.writeFileSync(logFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }

  // Append a session transcript so the actor's readLog(type: "session") works.
  if (sessionFile) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const turns = [
      { role: "user", content: task },
      { role: "assistant", content: text },
    ];
    fs.appendFileSync(sessionFile, turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n");
  }
}
