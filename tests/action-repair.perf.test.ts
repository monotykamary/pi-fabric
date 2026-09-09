import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { repairActionName } from "../src/core/action-repair.js";
import {
  actionArgNormalizer,
  normalizeActionArgs,
} from "../src/providers/arg-normalization.js";

const AGENTS_ACTIONS = [
  "run", "handoff", "spawn", "wait", "status", "list", "members", "self",
  "main", "peers", "subscribe", "subscriptions", "unsubscribe", "models",
  "switchModel", "stop", "cleanup", "create", "ask", "tell", "steer",
  "followUp", "setSteeringMode", "setFollowUpMode", "compact", "actorStatus",
  "actors", "messages", "setModel", "setThinking", "setTools", "setEvents",
  "setDeliveryPolicy", "clearMessages", "remove", "setInstructions", "import",
  "export", "log",
];

const MEMORY_ACTIONS = ["recall", "expand", "sessions"];

const synthetic = Array.from({ length: 3000 }, (_, i) => `op${String(i).padStart(5, "0")}`);

const timeIters = (iters: number, run: () => void): number => {
  const start = performance.now();
  for (let i = 0; i < iters; i++) run();
  return performance.now() - start;
};

describe("repair performance", () => {
  it("keeps per-repair cost trivial on realistic catalogs", () => {
    const spilled = ["search", "snd", "staus", "setsteermode", "mesage", "dstroy", "zzz"];
    for (const name of ["staus", "setsteermode", "mesage", "dstroy"]) {
      expect(repairActionName(AGENTS_ACTIONS, name).repaired).toBeUndefined();
    }
    const elapsed = timeIters(2000, () => {
      for (const name of spilled) {
        repairActionName(AGENTS_ACTIONS, name);
        repairActionName(MEMORY_ACTIONS, name);
      }
    });
    console.log(`repair: 14000 repairs over 39/3-name catalogs in ${elapsed.toFixed(1)}ms (${(elapsed / 14000 * 1000).toFixed(1)}µs/call)`);
    expect(elapsed).toBeLessThan(2000);
  });

  it("keeps the adversarial full-scan bounded on a 3000-name catalog", () => {
    const elapsed = timeIters(200, () => repairActionName(synthetic, "zzzzzz"));
    console.log(`adversarial repair: 3000-name catalog, no match, ${elapsed.toFixed(1)}ms for 200 calls (${(elapsed / 200).toFixed(3)}ms/call)`);
    expect(elapsed).toBeLessThan(5000);
  });

  it("keeps argument normalization cheap per prepare call", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
        scope: { type: "string", enum: ["session", "project", "global"] },
        outcome: { type: "string", enum: ["succeeded", "failed", "aborted", "timed_out"] },
      },
      additionalProperties: false,
    };
    const normalizer = actionArgNormalizer(() => [{ name: "recall", inputSchema: schema }]);
    const elapsed = timeIters(50_000, () => {
      const out = normalizer("recall", { q: "x", Limit: "20", scope: "cwd" });
      if (out.query !== "x" || out.limit !== 20 || out.scope !== "project") {
        throw new Error("normalization broke");
      }
    });
    console.log(`arg repair: 50k prepare calls in ${elapsed.toFixed(1)}ms (${(elapsed / 50_000 * 1000).toFixed(2)}µs/call)`);
    expect(elapsed).toBeLessThan(5000);
  });

  it("coerces declared numerics through the low-level path", () => {
    const out = normalizeActionArgs({ query: "x", limit: "20" }, {
      numerics: ["limit"],
      knownKeys: ["query", "limit"],
    });
    expect(out).toEqual({ query: "x", limit: 20 });
  });
});
