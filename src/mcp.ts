import type { FabricProvider } from "./protocol.js";
import { McpProvider, type HostedMcpSource } from "./providers/mcp-provider.js";

export type { HostedMcpSource, HostedMcpTool } from "./providers/mcp-provider.js";

/** Native MCP discovery and invocation over an explicitly authorized host transport. */
export function createMcpProvider(options: {
  source: HostedMcpSource;
  callTimeoutMs?: number;
}): FabricProvider {
  if (!options.source) throw new Error("An authorized MCP source is required");
  return new McpProvider("", {
    enabled: true,
    disableOAuth: true,
    allowDynamicServers: false,
    callTimeoutMs: options.callTimeoutMs ?? 120_000,
    cache: { enabled: false, revalidate: "off", revalidateBudgetMs: 0 },
  }, { source: options.source });
}
