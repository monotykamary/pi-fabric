import type { FabricAgentRunner, FabricSubagentTransport } from "../config.js";
import type { MeshIdentity } from "../mesh/store.js";
import type { SubagentUsage } from "../subagents/types.js";

export type FabricParticipantKind = "root" | "agent" | "actor";
export type FabricParticipantScope = "local" | "lineage" | "project";
export type FabricParticipantCapability =
  | "steer"
  | "followUp"
  | "stop"
  | "attach"
  | "fabric";

export interface FabricParticipantRecord {
  format: 1;
  id: string;
  kind: FabricParticipantKind;
  rootId: string;
  ownerHostId: string;
  ownerIdentityId: string;
  parentId?: string;
  name: string;
  status: string;
  runner: FabricAgentRunner;
  transport: FabricSubagentTransport | "host";
  capabilities: FabricParticipantCapability[];
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  pendingMessages?: boolean;
  currentTool?: string;
  turns?: number;
  toolCalls?: number;
  usage?: SubagentUsage;
  actorQueued?: number;
  actorMessages?: number;
  controlProtocol: "v1" | "legacy";
}

export interface FabricParticipantInfo extends FabricParticipantRecord {
  local: boolean;
  stale: boolean;
}

export interface FabricHostRecord {
  format: 1;
  id: string;
  rootId: string;
  identity: MeshIdentity;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface FabricParticipantListOptions {
  scope?: FabricParticipantScope;
  kinds?: FabricParticipantKind[];
  includeStale?: boolean;
}

export interface FabricPeerInfo {
  id: string;
  name: string;
  kind: "peer";
  status: "idle" | "running";
  runner: "pi";
  transport: "host";
  cwd: string;
  sessionId: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: false;
}

export interface FabricParticipantSource {
  list(options?: FabricParticipantListOptions, now?: number): FabricParticipantInfo[];
  get(id: string, now?: number): FabricParticipantInfo | undefined;
  self(now?: number): FabricParticipantInfo;
  peers(now?: number): FabricPeerInfo[];
  refresh(): Promise<void>;
  scheduleRefresh(): void;
}
