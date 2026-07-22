import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MeshIdentity } from "./mesh/store.js";

const MAIN_AGENT_ALIAS = "main";
const MAIN_AGENT_MESSAGE_MAX_CHARS = 8_000;

export type FabricAgentMessageDelivery = "steer" | "followUp";

export interface FabricMainAgentInfo {
  id: string;
  name: "Main";
  kind: "main";
  status: "idle" | "running" | "remote";
  runner: "pi";
  transport: "host";
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt?: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: boolean;
}

export interface FabricMainAgentDeliveryRequest {
  from: MeshIdentity;
  message: string;
  delivery: FabricAgentMessageDelivery;
  data?: unknown;
}

export interface FabricAgentMessageResult {
  queued: true;
  messageId: string;
  routed: "local" | "main" | "mesh";
  acknowledged?: boolean;
}

export interface FabricMainAgentTarget {
  readonly id: string;
  readonly local: boolean;
  matches(id: string): boolean;
  info(context?: ExtensionContext): FabricMainAgentInfo;
  deliverAgent(request: FabricMainAgentDeliveryRequest): FabricAgentMessageResult;
}

export interface FabricIdentityResolution {
  identity: MeshIdentity;
  mainAgentId: string;
}

export const resolveFabricIdentity = (
  sessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): FabricIdentityResolution => {
  const actorId = environment.PI_FABRIC_ACTOR_ID?.trim();
  const parentAgentId = environment.PI_FABRIC_PARENT_RUN?.trim();
  const identity: MeshIdentity = actorId
    ? {
        id: actorId,
        name: environment.PI_FABRIC_ACTOR_NAME?.trim() || actorId.slice(0, 8),
        kind: "actor",
        sessionId,
      }
    : parentAgentId
      ? {
          id: parentAgentId,
          name: environment.PI_FABRIC_AGENT_NAME?.trim() || parentAgentId.slice(0, 8),
          kind: "agent",
          sessionId,
        }
      : { id: `session:${sessionId}`, name: "main", kind: "main", sessionId };
  const inheritedMainAgentId = environment.PI_FABRIC_MAIN_AGENT_ID?.trim();
  return {
    identity,
    mainAgentId:
      inheritedMainAgentId || (identity.kind === "main" ? identity.id : `session:${sessionId}`),
  };
};

const escapeXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const boundedMessage = (value: string): string =>
  value.length > MAIN_AGENT_MESSAGE_MAX_CHARS
    ? `${value.slice(0, MAIN_AGENT_MESSAGE_MAX_CHARS)}\n[agent message truncated]`
    : value;

const boundedData = (value: unknown): unknown => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    if (serialized.length <= MAIN_AGENT_MESSAGE_MAX_CHARS) {
      return JSON.parse(serialized) as unknown;
    }
    return {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, MAIN_AGENT_MESSAGE_MAX_CHARS - 200),
    };
  } catch {
    return { fabricTruncated: true, preview: String(value).slice(0, 1_000) };
  }
};

export class MainAgentController implements FabricMainAgentTarget {
  readonly startedAt = Date.now();

  constructor(
    readonly pi: ExtensionAPI,
    readonly id: string,
    readonly local: boolean,
    readonly cwd: string,
    readonly sessionId?: string,
  ) {}

  matches(id: string): boolean {
    const target = id.trim();
    return target === MAIN_AGENT_ALIAS || target === this.id;
  }

  info(context?: ExtensionContext): FabricMainAgentInfo {
    const model =
      this.local && context?.model
        ? `${context.model.provider}/${context.model.id}`
        : undefined;
    const thinking = this.local ? this.pi.getThinkingLevel() : undefined;
    return {
      id: this.id,
      name: "Main",
      kind: "main",
      status: this.local ? (context?.isIdle() === false ? "running" : "idle") : "remote",
      runner: "pi",
      transport: "host",
      ...(this.local ? { cwd: this.cwd, startedAt: this.startedAt } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      updatedAt: Date.now(),
      pendingMessages: this.local ? (context?.hasPendingMessages() ?? false) : false,
      local: this.local,
    };
  }

  deliverUser(message: string, delivery: FabricAgentMessageDelivery): FabricAgentMessageResult {
    if (!this.local) throw new Error(`Main agent ${this.id} is owned by another Fabric process`);
    const text = message.trim();
    if (!text) throw new Error("Main agent message must not be empty");
    const messageId = randomUUID();
    this.pi.sendUserMessage(text, { deliverAs: delivery });
    return { queued: true, messageId, routed: "main" };
  }

  deliverAgent(request: FabricMainAgentDeliveryRequest): FabricAgentMessageResult {
    if (!this.local) throw new Error(`Main agent ${this.id} is owned by another Fabric process`);
    const message = boundedMessage(request.message.trim());
    if (!message) throw new Error("Main agent message must not be empty");
    const messageId = randomUUID();
    const data = request.data === undefined ? undefined : boundedData(request.data);
    this.pi.sendMessage(
      {
        customType: "pi-fabric-agent-message",
        content: [
          `<fabric-agent-message from_name=${JSON.stringify(request.from.name)} from_id=${JSON.stringify(request.from.id)} from_kind=${JSON.stringify(request.from.kind)}>`,
          escapeXmlText(message),
          data === undefined ? undefined : `<data>${escapeXmlText(JSON.stringify(data))}</data>`,
          "</fabric-agent-message>",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        display: true,
        details: {
          id: messageId,
          from: structuredClone(request.from),
          delivery: request.delivery,
          ...(data === undefined ? {} : { data }),
        },
      },
      { deliverAs: request.delivery, triggerTurn: true },
    );
    return { queued: true, messageId, routed: "main" };
  }
}
