#!/usr/bin/env node

import fs from "node:fs";

const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!key?.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next !== undefined && !next.startsWith("--")) {
    options.set(key, next);
    index++;
  } else {
    options.set(key, true);
  }
}

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ argv: process.argv.slice(2), options: Object.fromEntries(options) }) + "\n",
  );
}

const sessionId =
  options.get("--resume") ||
  process.env.FAKE_CLAUDE_SESSION_ID ||
  "11111111-1111-4111-8111-111111111111";
let initialized = false;
let turn = 0;
let remainder = "";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

const models = [
  {
    value: "default",
    resolvedModel: "claude-sonnet-test",
    displayName: "Default (test)",
    description: "Fake default model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-test",
    displayName: "Haiku (test)",
    description: "Fake cheap model",
  },
];

const textOf = (message) => {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text).join("");
};

const answer = (input) => {
  turn++;
  if (!initialized) {
    initialized = true;
    emit({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: sessionId,
      model: options.get("--model") || "claude-sonnet-test",
      tools: String(options.get("--tools") || "").split(",").filter(Boolean),
    });
  }
  const prompt = textOf(input);
  const toolId = `toolu_fake_${turn}`;
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: "README.md" } }],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
      },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  emit({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolId, content: "fake read" }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });

  const schemaRaw = options.get("--json-schema");
  const schema = typeof schemaRaw === "string" ? JSON.parse(schemaRaw) : undefined;
  const value = schema?.properties?.action
    ? { action: "message", message: "fake claude advice" }
    : schema
      ? { ok: true }
      : undefined;
  const response = value ? JSON.stringify(value) : `fake claude complete: ${prompt.slice(0, 40)}`;
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: response }],
      usage: {
        input_tokens: 0,
        output_tokens: 4,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  const failed = prompt.includes("CLAUDE_FAIL");
  emit({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 2,
    result: failed ? "fake Claude failure" : response,
    ...(failed ? { errors: ["fake Claude failure"] } : {}),
    ...(value ? { structured_output: value } : {}),
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 7,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
  });
};

const processLine = (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          models,
          account: { tokenSource: "none", apiKeySource: "fake" },
          pid: process.pid,
        },
      },
    });
    return;
  }
  if (message.type === "user") answer(message);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  while (true) {
    const newline = remainder.indexOf("\n");
    if (newline < 0) break;
    const line = remainder.slice(0, newline);
    remainder = remainder.slice(newline + 1);
    processLine(line);
  }
});
process.stdin.on("end", () => {
  if (remainder.trim()) processLine(remainder);
});
