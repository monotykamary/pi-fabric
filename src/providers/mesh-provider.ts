import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { MeshStore, type MeshIdentity } from "../mesh/store.js";

const emptySchema = { type: "object", properties: {}, additionalProperties: false };

const descriptors: FabricActionDescriptor[] = [
  {
    name: "self",
    description: "Return this Fabric participant's mesh identity",
    inputSchema: emptySchema,
    risk: "read",
    namespace: "coordination",
  },
  {
    name: "publish",
    description: "Append a durable event to a mesh topic, optionally addressed to one actor",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        kind: { type: "string" },
        to: { type: "string" },
        text: { type: "string" },
        data: {},
      },
      required: ["topic"],
      additionalProperties: false,
    },
    risk: "agent",
    namespace: "coordination",
  },
  {
    name: "read",
    description: "Read durable mesh events after a sequence cursor",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "number", minimum: 0 },
        topic: { type: "string" },
        to: { type: "string" },
        limit: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
    risk: "read",
    namespace: "coordination",
  },
  {
    name: "members",
    description: "List persistent actor presence records visible in this project mesh",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1 } },
      additionalProperties: false,
    },
    risk: "read",
    namespace: "coordination",
  },
  {
    name: "get",
    description: "Read a versioned value from shared mesh state",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    risk: "read",
    namespace: "coordination",
  },
  {
    name: "list",
    description: "List shared mesh state by key prefix",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string" },
        limit: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
    risk: "read",
    namespace: "coordination",
  },
  {
    name: "put",
    description: "Write shared mesh state, optionally with compare-and-swap version checking",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: {},
        ifVersion: { type: "number", minimum: 0 },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
    risk: "agent",
    namespace: "coordination",
  },
  {
    name: "delete",
    description: "Delete shared mesh state, optionally with compare-and-swap version checking",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        ifVersion: { type: "number", minimum: 0 },
      },
      required: ["key"],
      additionalProperties: false,
    },
    risk: "agent",
    namespace: "coordination",
  },
];

export class MeshProvider implements FabricProvider {
  readonly name = "mesh";
  readonly description =
    "Durable topics and compare-and-swap shared state for emergent agent coordination";

  constructor(
    readonly store: MeshStore,
    readonly identity: MeshIdentity,
  ) {}

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
    _context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "self":
        return this.identity;
      case "publish":
        return this.store.publish({
          topic: String(args.topic),
          from: this.identity,
          ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
          ...(typeof args.to === "string" ? { to: args.to } : {}),
          ...(typeof args.text === "string" ? { text: args.text } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
        });
      case "read":
        return this.store.read({
          ...(typeof args.after === "number" ? { after: args.after } : {}),
          ...(typeof args.topic === "string" ? { topic: args.topic } : {}),
          ...(typeof args.to === "string" ? { to: args.to } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
      case "members":
        return this.store.list("actors/", typeof args.limit === "number" ? args.limit : 100);
      case "get":
        return this.store.get(String(args.key)) ?? null;
      case "list":
        return this.store.list(
          typeof args.prefix === "string" ? args.prefix : "",
          typeof args.limit === "number" ? args.limit : 100,
        );
      case "put":
        return this.store.put({
          key: String(args.key),
          value: args.value,
          identity: this.identity,
          ...(typeof args.ifVersion === "number" ? { ifVersion: args.ifVersion } : {}),
        });
      case "delete":
        return this.store.delete({
          key: String(args.key),
          ...(typeof args.ifVersion === "number" ? { ifVersion: args.ifVersion } : {}),
        });
      default:
        throw new Error(`Unknown mesh action: ${actionName}`);
    }
  }
}
