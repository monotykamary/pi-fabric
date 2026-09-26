export interface FabricCacheHoldOptions {
  /** self is the local Pi session; main is accepted only in a root Pi runtime. */
  target?: "self" | "main";
  durationMs: number;
  /** Requires native admission support; currently returns unsupported, never ignored. */
  maxRefreshes?: number;
  /** Requires native admission support; currently returns unsupported, never ignored. */
  maxCostUsd?: number;
}

export interface FabricCacheLease {
  id: string;
  scope: "session" | "component";
  sessionId: string;
  model: string;
  expiresAt: number;
}

export type FabricCacheHoldResult =
  | ({ status: "held" } & FabricCacheLease)
  | { status: "unsupported" | "unavailable"; reason: string };

export interface FabricCacheSample {
  entryId: string;
  observedAt: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  totalInput: number;
  cacheReadShare: number;
  reportedCostUsd: number | null;
}

export interface FabricCacheObservation {
  lastRequest: FabricCacheSample | null;
  lastRefresh: FabricCacheSample | null;
  maintenance: {
    requests: number;
    tokens: number;
    reportedCostUsd: number;
    unknownCostRequests: number;
    unknownTokenRequests: number;
  };
  window: { entries: number; limit: number; truncated: boolean; stoppedAt: string | null };
}

export interface FabricCacheStatus {
  target: "self";
  sessionId: string;
  model: string | null;
  supported: boolean;
  reason: string | null;
  limits: { durationMs: true; maxRefreshes: false; maxCostUsd: false };
  leases: FabricCacheLease[];
  /** Native scheduling/residency is not observable through the scoped lease API. */
  scheduled: null;
  cleanupError: string | null;
  observation: FabricCacheObservation;
}
