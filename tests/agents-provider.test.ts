import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentDeliveryRequest } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type { FabricPeerInfo } from "../src/peer-session.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { SubagentManager } from "../src/subagents/manager.js";

const roots: string[] = [];
const actorManagers: ActorManager[] = [];
const subagentManagers: SubagentManager[] = [];

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
  activity() {},
};

const setup = (peers: FabricPeerInfo[] = []) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-agents-provider-"));
  roots.push(root);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const subagents = new SubagentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.subagents, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    claudeBinary: path.resolve("tests/fixtures/fake-claude.mjs"),
    runRoot: path.join(root, "runs"),
  });
  subagentManagers.push(subagents);
  const identity: MeshIdentity = {
    id: "session:test",
    name: "main",
    kind: "main",
    sessionId: "test",
  };
  const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
  const mainDeliveries: FabricMainAgentDeliveryRequest[] = [];
  const mainAgent = {
    id: identity.id,
    local: true,
    matches: (id: string) => id === "main" || id === identity.id,
    info: () => ({
      id: identity.id,
      name: "Main" as const,
      kind: "main" as const,
      status: "idle" as const,
      runner: "pi" as const,
      transport: "host" as const,
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    }),
    deliverAgent: (request: FabricMainAgentDeliveryRequest) => {
      mainDeliveries.push(request);
      return {
        queued: true as const,
        messageId: `main-message-${mainDeliveries.length}`,
        routed: "main" as const,
      };
    },
  };
  const actors = new ActorManager("test", identity, mesh, meshConfig, subagents, () => {}, {
    actorRoot: path.join(root, "actors"),
    persistent: true,
    mainAgent,
  });
  actorManagers.push(actors);
  const globalActors = new GlobalActorRegistry(root, 64 * 1024);
  const provider = new AgentsProvider(
    subagents,
    actors,
    globalActors,
    mainAgent,
    undefined,
    { list: () => peers },
  );
  return { root, actors, globalActors, provider, mainDeliveries };
};

afterEach(async () => {
  await Promise.all(actorManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(subagentManagers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for actor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const createRequest = {
  name: "reviewer",
  instructions: "Review code for security defects and reply concisely.",
  events: ["turn_end"],
  delivery: "steer",
  responseMode: "directive",
  triggerTurn: false,
};

describe("AgentsProvider runner support", () => {
  it("lists live peer sessions separately from Main", async () => {
    const peer: FabricPeerInfo = {
      id: "session:peer",
      name: "Peer peer",
      kind: "peer",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: process.cwd(),
      sessionId: "peer",
      startedAt: 1,
      updatedAt: 2,
      pendingMessages: false,
      local: false,
    };
    const { provider } = setup([peer]);

    await expect(provider.invoke("peers", {}, context)).resolves.toEqual([peer]);
    expect((await provider.describe("peers", context))?.risk).toBe("read");
  });

  it("attaches a structured child-tool preview to blocking agent runs", async () => {
    const { provider } = setup();
    const previews: unknown[] = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview);
      },
    };

    await provider.invoke(
      "run",
      { task: "return a short result", name: "preview-agent", transport: "process" },
      previewContext,
    );

    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      name: "preview-agent",
      status: "completed",
      runner: "pi",
      owner: "agent",
      text: "fake worker complete",
      tools: expect.any(Array),
    });
  });

  it("attaches previews and reports friendly names while waiting for spawned agents", async () => {
    const { provider } = setup();
    const updates: string[] = [];
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      update(message) {
        updates.push(message);
      },
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };
    const handle = await provider.invoke(
      "spawn",
      { task: "return a short result", name: "wait-preview-agent", transport: "process" },
      previewContext,
    ) as { id: string; name: string };

    await provider.invoke("wait", { id: handle.id }, previewContext);

    expect(updates.some((message) => message.startsWith("Agent wait-preview-agent:"))).toBe(true);
    expect(updates.join("\n")).not.toContain(handle.id.slice(0, 8));
    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      id: handle.id,
      name: "wait-preview-agent",
      status: "completed",
      owner: "agent",
    });
  });

  it("attaches the final preview for actors that settle before the first poll", async () => {
    const { provider } = setup();
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };

    await provider.invoke("ask", { id: actor.id, message: "inspect quickly" }, previewContext);

    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      status: "completed",
      owner: "actor",
      tools: expect.any(Array),
    });
  });

  it("ignores actor timeout overrides below the configured default", async () => {
    const { provider, actors } = setup();
    const inherited = (await provider.invoke(
      "create",
      { ...createRequest, name: "inherited-timeout", timeoutMs: 240_000 },
      context,
    )) as { id: string };
    const longer = (await provider.invoke(
      "create",
      { ...createRequest, name: "longer-timeout", timeoutMs: 7_200_000 },
      context,
    )) as { id: string };

    expect(actors.definition(inherited.id)).not.toHaveProperty("timeoutMs");
    expect(actors.definition(longer.id).timeoutMs).toBe(7_200_000);
  });

  it("enumerates Claude models and preserves runner on actors", async () => {
    const { provider } = setup();
    const models = (await provider.invoke("models", { runner: "claude" }, context)) as Array<{
      runner: string;
      key: string;
      resolvedModel: string;
    }>;
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runner: "claude",
          key: "claude/haiku",
          resolvedModel: "claude-haiku-test",
        }),
      ]),
    );

    const actor = (await provider.invoke(
      "create",
      {
        name: "claude-reviewer",
        instructions: "Review messages.",
        runner: "claude",
      },
      context,
    )) as { runner: string };
    expect(actor.runner).toBe("claude");
  });
});

