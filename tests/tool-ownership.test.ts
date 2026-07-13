import { describe, expect, it, vi } from "vitest";
import { FabricToolOwnership } from "../src/core/tool-ownership.js";

const hostWith = (initial: string[]) => {
  let active = [...initial];
  const setActiveTools = vi.fn((names: string[]) => {
    active = [...names];
  });
  return {
    host: {
      getActiveTools: () => [...active],
      setActiveTools,
    },
    active: () => active,
    setActiveTools,
  };
};

describe("FabricToolOwnership", () => {
  it("gives Fabric exclusive ownership of active Pi core tools", () => {
    const state = hostWith(["read", "bash", "grep", "custom_tool"]);
    const ownership = new FabricToolOwnership(state.host);

    expect(ownership.apply(true)).toBe(true);
    expect(state.active()).toEqual(["custom_tool", "fabric_exec"]);
    expect(state.setActiveTools).toHaveBeenCalledOnce();

    expect(ownership.apply(true)).toBe(false);
    expect(state.setActiveTools).toHaveBeenCalledOnce();
  });

  it("restores only the native core tools that were active before full mode", () => {
    const state = hostWith(["read", "find", "custom_tool"]);
    const ownership = new FabricToolOwnership(state.host);

    ownership.apply(true);
    expect(state.active()).toEqual(["custom_tool", "fabric_exec"]);
    expect(ownership.apply(false)).toBe(true);
    expect(state.active()).toEqual(["read", "find", "custom_tool", "fabric_exec"]);
    expect(state.active()).not.toContain("bash");
  });

  it("removes core tools re-enabled while full mode remains active", () => {
    const state = hostWith(["read", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    ownership.apply(true);
    state.host.setActiveTools(["fabric_exec", "read", "ls"]);
    expect(ownership.apply(true)).toBe(true);
    expect(state.active()).toEqual(["fabric_exec"]);

    ownership.release();
    expect(state.active()).toEqual(["read", "fabric_exec"]);
  });

  it("does not alter native tools in orchestration-only mode", () => {
    const state = hostWith(["read", "bash", "fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);

    expect(ownership.apply(false)).toBe(false);
    expect(state.active()).toEqual(["read", "bash", "fabric_exec"]);
    expect(state.setActiveTools).not.toHaveBeenCalled();
  });
});
