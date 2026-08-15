import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defaultCodePreviewSettings } from "./ui/code-preview.js";
import {
  type FabricToolShellDecorator,
  withCodePreviewShell,
} from "./ui/code-preview-shell.js";
import { registerFabricActorHostEventObservers } from "./actors/host-event-observer.js";
import { CapturedToolCatalog } from "./capture/catalog.js";
import { installRegisteredToolCapture } from "./capture/interceptor.js";
import { registerFabricCommand } from "./commands/fabric.js";
import {
  filterPrewalkContinuationMessages,
  settleInPlacePrewalk,
  withTrajectoryRearmDirective,
} from "./prewalk/handoff.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import { autoArmFabricPrewalk } from "./prewalk/arm.js";
import {
  DEFAULT_FABRIC_CONFIG,
  effectiveToolCaptureConfig,
} from "./config.js";
import { registerCompactionHook } from "./compaction/hook.js";
import { compactAtConfiguredThreshold } from "./compaction/threshold.js";
import {
  createToolOwnershipReassertion,
  FabricToolLifecycle,
  FabricToolOwnership,
  ownsFabricToolSource,
} from "./core/tool-ownership.js";
import {
  expandSkillDirMarkersForRead,
  expandSkillDirMarkersInSkillBlock,
} from "./core/skill-dir.js";
import { coreOverridePromptGuidance } from "./core/core-override-guidance.js";
import { restoreSkillsForFullCodePrompt } from "./core/skill-prompt.js";
import {
  FabricDirectToolApproval,
  mergeFabricApprovalUsage,
} from "./core/direct-tool-approval.js";
import { buildSkillReferenceGuidance } from "./core/skill-references.js";
import {
  CAPABILITY_ADVISORY_CUSTOM_TYPE,
  CapabilityAdvisor,
} from "./core/capability-advisory.js";
import {
  capturedToolNamespace,
  listCapturedToolDescriptors,
} from "./providers/captured-tools-provider.js";
import { toMcpAdvisoryDescriptor } from "./providers/mcp-advisory.js";
import { sanitizeMcpRefPart } from "./ref-names.js";
import { createFabricExecTool } from "./fabric-exec-tool.js";
import { FabricState } from "./fabric-state.js";
import { piHostCompatibilityWarning } from "./host-compatibility.js";
import {
  FABRIC_COMPONENT_REGISTER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricComponentRegistration,
  type FabricProviderRegistration,
} from "./protocol.js";
import type { AgentToolResultMessage } from "./agents/types.js";
import { FabricUiController } from "./ui/controller.js";
import { FabricToolDisplayController } from "./ui/tool-display.js";
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
const FABRIC_ENTRY_DIR = path.dirname(FABRIC_EXTENSION_ENTRY_PATH);
const FABRIC_RUNTIME_PATHS = {
  extension: FABRIC_EXTENSION_ENTRY_PATH,
  worker: path.join(FABRIC_ENTRY_DIR, "worker.js"),
  residentHost: path.join(FABRIC_ENTRY_DIR, "residency", "host.js"),
  skills: path.resolve(FABRIC_ENTRY_DIR, "..", "skills"),
};
const FABRIC_SKILLS_DIR = FABRIC_RUNTIME_PATHS.skills;

