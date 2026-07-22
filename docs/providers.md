# External providers

Normal `pi.registerTool()` tools are [captured automatically](configuration.md#captured-extension-tools). Extensions can still opt into the versioned provider protocol when they need to expose non-tool capabilities, richer risk declarations, or a large virtual action catalog without registering one Pi tool per action.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "pi-fabric/protocol";

export default function extension(pi: ExtensionAPI) {
  const provider: FabricProvider = {
    name: "example",
    description: "Example actions",
    async list() {
      return [];
    },
    async describe() {
      return undefined;
    },
    async invoke() {
      return null;
    },
  };

  pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, {
    version: 1,
    provider,
    overwrite: true,
  });

  pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (event: FabricProviderDiscovery) => {
    event.register(provider, { overwrite: true });
  });
}
```

Providers own their schemas, state, and execution semantics. Pi Fabric validates arguments, enforces the declared risk policy, records nested-call audits, and propagates cancellation. A provider can enrich the generic [activity surface](interface.md#data-driven-activity) without registering a TUI component:

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Nested `tool_result` proxy

Results from MCP, agent, memory, state, schema, mesh, compact, and external providers pass through Pi's `tool_result` middleware before `maxNestedResultChars` is enforced. This lets a user extension externalize or replace an oversized provider result before it crosses into QuickJS.

A proxied event has:

- `toolName` set to the fully qualified Fabric ref, such as `mcp.github.search`;
- a `toolCallId` beginning with `FABRIC_NESTED_TOOL_CALL_ID_PREFIX`;
- text `content` containing the raw string result or a JSON projection;
- `details` matching `FabricToolResultProxyDetailsV1`, whose `result` is the exact host-side structured value.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  readFabricToolResultProxyDetailsV1,
} from "pi-fabric/protocol";

export default function resultGuard(pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (!event.toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX)) return;
    const proxy = readFabricToolResultProxyDetailsV1(event.details);
    if (!proxy || proxy.ref !== event.toolName) return;

    const serialized =
      typeof proxy.result === "string"
        ? proxy.result
        : (JSON.stringify(proxy.result) ?? String(proxy.result));
    if (serialized.length <= 6_144) return;

    const artifact = await persistPrivately(serialized);
    const replacement = {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: `${serialized.slice(0, 3_000)}\n…`,
      artifact,
    };
    return {
      content: [{ type: "text", text: replacement.preview }],
      details: { ...proxy, result: replacement },
    };
  });
}
```

Changing only `content` replaces the nested sandbox value with the patched text. To preserve a structured replacement, return the proxy envelope in `details` with a changed `result`, as above. A valid changed `details.result` takes precedence when both fields are patched. Returning `isError: true` fails the nested provider invocation.

Pi core tools and captured extension tools are not sent through this generic proxy because they already replay their native `tool_call`, `tool_result`, and `tool_execution_*` lifecycle. For example, a nested `pi.bash()` still emits `toolName: "bash"` with native `BashToolDetails`; it can be handled with `isBashToolResult()`. Proxied events are middleware only and do not create separate persisted tool-result messages.
