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

describe("ApprovalController", () => {
  it("fails closed when approval is required without a UI", async () => {
    const controller = new ApprovalController(policies, { hasUI: false } as ExtensionContext);
    await expect(controller.approve(action)).rejects.toThrow("no interactive UI");
  });

  it("asks once per risk class during an execution", async () => {
    const confirm = vi.fn(async () => true);
    const controller = new ApprovalController(policies, {
      hasUI: true,
      ui: { confirm },
    } as unknown as ExtensionContext);
    await controller.approve(action);
    await controller.approve({ ...action, ref: "demo.writeAgain" });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("denies actions blocked by policy", async () => {
    const controller = new ApprovalController(policies, { hasUI: true } as ExtensionContext);
    await expect(controller.approve({ ...action, risk: "execute" })).rejects.toThrow(
      "denied by the Fabric execute policy",
    );
  });
});
