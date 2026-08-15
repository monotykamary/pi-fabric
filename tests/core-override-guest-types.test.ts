import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  buildCoreOverrideGuestDeclarations,
  type FabricCoreOverrideTypeSource,
} from "../src/runtime/core-override-guest-types.js";
import { GUEST_TYPE_DECLARATIONS, guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const declarationsFor = (...sources: FabricCoreOverrideTypeSource[]): string => {
  const coreOverrides = buildCoreOverrideGuestDeclarations(sources);
  if (!coreOverrides) throw new Error("Expected a core override declaration");
  return guestTypeDeclarations(true, { coreOverrides });
};

describe("captured core override guest declarations", () => {
  it("adds strict read forms while preserving built-in shorthand and return types", () => {
    const declarations = declarationsFor({
      name: "read",
      inputSchema: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
        structure: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("symbols")])),
        symbolId: Type.Optional(Type.String()),
        nullableCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        lines: Type.Optional(Type.Array(Type.Number())),
      }, { additionalProperties: false }),
    });

    const accepted = typeCheckFabricCode(
      `
const shorthand = await pi.read("src/index.ts");
const builtin = await pi.read({ path: "src/index.ts", offset: 4, limit: 2 });
const structure = await pi.read({
  path: "src/index.ts",
  structure: "symbols",
  symbolId: "opaque-id",
  nullableCursor: null,
  lines: [1, 2],
});
const text: string = structure;
return { shorthand, builtin, text };
`,
      declarations,
    );
    expect(accepted.errors).toEqual([]);

    const misspelled = typeCheckFabricCode(
      'await pi.read({ path: "src/index.ts", structrue: "symbols" }); return "never";',
      declarations,
    );
    expect(misspelled.errors.length).toBeGreaterThan(0);
  });

  it("retains every built-in core call form alongside an additive override", () => {
    const declarations = declarationsFor({
      name: "read",
      inputSchema: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    });
    const checked = typeCheckFabricCode(
      `
const readText: string = await pi.read("src/index.ts");
const bashOutput: string = (await pi.bash("echo ok")).output;
const editOutput: string = (await pi.edit("src/index.ts", "old", "new")).output;
const writeOutput: string = (await pi.write("src/index.ts", "content")).output;
const grepText: string = await pi.grep("TODO", "src", 10);
const findText: string = await pi.find("*.ts", "src", 10);
const lsText: string = await pi.ls("src");
return { readText, bashOutput, editOutput, writeOutput, grepText, findText, lsText };
`,
      declarations,
    );
    expect(checked.errors).toEqual([]);
  });

  it("adds edit batch and symbol forms while keeping positional edits and envelopes", () => {
    const declarations = declarationsFor({
      name: "edit",
      inputSchema: Type.Object({
        path: Type.String(),
        oldText: Type.Optional(Type.String()),
        newText: Type.Optional(Type.String()),
        edits: Type.Optional(Type.Array(Type.Object({
          oldText: Type.String(),
          newText: Type.String(),
          all: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }))),
        symbolId: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
    });

    const accepted = typeCheckFabricCode(
      `
const positional = await pi.edit("src/index.ts", "old", "new");
const exact = await pi.edit({ path: "src/index.ts", oldText: "old", newText: "new" });
const batch = await pi.edit({
  path: "src/index.ts",
  edits: [{ oldText: "one", newText: "two", all: true }],
});
const symbol = await pi.edit({ path: "src/index.ts", symbolId: "opaque-id", oldText: "old", newText: "new" });
const symbolAlias = await pi.edit({ file: "src/index.ts", symbolId: "opaque-id", old: "old", new: "new" });
const output: string = batch.output;
return { positional, exact, symbol, symbolAlias, output };
`,
      declarations,
    );
    expect(accepted.errors).toEqual([]);

    const misspelled = typeCheckFabricCode(
      'await pi.edit({ path: "src/index.ts", edits: [{ oldText: "a", newText: "b", alll: true }] }); return "never";',
      declarations,
    );
    expect(misspelled.errors.length).toBeGreaterThan(0);
  });

  it("supports literal, nullable, array, union, and intersection schema branches", () => {
    const declarations = declarationsFor({
      name: "read",
      inputSchema: Type.Intersect([
        Type.Object({
          path: Type.String(),
          mode: Type.Union([Type.Literal("tree"), Type.Literal("text")]),
          cursor: Type.Union([Type.String(), Type.Null()]),
          symbols: Type.Array(Type.String()),
        }, { additionalProperties: false }),
        Type.Union([
          Type.Object({ symbolId: Type.String() }, { additionalProperties: false }),
          Type.Object({ line: Type.Number() }, { additionalProperties: false }),
        ]),
      ]),
    });

    const accepted = typeCheckFabricCode(
      'await pi.read({ path: "src/index.ts", mode: "tree", cursor: null, symbols: ["A"], symbolId: "id" }); return "ok";',
      declarations,
    );
    expect(accepted.errors).toEqual([]);
  });

  it("uses a loose object overload for unsupported, recursive, malformed, and over-budget schemas", () => {
    const recursive: Record<string, unknown> = { type: "object", properties: {} };
    (recursive.properties as Record<string, unknown>).self = recursive;
    const huge = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`field_${index}`, { type: "string" }]),
      ),
    };
    const declarations = declarationsFor(
      { name: "read", inputSchema: { $ref: "#/definitions/Read" } },
      { name: "edit", inputSchema: recursive },
      { name: "write", inputSchema: { type: "object", properties: "malformed" } },
      { name: "grep", inputSchema: huge },
      { name: "find", inputSchema: { type: "array", items: { type: "string" } } },
    );

    const reachable = typeCheckFabricCode(
      `
await pi.read({ overrideOnly: true });
await pi.edit({ overrideOnly: true });
await pi.write({ overrideOnly: true });
await pi.grep({ overrideOnly: true });
await pi.find({ overrideOnly: true });
return "reachable";
`,
      declarations,
    );
    expect(reachable.errors).toEqual([]);
  });

  it("leaves the static declarations untouched without overrides", () => {
    expect(guestTypeDeclarations(true)).toBe(GUEST_TYPE_DECLARATIONS);
    expect(buildCoreOverrideGuestDeclarations([])).toBeUndefined();
  });
});
