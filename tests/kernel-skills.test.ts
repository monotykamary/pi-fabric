import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession, DefaultResourceLoader, SettingsManager, loadSkillsFromDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FabricState } from "../src/fabric-state.js";
import { normalizeFabricConfig } from "../src/config.js";
import { fabricSkillPaths } from "../src/core/kernel-skills.js";
import { restoreSkillsForFullCodePrompt } from "../src/core/skill-prompt.js";
import { expandSkillDirMarkersInSkillBlock } from "../src/core/skill-dir.js";

const root = path.resolve("skillsets");
const bundled = (kernel: "typescript" | "python") => loadSkillsFromDir({ dir: fabricSkillPaths(root, kernel)[0]!, source: "test" });

describe("physical kernel skill trees", () => {
  it("ships identical canonical names with only the execution reference model-invokable", () => {
    const ts = bundled("typescript");
    const python = bundled("python");
    expect(ts.diagnostics).toEqual([]);
    expect(python.diagnostics).toEqual([]);
    expect(ts.skills).toHaveLength(12);
    expect(python.skills.map((s) => s.name).sort()).toEqual(ts.skills.map((s) => s.name).sort());
    for (const loaded of [ts, python]) {
      expect(loaded.skills.filter((s) => !s.disableModelInvocation).map((s) => s.name)).toEqual(["fabric-exec"]);
    }
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.pi.skills).toEqual([]);
    expect(manifest.files).toContain("skillsets/");
  });

  it("fails closed when the selected tree is missing", () => {
    expect(() => fabricSkillPaths(path.join(root, "missing"), "python")).toThrow("no other-kernel fallback");
  });

  it("resolves the same command and all hard pointers within the selected physical tree", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "fabric-skill-discovery-"));
    try {
      const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: SettingsManager.inMemory({}), noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      for (const kernel of ["typescript", "python", "typescript"] as const) {
        await loader.reload();
        loader.extendResources({ skillPaths: fabricSkillPaths(root, kernel).map((selected) => ({ path: selected, metadata: { source: "fabric", scope: "temporary", origin: "top-level" } })) });
        const loaded = loader.getSkills();
        expect(loaded.skills).toHaveLength(12);
        expect(loaded.diagnostics).toEqual([]);
        const expand = (text: string): string => (AgentSession.prototype as unknown as { _expandSkillCommand(text: string): string })._expandSkillCommand.call({ resourceLoader: loader }, text);
        for (const name of ["fabric-exec", "fabric-advisor"]) {
          const expanded = expandSkillDirMarkersInSkillBlock(expand(`/skill:${name} inspect project`));
          expect(expanded).toContain(path.join(root, kernel, name, "SKILL.md"));
          expect(expanded).toContain("inspect project");
          expect(expanded).not.toContain(path.join(root, kernel === "python" ? "typescript" : "python"));
        }
        const skill = loaded.skills.find((s) => s.name === "fabric-exec")!;
        for (const file of ["agents.md", "mesh.md", "mcp.md"]) {
          const reference = readFileSync(path.join(skill.baseDir, "references", file), "utf8");
          expect(reference).toContain(kernel === "python" ? "```python" : "```ts");
        }
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it("keeps every marked reference valid and every executable fence in its own language", () => {
    for (const kernel of ["typescript", "python"] as const) {
      const tree = path.join(root, kernel);
      for (const relative of readdirSync(tree, { recursive: true }).filter((p) => String(p).endsWith(".md"))) {
        const file = path.join(tree, String(relative));
        const markdown = readFileSync(file, "utf8");
        expect(markdown).not.toContain("/Users/");
        expect(markdown).not.toContain("/home/");
        expect(markdown).not.toMatch(kernel === "python" ? /```(?:ts|typescript|javascript)\b/ : /```python\b/);
        for (const match of markdown.matchAll(/<skill-dir>\/([^`]+\.md)/g)) {
          const resolved = path.resolve(path.dirname(file), match[1]!);
          expect(() => readFileSync(resolved), `${file} -> ${resolved}`).not.toThrow();
          if (!resolved.includes(`${path.sep}docs${path.sep}`)) expect(resolved.startsWith(tree + path.sep)).toBe(true);
        }
      }
    }
  });

  it.each(["typescript", "python"] as const)("contributes only %s resources through the real extension hook", async (kernel) => {
    const handlers = new Map<string, Array<(event: any, context: any) => any>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) }, getActiveTools: vi.fn(() => ["fabric_exec"]), getAllTools: vi.fn(() => []),
      on: (event: string, handler: (event: any, context: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerTool: vi.fn(), setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const { default: piFabric } = await import("../src/index.js");
    await piFabric(pi);
    const ready = vi.spyOn(FabricState.prototype, "bootstrapped", "get").mockReturnValue(true);
    const config = vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(normalizeFabricConfig({ executor: { kernel } }));
    try {
      const discovery = await handlers.get("resources_discover")![0]!({}, {});
      expect(discovery).toEqual({ skillPaths: [path.join(root, kernel)] });
      const event = { systemPrompt: "Base", prompt: "inspect", systemPromptOptions: { skills: bundled(kernel).skills } };
      const prompt = await handlers.get("before_agent_start")![0]!(event, {});
      expect(prompt.systemPrompt).toContain(path.join(root, kernel, "fabric-exec", "SKILL.md"));
      expect((await handlers.get("before_agent_start")![0]!(event, {})).systemPrompt).toBe(prompt.systemPrompt);
      expect(prompt.systemPrompt).not.toContain("fabric-exec-python");
    } finally { ready.mockRestore(); config.mockRestore(); }
  });

  it("preserves the native/full-code loader distinction and neutral third-party skills", () => {
    const skills = bundled("python").skills;
    expect(restoreSkillsForFullCodePrompt("Base", skills, false)).toContain("Use the read tool");
    expect(restoreSkillsForFullCodePrompt("Base", skills)).toContain("Use `pi.read` inside");
  });
});
