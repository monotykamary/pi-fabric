import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import type { FabricMemoryConfig } from "../config.js";
import {
  enumerateAllSessions,
  resolveScope,
  type ResolveScopeInput,
  type SessionRef,
} from "../memory/discovery.js";
import { expandSessionEntry } from "../memory/normalize.js";
import {
  DEFAULT_HOT_SESSIONS,
  loadTieredIndex,
  type MemoryIndexOptions,
} from "../memory/index.js";
import { formatSearchResult, searchMemoryIndex, type SearchItem } from "../memory/search.js";

const RECALL_DEFAULT_PAGE_SIZE = 25;
const RECALL_MAX_PAGE_SIZE = 200;
const RECALL_BROWSE_LIMIT = 25;
const SESSIONS_MAX = 500;

const descriptors: FabricActionDescriptor[] = [
  {
    name: "recall",
    description:
      "Search hot session entries and cold session digests. Use scope session:<id-or-path> to hydrate a cold session and search its entries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: {
          type: "string",
          description:
            "session | project | global | session:<id-or-path>. Defaults to session.",
        },
        page: { type: "number", minimum: 1 },
        pageSize: { type: "number", minimum: 1, maximum: RECALL_MAX_PAGE_SIZE },
        role: { type: "string" },
        tool: { type: "string" },
        since: { type: "number" },
        until: { type: "number" },
      },
      additionalProperties: false,
    },
    risk: "read",
    namespace: "memory",
  },
  {
    name: "expand",
    description:
      "Re-read full, untruncated text for specific entry indices of a session (re-reads the source JSONL on demand).",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session file path or id." },
        indices: { type: "array", items: { type: "number", minimum: 0 } },
      },
      required: ["session", "indices"],
      additionalProperties: false,
    },
    risk: "read",
    namespace: "memory",
  },
  {
    name: "sessions",
    description: "List known sessions in scope with id, file, cwd, mtime, entry count, and hot/cold tier.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
      },
      additionalProperties: false,
    },
    risk: "read",
    namespace: "memory",
  },
];

export interface MemoryProviderContext {
  agentDir: string;
  cwd: string;
  config: FabricMemoryConfig;
  sessionId?: string;
  sessionFile?: string;
}

const resolveIndexOptions = (config: FabricMemoryConfig, agentDir: string): MemoryIndexOptions => ({
  indexDir: config.indexDir ?? `${agentDir}/fabric/memory-index`,
  maxEntryChars: config.maxEntryChars,
  hotSessions: config.hotSessions ?? DEFAULT_HOT_SESSIONS,
  digestTerms: config.digestTerms ?? 200,
});

const resolveTierRefs = (refs: SessionRef[], context: MemoryProviderContext): SessionRef[] => {
  const all = enumerateAllSessions(context.agentDir, Number.MAX_SAFE_INTEGER);
  const known = new Set(all.map((ref) => ref.file));
  for (const ref of refs) {
    if (!known.has(ref.file)) all.push(ref);
  }
  return all;
};

const resolveRefs = (scope: string | undefined, context: MemoryProviderContext): SessionRef[] => {
  const effectiveScope = scope ?? "session";
  const input: ResolveScopeInput = {
    agentDir: context.agentDir,
    cwd: context.cwd,
    scope: effectiveScope,
    maxSessions: context.config.maxSessions,
  };
  if (context.sessionId) input.sessionId = context.sessionId;
  if (context.sessionFile) input.sessionFile = context.sessionFile;
  return resolveScope(input);
};

const findSessionFile = (session: string, context: MemoryProviderContext): string | null => {
  if (session.endsWith(".jsonl")) return session;
  const refs = resolveScope({
    agentDir: context.agentDir,
    cwd: context.cwd,
    scope: "global",
    maxSessions: Number.MAX_SAFE_INTEGER,
  });
  const byId = refs.find((ref) => ref.id === session);
  if (byId) return byId.file;
  const byStem = refs.find((ref) => ref.file.endsWith(`${session}.jsonl`));
  return byStem?.file ?? null;
};

export class MemoryProvider implements FabricProvider {
  readonly name = "memory";
  readonly description =
    "Cross-session memory: a search engine over every Pi session timeline on this machine";

