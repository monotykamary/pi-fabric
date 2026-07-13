import { PI_CORE_TOOL_NAME_SET } from "./pi-tools.js";

export interface FabricToolOwnershipHost {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
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
