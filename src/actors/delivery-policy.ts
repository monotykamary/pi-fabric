import type { FabricActorDelivery } from "./types.js";

const ACTIVE_DELIVERIES = new Set<FabricActorDelivery>(["steer", "followUp"]);
const PASSIVE_DELIVERIES = new Set<FabricActorDelivery>(["mailbox", "nextTurn"]);

export interface FabricActorDeliveryPolicy {
  delivery: FabricActorDelivery;
  triggerTurn: boolean;
}

export const resolveActorDeliveryPolicy = (
  delivery: FabricActorDelivery | undefined,
  triggerTurn: boolean | undefined,
): FabricActorDeliveryPolicy => {
  const resolvedDelivery = delivery ?? "mailbox";
  if (!ACTIVE_DELIVERIES.has(resolvedDelivery) && !PASSIVE_DELIVERIES.has(resolvedDelivery)) {
    throw new Error(`Invalid Fabric actor delivery: ${String(delivery)}`);
  }
  if (ACTIVE_DELIVERIES.has(resolvedDelivery)) {
    if (typeof triggerTurn !== "boolean") {
      throw new Error(
        `Actor delivery "${resolvedDelivery}" requires explicit triggerTurn: true or false`,
      );
    }
    return { delivery: resolvedDelivery, triggerTurn };
  }
  if (triggerTurn === true) {
    throw new Error(
      `Actor delivery "${resolvedDelivery}" cannot use triggerTurn: true because it never starts Main`,
    );
  }
  return { delivery: resolvedDelivery, triggerTurn: false };
};

export const actorDeliveryNotice = (
  delivery: Exclude<FabricActorDelivery, "mailbox">,
  triggerTurn: boolean,
): string | undefined => {
  if (delivery === "nextTurn") {
    return "[Deferred actor delivery: queued for the next user turn; this message never starts Main.]";
  }
  if (!triggerTurn) {
    return "[Passive actor delivery: triggerTurn=false; this message does not start Main when idle.]";
  }
  return undefined;
};
