import { describe, expect, it } from "vitest";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  createMemorySourceClient,
  createMemorySourceRegistry,
  defineMemorySource,
  memoryActionSchemas,
  type MemorySourceAction,
  type MemorySourceCoverage,
  type MemorySourceRecord,
  type MemorySourceSessionMetadata,
  type MemorySourceSnapshot,
  type PortableMemorySource,
} from "../src/memory.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import {
  assistantText,
  messageEntry,
  sessionHeader,
  toolResult,
  userMessage,
} from "./fixtures/memory.js";
import { recordedIntegrationTrace } from "./fixtures/fabric-execution-trace.js";

const timestamp = (offset: number): string =>
  new Date(1_700_000_000_000 + offset * 1_000).toISOString();

interface FakeSession {
  key: string;
  revision: string;
  records: MemorySourceRecord[];
  metadata?: MemorySourceSessionMetadata;
  snapshotCoverage?: MemorySourceCoverage;
}

interface FakeSourceOptions {
  id?: string;
  authorize?: (
    action: MemorySourceAction,
    sessionKey: string | null,
  ) => boolean | Promise<boolean>;
  dropSnapshotKey?: boolean;
}

const fakeSource = (sessions: FakeSession[], options: FakeSourceOptions = {}) => {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const source: PortableMemorySource = {
    interfaceVersion: 1,
    id: options.id ?? "archive",
    async listSessions() {
      const listed = sessions.map((session) => ({
        sessionKey: session.key,
        revision: session.revision,
        ...(session.metadata ? { metadata: session.metadata } : {}),
      }));
      return listed;
    },
    async loadSession(sessionKey): Promise<MemorySourceSnapshot | null> {
      const session = byKey.get(sessionKey);
      if (!session) return null;
      return {
        sessionKey: options.dropSnapshotKey ? "mismatched-key" : session.key,
        revision: session.revision,
        ...(session.metadata ? { metadata: session.metadata } : {}),
        records: session.records,
        ...(session.snapshotCoverage ? { coverage: session.snapshotCoverage } : {}),
      };
    },
  };
  if (options.authorize) {
    source.authorize = (action, sessionKey) => options.authorize!(action, sessionKey);
  }
  return { source };
};

const sessionRecords = (id: string, texts: string[]): MemorySourceRecord[] => [
  sessionHeader(id, "/work/archive"),
  ...texts.map((text, index) =>
    messageEntry(
      id + "-" + index,
      index === 0 ? null : id + "-" + (index - 1),
      timestamp(index),
      index % 2 === 0 ? userMessage(text) : assistantText(text),
    ),
  ),
];

const metadata = (cwd: string, updatedAt: number): MemorySourceSessionMetadata => ({
  title: "archive session",
  cwd,
  updatedAt,
});

