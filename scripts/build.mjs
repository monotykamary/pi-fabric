#!/usr/bin/env node
import { build } from "esbuild";

const primaryEntryPoints = [
  "src/index.ts",
  "src/protocol.ts",
  "src/worker.ts",
  "src/residency/host.ts",
  "src/residency/launcher.ts",
  "src/residency/pi-entry.ts",
  "src/residency/actor-client.ts",
  "src/compaction/hook.ts",
  "src/core/action-registry.ts",
  "src/entropy/index.ts",
  "src/memory/digest.ts",
  "src/memory/search.ts",
  "src/memory/discovery.ts",
  "src/memory/normalize.ts",
  "src/providers/memory-provider.ts",
];

// Every package-local dynamic import is also an entry point. Its stable output
// path lets a session that loaded the previous index resolve delayed modules
// after the installed package is replaced, while preserving lazy evaluation.
const lazyEntryPoints = [
  "src/agents/claude-cli.ts",
  "src/agents/compact-control.ts",
  "src/agents/veda-cli.ts",
  "src/fabric-runtime-state.ts",
  "src/runtime/core-override-guest-types.ts",
  "src/runtime/dynamic-guest-types.ts",
  "src/runtime/guest-types.ts",
  "src/runtime/node-process-runtime.ts",
  "src/runtime/quickjs-runtime.ts",
  "src/runtime/type-checker.ts",
  "src/speculation/scanner.ts",
  "src/ui/dashboard.ts",
  "src/ui/model-picker.ts",
  "src/ui/settings.ts",
  "src/worker/options.ts",
  "src/worker/run-record.ts",
  "src/worker/session-export.ts",
];

const result = await build({
  entryPoints: [...primaryEntryPoints, ...lazyEntryPoints],
  outdir: "dist",
  outbase: "src",
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  splitting: true,
  sourcemap: true,
  metafile: true,
  logLevel: "info",
});

const bundledPackages = Object.keys(result.metafile.inputs).filter((input) =>
  input.includes("node_modules/"),
);
if (bundledPackages.length > 0) {
  throw new Error(`Package code was bundled unexpectedly:\n${bundledPackages.join("\n")}`);
}

const unstableLazyImports = Object.entries(result.metafile.outputs).flatMap(
  ([output, metadata]) =>
    metadata.imports
      .filter(
        (entry) =>
          entry.kind === "dynamic-import" &&
          !entry.external &&
          entry.path.includes("/chunks/"),
      )
      .map((entry) => `${output} -> ${entry.path}`),
);
if (unstableLazyImports.length > 0) {
  throw new Error(
    `Package-local dynamic imports must use stable entry paths:\n${unstableLazyImports.join("\n")}`,
  );
}
