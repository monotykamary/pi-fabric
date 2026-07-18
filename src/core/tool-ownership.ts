import path from "node:path";
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { readFabricExecutionTraceV1 } from "../audit/index.js";
import { NESTED_TOOL_CALL_ID_PREFIX } from "./action-registry.js";
import { PI_CORE_TOOL_NAME_SET } from "./pi-tools.js";

export interface FabricToolOwnershipHost {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface FabricTopLevelToolAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
}

const FABRIC_TOOL_NAME = "fabric_exec";
const TOP_LEVEL_SCHEMA_REF_PREFIX = "schema.top_level_tool.";

export const ownsFabricToolSource = (
  tools: Array<{ name: string; sourceInfo: { path: string } }>,
  extensionEntryPath: string,
): boolean => tools.some(
  (tool) =>
    tool.name === FABRIC_TOOL_NAME &&
    path.resolve(tool.sourceInfo.path) === path.resolve(extensionEntryPath),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finalFabricDetailsFailed = (details: unknown): boolean => {
  if (!isRecord(details)) return false;
  if (details.success === false) return true;
  const trace = readFabricExecutionTraceV1(details.trace);
  return trace !== undefined && trace.outcome !== "succeeded";
};

export class FabricToolLifecycle {
  readonly #outerCalls = new Set<string>();

  constructor(
    readonly ownsFabricTool: () => boolean,
    readonly authorizer: () => FabricTopLevelToolAuthorizer | undefined,
  ) {}

  async toolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    if (event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)) {
      if (this.#outerCalls.size > 0) return undefined;
      await this.#authorizeTopLevel(event);
      return undefined;
    }
    if (event.toolName === FABRIC_TOOL_NAME && this.ownsFabricTool()) {
      this.#outerCalls.add(event.toolCallId);
      return undefined;
    }
    await this.#authorizeTopLevel(event);
    return undefined;
  }

  toolResult(event: ToolResultEvent): { isError: true } | undefined {
    if (
      event.toolName !== FABRIC_TOOL_NAME ||
      event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX) ||
      !this.#outerCalls.delete(event.toolCallId)
    ) {
      return undefined;
    }
    return !event.isError && finalFabricDetailsFailed(event.details)
      ? { isError: true }
      : undefined;
  }

  clear(): void {
    this.#outerCalls.clear();
  }

  async #authorizeTopLevel(event: ToolCallEvent): Promise<void> {
    await this.authorizer()?.authorize(
      `${TOP_LEVEL_SCHEMA_REF_PREFIX}${event.toolName}`,
      event.toolCallId,
    );
  }
}

const sameTools = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index]);

export class FabricToolOwnership {
  #savedNativeCoreTools: Array<{ name: string; index: number }> | undefined;

  constructor(readonly host: FabricToolOwnershipHost) {}

  apply(fullCodeMode: boolean): boolean {
    const active = this.host.getActiveTools();
    if (!fullCodeMode) return this.#restore(active);

    this.#savedNativeCoreTools ??= active.flatMap((name, index) =>
      PI_CORE_TOOL_NAME_SET.has(name) ? [{ name, index }] : [],
    );
    const next = active.filter((name) => !PI_CORE_TOOL_NAME_SET.has(name));
    if (!next.includes("fabric_exec")) next.push("fabric_exec");
    return this.#setIfChanged(active, next);
  }

  release(): boolean {
    return this.#restore(this.host.getActiveTools());
  }

  #restore(active: string[]): boolean {
    const saved = this.#savedNativeCoreTools;
    if (!saved) return false;
    this.#savedNativeCoreTools = undefined;
    const next = [...active];
    for (const { name, index } of saved) {
      if (!next.includes(name)) next.splice(Math.min(index, next.length), 0, name);
    }
    return this.#setIfChanged(active, next);
  }

  #setIfChanged(active: string[], next: string[]): boolean {
    if (sameTools(active, next)) return false;
    this.host.setActiveTools(next);
    return true;
  }
}
