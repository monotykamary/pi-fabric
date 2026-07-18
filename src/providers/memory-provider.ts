import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import type { FabricMemoryConfig } from "../config.js";
import {
  AmbiguousSessionError,
  enumerateAllSessions,
  resolveScope,
  resolveSessionTarget,
  type ResolveScopeInput,
  type SessionRef,
} from "../memory/discovery.js";
import { expandSessionEntriesChecked, normalizeSession } from "../memory/normalize.js";
import {
  DEFAULT_HOT_SESSIONS,
  fingerprintSource,
  loadTieredIndex,
  type EntryRange,
  type MemoryIndexOptions,
} from "../memory/index.js";
import {
  DEFAULT_REGEX_MAX_HAYSTACK_BYTES,
  DEFAULT_REGEX_MAX_HAYSTACK_TERMS,
  DEFAULT_REGEX_MAX_PATTERN_BYTES,
  DEFAULT_REGEX_TIMEOUT_MS,
  formatSearchResult,
  searchMemoryIndex,
  type SearchItem,
} from "../memory/search.js";
import type { MemoryQueryMode } from "../memory/tokenize.js";

const RECALL_DEFAULT_PAGE_SIZE = 25;
const RECALL_MAX_PAGE_SIZE = 200;
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
        queryMode: {
          type: "string",
          enum: ["literal", "regex"],
          description: "Literal canonical-token matching (default) or explicitly bounded regex.",
        },
        expectedSourceHash: {
          type: "string",
          description: "SHA-256 from a prior pointer; stale sources are refused.",
        },
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
        entryRange: {
          type: "object",
          description:
            "Inclusive normalized-entry range for an explicit session:<id> hydration.",
          properties: {
            first: { type: "number", minimum: 0 },
            last: { type: "number", minimum: 0 },
          },
          required: ["first", "last"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    risk: "read",
    namespace: "memory",
  },
  {
    name: "expand",
    description:
      "Re-read full text or a bounded structured Fabric operation by index, entry id, operation address, or inclusive range.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Exact session file path or unambiguous id." },
        expectedSourceHash: {
          type: "string",
          description: "SHA-256 from a prior pointer; stale sources are refused.",
        },
        indices: { type: "array", items: { type: "number", minimum: 0 } },
        entryIds: { type: "array", items: { type: "string" } },
        operationAddresses: { type: "array", items: { type: "string" } },
        entryRange: {
          type: "object",
          properties: {
            first: { type: "number", minimum: 0 },
            last: { type: "number", minimum: 0 },
          },
          required: ["first", "last"],
          additionalProperties: false,
        },
      },
      required: ["session"],
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
  ...(config.maxColdVocabularyBytes === undefined
    ? {} : { maxColdVocabularyBytes: config.maxColdVocabularyBytes }),
  ...(config.maxColdCacheBytes === undefined ? {} : { maxColdCacheBytes: config.maxColdCacheBytes }),
  ...(config.maxSyncSessions === undefined ? {} : { maxSyncSessions: config.maxSyncSessions }),
  ...(config.maxSyncSourceBytes === undefined ? {} : { maxSyncSourceBytes: config.maxSyncSourceBytes }),
  ...(config.maxCacheCleanupFiles === undefined
    ? {} : { maxCacheCleanupFiles: config.maxCacheCleanupFiles }),
});

const resolveTierRefs = (refs: SessionRef[], context: MemoryProviderContext): SessionRef[] => {
  const all = enumerateAllSessions(context.agentDir, Number.MAX_SAFE_INTEGER);
  const known = new Set(all.map((ref) => ref.file));
  for (const ref of refs) {
    if (!known.has(ref.file)) all.push(ref);
  }
  return all;
};

const resolveRefs = (
  scope: string | undefined,
  context: MemoryProviderContext,
  boundedBrowse: boolean,
): SessionRef[] => {
  const effectiveScope = scope ?? "session";
  const input: ResolveScopeInput = {
    agentDir: context.agentDir,
    cwd: context.cwd,
    scope: effectiveScope,
    maxSessions: boundedBrowse ? context.config.maxSessions : Number.MAX_SAFE_INTEGER,
  };
  if (context.sessionId) input.sessionId = context.sessionId;
  if (context.sessionFile) input.sessionFile = context.sessionFile;
  return resolveScope(input);
};

const stalePointerError = (
  sessionFile: string,
  expectedSourceHash: string,
  actualSourceHash: string,
) => ({
  code: "stale_pointer",
  message: "Session source changed after the pointer was issued.",
  sessionFile,
  expectedSourceHash,
  actualSourceHash,
});