  constructor(private readonly context: MemoryProviderContext) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    invocationContext: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "recall":
        return this.recall(args, invocationContext);
      case "expand":
        return this.expand(args);
      case "sessions":
        return this.sessions(args);
      default:
        throw new Error(`Unknown memory action: ${actionName}`);
    }
  }

  private async recall(
    args: Record<string, unknown>,
    invocationContext: FabricInvocationContext,
  ): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query : undefined;
    const scope = typeof args.scope === "string" ? args.scope : undefined;
    const role = typeof args.role === "string" ? args.role : undefined;
    const tool = typeof args.tool === "string" ? args.tool : undefined;
    const since = typeof args.since === "number" ? args.since : undefined;
    const until = typeof args.until === "number" ? args.until : undefined;
    const page = typeof args.page === "number" && args.page >= 1 ? Math.floor(args.page) : 1;
    const pageSize =
      typeof args.pageSize === "number" && args.pageSize >= 1
        ? Math.min(Math.floor(args.pageSize), RECALL_MAX_PAGE_SIZE)
        : RECALL_DEFAULT_PAGE_SIZE;

    const refs = resolveRefs(scope, this.context);
    if (refs.length === 0) {
      return {
        scope: scope ?? "session",
        query: query ?? null,
        segments: [],
        text: query ? `No matches for "${query}".` : "No entries in scope.",
      };
    }

    const options = resolveIndexOptions(this.context.config, this.context.agentDir);
    const hydrate = scope?.trim().startsWith("session:") ?? false;
    const { shards, digests } = loadTieredIndex(
      refs,
      resolveTierRefs(refs, this.context),
      options,
      hydrate,
    );
    const limit = page * pageSize;
    const filters: { role?: string; tool?: string; since?: number; until?: number } = {};
    if (role) filters.role = role;
    if (tool) filters.tool = tool;
    if (since !== undefined) filters.since = since;
    if (until !== undefined) filters.until = until;
    const searchQuery: { query?: string; filters: typeof filters; limit: number } = {
      filters,
      limit,
    };
    if (query) searchQuery.query = query;
    const result = searchMemoryIndex(shards, digests, searchQuery);

    const start = (page - 1) * pageSize;
    const pagedItems = result.items.slice(start, start + pageSize);
    const pagedSegments = pagedItems
      .filter((item): item is Extract<SearchItem, { kind: "entry" }> => item.kind === "entry")
      .map((item) => item.segment);
    const pagedDigests = pagedItems
      .filter((item): item is Extract<SearchItem, { kind: "digest" }> => item.kind === "digest")
      .map((item) => item.digest);
    const displayResult = {
      ...result,
      segments: pagedSegments,
      digestHits: pagedDigests,
      items: pagedItems,
    };
    const pagedResult = {
      scope: scope ?? "session",
      query: query ?? null,
      matchedCount: result.matchedCount,
      segmentCount: result.segmentCount,
      segments: pagedSegments,
      digestHits: pagedDigests,
      page,
      pageSize,
      text: formatSearchResult(displayResult, query),
    };
    invocationContext.update(
      query
        ? `memory.recall: ${result.matchedCount} matches across ${result.segmentCount} segments`
        : `memory.recall: ${result.matchedCount} recent entries`,
    );
    return pagedResult;
  }

  private async expand(args: Record<string, unknown>): Promise<unknown> {
    const session = typeof args.session === "string" ? args.session : "";
    const indices = Array.isArray(args.indices)
      ? args.indices.filter((index): index is number => typeof index === "number" && index >= 0)
      : [];
    if (!session) throw new Error("memory.expand requires a session");
    if (indices.length === 0) return { session, expanded: [] };

    const file = findSessionFile(session, this.context);
    if (!file) {
      return { session, error: `Session not found: ${session}`, expanded: [] };
    }
    const expanded = indices.map((index) => ({
      index,
      text: expandSessionEntry(file, index),
    }));
    return { session: file, expanded };
  }

  private async sessions(args: Record<string, unknown>): Promise<unknown> {
    const scope = typeof args.scope === "string" ? args.scope : undefined;
    const refs = resolveRefs(scope, this.context).slice(0, SESSIONS_MAX);
    const options = resolveIndexOptions(this.context.config, this.context.agentDir);
    const index = loadTieredIndex(refs, resolveTierRefs(refs, this.context), options);
    const shards = new Map(index.shards.map((shard) => [shard.sessionFile, shard]));
    const digests = new Map(index.digests.map((digest) => [digest.file, digest]));
    const sessions = refs.map((ref) => {
      const tier = index.tiers.get(ref.file) ?? "cold";
      const shard = shards.get(ref.file);
      const digest = digests.get(ref.file);
      return {
        id: shard?.sessionId ?? digest?.sessionId ?? ref.id,
        file: ref.file,
        cwd: digest?.cwd ?? ref.cwd,
        mtime: ref.mtime,
        entryCount: shard?.entries.length ?? digest?.entryCount ?? 0,
        tier,
      };
    });
    return { scope: scope ?? "session", sessions };
  }
}
