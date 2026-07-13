export const PI_CORE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type PiCoreToolName = (typeof PI_CORE_TOOL_NAMES)[number];

export const PI_CORE_TOOL_NAME_SET: ReadonlySet<string> = new Set(PI_CORE_TOOL_NAMES);