const addressError = (message: string, entryCount?: number) => ({
  code: "index_out_of_bounds",
  message,
  ...(entryCount === undefined ? {} : { entryCount }),
});

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
    try {
      switch (actionName) {
        case "recall":
          return await this.recall(args, invocationContext);
        case "expand":
          return await this.expand(args);
        case "sessions":
          return await this.sessions(args);
        default:
          throw new Error(`Unknown memory action: ${actionName}`);
      }
    } catch (error) {
      if (error instanceof AmbiguousSessionError) {
        return {
          error: {
            code: error.code,
            message: error.message,
            session: error.session,
            candidates: error.candidates,
          },
        };
      }
      throw error;
    }
  }

  private async recall(
    args: Record<string, unknown>,
    invocationContext: FabricInvocationContext,
  ): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query : undefined;
    const rawQueryMode = args.queryMode;
    if (rawQueryMode !== undefined && rawQueryMode !== "literal" && rawQueryMode !== "regex") {
      throw new Error('memory.recall queryMode must be "literal" or "regex"');
    }
    const queryMode: MemoryQueryMode = rawQueryMode === "regex" ? "regex" : "literal";
    const expectedSourceHash = typeof args.expectedSourceHash === "string"
      ? args.expectedSourceHash
      : undefined;
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

    const refs = resolveRefs(scope, this.context, false);
    const options = resolveIndexOptions(this.context.config, this.context.agentDir);
    const hydrate = scope?.trim().startsWith("session:") ?? false;
    if (expectedSourceHash !== undefined && !hydrate) {
      throw new Error("memory.recall expectedSourceHash requires scope session:<id-or-path>");
    }
    if (hydrate && expectedSourceHash !== undefined && refs[0]) {
      const state = fingerprintSource(refs[0].file);
      if (state && state.sourceHash !== expectedSourceHash) {
        return {
          scope: scope ?? "session",
          query: query ?? null,
          error: stalePointerError(refs[0].file, expectedSourceHash, state.sourceHash),
          segments: [],
          digestHits: [],
          items: [],
        };
      }
    }

    const rawRange = args.entryRange;
    const entryRange = rawRange && typeof rawRange === "object" && !Array.isArray(rawRange)
      ? rawRange as Record<string, unknown>
      : undefined;
    const first = entryRange?.first;
    const last = entryRange?.last;
    if ((first === undefined) !== (last === undefined)) {
      throw new Error("memory.recall entryRange requires both first and last");
    }
    if ((first !== undefined || last !== undefined) && !hydrate) {
      throw new Error("memory.recall entryRange requires scope session:<id-or-path>");
    }
    if (first !== undefined && (
      typeof first !== "number" ||
      typeof last !== "number" ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 0 ||
      last < first
    )) {
      return {
        scope: scope ?? "session",
        query: query ?? null,
        error: addressError("Entry range requires safe integers with 0 <= first <= last."),
        segments: [],
        digestHits: [],
        items: [],
      };
    }
    const selectedRange: EntryRange | undefined =
      typeof first === "number" && typeof last === "number" ? { first, last } : undefined;
    const index = loadTieredIndex(
      refs,
      resolveTierRefs(refs, this.context),
      options,
      hydrate,
      selectedRange,
    );
    if (hydrate && expectedSourceHash !== undefined && index.shards[0]
      && index.shards[0].sourceHash !== expectedSourceHash) {
      return {
        scope: scope ?? "session",
        query: query ?? null,
        error: stalePointerError(
          index.shards[0].sessionFile,
          expectedSourceHash,
          index.shards[0].sourceHash,
        ),
        segments: [],
        digestHits: [],
        items: [],
      };
    }
    if (hydrate && selectedRange && index.shards[0] && selectedRange.last >= index.shards[0].totalEntryCount) {
      return {
        scope: scope ?? "session",
        query: query ?? null,
        error: addressError(
          `Entry range ends at ${selectedRange.last}, but the session has ${index.shards[0].totalEntryCount} entries.`,
          index.shards[0].totalEntryCount,
        ),
        segments: [],
        digestHits: [],
        items: [],
      };
    }

    const filters: { role?: string; tool?: string; since?: number; until?: number } = {};
    if (role) filters.role = role;
    if (tool) filters.tool = tool;
    if (since !== undefined) filters.since = since;
    if (until !== undefined) filters.until = until;
    const searchQuery = {
      ...(query === undefined ? {} : { query }),
      queryMode,
      filters,
      regexLimits: {
        maxPatternBytes: this.context.config.regexMaxPatternBytes
          ?? DEFAULT_REGEX_MAX_PATTERN_BYTES,
        maxHaystackTerms: this.context.config.regexMaxHaystackTerms
          ?? DEFAULT_REGEX_MAX_HAYSTACK_TERMS,
        maxHaystackBytes: this.context.config.regexMaxHaystackBytes
          ?? DEFAULT_REGEX_MAX_HAYSTACK_BYTES,
        timeoutMs: this.context.config.regexTimeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS,
      },
    };
    const result = await searchMemoryIndex(index.shards, index.digests, searchQuery);
    const coverage = {
      ...index.coverage,
      complete: index.coverage.complete && result.queryCoverage.complete,
      reasons: [...new Set([...index.coverage.reasons, ...result.queryCoverage.reasons])].sort(),
      ...(result.queryCoverage.error ? { error: result.queryCoverage.error } : {}),
    };

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
      queryMode,
      matchedCount: result.matchedCount,
      totalMatches: result.totalMatches,
      totalItems: result.totalItems,
      segmentCount: result.segmentCount,
      segments: pagedSegments,
      digestHits: pagedDigests,
      items: pagedItems,
      page,
      pageSize,
      hasNext: start + pageSize < result.totalItems,
      coverage,
      text: formatSearchResult(displayResult, query, coverage),
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
    const expectedSourceHash = typeof args.expectedSourceHash === "string"
      ? args.expectedSourceHash
      : undefined;
    const rawIndices = args.indices;
    if (rawIndices !== undefined && !Array.isArray(rawIndices)) {
      throw new Error("memory.expand indices must be an array");
    }
    if (Array.isArray(rawIndices) && !rawIndices.every((index) =>
      typeof index === "number" && Number.isSafeInteger(index) && index >= 0)) {
      return { session, error: addressError("Every entry index must be a non-negative safe integer."), expanded: [] };
    }
    const indices = (rawIndices as number[] | undefined) ?? [];
    const entryIds = Array.isArray(args.entryIds)
      ? args.entryIds.filter(
          (entryId): entryId is string => typeof entryId === "string" && entryId.length > 0,
        )
      : [];
    const operationAddresses = Array.isArray(args.operationAddresses)
      ? args.operationAddresses.filter(
          (address): address is string => typeof address === "string" && address.length > 0,
        )
      : [];
    const rawRange = args.entryRange;
    const rangeRecord = rawRange && typeof rawRange === "object" && !Array.isArray(rawRange)
      ? rawRange as Record<string, unknown>
      : undefined;
    const first = rangeRecord?.first;
    const last = rangeRecord?.last;
    if (!session) throw new Error("memory.expand requires a session");
    if ((first === undefined) !== (last === undefined)) {
      throw new Error("memory.expand entryRange requires both first and last");
    }
    if (first !== undefined && (
      typeof first !== "number" ||
      typeof last !== "number" ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 0 ||
      last < first
    )) {
      return { session, error: addressError("Entry range requires safe integers with 0 <= first <= last."), expanded: [] };
    }

    const ref = resolveSessionTarget(this.context.agentDir, session);
    if (!ref) {
      return {
        session,
        error: { code: "session_not_found", message: `Session not found: ${session}` },
        expanded: [],
      };
    }
    const initialState = fingerprintSource(ref.file);
    if (!initialState) {
      return {
        session: ref.file,
        error: { code: "source_unavailable", message: `Session source is unavailable: ${ref.file}` },
        expanded: [],
      };
    }
    if (expectedSourceHash !== undefined && initialState.sourceHash !== expectedSourceHash) {
      return {
        session: ref.file,
        error: stalePointerError(ref.file, expectedSourceHash, initialState.sourceHash),
        expanded: [],
      };
    }

    const entryCount = normalizeSession(ref.file, Number.MAX_SAFE_INTEGER).entries.length;
    const outOfBounds = indices.find((index) => index >= entryCount);
    if (outOfBounds !== undefined) {
      return {
        session: ref.file,
        error: addressError(`Entry index ${outOfBounds} is outside 0..${Math.max(0, entryCount - 1)}.`, entryCount),
        expanded: [],
      };
    }
    if (typeof last === "number" && last >= entryCount) {
      return {
        session: ref.file,
        error: addressError(`Entry range ends at ${last}, but the session has ${entryCount} entries.`, entryCount),
        expanded: [],
      };
    }
    if (
      indices.length === 0 &&
      entryIds.length === 0 &&
      operationAddresses.length === 0 &&
      (first === undefined || last === undefined)
    ) {
      return { session: ref.file, sourceHash: initialState.sourceHash, expanded: [] };
    }

    const selection: {
      indices?: number[];
      entryIds?: string[];
      operationAddresses?: string[];
      entryRange?: { first: number; last: number };
    } = {};
    if (indices.length > 0) selection.indices = indices;
    if (entryIds.length > 0) selection.entryIds = entryIds;
    if (operationAddresses.length > 0) selection.operationAddresses = operationAddresses;
    if (typeof first === "number" && typeof last === "number") {
      selection.entryRange = { first, last };
    }
    const expansion = expandSessionEntriesChecked(ref.file, selection);
    const finalState = fingerprintSource(ref.file);
    if (!finalState || finalState.sourceHash !== initialState.sourceHash) {
      return {
        session: ref.file,
        error: stalePointerError(
          ref.file,
          expectedSourceHash ?? initialState.sourceHash,
          finalState?.sourceHash ?? "",
        ),
        expanded: [],
      };
    }
    if ("error" in expansion) {
      return {
        session: ref.file,
        sourceHash: finalState.sourceHash,
        error: expansion.error,
        expanded: [],
      };
    }
    return { session: ref.file, sourceHash: finalState.sourceHash, expanded: expansion.expanded };
  }

  private async sessions(args: Record<string, unknown>): Promise<unknown> {
    const scope = typeof args.scope === "string" ? args.scope : undefined;
    const refs = resolveRefs(scope, this.context, true).slice(0, SESSIONS_MAX);
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
