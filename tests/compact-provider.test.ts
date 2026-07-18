import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  MAX_COMPACTION_INSTRUCTIONS_CHARS,
  MAX_PRESERVE_ITEM_CHARS,
  MAX_PRESERVE_ITEMS,
} from "../src/compaction/instructions.js";
import { CompactController } from "../src/core/compact-controller.js";
import { CompactProvider } from "../src/providers/compact-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
  activity() {},
};

const setup = (): { controller: CompactController; provider: CompactProvider } => {
  const controller = new CompactController();
  const provider = new CompactProvider(controller);
  return { controller, provider };
};

describe("CompactProvider", () => {
  it("exposes request (write), status (read), and cancel (read) descriptors", async () => {
    const { provider } = setup();
    const listed = await provider.list({}, context);
    const names = listed.map((d) => d.name);
    expect(names).toEqual(["request", "status", "cancel"]);
    const byName = new Map(listed.map((d) => [d.name, d]));
    expect(byName.get("request")?.risk).toBe("write");
    expect(byName.get("status")?.risk).toBe("read");
    expect(byName.get("cancel")?.risk).toBe("read");
  });

  it("describe returns each action by name and undefined otherwise", async () => {
    const { provider } = setup();
    expect((await provider.describe("request", context))?.name).toBe("request");
    expect((await provider.describe("status", context))?.name).toBe("status");
    expect((await provider.describe("cancel", context))?.name).toBe("cancel");
    expect(await provider.describe("nope", context)).toBeUndefined();
  });

  it("list filters by query", async () => {
    const { provider } = setup();
    const listed = await provider.list({ query: "cancel" }, context);
    expect(listed.map((d) => d.name)).toEqual(["cancel"]);
  });

  it("request records the intent and returns it", async () => {
    const { controller, provider } = setup();
    const result = (await provider.invoke(
      "request",
      {
        reason: "big file reads",
        instructions: "Keep the plan",
        preserve: ["rare fact"],
        requestedBy: "skill",
      },
      context,
    )) as { requested: true; intent: { reason?: string; instructions?: string; preserve?: string[]; requestedBy: string } };
    expect(result.requested).toBe(true);
    expect(result.intent.reason).toBe("big file reads");
    expect(result.intent.instructions).toBe("Keep the plan");
    expect(result.intent.preserve).toEqual(["rare fact"]);
    expect(result.intent.requestedBy).toBe("skill");
    expect(controller.status().pending?.instructions).toBe("Keep the plan");
  });

  it("request replaces a pending intent with the latest instructions", async () => {
    const { provider, controller } = setup();
    await provider.invoke("request", { instructions: "A" }, context);
    await provider.invoke("request", { instructions: "B" }, context);
    expect(controller.status().pending?.instructions).toBe("B");
  });

  it("status returns the controller status snapshot", async () => {
    const { provider } = setup();
    expect(await provider.invoke("status", {}, context)).toEqual({});
    await provider.invoke("request", { reason: "x" }, context);
    const status = (await provider.invoke("status", {}, context)) as {
      pending?: { reason?: string };
    };
    expect(status.pending?.reason).toBe("x");
  });

  it("cancel clears the pending intent", async () => {
    const { provider, controller } = setup();
    await provider.invoke("request", { reason: "x" }, context);
    const result = (await provider.invoke("cancel", {}, context)) as { cancelled: true };
    expect(result.cancelled).toBe(true);
    expect(controller.status().pending).toBeUndefined();
  });

  it("request rejects unknown action names", async () => {
    const { provider } = setup();
    await expect(provider.invoke("bogus", {}, context)).rejects.toThrow(/Unknown compact action/);
  });

  it("request inputSchema bounds instructions and preserve before invocation mapping", async () => {
    const { provider } = setup();
    const descriptor = await provider.describe("request", context);
    const schema = descriptor?.inputSchema as {
      properties: {
        instructions: { maxLength: number };
        preserve: { maxItems: number; items: { maxLength: number } };
      };
      required?: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.instructions.maxLength).toBe(MAX_COMPACTION_INSTRUCTIONS_CHARS);
    expect(schema.properties.preserve.maxItems).toBe(MAX_PRESERVE_ITEMS);
    expect(schema.properties.preserve.items.maxLength).toBe(MAX_PRESERVE_ITEM_CHARS);
    expect(schema.required ?? []).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("rejects invalid types, unknown fields, and bounded fields before recording an intent", async () => {
    const { provider, controller } = setup();
    await expect(provider.invoke("request", { preserve: ["ok", 7] }, context)).rejects.toThrow(/Invalid compact\.request/);
    await expect(provider.invoke("request", { instructions: "ok", goal: "unknown" }, context)).rejects.toThrow(/Invalid compact\.request/);
    await expect(provider.invoke("request", {
      instructions: "x".repeat(MAX_COMPACTION_INSTRUCTIONS_CHARS + 1),
    }, context)).rejects.toThrow(/Invalid compact\.request/);
    await expect(provider.invoke("request", {
      instructions: "界".repeat(3000),
    }, context)).rejects.toThrow(/UTF-8 bytes/);
    await expect(provider.invoke("request", {
      preserve: Array.from({ length: MAX_PRESERVE_ITEMS + 1 }, () => "x"),
    }, context)).rejects.toThrow(/Invalid compact\.request/);
    await expect(provider.invoke("request", {
      preserve: ["x".repeat(MAX_PRESERVE_ITEM_CHARS + 1)],
    }, context)).rejects.toThrow(/Invalid compact\.request/);
    await expect(provider.invoke("request", {
      preserve: [String.fromCharCode(0xd800)],
    }, context)).rejects.toThrow(/unpaired UTF-16 surrogate/);
    expect(controller.status().pending).toBeUndefined();
  });

  it("rejects an aggregate typed request that exceeds the encoded byte bound", async () => {
    const { provider, controller } = setup();
    await expect(provider.invoke("request", {
      preserve: Array.from({ length: MAX_PRESERVE_ITEMS }, () => "x".repeat(1100)),
    }, context)).rejects.toThrow(/encoded UTF-8 bytes/);
    expect(controller.status().pending).toBeUndefined();
  });
});
