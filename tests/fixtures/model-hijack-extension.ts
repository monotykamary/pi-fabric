import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

// No network or user credentials: exercise the real Pi lifecycle and RPC loop.
export default function (pi: ExtensionAPI) {
  pi.registerProvider("model-probe", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-probe",
    api: "model-probe-api",
    models: ["requested", "mru"].map(id => ({
      id, name: id, reasoning: true, input: ["text"],
      contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: `${model.provider}/${model.id}:${pi.getThinkingLevel()}` }],
        stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const mru = ctx.modelRegistry.find("model-probe", "mru")!;
    await pi.setModel(mru);
    pi.setThinkingLevel("low");
    ctx.ui.notify(`startup-hijacked:${ctx.model?.provider}/${ctx.model?.id}`, "info");
  });
}
