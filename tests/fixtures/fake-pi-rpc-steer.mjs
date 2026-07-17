#!/usr/bin/env node
// A real RPC-protocol fake pi for the steering e2e. Unlike fake-pi-rpc.mjs (which
// processes one prompt and exits), this stays alive after the prompt so the
// Fabric worker's steer.jsonl poller can forward steer/follow_up/queue-mode
// commands to it between turns. It records every command it receives to the
// file named by FAKE_PI_STEER_LOG so tests can assert the worker forwarded them,
// and emits queue_update events so the worker surfaces pendingMessages.
import fs from "node:fs";

const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const recordPath = process.env.FAKE_PI_STEER_LOG;
const record = (entry) => {
  if (recordPath) fs.appendFileSync(recordPath, JSON.stringify(entry) + "\n");
};

let prompted = false;
process.stdin.on("data", (chunk) => {
  for (const raw of chunk.toString("utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    if (command.type === "prompt" && !prompted) {
      prompted = true;
      send({ type: "response", command: "prompt", success: true });
      send({ type: "agent_start" });
      send({ type: "queue_update", steering: [], followUp: [] });
      record({ type: "prompt", message: command.message });
    } else if (command.type === "steer") {
      send({ type: "response", command: "steer", success: true });
      send({ type: "queue_update", steering: [command.message], followUp: [] });
      record({ type: "steer", message: command.message });
    } else if (command.type === "follow_up") {
      send({ type: "response", command: "follow_up", success: true });
      send({ type: "queue_update", steering: [], followUp: [command.message] });
      record({ type: "follow_up", message: command.message });
    } else if (command.type === "set_steering_mode") {
      send({ type: "response", command: "set_steering_mode", success: true });
      record({ type: "set_steering_mode", mode: command.mode });
    } else if (command.type === "set_follow_up_mode") {
      send({ type: "response", command: "set_follow_up_mode", success: true });
      record({ type: "set_follow_up_mode", mode: command.mode });
    } else if (command.type === "compact") {
      // Advisory compaction: pi core applies it between the child's own turns.
      // The worker only forwards the intent; record it so tests can assert the
      // frame shape (customInstructions is optional).
      record({
        type: "compact",
        ...(typeof command.customInstructions === "string"
          ? { customInstructions: command.customInstructions }
          : {}),
      });
    }
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 5));
process.stdin.resume();
