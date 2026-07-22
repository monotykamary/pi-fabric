import { createHash } from "node:crypto";
import type { FabricMainAgentInfo } from "../main-agent.js";
import { MeshStore, type MeshIdentity, type MeshStateEntry } from "../mesh/store.js";
import type {
  FabricHostRecord,
  FabricParticipantInfo,
  FabricParticipantKind,
  FabricParticipantListOptions,
  FabricParticipantRecord,
  FabricParticipantSource,
  FabricPeerInfo,
} from "./types.js";

const PARTICIPANT_PREFIX = "topology/participants/";
const HOST_PREFIX = "topology/hosts/";
const LEGACY_SESSION_PREFIX = "sessions/";
const LEGACY_ACTOR_PREFIX = "actors/";
const PARTICIPANT_HEARTBEAT_MS = 5_000;
const PARTICIPANT_LEASE_MS = 15_000;
const keyFor = (prefix: string, id: string): string =>
  prefix + createHash("sha256").update(id).digest("hex");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const participantKind = (value: unknown): FabricParticipantKind | undefined =>
  value === "root" || value === "agent" || value === "actor" ? value : undefined;

const transports = new Set([
  "host",
  "auto",
  "process",
  "tmux",
  "screen",
  "localterm",
  "herdr",
]);
const capabilities = new Set(["steer", "followUp", "stop", "attach", "fabric"]);

const participantFromEntry = (entry: MeshStateEntry): FabricParticipantRecord | undefined => {
  if (!isObject(entry.value) || entry.value.format !== 1) return undefined;
  const value = entry.value as Partial<FabricParticipantRecord>;
  const kind = participantKind(value.kind);
  if (
    !kind ||
    typeof value.id !== "string" ||
    entry.key !== keyFor(PARTICIPANT_PREFIX, value.id) ||
    typeof value.rootId !== "string" ||
    typeof value.ownerHostId !== "string" ||
    typeof value.ownerIdentityId !== "string" ||
    entry.updatedBy.id !== value.ownerIdentityId ||
    typeof value.name !== "string" ||
    typeof value.status !== "string" ||
    (value.runner !== "pi" && value.runner !== "claude") ||
    typeof value.transport !== "string" ||
    !transports.has(value.transport) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability) => typeof capability === "string" && capabilities.has(capability),
    ) ||
    typeof value.startedAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    value.controlProtocol !== "v1" &&
    value.controlProtocol !== "legacy"
  ) {
    return undefined;
  }
  return value as FabricParticipantRecord;
};

const hostFromEntry = (entry: MeshStateEntry): FabricHostRecord | undefined => {
  if (!isObject(entry.value) || entry.value.format !== 1) return undefined;
  const value = entry.value as Partial<FabricHostRecord>;
  if (
    typeof value.id !== "string" ||
    entry.key !== keyFor(HOST_PREFIX, value.id) ||
    typeof value.rootId !== "string" ||
    !isObject(value.identity) ||
    typeof value.identity.id !== "string" ||
    typeof value.identity.name !== "string" ||
    entry.updatedBy.id !== value.identity.id ||
    (value.identity.kind !== "main" &&
      value.identity.kind !== "agent" &&
      value.identity.kind !== "actor") ||
    typeof value.startedAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    typeof value.expiresAt !== "number"
  ) {
    return undefined;
  }
  return value as FabricHostRecord;
};

const peerFromParticipant = (participant: FabricParticipantInfo): FabricPeerInfo | undefined => {
  if (
    participant.kind !== "root" ||
    !participant.cwd ||
    !participant.sessionId ||
    (participant.status !== "idle" && participant.status !== "running")
  ) {
    return undefined;
  }
  return {
    id: participant.id,
    name: "Peer " + participant.sessionId.slice(0, 8),
    kind: "peer",
    status: participant.status,
    runner: "pi",
    transport: "host",
    cwd: participant.cwd,
    sessionId: participant.sessionId,
    ...(participant.model ? { model: participant.model } : {}),
    ...(participant.thinking ? { thinking: participant.thinking } : {}),
    startedAt: participant.startedAt,
    updatedAt: participant.updatedAt,
    pendingMessages: participant.pendingMessages === true,
    local: false,
  };
};

