import { describe, expect, it } from "vitest";
import {
  buildVedaArguments,
  mapVedaTools,
  normalizeVedaModel,
  vedaReasoning,
} from "../src/agents/veda-cli.js";

describe("Veda runner arguments", () => {
  it("builds a headless json argv with backend, persona, model, and isolated session", () => {
    const args = buildVedaArguments({
      backend: "agy",
      persona: "navigator-plan",
      model: "agy/gemini-3.1-pro-high",
      thinking: "high",
      tools: ["read", "grep", "find", "ls"],
      session: "fabric-run-123",
    });
    expect(args).toEqual([
      "-b", "agy",
      "-p", "navigator-plan",
      "-m", "agy/gemini-3.1-pro-high",
      "-r", "high",
      "--tools", "read,grep,glob",
      "--json", "--no-sel", "-S", "fabric-run-123", "--no-notify",
    ]);
  });

  it("forwards a custom persona name unchanged", () => {
    const args = buildVedaArguments({
      backend: "agy",
      persona: "frontend",
      tools: [],
      session: "fabric-run-1",
    });
    expect(args).toContainEqual("frontend");
    expect(args.indexOf("-p")).toBeGreaterThanOrEqual(0);
    expect(args[args.indexOf("-p") + 1]).toBe("frontend");
  });

  it("forwards non-AGY Veda backends unchanged", () => {
    expect(
      buildVedaArguments({
        backend: "claude-code",
        persona: "navigator-chat",
        tools: [],
        session: "fabric-claude",
      }),
    ).toContainEqual("claude-code");
    expect(
      buildVedaArguments({
        backend: "codex",
        persona: "navigator-chat",
        tools: [],
        session: "fabric-codex",
      }),
    ).toContainEqual("codex");
  });

  it("passes --no-tools when the allowlist is empty", () => {
    const args = buildVedaArguments({
      backend: "agy",
      persona: "reviewer",
      tools: [],
      session: "fabric-run-1",
    });
    expect(args).toContain("--no-tools");
    expect(args).not.toContain("--tools");
  });

  it("maps off/minimal thinking to minimal and passes higher levels through", () => {
    expect(vedaReasoning("off")).toBe("minimal");
    expect(vedaReasoning("minimal")).toBe("minimal");
    expect(vedaReasoning("medium")).toBe("medium");
    expect(vedaReasoning("xhigh")).toBe("xhigh");
  });

  it("normalizes the veda/ model prefix and leaves agy slugs untouched", () => {
    expect(normalizeVedaModel("veda/gemini-3.6-flash-low")).toBe("gemini-3.6-flash-low");
    expect(normalizeVedaModel("agy/claude-sonnet-4-6")).toBe("agy/claude-sonnet-4-6");
    expect(() => normalizeVedaModel("  ")).toThrow();
  });

  it("maps fabric tools to veda tool ids and rejects unknown tools", () => {
    expect(
      mapVedaTools(["read", "grep", "find", "ls", "bash", "edit", "write"]),
    ).toEqual(["read", "grep", "glob", "bash", "edit", "write"]);
    expect(() => mapVedaTools(["fabric_exec"])).toThrow(/Veda runner does not support/);
  });
});
