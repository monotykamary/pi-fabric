import type { Skill } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import type { FabricKernel } from "../runtime/kernel.js";
import { parseSkillBlock } from "./skill-block.js";

type SkillKernel = FabricKernel | "shared" | "invalid";

// Pi's Skill descriptor omits arbitrary frontmatter metadata. Cache only the
// declaration, not the selected kernel, so settings changes apply next turn.
export class KernelSkills {
  private readonly cache = new Map<string, { stamp: string; kernel: SkillKernel }>();

  private declaration(filePath: string): SkillKernel {
    try {
      const stat = statSync(filePath);
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.cache.get(filePath);
      if (cached?.stamp === stamp) return cached.kernel;
      const text = readFileSync(filePath, "utf8");
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
      let kernel: SkillKernel = "shared";
      if (frontmatter) {
        try {
          const value = parse(frontmatter)?.metadata?.["fabric-kernel"];
          kernel = value === undefined ? "shared"
            : value === "typescript" || value === "python" ? value : "invalid";
        } catch {
          kernel = "invalid";
        }
      }
      this.cache.set(filePath, { stamp, kernel });
      return kernel;
    } catch {
      // Preserve Pi's behavior for unavailable, unannotated resources.
      return this.cache.get(filePath)?.kernel ?? "shared";
    }
  }

  select(skills: readonly Skill[], kernel: FabricKernel): Skill[] {
    return skills.filter((skill) => this.compatible(skill.filePath, kernel));
  }

  private compatible(filePath: string, kernel: FabricKernel): boolean {
    const declared = this.declaration(filePath);
    return declared === "shared" || declared === kernel;
  }

  filterInvocation(text: string, kernel: FabricKernel): string {
    const block = parseSkillBlock(text);
    if (!block || this.compatible(block.location, kernel)) return text;
    return `Skill ${block.name} is unavailable for the configured ${kernel} kernel. Do not execute its instructions or switch interpreters to run it. Use a compatible skill or the current kernel's host APIs.${block.userMessage ? `\n\n${block.userMessage}` : ""}`;
  }
}
