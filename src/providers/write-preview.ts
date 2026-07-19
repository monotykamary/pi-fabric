// Adapted from pi-code-previews with Fabric result isolation; see THIRD_PARTY_NOTICES.md.
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  createWriteToolDefinition,
  type ToolDefinition,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const configuredMaxBytes = Number.parseInt(
  process.env.CODE_PREVIEW_MAX_WRITE_DIFF_BYTES ?? "",
  10,
);
const MAX_WRITE_DIFF_BYTES =
  Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : 200_000;

type ExistingFilePreview =
  | { kind: "content"; content: string }
  | {
      kind: "skipped";
      reason: string;
      byteLength?: number;
      maxBytes: number;
      sizeExceeded?: boolean;
    };

const resolvePreviewPath = (filePath: string, cwd: string): string => {
  let expanded = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  expanded = expanded.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = homedir() + expanded.slice(1);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
};

const skipped = (
  reason: string,
  byteLength: number | undefined,
  sizeExceeded = false,
): ExistingFilePreview => ({
  kind: "skipped",
  reason,
  ...(byteLength !== undefined ? { byteLength } : {}),
  maxBytes: MAX_WRITE_DIFF_BYTES,
  ...(sizeExceeded ? { sizeExceeded: true } : {}),
});

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export const writeContentForPreview = (content: string): string | undefined =>
  Buffer.byteLength(content, "utf8") <= MAX_WRITE_DIFF_BYTES ? content : undefined;

const readExistingFileForPreview = async (
  filePath: string,
  cwd: string,
  nextContent: string,
): Promise<ExistingFilePreview | undefined> => {
  const absolutePath = resolvePreviewPath(filePath, cwd);
  const nextBytes = Buffer.byteLength(nextContent, "utf8");
  if (writeContentForPreview(nextContent) === undefined) {
    return skipped("new content too large", nextBytes, true);
  }
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    return isMissing(error) ? undefined : skipped("previous content unavailable", undefined);
  }
  if (!fileStat.isFile()) return skipped("previous path is not a regular file", fileStat.size);
  if (fileStat.size > MAX_WRITE_DIFF_BYTES) {
    return skipped("previous file too large", fileStat.size, true);
  }
  try {
    const content = await readFile(absolutePath, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    return bytes > MAX_WRITE_DIFF_BYTES
      ? skipped("previous file too large", bytes, true)
      : { kind: "content", content };
  } catch {
    return skipped("previous content unavailable", fileStat.size);
  }
};

export const createPreviewWriteToolDefinition = (
  cwd: string,
): ToolDefinition<any, any, any> => {
  const original = createWriteToolDefinition(cwd);
  return {
    ...original,
    async execute(
      _toolCallId: string,
      params: { path: string; content: string },
      signal: AbortSignal | undefined,
    ) {
      const { path, content } = params;
      const absolutePath = resolvePreviewPath(path, cwd);
      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };
        throwIfAborted();
        const before = await readExistingFileForPreview(path, cwd, content);
        throwIfAborted();
        await mkdir(dirname(absolutePath), { recursive: true });
        throwIfAborted();
        await writeFile(absolutePath, content, "utf8");
        throwIfAborted();
        return {
          content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}` }],
          details: { codePreviewBeforeWrite: before },
        };
      });
    },
  } as unknown as ToolDefinition<any, any, any>;
};
