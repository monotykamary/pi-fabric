import { normalizeMontyValue } from "./monty-values.js";

const PRIMARY: Record<string, string> = { read: "path", ls: "path", bash: "command", powershell: "command", grep: "pattern", find: "pattern" };
const POSITIONAL: Record<string, string[]> = {
  read: ["path", "offset", "limit"], ls: ["path", "limit"], grep: ["pattern", "path", "limit"],
  find: ["pattern", "path", "limit"], write: ["path", "content"], edit: ["path", "oldText", "newText"], bash: ["command"], powershell: ["command"],
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function pythonArgumentsFor(ref: string, positional: unknown[], kwargs: Record<string, unknown>): Record<string, unknown> {
  let args = normalizeMontyValue(kwargs) as Record<string, unknown>;
  const values = normalizeMontyValue(positional) as unknown[];
  if (values.length === 1 && record(values[0])) {
    if (Object.keys(values[0]).some((key) => Object.hasOwn(args, key))) throw new TypeError("Duplicate Fabric argument keys");
    args = { ...values[0], ...args };
  } else if (ref === "tools.search" && values.length === 1 && typeof values[0] === "string") {
    args = { ...args, query: values[0] };
  } else if (values.length) {
    const name = ref.startsWith("pi.") ? ref.slice(3) : "";
    const primary = Object.hasOwn(PRIMARY, name) ? PRIMARY[name] : undefined;
    const fields = Object.hasOwn(POSITIONAL, name) ? POSITIONAL[name]! : [];
    if (primary && values.length === 2 && typeof values[0] === "string" && record(values[1])) {
      args = { ...values[1], ...args, [primary]: values[0] };
    } else if (fields.length && values.length <= fields.length) {
      for (let index = 0; index < values.length; index++) args[fields[index]!] = values[index];
    } else throw new TypeError("Fabric calls accept a dictionary or keyword arguments; Pi tools also accept documented positional arguments");
  }
  if (ref === "pi.edit" && !Object.hasOwn(args, "edits") && (Object.hasOwn(args, "oldText") || Object.hasOwn(args, "newText"))) {
    const edit: Record<string, unknown> = {};
    for (const key of ["oldText", "newText"]) if (Object.hasOwn(args, key)) { edit[key] = args[key]; delete args[key]; }
    args.edits = [edit];
  }
  return args;
}

