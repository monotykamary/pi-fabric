import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ExtensionContext,
  type ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import { NESTED_TOOL_CALL_ID_PREFIX } from "../src/core/action-registry.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

const baseContext = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  parentToolCallId: "parent",
  nestedToolCallId: "fabric_test-nested",
  extensionContext: { cwd: process.cwd() } as ExtensionContext,
  update: vi.fn(),
  approve: vi.fn(async () => {}),
  audits: [],
  maxResultChars: 100_000,
};

const makeRunner = (overrides: Record<string, unknown> = {}): ExtensionRunner =>
  ({
    createContext: () => ({ cwd: process.cwd() }),
    emit: vi.fn(async () => {}),
    emitToolCall: vi.fn(async () => undefined),
    emitToolResult: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as ExtensionRunner;

const registerWithRunner = (runner: ExtensionRunner) => {
  const catalog = new CapturedToolCatalog();
  catalog.replace(
    [],
    runner,
    DEFAULT_FABRIC_CONFIG.capture,
    "/extensions/pi-fabric/index.ts",
  );
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(process.cwd(), catalog, undefined));
  return registry;
};

describe("PiToolsProvider lifecycle", () => {
  it("fires the full tool-execution lifecycle for a pi core tool", async () => {
    const events: string[] = [];
    const runner = makeRunner({
      emit: vi.fn(async (event: { type: string }) => {
        events.push(event.type);
      }),
    });
    const registry = registerWithRunner(runner);

    await registry.invoke("pi.ls", { path: process.cwd() }, baseContext);

    expect(events).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(runner.emitToolCall).toHaveBeenCalledOnce();
    expect(runner.emitToolResult).toHaveBeenCalledOnce();
    const toolResult = (runner.emitToolResult as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { toolName: string; toolCallId: string; isError: boolean };
    expect(toolResult).toMatchObject({ toolName: "ls", isError: false });
    // ActionRegistry rewrites nestedToolCallId to fabric_<uuid>.
    expect(toolResult.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)).toBe(true);
  });

  it("applies a tool_result content patch to a core tool result", async () => {
    const runner = makeRunner({
      emitToolResult: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "[Image: a sample image, fully described.]" }],
      })),
    });
    const registry = registerWithRunner(runner);

    // A tool_result patch must flow through normalizeResult as the returned text.
    // Use a text file here because image decoding is covered by the media tests below.
    const result = await registry.invoke(
      "pi.read",
      { path: "package.json" },
      baseContext,
    );

    expect(result).toBe("[Image: a sample image, fully described.]");
  });


  it("honors a tool_call block by throwing without executing", async () => {
    const runner = makeRunner({
      emitToolCall: vi.fn(async () => ({ block: true, reason: "denied by gate" })),
    });
    const registry = registerWithRunner(runner);

    await expect(
      registry.invoke("pi.ls", { path: process.cwd() }, baseContext),
    ).rejects.toThrow("denied by gate");
  });

  it("falls back to a direct execute (no events) when no runner is bound", async () => {
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(process.cwd(), undefined, undefined));
    const result = await registry.invoke("pi.ls", { path: process.cwd() }, baseContext);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });

  it("captures pre-write content out of band without changing the sandbox result", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-write-preview-"));
    const before = `const value = 1;
`;
    const after = `export const value = "é${"x".repeat(20_000)}";
`;
    try {
      fs.writeFileSync(path.join(cwd, "example.ts"), before);
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const audits: FabricCallAudit[] = [];
      const result = await registry.invoke(
        "pi.write",
        { path: "example.ts", content: after },
        {
          ...baseContext,
          cwd,
          extensionContext: { cwd } as ExtensionContext,
          audits,
        },
      ) as { ok: boolean; output: string; details: unknown };

      expect(result).toMatchObject({ ok: true, details: null });
      expect(result.output).toContain("Successfully wrote");
      expect(result.output).toContain(`${Buffer.byteLength(after, "utf8")} bytes`);
      expect(fs.readFileSync(path.join(cwd, "example.ts"), "utf8")).toBe(after);
      expect(String(audits[0]?.args?.content ?? "").length).toBeLessThan(after.length);
      expect(audits[0]?.preview).toMatchObject({
        writeBeforeCaptured: true,
        writeContent: after,
        writeByteLength: Buffer.byteLength(after, "utf8"),
        writeLineCount: 1,
        codePreviewBeforeWrite: { kind: "content", content: before },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });


  it("attaches the pre-patch image and clean note when a tool_result patch replaces image blocks", async () => {
    // pi-vision-handoff keeps the read note and swaps the image for a
    // description. The provider captures the image BEFORE the patch (so the
    // single-call kitty preview still shows it) and the clean note AFTER.
    let rawContent: unknown;
    const runner = makeRunner({
      emitToolResult: vi.fn(async (event: { content: unknown }) => {
        rawContent = event.content;
        return {
          content: [
            { type: "text" as const, text: "Read image file [image/png]" },
            { type: "text" as const, text: "[Image: a described image.]" },
          ],
        };
      }),
    });
    const registry = registerWithRunner(runner);
    const audits: FabricCallAudit[] = [];

    await registry.invoke(
      "pi.read",
      { path: "tests/fixtures/images/sample.jpg" },
      { ...baseContext, audits },
    );

    expect((rawContent as Array<{ type: string }>).some((block) => block.type === "image")).toBe(true);
    expect(audits).toHaveLength(1);
    const media = audits[0]?.media;
    expect(media).toBeDefined();
    expect(media!.length).toBeGreaterThan(0);
    expect(media![0]?.type).toBe("image");
    expect(media![0]?.mimeType).toMatch(/^image\//);
    expect(typeof media![0]?.data).toBe("string");
    expect(media![0]?.data!.length).toBeGreaterThan(0);
    expect(audits[0]?.mediaNote).toBe("Read image file [image/png]");
  }, 15_000);
});
