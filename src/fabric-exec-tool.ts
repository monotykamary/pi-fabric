import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  type CodePreviewSettings,
  type FabricToolShellDecorator,
  withLightweightCodePreviewShell,
} from "./ui/code-preview.js";
import { Type } from "typebox";
import {
  createFabricPersistedExecutionDetails,
  readFabricExecutionRenderDetails,
} from "./audit/index.js";
import { DEFAULT_FABRIC_CONFIG } from "./config.js";
import type { FabricState } from "./fabric-state.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import type { FabricMediaBlock } from "./protocol.js";
import {
  captureFabricAgentPreviews,
  captureFabricCallHeadlinePreviews,
  captureFabricCoreToolPreviews,
  captureFabricWritePreviews,
  expandHint,
  fabricMulticallCallLimit,
  fabricWriteBindings,
  inheritComponentBackground,
  modelReadHint,
  nestedCallBody,
  nestedCallTitle,
  renderBoundedLines,
  renderFabricMulticallPartial,
  renderFabricWriteArgumentPreview,
  renderNestedAgentToolLines,
  restoreFabricAgentPreviews,
  restoreFabricCallHeadlinePreviews,
  restoreFabricCoreToolPreviews,
  restoreFabricWritePreviews,
  restoreLegacyBashCommands,
  safeTerminalText,
  singleCallProgressLine,
  type FabricAgentPreview,
  type FabricCallHeadlinePreview,
  type FabricCoreToolPreview,
  type FabricRenderAudit,
  type FabricWriteBinding,
  type FabricWritePreview,
} from "./ui/fabric-render.js";
import {
  coreToolPreviewEnabled,
  coreToolRendererEnabled,
  isCoreToolAudit,
  renderCoreToolBody,
} from "./ui/core-tool-render.js";
import { highlightCode } from "./ui/highlight.js";
import {
  HiddenRowBorrowingComponent,
  observeResultRows,
  type ResultRowBalance,
} from "./ui/row-balance.js";
import { type SpinnerTimerState, updateSpinner } from "./ui/spinner.js";
import { formatFabricValue } from "./ui/structured.js";
import { countNewlines, truncateMiddle } from "./util.js";

const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const MAX_FABRIC_CODE_TRANSFER_LINES = 12;

