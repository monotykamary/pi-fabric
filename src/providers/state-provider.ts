import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import type { MeshIdentity, MeshStore } from "../mesh/store.js";
import { StateStore, type StateTransitionKind } from "../state/store.js";

const STATE_ENTITY_ID = "fabric-state";

const transitionSchema = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description: "Name of this transition (the move), e.g. \"applied auth patch\"",
    },
    from: {
      type: "string",
      description:
        "State label this transition moves from. Must equal the current head's to-label when a head exists; rejected on mismatch unless force is set.",
    },
    to: {
      type: "string",
      description: "Resulting state label (the new world-model version)",
    },
    summary: { type: "string", description: "Short human-readable claim this transition asserts" },
    evidence: {
      type: "array",
      items: { type: "string" },
      description:
        "Shell commands that grounded this belief. state.verify re-runs them; exit 0 is confirmed, non-zero is violated.",
    },
    tags: { type: "array", items: { type: "string" } },
    kind: {
      type: "string",
      enum: ["state", "representation"],
      description:
        "Default \"state\". \"representation\" marks a Schema-style revision of the world model itself.",
    },
    force: {
      type: "boolean",
      description: "Override the from-mismatch and contention guards.",
    },
  },
  required: ["label", "to", "summary"],
  additionalProperties: false,
};

const verifySchema = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: { type: "string" },
      description:
        "Verify transitions matching these labels (by transition.label, from, or to). Omit to verify the current head.",
    },
    timeoutMs: { type: "number", minimum: 1, description: "Per-command timeout (default 30s)" },
  },
  additionalProperties: false,
};

const historySchema = {
  type: "object",
  properties: {
    label: { type: "string", description: "Filter transitions by label, from, or to" },
    limit: { type: "number", minimum: 1 },
  },
  additionalProperties: false,
};

const goalSchema = {
  type: "object",
  properties: {
    check: {
      type: "string",
      description: "Executable shell predicate; exit 0 means the goal is met.",
    },
    description: { type: "string" },
  },
  required: ["check"],
  additionalProperties: false,
};

const checkGoalSchema = {
  type: "object",
  properties: { timeoutMs: { type: "number", minimum: 1 } },
  additionalProperties: false,
};

const emptySchema = { type: "object", properties: {}, additionalProperties: false };

const descriptors: FabricActionDescriptor[] = [
  {
    name: "transition",
    description:
      "Append a labeled, validated state transition and compare-and-swap advance the head",
    inputSchema: transitionSchema,
    risk: "write",
    namespace: "state",
  },
  {
    name: "get",
    description: "Return the current state head, goal, and recent labels",
    inputSchema: emptySchema,
    risk: "read",
    namespace: "state",
  },
  {
    name: "history",
    description: "Fold the transition log into an ordered label graph with optional label filter",
    inputSchema: historySchema,
    risk: "read",
    namespace: "state",
  },
  {
    name: "verify",
    description:
      "Re-run evidence commands for the current head (or given labels); publishes a state.violated event on any violation",
    inputSchema: verifySchema,
    risk: "execute",
    namespace: "state",
  },
  {
    name: "goal",
    description: "Set the executable goal predicate (Schema's is_goal)",
    inputSchema: goalSchema,
    risk: "write",
    namespace: "state",
  },
  {
    name: "checkGoal",
    description: "Run the goal predicate and report pass/fail; publishes state.goal.met when it passes",
    inputSchema: checkGoalSchema,
    risk: "execute",
    namespace: "state",
  },
];

export class StateProvider implements FabricProvider {
  readonly name = "state";
  readonly description =
    "Schema-style labeled transition layer: an append-only timeline of validated transitions with a compare-and-swap head and evidence-based certification over mesh storage";

  readonly #store: StateStore;
  readonly #identity: MeshIdentity;

  constructor(store: MeshStore, identity: MeshIdentity) {
    this.#store = new StateStore(store);
    this.#identity = identity;
  }

  get state(): StateStore {
    return this.#store;
  }

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
      case "transition": {
        const label = String(args.label);
        const to = String(args.to);
        const summary = String(args.summary);
        const from = typeof args.from === "string" ? args.from : undefined;
        const evidence = Array.isArray(args.evidence)
          ? args.evidence.filter((item): item is string => typeof item === "string")
          : undefined;
        const tags = Array.isArray(args.tags)
          ? args.tags.filter((item): item is string => typeof item === "string")
          : undefined;
        const kind: StateTransitionKind | undefined =
          args.kind === "representation" || args.kind === "state" ? args.kind : undefined;
        const force = args.force === true;
        const { event, head } = await this.#store.transition(
          {
            label,
            ...(from !== undefined ? { from } : {}),
            to,
            summary,
            ...(evidence ? { evidence } : {}),
            ...(tags ? { tags } : {}),
            ...(kind ? { kind } : {}),
            force,
          },
          this.#identity,
        );
        context.activity?.({
          type: "entity",
          id: STATE_ENTITY_ID,
          kind: "mesh",
          name: `${label} → ${to}`,
        });
        context.update(`State transitioned to "${to}" via "${label}"`);
        return { event, head };
      }
      case "get": {
        const { head, goal } = this.#store.get();
        const { labels } = this.#store.history({ limit: 20 });
        return { head, goal, recentLabels: labels };
      }
      case "history": {
        const label = typeof args.label === "string" ? args.label : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        return this.#store.history({
          ...(label !== undefined ? { label } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      }
      case "verify": {
        const labels = Array.isArray(args.labels)
          ? args.labels.filter((item): item is string => typeof item === "string")
          : undefined;
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        context.activity?.({
          type: "entity",
          id: STATE_ENTITY_ID,
          kind: "mesh",
          name: "verify",
        });
        const result = await this.#store.verify({
          ...(labels ? { labels } : {}),
          cwd: context.cwd,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          identity: this.#identity,
        });
        context.update(
          result.violated
            ? "State verification found violations"
            : `State verification: ${result.results.length} evidence command(s) confirmed`,
        );
        return result;
      }
      case "goal": {
        const check = String(args.check);
        const description = typeof args.description === "string" ? args.description : undefined;
        const entry = await this.#store.goal(
          { check, ...(description !== undefined ? { description } : {}) },
          this.#identity,
        );
        context.activity?.({
          type: "entity",
          id: STATE_ENTITY_ID,
          kind: "mesh",
          name: "goal",
        });
        return entry;
      }
      case "checkGoal": {
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        const result = await this.#store.checkGoal({
          cwd: context.cwd,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          identity: this.#identity,
        });
        context.update(
          result.passed ? "Goal met" : "Goal not met",
        );
        return result;
      }
      default:
        throw new Error(`Unknown state action: ${actionName}`);
    }
  }
}