const componentRegistrationFrom = (
  value: unknown,
): FabricComponentRegistration | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registration = value as Partial<FabricComponentRegistration>;
  const component = registration.component;
  if (
    registration.version !== 1 ||
    typeof component !== "object" ||
    component === null ||
    typeof component.name !== "string" ||
    typeof component.activate !== "function"
  ) {
    return undefined;
  }
  return registration as FabricComponentRegistration;
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
  const codePreviewSettings = defaultCodePreviewSettings();
  const decorateShell: FabricToolShellDecorator = withCodePreviewShell;
  let compatibilityWarningShown = false;
  configureHighlighting(
    codePreviewSettings.shikiTheme,
    codePreviewSettings.syntaxHighlighting,
  );
  const capturedTools = new CapturedToolCatalog();
  const capabilityAdvisor = new CapabilityAdvisor();
  const state = new FabricState(
    pi,
    capturedTools,
    (entry) => {
      // Organic discovery: the model found and used the namespace on its own —
      // burn it as ash so no future hint wastes the fire. Nothing to persist:
      // the tool call itself is the transcript entry a future replay recovers.
      try {
        capabilityAdvisor.observeToolUse(capturedToolNamespace(entry));
      } catch {
        // Advisory bookkeeping only.
      }
    },
    {
      onSliceChanged: () => refreshAdvisorSources(),
      onToolUse: (server) => {
        // MCP tools are only callable through fabric_exec, so the provider is
        // the only organic-use observer available; ash the advisor namespace
        // (sanitized, matching the advisory slice) on every call.
        try {
          capabilityAdvisor.observeToolUse(`mcp:${sanitizeMcpRefPart(server)}`);
        } catch {
          // Advisory bookkeeping only.
        }
      },
    },
    { paths: FABRIC_RUNTIME_PATHS },
  );
  const directToolApproval = new FabricDirectToolApproval(
    pi,
    () => state.config,
    state.sessionApprovals,
  );
  const pendingHandoffs = new Map<string, PendingFabricHandoff>();
  const toolOwnership = new FabricToolOwnership(pi);
  const fabricUi = new FabricUiController(state, codePreviewSettings);
  const toolDisplay = new FabricToolDisplayController();

  const capturePolicy = () => effectiveToolCaptureConfig(state.config);
  // Advisor slices refresh independently: captured tools only while they are
  // hidden from the model (nothing to point at when tools are natively
  // visible); the MCP descriptor-cache slice whenever mcp.advisory is on —
  // MCP tools never have native visibility, so the gate is capture-agnostic.
  const refreshAdvisorSources = (): void => {
    if (!state.cwd) return;
    const policy = capturePolicy();
    capabilityAdvisor.setSource(
      "captured",
      policy.enabled && policy.hideFromModel
        ? listCapturedToolDescriptors(capturedTools.list())
        : [],
    );
    capabilityAdvisor.setSource(
      "mcp",
      state.config.mcp.advisory
        ? state.mcpSlice().map(toMcpAdvisoryDescriptor)
        : [],
    );
  };
  const fabricOwnsModelTools = (): boolean =>
    state.config.fullCodeMode || state.config.schema.mode === "enforce";
  // Captured tools that must stay out of the model's active set in full code
  // mode: every captured extension tool minus the capture.keepVisible names.
  const hiddenCapturedToolNames = (): Set<string> => {
    const visible = new Set(capturePolicy().keepVisible);
    return new Set(
      capturedTools.list().map((entry) => entry.name).filter((name) => !visible.has(name)),
    );
  };
  // Pi auto-activates tools that newly appear in the registry on every tool
  // refresh; re-assert ownership afterwards so captured tools stay hidden from
  // the model even when a late-loading extension triggers a refresh. Refresh
  // callbacks arrive before session initialization too, so reassertion waits
  // for state to be ready rather than reading an uninitialized config.
  const { reassert: reassertToolOwnership, schedule: scheduleOwnershipReassert } =
    createToolOwnershipReassertion({
      ready: () => state.cwd !== undefined,
      active: () => {
        const policy = capturePolicy();
        return policy.enabled && policy.hideFromModel && fabricOwnsModelTools();
      },
      hiddenNames: hiddenCapturedToolNames,
      apply: (hidden) => toolOwnership.apply(true, hidden),
    });

  const unsubscribeComponentRegistration = pi.events.on(
    FABRIC_COMPONENT_REGISTER_EVENT,
    (value: unknown) => {
      const registration = componentRegistrationFrom(value);
      if (!registration) throw new Error("Invalid Pi Fabric component registration");
      state.registerExternalComponent(
        registration.component,
        registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
      );
    },
  );

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
    decorateShell,
    toolDisplay,
  );
  const refreshCodePreviewSettings = (): void => {
    Object.assign(codePreviewSettings, state.config.codePreview);
    configureHighlighting(
      codePreviewSettings.shikiTheme,
      codePreviewSettings.syntaxHighlighting,
    );
  };
  const fabricToolLifecycle = new FabricToolLifecycle(
    () => ownsFabricToolSource(pi.getAllTools(), FABRIC_EXTENSION_ENTRY_PATH),
    () => state.initialized ? state.execution.authorizer : undefined,
    () => state.initialized ? directToolApproval : undefined,
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
    onCatalogRefresh: () => {
      scheduleOwnershipReassert();
      refreshAdvisorSources();
    },
  });
  pi.registerTool(fabricTool);

  const applyFabricMode = (): void => {
    toolCapture.setPolicy(capturePolicy());
    pi.registerTool(fabricTool);
    toolOwnership.apply(
      fabricOwnsModelTools(),
      fabricOwnsModelTools() ? hiddenCapturedToolNames() : undefined,
    );
    refreshAdvisorSources();
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

  // Durable advisory state is transcript-derived: custom messages replay ash,
  // emitted-word echoes, and the session fire count; captured/MCP calls replay
  // organic ash. Branch switches therefore reproduce one exact ledger.
  const refreshAdvisorLedger = (context: ExtensionContext): void => {
    capabilityAdvisor.restoreAshFromEntries(
      context.sessionManager?.getBranch?.() ?? [],
      (toolName, input) => {
        const captured = capturedTools.get(toolName);
        if (captured !== undefined) return capturedToolNamespace(captured);
        // MCP organic use happens inside fabric_exec and leaves no per-tool
        // transcript entries; recover it by scanning executed code for
        // mcp.<server>.<tool> refs so a branch rewind / reload does not
        // re-hint a namespace the model already spent.
        if (toolName !== "fabric_exec") return undefined;
        const code = typeof input?.code === "string" ? input.code : "";
        if (!code.includes("mcp.")) return undefined;
        const namespaces = new Set<string>();
        for (const match of code.matchAll(/\bmcp\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\./g)) {
          const server = match[1];
          if (server !== undefined) namespaces.add(`mcp:${server}`);
        }
        return namespaces.size > 0 ? [...namespaces] : undefined;
      },
    );
  };

  // alwaysRearm means always armed: every session opens with prewalk armed.
  // Config-health skips (no prewalk.model, gated modes) warn once per process
  // rather than on every session switch.
  let prewalkAutoArmNoticeShown = false;
  const autoArmPrewalk = async (context: ExtensionContext): Promise<void> => {
    const skipReason = await autoArmFabricPrewalk(state, context, pi);
    if (!skipReason || prewalkAutoArmNoticeShown || !context.hasUI) return;
    prewalkAutoArmNoticeShown = true;
    context.ui.notify(skipReason, "warning");
  };

  const cleanupActivationSideEffects = (): void => {
    uninstallHaltOnEscape();
    fabricUi.stop();
  };
  state.setActivationHook(async (context) => {
    refreshCodePreviewSettings();
    Object.assign(
      fabricTool,
      createFabricExecTool(state, codePreviewSettings, pendingHandoffs, decorateShell, toolDisplay),
    );
    await autoArmPrewalk(context);
    applyFabricMode();
    fabricUi.start(context);
    installHaltOnEscape(context);
  }, cleanupActivationSideEffects);

  pi.on("session_start", async (_event, context) => {
    pendingHandoffs.clear();
    directToolApproval.clear();
    toolDisplay.clear();
    uninstallHaltOnEscape();
    fabricUi.stop();
    suspendToolCapture();
    capabilityAdvisor.reset();
    refreshAdvisorLedger(context);
    if (!compatibilityWarningShown) {
      compatibilityWarningShown = true;
      const warning = piHostCompatibilityWarning();
      if (warning) {
        console.warn(`[pi-fabric] ${warning}`);
        if (context.hasUI) context.ui.notify(warning, "warning");
      }
    }
    await state.bootstrap(context);
    refreshCodePreviewSettings();
    applyFabricMode();
    if (state.shouldEagerlyActivate(context)) await state.ensure(context);
  });

  // Branch changes move the leaf: ash, emitted echoes, and spent advisory
  // budget must track it exactly. Rewind removes abandoned-branch residue.
  pi.on("session_tree", async (_event, context) => {
    capabilityAdvisor.reset();
    refreshAdvisorLedger(context);
    // Pi emits session_tree before it clears and rebuilds the transcript:
    // drop card invalidators from abandoned branches so a later display-mode
    // switch only refreshes cards registered by the rebuilt active branch.
    toolDisplay.clear();
    return undefined;
  });

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
    // Furnace feedback: did the just-fired advisory lead to captured tool use?
    capabilityAdvisor.endTurn();
    if (state.initialized) await state.publishHostLifecycle("pi.turn_end", event);
  });

  pi.on("agent_settled", async (event, context) => {
    if (!state.initialized) {
      await compactAtConfiguredThreshold(context, state.config);
      return;
    }
    const sessionId = context.sessionManager.getSessionId();
    const settledInPlace = await settleInPlacePrewalk(state.prewalk, pi, context, {
      compactOnReturn: state.config.prewalk.compactOnReturn,
      compact: state.compact,
    });
    if (!settledInPlace && state.prewalk.settleTask(sessionId)) {
      const status = state.prewalk.status();
      context.ui.setStatus(
        "fabric-prewalk",
        status.state === "armed" ? `armed → ${status.model}` : undefined,
      );
    }
    // Drift baselines track armed windows: re-anchor when still armed (a
    // re-arm starts each new window from the just-settled tree state), drop
    // once prewalk is no longer armed for this session.
    if (state.prewalk.status().state === "armed") {
      void state.prewalkDrift.captureBaseline(sessionId, context.cwd);
    } else {
      state.prewalkDrift.drop(sessionId);
    }
    // Keep the completed widget mounted until a newer Fabric run replaces it.
    // Removing rows at settle would pull the editor and latest chat content upward.
    // Pi's compact API is callback-based. Await the controller's Promise here
    // so ExtensionRunner does not finish this handler (and Pi does not publish
    // its public agent_settled event) before compaction settles.
    await state.compact.maybeCommit(context);
    await compactAtConfiguredThreshold(context, state.config);
    await state.publishHostLifecycle("pi.agent_settled", event);
  });

  pi.on("tool_call", (event, context) =>
    fabricToolLifecycle.toolCall(event, context));

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

  pi.on("message_end", (event) => {
    if (event.message.role !== "toolResult") return undefined;
    const message = event.message as AgentToolResultMessage & { usage?: Usage };
    const usage = directToolApproval.takeUsage(message.toolCallId);
    if (!usage) return undefined;
    return {
      message: {
        ...message,
        usage: mergeFabricApprovalUsage(message.usage, usage),
      },
    };
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
    const formatted = formatFabricValue(
      handoff,
      pending.resultFormat,
      state.config.executor.maxOutputChars,
    );
    const output = truncateMiddle(
      formatted.text || "(no output)",
      state.config.executor.maxOutputChars,
    );
    // Directive lands after truncation so it survives maxOutputChars, and
    // gates on "still armed" so one-shot trajectory handoffs stay silent.
    const text = withTrajectoryRearmDirective(
      output,
      pending,
      handoff,
      state.prewalk,
      context.sessionManager.getSessionId(),
    );
    const boundarySucceeded = handoff.completed === true || handoff.continued === true;
    const details =
      typeof event.message.details === "object" &&
      event.message.details !== null &&
      !Array.isArray(event.message.details) &&
      "success" in event.message.details
        ? { ...event.message.details, success: boundarySucceeded }
        : event.message.details;
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text }],
        details,
        isError: !boundarySucceeded,
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
      state.cwd
        ? state.config.compaction.engine
        : DEFAULT_FABRIC_CONFIG.compaction.engine,
    getTargetContextRatio: () =>
      state.cwd
        ? state.config.compaction.targetContextRatio
        : DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
    getThresholdContextRatio: (modelKey) =>
      state.cwd
        ? state.config.compaction.thresholds[modelKey]
        : DEFAULT_FABRIC_CONFIG.compaction.thresholds[modelKey],
    getThresholdTokens: (modelKey) =>
      state.cwd
        ? state.config.compaction.tokenThresholds[modelKey]
        : DEFAULT_FABRIC_CONFIG.compaction.tokenThresholds[modelKey],
  });

  pi.on("context", (event, context) => {
    const sessionId = context.sessionManager.getSessionId();
    const continuation = filterPrewalkContinuationMessages(
      event.messages,
      (continuationId) => state.initialized &&
        state.prewalk.acceptContinuation(sessionId, continuationId),
    );
    let changed = continuation.changed;
    const messages = continuation.messages.map((message) => {
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
    const fullCodeMode = state.cwd
      ? state.config.fullCodeMode
      : DEFAULT_FABRIC_CONFIG.fullCodeMode;
    const schemaMode = state.cwd
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
      ? "Pi Fabric full code mode: `fabric_exec` is the only way to call Pi core tools — use them as `pi.*` inside `code`.\nExamples and returns: `pi.read('/x')`, `pi.grep('TODO','src')` / `pi.grep({pattern:'TODO', path:'src', ignoreCase:true, context:2})`, `pi.find({pattern:'*.ts', path:'src', limit:20})`, and `pi.ls('src')` return strings; `pi.bash({cmd:'ls'})`, `pi.edit({path:'/x', old:'a', new:'b'})`, and `pi.write({path:'/y', text:'z'})` return `{ok, output, details}` (read `.output`); failed core calls reject, including `bash` on an ordinary nonzero exit; pass `settle: true` to `pi.bash` to get `{ ok: false, exitCode, output, error }` instead. Timeout, cancellation, approval, and security failures still reject.\n`tools` is discovery + generic calls only (`providers`/`catalog`/`list`/`search`/`describe`/`call`/`models`). Call known MCP tools as `mcp.<sanitized_server>.<sanitized_tool>(args)`, captured tools as `extensions.<tool>(args)`, and stable providers as `memory.*`, `state.*`, `schema.*`, or `compact.*`. Use `tools.call({ref,args})` for computed refs. `pi` is the core tools; `π.<key>` reads named `strings` (not a tool)."
      : "Pi Fabric is in orchestration-only mode. Pi core and registered extension tools stay on their native direct execution path; inside fabric_exec, `pi.*` and `extensions.*` are unavailable. Call known actions through `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, `components.*`, `compact.*`, `agents.*`, or `mesh.*`; use `tools.catalog`/`search`/`describe`/`list` for discovery and `tools.call({ref,args})` for computed refs. Other surfaces are opt-in via user-loaded skills.")
      + (schemaMode === "enforce"
        ? "\n\nSchema enforce mode is fixed for this session. Reads remain available, but protected-workspace changes must use schema.hypothesize → schema.verify → schema.commit in the same fabric_exec invocation. Direct pi.edit/write/bash, agents, state/mesh writes, compaction requests, MCP, extensions, and external providers are blocked by the host gate."
        : schemaMode === "audit"
          ? "\n\nSchema audit mode reports actions that enforce mode would block, but preserves their current behavior."
          : "")
      + (skillReferenceGuidance ? `\n\n${skillReferenceGuidance}` : "");
    const overrideGuidance = effectiveFullCodeMode && schemaMode !== "enforce"
      ? coreOverridePromptGuidance(capturedTools)
      : "";
    // One-shot capability steering: when the prompt's vocabulary matches a
    // capability source's fingerprint, name the tools once so the model
    // reaches for extensions.* / mcp.* instead of re-implementing them. Slice
    // membership already encodes visibility (captured tools only while
    // hidden; MCP while mcp.advisory is on), so any non-empty index fires.
    const captureSnapshot = state.cwd ? capturePolicy() : undefined;
    const advisory =
      captureSnapshot && capabilityAdvisor.hasSources()
        ? capabilityAdvisor.evaluate(event.prompt, captureSnapshot.advisory)
        : undefined;
    // No separate persistence: ash already lives in memory, and the custom
    // message below is the transcript record a session replay recovers after
    // a reload.
    return {
      systemPrompt: `${systemPrompt}\n\n${guidance}${overrideGuidance}`,
      ...(advisory
        ? {
            message: {
              customType: CAPABILITY_ADVISORY_CUSTOM_TYPE,
              content: advisory.content,
              display: advisory.display,
              details: advisory.details,
            },
          }
        : {}),
    };
  });

  registerFabricActorHostEventObservers(pi, (eventName, event, context) => {
    if (!state.initialized) return;
    state.dispatchHostEvent(eventName, event, context);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeComponentRegistration();
    unsubscribeProviderRegistration();
    pendingHandoffs.clear();
    directToolApproval.clear();
    toolDisplay.clear();
    try {
      await state.shutdown();
    } finally {
      uninstallHaltOnEscape();
      fabricUi.stop();
      suspendToolCapture();
      toolOwnership.release();
      fabricToolLifecycle.clear();
      toolCapture.dispose();
    }
  });

  // Turn-scoped invariant: even if another extension rewrote the active tool
  // set (e.g. a permission system filtering its allowlist at before_agent_start,
  // or a refresh that ran before Fabric's policy was active), captured tools
  // must not leak into the model's next turn.
  pi.on("before_agent_start", () => {
    reassertToolOwnership();
  });

  registerFabricCommand(pi, {
    state,
    fabricUi,
    capturedTools,
    applyFabricMode,
    suspendToolCapture,
    refreshCodePreviewSettings,
    refreshToolDisplay: () => toolDisplay.refresh(),
  });
}

export * from "./audit/index.js";
export * from "./protocol.js";