describe("AgentsProvider global actors", () => {
  it("creates a global template and lists it separately from project actors", async () => {
    const { provider, actors, globalActors } = setup();
    const template = await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    expect((template as { name: string }).name).toBe("reviewer");
    expect(globalActors.list()).toHaveLength(1);
    // project scope (default) lists live actors, not templates
    expect(await provider.invoke("actors", {}, context)).toEqual([]);
    expect(await provider.invoke("actors", { scope: "global" }, context)).toHaveLength(1);
    expect(actors.list()).toEqual([]);
  });

  it("imports a global template as a fresh live actor without history", async () => {
    const { provider, actors } = setup();
    await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    const actor = (await provider.invoke("import", { name: "reviewer" }, context)) as {
      id: string;
      name: string;
      messages: number;
    };
    expect(actor.name).toBe("reviewer");
    expect(actors.list()).toHaveLength(1);
    // fresh actor starts with no mailbox history
    expect(actor.messages).toBe(0);
    expect(actors.instructions(actor.id)).toBe(createRequest.instructions);
  });

  it("exports a project actor to a global template without its history", async () => {
    const { provider, actors, globalActors } = setup();
    const actor = (await provider.invoke(
      "create",
      { ...createRequest, extensions: false, tools: ["read"] },
      context,
    )) as { id: string };
    // build some mailbox history so we can prove it is not exported
    await provider.invoke("ask", { id: actor.id, message: "inspect auth" }, context);
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id).messages).toBeGreaterThan(0);

    const template = (await provider.invoke("export", { id: actor.id }, context)) as {
      name: string;
      instructions: string;
    };
    expect(template.name).toBe("reviewer");
    expect(template.instructions).toBe(createRequest.instructions);
    expect(globalActors.list()).toHaveLength(1);
    // a template carries no history at all
    const stored = globalActors.resolve("reviewer")!;
    expect(stored).not.toHaveProperty("messages");
    expect(stored).not.toHaveProperty("sessionFile");
    expect(stored.extensions).toBe(false);

    // re-importing yields a fresh actor with no inherited history
    const fresh = (await provider.invoke("import", { name: "reviewer", as: "reviewer-2" }, context)) as {
      messages: number;
      extensions?: boolean;
    };
    expect(fresh.messages).toBe(0);
    expect(fresh.extensions).toBe(false);
  });

  it("export collides without overwrite and replaces with it", async () => {
    const { provider } = setup();
    await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await expect(provider.invoke("export", { id: actor.id }, context)).rejects.toThrow(/already exists/);
    const replaced = (await provider.invoke("export", { id: actor.id, overwrite: true }, context)) as {
      name: string;
    };
    expect(replaced.name).toBe("reviewer");
  });

  it("updates tool allowlists for project actors and global templates", async () => {
    const { provider, actors, globalActors } = setup();
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke("setTools", { id: actor.id, tools: ["read", "grep"] }, context);
    expect(actors.status(actor.id).tools).toEqual(["read", "grep"]);

    await provider.invoke("create", { ...createRequest, name: "templar", scope: "global" }, context);
    const templateId = globalActors.resolve("templar")!.id;
    await provider.invoke(
      "setTools",
      { id: templateId, tools: [], scope: "global" },
      context,
    );
    expect(globalActors.resolve("templar")!.tools).toEqual([]);
  });


  it("validates and updates delivery policies for project actors and global templates", async () => {
    const { provider, actors, globalActors } = setup();
    const { triggerTurn: _triggerTurn, ...ambiguous } = createRequest;
    await expect(provider.invoke("create", ambiguous, context)).rejects.toThrow(
      /requires explicit triggerTurn/,
    );

    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke(
      "setDeliveryPolicy",
      { id: actor.id, delivery: "steer", triggerTurn: true },
      context,
    );
    expect(actors.status(actor.id)).toMatchObject({ delivery: "steer", triggerTurn: true });

    await provider.invoke(
      "create",
      { ...createRequest, name: "templar", scope: "global" },
      context,
    );
    const templateId = globalActors.resolve("templar")!.id;
    await provider.invoke(
      "setDeliveryPolicy",
      { id: templateId, delivery: "followUp", triggerTurn: true, scope: "global" },
      context,
    );
    expect(globalActors.resolve(templateId)).toMatchObject({
      delivery: "followUp",
      triggerTurn: true,
    });
  });

  it("edits instructions for project and global scopes", async () => {
    const { provider, actors, globalActors } = setup();
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke("setInstructions", { id: actor.id, instructions: "Be brief." }, context);
    expect(actors.instructions(actor.id)).toBe("Be brief.");

    await provider.invoke("create", { ...createRequest, name: "templar", scope: "global" }, context);
    const globalId = globalActors.resolve("templar")!.id;
    await provider.invoke("setInstructions", { id: globalId, instructions: "Template brief.", scope: "global" }, context);
    expect(globalActors.resolve("templar")!.instructions).toBe("Template brief.");
  });

  it("removes a global template via scoped remove", async () => {
    const { provider, globalActors } = setup();
    const template = (await provider.invoke(
      "create",
      { ...createRequest, scope: "global" },
      context,
    )) as { id: string };
    await provider.invoke("remove", { id: template.id, scope: "global" }, context);
    expect(globalActors.list()).toEqual([]);
  });
});

