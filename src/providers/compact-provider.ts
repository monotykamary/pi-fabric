import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  compactionRequestBoundsError,
  encodeCompactionRequest,
  MAX_COMPACTION_INSTRUCTIONS_CHARS,
  MAX_PRESERVE_ITEM_CHARS,
  MAX_PRESERVE_ITEMS,
} from "../compaction/instructions.js";
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

const requestSchema = Type.Object({
  reason: Type.Optional(Type.String({
    maxLength: 1024,
    description: "Short human-readable reason for the compaction",
  })),
  instructions: Type.Optional(Type.String({
    maxLength: MAX_COMPACTION_INSTRUCTIONS_CHARS,
    description: "Custom compaction instructions forwarded to Pi core",
  })),
  preserve: Type.Optional(Type.Array(
    Type.String({ maxLength: MAX_PRESERVE_ITEM_CHARS }),
    {
      maxItems: MAX_PRESERVE_ITEMS,
      description: "Explicit bounded facts to preserve, encoded as a typed Fabric compaction request",
    },
  )),
  requestedBy: Type.Optional(Type.String({
    maxLength: 256,
    description: "Who requested the compaction (default: model)",
  })),
}, { additionalProperties: false });

interface CompactRequestArguments {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy?: string;
}

const checkedRequestArguments = (args: Record<string, unknown>): CompactRequestArguments => {
  if (!Value.Check(requestSchema, args)) {
    const message = [...Value.Errors(requestSchema, args)]
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
    throw new Error(`Invalid compact.request arguments: ${message}`);
  }
  const input = args as CompactRequestArguments;
  const boundsError = compactionRequestBoundsError({
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.preserve !== undefined ? { preserve: input.preserve } : {}),
  });
  if (boundsError) throw new Error(`Invalid compact.request arguments: ${boundsError.message}`);
  if (input.preserve !== undefined) {
    encodeCompactionRequest({
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      preserve: input.preserve,
    });
  }
  return input;
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
    inputSchema: requestSchema as unknown as Record<string, unknown>,
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
        const input = checkedRequestArguments(args);
        const intent = this.controller.request({
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.preserve !== undefined ? { preserve: input.preserve } : {}),
          ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy } : {}),
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
