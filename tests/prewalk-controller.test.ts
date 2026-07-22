import { describe, expect, it } from "vitest";
import type { FabricCallAudit } from "../src/core/action-registry.js";
import { PrewalkController } from "../src/prewalk/controller.js";

const audit = (
  ref: string,
  success: boolean,
  sequence = 1,
): FabricCallAudit => ({
  ref,
  nestedToolCallId: `call-${sequence}`,
  startedAt: sequence,
  endedAt: sequence + 1,
  success,
});

describe("PrewalkController", () => {
  it("arms a one-shot executor and captures the next task when omitted", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.isArmed("session-1")).toBe(true);
    controller.observeTask("session-1", "  Implement the guard  ");
    controller.observeTask("session-1", "Do not replace the first task");

    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement the guard",
    });
  });

  it("disarms an observed task when it settles without a mutation", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.settleTask("session-1")).toBe(false);
    controller.observeTask("session-1", "Inspect without changing anything");
    expect(controller.settleTask("session-2")).toBe(false);
    expect(controller.settleTask("session-1")).toBe(true);
    expect(controller.status()).toEqual({ state: "idle" });
  });

  it("re-arms without leaking the previous task when always re-arm is enabled", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Inspect without changing anything",
      alwaysRearm: true,
    });

    expect(controller.settleTask("session-1")).toBe(true);
    expect(controller.status()).toMatchObject({
      state: "armed",
      model: "anthropic/executor",
      sessionId: "session-1",
      alwaysRearm: true,
    });
    expect(controller.status()).not.toHaveProperty("task");

    controller.observeTask("session-1", "Implement the next task");
    expect(controller.status()).toMatchObject({ task: "Implement the next task" });
  });

  it("claims only the first successful recognized mutation", () => {
    const controller = new PrewalkController();
    controller.arm({
      model: "anthropic/executor",
      sessionId: "session-1",
      task: "Implement",
    });

    expect(
      controller.claim(
        [audit("pi.read", true), audit("pi.edit", false, 2)],
        "session-1",
      ),
    ).toBeUndefined();
    const claim = controller.claim(
      [audit("pi.read", true), audit("pi.write", true, 2)],
      "session-1",
    );

    expect(claim).toMatchObject({
      arm: { model: "anthropic/executor", task: "Implement" },
      mutation: { ref: "pi.write", success: true },
    });
    expect(controller.status()).toMatchObject({ state: "handing_off" });
    expect(controller.claim([audit("schema.commit", true)], "session-1")).toBeUndefined();
  });

  it("does not cross session boundaries", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(controller.claim([audit("pi.edit", true)], "session-2")).toBeUndefined();
    expect(controller.isArmed("session-1")).toBe(true);
  });

  it("disarms when the program already performed an explicit handoff", () => {
    const controller = new PrewalkController();
    controller.arm({ model: "anthropic/executor", sessionId: "session-1" });

    expect(
      controller.claim(
        [audit("pi.edit", true), audit("agents.handoff", true, 2)],
        "session-1",
      ),
    ).toBeUndefined();
    expect(controller.status()).toEqual({ state: "idle" });
  });
});
