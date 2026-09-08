import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the source subject in memory without adding a public package entry.
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/activity/store.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false });
const { FabricActivityStore } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
assert(global.gc, "Run with node --expose-gc");
const runCount = Number(process.argv[2] ?? 12);
assert(Number.isInteger(runCount) && runCount > 0 && runCount <= 24, "Run count must be 1–24");
const activeRun = `run-${runCount - 1}`;
const fixture = () => {
  const store = new FabricActivityStore();
  for (let r = 0; r < runCount; r++) {
    const id = `run-${r}`;
    store.start(id);
    for (let c = 0; c < 300; c++) store.beginCall(id, { callId: `call-${c}`, ref: "pi.read",
      args: { path: `${c}.ts`, content: "x".repeat(8000) } });
    if (r < runCount - 1) store.finish(id, true);
  }
  return store;
};
const round = (n) => Math.round(n * 1000) / 1000;
const cases = [];
for (const detailed of [false, true]) {
  for (const streaming of [false, true]) {
    for (const incremental of [false, true]) {
      const store = fixture();
      const view = store.createRunView();
      const read = incremental ? () => view(detailed) : detailed ? () => store.runs() : () => store.runSummaries();
      let snapshot = read();
      const samples = [];
      let replacedRuns = 0;
      let replacedCalls = 0;
      for (let i = 0; i < 35; i++) {
        if (streaming) store.updateCall(activeRun, "call-0", { type: "progress", message: `progress-${i}` });
        const start = performance.now();
        const next = read();
        const elapsed = performance.now() - start;
        if (i >= 5) {
          samples.push(elapsed);
          for (let r = 0; r < next.length; r++) {
            if (next[r] !== snapshot[r]) replacedRuns++;
            for (let c = 0; c < next[r].calls.length; c++) {
              if (next[r].calls[c] !== snapshot[r].calls[c]) replacedCalls++;
            }
          }
        }
        snapshot = next;
      }
      assert.deepEqual(snapshot, detailed ? store.runs() : store.runSummaries());
      if (incremental) {
        assert.equal(replacedRuns, streaming ? 30 : 0);
        assert.equal(replacedCalls, streaming ? 30 : 0);
      }
      samples.sort((a, b) => a - b);
      cases.push({ detailed, streaming, incremental, medianMs: round(samples[15]), p95Ms: round(samples[28]),
        replacedRuns, replacedCalls });
    }
  }
}
let notifications = 0;
const store = fixture();
store.updateCall(activeRun, "call-0", { type: "progress", message: "same" });
const unsubscribe = store.subscribe(() => notifications++);
for (let i = 0; i < 10000; i++) store.updateCall(activeRun, "call-0", { type: "progress", message: "same" });
assert.equal(notifications, 0);
unsubscribe();
const view = store.createRunView();
const sampleHeap = () => { global.gc(); return process.memoryUsage().heapUsed; };
view(true);
const retained = [{ cycles: 0, heapBytes: sampleHeap() }];
for (let cycle = 1; cycle <= 60; cycle++) {
  store.reset();
  store.start("live");
  for (let c = 0; c < 300; c++) store.beginCall("live", { callId: `c-${c}`, ref: "pi.read", args: { text: "y".repeat(8000) } });
  view(true);
  if (cycle % 20 === 0) retained.push({ cycles: cycle, heapBytes: sampleHeap() });
}
store.reset();
assert.deepEqual(view(), []);
retained.push({ cycles: "reset", heapBytes: sampleHeap() });
console.log(JSON.stringify({ node: process.version, arch: process.arch, synthetic: true,
  fixture: { runs: runCount, callsPerRun: 300, payloadCharsPerCall: 8000, measuredReads: 30 },
  cases, duplicateProgressNotifications: notifications, retention: retained }, null, 2));
