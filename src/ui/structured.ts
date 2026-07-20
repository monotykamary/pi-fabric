import { stringify } from "yaml";
import type { FabricResultFormat } from "../config.js";

const normalizeJsonValue = (value: unknown): unknown | undefined => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : (JSON.parse(serialized) as unknown);
  } catch {
    return undefined;
  }
};

export const formatJsonAsYaml = (value: unknown): string | undefined => {
  const normalized = normalizeJsonValue(value);
  if (normalized === undefined) return undefined;
  return stringify(normalized, { indent: 2, lineWidth: 0 }).trimEnd();
};

export interface FormattedFabricValue {
  text: string;
  language?: "yaml" | "json";
}

interface HoistedSection {
  path: string;
  text: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// YAML literal block scalars must indent their content, so every multi-line
// string serialized inside a structure is displayed with extra leading
// whitespace on each line. Agents transcribe that corrupted indentation into
// exact-match consumers (pi.edit oldText) and the match fails. Hoist
// multi-line strings out of the YAML skeleton into raw sections so the
// model-bound text preserves the original bytes.
const hoistMultilineStrings = (
  value: unknown,
  path: string,
  sections: HoistedSection[],
  seen: Set<unknown>,
): unknown => {
  if (typeof value === "string") {
    if (!value.includes("\n")) return value;
    sections.push({ path, text: value });
    return `<multi-line string, see section: ${path}>`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular reference]";
    seen.add(value);
    const skeleton = value.map((item, index) =>
      hoistMultilineStrings(item, `${path}[${index}]`, sections, seen),
    );
    seen.delete(value);
    return skeleton;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return "[circular reference]";
    seen.add(value);
    const skeleton: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      skeleton[key] = hoistMultilineStrings(
        item,
        path ? `${path}.${key}` : key,
        sections,
        seen,
      );
    }
    seen.delete(value);
    return skeleton;
  }
  return value;
};

export const formatFabricValue = (
  value: unknown,
  format: FabricResultFormat,
): FormattedFabricValue => {
  if (value === undefined) return { text: "" };
  if (format === "text" && typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return { text };
  }
  if (typeof value === "string") return { text: value };
  if (format === "auto" || format === "yaml") {
    const sections: HoistedSection[] = [];
    const skeleton = hoistMultilineStrings(value, "", sections, new Set());
    const yaml = formatJsonAsYaml(skeleton);
    if (yaml !== undefined) {
      if (sections.length === 0) return { text: yaml, language: "yaml" };
      const raw = sections
        .map(
          (section) =>
            `--- ${section.path} (${section.text.length} chars) ---\n${section.text}`,
        )
        .join("\n\n");
      // No language tag: the skeleton is YAML but the raw sections are not.
      return { text: `${yaml}\n\n${raw}` };
    }
  }
  try {
    return {
      text: JSON.stringify(value, null, format === "json" ? 2 : 0),
      ...(format === "json" ? { language: "json" as const } : {}),
    };
  } catch {
    return { text: String(value) };
  }
};
