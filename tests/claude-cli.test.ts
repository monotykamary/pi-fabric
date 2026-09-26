import { describe, expect, it } from "vitest";
import { buildClaudeArguments, claudeUserMessage } from "../src/agents/claude-cli.js";

describe("Claude stream-json messages", () => {
  it("maps Fabric image blocks to Claude base64 content blocks", () => {
    const message = claudeUserMessage("Inspect this", [
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    expect(message).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
          },
        ],
      },
    });
  });
});

describe("Claude session persistence", () => {
  const options = { tools: ["read"], extensions: false, persistentSession: false };

  it("disables transcript persistence by default", () => {
    expect(buildClaudeArguments(options)).toContain("--no-session-persistence");
  });

  it("omits the disable flag when explicitly opted in", () => {
    expect(buildClaudeArguments({ ...options, persistentSession: true })).not.toContain("--no-session-persistence");
  });
});
