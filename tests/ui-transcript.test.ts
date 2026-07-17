import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTranscriptReader, projectAgentTranscript } from "../src/ui/transcript.js";
import type { FabricUiAgent } from "../src/ui/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent transcript projection", () => {
  it("projects streamed assistant text and tool lifecycle events", () => {
    const transcript = projectAgentTranscript([
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "Reviewing the dashboard" }] },
      },
      { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "src/ui/dashboard.ts" } },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "Loaded dashboard source" }] },
        isError: false,
      },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Found the transcript path" }] },
      },
    ]);

    expect(transcript.entries).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Found the transcript path", status: "completed" }),
      expect.objectContaining({ kind: "tool", label: "read", text: '{"path":"src/ui/dashboard.ts"}', status: "completed" }),
    ]);
  });


  it("shows provider diagnostics when an assistant message fails without text", () => {
    const transcript = projectAgentTranscript([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "fetch failed",
          diagnostics: [{ error: { message: "WebSocket error" } }],
        },
      },
    ]);

    expect(transcript.entries[0]).toMatchObject({
      kind: "error",
      label: "Agent error",
      text: "fetch failed · WebSocket error",
      status: "failed",
    });
  });

  it("retains a stable ring tail while old transcript entries roll off", () => {
    const events = Array.from({ length: 90 }, (_, index) => ({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `update-${index}` }],
      },
    }));

    const transcript = projectAgentTranscript(events);
    expect(transcript.entries).toHaveLength(80);
    expect(transcript.truncated).toBe(true);
    expect(transcript.entries[0]?.text).toBe("update-10");
    expect(transcript.entries.at(-1)?.text).toBe("update-89");
  });

  it("tails a live JSONL file and refreshes when it grows", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-transcript-"));
    temporaryDirectories.push(directory);
    const logFile = path.join(directory, "events.jsonl");
    fs.writeFileSync(
      logFile,
      `${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "First update" }] } })}\n`,
    );
    const agent: FabricUiAgent = {
      id: "agent-1",
      name: "reviewer",
      status: "running",
      transport: "process",
      cwd: directory,
      logFile,
    };
    const reader = new AgentTranscriptReader();

    expect(reader.read(agent).entries[0]).toMatchObject({ text: "First update", status: "running" });
    fs.appendFileSync(
      logFile,
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Finished update" }] } })}\n`,
    );
    expect(reader.read(agent).entries[0]).toMatchObject({ text: "Finished update", status: "completed" });
  });
});
