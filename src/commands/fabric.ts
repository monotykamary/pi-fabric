import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { CapturedToolCatalog } from "../capture/catalog.js";
import type { FabricState } from "../fabric-state.js";
import { truncateMiddle } from "../util.js";
import type { FabricUiController } from "../ui/controller.js";
import { openFabricSettings } from "../ui/settings.js";

interface FabricCommandDeps {
  state: FabricState;
  fabricUi: FabricUiController;
  capturedTools: CapturedToolCatalog;
  applyFabricMode: () => void;
  suspendToolCapture: () => void;
}

export function registerFabricCommand(pi: ExtensionAPI, deps: FabricCommandDeps): void {
  const { state, fabricUi, capturedTools, applyFabricMode, suspendToolCapture } = deps;
  pi.registerCommand("fabric", {
    description: "Open the Fabric dashboard; inspect, reload, or manage agents and actors",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      const subcommands = [
        "status",
        "dashboard",
        "settings",
        "reload",
        "providers",
        "agents",
        "actors",
        "messages",
        "attach",
        "stop",
        "remove",
        "kill",
      ];
      const idCommands = new Set(["messages", "attach", "stop", "remove", "kill"]);
      const firstSpace = argumentPrefix.indexOf(" ");
      if (firstSpace < 0) {
        const matches = subcommands.filter((name) => name.startsWith(argumentPrefix));
        return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
      }
      const subcommand = argumentPrefix.slice(0, firstSpace);
      if (!idCommands.has(subcommand)) return null;
      const idPrefix = argumentPrefix.slice(firstSpace + 1);
      if (!state.initialized) return null;
      const items: AutocompleteItem[] = [];
      try {
        for (const actor of state.actors.list()) {
          items.push({
            value: actor.name,
            label: actor.name,
            description: `${actor.status} actor · ${actor.id.slice(0, 8)}`,
          });
        }
      } catch {
        /* actors not initialized */
      }
      try {
        for (const agent of state.subagents.list()) {
          const short = agent.id.slice(0, 8);
          items.push({
            value: short,
            label: short,
            description: `${agent.status} subagent · ${agent.name}`,
          });
        }
      } catch {
        /* subagents not initialized */
      }
      const filtered = items.filter((item) => item.value.startsWith(idPrefix));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(argumentsText, context) {
      await state.ensure(context);
      const [command = "status", ...argumentsList] = argumentsText
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (command === "reload") {
        fabricUi.stop();
        suspendToolCapture();
        await state.initialize(context);
        applyFabricMode();
        fabricUi.start(context);
        context.ui.notify("Pi Fabric reloaded", "info");
        return;
      }
      if (command === "settings") {
        await openFabricSettings(context, { state, applyFabricMode, capturedTools });
        return;
      }
      if (command === "dashboard" || command === "ui") {
        await fabricUi.openDashboard(context);
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
      if (command === "remove" || command === "kill") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /fabric remove <id>", "warning");
          return;
        }
        const actor = state.actors
          .list()
          .find((candidate) => candidate.id.startsWith(id) || candidate.name === id);
        if (actor) {
          await state.actors.remove(actor.id);
          context.ui.notify(`Removed Fabric actor ${actor.id.slice(0, 8)} (${actor.name})`, "info");
          return;
        }
        const agent = state.subagents.list().find((candidate) => candidate.id.startsWith(id));
        if (!agent) {
          context.ui.notify(`Unknown Fabric actor or subagent: ${id}`, "error");
          return;
        }
        await state.subagents.stop(agent.id);
        await state.subagents.cleanup(agent.id);
        context.ui.notify(`Removed Fabric subagent ${agent.id.slice(0, 8)}`, "info");
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
          "Usage: /fabric [status|dashboard|reload|providers|agents|actors|messages <id>|attach <id>|stop <id>|remove <id>|kill <id>]",
          "warning",
        );
        return;
      }
      const config = state.config;
      context.ui.notify(
        [
          `cwd: ${state.cwd}`,
          `mode: ${config.fullCodeMode ? "full code (Fabric-owned core tools)" : "orchestration-only (native Pi tools)"}`,
          `providers: ${state.registry
            .providers()
            .map((provider) => provider.name)
            .join(", ")}`,
          `transport: ${config.subagents.transport}`,
          `subagent limits: concurrency ${config.subagents.maxConcurrent}, per execution ${config.subagents.maxPerExecution}, depth ${config.subagents.maxDepth}`,
          config.fullCodeMode && config.capture.enabled
            ? `captured tools: ${capturedTools.size} · model visibility: ${config.capture.hideFromModel ? "hidden" : "visible"}`
            : "captured tools: disabled (native registry preserved)",
          `actors: ${state.actors.list().length} · mesh: ${config.mesh.enabled ? state.mesh.root : "disabled"}`,
          `MCP: ${config.mcp.enabled ? "enabled" : "disabled"}`,
          `UI: ${config.ui.enabled ? `${config.ui.widget} widget above chat` : "disabled"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
