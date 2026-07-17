import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import type { FabricActorRequest } from "../src/actors/types.js";

const dirs: string[] = [];

const setup = () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-actors-"));
  dirs.push(agentDir);
  const registry = new GlobalActorRegistry(agentDir, 64 * 1024);
  return { agentDir, registry };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const baseRequest: FabricActorRequest = {
  name: "reviewer",
  instructions: "Review code for security defects and reply concisely.",
  events: ["turn_end"],
  topics: ["team.review"],
  delivery: "steer" as const,
  responseMode: "directive" as const,
  triggerTurn: false,
  coalesce: true,
};

describe("GlobalActorRegistry", () => {
  it("creates, lists, and resolves templates by id, prefix, and name", () => {
    const { registry } = setup();
    expect(registry.list()).toEqual([]);

    const created = registry.create(baseRequest);
    expect(created.id).toMatch(/^[a-f0-9]{32}$/);
    expect(created.name).toBe("reviewer");
    expect(created.events).toEqual(["turn_end"]);
    expect(created.delivery).toBe("steer");
    expect(created.runner).toBe("pi");
    expect(created.model).toBeUndefined();

    expect(registry.list()).toHaveLength(1);
    expect(registry.resolve(created.id)?.name).toBe("reviewer");
    expect(registry.resolve(created.id.slice(0, 8))?.name).toBe("reviewer");
    expect(registry.resolve("reviewer")?.id).toBe(created.id);
    expect(registry.resolve("missing")).toBeUndefined();
  });

  it("persists across instances in the same agent dir", () => {
    const { agentDir, registry } = setup();
    registry.create(baseRequest);
    const reloaded = new GlobalActorRegistry(agentDir, 64 * 1024);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.resolve("reviewer")?.instructions).toBe(baseRequest.instructions);
  });

  it("rejects duplicate names without overwrite and replaces with it", () => {
    const { registry } = setup();
    registry.create(baseRequest);
    expect(() => registry.create(baseRequest)).toThrow(/already exists/);

    const replaced = registry.create(
      { ...baseRequest, instructions: "Updated instructions." },
      true,
    );
    expect(replaced.instructions).toBe("Updated instructions.");
    expect(replaced.id).toBe(registry.resolve("reviewer")?.id);
    expect(registry.list()).toHaveLength(1);
  });

  it("applies partial patches via update and revalidates", () => {
    const { registry } = setup();
    const created = registry.create(baseRequest);
    const patched = registry.update(created.id, { instructions: "Be brief." });
    expect(patched.instructions).toBe("Be brief.");
    expect(patched.name).toBe("reviewer");
    expect(patched.events).toEqual(["turn_end"]);

    expect(() => registry.update(created.id, { instructions: "   " })).toThrow(/empty/);
    expect(() => registry.update(created.id, { name: "bad name!" })).toThrow(/Invalid/);
  });

  it("removes templates", () => {
    const { registry } = setup();
    const created = registry.create(baseRequest);
    expect(registry.remove(created.id)).toEqual({ removed: true });
    expect(registry.list()).toEqual([]);
    expect(registry.remove(created.id)).toEqual({ removed: false });
  });

  it("validates names, instructions, events, topics, and sizes", () => {
    const { registry } = setup();
    expect(() => registry.create({ ...baseRequest, name: "" })).toThrow(/Invalid/);
    expect(() => registry.create({ ...baseRequest, name: "9bad name!" })).toThrow(/Invalid/);
    expect(() => registry.create({ ...baseRequest, instructions: "  " })).toThrow(/empty/);
    expect(() =>
      registry.create({ ...baseRequest, events: ["bogus" as never] }),
    ).toThrow(/Unsupported/);
    expect(() =>
      registry.create({ ...baseRequest, topics: ["bad topic!"] }),
    ).toThrow(/Invalid/);
    const big = "x".repeat(64 * 1024 + 1);
    expect(() => registry.create({ ...baseRequest, instructions: big })).toThrow(/exceed/);
  });

  it("strips identity and timestamps in toRequest and supports renaming", () => {
    const { registry } = setup();
    const created = registry.create({ ...baseRequest, runner: "claude", model: "claude/haiku" });
    const request = registry.toRequest(created);
    expect(request).not.toHaveProperty("id");
    expect(request).not.toHaveProperty("createdAt");
    expect(request).not.toHaveProperty("updatedAt");
    expect(request.name).toBe("reviewer");
    expect(request.runner).toBe("claude");
    expect(request.model).toBe("claude/haiku");

    const renamed = registry.toRequest(created, "reviewer-2");
    expect(renamed.name).toBe("reviewer-2");
  });

  it("throws when a query matches multiple templates", () => {
    const { registry } = setup();
    registry.create(baseRequest);
    registry.create({ ...baseRequest, name: "reviewer-2" });
    // An empty query matches every template's id prefix, so two templates
    // are ambiguous. (Random 32-hex ids rarely share a longer prefix, so the
    // empty query deterministically exercises the ambiguity branch.)
    expect(() => registry.resolve("")).toThrow(/Ambiguous/);
  });
});
