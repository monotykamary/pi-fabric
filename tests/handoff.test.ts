import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  snapshotHandoffSession,
  writeHandoffSession,
} from "../src/agents/handoff.js";
import type { AgentToolResultMessage } from "../src/agents/types.js";

const roots: string[] = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (content: Array<Record<string, unknown>>) => ({
  role: "assistant" as const,
  content,
  api: "anthropic",
  provider: "anthropic",
  model: "frontier",
  usage,
  stopReason: content.some((part) => part.type === "toolCall")
    ? "toolUse" as const
    : "stop" as const,
  timestamp: Date.now(),
}) as unknown as Parameters<SessionManager["appendMessage"]>[0];

const outerResult = (toolCallId: string): AgentToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "fabric_exec",
  content: [{
    type: "text",
    text: "full Fabric program completed: read, edit one, edit two, tests passed",
  }],
  details: {
    success: true,
    trace: {
      kind: "pi-fabric.execution",
      version: 1,
      operations: ["pi.read", "pi.edit", "pi.edit", "pi.bash"],
    },
  },
  isError: false,
  timestamp: 20,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trajectory handoff sessions", () => {
  it("forks through the outer fabric_exec call and appends its finalized native result", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.create(root, path.join(root, "source"));
    source.appendMessage({ role: "user", content: "Implement the token guard", timestamp: 1 });
    source.appendMessage(assistant([{ type: "text", text: "I found src/token.ts." }]));
    source.appendMessage({ role: "user", content: "Proceed", timestamp: 2 });
    const activeEntryId = source.appendMessage(
      assistant([
        { type: "thinking", thinking: "Run the complete implementation program." },
        { type: "text", text: "I will implement and verify the change." },
        {
          type: "toolCall",
          id: "outer-fabric-call",
          name: "fabric_exec",
          arguments: {
            code: "await pi.read(...); await pi.edit(...); await pi.edit(...); await pi.bash(...);",
          },
        },
      ]),
    );

    const result = outerResult("outer-fabric-call");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-fabric-call",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"));
    const child = SessionManager.open(sessionFile);
    const messages = child.buildSessionContext().messages;

    expect(seed.sourceBranchLeafId).toBe(activeEntryId);
    expect(child.getHeader()?.parentSession).toBe(source.getSessionFile());
    expect(child.getSessionId()).not.toBe(source.getSessionId());
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Run the complete implementation program." },
        { type: "text", text: "I will implement and verify the change." },
        {
          type: "toolCall",
          id: "outer-fabric-call",
          name: "fabric_exec",
          arguments: {
            code: "await pi.read(...); await pi.edit(...); await pi.edit(...); await pi.bash(...);",
          },
        },
      ],
    });
    expect(messages[4]).toEqual(result);
    expect(child.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("fabric_nested_");
    expect(source.getLeafId()).toBe(activeEntryId);
    expect(source.buildSessionContext().messages.at(-1)?.role).toBe("assistant");
    if (process.platform !== "win32") {
      expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
    }
  });

  it("materializes an in-memory source with the complete outer boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Preserve rare fact 43117", timestamp: 1 });
    source.appendMessage(
      assistant([
        { type: "text", text: "Rare fact retained." },
        {
          type: "toolCall",
          id: "outer-in-memory",
          name: "fabric_exec",
          arguments: { code: "await pi.write(...); await pi.bash(...);" },
        },
      ]),
    );

    const result = outerResult("outer-in-memory");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-in-memory",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"));
    const child = SessionManager.open(sessionFile);

    expect(child.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "Preserve rare fact 43117" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Rare fact retained." },
          { type: "toolCall", name: "fabric_exec" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "outer-in-memory",
        toolName: "fabric_exec",
        isError: false,
      },
    ]);
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: {
        sourceSessionId: source.getSessionId(),
        boundary: "fabric_exec_end",
      },
    });
  });

  it("fails rather than forking an incomplete parallel top-level tool batch", () => {
    const source = SessionManager.inMemory();
    source.appendMessage({ role: "user", content: "Do both", timestamp: 1 });
    source.appendMessage(
      assistant([
        { type: "toolCall", id: "outer", name: "fabric_exec", arguments: {} },
        { type: "toolCall", id: "sibling", name: "read", arguments: { path: "x" } },
      ]),
    );

    expect(() =>
      snapshotHandoffSession(
        source,
        { provider: "anthropic", id: "frontier" },
        outerResult("outer"),
        "outer",
      )
    ).toThrow(/only top-level tool call/);
  });
});
