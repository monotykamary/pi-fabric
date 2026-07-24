import fs from "node:fs";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrTransport } from "../src/agents/transports/herdr-transport.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const startServer = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-herdr-"));
  roots.push(root);
  const socketPath = path.join(root, "herdr.sock");
  let paneAlive = true;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({ method: request.method, params: request.params });
      let response: unknown;
      if (request.method === "ping") {
        response = { id: request.id, result: { type: "pong", version: "test", protocol: 17 } };
      } else if (request.method === "layout.apply") {
        response = {
          id: request.id,
          result: {
            type: "layout_apply",
            layout: {
              workspace_id: "w1",
              tab_id: "w1:t2",
              zoomed: false,
              focused_pane_id: "w1:p2",
              root: { type: "pane", pane_id: "w1:p2" },
            },
          },
        };
      } else if (request.method === "pane.get" && paneAlive) {
        response = {
          id: request.id,
          result: {
            type: "pane_info",
            pane: { pane_id: "w1:p2", terminal_id: "term_worker" },
          },
        };
      } else if (request.method === "pane.close" && paneAlive) {
        paneAlive = false;
        response = { id: request.id, result: { type: "ok" } };
      } else {
        response = { id: request.id, error: { code: "pane_not_found", message: "pane not found" } };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, requests };
};

describe.skipIf(process.platform === "win32")("HerdrTransport", () => {
  it("is available only inside a reachable Herdr workspace", async () => {
    const { socketPath } = await startServer();
    const available = new HerdrTransport({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_WORKSPACE_ID: "w1",
    });
    await expect(available.available()).resolves.toBe(true);
    await expect(new HerdrTransport({ HERDR_ENV: "1" }).available()).resolves.toBe(false);
  });

  it("launches an argv-backed background tab and controls it by pane id", async () => {
    const { socketPath, requests } = await startServer();
    const transport = new HerdrTransport({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_WORKSPACE_ID: "w1",
    });
    const handle = await transport.launch({
      id: "agent-id",
      name: "review worker",
      cwd: "/repo with spaces",
      workerPath: "/fabric/worker.js",
      workerArguments: ["--task-file", "/tmp/task with spaces.txt"],
    });

    expect(handle).toMatchObject({
      kind: "herdr",
      sessionId: "w1:p2",
      attachCommand: "herdr terminal attach term_worker",
    });
    const apply = requests.find((request) => request.method === "layout.apply");
    expect(apply?.params).toEqual({
      workspace_id: "w1",
      tab_label: "review worker",
      focus: false,
      root: {
        type: "pane",
        label: "review worker",
        cwd: "/repo with spaces",
        command: [
          process.execPath,
          "/fabric/worker.js",
          "--task-file",
          "/tmp/task with spaces.txt",
        ],
      },
    });
    await expect(handle.isAlive()).resolves.toBe(true);
    await handle.stop();
    await expect(handle.isAlive()).resolves.toBe(false);
  });
});
