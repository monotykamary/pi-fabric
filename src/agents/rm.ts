import fs from "node:fs";

const RETRYABLE_RM_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EMFILE"]);
const RM_RETRY_BACKOFF_MS = 5;
const RM_MAX_ATTEMPTS = 5;

type RemoveFn = (
  target: string,
  options: { recursive: boolean; force: boolean },
) => Promise<void>;

const defaultRemove: RemoveFn = (target, options) => fs.promises.rm(target, options);

/**
 * Recursively remove a directory tree, retrying on transient filesystem
 * races. `fs.rm({ force: true })` ignores ENOENT, but on macOS/APFS a
 * recursive removal can still surface ENOTEMPTY when a child entry has not
 * yet been purged by the filesystem. Retry a few times with a short backoff
 * so agent cleanup and shutdown do not flake on that race. The `rm`
 * argument is a seam for tests; production callers omit it.
 */
export const removeTree = async (target: string, rm: RemoveFn = defaultRemove): Promise<void> => {
  for (let attempt = 0; attempt < RM_MAX_ATTEMPTS; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (
        attempt < RM_MAX_ATTEMPTS - 1 &&
        code !== undefined &&
        RETRYABLE_RM_CODES.has(code)
      ) {
        await new Promise((resolve) => setTimeout(resolve, RM_RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
};
