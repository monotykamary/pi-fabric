import { describe, expect, it } from "vitest";
import {
  actorDeliveryNotice,
  resolveActorDeliveryPolicy,
} from "../src/actors/delivery-policy.js";

describe("actor delivery policy", () => {
  it("makes active turn intent explicit", () => {
    expect(() => resolveActorDeliveryPolicy("steer", undefined)).toThrow(
      /requires explicit triggerTurn/,
    );
    expect(resolveActorDeliveryPolicy("steer", false)).toEqual({
      delivery: "steer",
      triggerTurn: false,
    });
    expect(resolveActorDeliveryPolicy("followUp", true)).toEqual({
      delivery: "followUp",
      triggerTurn: true,
    });
  });

  it("rejects trigger intent for delivery modes that never start Main", () => {
    expect(resolveActorDeliveryPolicy(undefined, undefined)).toEqual({
      delivery: "mailbox",
      triggerTurn: false,
    });
    expect(() => resolveActorDeliveryPolicy("mailbox", true)).toThrow(/never starts Main/);
    expect(() => resolveActorDeliveryPolicy("nextTurn", true)).toThrow(/never starts Main/);
  });

  it("labels passive and deferred deliveries without labeling active continuations", () => {
    expect(actorDeliveryNotice("steer", false)).toContain("does not start Main when idle");
    expect(actorDeliveryNotice("followUp", false)).toContain("triggerTurn=false");
    expect(actorDeliveryNotice("nextTurn", false)).toContain("next user turn");
    expect(actorDeliveryNotice("steer", true)).toBeUndefined();
  });
});
