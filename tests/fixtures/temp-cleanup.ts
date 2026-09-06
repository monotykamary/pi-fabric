import fs from "node:fs";

// Windows keeps a directory locked while a just-terminated child's cwd or a
// scanner handle releases; retry bounded removals instead of failing cleanup.
export const rmTempSync = (root: string): void => {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
};
