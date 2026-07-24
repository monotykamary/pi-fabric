import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piFabric from "../src/index.js";
import { FABRIC_PROVIDER_REGISTER_EVENT } from "../src/protocol.js";

type ExtensionHandler = (...args: never[]) => unknown;

describe("Pi Fabric extension shutdown", () => {
  it("unsubscribes shared provider listeners across reloads", async () => {
    const providerListeners = new Set<(value: unknown) => void>();
    const events = {
      emit: vi.fn(),
      on: vi.fn((channel: string, handler: (value: unknown) => void) => {
        if (channel === FABRIC_PROVIDER_REGISTER_EVENT) providerListeners.add(handler);
        return () => providerListeners.delete(handler);
      }),
    };

    for (let reload = 0; reload < 3; reload++) {
      const handlers = new Map<string, ExtensionHandler[]>();
      const pi = {
        events,
        getActiveTools: vi.fn(() => []),
        getAllTools: vi.fn(() => []),
        on: vi.fn((event: string, handler: ExtensionHandler) => {
          const registered = handlers.get(event) ?? [];
          registered.push(handler);
          handlers.set(event, registered);
        }),
        registerCommand: vi.fn(),
        registerTool: vi.fn(),
        setActiveTools: vi.fn(),
      } as unknown as ExtensionAPI;

      await piFabric(pi);
      expect(providerListeners.size).toBe(1);

      const shutdown = handlers.get("session_shutdown")?.[0] as
        | (() => Promise<void>)
        | undefined;
      expect(shutdown).toBeDefined();
      await shutdown?.();
      expect(providerListeners.size).toBe(0);
    }
  });
});
