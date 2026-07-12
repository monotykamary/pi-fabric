#!/usr/bin/env node

process.stdin.once("data", () => {
  const value = {
    action: "message",
    message: "validated actor response",
  };
  const message = {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(value) }],
    usage: { input: 3, output: 4 },
    stopReason: "stop",
  };
  process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  setTimeout(() => process.exit(0), 10);
});