const invocation = (): FabricInvocationContext => ({
  cwd: "/work/nowhere",
  signal: undefined,
  parentToolCallId: "portable-conformance",
  nestedToolCallId: "portable-conformance-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

interface Recalled {
  total: number;
  hits: Array<Record<string, unknown>>;
  coverage: { complete: boolean; reasons: string[] };
  error?: { code: string; message: string };
}

interface Expanded {
  session: string;
  sourceHash: string;
  entryCount: number;
  entries: Array<{ text: string }>;
  next: { args: Record<string, unknown> } | null;
  error?: { code: string; message: string };
}

interface Listed {
  scope: string;
  sessions: Array<{ id: string; file: string; cwd: string; mtime: number; entryCount: number }>;
  coverage?: { complete: boolean; reasons: string[] };
  error?: { code: string; message: string };
}

describe("portable memory source conformance", () => {
  it("registers sources through the versioned registry and rejects mismatches", () => {
    const registry = createMemorySourceRegistry();
    const { source } = fakeSource([]);
    registry.register(source);
    expect(registry.ids()).toEqual(["archive"]);
    expect(registry.get("archive")).toBe(source);
    expect(() =>
      defineMemorySource({ ...source, interfaceVersion: 99 as unknown as 1 }),
    ).toThrow(/interface version/);
    expect(() => defineMemorySource({ ...source, id: "bad id!" })).toThrow(/source id/);
  });
  it("recalls and expands only from the explicit registered source with no filesystem fallback", async () => {
    const emojiKey = "sess-\u{1F41A}";
    const { source } = fakeSource([
      {
        key: emojiKey,
        revision: "r1",
        metadata: metadata("/work/archive", 1_700_000_100_000),
        records: sessionRecords(emojiKey, ["quicksort notes caf\u00E9", "r\u00E9sum\u00E9 \u{1F41A} details"]),
      },
    ]);
    // Registry without the source: explicit failure, never filesystem discovery.
    const emptyClient = createMemorySourceClient({ sources: createMemorySourceRegistry() });
    const missing = (await emptyClient.recall({ source: "archive", query: "quicksort" })) as Recalled;
    expect(missing.coverage.complete).toBe(false);
    expect(missing.coverage.reasons).toContain("source_not_found");
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const recalled = (await client.recall({ source: "archive", query: "quicksort" })) as Recalled;
    expect(recalled.error).toBeUndefined();
    expect(recalled.coverage.complete).toBe(true);
    expect(recalled.hits.length).toBeGreaterThan(0);
    expect(recalled.hits[0]!.sessionId).toBe(emojiKey);
    const expanded = (await client.expand({
      source: "archive",
      session: emojiKey,
      entryRange: { first: 0, last: 1 },
    })) as Expanded;
    const text = expanded.entries.map((entry) => entry.text).join("\n");
    expect(text).toContain("quicksort notes caf\u00E9");
    expect(text).toContain("r\u00E9sum\u00E9 \u{1F41A} details");
    expect(() =>
      (client.recall as (args: Record<string, unknown>) => Promise<unknown>)({ query: "x" }),
    ).toThrow(/source/);
  });

  it("keeps raw follow and cached continuation calls source-qualified across sessions", async () => {
    const { source } = fakeSource(["one", "two"].map((key) => ({
      key, revision: "r1", records: sessionRecords(key, ["needle first", "needle second", "needle third"]),
    })));
    const sources = createMemorySourceRegistry();
    sources.register(source);
    const provider = new MemoryProvider({
      agentDir: "/nonexistent-agent-dir", cwd: "/work/nowhere", sources,
      config: { enabled: true, maxSessions: 32, maxEntryChars: 2_000, indexThinking: false, indexToolOutput: true },
    });
    type Page = { hits: Array<{ sessionId: string; entryId: string; follow: { ref: string; args: Record<string, unknown> } }>; next: { args: Record<string, unknown> } | null };
    let args: Record<string, unknown> = { source: source.id, query: "needle", pageSize: 1 };
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const page = await provider.invoke("recall", args, invocation()) as Page;
      expect(page.hits).toHaveLength(1);
      const hit = page.hits[0]!;
      expect(hit.follow.args.source).toBe(source.id);
      const expanded = await provider.invoke("expand", hit.follow.args, invocation()) as Expanded;
      expect(expanded.error).toBeUndefined();
      expect(JSON.stringify(expanded.entries)).toContain("needle");
      seen.add(`${hit.sessionId}:${hit.entryId}`);
      if (i < 5) {
        expect(page.next?.args.source).toBe(source.id);
        args = page.next!.args;
      } else expect(page.next).toBeNull();
    }
    expect(seen.size).toBe(6);
  });

  it("expands adapter session keys and display keys interchangeably", async () => {
    const { source } = fakeSource([
      { key: "plain-key", revision: "r1", records: sessionRecords("plain-key", ["hello"]) },
    ]);
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const selection = { entryRange: { first: 0, last: 0 } as const };
    const direct = (await client.expand({
      source: "archive",
      session: "plain-key",
      ...selection,
    })) as Expanded;
    expect(direct.session).toBe("memory-source:archive/plain-key");
    expect(direct.entries.map((entry) => entry.text).join("")).toContain("hello");
    const display = (await client.expand({
      source: "archive",
      session: "memory-source:archive/plain-key",
      ...selection,
    })) as Expanded;
    expect(display.entries.map((entry) => entry.text).join("")).toContain("hello");
  });

  it("lists sessions from the source with honest bounded coverage", async () => {
    const sessions: FakeSession[] = ["a", "b", "c"].map((key, index) => ({
      key,
      revision: "r" + index,
      metadata: metadata("/work/archive", 1_700_000_000_000 + index),
      records: sessionRecords(key, ["content " + key]),
    }));
    const { source } = fakeSource(sessions);
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const listed = (await client.sessions({ source: "archive" })) as Listed;
    expect(listed.error).toBeUndefined();
    expect(listed.scope).toBe("source:archive");
    expect(listed.sessions.map((session) => session.file)).toEqual([
      "memory-source:archive/a",
      "memory-source:archive/b",
      "memory-source:archive/c",
    ]);
    expect(listed.sessions[0]!.cwd).toBe("/work/archive");
    expect(listed.sessions[0]!.entryCount).toBeGreaterThan(0);
    expect(listed.coverage).toBeUndefined();
    const bounded = (await client.sessions({ source: "archive", limit: 2 })) as Listed;
    expect(bounded.sessions).toHaveLength(2);
    expect(bounded.coverage?.complete).toBe(false);
    expect(bounded.coverage?.reasons).toContain("source_limit_exceeded");
  });

  it("keeps explicit-source expand and sessions off the filesystem even on key collision", async () => {
    const { source } = fakeSource([
      {
        key: "collision.jsonl",
        revision: "r1",
        records: sessionRecords("collision.jsonl", ["from the portable source"]),
      },
    ]);
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const provider = new MemoryProvider({
      agentDir: "/nonexistent-agent-dir",
      cwd: "/work/nowhere",
      config: {
        enabled: true,
        maxSessions: 500,
        maxEntryChars: 2_000,
        indexThinking: false,
        indexToolOutput: true,
      },
      sources: registry,
    });
    const expanded = (await provider.invoke(
      "expand",
      { source: "archive", session: "collision.jsonl", entryRange: { first: 0, last: 0 } },
      invocation(),
    )) as Expanded;
    expect(expanded.error).toBeUndefined();
    expect(expanded.entries.map((entry) => entry.text).join("")).toContain("from the portable source");
    expect(expanded.session).toBe("memory-source:archive/collision.jsonl");
    const listed = (await provider.invoke("sessions", { source: "archive" }, invocation())) as Listed;
    expect(listed.scope).toBe("source:archive");
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]!.file).toBe("memory-source:archive/collision.jsonl");
  });
  it("fails closed on unknown sources, revocation, and post-load revocation races", async () => {
    let recallCount = 0;
    const { source } = fakeSource(
      [{ key: "k", revision: "r1", records: sessionRecords("k", ["secret"]) }],
      {
        authorize: (action, sessionKey) => {
          if (action === "recall" && sessionKey === "k") {
            recallCount += 1;
            return recallCount <= 1;
          }
          return action !== "expand";
        },
      },
    );
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const unknown = (await client.recall({ source: "missing", query: "x" })) as Recalled;
    expect(unknown.coverage.reasons).toContain("source_not_found");
    const denied = (await client.expand({ source: "archive", session: "k", entryRange: { first: 0, last: 0 } })) as Expanded;
    expect(denied.error?.code).toBe("source_unauthorized");
    // Authorization is rechecked after the async load; revocation in that window fails closed.
    const racing = (await client.recall({ source: "archive", scope: "session:k" })) as Recalled;
    expect(racing.error?.code ?? racing.coverage.reasons.join(",")).toContain("source_unauthorized");
    const thrown = fakeSource([{ key: "k", revision: "r1", records: [] }], {
      authorize: () => {
        throw new Error("backend exploded with secrets");
      },
    });
    const thrownRegistry = createMemorySourceRegistry();
    thrownRegistry.register(thrown.source);
    const thrownClient = createMemorySourceClient({ sources: thrownRegistry });
    const sanitized = (await thrownClient.sessions({ source: "archive" })) as Listed;
    expect(sanitized.error?.code).toBe("source_unauthorized");
    expect(JSON.stringify(sanitized)).not.toContain("backend exploded");
  });

  it("refuses stale pointers after source revision and rejects malformed snapshots", async () => {
    const sessions: FakeSession[] = [
      { key: "k", revision: "r1", records: sessionRecords("k", ["before edit"]) },
    ];
    const { source } = fakeSource(sessions);
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const first = (await client.expand({ source: "archive", session: "k" })) as Expanded;
    expect(first.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    sessions[0]!.revision = "r2";
    sessions[0]!.records = sessionRecords("k", ["after edit"]);
    const stale = (await client.recall({
      source: "archive",
      scope: "session:k",
      expectedSourceHash: first.sourceHash,
    })) as Recalled;
    expect(stale.error?.code).toBe("stale_pointer");
    const mismatched = fakeSource(
      [{ key: "k", revision: "r1", records: sessionRecords("k", ["x"]) }],
      { dropSnapshotKey: true },
    );
    const mismatchedRegistry = createMemorySourceRegistry();
    mismatchedRegistry.register(mismatched.source);
    const invalid = (await createMemorySourceClient({ sources: mismatchedRegistry }).expand({
      source: "archive",
      session: "k",
    })) as Expanded;
    expect(invalid.error?.code).toBe("invalid_source_response");
  });

  it("folds adapter coverage into engine coverage so truncated archives stay honest", async () => {
    const { source } = fakeSource([
      {
        key: "k",
        revision: "r1",
        records: sessionRecords("k", ["only the first page"]),
        snapshotCoverage: { complete: false, reason: "max_records" },
      },
    ]);
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const recalled = (await client.recall({ source: "archive", query: "first page" })) as Recalled;
    expect(recalled.coverage.complete).toBe(false);
    expect(recalled.coverage.reasons).toContain("source_coverage:max_records");
  });
  it("preserves provenance and trace filters from standard fabric_exec details", async () => {
    const traceRecord = (id: string, parentId: string | null, offset: number): MemorySourceRecord => ({
      type: "message",
      id,
      parentId,
      timestamp: timestamp(offset),
      message: {
        ...toolResult("fabric-call", "fabric_exec", "ignored"),
        details: { trace: recordedIntegrationTrace() },
      },
    });
    const { source } = fakeSource([
      {
        key: "tracey",
        revision: "r1",
        records: [sessionHeader("tracey", "/work/archive"), traceRecord("t1", null, 0)],
      },
    ]);
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const failed = (await client.recall({ source: "archive", outcome: "failed" })) as Recalled;
    expect(failed.total).toBeGreaterThan(0);
    expect(failed.hits.every((hit) => hit.outcome === "failed")).toBe(true);
    const edits = (await client.recall({
      source: "archive",
      ref: "pi.edit",
      outcome: "failed",
    })) as Recalled;
    expect(edits.hits.length).toBeGreaterThan(0);
    expect(edits.hits.every((hit) => hit.ref === "pi.edit")).toBe(true);
  });

  it("expands across branches and paginates losslessly over Unicode text", async () => {
    const records: MemorySourceRecord[] = [
      sessionHeader("branchy", "/work/archive"),
      messageEntry("root", null, timestamp(0), userMessage("root \u{1F680}")),
      messageEntry("leaf-a", "root", timestamp(1), assistantText("leaf a")),
      messageEntry("leaf-b", "root", timestamp(2), assistantText("leaf b")),
    ];
    const { source } = fakeSource([{ key: "branchy", revision: "r1", records }]);
    const registry = createMemorySourceRegistry();
    registry.register(source);
    const client = createMemorySourceClient({ sources: registry });
    const active = (await client.expand({ source: "archive", session: "branchy" })) as Expanded;
    const allMeta = (await client.expand({
      source: "archive",
      session: "branchy",
      branches: "all",
    })) as Expanded;
    expect(allMeta.entryCount).toBeGreaterThan(active.entryCount);
    const all = (await client.expand({
      source: "archive",
      session: "branchy",
      branches: "all",
      entryRange: { first: 0, last: allMeta.entryCount - 1 },
    })) as Expanded;
    expect(all.entries.some((entry) => entry.text.includes("leaf b"))).toBe(true);

    const longText = "caf\u00E9 ".repeat(40) + "\u{1F41A}\u{1F41A}\u{1F41A}fin";
    const { source: pagedSource } = fakeSource([
      {
        key: "paged",
        revision: "r1",
        records: [
          sessionHeader("paged", "/work/archive"),
          messageEntry("p0", null, timestamp(0), userMessage(longText)),
        ],
      },
    ]);
    const pagedRegistry = createMemorySourceRegistry();
    pagedRegistry.register(pagedSource);
    const pagedClient = createMemorySourceClient({ sources: pagedRegistry });
    let page = (await pagedClient.expand({
      source: "archive",
      session: "paged",
      entryRange: { first: 0, last: 0 },
      maxChars: 96,
      maxEntries: 1,
    })) as Expanded;
    let collected = page.entries[0]!.text;
    let guard = 0;
    while (page.next && guard < 200) {
      page = (await pagedClient.expand(
        page.next.args as { source: string; session: string } & Record<string, unknown>,
      )) as Expanded;
      collected += page.entries[0]!.text;
      guard += 1;
    }
    expect(collected).toBe(longText);
    expect(page.next).toBeNull();
  });

  it("exposes managed-proxy action schemas with the source argument", () => {
    for (const name of ["recall", "expand", "sessions"] as const) {
      const schema = memoryActionSchemas[name];
      expect(
        (schema.inputSchema as { properties: Record<string, unknown> }).properties.source,
      ).toBeDefined();
      expect(schema.outputSchema).toBeDefined();
    }
    const expandInput = memoryActionSchemas.expand.inputSchema as { required: string[] };
    expect(expandInput.required).toContain("session");
  });
});