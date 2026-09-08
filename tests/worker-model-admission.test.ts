import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const workerPath = path.resolve("dist/worker.js");
const requested = "openai-codex/gpt-5.6-sol";

describe.skipIf(!fs.existsSync(workerPath))("real worker model admission", () => {
  const roots: string[] = [];
  const managers: AgentManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.close()));
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const root = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-model-admission-"));
    roots.push(directory);
    return directory;
  };
  const run = async (scenario: string, model = requested) => {
    const directory = root();
    const scenarioFile = path.join(directory, "scenario");
    fs.writeFileSync(scenarioFile, scenario);
    vi.stubEnv("FAKE_MODEL_SCENARIO", scenarioFile);
    const manager = new AgentManager(directory, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: scenario === "timeout" ? 30_000 : 5_000 }, {
      workerPath, piBinary: path.resolve("tests/fixtures/fake-pi-model.mjs"), runRoot: path.join(directory, "runs"),
    });
    managers.push(manager);
    const result = await manager.run({ task: "must run on requested model", model, thinking: "high", transport: "process" });
    const events = fs.readFileSync(result.logFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const frames = events.filter(event => event.type === "fake_received").map(event => event.frame);
    return { manager, result, frames };
  };

  it("overrides startup MRU and remembered reasoning before sending any task", async () => {
    const { result, frames, manager } = await run("success");
    expect(result).toMatchObject({ status: "completed", model: requested, requestedModel: requested, thinking: "high" });
    expect(frames.map(frame => frame.type)).toEqual(["set_model", "set_thinking_level", "get_state", "prompt"]);
    expect(frames[0]).toMatchObject({ provider: "openai-codex", modelId: "gpt-5.6-sol" });
    expect(manager.listForUi()[0]).toMatchObject({ model: requested, thinking: "high" });
  });

  it.each(["reject", "reswitch", "malformed", "exit", "timeout"])("never sends work when admission fails: %s", async scenario => {
    const { result, frames } = await run(scenario);
    expect(["failed", "timed_out"]).toContain(result.status);
    expect(result.error).toMatch(/model|timed out/);
    expect(frames.some(frame => frame.type === "prompt")).toBe(false);
    expect(result.toolCalls).toBe(0);
  }, 40_000);

  it("reports actual model drift through the result and UI, without erasing the failure", async () => {
    const { result, manager } = await run("drift");
    expect(result).toMatchObject({ status: "failed", model: "runinfra/glm-5-3-flash", requestedModel: requested });
    expect(result.error).toContain("terminating child");
    expect(manager.listForUi()[0]).toMatchObject({ status: "failed", model: "runinfra/glm-5-3-flash" });
  });

  it("supports an exact bare model ID without using the startup default", async () => {
    const { result, frames } = await run("success", "gpt-5.6-sol");
    expect(result).toMatchObject({ status: "completed", model: requested });
    expect(frames[0].type).toBe("get_available_models");
  });

  it("reasserts selection after a real Pi session_start extension hijacks it (offline)", async () => {
    const directory = root();
    const agentDir = path.join(directory, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      extensions: [path.resolve("tests/fixtures/model-hijack-extension.ts")],
      enableInstallTelemetry: false,
    }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    const manager = new AgentManager(directory, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 20_000 }, {
      workerPath,
      piBinary: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      fullCodeMode: false,
      fabricExtensionPath: path.resolve("dist/index.js"),
      runRoot: path.join(directory, "runs"),
    });
    managers.push(manager);
    const result = await manager.run({ task: "probe model", model: "model-probe/requested", thinking: "high", extensions: true, transport: "process" });
    expect(result, `${result.error}
${result.stderr}
${fs.readFileSync(result.logFile!, "utf8")}`).toMatchObject({ status: "completed", model: "model-probe/requested", thinking: "high" });
    expect(result.text).toBe("model-probe/requested:high");
    const log = fs.readFileSync(result.logFile!, "utf8");
    expect(log).toContain("startup-hijacked:model-probe/mru");
  }, 30_000);
});
