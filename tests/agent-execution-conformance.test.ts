import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { AgentService } from "../src/agents.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { AgentServiceRequest } from "../src/agents/service-types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));});
const construct = (kind: "native" | "hosted") => {
  if (kind === "native") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-conformance-"));
    const manager = new AgentManager(process.cwd(), {...DEFAULT_FABRIC_CONFIG.agents, maxConcurrent: 1}, {workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: root});
    cleanups.push(async () => {await manager.close(); fs.rmSync(root, {recursive: true, force: true});});
    return {
      run: (request: AgentServiceRequest) => manager.run({...request, transport: "process"}),
      spawn: (request: AgentServiceRequest) => manager.spawn({...request, transport: "process"}),
      wait: (id: string) => manager.wait(id), status: async (id: string) => manager.status(id), stop: (id: string) => manager.stop(id),
    };
  }
  const service = new AgentService({rootId: "root", maxConcurrent: 1, port: {execute: async (request) => {
    if (request.request.task.includes("HANG")) return new Promise((resolve) => {
      const stop = () => resolve({status: "stopped"});
      request.signal.addEventListener("abort", stop, {once: true});
      if (request.signal.aborted) stop();
    });
    await request.emit({type: "progress", turns: 1, toolCalls: 0, usage: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0}});
    if (request.request.task.includes("FAIL_DIRECTIVE")) return {status: "failed", text: "fake worker complete", error: "Structured agent output was invalid: Unexpected token (output: not json)"};
    return {status: "completed", text: request.request.schema ? '{"action":"message","message":"fake actor advice"}' : "fake worker complete"};
  }}});
  cleanups.push(() => service.close());
  return {
    run: (request: AgentServiceRequest) => service.run("root", request),
    spawn: (request: AgentServiceRequest) => service.spawn("root", request),
    wait: (id: string) => service.wait("root", id), status: (id: string) => service.status("root", id), stop: (id: string) => service.stop("root", id),
  };
};

for (const kind of ["native", "hosted"] as const) describe(`${kind} one-shot lifecycle conformance`, () => {
  it("settles success/error/schema results, reports status, and reuses released admission", async () => {
    const agents = construct(kind);
    const success = await agents.run({task: "success", model: "test/model", thinking: "low"});
    expect(success).toMatchObject({status: "completed", text: "fake worker complete", turns: 1, toolCalls: 0, usage: {input: 1, output: 2}, model: "test/model", thinking: "low"});
    expect(await agents.status(success.id)).toMatchObject({status: "completed"});
    expect(await agents.wait(success.id)).toMatchObject({status: "completed"});
    const failure = await agents.run({task: "FAIL_DIRECTIVE"});
    expect(failure).toMatchObject({status: "failed", error: "Structured agent output was invalid: Unexpected token (output: not json)"});
    const schema = {type: "object", properties: {action: {type: "string"}, message: {type: "string"}}, required: ["action", "message"]};
    expect(await agents.run({task: "structured", schema})).toMatchObject({status: "completed", value: {action: "message", message: "fake actor advice"}});
    const running = await agents.spawn({task: "HANG"});
    expect(["queued", "running"]).toContain((await agents.status(running.id)).status);
    expect(await agents.stop(running.id)).toMatchObject({status: "stopped"});
    expect(await agents.wait(running.id)).toMatchObject({status: "stopped"});
    expect(await agents.run({task: "after stop"})).toMatchObject({status: "completed"});
  });
});
