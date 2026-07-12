import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const respond = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

input.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "pi-fabric-test", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "echo-value",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }
  if (request.method === "tools/call") {
    respond(request.id, {
      content: [{ type: "text", text: `echo:${request.params.arguments.value}` }],
    });
    return;
  }
  if (request.id !== undefined) respond(request.id, {});
});
