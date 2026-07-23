import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ApprovalController } from "../src/core/approval-controller.js";
import type { ResolvedFabricAction } from "../src/core/action-registry.js";

const action: ResolvedFabricAction = {
  ref: "demo.write",
  provider: "demo",
  name: "write",
  description: "Write data",
  inputSchema: {},
  risk: "write",
};

const policies = {
  read: "allow" as const,
  write: "ask" as const,
  execute: "deny" as const,
  network: "ask" as const,
  agent: "ask" as const,
};

const tuiContext = (
  custom: (...args: unknown[]) => Promise<unknown>,
  notify = vi.fn(),
): ExtensionContext => ({
  hasUI: true,
  mode: "tui",
  ui: { custom, notify },
} as unknown as ExtensionContext);

describe("ApprovalController", () => {
  it("fails closed when approval is required without a UI", async () => {
    const controller = new ApprovalController(policies, { hasUI: false } as ExtensionContext);
    await expect(controller.approve(action)).rejects.toThrow("no interactive UI");
  });

  it("notifies and shows the TUI permission wizard once per risk class", async () => {
    const custom = vi.fn(async () => "allow");
    const notify = vi.fn();
    const controller = new ApprovalController(policies, tuiContext(custom, notify));

    await controller.approve(action);
    await controller.approve({ ...action, ref: "demo.writeAgain" });

    expect(custom).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenNthCalledWith(
      1,
      "Fabric permission requested: demo.write needs write access",
      "warning",
    );
    expect(notify).toHaveBeenNthCalledWith(
      2,
      "Allowed write access for the current Fabric execution",
      "info",
    );
  });

  it("uses an RPC-compatible select dialog", async () => {
    const select = vi.fn(async () => "Allow write access");
    const notify = vi.fn();
    const controller = new ApprovalController(policies, {
      hasUI: true,
      mode: "rpc",
      ui: { select, notify },
    } as unknown as ExtensionContext);

    await controller.approve(action);

    expect(select).toHaveBeenCalledWith(
      "Pi Fabric permission · demo.write requests write access. Write data",
      ["Allow write access", "Deny"],
    );
  });

  it("fails closed and notifies when the user denies or dismisses", async () => {
    const custom = vi.fn(async () => "deny");
    const notify = vi.fn();
    const controller = new ApprovalController(policies, tuiContext(custom, notify));

    await expect(controller.approve(action)).rejects.toThrow(
      "User denied write access for demo.write",
    );
    expect(notify).toHaveBeenLastCalledWith(
      "Denied write access for demo.write",
      "warning",
    );
  });

  it("coalesces concurrent approval requests for workflow fan-out", async () => {
    let release: (() => void) | undefined;
    const custom = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("allow");
        }),
    );
    const controller = new ApprovalController(policies, tuiContext(custom));
    const approvals = Promise.all([
      controller.approve(action),
      controller.approve({ ...action, ref: "demo.parallelWrite" }),
    ]);
    expect(custom).toHaveBeenCalledOnce();
    release?.();
    await approvals;
  });

  it("denies actions blocked by policy without prompting", async () => {
    const custom = vi.fn(async () => "allow");
    const controller = new ApprovalController(policies, tuiContext(custom));
    await expect(controller.approve({ ...action, risk: "execute" })).rejects.toThrow(
      "denied by the Fabric execute policy",
    );
    expect(custom).not.toHaveBeenCalled();
  });
});
