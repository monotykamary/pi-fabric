import { type ModelSource, buildClaudeModelSource } from "./model-picker.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "../config.js";
import { coerceValue } from "./settings-values.js";
import { markDrillIn } from "./settings-submenus.js";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  buildFullCodeModeSection,
  buildExecutorSection,
  buildSchemaSection,
  buildApprovalsSection,
  buildMcpSection,
} from "./settings-sections-execution.js";
import { buildPrewalkSection, buildAgentsSection } from "./settings-sections-agents.js";
import {
  buildCaptureSection,
  buildUiSection,
  buildCodePreviewSection,
} from "./settings-sections-presentation.js";
import {
  buildCompactionSection,
  buildRetentionSection,
  buildMeshSection,
} from "./settings-sections-lifecycle.js";

export const populateClaudeModelSource = async (
  source: ModelSource,
  load: () => Promise<Parameters<typeof buildClaudeModelSource>[0]>,
): Promise<void> => {
  const loaded = buildClaudeModelSource(await load());
  source.models.splice(0, source.models.length, ...loaded.models);
  source.lastUsed = loaded.lastUsed;
};

export const buildFabricSettingsItems = (
  theme: Theme,
  config: FabricConfig,
  apply: (id: string, value: unknown) => void,
  options: {
    keepVisibleCandidates: readonly string[];
    modelSource: ModelSource;
    claudeModelSource?: ModelSource;
    activeModelKey?: string;
  },
): SettingItem[] => {
  const persist = (id: string, newValue: string): void =>
    apply(id, coerceValue(id, newValue, config));
  const context = { theme, config, apply, options, persist };
  return markDrillIn([
    buildFullCodeModeSection(context),
    buildExecutorSection(context),
    buildSchemaSection(context),
    buildApprovalsSection(context),
    buildMcpSection(context),
    buildPrewalkSection(context),
    buildAgentsSection(context),
    buildCaptureSection(context),
    buildUiSection(context),
    buildCompactionSection(context),
    buildRetentionSection(context),
    buildMeshSection(context),
    buildCodePreviewSection(context),
  ]);
};
