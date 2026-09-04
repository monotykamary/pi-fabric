#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const hostPackage = "@earendil-works/pi-coding-agent";
const entries = ["ui/dashboard.js", "ui/model-picker.js", "ui/settings.js"].map((file) =>
  join(dist, file),
);
const missing = entries.filter((file) => !existsSync(file));
if (missing.length > 0) {
  throw new Error(`Lazy UI entries were not built:\n${missing.join("\n")}`);
}

const importRe = /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const visited = new Set();
const stack = [...entries];
while (stack.length > 0) {
  const file = stack.pop();
  if (!file || visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importRe)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) stack.push(resolve(dirname(file), specifier));
  }
}
const offenders = [...visited].filter((file) => {
  const source = readFileSync(file, "utf8");
  return source.includes(`from \"${hostPackage}\"`) || source.includes(`from '${hostPackage}'`);
});
if (offenders.length > 0) {
  throw new Error(
    `Lazy UI graph must not import ${hostPackage}:\n${offenders.join("\n")}`,
  );
}
console.log(`lazy UI graph is host-package-free (${visited.size} files checked)`);
