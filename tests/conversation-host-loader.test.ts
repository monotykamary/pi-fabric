import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// Exercise the compiled native-import boundary, not Vitest's module resolver.
// Pi supplies its own host module eagerly; resolving that package again from
// a lazy UI can enter another installation's proper-lockfile/signal-exit tree.
describe("conversation host-loader boundary", () => {
  it("loads and renders native chat using the injected host without resolving Pi again", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fabric-chat-loader-"));
    try {
      symlinkSync(path.resolve("node_modules"), path.join(directory, "node_modules"), "junction");
      await build({
        entryPoints: ["dashboard", "settings", "model-picker", "conversation", "conversation-host", "conversation-chrome", "conversation-native-reader"]
          .map((name) => `src/ui/${name}.ts`),
        outdir: directory, bundle: true, packages: "external", platform: "node",
        format: "esm", target: "node24", splitting: true, logLevel: "silent",
      });
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        import { registerHooks } from "node:module";
        import * as host from "@earendil-works/pi-coding-agent";
        const directory = ${JSON.stringify(directory)};
        host.initTheme("dark", false);
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === "@earendil-works/pi-coding-agent" || specifier.startsWith("@earendil-works/pi-coding-agent/")) {
            throw new Error("Lazy UI bypassed Pi's host alias: " + context.parentURL);
          }
          return next(specifier, context);
        }});
        const load = (name) => import(pathToFileURL(path.join(directory, name + ".js")).href);
        // Negative control: the pre-fix lazy host import must be rejected.
        fs.writeFileSync(path.join(directory, "unsafe-host.js"), 'import "@earendil-works/pi-coding-agent";');
        await assert.rejects(load("unsafe-host"), /Lazy UI bypassed Pi's host alias/);
        const [dashboard, settings, picker] = await Promise.all([load("dashboard"), load("settings"), load("model-picker")]);
        assert.equal(typeof dashboard.FabricDashboard, "function");
        assert.equal(typeof settings.openFabricSettings, "function");
        assert.equal(typeof picker.buildModelSource, "function");
        const bridge = await load("conversation-host");
        assert.throws(() => bridge.getConversationHost(), /has not been initialized/);
        bridge.initializeConversationHost(host);
        assert.equal(bridge.getConversationHost(), host);
        const [{ FabricConversationView, FabricConversationState }, { readConversationAppearance }, { NativeConversationReader }] =
          await Promise.all([load("conversation"), load("conversation-chrome"), load("conversation-native-reader")]);
        const appearance = readConversationAppearance(directory, directory, false);
        assert.equal(typeof appearance.editorPaddingX, "number");
        const sessionFile = path.join(directory, "session.jsonl");
        const message = { role: "user", content: "host bridge works", timestamp: 1 };
        fs.writeFileSync(sessionFile, [
          { type: "session", version: 3, id: "session", cwd: directory, timestamp: new Date(0).toISOString() },
          { type: "message", id: "m1", parentId: null, timestamp: new Date(1).toISOString(), message },
        ].map(JSON.stringify).join("\\n") + "\\n");
        const reader = new NativeConversationReader();
        reader.read({ id: "child", status: "idle", sessionFile });
        assert.deepEqual(reader.last.messages, [message]);
        const theme = Object.fromEntries(["fg", "bg"].map((key) => [key, (_color, text) => text]));
        for (const key of ["bold", "italic", "underline", "strikethrough"]) theme[key] = (text) => text;
        const state = new FabricConversationState();
        const target = { id: "child", name: "Child", kind: "agent", status: "idle", canSteer: true, canFollowUp: true, canStop: true };
        const view = new FabricConversationView(
          { requestRender() {}, terminal: { columns: 100, rows: 30 } }, theme,
          { state, initialTargetId: "child", targets: () => [target], transcript: () => reader.last,
            appearance, send: async () => ({ queued: true }), stop: async () => {}, close() {} },
        );
        assert(view.render(100).join("\\n").includes("host bridge works"));
        view.dispose(); state.clear(); reader.clear();
        // Native modules can survive /reload: rebinding must use the current host.
        const rebound = { ...host, copyToClipboard: async () => {} };
        bridge.initializeConversationHost(rebound);
        assert.equal(bridge.getConversationHost().copyToClipboard, rebound.copyToClipboard);
        console.log("host-free native chat rendered");
      `], { encoding: "utf8", timeout: 30_000 });
      expect(output).toContain("host-free native chat rendered");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
