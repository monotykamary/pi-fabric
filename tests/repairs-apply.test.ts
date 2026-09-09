import { describe, expect, it } from "vitest";
import {
  applyActionAliasRepairs,
  applyCatalogArgRepairs,
} from "../src/repairs/apply.js";

const sessionSchema = {
  type: "object",
  properties: { session: { type: "string" }, entryId: { type: "string" } },
  additionalProperties: false,
};

describe("applyCatalogArgRepairs", () => {
  const repairs = [
    { kind: "keyAlias" as const, ref: "memory.expand", from: "sessionId", to: "session" },
  ];

  it("preserves canonical identity and is idempotent", () => {
    const args = { sessionId: "s1" };
    const once = applyCatalogArgRepairs("memory.expand", args, repairs, sessionSchema);
    expect(once).toEqual({ args: { session: "s1" }, changed: true });
    expect(args).toEqual({ sessionId: "s1" });
    const twice = applyCatalogArgRepairs("memory.expand", once.args, repairs, sessionSchema);
    expect(twice.changed).toBe(false);
    expect(twice.args).toBe(once.args);
    const canonical = { session: "canonical" };
    expect(applyCatalogArgRepairs("memory.expand", canonical, repairs, sessionSchema).args).toBe(canonical);
  });

  it.each(["different", "canonical", undefined])("refuses canonical/alias conflicts (%s) atomically", (alias) => {
    const args = { session: "canonical", sessionId: alias, entry_id: "entry" };
    const aliases = [...repairs, { kind: "keyAlias" as const, ref: "memory.expand", from: "entry_id", to: "entryId" }];
    const result = applyCatalogArgRepairs("memory.expand", args, aliases, sessionSchema);
    expect(result.changed).toBe(false);
    expect(result.args).toBe(args);
    expect(args).toEqual({ session: "canonical", sessionId: alias, entry_id: "entry" });
  });

  it("refuses many-to-one conflicts without applying an unrelated alias", () => {
    const args = { sessionId: "s1", path: "s2", entry_id: "entry" };
    const aliases = [...repairs,
      { kind: "keyAlias" as const, ref: "memory.expand", from: "path", to: "session" },
      { kind: "keyAlias" as const, ref: "memory.expand", from: "entry_id", to: "entryId" },
    ];
    const result = applyCatalogArgRepairs("memory.expand", args, aliases, sessionSchema);
    expect(result.changed).toBe(false);
    expect(result.args).toBe(args);
  });

  it("does not treat duplicate stored rows as multiple alias sources", () => {
    expect(applyCatalogArgRepairs("memory.expand", { sessionId: "s" }, [...repairs, ...repairs], sessionSchema))
      .toEqual({ args: { session: "s" }, changed: true });
  });

  it.each([
    { args: { sessionId: 42 }, schema: sessionSchema },
    { args: { sessionId: "s", extra: true }, schema: sessionSchema },
    { args: { sessionId: "s" }, schema: { ...sessionSchema, required: ["entryId"] } },
    { args: { sessionId: "s" }, schema: { ...sessionSchema, properties: { session: { type: "string", minLength: 3 } } } },
    { args: { sessionId: "s" }, schema: { ...sessionSchema, properties: { session: { $ref: "missing" } } } },
  ])("returns the original when the live candidate is invalid or uncheckable: %j", ({ args, schema }) => {
    const before = { ...args };
    const result = applyCatalogArgRepairs("memory.expand", args, repairs, schema);
    expect(result.changed).toBe(false);
    expect(result.args).toBe(args);
    expect(args).toEqual(before);
  });

  it("re-proves a stored map against the complete live object schema", () => {
    expect(
      applyCatalogArgRepairs(
        "memory.expand",
        { sessionId: "s1" },
        repairs,
        {
          ...sessionSchema,
          properties: { sessionId: { type: "string" }, entryId: { type: "string" } },
        },
      ),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
    expect(
      applyCatalogArgRepairs("memory.expand", { sessionId: "s1" }, repairs, {
        ...sessionSchema,
        properties: { entryId: { type: "string" } },
      }),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
    expect(
      applyCatalogArgRepairs("memory.expand", { sessionId: "s1" }, repairs, {
        ...sessionSchema,
        properties: { session: { type: "string" }, path: { type: "string" } },
      }),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
    expect(
      applyCatalogArgRepairs("memory.expand", { sessionId: "s1" }, repairs, {
        ...sessionSchema,
        additionalProperties: true,
      }),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
  });

  it("refuses ambiguous many-to-one aliases when canonical input is absent", () => {
    const aliases = [
      ...repairs,
      { kind: "keyAlias" as const, ref: "memory.expand", from: "path", to: "session" },
    ];
    expect(
      applyCatalogArgRepairs(
        "memory.expand",
        { sessionId: "s1", path: "s2" },
        aliases,
        sessionSchema,
      ),
    ).toEqual({ args: { sessionId: "s1", path: "s2" }, changed: false });
  });
});

describe("applyActionAliasRepairs", () => {
  it("re-proves stored fuzzy mappings as suggestions only", () => {
    const repairs = [{ kind: "actionAlias" as const, provider: "demo", from: "staus", to: "status" }];
    expect(applyActionAliasRepairs("demo", "staus", repairs, ["status"])).toBeUndefined();
  });

  it("re-proves an exact separator mapping and refuses new ambiguity", () => {
    const repairs = [{ kind: "actionAlias" as const, provider: "demo", from: "switch_model", to: "switchModel" }];
    expect(applyActionAliasRepairs("demo", "switch_model", repairs, ["switchModel"])).toBe("switchModel");
    expect(applyActionAliasRepairs("demo", "switch_model", repairs, ["switchModel", "switch-model"])).toBeUndefined();
  });
  const repairs = [
    { kind: "actionAlias" as const, provider: "memory", from: "search", to: "recall" },
  ];

  it("rewrites a unique verb that is still undeclared", () => {
    expect(applyActionAliasRepairs("memory", "search", repairs, ["recall", "expand"])).toBe(
      "recall",
    );
  });

  it("does not rewrite when the live mapping is invalid or ambiguous", () => {
    expect(applyActionAliasRepairs("memory", "search", repairs, ["search", "recall"])).toBeUndefined();
    expect(applyActionAliasRepairs("memory", "search", repairs, ["expand"])).toBeUndefined();
    expect(
      applyActionAliasRepairs("memory", "search", repairs, ["recall", "find"]),
    ).toBeUndefined();
  });
});
