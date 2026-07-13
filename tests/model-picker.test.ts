import { describe, expect, it } from "vitest";
import {
  buildModelSource,
  INHERIT_VALUE,
  modelKey,
  readModelSortLastUsed,
  sortByLastUsed,
  type ModelLike,
} from "../src/ui/model-picker.js";

describe("model-picker sortByLastUsed", () => {
  const items: ModelLike[] = [
    { provider: "openai", id: "gpt-5.5" },
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "google", id: "gemini-pro" },
  ];
  const key = (model: ModelLike): string => `${model.provider}/${model.id}`;

  it("puts the current model first, then most recently used", () => {
    const lastUsed = {
      "openai/gpt-5.5": 100,
      "anthropic/claude-sonnet-4-5": 200,
    };
    const sorted = sortByLastUsed(items, lastUsed, "google/gemini-pro");
    expect(sorted.map(key)).toEqual([
      "google/gemini-pro",
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.5",
    ]);
  });

  it("falls back to provider/id alphabetical with no usage", () => {
    const sorted = sortByLastUsed(items, {}, null);
    expect(sorted.map(key)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "google/gemini-pro",
      "openai/gpt-5.5",
    ]);
  });

  it("breaks timestamp ties alphabetically", () => {
    const tied = sortByLastUsed(items, { "openai/gpt-5.5": 5, "google/gemini-pro": 5 }, null);
    expect(tied.map(key)).toEqual([
      "google/gemini-pro",
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("does not mutate the input array", () => {
    const original = [...items];
    sortByLastUsed(items, { "openai/gpt-5.5": 1 }, null);
    expect(items.map(key)).toEqual(original.map(key));
  });
});

describe("model-picker buildModelSource", () => {
  const models: ModelLike[] = [
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ];

  it("returns the available models and a lastUsed record", () => {
    const source = buildModelSource({ getAvailable: () => models });
    expect(source.models).toHaveLength(2);
    expect(source.models.map((m) => modelKey(m.provider, m.id))).toContain("anthropic/claude-sonnet-4-5");
    expect(typeof source.lastUsed).toBe("object");
  });

  it("degrades to an empty model list when the registry throws", () => {
    const source = buildModelSource({
      getAvailable: (): ModelLike[] => {
        throw new Error("registry unavailable");
      },
    });
    expect(source.models).toEqual([]);
  });

  it("readModelSortLastUsed never throws and returns a record", () => {
    expect(() => readModelSortLastUsed()).not.toThrow();
    expect(typeof readModelSortLastUsed()).toBe("object");
  });
});

describe("model-picker constants", () => {
  it("INHERIT_VALUE is the Inherit sentinel", () => {
    expect(INHERIT_VALUE).toBe("Inherit");
  });

  it("modelKey builds provider/id", () => {
    expect(modelKey("anthropic", "claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
  });
});
