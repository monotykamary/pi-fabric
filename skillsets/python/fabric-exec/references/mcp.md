# MCP surface — Python

MCP is backed by mcporter discovery, OAuth cache, and pooled connections. All calls are awaited; arguments/results use native dictionaries. Discover uncertain schemas rather than guessing fields. Never launch another interpreter to call MCP.

```python
result = await mcp.context7.resolve_library_id(libraryName="react", query="hooks")
image_schema = await mcp.fal_ai.get_model_schema(endpoint_id="openai/gpt-image-2")
return {"result": result, "imageSchema": image_schema}
```

Names replace non-identifier characters with underscores; fal-ai/get-model-schema becomes fal_ai/get_model_schema. Names beginning with underscores cannot use Monty's direct capability attributes: call the exact discovered ref with `tools.call` or use `mcp.call` for original names. Tool results are server-defined, commonly containing text/content/structuredContent.

```python
return await mcp.call(server="my-server", tool="weird-tool-name", args={"q": "x"})
```

`await mcp.servers()` returns server metadata (never credentials); `await mcp.reload()` reloads pooled configuration and returns servers. `mcp.register` accepts name, optional description, command/args/cwd/env for stdio or baseUrl/headers for HTTP, and overwrite. It registers an ephemeral server after approval until reload/shutdown, not a persisted configuration entry.

```python
return await tools.describe(ref="mcp.context7.resolve_library_id")
```

Inspect inputSchema first and outputSchema when supplied. `tools.search` discovers current refs; `tools.call(ref=..., args=...)` invokes a computed one. `mcp.disableOAuth` permits cached credentials but prevents new interactive OAuth; calls respect mcp.callTimeoutMs. mcp.enabled=False disables this surface. Never expose credentials in model results.
