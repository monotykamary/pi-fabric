import { stringify } from "yaml";

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
