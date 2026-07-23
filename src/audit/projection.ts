import type { FabricTraceJsonValue } from "./trace.js";

export interface FabricAuditProjection {
  value: { [key: string]: FabricTraceJsonValue };
  droppedValues: number;
}

const emptyProjection = (args: Record<string, unknown>): FabricAuditProjection => ({
  value: {},
  droppedValues: topLevelKeyCount(args),
});

const topLevelKeyCount = (value: Record<string, unknown>): number => {
  try {
    return Object.keys(value).length;
  } catch {
    return 1;
  }
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const isWindowsDrivePath = (value: string): boolean => {
  if (value.length < 3 || value[1] !== ":" || (value[2] !== "\\" && value[2] !== "/")) {
    return false;
  }
  const drive = value.charCodeAt(0);
  return (drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122);
};

const localPath = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  if (!isWindowsDrivePath(value)) {
    try {
      // Absolute and network-path URLs are not local file addresses. In
      // particular, never retain URL userinfo or query credentials as a path.
      const absolute = new URL(value);
      if (absolute.protocol) return undefined;
    } catch {
      // Plain relative and absolute filesystem paths are expected to fail URL
      // construction without a base.
    }
    try {
      const based = new URL(value, "https://fabric.invalid/");
      if (based.hostname !== "fabric.invalid") return undefined;
    } catch {
      return undefined;
    }
  }
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  const end = Math.min(
    query < 0 ? value.length : query,
    fragment < 0 ? value.length : fragment,
  );
  return value.slice(0, end) || undefined;
};

const copyString = (
  output: Record<string, FabricTraceJsonValue>,
  args: Record<string, unknown>,
  key: string,
): void => {
  const value = stringValue(args[key]);
  if (value !== undefined) output[key] = value;
};

const copyNumber = (
  output: Record<string, FabricTraceJsonValue>,
  args: Record<string, unknown>,
  key: string,
): void => {
  const value = finiteNumber(args[key]);
  if (value !== undefined) output[key] = value;
};

const structuralIdentifier = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const alphanumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);
    if (alphanumeric) continue;
    if (index > 0 && (code === 45 || code === 46 || code === 47 || code === 58 || code === 95)) {
      continue;
    }
    return undefined;
  }
  return value;
};

const copyIdentifier = (
  output: Record<string, FabricTraceJsonValue>,
  args: Record<string, unknown>,
  key: string,
): void => {
  const value = structuralIdentifier(args[key]);
  if (value !== undefined) output[key] = value;
};

const copyPath = (
  output: Record<string, FabricTraceJsonValue>,
  args: Record<string, unknown>,
): void => {
  const value = localPath(args.path);
  if (value !== undefined) output.path = value;
};

const projected = (
  args: Record<string, unknown>,
  build: (output: Record<string, FabricTraceJsonValue>) => void,
): FabricAuditProjection => {
  const value: Record<string, FabricTraceJsonValue> = {};
  try {
    build(value);
  } catch {
    return emptyProjection(args);
  }
  return {
    value,
    droppedValues: Math.max(0, topLevelKeyCount(args) - Object.keys(value).length),
  };
};

const idOnlyAgentActions = new Set([
  "agents.wait",
  "agents.status",
  "agents.stop",
  "agents.cleanup",
  "agents.ask",
  "agents.tell",
  "agents.steer",
  "agents.followUp",
  "agents.setSteeringMode",
  "agents.setFollowUpMode",
  "agents.compact",
  "agents.actorStatus",
  "agents.setModel",
  "agents.setThinking",
  "agents.setTools",
  "agents.setEvents",
  "agents.setDeliveryPolicy",
  "agents.clearMessages",
  "agents.setInstructions",
  "agents.messages",
  "agents.remove",
  "agents.import",
  "agents.export",
  "agents.log",
]);

/**
 * Projects invocation arguments by exact built-in reference. Unknown,
 * extension, MCP, schema, state, compact, and generic provider calls retain no
 * arguments. This allowlist, rather than secret-looking string matching, is
 * the durable trace's primary confidentiality boundary.
 */
