import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ExtensionRunner as ImportedExtensionRunner,
  type ExtensionRunner,
  type RegisteredTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_FABRIC_CONFIG, type FabricToolCaptureConfig } from "../config.js";
import { CapturedToolCatalog } from "./catalog.js";

type ToolCaptureListener = (tools: RegisteredTool[], runner: ExtensionRunner) => RegisteredTool[];

interface ToolCaptureHub {
  listeners: Set<ToolCaptureListener>;
}

export interface RegisteredToolCaptureController {
  setPolicy(config: FabricToolCaptureConfig): void;
  dispose(): void;
}

const HUB_SYMBOL = Symbol.for("pi-fabric.registered-tool-capture.v1");
const ANCHOR_SYMBOL = Symbol.for("pi-fabric.registered-tool-anchor.v1");

const definitionDelegatesTo = (
  definition: ToolDefinition<any, any, any>,
  target: ToolDefinition<any, any, any>,
): boolean => {
  let current: object | null = definition;
  while (current) {
    if (current === target) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
};

const clonePolicy = (config: FabricToolCaptureConfig): FabricToolCaptureConfig => ({
  enabled: config.enabled,
  hideFromModel: config.hideFromModel,
  keepVisible: [...config.keepVisible],
  defaultRisk: config.defaultRisk,
  risks: { ...config.risks },
});

type ExtensionRunnerConstructor = {
  prototype: ExtensionRunner;
};

const captureHub = (Runner: ExtensionRunnerConstructor): ToolCaptureHub => {
  const prototype = Runner.prototype as ExtensionRunner & Record<PropertyKey, unknown>;
  const existing = prototype[HUB_SYMBOL] as ToolCaptureHub | undefined;
  if (existing) return existing;

  const original = prototype.getAllRegisteredTools;
  if (typeof original !== "function") {
    throw new Error("Pi Fabric could not intercept ExtensionRunner.getAllRegisteredTools");
  }

  const hub: ToolCaptureHub = { listeners: new Set() };
  Object.defineProperty(prototype, HUB_SYMBOL, {
    value: hub,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  prototype.getAllRegisteredTools = function getFabricVisibleTools(): RegisteredTool[] {
    let tools = original.call(this);
    for (const listener of [...hub.listeners]) tools = listener(tools, this);
    return tools;
  };
  return hub;
};

const hostPackageRoot = (): string | undefined => {
  const cliPath = process.argv[1];
  if (!cliPath) return undefined;
  let directory: string;
  try {
    directory = path.dirname(realpathSync(cliPath));
  } catch {
    return undefined;
  }
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
        if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
      } catch { /* unreadable or invalid manifest; keep searching */ }
    }
    directory = path.dirname(directory);
  }
  return undefined;
};

const extensionRunnerConstructors = async (): Promise<ExtensionRunnerConstructor[]> => {
  const constructors = new Set<ExtensionRunnerConstructor>([ImportedExtensionRunner]);
  const packageRoots = new Set(
    [process.env.PI_PACKAGE_DIR, hostPackageRoot()].filter(
      (root): root is string => typeof root === "string" && Boolean(root),
    ),
  );
  for (const packageRoot of packageRoots) {
    try {
      const hostEntry = path.join(packageRoot, "dist", "index.js");
      const hostModule = (await import(pathToFileURL(hostEntry).href)) as {
        ExtensionRunner?: ExtensionRunnerConstructor;
      };
      if (hostModule.ExtensionRunner) constructors.add(hostModule.ExtensionRunner);
    } catch { /* host entry not importable; skip */ }
  }
  return [...constructors];
};

export const installRegisteredToolCapture = async (options: {
  anchorDefinition: ToolDefinition<any, any, any>;
  catalog: CapturedToolCatalog;
  initialPolicy?: FabricToolCaptureConfig;
}): Promise<RegisteredToolCaptureController> => {
  const hubs = (await extensionRunnerConstructors()).map(captureHub);
  const anchorToken = {};
  Object.defineProperty(options.anchorDefinition, ANCHOR_SYMBOL, {
    value: anchorToken,
    configurable: false,
    enumerable: true,
    writable: false,
  });
  let policy = clonePolicy(options.initialPolicy ?? DEFAULT_FABRIC_CONFIG.capture);
  let disposed = false;

  const listener: ToolCaptureListener = (tools, runner) => {
    if (disposed) return tools;
    const anchor = tools.find(
      (tool) =>
        (tool.definition as unknown as Record<PropertyKey, unknown>)[ANCHOR_SYMBOL] ===
          anchorToken || definitionDelegatesTo(tool.definition, options.anchorDefinition),
    );
    if (!anchor) return tools;

    options.catalog.replace(tools, runner, policy, anchor.sourceInfo.path);
    if (!policy.enabled || !policy.hideFromModel) return tools;

    const visible = new Set(policy.keepVisible);
    return tools.filter(
      (tool) =>
        tool.sourceInfo.path === anchor.sourceInfo.path || visible.has(tool.definition.name),
    );
  };

  for (const hub of hubs) hub.listeners.add(listener);
  return {
    setPolicy(config) {
      policy = clonePolicy(config);
      if (!policy.enabled) options.catalog.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const hub of hubs) hub.listeners.delete(listener);
      options.catalog.clear();
    },
  };
};
