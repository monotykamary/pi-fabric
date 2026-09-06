import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { CompactionThresholdSelection, FabricSettingsComponentOptions } from "../src/ui/settings.js";
import * as facade from "../src/ui/settings.js";
import { FabricSettingsComponent } from "../src/ui/settings-component.js";
import { buildFabricSettingsItems, populateClaudeModelSource } from "../src/ui/settings-sections.js";
import { openRpcFabricSettings } from "../src/ui/settings-rpc.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { buildExecutorSection } from "../src/ui/settings-sections-execution.js";
import { buildCaptureSection } from "../src/ui/settings-sections-presentation.js";
import { IntegerInputSubmenu, SectionSubmenu } from "../src/ui/settings-submenus.js";
import { compactionThresholdPartial, executorMemoryLimitOptions, parseBudgetValue, parseFormattedNumericValue } from "../src/ui/settings-values.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

type RpcContext = Parameters<typeof openRpcFabricSettings>[0];

const dialogs = () => ({
  select: vi.fn<RpcContext["ui"]["select"]>(),
  input: vi.fn<RpcContext["ui"]["input"]>(),
  notify: vi.fn<RpcContext["ui"]["notify"]>(),
});

const options = (items: SettingItem[], persist = vi.fn()) => ({
  projectScopeAvailable: false,
  getScope: () => "global" as const,
  setScope: vi.fn(),
  itemsForScope: () => items,
  persist,
});

describe("settings module boundaries", () => {
  it("preserves public option types through the facade", () => {
    expectTypeOf<CompactionThresholdSelection>().toEqualTypeOf<Parameters<typeof compactionThresholdPartial>[1]>();
    expectTypeOf<FabricSettingsComponentOptions>().toEqualTypeOf<NonNullable<ConstructorParameters<typeof FabricSettingsComponent>[4]>>();
  });

  it("builds execution settings using only display data and a persistence callback", () => {
    const persist = vi.fn();
    const item = buildExecutorSection({ config: DEFAULT_FABRIC_CONFIG, theme, persist });
    const section = item.submenu!(item.currentValue, () => {});
    expect(section).toBeInstanceOf(SectionSubmenu);
    if (!(section instanceof SectionSubmenu)) throw new Error("Expected a section");
    section.applyChange("executor.runtime", "node-process");
    expect(persist).toHaveBeenCalledExactlyOnceWith("executor.runtime", "node-process");
  });

  it("keeps capture list callbacks and summary updates within its section builder", () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.capture.keepVisible = [];
    const apply = vi.fn();
    const item = buildCaptureSection({
      config, theme, apply, persist: vi.fn(),
      options: { keepVisibleCandidates: ["read"] },
    });
    const section = item.submenu!(item.currentValue, () => {});
    if (!(section instanceof SectionSubmenu)) throw new Error("Expected a section");
    const listItem = section.items.find(child => child.id === "capture.keepVisible")!;
    const list = listItem.submenu!(listItem.currentValue, () => {});
    if (!(list instanceof SectionSubmenu)) throw new Error("Expected a list section");
    list.items[0]!.currentValue = "true";
    list.applyChange("capture.keepVisible.read", "true");
    expect(apply).toHaveBeenCalledExactlyOnceWith("capture.keepVisible", ["read"]);
    expect(listItem.currentValue).toBe("1 tool");
  });

  it("retains exactly the public runtime exports and their implementation identities", () => {
    expect({ ...facade }).toEqual({
      FabricSettingsComponent,
      buildFabricSettingsItems,
      populateClaudeModelSource,
      compactionThresholdPartial,
      executorMemoryLimitOptions,
      parseBudgetValue,
      parseFormattedNumericValue,
      openFabricSettings: facade.openFabricSettings,
    });
  });

  it("retries invalid RPC integers and commits through the shared submenu", async () => {
    const ui = dialogs();
    const item: SettingItem = {
      id: "agents.maxDepth",
      label: "Depth ›",
      currentValue: "0",
      submenu: (value, done) => new IntegerInputSubmenu(theme, "Depth", "", value, done, () => done()),
    };
    ui.select.mockImplementationOnce(async (_title, rows) => rows[0]);
    ui.select.mockResolvedValueOnce("Done");
    ui.input.mockResolvedValueOnce("-1").mockResolvedValueOnce(" 42 ");
    const config = options([item]);
    await openRpcFabricSettings({ ui }, config);
    expect(ui.notify).toHaveBeenCalledWith("Enter a non-negative safe integer.", "warning");
    expect(config.persist).toHaveBeenCalledExactlyOnceWith("agents.maxDepth", "42");
    expect(item.currentValue).toBe("42");
  });

  it("keeps shared section item references and delegates child changes only once", async () => {
    const ui = dialogs();
    const child: SettingItem = { id: "capture.enabled", label: "Enabled", currentValue: "true", values: ["true", "false"] };
    const apply = vi.fn();
    const root: SettingItem = {
      id: "capture",
      label: "Capture ›",
      currentValue: "enabled",
      submenu: (_value, done) => new SectionSubmenu(theme, "Capture", undefined, [child], apply, () => done()),
    };
    ui.select
      .mockImplementationOnce(async (_title, rows) => rows[0])
      .mockImplementationOnce(async (_title, rows) => rows[0])
      .mockResolvedValueOnce("false")
      .mockResolvedValueOnce("← Back")
      .mockResolvedValueOnce("Done");
    const config = options([root]);
    await openRpcFabricSettings({ ui }, config);
    expect(child.currentValue).toBe("false");
    expect(apply).toHaveBeenCalledExactlyOnceWith("capture.enabled", "false");
    expect(config.persist).not.toHaveBeenCalled();
  });

  it("does not persist cancelled submenu input or offer untrusted scope switching", async () => {
    const ui = dialogs();
    const item: SettingItem = {
      id: "agents.maxDepth", label: "Depth", currentValue: "0",
      submenu: (value, done) => new IntegerInputSubmenu(theme, "Depth", "", value, done, () => done()),
    };
    ui.select.mockImplementationOnce(async (_title, rows) => {
      expect(rows.some(row => row.startsWith("Switch save scope"))).toBe(false);
      return rows[0];
    }).mockResolvedValueOnce("Done");
    ui.input.mockResolvedValueOnce(undefined);
    const config = options([item]);
    await openRpcFabricSettings({ ui }, config);
    expect(config.persist).not.toHaveBeenCalled();
    expect(config.setScope).not.toHaveBeenCalled();
    expect(item.currentValue).toBe("0");
  });
});
