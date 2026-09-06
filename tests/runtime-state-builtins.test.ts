import { describe, expect, it, vi } from "vitest";
import { createProviderComponent, type FabricProviderComponentManifest } from "../src/components/provider-component.js";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { RuntimeStateBuiltins } from "../src/runtime-state-builtins.js";

const fixture = () => {
  const manifest = { install: vi.fn(async () => {}), assertActive: vi.fn() };
  const onInstalled = vi.fn();
  const registry = new ActionRegistry();
  const builtins = new RuntimeStateBuiltins(
    manifest as unknown as FabricProviderComponentManifest, registry, onInstalled,
  );
  return { manifest, onInstalled, registry, builtins };
};

describe("runtime built-in installation policy", () => {
  it.each([
    { fullCodeMode: false, schema: { mode: "off" }, capture: { enabled: true }, expected: [] },
    { fullCodeMode: true, schema: { mode: "off" }, capture: { enabled: false }, expected: ["pi"] },
    { fullCodeMode: true, schema: { mode: "off" }, capture: { enabled: true }, expected: ["pi", "extensions"] },
    { fullCodeMode: false, schema: { mode: "enforce" }, capture: { enabled: false }, expected: ["pi"] },
    { fullCodeMode: true, schema: { mode: "enforce" }, capture: { enabled: true }, expected: ["pi"] },
  ])("asserts the protected provider surface for %j", ({ expected, ...options }) => {
    const { builtins, manifest, registry } = fixture();
    builtins.assertActive(normalizeFabricConfig({
      ...options, mesh: { enabled: false }, memory: { enabled: false },
    }));
    const [names, actualRegistry] = manifest.assertActive.mock.calls[0] as unknown as [Set<string>, ActionRegistry];
    expect([...names]).toEqual([...expected, "mcp", "schema", "compact", "agents"]);
    expect(actualRegistry).toBe(registry);
  });

  it("records ownership only after successful activation", async () => {
    const { builtins, manifest, onInstalled } = fixture();
    const component = createProviderComponent({
      provider: "compact", description: "Fixture",
      create: () => ({
        name: "compact", description: "Fixture",
        async list() { return []; }, async describe() { return undefined; },
        async invoke() { return undefined; },
      }),
    });
    manifest.install.mockRejectedValueOnce(new Error("activation failed"));
    await expect(builtins.install(component)).rejects.toThrow("activation failed");
    expect(onInstalled).not.toHaveBeenCalled();
    await builtins.install(component);
    expect(onInstalled).toHaveBeenCalledExactlyOnceWith("fabric.provider.compact");
  });
});