describe("AgentsProvider steering", () => {
  const readSteerFile = (root: string, id: string): Array<Record<string, unknown>> => {
    const file = path.join(root, "runs", id, "steer.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("discovers and addresses the root Main agent through its stable alias", async () => {
    const { provider, mainDeliveries } = setup();

    await expect(provider.invoke("main", {}, context)).resolves.toMatchObject({
      id: "session:test",
      name: "Main",
      kind: "main",
      local: true,
    });
    await expect(
      provider.invoke("status", { id: "main" }, context),
    ).resolves.toMatchObject({ id: "session:test", name: "Main" });

    const steer = await provider.invoke(
      "steer",
      { id: "main", message: "prioritize the failing test", data: { source: "supervisor" } },
      context,
    );
    const followUp = await provider.invoke(
      "followUp",
      { id: "session:test", message: "then summarize the fix" },
      context,
    );

    expect(steer).toEqual({
      queued: true,
      messageId: "main-message-1",
      routed: "main",
    });
    expect(followUp).toEqual({
      queued: true,
      messageId: "main-message-2",
      routed: "main",
    });
    expect(mainDeliveries).toMatchObject([
      {
        from: { id: "session:test", kind: "main" },
        message: "prioritize the failing test",
        delivery: "steer",
        data: { source: "supervisor" },
      },
      {
        message: "then summarize the fix",
        delivery: "followUp",
      },
    ]);
  });

  it("steer routes to a local running subagent and queues a steer command", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "steer",
      { id: handle.id, message: "focus on refresh tokens" },
      context,
    )) as { queued: boolean; messageId: string; routed: string };
    expect(result).toEqual({ queued: true, messageId: expect.any(String), routed: "local" });
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "steer", message: "focus on refresh tokens" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("steer routes to a local actor as a mailbox message", async () => {
    const { provider } = setup();
    const actor = (await provider.invoke(
      "create",
      { name: "steered", instructions: "reply", responseMode: "text" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "steer",
      { id: actor.id, message: "check session expiry" },
      context,
    )) as { routed: string };
    expect(result.routed).toBe("local");
    const messages = (await provider.invoke("messages", { id: actor.id }, context)) as Array<{
      direction: string;
      data?: { message?: string };
    }>;
    expect(
      messages.some(
        (message) => message.direction === "in" && message.data?.message === "check session expiry",
      ),
    ).toBe(true);
  });

  it("steer routes a non-local id over the mesh", async () => {
    const { provider } = setup();
    const result = (await provider.invoke(
      "steer",
      { id: "not-a-local-id", message: "from elsewhere" },
      context,
    )) as { routed: string };
    expect(result.routed).toBe("mesh");
  });

  it("setSteeringMode routes to a local subagent", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    await provider.invoke("setSteeringMode", { id: handle.id, mode: "all" }, context);
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "set_steering_mode", mode: "all" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("setSteeringMode throws for a non-local id (no mesh fallback)", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("setSteeringMode", { id: "unknown-id", mode: "all" }, context),
    ).rejects.toThrow(/Unknown Fabric subagent/);
  });

  it("setSteeringMode rejects an invalid mode", async () => {
    const { provider } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    await expect(
      provider.invoke("setSteeringMode", { id: handle.id, mode: "always" }, context),
    ).rejects.toThrow(/Invalid steering mode/);
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("compact enqueues a compact entry for a running pi child", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "compact",
      { id: handle.id, instructions: "Keep the test plan" },
      context,
    )) as { queued: true; messageId: string };
    expect(result.queued).toBe(true);
    expect(typeof result.messageId).toBe("string");
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "compact", instructions: "Keep the test plan" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("compact descriptor is agent-risk with required id", async () => {
    const { provider } = setup();
    const descriptor = await provider.describe("compact", context);
    expect(descriptor?.risk).toBe("agent");
    const schema = descriptor?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["id"]);
    expect(schema.properties).toHaveProperty("instructions");
    expect(schema.additionalProperties).toBe(false);
  });

  it("compact rejects an unknown id", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("compact", { id: "not-a-real-id" }, context),
    ).rejects.toThrow(/Unknown Fabric subagent/);
  });
});
