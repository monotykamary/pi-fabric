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

  it("handles realistic message-only and anonymous tool event shapes", () => {
    const transcript = projectAgentTranscript([
      { type: "tool_execution_start", toolName: "read", args: { path: "README.md" } },
      { type: "tool_execution_end", toolName: "read", isError: false },
      { type: "message_end", message: { role: "assistant", content: "complete" } },
    ]);

    expect(transcript.entries).toEqual([
      expect.objectContaining({ kind: "tool", label: "read", status: "completed" }),
      expect.objectContaining({ kind: "assistant", text: "complete", status: "completed" }),
    ]);
  });

  it("projects Claude stream-json assistant and tool events", () => {
    const transcript = projectAgentTranscript([
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "draft" } },
      },
      {
        type: "assistant",
        uuid: "assistant-tool",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "Read",
              input: { file_path: "README.md", authorization: "secret" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "loaded" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-final",
        message: { role: "assistant", content: [{ type: "text", text: "Claude complete" }] },
      },
      { type: "result", subtype: "success", is_error: false },
    ]);

    expect(transcript.entries).toEqual([
      expect.objectContaining({
        kind: "assistant",
        label: "Claude",
        text: "Claude complete",
        status: "completed",
      }),
      expect.objectContaining({
        kind: "tool",
        label: "Read",
        text: expect.stringContaining("[redacted]"),
        status: "completed",
      }),
    ]);
  });

  it("settles assistant, tool, retry, and compaction failures and completions", () => {
    const transcript = projectAgentTranscript([
      { type: "message_update", message: { role: "assistant", content: "partial" } },
      {
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "model failed" },
      },
      { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "false" } },
      { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: true, result: "exit 1" },
      { type: "auto_retry_start", attempt: 1, errorMessage: "rate limited" },
      { type: "auto_retry_end", attempt: 1, success: true },
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", aborted: false },
      { type: "response", command: "prompt", success: false, error: "prompt rejected" },
    ]);

    expect(transcript.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", text: "partial", status: "failed" }),
        expect.objectContaining({ kind: "tool", label: "bash", text: expect.stringContaining("exit 1"), status: "failed" }),
        expect.objectContaining({ kind: "status", label: "Retry 1", status: "completed" }),
        expect.objectContaining({ kind: "status", label: "Compacting context", status: "completed" }),
        expect.objectContaining({ kind: "error", label: "Prompt rejected", text: "prompt rejected" }),
      ]),
    );
  });

  it("redacts secrets and strips terminal and bidi controls without splitting emoji", () => {
    const long = `${"a".repeat(9_000)}secret-tail👩‍💻`;
    const transcript = projectAgentTranscript([
      {
        type: "tool_execution_start",
        toolCallId: "secret-tool",
        toolName: "request\u202e",
        args: {
          authorization: "Bearer top-secret-token",
          apiKey: "sk_test_secret_value",
          payload: "A".repeat(200),
        },
      },
      {
        type: "message_end",
        message: { role: "assistant", content: `\u001b]8;;https://evil.test\u0007safe\u001b]8;;\u0007 ${long}` },
      },
    ]);

    const tool = transcript.entries[0];
    const assistant = transcript.entries[1];
    expect(tool?.label).toBe("request");
    expect(tool?.text).toContain("[redacted]");
    expect(tool?.text).not.toContain("top-secret-token");
    expect(tool?.text).toContain("large encoded value");
    expect(assistant?.text).not.toContain("evil.test");
    expect(
      Array.from(assistant?.text ?? "").some(
        (character) => character.length === 1 && /[\uD800-\uDFFF]/.test(character),
      ),
    ).toBe(false);
    expect(assistant?.text).toContain("👩‍💻");
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

  it("preserves partial UTF-8 JSON records across incremental reads", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-transcript-"));
    temporaryDirectories.push(directory);
    const logFile = path.join(directory, "events.jsonl");
    const line = Buffer.from(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "界面 🚀" } })}\n`,
    );
    const split = line.indexOf(Buffer.from("界")) + 1;
    fs.writeFileSync(logFile, line.subarray(0, split));
    const agent: FabricUiAgent = {
      id: "agent-utf8",
      name: "unicode",
      status: "running",
      transport: "process",
      cwd: directory,
      logFile,
    };
    const reader = new AgentTranscriptReader();

    expect(reader.read(agent).entries).toEqual([]);
    fs.appendFileSync(logFile, line.subarray(split));
    expect(reader.read(agent).entries[0]).toMatchObject({ text: "界面 🚀", status: "completed" });
  });

  it("invalidates same-size rewrites and retains cached data across transient failures", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-transcript-"));
    temporaryDirectories.push(directory);
    const logFile = path.join(directory, "events.jsonl");
    const event = (text: string) =>
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: text } })}\n`;
    fs.writeFileSync(logFile, event("first"));
    const agent: FabricUiAgent = {
      id: "agent-cache",
      name: "cache",
      status: "completed",
      transport: "process",
      cwd: directory,
      logFile,
    };
    const reader = new AgentTranscriptReader();
    expect(reader.read(agent).entries[0]?.text).toBe("first");

    fs.writeFileSync(logFile, event("other"));
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(logFile, future, future);
    expect(reader.read(agent).entries[0]?.text).toBe("other");

    fs.rmSync(logFile);
    expect(reader.read(agent).entries[0]?.text).toBe("other");
    reader.clear();
    expect(reader.read(agent).entries).toEqual([]);
  });
});
