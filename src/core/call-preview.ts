// A shared, provider-agnostic heuristic for the one-line "headline" argument
// of a nested Fabric call — the value shown beside a tool's name in the chat
// preview (e.g. `recall <query>`) and appended to its ref in the dashboard
// (e.g. `extensions.vcc_recall · <query>`). Pi core tools and the first-class
// Fabric providers (agents/mesh/mcp management) keep their bespoke, tuned
// previews; this picks up everything else — captured extension tools and
// arbitrary MCP tools — so they no longer render as a bare tool name.
//
// The key order preserves the dashboard's prior task -> path -> query ->
// message preference for the fields it already recognized, then extends to
// other common payload names. The final first-string fallback covers tools
// whose argument names are unfamiliar, skipping structural/metadata keys
// (label/title/mode/limit/...) that describe the call rather than its
// payload. Control characters are not stripped here: the inline preview
// already tolerates them (matching the existing task fallback) and the
// dashboard sanitizes labels via safeText at render time.
export const HEADLINE_ARG_KEYS = [
  "task", "path", "query", "message", "search", "pattern", "command", "text",
  "prompt", "question", "input", "content", "expression", "url", "topic",
  "key", "filter", "name", "q",
] as const;

const HEADLINE_SKIP_KEYS = new Set([
  "label", "title", "type", "kind", "mode", "format", "resultFormat",
  "limit", "max", "offset", "start", "concurrency", "overwrite", "id",
  "provider", "namespace", "server", "tool", "ref", "recursive", "synthesize",
  "commandDigest",
]);

const cleanOneLine = (value: string, max: number): string => {
  const single = value.replace(/\s+/g, " ").trim();
  if (!single) return "";
  return single.length <= max ? single : `${single.slice(0, Math.max(1, max - 1))}…`;
};

/**
 * Pick the best single-line argument value to display beside a nested call's
 * tool name, for tools that have no bespoke preview. Returns `undefined`
 * when no string payload argument is present.
 */
export const headlineArg = (
  args: Record<string, unknown> | undefined,
  max = 96,
): string | undefined => {
  if (!args) return undefined;
  for (const key of HEADLINE_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      const cleaned = cleanOneLine(value, max);
      if (cleaned) return cleaned;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (HEADLINE_SKIP_KEYS.has(key)) continue;
    if (typeof value === "string") {
      const cleaned = cleanOneLine(value, max);
      if (cleaned) return cleaned;
    }
  }
  return undefined;
};