export const projectFabricAuditArgs = (
  ref: string,
  args: Record<string, unknown>,
): FabricAuditProjection => {
  switch (ref) {
    case "fabric.discovery.providers":
    case "fabric.discovery.models":
    case "fabric.workflow.progress":
      return emptyProjection(args);
    case "fabric.approval.auto":
      return projected(args, (output) => {
        copyIdentifier(output, args, "action");
        copyIdentifier(output, args, "risk");
      });
    case "fabric.discovery.catalog":
      return projected(args, (output) => {
        copyIdentifier(output, args, "provider");
        copyNumber(output, args, "limit");
      });
    case "fabric.discovery.list":
      return projected(args, (output) => {
        copyIdentifier(output, args, "provider");
        copyIdentifier(output, args, "namespace");
        copyNumber(output, args, "limit");
      });
    case "fabric.discovery.search":
      return projected(args, (output) => copyNumber(output, args, "limit"));
    case "fabric.discovery.describe":
      return projected(args, (output) => copyIdentifier(output, args, "ref"));
    case "fabric.workflow.configure":
      return projected(args, (output) => copyString(output, args, "name"));
    case "fabric.workflow.phase":
      return projected(args, (output) => {
        copyString(output, args, "name");
        copyIdentifier(output, args, "id");
        copyNumber(output, args, "total");
      });
    case "fabric.workflow.item":
      return projected(args, (output) => {
        copyIdentifier(output, args, "id");
        copyIdentifier(output, args, "status");
        copyIdentifier(output, args, "phase");
        copyIdentifier(output, args, "kind");
        copyNumber(output, args, "total");
        copyNumber(output, args, "completed");
      });
    case "fabric.workflow.event":
      return projected(args, (output) => copyIdentifier(output, args, "level"));
    case "fabric.workflow.parallel":
    case "fabric.workflow.pipeline":
      return projected(args, (output) => {
        copyIdentifier(output, args, "kind");
        copyNumber(output, args, "itemCount");
        copyNumber(output, args, "stageCount");
        copyNumber(output, args, "concurrency");
      });
    case "pi.read":
      return projected(args, (output) => {
        copyPath(output, args);
        copyNumber(output, args, "offset");
        copyNumber(output, args, "limit");
      });
    case "pi.grep":
      return projected(args, (output) => {
        copyPath(output, args);
        copyNumber(output, args, "context");
        copyNumber(output, args, "limit");
      });
    case "pi.find":
    case "pi.ls":
      return projected(args, (output) => {
        copyPath(output, args);
        copyNumber(output, args, "limit");
      });
    case "pi.edit":
    case "pi.write":
      return projected(args, (output) => copyPath(output, args));
    case "pi.bash":
      return projected(args, (output) => copyString(output, args, "command"));
    case "mesh.publish":
      return projected(args, (output) => {
        copyString(output, args, "topic");
        copyString(output, args, "to");
      });
    case "mesh.read":
      return projected(args, (output) => {
        copyString(output, args, "topic");
        copyString(output, args, "to");
        copyNumber(output, args, "after");
        copyNumber(output, args, "limit");
      });
    case "mesh.get":
    case "mesh.put":
    case "mesh.delete":
      return projected(args, (output) => copyString(output, args, "key"));
    case "mesh.list":
      return projected(args, (output) => {
        copyString(output, args, "prefix");
        copyNumber(output, args, "limit");
      });
    default:
      if (idOnlyAgentActions.has(ref)) {
        return projected(args, (output) => copyString(output, args, "id"));
      }
      return emptyProjection(args);
  }
};

/**
 * Results are omitted except for the exact boolean creation outcome emitted by
 * pi.write. No provider details or output text accompany that flag.
 */
export const projectFabricAuditResult = (
  ref: string,
  result: unknown,
): FabricAuditProjection | undefined => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  if (ref === "fabric.approval.auto") {
    return projected(record, (output) => {
      copyIdentifier(output, record, "action");
      copyIdentifier(output, record, "risk");
      copyIdentifier(output, record, "decision");
      copyIdentifier(output, record, "model");
      copyNumber(output, record, "at");
    });
  }
  if (ref !== "pi.write") return undefined;
  const details =
    typeof record.details === "object" && record.details !== null && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  if (record.created !== true && details?.created !== true) return undefined;
  return {
    value: { created: true },
    droppedValues: Math.max(0, topLevelKeyCount(record) - 1),
  };
};