type FabricRendererState = {
  fabricWriteBindingsCode?: string;
  fabricWriteBindings?: FabricWriteBinding[];
  fabricWritePreviews?: FabricWritePreview[];
  fabricCoreToolPreviews?: FabricCoreToolPreview[];
  fabricCallHeadlinePreviews?: FabricCallHeadlinePreview[];
  fabricAgentPreviews?: FabricAgentPreview[];
  fabricResultRowBalance?: ResultRowBalance;
  fabricSpinner?: SpinnerTimerState;
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

export const createFabricExecTool = (
  state: FabricState,
  codePreviewSettings: CodePreviewSettings,
  pendingHandoffs: Map<string, PendingFabricHandoff>,
  decorateShell: FabricToolShellDecorator = withLightweightCodePreviewShell,
): ToolDefinition<any, any, any> => decorateShell(
  defineTool({
    name: "fabric_exec",
    label: "Fabric",
    description:
      "Execute type-checked TypeScript through Fabric's configured executor for Pi core tools, MCP, Fabric providers, discovery, and extensions. QuickJS is isolated by default; the optional Node process is an unsafe trusted-code escape hatch. In full code mode, and always in Schema enforce mode, this is the exclusive model tool path.",
    promptSnippet:
      "Pi core tools, MCP, Fabric providers, discovery, and extensions",
    promptGuidelines: [
      "Batch independent operations in one `fabric_exec` program (`Promise.all` for parallel, sequential `await` for ordered), not one call per tool; keep dependent/conditional steps sequential. Return only the compact final value; intermediate results stay in the sandbox.",
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
          "TypeScript function body. Top-level await and return are supported. Globals include `tools`, `mcp`, `memory`, `state`, `schema`, `compact`, `agents`, `mesh`, `print`, and `π`; full-code mode adds `pi` and `extensions`. See session guidance / `fabric-exec` skill for exact signatures.",
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
      const code = Array.isArray(params.code) ? params.code.join("\n") : params.code;
      const rendererState = context.state as FabricRendererState;
      const spinner = updateSpinner(
        rendererState.fabricSpinner ??= {},
        context.isPartial,
        context.invalidate,
      );
      const rowBalance = rendererState.fabricResultRowBalance ??= {};
      if (rendererState.fabricWriteBindingsCode !== code) {
        rendererState.fabricWriteBindingsCode = code;
        rendererState.fabricWriteBindings = fabricWriteBindings(code);
      }
      const writePreview = context.executionStarted
        ? null
        : renderFabricWriteArgumentPreview(
            {
              bindings: rendererState.fabricWriteBindings ?? [],
              strings: params.strings,
              expanded: context.expanded,
              cwd: context.cwd,
              settings: codePreviewSettings,
              spinner,
            },
            theme,
            context.invalidate,
          );

      const lines = safeTerminalText(code).split("\n");
      const displayName = params.display?.name ? safeTerminalText(params.display.name) : "";
      const title = `${theme.fg("toolTitle", theme.bold("fabric"))}${
        displayName ? ` ${theme.fg("accent", displayName)}` : ""
      } ${theme.fg("dim", `TypeScript · ${countLabel(lines.length, "line")}`)}`;
      const baseLimit = context.expanded ? lines.length : Math.min(lines.length, 8);
      const maxLimit = context.expanded
        ? lines.length
        : Math.min(lines.length, baseLimit + MAX_FABRIC_CODE_TRANSFER_LINES);
      const renderCodePreview = (limit: number, width: number): string[] => {
        const shown = lines.slice(0, limit);
        const lineNumberWidth = String(Math.max(1, shown.length)).length;
        const preview = shown
          .map(
            (line, index) =>
              `${theme.fg("dim", String(index + 1).padStart(lineNumberWidth, " "))} ${theme.fg("muted", line || " ")}`,
          )
          .join("\n");
        const hidden = lines.length - shown.length;
        const hiddenHint =
          hidden > 0
            ? `\n${theme.fg("dim", `… ${countLabel(hidden, "line")} hidden · `)}${expandHint(theme)}`
            : "";
        return new Text(
          `${title}${preview ? `\n${preview}` : ""}${hiddenHint}`,
          0,
          0,
        ).render(width);
      };
      const codePreview = new HiddenRowBorrowingComponent(
        baseLimit,
        maxLimit,
        renderCodePreview,
        rowBalance,
      );
      if (!writePreview) return codePreview;
      const composite = new Container();
      composite.addChild(codePreview);
      composite.addChild(new Text("\n", 0, 0));
      composite.addChild(writePreview);
      return composite;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = readFabricExecutionRenderDetails(result.details);
      let audits = restoreLegacyBashCommands(
        details.audits as FabricRenderAudit[],
        context.args,
      );
      const rendererState = context.state as FabricRendererState;
      const spinner = updateSpinner(
        rendererState.fabricSpinner ??= {},
        isPartial,
        context.invalidate,
      );
      const rowBalance = rendererState.fabricResultRowBalance ??= {};
      const trackRows = (component: Component): Component =>
        observeResultRows(
          inheritComponentBackground(component),
          rowBalance,
          { expanded, isPartial },
        );
      if (isPartial) {
        rendererState.fabricCoreToolPreviews = captureFabricCoreToolPreviews(
          audits,
          rendererState.fabricCoreToolPreviews,
        );
        rendererState.fabricAgentPreviews = captureFabricAgentPreviews(
          audits,
          rendererState.fabricAgentPreviews,
        );
        const headlinePreviews = captureFabricCallHeadlinePreviews(audits);
        if (headlinePreviews.length > 0) {
          rendererState.fabricCallHeadlinePreviews = headlinePreviews;
        }
        const writePreviews = captureFabricWritePreviews(audits);
        if (writePreviews.length > 0) rendererState.fabricWritePreviews = writePreviews;
      } else {
        if (rendererState.fabricCoreToolPreviews) {
          audits = restoreFabricCoreToolPreviews(
            audits,
            rendererState.fabricCoreToolPreviews,
          );
        }
        if (rendererState.fabricAgentPreviews) {
          audits = restoreFabricAgentPreviews(audits, rendererState.fabricAgentPreviews);
        }
        if (rendererState.fabricCallHeadlinePreviews) {
          audits = restoreFabricCallHeadlinePreviews(
            audits,
            rendererState.fabricCallHeadlinePreviews,
          );
        }
        if (rendererState.fabricWritePreviews) {
          audits = restoreFabricWritePreviews(audits, rendererState.fabricWritePreviews);
        }
      }
      const phases = details.phases;
      const nl = "\n";
      const allRowIndexes = (lines: string[], enabled: boolean): ReadonlySet<number> | undefined =>
        enabled ? new Set(lines.map((_line, index) => index)) : undefined;
      const corePreviewContext = { cwd: context.cwd, settings: codePreviewSettings };
      const showNestedToolCalls = state.initialized
        ? state.config.ui.showNestedToolCalls
        : DEFAULT_FABRIC_CONFIG.ui.showNestedToolCalls;

      const renderBody = (
        audit: FabricRenderAudit,
        limit: number,
      ): { body: string; hidden: number } | null => {
        const core = renderCoreToolBody(audit, theme, {
          cwd: context.cwd,
          settings: codePreviewSettings,
          expanded,
          maxLines: limit,
          ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
        });
        if (core) return { body: core.lines.join(nl), hidden: core.hidden };
        if (coreToolRendererEnabled(audit, codePreviewSettings)) return null;

        const body = nestedCallBody(audit);
        if (!body) return null;
        const bodyLines = safeTerminalText(body).split(nl);
        while (bodyLines.length > 0) {
          const last = bodyLines[bodyLines.length - 1];
          if (last === undefined || last.trim() === "") bodyLines.pop();
          else break;
        }
        if (bodyLines.length === 0) return null;
        const shown = bodyLines.slice(0, limit);
        return {
          body: shown.map((line) => theme.fg("toolOutput", line || " ")).join(nl),
          hidden: bodyLines.length - shown.length,
        };
      };

      if (isPartial) {
        const progress = details.progress;
        if (audits.length === 0) {
          return trackRows(
            new Text(
              theme.fg(
                "warning",
                `◆ ${safeTerminalText(progress ?? "Running Fabric program…")}`,
              ),
              0,
              0,
            ),
          );
        }
        if (audits.length === 1) {
          const audit = audits[0]!;
          const glyph =
            audit.success === undefined
              ? theme.fg("warning", spinner)
              : audit.success === false
                ? theme.fg("error", "✗")
                : theme.fg("dim", "›");
          let text = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
          const nested = renderNestedAgentToolLines(audit, theme, {
            expanded,
            showTools: showNestedToolCalls,
            core: corePreviewContext,
            ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
          });
          const progressLine = singleCallProgressLine(progress, nested);
          if (audit.success === false && audit.error) {
            text += nl + `  ${theme.fg("error", safeTerminalText(audit.error))}`;
          } else {
            const rendered = renderBody(
              audit,
              expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 10,
            );
            if (rendered) {
              text += nl + rendered.body;
              if (rendered.hidden > 0) {
                text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
                if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
              }
            } else if (
              isCoreToolAudit(audit) &&
              !expanded &&
              !coreToolPreviewEnabled(audit, codePreviewSettings)
            ) {
              text += nl + theme.fg("muted", "╰─ ") + expandHint(theme);
            } else if (progressLine) {
              text += nl + theme.fg("dim", progressLine);
            }
          }
          if (audit.success !== false && nested[0]) {
            const firstBreak = text.indexOf(nl);
            if (firstBreak < 0) text += ` ${nested[0]}`;
            else text = `${text.slice(0, firstBreak)} ${nested[0]}${text.slice(firstBreak)}`;
            if (nested.length > 1) text += nl + nested.slice(1).join(nl);
          }
          const textLines = text.split(nl);
          return trackRows(
            renderBoundedLines(
              textLines,
              theme,
              codePreviewSettings.diffIntensity,
              allRowIndexes(textLines, nested.length > 0),
            ),
          );
        }
        let preview: { auditIndex: number; body: string; hidden: number } | undefined;
        for (let index = audits.length - 1; index >= 0; index--) {
          const audit = audits[index]!;
          if (audit.tool !== "write" || audit.success === false) continue;
          const rendered = renderBody(audit, expanded ? 20 : 10);
          if (rendered) {
            preview = { auditIndex: index, ...rendered };
            break;
          }
        }
        return trackRows(
          renderFabricMulticallPartial(
            {
              audits,
              phases,
              progress,
              expanded,
              preview,
              core: corePreviewContext,
              showNestedToolCalls,
              spinner,
            },
            theme,
            context?.invalidate,
          ),
        );
      }

      const output = result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(nl);
      const styleOutputLines = (lines: string[]): string[] => {
        if (!details.outputFormat || lines.length === 0) {
          return lines.map((line) => theme.fg("toolOutput", line || " "));
        }
        const highlightedStart = Math.min(
          lines.length,
          details.outputFormatStartLine ?? 0,
        );
        const highlightedCount = Math.min(
          lines.length - highlightedStart,
          details.outputFormatLines ?? lines.length,
        );
        const highlightedSource = lines.slice(
          highlightedStart,
          highlightedStart + highlightedCount,
        );
        const highlighted = highlightedSource.length > 0
          ? highlightCode(
              highlightedSource.join(nl),
              details.outputFormat,
              context?.invalidate,
            )
          : [];
        const styledPrefix = highlighted?.map((line) => line || " ")
          ?? highlightedSource.map((line) => theme.fg("toolOutput", line || " "));
        return [
          ...lines.slice(0, highlightedStart).map((line) => theme.fg("toolOutput", line || " ")),
          ...styledPrefix,
          ...lines
            .slice(highlightedStart + highlightedCount)
            .map((line) => theme.fg("toolOutput", line || " ")),
        ];
      };
      const failed = details.success === false;

      if (audits.length === 0) {
        if (failed && details.error) {
          return trackRows(
            new Text(
              theme.fg("error", `✗ ${safeTerminalText(details.error)}`),
              0,
              0,
            ),
          );
        }
        if (!output) return trackRows(new Text(theme.fg("dim", "✓ Fabric"), 0, 0));
        const lines = safeTerminalText(output).split(nl);
        const limit = expanded ? Math.min(lines.length, 200) : 12;
        const shown = lines.slice(0, limit);
        let text = styleOutputLines(shown).join(nl);
        if (lines.length > shown.length) {
          text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")}`);
          if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
        }
        return trackRows(
          renderBoundedLines(text.split(nl), theme, codePreviewSettings.diffIntensity),
        );
      }

      if (audits.length === 1) {
        const audit = audits[0]!;
        let text = nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext);
        const nested = renderNestedAgentToolLines(audit, theme, {
          expanded,
          showTools: showNestedToolCalls,
          core: corePreviewContext,
          ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
        });
        if (audit.success === false) {
          if (audit.error) {
            text += nl + theme.fg("error", safeTerminalText(audit.error));
          }
          return trackRows(new Text(text, 0, 0));
        }
        if (nested[0]) {
          text += ` ${nested[0]}`;
          if (nested.length > 1) text += nl + nested.slice(1).join(nl);
        }
        const limit =
          expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 12;
        const rendered = nested.length > 0 ? null : renderBody(audit, limit);
        if (rendered) {
          text += nl + rendered.body;
          if (rendered.hidden > 0) {
            text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
          const readHint = modelReadHint(audits, output, theme);
          if (readHint) text += nl + readHint;
        } else if (
          isCoreToolAudit(audit) &&
          !expanded &&
          !coreToolPreviewEnabled(audit, codePreviewSettings)
        ) {
          text += nl + theme.fg("muted", "╰─ ") + expandHint(theme);
        } else if (nested.length === 0 && output && !isCoreToolAudit(audit)) {
          const lines = safeTerminalText(output).split(nl);
          const outLimit = expanded ? Math.min(lines.length, 200) : 12;
          const outShown = lines.slice(0, outLimit);
          text += nl + styleOutputLines(outShown).join(nl);
          if (lines.length > outShown.length) {
            text += nl + theme.fg("dim", `… ${countLabel(lines.length - outShown.length, "line")}`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
        }
        const textLines = text.split(nl);
        return trackRows(
          renderBoundedLines(
            textLines,
            theme,
            codePreviewSettings.diffIntensity,
            allRowIndexes(textLines, nested.length > 0),
          ),
        );
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

      const callLimit = fabricMulticallCallLimit(expanded);
      const callsShown = audits.slice(0, callLimit);
      const callsHidden = audits.length - callsShown.length;
      let collapsedPreview:
        | { auditIndex: number; body: string; hidden: number }
        | undefined;
      if (!expanded) {
        for (let index = callsShown.length - 1; index >= 0; index--) {
          const audit = callsShown[index]!;
          if (audit.tool !== "write" || audit.success === false) continue;
          const rendered = renderBody(audit, 10);
          if (rendered) {
            collapsedPreview = { auditIndex: index, ...rendered };
            break;
          }
        }
      }
      let firstNested = true;
      const textRows = text.split(nl);
      const agentWrapLineIndexes = new Set<number>();
      for (let index = 0; index < callsShown.length; index++) {
        const audit = callsShown[index]!;
        if (expanded && !firstNested) textRows.push("");
        firstNested = false;
        const glyph =
          audit.success === false ? theme.fg("error", "✗") : theme.fg("dim", "›");
        const nested = renderNestedAgentToolLines(audit, theme, {
          expanded,
          compact: !expanded,
          showTools: showNestedToolCalls,
          core: corePreviewContext,
          ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
        });
        let callRow = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
        if (nested[0] && audit.success !== false) {
          callRow += ` ${nested[0]}`;
          if (expanded) agentWrapLineIndexes.add(textRows.length);
        }
        textRows.push(callRow);
        if (audit.success === false && audit.error) {
          textRows.push(`  ${theme.fg("error", safeTerminalText(audit.error))}`);
        } else {
          if (nested.length > 1) {
            for (const line of nested.slice(1)) {
              agentWrapLineIndexes.add(textRows.length);
              textRows.push(line);
            }
          }
          const rendered = nested.length === 0 && expanded ? renderBody(audit, 40) : null;
          if (rendered) {
            textRows.push(...rendered.body.split(nl));
            if (rendered.hidden > 0) {
              textRows.push(theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`));
            }
          } else if (nested.length === 0 && collapsedPreview?.auditIndex === index) {
            textRows.push(...collapsedPreview.body.split(nl).map((line) => `  ${line}`));
            if (collapsedPreview.hidden > 0) {
              textRows.push(theme.fg(
                "dim",
                `  … ${countLabel(collapsedPreview.hidden, "line")}`,
              ));
            }
          }
        }
      }
      text = textRows.join(nl);
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
          text += nl + styleOutputLines(shown).join(nl);
          if (lines.length > shown.length) {
            text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")} hidden`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
        }
      }
      return trackRows(
        renderBoundedLines(
          text.split(nl),
          theme,
          codePreviewSettings.diffIntensity,
          agentWrapLineIndexes,
        ),
      );
    },
    async execute(toolCallId, params, signal, onUpdate, context) {
      await state.ensure(context);
      // Defensive: a non-strict provider may deliver code as an array of lines;
      // join before type-checking so the program runs instead of failing on a
      // non-string code param. Strict providers reject an array upstream
      // against the Type.String schema, so this branch is a no-op there.
      const code = Array.isArray(params.code) ? params.code.join("\n") : params.code;
      const result = await state.execution.execute({
        code,
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
              phases: snapshot.phases,
            },
          });
        },
      });

      const selectedResultFormat =
        params.resultFormat ?? state.config.executor.resultFormat;
      const pendingHandoff = state.claimHandoff(
        result,
        context.sessionManager.getSessionId(),
        selectedResultFormat,
      );
      if (pendingHandoff) {
        pendingHandoffs.set(toolCallId, pendingHandoff);
        context.ui.setStatus(
          "fabric-prewalk",
          `waiting for fabric_exec boundary → ${String(pendingHandoff.args.model ?? "executor")}`,
        );
      }
      const formattedValue = formatFabricValue(result.value, selectedResultFormat);
      const sections = [...result.logs];
      const logPrefix = result.logs.join("\n\n");
      if (formattedValue.text) sections.push(formattedValue.text);
      if (result.error) sections.push(`Runtime error: ${result.error}`);
      const rawOutput = sections.join("\n\n");
      const outputWillTruncate = rawOutput.length > state.config.executor.maxOutputChars;
      const outputFormat =
        formattedValue.language &&
        formattedValue.text &&
        (result.logs.length === 0 || !outputWillTruncate)
          ? formattedValue.language
          : undefined;
      const outputFormatStartLine = result.logs.length > 0
        ? countNewlines(logPrefix) + 2
        : 0;
      const persistedDetails = createFabricPersistedExecutionDetails({
        ...result,
        ...(outputFormat ? { outputFormat, outputFormatStartLine } : {}),
        ...(outputFormat
          ? {
              outputFormatLines:
                formattedValue.highlightedLineCount
                ?? countNewlines(formattedValue.text) + 1,
            }
          : {}),
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
          details: persistedDetails,
          isError: true,
        };
      }

      const output = truncateMiddle(
        rawOutput || "(no output)",
        state.config.executor.maxOutputChars,
      );
      const terminate =
        pendingHandoff !== undefined ||
        (result.success &&
          typeof result.value === "object" &&
          result.value !== null &&
          "terminate" in result.value &&
          result.value.terminate === true);
      // A nested `pi.read` of an image returns image content blocks that
      // normalizeResult stripped (the sandbox holds text only). The provider
      // handed them out-of-band to each call audit; re-attach them here so
      // pi core's ToolExecutionComponent renders a kitty image preview — the
      // same path a native `read` takes — for single-call AND multitool
      // reads. pi-vision-handoff keeps the image in the nested tool_result
      // (its `context` hook swaps image→description on the LLM-bound
      // fabric_exec clone), so every read audit carries its image here.
      const mediaBlocks: FabricMediaBlock[] = [];
      for (const audit of result.audits) {
        if (audit.media) mediaBlocks.push(...audit.media);
      }
      const singleAudit = result.audits.length === 1 ? result.audits[0] : undefined;
      // The read tool's own text note (e.g. "Read image file [image/png]"),
      // captured after the handoff stripped pi's non-vision note. Used as
      // the single-call body + content text so the preview shows the kitty
      // image + the clean note (like pi core) instead of the handoff's
      // verbose description. Multitool renders each read's note as its own
      // call body, so the joined program return suffices as the content text
      // there.
      const mediaNote = singleAudit?.mediaNote;
      // The base64 payload now lives in the result content; discard the
      // duplicate in-memory audit copies before returning.
      for (const audit of result.audits) {
        delete audit.media;
        delete audit.mediaNote;
      }
      const content: Array<{ type: "text"; text: string } | FabricMediaBlock> = [];
      if (mediaBlocks.length > 0) {
        // Mirror a native `read`: keep the image block(s) for pi core's kitty
        // render alongside the short note. The handoff's `context` hook
        // swaps each image for its description on the LLM-bound clone, so the
        // text-only model still receives the description while the terminal
        // shows the kitty image.
        const textOutput =
          singleAudit && mediaNote
            ? mediaNote
            : (output === "(no output)" ? "" : output);
        if (textOutput) content.push({ type: "text", text: textOutput });
        for (const block of mediaBlocks) content.push(block);
        if (singleAudit && mediaNote) {
          singleAudit.result = mediaNote;
        }
      } else {
        content.push({ type: "text", text: output });
      }
      return {
        content,
        details: persistedDetails,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(terminate ? { terminate: true } : {}),
        ...(result.success ? {} : { isError: true }),
      };
    },
  }),
  {
    mode: codePreviewSettings.toolCallBackground,
    toolCallTiming: codePreviewSettings.toolCallTiming,
  },
);
