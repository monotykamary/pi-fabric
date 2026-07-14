import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import { Type } from "typebox";
import { CapturedToolCatalog } from "./capture/catalog.js";
import { installRegisteredToolCapture } from "./capture/interceptor.js";
import { registerFabricCommand } from "./commands/fabric.js";
import { DEFAULT_FABRIC_CONFIG, effectiveToolCaptureConfig } from "./config.js";
import { FabricToolOwnership } from "./core/tool-ownership.js";
import { FabricState } from "./fabric-state.js";
import { FABRIC_PROVIDER_REGISTER_EVENT, type FabricProviderRegistration } from "./protocol.js";
import { FabricUiController } from "./ui/controller.js";
import {
  expandHint,
  isNumberedTool,
  modelReadHint,
  nestedCallBody,
  nestedCallCode,
  nestedCallTitle,
  nestedEditDiff,
  type FabricRenderAudit,
} from "./ui/fabric-render.js";
import { highlightCode, initHighlighting } from "./ui/highlight.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { truncateMiddle } from "./util.js";

const RESULT_FORMATS = ["auto", "json", "text"] as const;
type ResultFormat = (typeof RESULT_FORMATS)[number];

// Absolute path to the Fabric skills bundled with this extension. Resolved
// relative to the extension entry so it works both in development (src/) and
// in an installed package (dist/). Contributed via resources_discover so child
// Pi processes that load Fabric with -e (subagents and actors) discover the
// same fabric-exec / fabric-advisor / fabric-council skill references as the
// main agent, which gets them through the package manifest.
const FABRIC_SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
);

// Appended to the system prompt each agent run. Lives in the system prompt
// (the most cache-stable prefix), not the tool schema — applyFabricMode()
// re-registers the tool on several lifecycle events, so the system prompt is
// the more reliable cached surface for persistent guidance.
const FABRIC_TEMPLATE_LITERAL_CAVEAT =
  "Caveat: when a fabric_exec program builds a string containing literal `${...}` (shell snippets, MCP/agent args, grep patterns), avoid TS template literals — TS interpolates `${var}` into a 'Cannot find name' type error, or substitutes silently if a same-named variable exists. Use a plain quoted string or pass the content via the `strings` param and reference it as `π.key`.";

const safeTerminalText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00";
    return `\\x${code}`;
  });

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const PROGRESS_PREVIEW_LINES = 3;

