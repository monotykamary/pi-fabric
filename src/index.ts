import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FabricState } from "./fabric-state.js";
import {
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProviderRegistration,
} from "./protocol.js";

const RESULT_FORMATS = ["auto", "json", "text"] as const;
type ResultFormat = (typeof RESULT_FORMATS)[number];

const formatValue = (value: unknown, format: ResultFormat): string => {
  if (value === undefined) return "";
  if (format === "text" && typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, format === "json" || format === "auto" ? 2 : 0);
  } catch {
    return String(value);
  }
};

const truncateMiddle = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  const marker = `\n\n... ${value.length - maxChars} characters omitted by Pi Fabric ...\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
};

const registrationFrom = (value: unknown): FabricProviderRegistration | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registration = value as Partial<FabricProviderRegistration>;
  const provider = registration.provider;
  if (
    registration.version !== 1 ||
    typeof provider !== "object" ||
    provider === null ||
    typeof provider.name !== "string" ||
    typeof provider.description !== "string" ||
    typeof provider.list !== "function" ||
    typeof provider.describe !== "function" ||
    typeof provider.invoke !== "function"
  ) {
    return undefined;
  }
  return registration as FabricProviderRegistration;
};

export default function piFabric(pi: ExtensionAPI): void {
  const state = new FabricState(pi);

  pi.events.on(FABRIC_PROVIDER_REGISTER_EVENT, (value: unknown) => {
    const registration = registrationFrom(value);
    if (!registration) throw new Error("Invalid Pi Fabric provider registration");
    state.registerExternal(
      registration.provider,
      registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
    );
  });

  pi.registerTool({
    name: "fabric_exec",
    label: "Fabric",
    description:
      "Execute type-checked TypeScript in a QuickJS sandbox and compose Pi tools, MCP tools, child agents, councils, and recursive queries. Prefer this for workflows with multiple dependent calls, parallel work, filtering, or large intermediate results.",
    promptSnippet: "Execute a typed program over Pi tools, MCP, and guarded subagents",
    promptGuidelines: [
      "Use fabric_exec for workflows with multiple calls, loops, filtering, aggregation, MCP tools, or subagents; use direct Pi tools for one simple operation.",
      "Inside Fabric, discover capabilities with tools.providers(), tools.search(), and tools.describe(). Call built-ins through pi.*, MCP through mcp.<server>.<tool>(), and child agents through agents.*.",
      "Use Promise.all for independent calls. Return only the compact final value; intermediate results remain inside the sandbox.",
      "Use council.run() for bounded multi-perspective review and rlm.query() only when recursive decomposition is genuinely useful.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description:
          "TypeScript function body. Top-level await and return are supported. Available globals: tools, pi, mcp, agents, council, rlm, print, and π.",
      }),
      strings: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Named strings exposed as π.key, useful for content that is awkward to quote",
        }),
      ),
      resultFormat: Type.Optional(Type.Union(RESULT_FORMATS.map((value) => Type.Literal(value)))),
    }),
    async execute(toolCallId, params, signal, onUpdate, context) {
      await state.ensure(context);
      const result = await state.execution.execute({
        code: params.code,
        ...(params.strings ? { strings: params.strings } : {}),
        signal,
        parentToolCallId: toolCallId,
        context,
        update(message) {
          onUpdate?.({
            content: [{ type: "text", text: message }],
            details: { progress: message },
          });
        },
      });

      if (result.typeErrors) {
        const text = result.typeErrors
          .map((error) =>
            error.line > 0
              ? `Line ${error.line}:${error.column} — ${error.message}`
              : error.message,
          )
          .join("\n");
        return {
          content: [{ type: "text", text: `Type errors; code was not executed:\n${text}` }],
          details: result,
          isError: true,
        };
      }

      const sections = [...result.logs];
      const formattedValue = formatValue(result.value, params.resultFormat ?? "auto");
      if (formattedValue) sections.push(formattedValue);
      if (result.error) sections.push(`Runtime error: ${result.error}`);
      const output = truncateMiddle(
        sections.join("\n\n") || "(no output)",
        state.config.executor.maxOutputChars,
      );
      return {
        content: [{ type: "text", text: output }],
        details: result,
        ...(result.success ? {} : { isError: true }),
      };
    },
  });

  pi.on("session_start", async (_event, context) => {
    await state.initialize(context);
  });

  pi.on("session_shutdown", async () => {
    await state.shutdown();
  });

  pi.on("before_agent_start", async (event) => {
    if (!pi.getActiveTools().includes("fabric_exec")) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nPi Fabric is available for programmatic composition. Keep simple one-call tasks on direct tools. For Fabric-shaped work, use tools.search()/tools.describe() for progressive discovery instead of guessing external tool schemas.`,
    };
  });

  pi.registerCommand("fabric", {
    description: "Inspect or reload Pi Fabric; manage Fabric subagents",
    async handler(argumentsText, context) {
      await state.ensure(context);
      const [command = "status", ...argumentsList] = argumentsText.trim().split(/\s+/).filter(Boolean);
      if (command === "reload") {
        await state.initialize(context);
        context.ui.notify("Pi Fabric reloaded", "info");
        return;
      }
      if (command === "providers") {
        const providers = state.registry.providers();
        context.ui.notify(
          providers.map((provider) => `${provider.name} — ${provider.description}`).join("\n"),
          "info",
        );
        return;
      }
      if (command === "agents") {
        const agents = state.subagents.list();
        context.ui.notify(
          agents.length > 0
            ? agents
                .map((agent) =>
                  `${agent.id.slice(0, 8)} ${agent.status} ${agent.transport} — ${agent.name}`,
                )
                .join("\n")
            : "No Fabric subagents",
          "info",
        );
        return;
      }
      if (command === "stop") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /fabric stop <id>", "warning");
          return;
        }
        const agent = state.subagents.list().find((candidate) => candidate.id.startsWith(id));
        if (!agent) {
          context.ui.notify(`Unknown Fabric subagent: ${id}`, "error");
          return;
        }
        await state.subagents.stop(agent.id);
        context.ui.notify(`Stopped Fabric subagent ${agent.id.slice(0, 8)}`, "info");
        return;
      }
      if (command === "attach") {
        const id = argumentsList[0];
        const agent = id
          ? state.subagents.list().find((candidate) => candidate.id.startsWith(id))
          : undefined;
        if (!agent?.attachCommand) {
          context.ui.notify("No attachable Fabric subagent found", "warning");
          return;
        }
        context.ui.notify(agent.attachCommand, "info");
        return;
      }
      if (command !== "status") {
        context.ui.notify(
          "Usage: /fabric [status|reload|providers|agents|attach <id>|stop <id>]",
          "warning",
        );
        return;
      }
      const config = state.config;
      context.ui.notify(
        [
          `cwd: ${state.cwd}`,
          `providers: ${state.registry.providers().map((provider) => provider.name).join(", ")}`,
          `transport: ${config.subagents.transport}`,
          `subagent limits: concurrency ${config.subagents.maxConcurrent}, depth ${config.subagents.maxDepth}`,
          `MCP: ${config.mcp.enabled ? "enabled" : "disabled"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}

export * from "./protocol.js";
