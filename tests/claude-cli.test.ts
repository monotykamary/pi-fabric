import { describe, expect, it } from "vitest";
import { claudeUserMessage } from "../src/subagents/claude-cli.js";

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
