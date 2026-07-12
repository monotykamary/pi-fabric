import {
  wrapRegisteredTool,
  type ExtensionRunner,
  type RegisteredTool,
  type SourceInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { FabricToolCaptureConfig } from "../config.js";
import type { FabricRisk } from "../protocol.js";

export interface CapturedToolEntry {
  name: string;
  definition: ToolDefinition<any, any, any>;
  registeredTool: RegisteredTool;
  sourceInfo: SourceInfo;
  runner: ExtensionRunner;
  wrappedTool: ReturnType<typeof wrapRegisteredTool>;
  risk: FabricRisk;
}

export class CapturedToolCatalog {
  readonly #tools = new Map<string, CapturedToolEntry>();

  replace(
    registeredTools: RegisteredTool[],
    runner: ExtensionRunner,
    config: FabricToolCaptureConfig,
    ownSourcePath: string,
  ): void {
    this.#tools.clear();
    if (!config.enabled) return;

    for (const registeredTool of registeredTools) {
      const { definition, sourceInfo } = registeredTool;
      if (sourceInfo.path === ownSourcePath) continue;
      this.#tools.set(definition.name, {
        name: definition.name,
        definition,
        registeredTool,
        sourceInfo,
        runner,
        wrappedTool: wrapRegisteredTool(registeredTool, runner),
        risk: config.risks[definition.name] ?? config.defaultRisk,
      });
    }
  }

  clear(): void {
    this.#tools.clear();
  }

  get(name: string): CapturedToolEntry | undefined {
    return this.#tools.get(name);
  }

  require(name: string): CapturedToolEntry {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown captured extension tool: ${name}`);
    return tool;
  }

  list(): CapturedToolEntry[] {
    return [...this.#tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get size(): number {
    return this.#tools.size;
  }
}
