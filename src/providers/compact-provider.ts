import { CompactController } from "../core/compact-controller.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";

// Fabric provider exposing the host-session compaction controller to
// `fabric_exec`. Compaction is advisory-then-committed: `request` only records
// an intent the host commits at the next `agent_settled` boundary; the model
// cannot compact the running context directly. Always available (no config
// guard) — it is a first-principles primitive, not an optional capability.

const requestSchema = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description: "Short human-readable reason for the compaction",
    },
    instructions: {
      type: "string",
      description: "Custom compaction instructions forwarded to Pi core",
    },
    requestedBy: {
      type: "string",
      description: "Who requested the compaction (default: model)",
    },
  },
  additionalProperties: false,
};

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const descriptors: FabricActionDescriptor[] = [
  {
    name: "request",
    description:
      "Request an advisory compaction of the host session's context at the next safe boundary (agent_settled). The host commits it only between turns, never mid-turn. A new request replaces any pending one.",
    inputSchema: requestSchema,
    risk: "write",
  },
  {
    name: "status",
    description:
      "Read the pending compaction intent and the last committed/failed compaction info",
    inputSchema: emptySchema,
    risk: "read",
  },
  {
    name: "cancel",
    description: "Clear a pending compaction intent before the host commits it",
    inputSchema: emptySchema,
    risk: "read",
  },
];

export class CompactProvider implements FabricProvider {
  readonly name = "compact";
  readonly description =
    "Programmatic, advisory-then-committed context compaction for the host Pi session";

  constructor(readonly controller: CompactController) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "request": {
        const intent = this.controller.request({
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
          ...(typeof args.instructions === "string" ? { instructions: args.instructions } : {}),
          ...(typeof args.requestedBy === "string" ? { requestedBy: args.requestedBy } : {}),
        });
        context.activity?.({
          type: "entity",
          id: "host-compact",
          kind: "custom",
          name: "Context compaction",
        });
        context.activity?.({
          type: "progress",
          message: intent.reason
            ? `Compaction requested: ${intent.reason}`
            : "Compaction requested (advisory; commits at next agent_settled)",
        });
        return { requested: true, intent };
      }
      case "status":
        return this.controller.status();
      case "cancel":
        this.controller.cancel();
        context.activity?.({ type: "progress", message: "Compaction request cancelled" });
        return { cancelled: true };
      default:
        throw new Error(`Unknown compact action: ${actionName}`);
    }
  }
}
