import { Value } from "typebox/value";
import { AGENTS_ACTION_DESCRIPTORS } from "../providers/agents-actions.js";
import { actionArgNormalizer } from "../providers/arg-normalization.js";
import type { FabricActionDescriptor } from "../protocol.js";
import { assertAgentTask } from "./lifecycle.js";
import { normalizeAgentRunRequest } from "./request.js";
import type { AgentServiceAction, AgentServiceCapabilities, AgentServiceRequest } from "./service-types.js";

const native = (name: string): FabricActionDescriptor => {
  const descriptor = AGENTS_ACTION_DESCRIPTORS.find((entry) => entry.name === name);
  if (!descriptor) throw new Error(`Missing native agent descriptor: ${name}`);
  return structuredClone(descriptor);
};
const run = native("run");
const properties = { ...(run.inputSchema as {properties: Record<string, unknown>}).properties };
for (const key of ["transport", "persona"]) delete properties[key];
Object.assign(properties, {
  runner: {type: "string", enum: ["pi"]},
  kernel: {type: "string", enum: ["typescript", "inherit"]},
  extensions: {type: "boolean", const: true},
  worktree: {type: "boolean", const: false},
  timeoutMs: {type: "number", minimum: 1},
  cwd: {type: "string", description: "Host-authorized placement selector; never resolved by Fabric"},
  images: {type: "array", items: {type: "object", properties: {type: {const: "image"}, data: {type: "string"}, mimeType: {type: "string"}}, required: ["type", "data", "mimeType"], additionalProperties: false}},
  systemPrompt: {type: "string"},
});
const runSchema = {type: "object", properties, required: ["task"], additionalProperties: false};
const id = {type: "string", minLength: 1};
const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({type: "object", properties, required, additionalProperties: false});

export function agentServiceDescriptors(capabilities: AgentServiceCapabilities = {}): FabricActionDescriptor[] {
  const descriptors: FabricActionDescriptor[] = [
    {...run, description: "Run one host-authorized Pi child and wait for its result or pause", inputSchema: runSchema},
    {...native("spawn"), description: "Admit one host-authorized Pi child and return its record", inputSchema: runSchema},
    ...["wait", "status", "stop"].map((name) => ({...native(name), inputSchema: object({id}, ["id"])})),
    {...native("list"), description: "List only the authenticated caller's direct children", inputSchema: object({})},
  ];
  if (capabilities.steer) descriptors.push({...native("steer"), inputSchema: object({id, message: {type: "string", minLength: 1}}, ["id", "message"])});
  if (capabilities.compact) descriptors.push({...native("compact"), inputSchema: object({id, instructions: {type: "string"}}, ["id"])});
  if (capabilities.resume) descriptors.push({name: "resume", description: "Continue a paused, completed or failed direct child from its host checkpoint and wait for result or pause", risk: "agent", inputSchema: object({id, task: {type: "string", minLength: 1}}, ["id"])});
  return descriptors;
}

const descriptors = agentServiceDescriptors({steer: true, compact: true, resume: true});
const normalize = actionArgNormalizer(() => descriptors);
export function agentServiceArgs(action: AgentServiceAction, input: Record<string, unknown>): Record<string, unknown> {
  const descriptor = descriptors.find((entry) => entry.name === action);
  if (!descriptor) throw new Error(`Unsupported hosted agents action: ${action}`);
  const args = normalize(action, input);
  if (!Value.Check(descriptor.inputSchema, args)) {
    const reasons = [...Value.Errors(descriptor.inputSchema, args)].slice(0, 5).map((error) => `${error.instancePath}: ${error.message}`);
    throw new Error(`Invalid hosted agents.${action} arguments: ${reasons.join("; ")}`);
  }
  return args;
}

export function normalizeAgentServiceRequest(input: AgentServiceRequest): AgentServiceRequest {
  const args = agentServiceArgs("run", input as unknown as Record<string, unknown>);
  const request = normalizeAgentRunRequest(args, {runner: "pi", timeoutMs: 0}) as AgentServiceRequest;
  if (args.images !== undefined) request.images = structuredClone(args.images) as NonNullable<AgentServiceRequest["images"]>;
  if (args.systemPrompt !== undefined) request.systemPrompt = args.systemPrompt as string;
  assertAgentTask(request);
  return structuredClone(request);
}