const legacyRootFromEntry = (
  entry: MeshStateEntry,
  localRootId: string,
  now: number,
): FabricParticipantInfo | undefined => {
  if (now - entry.updatedAt > PARTICIPANT_LEASE_MS || !isObject(entry.value)) return undefined;
  const value = entry.value;
  if (
    typeof value.id !== "string" ||
    value.id === localRootId ||
    typeof value.sessionId !== "string" ||
    entry.key !== `${LEGACY_SESSION_PREFIX}${value.sessionId}` ||
    entry.updatedBy.id !== value.id ||
    typeof value.cwd !== "string" ||
    typeof value.startedAt !== "number" ||
    (value.status !== "idle" && value.status !== "running")
  ) {
    return undefined;
  }
  return {
    format: 1,
    id: value.id,
    kind: "root",
    rootId: value.id,
    ownerHostId: value.id,
    ownerIdentityId: value.id,
    name: typeof value.name === "string" ? value.name : "main",
    status: value.status,
    runner: "pi",
    transport: "host",
    capabilities: ["steer", "followUp", "fabric"],
    cwd: value.cwd,
    sessionId: value.sessionId,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
    startedAt: value.startedAt,
    updatedAt: entry.updatedAt,
    pendingMessages: value.pendingMessages === true,
    controlProtocol: "legacy",
    local: false,
    stale: false,
  };
};

const legacyActorFromEntry = (
  entry: MeshStateEntry,
  roots: Map<string, FabricParticipantInfo>,
): FabricParticipantInfo | undefined => {
  if (!isObject(entry.value)) return undefined;
  const value = entry.value;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.runner !== "pi" && value.runner !== "claude") ||
    typeof value.status !== "string"
  ) {
    return undefined;
  }
  const root = roots.get(entry.updatedBy.id);
  if (
    !root?.sessionId ||
    entry.key !== `${LEGACY_ACTOR_PREFIX}${root.sessionId}/${value.id}`
  ) {
    return undefined;
  }
  const active = value.status !== "stopped";
  return {
    format: 1,
    id: value.id,
    kind: "actor",
    rootId: root.id,
    ownerHostId: root.id,
    ownerIdentityId: entry.updatedBy.id,
    parentId: root.id,
    name: value.name,
    status: value.status,
    runner: value.runner,
    transport: "host",
    capabilities: [
      ...(active ? (["steer", "followUp"] as const) : []),
      ...(value.runner === "pi" ? (["fabric"] as const) : []),
    ],
    startedAt: typeof value.createdAt === "number" ? value.createdAt : entry.updatedAt,
    updatedAt: entry.updatedAt,
    controlProtocol: "legacy",
    local: false,
    stale: false,
  };
};

export interface ParticipantDirectoryOptions {
  enabled: boolean;
  hostId: string;
  rootId: string;
  identity: MeshIdentity;
  selfOwnerHostId?: string;
  selfOwnerIdentityId?: string;
  heartbeatMs?: number;
  leaseMs?: number;
}

export type ParticipantSnapshotSource = () => FabricParticipantRecord[];

export class ParticipantDirectory implements FabricParticipantSource {
  readonly #sources = new Set<ParticipantSnapshotSource>();
  readonly #startedAt = Date.now();
  readonly #heartbeatMs: number;
  readonly #leaseMs: number;
  readonly #localRecords = new Map<string, FabricParticipantRecord>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #refreshing: Promise<void> | undefined;
  #refreshScheduled = false;
  #refreshAgain = false;
  #quiescing = false;

  constructor(
    readonly mesh: MeshStore,
    readonly options: ParticipantDirectoryOptions,
  ) {
    this.#heartbeatMs = Math.max(100, options.heartbeatMs ?? PARTICIPANT_HEARTBEAT_MS);
    this.#leaseMs = Math.max(this.#heartbeatMs * 2, options.leaseMs ?? PARTICIPANT_LEASE_MS);
  }

