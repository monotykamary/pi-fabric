import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import { Type } from "typebox";
import { CapturedToolCatalog } from "./capture/catalog.js";
import { installRegisteredToolCapture } from "./capture/interceptor.js";
import { FabricState } from "./fabric-state.js";
import { FABRIC_PROVIDER_REGISTER_EVENT, type FabricProviderRegistration } from "./protocol.js";

const RESULT_FORMATS = ["auto", "json", "text"] as const;
type ResultFormat = (typeof RESULT_FORMATS)[number];

const safeTerminalText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00";
    return `\\x${code}`;
  });

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

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

export default async function piFabric(pi: ExtensionAPI): Promise<void> {
  await loadCodePreviewSettings(process.cwd());
  const capturedTools = new CapturedToolCatalog();
  const state = new FabricState(pi, capturedTools);

  pi.events.on(FABRIC_PROVIDER_REGISTER_EVENT, (value: unknown) => {
    const registration = registrationFrom(value);
    if (!registration) throw new Error("Invalid Pi Fabric provider registration");
    state.registerExternal(
      registration.provider,
      registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
    );
  });

  const fabricTool = withCodePreviewShell(
    defineTool({
      name: "fabric_exec",
      label: "Fabric",
      description:
        "Execute type-checked TypeScript in a QuickJS sandbox and lazily compose Pi tools, captured extension tools, MCP tools, workflows, persistent actors, durable mesh coordination, councils, and recursive queries. Prefer this for multi-step or multi-agent work.",
      promptSnippet:
        "Discover and compose captured extension tools, workflows, persistent actors, and mesh state",
      promptGuidelines: [
        "Use fabric_exec for workflows with multiple calls, loops, filtering, aggregation, MCP tools, or subagents; use direct Pi tools for one simple operation.",
        "Inside Fabric, discover capabilities with tools.providers(), tools.search(), and tools.describe(). Call built-ins through pi.*, captured extension tools through extensions.* or tools.call(), MCP through mcp.<server>.<tool>(), child agents and persistent actors through agents.*, and coordination through mesh.*.",
        "For scripted fan-out use workflow.agent(), workflow.parallel(), workflow.pipeline(), and workflow.phase(); the short aliases agent(), parallel(), pipeline(), and phase() are also available.",
        "Use agents.create() for persistent mailbox actors. Subscribe them to host events for ambient behavior or mesh topics for peer coordination; use directive response mode when silence/intervention is conditional.",
        "Return only the compact final value; intermediate results remain inside the sandbox. Use council.run() or rlm.query() only when their extra cost is justified.",
      ],
      parameters: Type.Object({
        code: Type.String({
          description:
            "TypeScript function body. Top-level await and return are supported. Available globals include tools, pi, extensions, mcp, agents, mesh, workflow, agent, parallel, pipeline, phase, council, rlm, print, and π.",
        }),
        strings: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              "Named strings exposed as π.key, useful for content that is awkward to quote",
          }),
        ),
        resultFormat: Type.Optional(Type.Union(RESULT_FORMATS.map((value) => Type.Literal(value)))),
        tokenBudget: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "Optional token budget observed by workflow.agent() calls",
          }),
        ),
        agentBudget: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "Optional agent-call cap, bounded by Fabric configuration",
          }),
        ),
      }),
      renderCall(params, theme, context) {
        const lines = safeTerminalText(params.code).split("\n");
        const limit = context.expanded ? lines.length : 8;
        const shown = lines.slice(0, limit);
        const width = String(Math.max(1, shown.length)).length;
        const preview = shown
          .map(
            (line, index) =>
              `${theme.fg("dim", String(index + 1).padStart(width, " "))} ${theme.fg("muted", line || " ")}`,
          )
          .join("\n");
        const hidden = lines.length - shown.length;
        const title = `${theme.fg("toolTitle", theme.bold("fabric"))} ${theme.fg("dim", `TypeScript · ${countLabel(lines.length, "line")}`)}`;
        return new Text(
          `${title}${preview ? `\n${preview}` : ""}${hidden > 0 ? `\n${theme.fg("dim", `… ${countLabel(hidden, "line")} hidden`)}` : ""}`,
          0,
          0,
        );
      },
      renderResult(result, { expanded, isPartial }, theme) {
        const details = result.details as
          | {
              success?: boolean;
              progress?: string;
              audits?: Array<{ ref: string; success?: boolean }>;
              phases?: string[];
            }
          | undefined;
        if (isPartial) {
          return new Text(
            theme.fg(
              "warning",
              `◆ ${safeTerminalText(details?.progress ?? "Running Fabric program…")}`,
            ),
            0,
            0,
          );
        }
        const output = result.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const lines = safeTerminalText(output).split("\n");
        const limit = expanded ? lines.length : 12;
        const shown = lines.slice(0, limit);
        const audits = details?.audits ?? [];
        const failedCalls = audits.filter((audit) => audit.success === false).length;
        const phases = details?.phases ?? [];
        const status = details?.success === false ? "failed" : "complete";
        const statusColor = details?.success === false ? "error" : "success";
        const metadata = [
          countLabel(audits.length, "nested call"),
          failedCalls > 0 ? `${failedCalls} failed` : undefined,
          phases.length > 0 ? countLabel(phases.length, "phase") : undefined,
        ].filter((value): value is string => Boolean(value));
        let text = theme.fg(
          statusColor,
          `${details?.success === false ? "✗" : "✓"} Fabric ${status}`,
        );
        if (metadata.length > 0) text += theme.fg("dim", ` · ${metadata.join(" · ")}`);
        if (phases.length > 0)
          text += `\n${theme.fg("dim", phases.map((phase) => `◆ ${phase}`).join("  "))}`;
        if (shown.length > 0)
          text += `\n${shown.map((line) => theme.fg("toolOutput", line || " ")).join("\n")}`;
        if (lines.length > shown.length) {
          text += `\n${theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")} hidden`)}`;
        }
        return new Text(text, 0, 0);
      },
      async execute(toolCallId, params, signal, onUpdate, context) {
        await state.ensure(context);
        const result = await state.execution.execute({
          code: params.code,
          ...(params.strings ? { strings: params.strings } : {}),
          signal,
          parentToolCallId: toolCallId,
          context,
          ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
          ...(params.agentBudget !== undefined ? { maxAgentCalls: params.agentBudget } : {}),
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
        const terminate =
          result.success &&
          typeof result.value === "object" &&
          result.value !== null &&
          "terminate" in result.value &&
          result.value.terminate === true;
        return {
          content: [{ type: "text", text: output }],
          details: result,
          ...(terminate ? { terminate: true } : {}),
          ...(result.success ? {} : { isError: true }),
        };
      },
    }),
  );
  const toolCapture = await installRegisteredToolCapture({
    anchorDefinition: fabricTool,
    catalog: capturedTools,
  });
  pi.registerTool(fabricTool);

  const refreshToolCapture = (): void => {
    toolCapture.setPolicy(state.config.capture);
    pi.registerTool(fabricTool);
  };

  pi.on("session_start", async (_event, context) => {
    await state.initialize(context);
    refreshToolCapture();
  });

  pi.on("session_shutdown", async () => {
    try {
      await state.shutdown();
    } finally {
      toolCapture.dispose();
    }
  });

  pi.on("input", async (event, context) => {
    if (state.initialized) state.dispatchHostEvent("input", event, context);
  });

  pi.on("turn_end", async (event, context) => {
    if (state.initialized) state.dispatchHostEvent("turn_end", event, context);
  });

  pi.on("agent_settled", async (event, context) => {
    if (state.initialized) state.dispatchHostEvent("agent_settled", event, context);
  });

  pi.on("tool_execution_end", async (event, context) => {
    if (state.initialized && event.isError) {
      state.dispatchHostEvent("tool_error", event, context);
    }
  });

  pi.on("session_compact", async (event, context) => {
    if (state.initialized) state.dispatchHostEvent("session_compact", event, context);
  });

  pi.on("before_agent_start", async (event) => {
    if (!pi.getActiveTools().includes("fabric_exec")) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nPi Fabric is available for programmatic composition. Extension tools hidden from the top-level schema remain discoverable through tools.search()/tools.describe() and callable through extensions.* or tools.call(). Keep simple one-call tasks on visible direct tools; do not guess captured tool schemas.`,
    };
  });

  pi.registerCommand("fabric", {
    description: "Inspect or reload Pi Fabric; manage captured tools, actors, and subagents",
    async handler(argumentsText, context) {
      await state.ensure(context);
      const [command = "status", ...argumentsList] = argumentsText
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (command === "reload") {
        await state.initialize(context);
        refreshToolCapture();
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
      if (command === "captured") {
        const query = argumentsList.join(" ").toLowerCase();
        const tools = capturedTools
          .list()
          .filter(
            (tool) =>
              !query ||
              `${tool.name} ${tool.definition.description} ${tool.sourceInfo.path}`
                .toLowerCase()
                .includes(query),
          );
        const shown = tools.slice(0, 100);
        context.ui.notify(
          shown.length > 0
            ? [
                ...shown.map((tool) => `${tool.name} [${tool.risk}] — ${tool.sourceInfo.path}`),
                ...(tools.length > shown.length
                  ? [`… ${tools.length - shown.length} more captured tools`]
                  : []),
              ].join("\n")
            : query
              ? `No captured extension tools matching ${JSON.stringify(query)}`
              : "No extension tools captured",
          "info",
        );
        return;
      }
      if (command === "agents") {
        const agents = state.subagents.list();
        context.ui.notify(
          agents.length > 0
            ? agents
                .map(
                  (agent) =>
                    `${agent.id.slice(0, 8)} ${agent.status} ${agent.transport} — ${agent.name}`,
                )
                .join("\n")
            : "No Fabric subagents",
          "info",
        );
        return;
      }
      if (command === "actors") {
        const actors = state.actors.list();
        context.ui.notify(
          actors.length > 0
            ? actors
                .map(
                  (actor) =>
                    `${actor.id.slice(0, 8)} ${actor.status} q:${actor.queued} — ${actor.name}`,
                )
                .join("\n")
            : "No Fabric actors",
          "info",
        );
        return;
      }
      if (command === "messages") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /fabric messages <actor-id>", "warning");
          return;
        }
        try {
          const actor = state.actors.status(id);
          const messages = state.actors.messages(actor.id, 20);
          context.ui.notify(
            messages.length > 0
              ? messages
                  .map((message) => {
                    const value = message.text ?? message.action ?? message.error ?? "data";
                    const summary = truncateMiddle(value.replace(/\s+/g, " "), 500);
                    return `${message.direction === "in" ? "→" : "←"} ${message.source}: ${summary}`;
                  })
                  .join("\n")
              : `No messages for ${actor.name}`,
            "info",
          );
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "stop") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /fabric stop <id>", "warning");
          return;
        }
        const actor = state.actors
          .list()
          .find((candidate) => candidate.id.startsWith(id) || candidate.name === id);
        if (actor) {
          await state.actors.stop(actor.id);
          context.ui.notify(`Stopped Fabric actor ${actor.id.slice(0, 8)}`, "info");
          return;
        }
        const agent = state.subagents.list().find((candidate) => candidate.id.startsWith(id));
        if (!agent) {
          context.ui.notify(`Unknown Fabric actor or subagent: ${id}`, "error");
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
          "Usage: /fabric [status|reload|providers|agents|actors|messages <id>|attach <id>|stop <id>]",
          "warning",
        );
        return;
      }
      const config = state.config;
      context.ui.notify(
        [
          `cwd: ${state.cwd}`,
          `providers: ${state.registry
            .providers()
            .map((provider) => provider.name)
            .join(", ")}`,
          `transport: ${config.subagents.transport}`,
          `subagent limits: concurrency ${config.subagents.maxConcurrent}, per execution ${config.subagents.maxPerExecution}, depth ${config.subagents.maxDepth}`,
          config.capture.enabled
            ? `captured tools: ${capturedTools.size} · model visibility: ${config.capture.hideFromModel ? "hidden" : "visible"}`
            : "captured tools: disabled",
          `actors: ${state.actors.list().length} · mesh: ${config.mesh.enabled ? state.mesh.root : "disabled"}`,
          `MCP: ${config.mcp.enabled ? "enabled" : "disabled"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}

export * from "./protocol.js";
