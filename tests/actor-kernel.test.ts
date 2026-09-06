import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { MeshStore } from "../src/mesh/store.js";
import type { FabricKernel } from "../src/runtime/kernel.js";

const roots: string[] = [];
const actorsToClose: ActorManager[] = [];
const agentsToClose: AgentManager[] = [];
afterEach(async () => {
  await Promise.all(actorsToClose.splice(0).map((manager) => manager.close()));
  await Promise.all(agentsToClose.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-actor-kernel-"));
  roots.push(root);
  let kernel: FabricKernel = "python";
  let pythonRuntime: "cpython" | "monty" = "monty";
  const agents = new AgentManager(process.cwd(), structuredClone(DEFAULT_FABRIC_CONFIG.agents), {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: path.join(root, "runs"),
    kernel: () => kernel,
    pythonRuntime: () => pythonRuntime,
  });
  agentsToClose.push(agents);
  const run = vi.spyOn(agents, "run");
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const createManager = () => {
    const manager = new ActorManager("actor-kernel", {
      id: "session:actor-kernel", name: "main", kind: "main", sessionId: "actor-kernel",
    }, mesh, { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 }, agents, () => {}, {
      actorRoot: path.join(root, "actors"), persistent: true,
    });
    actorsToClose.push(manager);
    return manager;
  };
  const actors = createManager();
  return { root, agents, run, actors, createManager,
    setKernel: (value: FabricKernel) => { kernel = value; },
    setBackend: (value: "cpython" | "monty") => { pythonRuntime = value; },
  };
};

describe("persistent actor kernels", () => {
  it("inherits once at creation and keeps the session language across activations and export", async () => {
    const { actors, run, setKernel, setBackend } = fixture();
    const actor = await actors.create({ name: "python reviewer", instructions: "Review", kernel: "inherit" });
    expect(actor.kernel).toBe("python");
    setKernel("typescript");
    setBackend("cpython");
    await actors.ask(actor.id, "check");
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kernel: "python", pythonRuntime: "monty", runner: "pi" });
    expect(actors.definition(actor.id).kernel).toBe("python");
    const explicit = await actors.create({ name: "TS reviewer", instructions: "Review", kernel: "typescript" });
    expect(explicit.kernel).toBe("typescript");
    const inherited = await actors.create({ name: "new inherited reviewer", instructions: "Review" });
    expect(inherited.kernel).toBe("typescript");
  });

  it("persists the chosen kernel and treats legacy saved Pi sessions as TypeScript", async () => {
    const { actors, createManager, root } = fixture();
    const actor = await actors.create({ name: "persisted Python", instructions: "Review" });
    await actors.close();
    const file = path.join(root, "actors", "actors.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.actors[0].kernel).toBe("python");
    const restored = createManager();
    expect(restored.status(actor.id).kernel).toBe("python");
    await restored.close();
    delete saved.actors[0].kernel;
    fs.writeFileSync(file, JSON.stringify(saved));
    const legacy = createManager();
    expect(legacy.status(actor.id).kernel).toBe("typescript");
  });

  it("rejects incompatible explicit kernels before creating actors", async () => {
    const { actors } = fixture();
    await expect(actors.create({ name: "no Fabric", instructions: "Review", extensions: false, kernel: "python" })).rejects.toThrow(/kernel/i);
    await expect(actors.create({ name: "Claude", instructions: "Review", runner: "claude", kernel: "python" })).rejects.toThrow(/kernel/i);
    await expect(actors.create({ name: "invalid", instructions: "Review", kernel: "ruby" as never })).rejects.toThrow(/kernel/i);
    expect(actors.list()).toEqual([]);
    const native = await actors.create({ name: "native", instructions: "Review", extensions: false });
    expect(native.kernel).toBeUndefined();
  });

  it("keeps explicit or inherited selections in reusable global templates", () => {
    const { root } = fixture();
    const templates = new GlobalActorRegistry(root, 64 * 1024);
    const python = templates.create({ name: "Python template", instructions: "Review", kernel: "python" });
    const inherited = templates.create({ name: "inherit template", instructions: "Review", kernel: "inherit" });
    const restored = new GlobalActorRegistry(root, 64 * 1024);
    expect(restored.resolve(python.id)?.kernel).toBe("python");
    expect(restored.resolve(inherited.id)?.kernel).toBe("inherit");
    expect(restored.update(python.id, { kernel: "typescript" }).kernel).toBe("typescript");
    expect(() => restored.create({ name: "bad", instructions: "Review", runner: "claude", kernel: "python" })).toThrow(/kernel/i);
    expect(() => restored.create({ name: "bad", instructions: "Review", kernel: "ruby" as never })).toThrow(/kernel/i);
  });
});
