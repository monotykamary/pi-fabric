/** Portable hosted agents: no local manager, filesystem, model registry or ambient configuration. */
export { AgentService } from "./agents/service.js";
export { createAgentsProvider, createAgentServiceClient, createAgentServiceHandler } from "./agents/service-provider.js";
export { agentServiceDescriptors } from "./agents/service-schema.js";
export type * from "./agents/service-types.js";
export type { AgentRunRequest, AgentRunRecord, AgentRunResult, AgentHandleInfo, AgentUsage } from "./agents/types.js";
export const HOSTED_AGENTS_PROTOCOL_VERSION = 1 as const;
