import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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
      { reason: "big file reads", instructions: "Keep the plan", requestedBy: "skill" },
      context,
    )) as { requested: true; intent: { reason?: string; instructions?: string; requestedBy: string } };
    expect(result.requested).toBe(true);
    expect(result.intent.reason).toBe("big file reads");
    expect(result.intent.instructions).toBe("Keep the plan");
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

  it("request inputSchema requires no fields and accepts optional reason/instructions/requestedBy", async () => {
    const { provider } = setup();
    const descriptor = await provider.describe("request", context);
    const schema = descriptor?.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties).toHaveProperty("reason");
    expect(schema.properties).toHaveProperty("instructions");
    expect(schema.properties).toHaveProperty("requestedBy");
    expect(schema.required ?? []).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });
});
