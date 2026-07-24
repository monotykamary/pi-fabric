import { describe, expect, it } from "vitest";
import {
  codeUsesOrchestration,
  isBlockingOrchestrationRef,
} from "../src/runtime/orchestration.js";

describe("isBlockingOrchestrationRef", () => {
  it("classifies only host calls that wait for child agent turns", () => {
    expect(isBlockingOrchestrationRef("agents.run")).toBe(true);
    expect(isBlockingOrchestrationRef("agents.handoff")).toBe(false);
    expect(isBlockingOrchestrationRef("agents.wait")).toBe(true);
    expect(isBlockingOrchestrationRef("agents.ask")).toBe(true);
    expect(isBlockingOrchestrationRef("agents.spawn")).toBe(false);
    expect(isBlockingOrchestrationRef("agents.status")).toBe(false);
    expect(isBlockingOrchestrationRef("demo.slow")).toBe(false);
  });
});

describe("codeUsesOrchestration", () => {
  it("detects workflow agent entry points", () => {
    expect(codeUsesOrchestration('await agent("review", { label: "x" });')).toBe(true);
    expect(codeUsesOrchestration('await workflow.agent("review");')).toBe(true);
    expect(codeUsesOrchestration('await agent ("review");')).toBe(true);
    expect(
      codeUsesOrchestration('const out = await parallel([() => agent("a"), () => agent("b")]);'),
    ).toBe(true);
  });

  it("detects generic typed workflow agent calls", () => {
    expect(
      codeUsesOrchestration('const inv = await agent<{ files: string[] }>("list", { label: "x" });'),
    ).toBe(true);
  });

  it("detects direct blocking agents calls", () => {
    expect(codeUsesOrchestration('await agents.run({ task: "x" });')).toBe(true);
    expect(codeUsesOrchestration('await agents.handoff({ model: "p/m" });')).toBe(false);
    expect(codeUsesOrchestration('await agents.wait({ id: h.id });')).toBe(true);
    expect(codeUsesOrchestration('await agents.ask({ id, message: "go" });')).toBe(true);
  });

  it("detects council and rlm entry points", () => {
    expect(codeUsesOrchestration('await council.run({ task: "review", roles: ["a"] });')).toBe(true);
    expect(codeUsesOrchestration('await rlm.query({ task: "map" });')).toBe(true);
  });

  it("ignores read-only and non-blocking agent calls", () => {
    expect(codeUsesOrchestration('return agents.list();')).toBe(false);
    expect(codeUsesOrchestration('return agents.status({ id });')).toBe(false);
    expect(
      codeUsesOrchestration('const h = await agents.spawn({ task: "x" }); return h;'),
    ).toBe(false);
    expect(
      codeUsesOrchestration('await agents.create({ name: "x", instructions: "y" });'),
    ).toBe(false);
    expect(codeUsesOrchestration('await agents.tell({ id, message: "x" });')).toBe(false);
  });

  it("ignores plain tool calls and property access", () => {
    expect(codeUsesOrchestration('return pi.read({ path: "x" });')).toBe(false);
    expect(codeUsesOrchestration('return tools.call({ ref: "pi.read", args: {} });')).toBe(false);
    expect(codeUsesOrchestration('return obj.agent("x");')).toBe(false);
    expect(codeUsesOrchestration('return userAgent("x");')).toBe(false);
    expect(codeUsesOrchestration('return worker("x");')).toBe(false);
  });

  it("ignores orchestration tokens that are not call sites", () => {
    expect(codeUsesOrchestration('// agents.run something\nreturn 1;')).toBe(false);
    expect(codeUsesOrchestration('return "agents.run";')).toBe(false);
    expect(codeUsesOrchestration('const workflow = {}; return workflow;')).toBe(false);
  });
});
