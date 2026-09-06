import { statSync } from "node:fs";
import path from "node:path";
import type { FabricKernel } from "../runtime/kernel.js";

// Both trees use identical public names. Contribute only one physical root;
// Pi resolves skill expansion and relative references from that root.
export const fabricSkillPaths = (root: string, kernel: FabricKernel): string[] => {
  const selected = path.join(root, kernel);
  if (!statSync(selected, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Missing Fabric ${kernel} skill tree: ${selected}. Reinstall Fabric; no other-kernel fallback is available.`);
  }
  return [selected];
};
