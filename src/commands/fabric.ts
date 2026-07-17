import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { CapturedToolCatalog } from "../capture/catalog.js";
import type { FabricActorHostEvent } from "../actors/types.js";
import type { FabricState } from "../fabric-state.js";
import { truncateMiddle } from "../util.js";
import type { FabricUiController } from "../ui/controller.js";
import { openFabricSettings } from "../ui/settings.js";
import fs from "node:fs";
import path from "node:path";

interface FabricCommandDeps {
  state: FabricState;
  fabricUi: FabricUiController;
  capturedTools: CapturedToolCatalog;
  applyFabricMode: () => void;
  suspendToolCapture: () => void;
}

const extractContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const p = part as Record<string, unknown>;
        return typeof p.text === "string" ? p.text : typeof p.type === "string" ? p.type : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
};

const summarizeLogLine = (entry: unknown): string => {
  if (typeof entry !== "object" || entry === null) return truncateMiddle(String(entry), 200);
  const record = entry as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const tool = typeof record.toolName === "string" ? record.toolName : undefined;
  // Pi session lines and worker message_end both wrap a { role, content } message.
  const msg = record.message;
  if (typeof msg === "object" && msg !== null && !Array.isArray(msg)) {
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "message";
    const model = typeof m.model === "string" ? m.model : undefined;
    const text = extractContentText(m.content);
    const body = (text || JSON.stringify(m)).replace(/\s+/g, " ");
    return `${role}${model ? ` [${model}]` : ""}: ${truncateMiddle(body, 160)}`;
  }
  if (type) {
    const bits = [type];
    if (tool) bits.push(tool);
    const model = typeof record.modelId === "string" ? record.modelId : undefined;
    const provider = typeof record.provider === "string" && !model ? record.provider : undefined;
    if (provider) bits.push(provider);
    if (model) bits.push(model);
    return bits.join(" ");
  }
  return truncateMiddle(JSON.stringify(record), 160);
};

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
        "clear-messages",
        "events",
        "log",
        "export-log",
        "attach",
        "stop",
        "remove",
        "global",
        "import",
        "export",
        "kill",
      ];
      const idCommands = new Set([
        "messages",
        "clear-messages",
        "events",
        "log",
        "export-log",
        "attach",
        "stop",
        "remove",
        "kill",
      ]);
      const firstSpace = argumentPrefix.indexOf(" ");
      if (firstSpace < 0) {
        const matches = subcommands.filter((name) => name.startsWith(argumentPrefix));
        return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
      }
      const subcommand = argumentPrefix.slice(0, firstSpace);
      const idPrefix = argumentPrefix.slice(firstSpace + 1);
      if (!state.initialized) return null;
      if (subcommand === "import") {
        const items: AutocompleteItem[] = [];
        try {
          for (const template of state.globalActors.list()) {
            items.push({
              value: template.name,
              label: template.name,
              description: `global ${template.runner} template · ${template.id.slice(0, 8)}`,
            });
          }
        } catch {
          /* global registry not initialized */
        }
        const filtered = items.filter((item) => item.value.startsWith(idPrefix));
        return filtered.length > 0 ? filtered : null;
      }
      if (!idCommands.has(subcommand)) {
        if (subcommand === "export") {
          const items: AutocompleteItem[] = [];
          try {
            for (const actor of state.actors.list()) {
              items.push({
                value: actor.name,
                label: actor.name,
                description: `${actor.status} ${actor.runner} actor · ${actor.id.slice(0, 8)}`,
              });
            }
          } catch {
            /* actors not initialized */
          }
          const filtered = items.filter((item) => item.value.startsWith(idPrefix));
          return filtered.length > 0 ? filtered : null;
        }
        return null;
      }
      const items: AutocompleteItem[] = [];
      try {
        for (const actor of state.actors.list()) {
          items.push({
            value: actor.name,
            label: actor.name,
            description: `${actor.status} ${actor.runner} actor · ${actor.id.slice(0, 8)}`,
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
            description: `${agent.status} ${agent.runner} subagent · ${agent.name}`,
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
                    `${agent.id.slice(0, 8)} ${agent.status} ${agent.runner}/${agent.transport} — ${agent.name}`,
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
                    `${actor.id.slice(0, 8)} ${actor.status} ${actor.runner} q:${actor.queued} — ${actor.name}`,
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
          const shortId = actor.id.slice(0, 8);
          const body =
            messages.length > 0
              ? messages
                  .map((message) => {
                    const value = message.text ?? message.error ?? message.action ?? "data";
                    const summary = truncateMiddle(value.replace(/\s+/g, " "), 500);
                    const runTag = message.runId ? ` [${message.runId.slice(0, 8)}]` : "";
                    const usageTag = message.usage
                      ? ` · ${message.usage.input + message.usage.output} tok`
                      : "";
                    return `${message.direction === "in" ? "→" : "←"} ${message.source}${runTag}: ${summary}${usageTag}`;
                  })
                  .join("\n")
              : `No messages for ${actor.name}`;
          const footer = `\nInspect LLM I/O: /fabric log ${shortId} · Export: /fabric export-log ${actor.name}`;
          context.ui.notify(`${body}${footer}`, "info");
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "log") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify(
            "Usage: /fabric log <id> [session|run|all] [--lines N] [--run <runId>]",
            "warning",
          );
          return;
        }
        let type: "session" | "run" | "all" = "session";
        let lines = 40;
        let runId: string | undefined;
        for (let i = 1; i < argumentsList.length; i++) {
          const arg = argumentsList[i]!;
          if (arg === "session" || arg === "run" || arg === "all") type = arg;
          else if ((arg === "--lines" || arg === "-n") && i + 1 < argumentsList.length) {
            const n = Number(argumentsList[++i]);
            if (n > 0) lines = Math.min(n, 5000);
          } else if (arg === "--run" && i + 1 < argumentsList.length) {
            runId = argumentsList[++i];
          }
        }
        try {
          const actor = state.actors.status(id);
          const log = state.actors.readLog(actor.id, { type, lines, ...(runId ? { runId } : {}) });
          const parts: string[] = [`Actor ${actor.name} · ${log.sessionFile}`];
          if (log.session.length > 0) {
            parts.push(`── session (last ${log.session.length} lines) ──`);
            for (const line of log.session) parts.push(summarizeLogLine(line.parsed ?? line.raw));
          }
          if (log.run) {
            parts.push(
              `── run ${log.run.runId.slice(0, 8)} (${log.run.status?.status ?? "?"}) ──`,
            );
            for (const line of log.run.events) parts.push(summarizeLogLine(line.parsed ?? line.raw));
          }
          if (log.retainedRuns.length > 0) {
            parts.push(
              `retained runs: ${log.retainedRuns.map((r) => r.slice(0, 8)).join(" ")}`,
            );
          }
          context.ui.notify(
            parts.length > 1 ? truncateMiddle(parts.join("\n"), 8000) : `No log found for ${actor.name}`,
            "info",
          );
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "export-log") {
        const id = argumentsList[0];
        const destArg = argumentsList.slice(1).join(" ");
        if (!id) {
          context.ui.notify("Usage: /fabric export-log <id> [path]", "warning");
          return;
        }
        try {
          const dest = path.resolve(
            destArg || path.join("fabric-logs", `export-${Date.now()}`),
          );
          fs.mkdirSync(dest, { recursive: true });
          const actor = state.actors
            .list()
            .find((candidate) => candidate.id.startsWith(id) || candidate.name === id);
          let label: string;
          let copied: string[] = [];
          if (actor) {
            const full = state.actors.status(actor.id);
            label = actor.name;
            if (full.sessionFile && fs.existsSync(full.sessionFile)) {
              fs.copyFileSync(full.sessionFile, path.join(dest, "session.jsonl"));
              copied.push("session.jsonl");
            }
            if (full.logDir && fs.existsSync(full.logDir)) {
              fs.cpSync(full.logDir, path.join(dest, "runs"), { recursive: true });
              copied.push("runs/");
            }
          } else {
            const runDir = state.subagents.runDirectory(id);
            const status = state.subagents.status(id);
            label = status.name;
            if (runDir && fs.existsSync(runDir)) {
              fs.cpSync(runDir, dest, { recursive: true });
              copied.push("run/");
            }
          }
          if (copied.length === 0) {
            context.ui.notify(`No log files found for ${label}`, "warning");
            return;
          }
          context.ui.notify(`Exported ${label} log → ${dest} (${copied.join(", ")})`, "info");
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "clear-messages") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /fabric clear-messages <actor-id>", "warning");
          return;
        }
        try {
          const actor = state.actors.status(id);
          await state.actors.clearMessages(actor.id);
          context.ui.notify(`Cleared message history for ${actor.name}`, "info");
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "events") {
        const id = argumentsList[0];
        if (!id) {
          context.ui.notify("Usage: /fabric events <actor-id> [event...]", "warning");
          return;
        }
        try {
          const actor = state.actors.status(id);
          const events = argumentsList.slice(1) as FabricActorHostEvent[];
          await state.actors.setEvents(actor.id, events);
          context.ui.notify(
            `Set ${actor.name} events: ${events.join(", ") || "(none)"}`,
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
      if (command === "global") {
        const templates = state.globalActors.list();
        context.ui.notify(
          templates.length > 0
            ? templates
                .map((template) => `${template.id.slice(0, 8)} global ${template.runner} — ${template.name}`)
                .join("\n")
            : "No global Fabric actor templates",
          "info",
        );
        return;
      }
      if (command === "import") {
        const key = argumentsList[0];
        if (!key) {
          context.ui.notify("Usage: /fabric import <global-actor-name-or-id> [as <new-name>]", "warning");
          return;
        }
        try {
          const def = state.globalActors.resolve(key);
          if (!def) {
            context.ui.notify(`Unknown global actor: ${key}`, "error");
            return;
          }
          const asIndex = argumentsList.indexOf("as");
          const as =
            asIndex >= 0 && argumentsList[asIndex + 1] ? argumentsList[asIndex + 1] : undefined;
          const actor = await state.actors.create(state.globalActors.toRequest(def, as));
          context.ui.notify(`Imported global actor "${def.name}" as ${actor.name}`, "info");
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "export") {
        const id = argumentsList[0];
        const overwrite = argumentsList.includes("--overwrite") || argumentsList.includes("-f");
        if (!id) {
          context.ui.notify("Usage: /fabric export <actor-id> [--overwrite]", "warning");
          return;
        }
        try {
          const actor = state.actors
            .list()
            .find((candidate) => candidate.id.startsWith(id) || candidate.name === id);
          if (!actor) {
            context.ui.notify(`Unknown Fabric actor: ${id}`, "error");
            return;
          }
          const def = state.actors.definition(actor.id);
          const template = state.globalActors.create(def, overwrite);
          context.ui.notify(`Exported "${template.name}" to global actors`, "info");
        } catch (error) {
          context.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command !== "status") {
        context.ui.notify(
          "Usage: /fabric [status|dashboard|reload|providers|agents|actors|global|import <name> [as <new>]|export <id> [--overwrite]|messages <id>|clear-messages <id>|events <id> [event...]|log <id>|export-log <id>|attach <id>|stop <id>|remove <id>|kill <id>]",
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
          `runner: ${config.subagents.runner} · transport: ${config.subagents.transport} · model: ${
            config.subagents.runner === "claude"
              ? config.subagents.claude.model || "Claude default"
              : config.subagents.model || "inherit"
          }`,
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
