import { afterEach, describe, expect, it, vi } from "vitest";
import { readChildToolAllowlist } from "../src/core/child-tool-allowlist.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context = { cwd: process.cwd(), signal: new AbortController().signal } as FabricInvocationContext;
afterEach(() => vi.unstubAllEnvs());

describe("child optional tool allowlist", () => {
  it("leaves the host unrestricted and fails closed for malformed inherited authority", () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
    expect(readChildToolAllowlist()).toBeUndefined();
    for (const value of ["", "null", "{}", "not json", '["read", 1]']) {
      expect([...readChildToolAllowlist(value)!]).toEqual([]);
    }
    expect([...readChildToolAllowlist('["read", "fabric_exec"]')!]).toEqual(["read"]);
  });

  it("filters discovery and blocks preparation and execution before any side effect", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read", "fabric_exec"]');
    const provider = new PiToolsProvider(process.cwd());
    expect((await provider.list({}, context)).map((entry) => entry.name)).toEqual(["read"]);
    expect(await provider.describe("bash", context)).toBeUndefined();
    expect(() => provider.prepareArguments("edit", { path: "must-not-read", oldText: "x", newText: "y", all: true })).toThrow(/allowlist/);
    await expect(provider.invoke("bash", { command: "must-not-execute" }, context)).rejects.toThrow(/allowlist/);
    // Permissions are frozen when the provider is created, not ambient mutable policy.
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["bash"]');
    expect(await provider.describe("read", context)).toBeDefined();
    expect(await provider.describe("bash", context)).toBeUndefined();
  });

  it("cannot bypass the allowlist through the captured-tool namespace", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read", "fabric_exec"]');
    const catalog = new CapturedToolCatalog();
    const entry = { name: "bash", definition: { description: "shell", parameters: {} }, sourceInfo: { path: "/extension/index.ts" }, risk: "execute" };
    const list = vi.spyOn(catalog, "list").mockReturnValue([entry] as never);
    const get = vi.spyOn(catalog, "get").mockReturnValue(entry as never);
    const require = vi.spyOn(catalog, "require");
    const provider = new CapturedToolsProvider(catalog);
    expect(await provider.list({}, context)).toEqual([]);
    expect(await provider.describe("bash", context)).toBeUndefined();
    expect(() => provider.prepareArguments("bash", {})).toThrow(/allowlist/);
    await expect(provider.invoke("bash", {}, context)).rejects.toThrow(/allowlist/);
    expect(require).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
  });
});
