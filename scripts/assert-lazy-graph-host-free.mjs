#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const hostPackage = "@earendil-works/pi-coding-agent";
const entries = [
  "ui/dashboard.js", "ui/model-picker.js", "ui/settings.js",
  "ui/conversation.js", "ui/conversation-host.js", "ui/conversation-targets.js",
  "ui/conversation-chrome.js", "ui/conversation-native-reader.js",
].map((file) => join(dist, file));
const missing = entries.filter((file) => !existsSync(file));
if (missing.length > 0) {
  throw new Error(`Lazy UI entries were not built:\n${missing.join("\n")}`);
}

const importRe = /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g;
const visited = new Set();
const offenders = new Set();
const stack = [...entries];
while (stack.length > 0) {
  const file = stack.pop();
  if (!file || visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of [...source.matchAll(importRe), ...source.matchAll(dynamicImportRe)]) {
    const specifier = match[1];
    if (specifier === hostPackage || specifier?.startsWith(`${hostPackage}/`)) offenders.add(file);
    if (specifier?.startsWith(".")) stack.push(resolve(dirname(file), specifier));
  }
}
if (offenders.size > 0) {
  throw new Error(
    `Lazy UI graph must not import ${hostPackage}:\n${[...offenders].join("\n")}`,
  );
}
console.log(`lazy UI graph is host-package-free (${visited.size} files checked)`);