  registerSource(source: ParticipantSnapshotSource): () => void {
    this.#sources.add(source);
    if (this.#timer) this.scheduleRefresh();
    return () => {
      this.#sources.delete(source);
      if (this.#timer) this.scheduleRefresh();
    };
  }

  async start(): Promise<void> {
    if (this.#timer) return;
    this.#closed = false;
    await this.refresh();
    if (!this.options.enabled) return;
    this.#timer = setInterval(() => void this.refresh().catch(() => undefined), this.#heartbeatMs);
    this.#timer.unref();
  }

  scheduleRefresh(): void {
    if (this.#closed) return;
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return;
    }
    if (this.#refreshScheduled) return;
    this.#refreshScheduled = true;
    queueMicrotask(() => {
      this.#refreshScheduled = false;
      void this.refresh().catch(() => undefined);
    });
  }

  async refresh(): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing) return this.#refreshing;
    const operation = this.#refresh();
    this.#refreshing = operation;
    try {
      await operation;
    } finally {
      if (this.#refreshing === operation) this.#refreshing = undefined;
      if (this.#refreshAgain) {
        this.#refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  list(
    options: FabricParticipantListOptions = {},
    now = Date.now(),
  ): FabricParticipantInfo[] {
    if (!this.options.enabled) {
      const byId = new Map<string, FabricParticipantInfo>();
      for (const participant of this.#localRecords.values()) {
        if (options.scope === "lineage" && participant.rootId !== this.options.rootId) continue;
        if (options.kinds && !options.kinds.includes(participant.kind)) continue;
        byId.set(participant.id, { ...participant, local: true, stale: false });
      }
      const self = this.self(now);
      if (!options.kinds || options.kinds.includes(self.kind)) byId.set(self.id, self);
      return [...byId.values()];
    }
    const hosts = new Map(
      this.mesh
        .listAll(HOST_PREFIX)
        .flatMap((entry) => {
          const host = hostFromEntry(entry);
          return host ? [[host.id, host] as const] : [];
        }),
    );
    const byId = new Map<string, FabricParticipantInfo>();
    for (const entry of this.mesh.listAll(PARTICIPANT_PREFIX)) {
      const participant = participantFromEntry(entry);
      if (!participant) continue;
      const owner = hosts.get(participant.ownerHostId);
      const stale =
        !owner ||
        owner.expiresAt < now ||
        owner.identity.id !== participant.ownerIdentityId ||
        owner.rootId !== participant.rootId;
      if (stale && !options.includeStale) continue;
      if (options.scope === "local" && participant.ownerHostId !== this.options.hostId) continue;
      if (options.scope === "lineage" && participant.rootId !== this.options.rootId) continue;
      if (options.kinds && !options.kinds.includes(participant.kind)) continue;
      byId.set(participant.id, {
        ...participant,
        local: participant.ownerHostId === this.options.hostId,
        stale,
      });
    }
    const legacyRoots = new Map(
      this.mesh
        .listAll(LEGACY_SESSION_PREFIX)
        .flatMap((entry) => {
          const root = legacyRootFromEntry(entry, this.options.rootId, now);
          return root ? [[root.id, root] as const] : [];
        }),
    );
    if (options.scope !== "local" && options.scope !== "lineage") {
      if (!options.kinds || options.kinds.includes("root")) {
        for (const root of legacyRoots.values()) {
          if (!byId.has(root.id)) byId.set(root.id, root);
        }
      }
      if (!options.kinds || options.kinds.includes("actor")) {
        for (const entry of this.mesh.listAll(LEGACY_ACTOR_PREFIX)) {
          const actor = legacyActorFromEntry(entry, legacyRoots);
          if (actor && !byId.has(actor.id)) byId.set(actor.id, actor);
        }
      }
    }
    const self = this.self(now);
    if (
      (!options.kinds || options.kinds.includes(self.kind)) &&
      options.scope !== "project" &&
      !byId.has(self.id)
    ) {
      byId.set(self.id, self);
    }
    return [...byId.values()].sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  }

  get(id: string, now = Date.now()): FabricParticipantInfo | undefined {
    const target = id === "main" ? this.options.rootId : id;
    return this.list({ scope: "project" }, now).find((participant) => participant.id === target);
  }

  self(now = Date.now()): FabricParticipantInfo {
    const existing =
      this.#localRecords.get(this.options.identity.id) ??
      this.mesh
        .listAll(PARTICIPANT_PREFIX)
        .map(participantFromEntry)
        .find((participant) => participant?.id === this.options.identity.id);
    if (existing) {
      return {
        ...existing,
        local: existing.ownerHostId === this.options.hostId,
        stale: false,
      };
    }
    const kind: FabricParticipantKind =
      this.options.identity.kind === "main" ? "root" : this.options.identity.kind;
    return {
      format: 1,
      id: this.options.identity.id,
      kind,
      rootId: this.options.rootId,
      ownerHostId: this.options.selfOwnerHostId ?? this.options.hostId,
      ownerIdentityId: this.options.selfOwnerIdentityId ?? this.options.identity.id,
      ...(kind === "root" ? {} : { parentId: this.options.rootId }),
      name: this.options.identity.name,
      status: "running",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      ...(this.options.identity.sessionId ? { sessionId: this.options.identity.sessionId } : {}),
      startedAt: this.#startedAt,
      updatedAt: now,
      controlProtocol: "v1",
      local: (this.options.selfOwnerHostId ?? this.options.hostId) === this.options.hostId,
      stale: false,
    };
  }

  peers(now = Date.now()): FabricPeerInfo[] {
    return this.list({ scope: "project", kinds: ["root"] }, now)
      .filter((participant) => participant.id !== this.options.rootId)
      .flatMap((participant) => {
        const peer = peerFromParticipant(participant);
        return peer ? [peer] : [];
      });
  }

  root(main: FabricMainAgentInfo): FabricParticipantRecord {
    return {
      format: 1,
      id: main.id,
      kind: "root",
      rootId: main.id,
      ownerHostId: this.options.hostId,
      ownerIdentityId: this.options.identity.id,
      name: "main",
      status: main.status === "running" ? "running" : "idle",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      ...(main.cwd ? { cwd: main.cwd } : {}),
      ...(main.sessionId ? { sessionId: main.sessionId } : {}),
      ...(main.model ? { model: main.model } : {}),
      ...(main.thinking ? { thinking: main.thinking } : {}),
      startedAt: main.startedAt ?? this.#startedAt,
      updatedAt: main.updatedAt,
      pendingMessages: main.pendingMessages,
      controlProtocol: "v1",
    };
  }

  async quiesce(): Promise<void> {
    if (this.#closed || this.#quiescing) return;
    this.#quiescing = true;
    await this.#refreshing?.catch(() => undefined);
    await this.refresh();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#refreshing?.catch(() => undefined);
    if (!this.options.enabled) return;
    const owned = this.mesh
      .listAll(PARTICIPANT_PREFIX)
      .filter((entry) => participantFromEntry(entry)?.ownerHostId === this.options.hostId);
    await Promise.allSettled(owned.map((entry) => this.mesh.delete({ key: entry.key, ifVersion: entry.version })));
    const legacySessionKey = this.#legacySessionKey();
    if (legacySessionKey) {
      const legacy = this.mesh.get(legacySessionKey);
      if (legacy?.updatedBy.id === this.options.identity.id) {
        await this.mesh.delete({ key: legacy.key, ifVersion: legacy.version }).catch(() => undefined);
      }
    }
    const hostEntry = this.mesh.get(keyFor(HOST_PREFIX, this.options.hostId));
    if (hostEntry) await this.mesh.delete({ key: hostEntry.key, ifVersion: hostEntry.version }).catch(() => undefined);
  }

  async #refresh(): Promise<void> {
    const now = Date.now();
    const desired = new Map<string, FabricParticipantRecord>();
    for (const source of this.#sources) {
      for (const candidate of source()) {
        const { task: _task, text: _text, error: _error, ...operational } = candidate as
          FabricParticipantRecord & { task?: unknown; text?: unknown; error?: unknown };
        const record: FabricParticipantRecord = {
          ...operational,
          format: 1,
          ownerHostId: this.options.hostId,
          ownerIdentityId: this.options.identity.id,
          ...(this.#quiescing ? { capabilities: [] } : {}),
          controlProtocol: "v1",
        };
        desired.set(record.id, record);
      }
    }
    this.#localRecords.clear();
    for (const [id, record] of desired) this.#localRecords.set(id, record);
    if (!this.options.enabled) return;

    const host: FabricHostRecord = {
      format: 1,
      id: this.options.hostId,
      rootId: this.options.rootId,
      identity: this.options.identity,
      startedAt: this.#startedAt,
      updatedAt: now,
      expiresAt: now + this.#leaseMs,
    };
    await this.mesh.put({
      key: keyFor(HOST_PREFIX, this.options.hostId),
      value: host,
      identity: this.options.identity,
    });
    const root = [...desired.values()].find(
      (participant) => participant.kind === "root" && participant.id === this.options.rootId,
    );
    const legacySessionKey = this.#legacySessionKey();
    if (legacySessionKey && this.#quiescing) {
      const legacy = this.mesh.get(legacySessionKey);
      if (legacy?.updatedBy.id === this.options.identity.id) {
        await this.mesh
          .delete({ key: legacy.key, ifVersion: legacy.version })
          .catch(() => undefined);
      }
    } else if (root && legacySessionKey && root.cwd && root.sessionId) {
      await this.mesh.put({
        key: legacySessionKey,
        value: {
          id: root.id,
          name: `Peer ${root.sessionId.slice(0, 8)}`,
          kind: "peer",
          status: root.status === "running" ? "running" : "idle",
          runner: "pi",
          transport: "host",
          cwd: root.cwd,
          sessionId: root.sessionId,
          ...(root.model ? { model: root.model } : {}),
          ...(root.thinking ? { thinking: root.thinking } : {}),
          startedAt: root.startedAt,
          updatedAt: now,
          pendingMessages: root.pendingMessages === true,
          local: false,
        },
        identity: this.options.identity,
      });
    }

    const existing = this.mesh
      .listAll(PARTICIPANT_PREFIX)
      .flatMap((entry) => {
        const participant = participantFromEntry(entry);
        return participant?.ownerHostId === this.options.hostId ? [{ entry, participant }] : [];
      });
    const existingById = new Map(existing.map((item) => [item.participant.id, item]));
    const legacyRoots = new Map(
      this.mesh
        .listAll(LEGACY_SESSION_PREFIX)
        .flatMap((entry) => {
          const root = legacyRootFromEntry(entry, this.options.rootId, now);
          return root ? [[root.id, root] as const] : [];
        }),
    );
    const legacyActorOwners = new Map(
      this.mesh
        .listAll(LEGACY_ACTOR_PREFIX)
        .flatMap((entry) => {
          const actor = legacyActorFromEntry(entry, legacyRoots);
          return actor ? [[actor.id, actor.ownerIdentityId] as const] : [];
        }),
    );
    for (const record of desired.values()) {
      const current = existingById.get(record.id);
      if (current && JSON.stringify(current.participant) === JSON.stringify(record)) continue;
      const key = keyFor(PARTICIPANT_PREFIX, record.id);
      const occupied = current?.entry ?? this.mesh.get(key);
      const occupiedParticipant = occupied && participantFromEntry(occupied);
      const legacyOwner = record.kind === "actor" ? legacyActorOwners.get(record.id) : undefined;
      if (!occupiedParticipant && legacyOwner && legacyOwner !== this.options.identity.id) {
        continue;
      }
      if (occupiedParticipant && occupiedParticipant.ownerHostId !== this.options.hostId) {
        const ownerEntry = this.mesh.get(keyFor(HOST_PREFIX, occupiedParticipant.ownerHostId));
        const owner = ownerEntry && hostFromEntry(ownerEntry);
        if (
          owner &&
          owner.expiresAt >= now &&
          owner.identity.id === occupiedParticipant.ownerIdentityId
        ) {
          continue;
        }
      }
      await this.mesh.put({
        key,
        value: record,
        identity: this.options.identity,
        ...(occupied ? { ifVersion: occupied.version } : {}),
      }).catch((error: unknown) => {
        const latest = this.mesh.get(key);
        const latestParticipant = latest && participantFromEntry(latest);
        if (latestParticipant && latestParticipant.ownerHostId !== this.options.hostId) return;
        throw error;
      });
    }
    for (const { entry, participant } of existing) {
      if (desired.has(participant.id)) continue;
      await this.mesh.delete({ key: entry.key, ifVersion: entry.version }).catch(() => undefined);
    }
  }

  #legacySessionKey(): string | undefined {
    if (this.options.identity.kind !== "main") return undefined;
    return `sessions/${this.options.identity.sessionId ?? this.options.identity.id}`;
  }
}
