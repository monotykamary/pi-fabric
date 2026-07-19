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
    const yaml = formatJsonAsYaml(value);
    if (yaml !== undefined) return { text: yaml, language: "yaml" };
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
