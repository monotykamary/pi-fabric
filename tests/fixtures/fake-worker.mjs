import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const statusFile = args.get("status-file");
const taskFile = args.get("task-file");
const logFile = args.get("log-file");
const lifecycleFile = args.get("lifecycle-file");
const sessionFile = args.get("session-file");
const schemaFile = args.get("schema-file");
const imagesFile = args.get("images-file");
const schema = schemaFile ? JSON.parse(fs.readFileSync(schemaFile, "utf8")) : undefined;
const images = imagesFile ? JSON.parse(fs.readFileSync(imagesFile, "utf8")) : [];
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
      runner: args.get("runner") ?? "pi",
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
    ? {
        action: "message",
        message: "fake actor advice",
        ...(images.length > 0 ? { data: { imageCount: images.length } } : {}),
      }
    : undefined;
  const now = Date.now();
  const largeText = task.includes("LARGE_RESULT") ? "x".repeat(100_000) : undefined;
  const text = largeText ?? (directive && !fail ? JSON.stringify(directive) : "fake worker complete");
  const record = {
    id: args.get("id"),
    name: args.get("name"),
    task,
    status: fail ? "failed" : "completed",
    runner: args.get("runner") ?? "pi",
    transport: args.get("transport"),
    fullCodeMode: args.get("full-code-mode"),
    mainAgentId: args.get("main-agent-id"),
    tools: JSON.parse(args.get("tools") ?? "[]"),
    extensions: args.get("extensions"),
    imageCount: images.length,
    cwd: args.get("cwd"),
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    turns: 1,
    toolCalls: 0,
    text,
    ...(largeText
      ? { value: { output: largeText } }
      : directive && !fail
        ? { value: directive }
        : {}),
    ...(fail ? { error: "Structured agent output was invalid: Unexpected token (output: not json)" } : {}),
    exitCode: 0,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ...(args.has("model") ? { model: args.get("model") } : {}),
    ...(args.has("thinking") ? { thinking: args.get("thinking") } : {}),
  };
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  if (lifecycleFile) {
    const lifecycleEvents = [
      { version: 1, event: "pi.agent_start", occurredAt: now },
      { version: 1, event: "pi.turn_end", occurredAt: now, data: { turnIndex: 0 } },
      { version: 1, event: "pi.agent_end", occurredAt: now, data: { willRetry: false } },
      { version: 1, event: "pi.agent_settled", occurredAt: now },
    ];
    fs.writeFileSync(
      lifecycleFile,
      lifecycleEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
  }
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

  // Append a lightweight actor transcript only when this is not already a
  // native Pi session. Handoff fixtures pass a real branched JSONL file; raw
  // role records would corrupt its id/parentId tree.
  let nativePiSession = false;
  if (sessionFile && fs.existsSync(sessionFile)) {
    try {
      const first = fs.readFileSync(sessionFile, "utf8").split("\n", 1)[0];
      nativePiSession = JSON.parse(first).type === "session";
    } catch {}
  }
  if (sessionFile && !nativePiSession) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const turns = [
      { role: "user", content: task },
      { role: "assistant", content: text },
    ];
    fs.appendFileSync(sessionFile, turns.map((turn) => JSON.stringify(turn)).join("\n") + "\n");
  }
}
