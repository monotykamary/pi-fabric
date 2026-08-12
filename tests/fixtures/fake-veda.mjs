#!/usr/bin/env node
// A stub `veda` binary for the real-worker e2e. The Fabric worker spawns this
// as the child agent, writes the task to stdin, and expects the same JSON
// envelope `veda --json` emits on stdout. Behavior is selected with the
// FAKE_VEDA_BEHAVIOR env var.
const behavior = process.env.FAKE_VEDA_BEHAVIOR || "success";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  switch (behavior) {
    case "error":
      process.stdout.write(
        JSON.stringify({
          text: "partial",
          error: "backend quota exceeded",
          sessionId: "conv-1",
          usage: { inputTokens: 10, outputTokens: 5 },
        }, null, 2) + "\n",
      );
      process.exit(1);
      break;
    case "design-fail":
      process.stdout.write(
        JSON.stringify({
          text: "no program here",
          sessionId: "conv-1",
          usage: { inputTokens: 10, outputTokens: 5 },
          design: { ok: false, errors: ["[missing] no <program> block found"] },
        }, null, 2) + "\n",
      );
      process.exit(1);
      break;
    case "no-json":
      process.exit(0);
      break;
    case "hang":
      // Never exit; the worker timeout should fire.
      setInterval(() => {}, 60_000);
      break;
    case "success":
    default:
      process.stdout.write(
        JSON.stringify({
          text: `echo: ${input.slice(0, 80)}`,
          sessionId: "conv-1",
          usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 2 },
        }, null, 2) + "\n",
      );
      process.exit(0);
  }
});
