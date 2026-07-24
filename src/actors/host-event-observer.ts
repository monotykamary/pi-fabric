import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  FABRIC_ACTOR_PI_HOST_EVENTS,
  type FabricActorPiHostEvent,
} from "./types.js";

export type FabricActorHostEventObserver = (
  eventName: FabricActorPiHostEvent,
  event: ExtensionEvent,
  context: ExtensionContext,
) => void;

interface ObservableExtensionApi {
  on(
    event: FabricActorPiHostEvent,
    handler: (event: ExtensionEvent, context: ExtensionContext) => void,
  ): void;
}

export const registerFabricActorHostEventObservers = (
  pi: ExtensionAPI,
  observer: FabricActorHostEventObserver,
): void => {
  const observable = pi as unknown as ObservableExtensionApi;
  for (const eventName of FABRIC_ACTOR_PI_HOST_EVENTS) {
    observable.on(eventName, (event, context) => observer(eventName, event, context));
  }
};