// A streaming bash call can dump many lines of stdout into `progress`. In a
// multitool partial render that shoves the rest of the call list around, so
// tail-window the progress to a fixed line count and keep the height stable.
const tailProgressPreview = (progress: string, theme: Theme): string => {
  const escaped = safeTerminalText(progress);
  const lines = escaped.split("\n");
  if (lines.length <= PROGRESS_PREVIEW_LINES) return theme.fg("dim", escaped);
  const hidden = lines.length - PROGRESS_PREVIEW_LINES;
  const tail = lines.slice(lines.length - PROGRESS_PREVIEW_LINES);
  return theme.fg("dim", `… ${hidden} lines streaming\n${tail.join("\n")}`);
};

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
  const codePreviewSettings = await loadCodePreviewSettings(process.cwd());
  void initHighlighting(
    codePreviewSettings.shikiTheme,
    codePreviewSettings.syntaxHighlighting,
  );
  const capturedTools = new CapturedToolCatalog();
  const state = new FabricState(pi, capturedTools);
  const toolOwnership = new FabricToolOwnership(pi);
  const fabricUi = new FabricUiController(state);

  pi.events.on(FABRIC_PROVIDER_REGISTER_EVENT, (value: unknown) => {
    const registration = registrationFrom(value);
    if (!registration) throw new Error("Invalid Pi Fabric provider registration");
    state.registerExternal(
      registration.provider,
      registration.overwrite === undefined ? {} : { overwrite: registration.overwrite },
    );
  });

  pi.on("resources_discover", async () => {
    if (existsSync(FABRIC_SKILLS_DIR)) return { skillPaths: [FABRIC_SKILLS_DIR] };
    return {};
  });

  const fabricTool = withCodePreviewShell(
    defineTool({
      name: "fabric_exec",
      label: "Fabric",
      description:
        "Execute type-checked TypeScript in a QuickJS sandbox for Pi core tools, MCP, agents, actors, workflows, mesh coordination, councils, and recursive orchestration. In full code mode, this is the exclusive path to Pi core tools.",
      promptSnippet:
        "Compose Pi core tools, MCP tools, workflows, persistent actors, agents, and mesh state",
      promptGuidelines: [
        "Inside fabric_exec, route by surface: MCP is mcp.<server>.<tool>(args); subagents and persistent actors are agents.*; mesh coordination is mesh.*; scripted fan-out is workflow.agent()/parallel()/pipeline()/phase() (aliases agent/parallel/pipeline/phase), with workflow.configure()/item()/event() for a live dashboard on long setups.",
        "`pi.*` tools take a single options object, never positional args. The `fabric-exec` skill has the full reference (exact signatures, `tools` discovery, `π` strings, validate/describe/retry) plus reference files for MCP, agents/rlm, and mesh.",
        "Use agents.create() for persistent mailbox actors; subscribe to host events for ambient behavior or mesh topics for peer coordination; directive response mode when silence/intervention is conditional.",
        "Batch independent operations in one `fabric_exec` program (`Promise.all` for parallel, sequential `await` for ordered), not one call per tool; keep dependent/conditional steps sequential. Return only the compact final value; intermediate results stay in the sandbox. Use council.run()/rlm.query() only when their cost is justified.",
        "workflow.parallel accepts (items, mapper, concurrency?) to map over items or (thunks, concurrency?) to run zero-arg functions; concurrency may be a bare number.",
      ],
      // The model-facing schema is intentionally flat: one large `code` string
      // plus scalar/optional params. Do not add nested arrays-of-objects with
      // escaped content here. SOTA models are post-trained on one dominant
      // harness's flat tool shapes and can invent trailing keys at the
      // highest-entropy point of a nested escaped-JSON field, which a strict
      // schema hard-rejects. Keep this surface string/scalar-heavy; the only
      // nested field (display) ignores unknown keys. See
      // lucumr.pocoo.org/2026/7/4/better-models-worse-tools/ and pi-tool-repair.
      parameters: Type.Object({
        code: Type.String({
          description:
            "TypeScript function body. Top-level await and return are supported. Globals: tools, mcp, agents, mesh, workflow, agent, parallel, pipeline, phase, council, rlm, print, π (named strings via the `strings` param). In full code mode, also pi (Pi core tools) and extensions.",
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
        display: Type.Optional(
          Type.Object(
            {
              name: Type.Optional(
                Type.String({ description: "Human-readable name for the Fabric activity panel" }),
              ),
              description: Type.Optional(
                Type.String({ description: "Compact objective shown in the Fabric dashboard" }),
              ),
            },
          ),
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
        const displayName = params.display?.name ? safeTerminalText(params.display.name) : "";
        const title = `${theme.fg("toolTitle", theme.bold("fabric"))}${
          displayName ? ` ${theme.fg("accent", displayName)}` : ""
        } ${theme.fg("dim", `TypeScript · ${countLabel(lines.length, "line")}`)}`;
        const hiddenHint =
          hidden > 0
            ? `\n${theme.fg("dim", `… ${countLabel(hidden, "line")} hidden · `)}${expandHint(theme)}`
            : "";
        return new Text(
          `${title}${preview ? `\n${preview}` : ""}${hiddenHint}`,
          0,
          0,
        );
      },
      renderResult(result, { expanded, isPartial }, theme, context) {
        const details = result.details as
          | {
              success?: boolean;
              progress?: string;
              error?: string;
              audits?: FabricRenderAudit[];
              phases?: string[];
            }
          | undefined;
        const audits = details?.audits ?? [];
        const phases = details?.phases ?? [];
        const nl = "\n";

        const renderBody = (
          audit: FabricRenderAudit,
          limit: number,
        ): { body: string; hidden: number } | null => {
          let bodyLines: string[] | null = null;
          let numbered = false;
          let raw = false;
          const editDiff = nestedEditDiff(audit, theme, context?.invalidate);
          if (editDiff) {
            bodyLines = editDiff;
            raw = true;
          } else {
            const codeInfo = nestedCallCode(audit);
            if (codeInfo) {
              const highlighted = highlightCode(
                codeInfo.code,
                codeInfo.lang,
                context?.invalidate,
              );
              if (highlighted) {
                bodyLines = highlighted.map((line) => line || " ");
                numbered = true;
                raw = true;
              }
            }
            if (!bodyLines) {
              const body = nestedCallBody(audit);
              if (body) {
                bodyLines = safeTerminalText(body).split(nl);
                numbered = isNumberedTool(audit);
              }
            }
          }
          if (bodyLines) {
            while (bodyLines.length > 0) {
              const last = bodyLines[bodyLines.length - 1];
              if (last === undefined || last.trim() === "") bodyLines.pop();
              else break;
            }
            if (bodyLines.length === 0) bodyLines = null;
          }
          if (!bodyLines) return null;
          const shown = bodyLines.slice(0, limit);
          const body = shown
            .map((line, index) => {
              const content = raw ? line : theme.fg("toolOutput", line || " ");
              return numbered
                ? `${theme.fg("dim", String(index + 1).padStart(3, " "))} ${content}`
                : content;
            })
            .join(nl);
          return { body, hidden: bodyLines.length - shown.length };
        };

        if (isPartial) {
          const progress = details?.progress;
          if (audits.length === 0) {
            return new Text(
              theme.fg(
                "warning",
                `◆ ${safeTerminalText(progress ?? "Running Fabric program…")}`,
              ),
              0,
              0,
            );
          }
          if (audits.length === 1) {
            const audit = audits[0]!;
            const glyph =
              audit.success === undefined
                ? theme.fg("warning", "◐")
                : audit.success === false
                  ? theme.fg("error", "✗")
                  : theme.fg("dim", "›");
            let text = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate)}`;
            if (audit.success === false && audit.error) {
              text += nl + `  ${theme.fg("error", safeTerminalText(audit.error))}`;
            }
            if (progress) text += nl + theme.fg("dim", safeTerminalText(progress));
            return new Text(text, 0, 0);
          }
          const done = audits.filter(
            (audit) => audit.success !== undefined,
          ).length;
          let text = theme.fg(
            "warning",
            `◆ Fabric running · ${done}/${audits.length} calls`,
          );
          for (const audit of audits) {
            const glyph =
              audit.success === undefined
                ? theme.fg("warning", "◐")
                : audit.success === false
                  ? theme.fg("error", "✗")
                  : theme.fg("dim", "›");
            text += nl + `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate)}`;
            if (audit.success === false && audit.error) {
              text += nl + `  ${theme.fg("error", safeTerminalText(audit.error))}`;
            }
          }
          if (progress) text += nl + tailProgressPreview(progress, theme);
          return new Text(text, 0, 0);
        }

        const output = result.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join(nl);
        const failed = details?.success === false;

        if (audits.length === 0) {
          if (failed && details?.error) {
            return new Text(
              theme.fg("error", `✗ ${safeTerminalText(details.error)}`),
              0,
              0,
            );
          }
          if (!output) return new Text(theme.fg("dim", "✓ Fabric"), 0, 0);
          const lines = safeTerminalText(output).split(nl);
          const limit = expanded ? Math.min(lines.length, 200) : 12;
          const shown = lines.slice(0, limit);
          let text = shown
            .map((line) => theme.fg("toolOutput", line || " "))
            .join(nl);
          if (lines.length > shown.length) {
            text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")}`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
          return new Text(text, 0, 0);
        }

        if (audits.length === 1) {
          const audit = audits[0]!;
          let text = nestedCallTitle(audit, theme, context?.invalidate);
          if (audit.success === false) {
            if (audit.error) {
              text += nl + theme.fg("error", safeTerminalText(audit.error));
            }
            return new Text(text, 0, 0);
          }
          const limit = expanded ? 200 : 12;
          const rendered = renderBody(audit, limit);
          if (rendered) {
            text += nl + rendered.body;
            if (rendered.hidden > 0) {
              text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
              if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
            }
            const readHint = modelReadHint(audits, output, theme);
            if (readHint) text += nl + readHint;
          } else if (output) {
            const lines = safeTerminalText(output).split(nl);
            const outLimit = expanded ? Math.min(lines.length, 200) : 12;
            const outShown = lines.slice(0, outLimit);
            text += nl + outShown
              .map((line) => theme.fg("toolOutput", line || " "))
              .join(nl);
            if (lines.length > outShown.length) {
              text += nl + theme.fg("dim", `… ${countLabel(lines.length - outShown.length, "line")}`);
              if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
            }
          }
          return new Text(text, 0, 0);
        }

        const failedCalls = audits.filter(
          (audit) => audit.success === false,
        ).length;
        const status = failed ? "failed" : "complete";
        const statusColor = failed ? "error" : "success";
        const metadata = [
          countLabel(audits.length, "nested call"),
          failedCalls > 0 ? `${failedCalls} failed` : undefined,
          phases.length > 0 ? countLabel(phases.length, "phase") : undefined,
        ].filter((value): value is string => Boolean(value));
        let text = theme.fg(
          statusColor,
          `${failed ? "✗" : "✓"} Fabric ${status}`,
        );
        if (metadata.length > 0) text += theme.fg("dim", ` · ${metadata.join(" · ")}`);
        if (phases.length > 0)
          text += nl + theme.fg("dim", phases.map((phase) => `◆ ${phase}`).join("  "));

        const callLimit = expanded ? 30 : 8;
        const callsShown = audits.slice(0, callLimit);
        const callsHidden = audits.length - callsShown.length;
        let firstNested = true;
        for (const audit of callsShown) {
          if (expanded && !firstNested) text += nl;
          firstNested = false;
          const glyph =
            audit.success === false ? theme.fg("error", "✗") : theme.fg("dim", "›");
          text += nl + `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate)}`;
          if (audit.success === false && audit.error) {
            text += nl + `  ${theme.fg("error", safeTerminalText(audit.error))}`;
          } else if (expanded) {
            const rendered = renderBody(audit, 40);
            if (rendered) {
              text += nl + rendered.body;
              if (rendered.hidden > 0) {
                text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
              }
            }
          }
        }
        if (callsHidden > 0) {
          text += nl + theme.fg("dim", `… ${countLabel(callsHidden, "nested call")} hidden`);
          if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
        }
        const readHint = modelReadHint(audits, output, theme);
        if (readHint) text += nl + readHint;

        const showOutput = failed || expanded;
        if (showOutput && output) {
          const lines = safeTerminalText(output).split(nl);
          const limit = expanded ? Math.min(lines.length, 200) : 6;
          const shown = lines.slice(0, limit);
          if (shown.length > 0) {
            if (expanded) text += nl + theme.fg("dim", "↩ return");
            text += nl + shown.map((line) => theme.fg("toolOutput", line || " ")).join(nl);
            if (lines.length > shown.length) {
              text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")} hidden`);
              if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
            }
          }
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
          ...(params.display
            ? {
                display: {
                  ...(params.display.name !== undefined && { name: params.display.name }),
                  ...(params.display.description !== undefined && { description: params.display.description }),
                },
              }
            : {}),
          onPartial(snapshot) {
            onUpdate?.({
              content: [{ type: "text", text: snapshot.progress ?? "" }],
              details: {
                progress: snapshot.progress,
                audits: snapshot.audits,
              },
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
    toolOwnership.apply(state.config.fullCodeMode);
  };
  const suspendToolCapture = (): void => {
    toolCapture.setPolicy(inactiveCapturePolicy);
  };

  // ESC interrupt: a lone Escape (debounced to ignore escape sequences such as
  // arrow keys) halts every persistent actor — aborting in-flight runs and
  // cancelling queued work — without tearing the actors down. Escape is
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
        halted = state.actors.haltAll().halted;
      } catch {
        return;
      }
      if (halted > 0) {
        context.ui.notify(
          `Fabric: halted ${halted} actor${halted === 1 ? "" : "s"} (Esc)`,
          "warning",
        );
      }
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
    fabricUi.stop();
    suspendToolCapture();
    await state.initialize(context);
    applyFabricMode();
    fabricUi.start(context);
    installHaltOnEscape(context);
  });

  pi.on("session_shutdown", async () => {
    try {
      uninstallHaltOnEscape();
      fabricUi.stop();
      suspendToolCapture();
      toolOwnership.release();
      await state.shutdown();
    } finally {
      toolCapture.dispose();
    }
  });

  pi.on("input", async (event, context) => {
    if (!state.initialized) return;
    toolOwnership.apply(state.config.fullCodeMode);
    state.dispatchHostEvent("input", event, context);
  });

  pi.on("turn_end", async (event, context) => {
    if (!state.initialized) return;
    toolOwnership.apply(state.config.fullCodeMode);
    state.dispatchHostEvent("turn_end", event, context);
  });

  pi.on("agent_settled", async (event, context) => {
    if (!state.initialized) return;
    toolOwnership.apply(state.config.fullCodeMode);
    state.dispatchHostEvent("agent_settled", event, context);
    fabricUi.dismissOnSettle();
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
    const fullCodeMode = state.initialized
      ? state.config.fullCodeMode
      : DEFAULT_FABRIC_CONFIG.fullCodeMode;
    toolOwnership.apply(fullCodeMode);
    state.widgetDismissedAt = Date.now();
    if (!pi.getActiveTools().includes("fabric_exec")) return;
    const guidance = (fullCodeMode
      ? "Pi Fabric full code mode is on: fabric_exec is the only path to Pi core tools (read, bash, edit, write, grep, find, ls); direct core tools are unavailable. `π.<key>` is only for named strings from the `strings` parameter. Hidden extension tools are discoverable via `tools.search({ query })`/`tools.describe({ ref })` and callable via `extensions.<tool>(options)` or `tools.call({ ref, args })`."
      : "Pi Fabric is in orchestration-only mode. Keep Pi core and registered extension tools on their native direct execution path. Inside fabric_exec, use only MCP, agents, actors, workflows, mesh coordination, councils, recursive queries, and explicit Fabric providers; pi.* and extensions.* are unavailable.")
      + "\n\n" + FABRIC_TEMPLATE_LITERAL_CAVEAT;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
    };
  });

  registerFabricCommand(pi, { state, fabricUi, capturedTools, applyFabricMode, suspendToolCapture });
}

export * from "./protocol.js";
