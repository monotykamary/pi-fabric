import {
  FabricExecutionTraceRecorder,
  type FabricExecutionTraceV1,
} from "../../src/audit/trace.js";

export const recordedIntegrationTrace = (): FabricExecutionTraceV1 => {
  const recorder = new FabricExecutionTraceRecorder();
  const read = recorder.issueCall("pi.read", { path: "src/read.ts", offset: 1, limit: 20 });
  const editFailure = recorder.issueCall("pi.edit", { path: "src/edit.ts", edits: [{ oldText: "a", newText: "b" }] });
  const editSuccess = recorder.issueCall("pi.edit", { path: "src/edit.ts", edits: [{ oldText: "a", newText: "b" }] });
  const write = recorder.issueCall("pi.write", { path: "src/write.ts", content: "export {};" });
  const created = recorder.issueCall("pi.write", { path: "src/created.ts", content: "new" });
  const bashFailure = recorder.issueCall("pi.bash", { command: "pnpm test", timeout: 30 });
  const bashSuccess = recorder.issueCall("pi.bash", { command: "pnpm test", timeout: 30 });
  const agent = recorder.issueCall("agents.run", { name: "reviewer", prompt: "inspect" });
  const workflow = recorder.issueCall("workflow.agent", { name: "builder", prompt: "build" });
  const mesh = recorder.issueCall("mesh.query", { topic: "build.status" });
  const state = recorder.issueCall("state.get", { key: "release" });
  const mcp = recorder.issueCall("mcp.github.search", { query: "issue" });
  const extension = recorder.issueCall("extensions.preview", { path: "ui.png" });

  // Complete out of issue order to exercise deterministic sequence ordering.
  extension.succeed({ visible: true });
  state.succeed({ value: "ready" });
  read.succeed("export const value = 1;");
  editFailure.fail("invoke", new Error("exact edit failure"));
  editSuccess.succeed({ ok: true, output: "edited" });
  write.succeed({ ok: true, output: "wrote", details: null });
  created.succeed({ ok: true, created: true });
  bashFailure.fail("invoke", new Error("typed test failure"));
  bashSuccess.succeed({ ok: true, output: "all tests passed" });
  agent.succeed({ id: "agent-1" });
  workflow.succeed({ id: "workflow-1" });
  mesh.succeed({ events: 1 });
  mcp.succeed({ issues: 1 });

  return recorder.seal("succeeded", ["Inspect", "Implement", "Verify"]);
};

export const recordedParallelTrace = (): FabricExecutionTraceV1 => {
  const recorder = new FabricExecutionTraceRecorder();
  const first = recorder.issueCall("pi.read", { path: "parallel/first.ts" });
  const second = recorder.issueCall("pi.read", { path: "parallel/second.ts" });
  second.succeed("second");
  first.succeed("first");
  return recorder.seal("succeeded", ["Parallel"]);
};
