import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { McpProvider } from "../src/providers/mcp-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
};

describe("McpProvider", () => {
  it("discovers and calls a stdio server through mcporter", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mcp-"));
    const configPath = path.join(directory, "mcporter.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: {
            command: process.execPath,
            args: [path.resolve("tests/fixtures/fake-mcp-server.mjs")],
          },
          "fal-ai": {
            command: process.execPath,
            args: [path.resolve("tests/fixtures/fake-mcp-server.mjs")],
          },
        },
        imports: [],
      }),
    );
    const provider = new McpProvider(directory, {
      enabled: true,
      configPath,
      disableOAuth: true,
      allowDynamicServers: true,
      callTimeoutMs: 5_000,
    });
    try {
      const listed = await provider.list({ namespace: "test" }, context);
      expect(listed).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "test.echo-value", risk: "network" })]),
      );
      const described = await provider.describe("test.echo_value", context);
      expect(described?.inputSchema).toMatchObject({ required: ["value"] });
      await expect(provider.invoke("test.echo_value", { value: "hello" }, context)).resolves.toMatchObject({
        text: "echo:hello",
      });
      await expect(provider.invoke("test.echo_value", { value: "again" }, context)).resolves.toMatchObject({
        text: "echo:again",
      });
      const modelSchema = await provider.describe("fal_ai.get_model_schema", context);
      expect(modelSchema?.name).toBe("fal-ai.get-model-schema");
      await expect(
        provider.invoke(
          "fal_ai.get_model_schema",
          { endpoint_id: "openai/gpt-image-2" },
          context,
        ),
      ).resolves.toMatchObject({ text: "schema:openai/gpt-image-2" });
      const controller = new AbortController();
      const cancelled = provider.invoke(
        "test.echo_value",
        { value: "__delay__" },
        { ...context, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 20);
      await expect(cancelled).rejects.toThrow("MCP call cancelled");

      await expect(
        provider.invoke(
          "$register",
          {
            name: "dynamic-server",
            command: process.execPath,
            args: [path.resolve("tests/fixtures/fake-mcp-server.mjs")],
          },
          context,
        ),
      ).resolves.toEqual({ registered: "dynamic-server" });
      await expect(
        provider.invoke("dynamic_server.echo_value", { value: "dynamic" }, context),
      ).resolves.toMatchObject({ text: "echo:dynamic" });
    } finally {
      await provider.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
