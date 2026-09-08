import { describe, expect, it } from "vitest";
import { repairActionName } from "../src/core/action-repair.js";

describe("action repair catalogue reuse", () => {
  it("invalidates same-length replacements without stale repair targets", () => {
    const names = ["recall"];
    expect(repairActionName(names, "search").repaired).toBe("recall");
    names[0] = "spawn";
    expect(repairActionName(names, "search")).toEqual(repairActionName([...names], "search"));
    expect(repairActionName(names, "search").repaired).toBeUndefined();
  });

  it("rechecks ambiguity when actions are registered or removed", () => {
    const names = ["get"];
    expect(repairActionName(names, "fetch").repaired).toBe("get");
    names.push("read");
    expect(repairActionName(names, "fetch")).toEqual({ suggestions: ["get", "read"] });
    names.splice(0, 1);
    expect(repairActionName(names, "fetch").repaired).toBe("read");
  });

  it("matches fresh catalogues across reorder, duplicate, and empty transitions", () => {
    const names = ["status", "setSteeringMode", "messages", "spawn"];
    const queries = ["staus", "setsteermode", "mesage", "dstroy", "", "spawn"];
    for (const mutate of [() => {}, () => names.reverse(), () => names.push("status"), () => { names.length = 0; }]) {
      mutate();
      for (const query of queries) {
        expect(repairActionName(names, query)).toEqual(repairActionName([...names], query));
      }
    }
  });

  it("keeps results correct after bounded query-cache eviction", () => {
    const names = ["status", "spawn", "read"];
    const first = repairActionName(names, "staus");
    for (let i = 0; i < 140; i++) repairActionName(names, `missing${i}`);
    expect(repairActionName(names, "staus")).toEqual(first);
    names[0] = "recall";
    expect(repairActionName(names, "staus")).toEqual(repairActionName([...names], "staus"));
  });

  it("does not expose cached mutable arrays through results", () => {
    const names = Object.freeze(["get", "read"]);
    const result = repairActionName(names, "fetch");
    result.suggestions.length = 0;
    expect(repairActionName(names, "fetch")).toEqual({ suggestions: ["get", "read"] });
  });
});
