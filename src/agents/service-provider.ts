import type { FabricProvider } from "../protocol.js";
import { AgentService } from "./service.js";
import { agentServiceArgs, agentServiceDescriptors } from "./service-schema.js";
import type { AgentServiceAction, AgentServiceCapabilities, AgentServiceClient, AgentServiceDispatcher, AgentPublicRecord, AgentServiceRequest, AgentSessionRecord } from "./service-types.js";

/** Bind only authenticated host identity here. Guest arguments never carry the caller. */
export function createAgentServiceHandler(service: AgentService, callerId: string): AgentServiceDispatcher {
  return async (action, input, signal) => {
    const args = agentServiceArgs(action, input);
    switch (action) {
      case "run": return service.run(callerId, args as unknown as AgentServiceRequest, signal);
      case "spawn": return service.spawn(callerId, args as unknown as AgentServiceRequest, signal);
      case "wait": return service.wait(callerId, args.id as string, signal);
      case "status": return service.status(callerId, args.id as string);
      case "list": return service.list(callerId);
      case "stop": return service.stop(callerId, args.id as string);
      case "steer": return service.steer(callerId, args.id as string, args.message as string);
      case "followUp": return service.followUp(callerId, args.id as string, args.message as string);
      case "compact": return service.compact(callerId, args.id as string, args.instructions as string | undefined);
      case "resume": return service.resume(callerId, args.id as string, args.task as string | undefined, signal);
      case "sessions": return service.sessions(callerId);
      case "peers": return service.peers(callerId);
      case "self": return service.self(callerId);
      case "members": return service.members(callerId);
      case "create": return service.create(callerId, args as {name: string; instructions?: string; task?: string}, signal);
      case "remove": return service.remove(callerId, args.id as string, args.name as string | undefined, signal);
      default: throw new Error(`Unsupported hosted agents action: ${String(action)}`);
    }
  };
}

/** A transport client only; all admission and lifecycle remain in the root service. */
export function createAgentServiceClient(dispatch: AgentServiceDispatcher, capabilities: AgentServiceCapabilities = {}): AgentServiceClient {
  const record = (action: AgentServiceAction, args: Record<string, unknown>, signal?: AbortSignal) => dispatch(action, args, signal) as Promise<AgentPublicRecord>;
  return {
    capabilities: Object.freeze({...capabilities}), dispatch,
    run: (request, signal) => record("run", request as unknown as Record<string, unknown>, signal),
    spawn: (request, signal) => record("spawn", request as unknown as Record<string, unknown>, signal),
    wait: (id, signal) => record("wait", {id}, signal),
    status: (id) => record("status", {id}),
    list: () => dispatch("list", {}) as Promise<AgentPublicRecord[]>,
    stop: (id) => record("stop", {id}),
    steer: (id, message) => record("steer", {id, message}),
    compact: (id, instructions) => record("compact", {id, ...(instructions !== undefined ? {instructions} : {})}),
    resume: (id, task, signal) => record("resume", {id, ...(task !== undefined ? {task} : {})}, signal),
    followUp: (id, message) => record("followUp", {id, message}),
    sessions: () => dispatch("sessions", {}) as Promise<AgentSessionRecord[]>,
    peers: () => dispatch("peers", {}) as Promise<AgentSessionRecord[]>,
    self: () => dispatch("self", {}) as Promise<AgentSessionRecord>,
    members: () => dispatch("members", {}) as Promise<AgentSessionRecord[]>,
    create: (request, signal) => dispatch("create", request as unknown as Record<string, unknown>, signal) as Promise<AgentSessionRecord>,
    remove: (id, name, signal) => dispatch("remove", {id, ...(name !== undefined ? {name} : {})}, signal) as Promise<AgentSessionRecord>,
  };
}

export function createAgentsProvider(client: AgentServiceClient): FabricProvider {
  const descriptors = agentServiceDescriptors(client.capabilities);
  const allowed = new Set(descriptors.map((descriptor) => descriptor.name));
  const validate = (action: string, args: Record<string, unknown>) => {
    if (!allowed.has(action)) throw new Error(`Unsupported hosted agents action: ${action}`);
    return agentServiceArgs(action as AgentServiceAction, args);
  };
  return {
    name: "agents", description: "Fabric host-authorized Pi agents",
    list: async () => structuredClone(descriptors),
    describe: async (name) => structuredClone(descriptors.find((descriptor) => descriptor.name === name)),
    prepareArguments: (action, args) => validate(action, args),
    invoke: async (action, args, context) => client.dispatch(action as AgentServiceAction, validate(action, args), context.signal),
  };
}
