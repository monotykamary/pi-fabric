import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

describe("Fabric guest type checker", () => {
  it("accepts typed Fabric code with top-level return", () => {
    const result = typeCheckFabricCode(
      'const text = await pi.read({ path: "README.md" });\nreturn text.length;',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts dynamic MCP namespaces and orchestration helpers", () => {
    const result = typeCheckFabricCode(
      `
const mcpResult = await mcp.context7.resolve_library_id({ libraryName: "react" });
const review = await agents.run({ task: "Review it", transport: "localterm" });
console.log(review.status);
return { mcpResult, review };
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts workflow, actor, and mesh primitives", () => {
    const result = typeCheckFabricCode(
      `
const captured = await extensions.project_status({ verbose: true });
console.log(captured.text);
const watcher = await agents.create({
  name: "advisor",
  instructions: "Review each turn",
  events: ["turn_end"],
  responseMode: "directive",
});
await mesh.publish({ topic: "team.review", to: watcher.id, text: "start" });
await phase("Review");
const findings = await parallel([
  () => agent<{ issues: string[] }>("Find issues", {
    label: "issue scan",
    schema: {
      type: "object",
      properties: { issues: { type: "array", items: { type: "string" } } },
      required: ["issues"],
    },
  }),
]);
return findings;
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("reports user-facing line numbers", () => {
    const result = typeCheckFabricCode(
      'await pi.read({ path: 42 });\nreturn "never";',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors[0]?.line).toBe(1);
    expect(result.errors[0]?.message).toContain("number");
  });
});
