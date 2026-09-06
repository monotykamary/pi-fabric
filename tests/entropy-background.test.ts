import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const scanControl = vi.hoisted(() => ({
  calls: 0,
  resolvers: [] as Array<(files: string[]) => void>,
}));

vi.mock("../src/entropy/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/entropy/sessions.js")>();
  return {
    ...actual,
    machineSessionFilesAsync: () => {
      scanControl.calls += 1;
      return new Promise<string[]>((resolve) => scanControl.resolvers.push(resolve));
    },
  };
});

vi.mock("../src/fabric-runtime-state.js", () => ({
  FabricRuntimeState: class {
    initialized = true;
    widgetDismissedAt = 0;
    registry = { list: vi.fn(async () => []) };
    repairs = {
      repairs: [],
      status: () => ({
        enabled: true,
        catalogDigest: "test",
        repairCount: 0,
        applyHits: 0,
        invocationErrors: 0,
        effectDropped: 0,
        fingerprints: [],
        repairs: [],
      }),
    };
    async initialize(): Promise<void> {}
    async shutdown(): Promise<void> {}
    async publishHostLifecycle(): Promise<void> {}
    async settleComponents(): Promise<void> {}
    noteMainActivity(): void {}
    resetSpeculation(): void {}
    dispatchHostEvent(): number { return 0; }
    registerExternal(): void {}
    registerExternalComponent(): void {}
    mcpSlice(): never[] { return []; }
  },
}));

import piFabric from "../src/index.js";

type ExtensionHandler = (event: unknown, context: ExtensionContext) => unknown;

const tempRoots: string[] = [];
afterEach(() => {
  scanControl.calls = 0;
  scanControl.resolvers.length = 0;
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const createHarness = () => {
  const handlers = new Map<string, ExtensionHandler[]>();
  let command: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
  const pi = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: ExtensionHandler) => {
      const values = handlers.get(event) ?? [];
      values.push(handler);
      handlers.set(event, values);
    }),
    registerCommand: vi.fn((_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    }),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers, command: () => command! };
};

const emit = async (
  handlers: Map<string, ExtensionHandler[]>,
  name: string,
  event: unknown,
  context: ExtensionContext,
): Promise<void> => {
  for (const handler of handlers.get(name) ?? []) await handler(event, context);
};

describe("entropy background scheduler", () => {
  it("returns turn hooks immediately, coalesces pending turns, and flushes on shutdown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-background-"));
    tempRoots.push(root);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
    const harness = createHarness();
    await piFabric(harness.pi);
    const context = {
      mode: "code",
      cwd: root,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: { getBranch: () => [], getSessionId: () => "background-session" },
    } as unknown as ExtensionContext;
    await harness.command()("repairs", context);

    const trigger = async (): Promise<void> => {
      await emit(
        harness.handlers,
        "tool_execution_end",
        { toolName: "fabric_exec", isError: false },
        context,
      );
      await emit(harness.handlers, "turn_end", {}, context);
    };

    await trigger();
    expect(scanControl.calls).toBe(0);
    await vi.waitFor(() => expect(scanControl.calls).toBe(1), { timeout: 1_000 });
    await trigger();
    await trigger();
    expect(scanControl.calls).toBe(1);

    scanControl.resolvers.shift()!([]);
    await vi.waitFor(() => expect(scanControl.calls).toBe(2), { timeout: 1_000 });
    expect(scanControl.resolvers).toHaveLength(1);
    scanControl.resolvers.shift()!([]);
    await emit(harness.handlers, "session_shutdown", {}, context);
    expect(scanControl.calls).toBe(2);
  });
});
