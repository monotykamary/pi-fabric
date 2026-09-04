#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const stable = [
  "index.js",
  "protocol.js",
  "worker.js",
  "residency/host.js",
  "compaction/hook.js",
  "core/action-registry.js",
  "entropy/index.js",
  "memory/digest.js",
  "memory/search.js",
  "memory/discovery.js",
  "memory/normalize.js",
  "providers/memory-provider.js",
];
const lazy = [
  "agents/claude-cli.js",
  "agents/compact-control.js",
  "agents/veda-cli.js",
  "fabric-runtime-state.js",
  "runtime/core-override-guest-types.js",
  "runtime/dynamic-guest-types.js",
  "runtime/guest-types.js",
  "runtime/node-process-runtime.js",
  "runtime/quickjs-runtime.js",
  "runtime/type-checker.js",
  "speculation/scanner.js",
  "ui/dashboard.js",
  "ui/model-picker.js",
  "ui/settings.js",
  "worker/options.js",
  "worker/run-record.js",
  "worker/session-export.js",
];
const entries = [...stable, ...lazy];
const declarations = entries.map((file) => file.replace(/\.js$/, ".d.ts"));
const required = [
  ...entries,
  ...entries.map((file) => `${file}.map`),
  ...declarations,
  ...declarations.map((file) => `${file}.map`),
];
const missing = required.filter((file) => !existsSync(join(dist, file)));
if (missing.length > 0) throw new Error(`Missing build artifacts:\n${missing.join("\n")}`);

const chunks = join(dist, "chunks");
const chunkFiles = existsSync(chunks)
  ? readdirSync(chunks).filter((file) => file.endsWith(".js"))
  : [];
if (chunkFiles.length === 0) throw new Error("Build did not produce dynamic chunks");
for (const chunk of chunkFiles) {
  if (!existsSync(join(chunks, `${chunk}.map`))) {
    throw new Error(`Missing source map for chunk ${chunk}`);
  }
}

const staticImport = /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const staticClosure = (roots) => {
  const visited = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) stack.push(resolve(dirname(file), specifier));
    }
  }
  return visited;
};

const startupFiles = staticClosure([join(dist, "index.js")]);
const initialSource = [...startupFiles]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
for (const forbidden of ["src/fabric-runtime-state.ts", "src/ui/settings.ts", 'from "mcporter"']) {
  if (initialSource.includes(forbidden)) {
    throw new Error(`Startup static graph contains lazy module marker: ${forbidden}`);
  }
}
const lazyFiles = staticClosure(lazy.map((file) => join(dist, file)));
const lazySource = [...lazyFiles].map((file) => readFileSync(file, "utf8")).join("\n");
for (const expected of ["src/fabric-runtime-state.ts", "src/ui/settings.ts", 'import("mcporter")']) {
  if (!lazySource.includes(expected)) {
    throw new Error(`Expected lazy entry marker not found: ${expected}`);
  }
}

for (const file of entries) {
  const checked = spawnSync(process.execPath, ["--check", join(dist, file)], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(checked.stderr || `Syntax check failed: ${file}`);
}
await Promise.all(
  stable.filter((file) => file !== "worker.js").map((file) =>
    import(new URL(`../dist/${file}`, import.meta.url)),
  ),
);
console.log(
  `build artifacts and lazy startup graph verified (${startupFiles.size} startup files, ${lazy.length} stable lazy entries, ${chunkFiles.length} chunks)`,
);
