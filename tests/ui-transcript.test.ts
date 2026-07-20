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
      expect.objectContaining({
        kind: "tool",
        label: "read",
        text: '{"path":"src/ui/dashboard.ts"}',
        args: { path: "src/ui/dashboard.ts" },
        result: { content: [{ type: "text", text: "Loaded dashboard source" }] },
        status: "completed",
      }),
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
          command:
            "PASSWORD=hunter2 curl https://user:pass@example.test --token abc123 Authorization: Basic dXNlcjpwYXNz",
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
    expect(tool?.text).not.toContain("hunter2");
    expect(tool?.text).not.toContain("user:pass");
    expect(tool?.text).not.toContain("abc123");
    expect(tool?.text).not.toContain("dXNlcjpwYXNz");
    expect(tool?.text).toContain("large encoded value");
    expect(assistant?.text).not.toContain("evil.test");
    expect(
      Array.from(assistant?.text ?? "").some(
        (character) => character.length === 1 && /[\uD800-\uDFFF]/.test(character),
      ),
    ).toBe(false);
    expect(assistant?.text).toContain("👩‍💻");
  });

  it("bounds oversized messages and structured tool values before caching", () => {
    const oversized = "large value ".repeat(20_000);
    const transcript = projectAgentTranscript([
      {
        type: "tool_execution_start",
        toolCallId: "large-tool",
        toolName: "read",
        args: { path: "large.txt", payload: oversized },
      },
      {
        type: "tool_execution_end",
        toolCallId: "large-tool",
        toolName: "read",
        result: { content: oversized },
      },
      { type: "message_end", message: { role: "assistant", content: oversized } },
    ]);

    const tool = transcript.entries[0];
    const assistant = transcript.entries[1];
    expect(JSON.stringify(tool?.args).length).toBeLessThan(20_000);
    expect(JSON.stringify(tool?.result).length).toBeLessThan(20_000);
    expect(assistant?.text?.length).toBeLessThanOrEqual(40_000);
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

  it("retains nested fabric tool structure for rich code-change rendering", () => {
    const transcript = projectAgentTranscript([
      {
        type: "tool_execution_start",
        toolCallId: "outer",
        toolName: "fabric_exec",
        args: { code: "await pi.edit(...)" },
      },
      {
        type: "tool_execution_start",
        toolCallId: "fabric_edit",
        toolName: "edit",
        args: {
          path: "src/example.ts",
          edits: [{ oldText: "const oldValue = 1;", newText: "const newValue = 2;" }],
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "fabric_edit",
        toolName: "edit",
        result: { output: "Successfully replaced 1 block" },
        isError: false,
      },
    ]);

    expect(transcript.entries[1]).toMatchObject({
      kind: "tool",
      toolName: "edit",
      parentId: "outer",
      depth: 1,
      args: { path: "src/example.ts" },
      result: { output: "Successfully replaced 1 block" },
      status: "completed",
    });
  });

  it("navigates an unbounded log through bounded lazy pages", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-transcript-"));
    temporaryDirectories.push(directory);
    const logFile = path.join(directory, "events.jsonl");
    const events = Array.from({ length: 520 }, (_, index) => ({
      type: "message_end",
      message: { role: "assistant", content: `page-${index}` },
    }));
    fs.writeFileSync(logFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const agent: FabricUiAgent = {
      id: "agent-pages",
      name: "paged",
      status: "completed",
      transport: "process",
      cwd: directory,
      logFile,
    };
    const reader = new AgentTranscriptReader();

    const tail = reader.read(agent);
    expect(tail.entries).toHaveLength(40);
    expect(tail.entries[0]?.text).toBe("page-480");
    expect(tail.hasMore).toBe(true);
    expect(tail.hasNewer).toBe(false);

    for (let page = 0; page < 12; page++) {
      expect(reader.loadOlder(agent)).toBe(true);
      expect(reader.read(agent, false).entries.length).toBeLessThanOrEqual(40);
    }
    const beginning = reader.read(agent, false);
    expect(beginning.entries).toHaveLength(40);
    expect(beginning.entries[0]?.text).toBe("page-0");
    expect(beginning.entries.at(-1)?.text).toBe("page-39");
    expect(beginning.hasMore).toBe(false);
    expect(beginning.hasNewer).toBe(true);
    expect(reader.loadOlder(agent)).toBe(false);

    for (let page = 0; page < 12; page++) {
      expect(reader.loadNewer(agent)).toBe(true);
      expect(reader.read(agent, false).entries.length).toBeLessThanOrEqual(40);
    }
    const returnedTail = reader.read(agent, false);
    expect(returnedTail.entries[0]?.text).toBe("page-480");
    expect(returnedTail.entries.at(-1)?.text).toBe("page-519");
    expect(returnedTail.hasNewer).toBe(false);
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

  it("bounds live transcript pages and freezes a paused page while the log grows", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-transcript-"));
    temporaryDirectories.push(directory);
    const logFile = path.join(directory, "events.jsonl");
    const event = (text: string) =>
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: text } });
    fs.writeFileSync(logFile, `${event("initial")}\n`);
    const agent: FabricUiAgent = {
      id: "agent-bounded",
      name: "bounded",
      status: "running",
      transport: "process",
      cwd: directory,
      logFile,
    };
    const reader = new AgentTranscriptReader();
    reader.read(agent);
    fs.appendFileSync(
      logFile,
      `${Array.from({ length: 1_500 }, (_, index) => event(`live-${index}`)).join("\n")}\n`,
    );

    const live = reader.read(agent);
    expect(live.entries).toHaveLength(40);
    expect(live.entries[0]?.text).toBe("live-1460");
    expect(live.entries.at(-1)?.text).toBe("live-1499");
    expect(live.hasMore).toBe(true);
    expect(reader.loadOlder(agent)).toBe(true);

    fs.appendFileSync(logFile, `${event("live-1500")}\n`);
    const paused = reader.read(agent, false);
    expect(paused.entries).toHaveLength(40);
    expect(paused.entries.at(-1)?.text).toBe("live-1459");
    expect(paused.hasNewer).toBe(true);

    expect(reader.loadLatest(agent)).toBe(true);
    const latest = reader.read(agent);
    expect(latest.entries).toHaveLength(40);
    expect(latest.entries.at(-1)?.text).toBe("live-1500");
    expect(latest.hasNewer).toBe(false);
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
