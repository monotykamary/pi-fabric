#!/usr/bin/env node
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
const requested = { provider: "openai-codex", id: "gpt-5.6-sol" };
const wrong = { provider: "runinfra", id: "glm-5-3-flash" };
// Simulate an MRU extension replacing the --model selection during startup.
let model = wrong;
let thinkingLevel = "low";
let behavior = "success";
const taskFile = process.env.FAKE_MODEL_SCENARIO;
if (taskFile) behavior = fs.readFileSync(taskFile, "utf8");
const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += decoder.write(chunk);
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const frame = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    emit({ type: "fake_received", frame });
    const reply = (data, success = true) => emit({ type: "response", id: frame.id, command: frame.type, success, data, ...(success ? {} : { error: "model unavailable" }) });
    if (frame.type === "get_available_models") {
      reply({ models: [requested, wrong] });
    } else if (frame.type === "set_model") {
      if (behavior === "exit") process.exit(0);
      if (behavior === "timeout") continue;
      if (behavior === "reject") { reply(undefined, false); continue; }
      model = { provider: frame.provider, id: frame.modelId };
      thinkingLevel = "max"; // model_select restores a remembered level.
      reply(model);
      if (behavior === "reswitch") model = wrong;
    } else if (frame.type === "set_thinking_level") {
      thinkingLevel = frame.level;
      reply();
    } else if (frame.type === "get_state") {
      reply(behavior === "malformed" ? {} : { model, thinkingLevel, isStreaming: false });
    } else if (frame.type === "prompt") {
      emit({ type: "agent_start" });
      const actual = behavior === "drift" ? wrong : model;
      const message = { role: "assistant", provider: actual.provider, model: actual.id, content: [{ type: "text", text: "correct model ran" }], stopReason: "stop", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } };
      emit({ type: "message_start", message });
      emit({ type: "message_end", message });
      // Late events must never erase the model mismatch failure.
      emit({ type: "agent_start" });
      emit({ type: "agent_end" });
      emit({ type: "agent_settled" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
