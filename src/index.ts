import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadCodePreviewSettings } from "pi-code-previews";
import { registerFabricActorHostEventObservers } from "./actors/host-event-observer.js";
import { CapturedToolCatalog } from "./capture/catalog.js";
import { installRegisteredToolCapture } from "./capture/interceptor.js";
import { registerFabricCommand } from "./commands/fabric.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import {
  DEFAULT_FABRIC_CONFIG,
  effectiveToolCaptureConfig,
} from "./config.js";
import { registerCompactionHook } from "./compaction/hook.js";
import {
  FabricToolLifecycle,
  FabricToolOwnership,
  ownsFabricToolSource,
} from "./core/tool-ownership.js";
import {
  expandSkillDirMarkersForRead,
  expandSkillDirMarkersInSkillBlock,
} from "./core/skill-dir.js";
import { restoreSkillsForFullCodePrompt } from "./core/skill-prompt.js";
import { buildSkillReferenceGuidance } from "./core/skill-references.js";
import { createFabricExecTool } from "./fabric-exec-tool.js";
import { FabricState } from "./fabric-state.js";
import { piHostCompatibilityWarning } from "./host-compatibility.js";
import {
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProviderRegistration,
} from "./protocol.js";
import type { AgentToolResultMessage } from "./agents/types.js";
import { FabricUiController } from "./ui/controller.js";
import { configureHighlighting } from "./ui/highlight.js";
import { formatFabricValue } from "./ui/structured.js";
import { truncateMiddle } from "./util.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the Fabric skills bundled with this extension. Resolved
// relative to the extension entry so it works both in development (src/) and
// in an installed package (dist/). Contributed via resources_discover so child
// Pi processes that load Fabric with -e (agents and actors) discover the
// same fabric-exec / fabric-advisor / fabric-council skill references as the
// main agent, which gets them through the package manifest.
const FABRIC_EXTENSION_ENTRY_PATH = path.resolve(fileURLToPath(import.meta.url));
const FABRIC_SKILLS_DIR = path.resolve(
  path.dirname(FABRIC_EXTENSION_ENTRY_PATH),
  "..",
  "skills",
);

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
  const codePreviewSettings = await loadCodePreviewSettings();
  let compatibilityWarningShown = false;
  configureHighlighting(
    codePreviewSettings.shikiTheme,
    codePreviewSettings.syntaxHighlighting,
  );
  const capturedTools = new CapturedToolCatalog();
  const state = new FabricState(pi, capturedTools);
  const pendingHandoffs = new Map<string, PendingFabricHandoff>();
  const toolOwnership = new FabricToolOwnership(pi);
  const fabricUi = new FabricUiController(state, codePreviewSettings);

  const unsubscribeProviderRegistration = pi.events.on(
    FABRIC_PROVIDER_REGISTER_EVENT,
    (value: unknown) => {
      const registration = registrationFrom(value);
      if (!registration) throw new Error("Invalid Pi Fabric provider registration");
      state.registerExternal(
        registration.provider,
        registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
      );
    },
  );

  pi.on("resources_discover", async () => {
    if (existsSync(FABRIC_SKILLS_DIR)) return { skillPaths: [FABRIC_SKILLS_DIR] };
    return {};
  });

  const fabricTool = createFabricExecTool(
    state,
    codePreviewSettings,
    pendingHandoffs,
  );
  const fabricToolLifecycle = new FabricToolLifecycle(
    () => ownsFabricToolSource(pi.getAllTools(), FABRIC_EXTENSION_ENTRY_PATH),
    () => state.initialized ? state.execution.authorizer : undefined,
  );

  const inactiveCapturePolicy = {
    ...structuredClone(DEFAULT_FABRIC_CONFIG.capture),
    enabled: false,
    hideFromModel: false,
  };
  const toolCapture = await installRegisteredToolCapture({
    anchorDefinition: fabricTool,
    catalog: capturedTools,
    initialPolicy: inactiveCapturePolicy,
  });
  pi.registerTool(fabricTool);

  const applyFabricMode = (): void => {
    toolCapture.setPolicy(effectiveToolCaptureConfig(state.config));
    pi.registerTool(fabricTool);
    toolOwnership.apply(
      state.config.fullCodeMode || state.config.schema.mode === "enforce",
    );
  };
  const suspendToolCapture = (): void => {
    toolCapture.setPolicy(inactiveCapturePolicy);
  };

  // ESC stop-the-world: a lone Escape (debounced to ignore escape sequences
  // such as arrow keys) halts every persistent actor — aborting in-flight runs
  // and cancelling queued work — and arms a stop-the-world gate that freezes
  // host-event and mesh dispatch so the interrupted actors are not re-armed by
  // the interrupt's own turn_end / agent_settled events. The gate lifts when the
  // user resumes by sending a new message (the "input" host event). Escape is
  // observed but not consumed, so Pi's native cancel-streaming still fires;
  // single ESC therefore stops the current turn and the advisor/supervisor
  // actors at once. Disabled when mesh/actors are off or ui.haltOnEscape is
  // false.
  let haltOnEscapeUnsubscribe: (() => void) | undefined;
  const uninstallHaltOnEscape = (): void => {
    haltOnEscapeUnsubscribe?.();
    haltOnEscapeUnsubscribe = undefined;
  };
  const installHaltOnEscape = (context: ExtensionContext): void => {
    uninstallHaltOnEscape();
    if (context.mode !== "tui") return;
    if (!state.config.ui.haltOnEscape || !state.config.mesh.enabled) return;
    if (typeof context.ui.onTerminalInput !== "function") return;
    const ESC = "\x1b";
    const DEBOUNCE_MS = 60;
    let escTimer: NodeJS.Timeout | undefined;
    const trigger = (): void => {
      if (!state.initialized || !state.config.mesh.enabled) return;
      let halted = 0;
      try {
        // A lone Esc that lands while Fabric is already in a stop-the-world
        // halt is a no-op: the gate is armed and resumes on the next message,
        // so don't repeat the notice — a double-Esc to open /tree would
        // otherwise pop it on every press. Only the first Esc of a halt
        // session notifies.
        if (state.actors.halted) return;
        halted = state.actors.haltAll().halted;
      } catch {
        return;
      }
      // Nothing had work to abort: the gate armed silently, so skip the
      // notice — a lone Esc with no active actors should not pop a
      // "halted 0 actors" line.
      if (halted === 0) return;
      context.ui.notify(
        `Fabric: halted ${halted} actor${halted === 1 ? "" : "s"} (Esc) · resumes on next message`,
        "warning",
      );
    };
    haltOnEscapeUnsubscribe = context.ui.onTerminalInput((data: string) => {
      if (data === ESC) {
        if (escTimer) clearTimeout(escTimer);
        escTimer = setTimeout(() => {
          escTimer = undefined;
          trigger();
        }, DEBOUNCE_MS);
        escTimer.unref?.();
        return undefined;
      }
      // Any other input cancels a pending lone-Esc debounce — the Esc byte was
      // most likely the start of an escape sequence that arrived split.
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = undefined;
      }
      return undefined;
    });
  };

  pi.on("session_start", async (_event, context) => {
    pendingHandoffs.clear();
    fabricUi.stop();
    suspendToolCapture();
    if (!compatibilityWarningShown) {
      compatibilityWarningShown = true;
      const warning = piHostCompatibilityWarning();
      if (warning) {
        console.warn(`[pi-fabric] ${warning}`);
        if (context.hasUI) context.ui.notify(warning, "warning");
      }
    }
    const projectTrusted =
      typeof context.isProjectTrusted === "function" ? context.isProjectTrusted() : true;
    try {
      Object.assign(
        codePreviewSettings,
        await loadCodePreviewSettings(context.cwd, projectTrusted),
      );
      configureHighlighting(
        codePreviewSettings.shikiTheme,
        codePreviewSettings.syntaxHighlighting,
      );
      Object.assign(
        fabricTool,
        createFabricExecTool(state, codePreviewSettings, pendingHandoffs),
      );
    } catch (error) {
      console.warn("[pi-fabric] Failed to refresh code preview settings.", error);
    }
    await state.initialize(context);
    applyFabricMode();
    fabricUi.start(context);
    installHaltOnEscape(context);
  });

  // Tool ownership changes only at session or mode transitions; lifecycle hooks
  // forward host events without churning an explicitly selected active set.
  pi.on("input", async (event, context) => {
    if (!state.initialized) return;
    state.prewalk.observeTask(
      context.sessionManager.getSessionId(),
      event.text,
    );
    await state.publishHostLifecycle("pi.input", event);
  });

  pi.on("agent_start", async (event) => {
    if (state.initialized) await state.publishHostLifecycle("pi.agent_start", event);
  });

  pi.on("agent_end", async (event) => {
    if (state.initialized) await state.publishHostLifecycle("pi.agent_end", event);
  });

  pi.on("turn_end", async (event, context) => {
    if (!state.initialized) return;
    await state.publishHostLifecycle("pi.turn_end", event);
  });

  pi.on("agent_settled", async (event, context) => {
    if (!state.initialized) return;
    if (state.prewalk.settleTask(context.sessionManager.getSessionId())) {
      const status = state.prewalk.status();
      context.ui.setStatus(
        "fabric-prewalk",
        status.state === "armed" ? `armed → ${status.model}` : undefined,
      );
    }
    // Keep the completed widget mounted until a newer Fabric run replaces it.
    // Removing rows at settle would pull the editor and latest chat content upward.
    // Pi's compact API is callback-based. Await the controller's Promise here
    // so ExtensionRunner does not finish this handler (and Pi does not publish
    // its public agent_settled event) before compaction settles.
    await state.compact.maybeCommit(context);
    await state.publishHostLifecycle("pi.agent_settled", event);
  });

  pi.on("tool_call", (event) => fabricToolLifecycle.toolCall(event));

  // Pi 0.80.6 intentionally ignores `isError` returned by custom-tool
  // execute(). Repair the finalized outer result through official middleware.
  pi.on("tool_result", (event) => fabricToolLifecycle.toolResult(event));

  pi.on("tool_result", (event, context) => {
    if (event.toolName !== "read" || event.isError) return undefined;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = expandSkillDirMarkersForRead(
        part.text,
        event.input,
        context.cwd,
      );
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });

  // message_end runs after all tool-result middleware and tool_execution_end but
  // before Pi persists the native toolResult or starts another model turn. That
  // is the complete outer fabric_exec boundary: fork the exact message, wait for
  // the child, then replace what Main sees while terminate prevents inference.
  pi.on("message_end", async (event, context) => {
    if (event.message.role !== "toolResult") return undefined;
    const pending = pendingHandoffs.get(event.message.toolCallId);
    if (!pending || event.message.toolName !== "fabric_exec") return undefined;
    pendingHandoffs.delete(event.message.toolCallId);

    const outerToolResult = event.message as AgentToolResultMessage;
    const handoff = await state.runHandoffAtBoundary(
      pending,
      outerToolResult,
      context,
    );
    const formatted = formatFabricValue(handoff, pending.resultFormat);
    const output = truncateMiddle(
      formatted.text || "(no output)",
      state.config.executor.maxOutputChars,
    );
    const details =
      typeof event.message.details === "object" &&
      event.message.details !== null &&
      !Array.isArray(event.message.details) &&
      "success" in event.message.details
        ? { ...event.message.details, success: handoff.completed === true }
        : event.message.details;
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: output }],
        details,
        isError: handoff.completed !== true,
      },
    };
  });

  pi.on("tool_execution_end", async (event, context) => {
    if (!state.initialized) return;
    state.noteMainActivity(context);
    if (event.isError) {
      state.dispatchHostEvent("tool_error", event, context);
      await state.publishHostLifecycle("pi.tool_error", event);
    }
  });

  pi.on("session_compact", async (event, context) => {
    if (!state.initialized) return;
    await state.publishHostLifecycle("pi.session_compact", event);
  });

  // Deterministic, LLM-free compaction is registered unconditionally and is
  // active by default. The documented "pi" escape hatch returns early so
  // pi-core's own summarization proceeds normally.
  registerCompactionHook(pi, {
    getEngine: () =>
      state.initialized
        ? state.config.compaction.engine
        : DEFAULT_FABRIC_CONFIG.compaction.engine,
    getTargetContextRatio: () =>
      state.initialized
        ? state.config.compaction.targetContextRatio
        : DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
  });

  pi.on("context", (event) => {
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "user") return message;
      if (typeof message.content === "string") {
        const content = expandSkillDirMarkersInSkillBlock(message.content);
        if (content === message.content) return message;
        changed = true;
        return { ...message, content };
      }
      let messageChanged = false;
      const content = message.content.map((part) => {
        if (part.type !== "text") return part;
        const text = expandSkillDirMarkersInSkillBlock(part.text);
        if (text === part.text) return part;
        changed = true;
        messageChanged = true;
        return { ...part, text };
      });
      return messageChanged ? { ...message, content } : message;
    });
    return changed ? { messages } : undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const fullCodeMode = state.initialized
      ? state.config.fullCodeMode
      : DEFAULT_FABRIC_CONFIG.fullCodeMode;
    const schemaMode = state.initialized
      ? state.config.schema.mode
      : DEFAULT_FABRIC_CONFIG.schema.mode;
    const effectiveFullCodeMode = fullCodeMode || schemaMode === "enforce";
    if (!pi.getActiveTools().includes("fabric_exec")) return;
    const skills = event.systemPromptOptions.skills ?? [];
    // Pi omits its entire skill catalog when the active tool set lacks a tool
    // named read. Restore that catalog in full code mode with only the loader
    // instruction adapted to Fabric's nested pi.read path.
    const systemPrompt = effectiveFullCodeMode
      ? restoreSkillsForFullCodePrompt(event.systemPrompt, skills)
      : event.systemPrompt;
    // Pi expands the invoked skill into the user message, but wrappers may
    // delegate by name. Resolve only explicit invocation lines so full code
    // mode preserves Pi's progressive skill loading without exposing read.
    const skillReferenceGuidance = effectiveFullCodeMode
      ? buildSkillReferenceGuidance(event.prompt, skills)
      : undefined;
    const guidance = (effectiveFullCodeMode
      ? "Pi Fabric full code mode: `fabric_exec` is the only way to call Pi core tools — use them as `pi.*` inside `code`.\nExamples and returns: `pi.read('/x')`, `pi.grep('TODO','src')` / `pi.grep({regex:'TODO', ic:true, ctx:2})`, `pi.find('*.ts','src')`, and `pi.ls('src')` return strings; `pi.bash({cmd:'ls'})`, `pi.edit({path:'/x', old:'a', new:'b'})`, and `pi.write({path:'/y', text:'z'})` return `{ok, output, details}` (read `.output`); failed core calls reject. Use `pi.bashSettled(args)` only when a nonzero exit is expected as data; timeout, cancellation, approval, and security failures still reject.\n`tools` is discovery + generic calls only (`providers`/`catalog`/`list`/`search`/`describe`/`call`/`models`). Call known MCP tools as `mcp.<sanitized_server>.<sanitized_tool>(args)`, captured tools as `extensions.<tool>(args)`, and stable providers as `memory.*`, `state.*`, `schema.*`, or `compact.*`. Use `tools.call({ref,args})` for computed refs. `pi` is the core tools; `π.<key>` is named strings (not a tool)."
      : "Pi Fabric is in orchestration-only mode. Pi core and registered extension tools stay on their native direct execution path; inside fabric_exec, `pi.*` and `extensions.*` are unavailable. Call known actions through `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, `compact.*`, `agents.*`, or `mesh.*`; use `tools.catalog`/`search`/`describe`/`list` for discovery and `tools.call({ref,args})` for computed refs. Other surfaces are opt-in via user-loaded skills.")
      + (schemaMode === "enforce"
        ? "\n\nSchema enforce mode is fixed for this session. Reads remain available, but protected-workspace changes must use schema.hypothesize → schema.verify → schema.commit in the same fabric_exec invocation. Direct pi.edit/write/bash, agents, state/mesh writes, compaction requests, MCP, extensions, and external providers are blocked by the host gate."
        : schemaMode === "audit"
          ? "\n\nSchema audit mode reports actions that enforce mode would block, but preserves their current behavior."
          : "")
      + (skillReferenceGuidance ? `\n\n${skillReferenceGuidance}` : "");
    return {
      systemPrompt: `${systemPrompt}\n\n${guidance}`,
    };
  });

  registerFabricActorHostEventObservers(pi, (eventName, event, context) => {
    if (!state.initialized) return;
    state.dispatchHostEvent(eventName, event, context);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeProviderRegistration();
    try {
      pendingHandoffs.clear();
      uninstallHaltOnEscape();
      fabricUi.stop();
      suspendToolCapture();
      toolOwnership.release();
      fabricToolLifecycle.clear();
      await state.shutdown();
    } finally {
      toolCapture.dispose();
    }
  });

  registerFabricCommand(pi, { state, fabricUi, capturedTools, applyFabricMode, suspendToolCapture });
}

export * from "./audit/index.js";
export * from "./protocol.js";
