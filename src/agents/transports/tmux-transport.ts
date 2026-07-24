import type {
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
} from "../types.js";
import { EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS } from "../constants.js";
import {
  commandAvailable,
  executeFile,
  workerCommand,
} from "./process-utils.js";

const sessionName = (id: string): string => `pi-fabric-${id.slice(0, 12)}`;

export class TmuxTransport implements AgentTransportAdapter {
  readonly kind = "tmux" as const;

  async available(): Promise<boolean> {
    return commandAvailable("tmux");
  }

  async launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const session = sessionName(request.id);
    await executeFile("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      request.cwd,
      workerCommand(request.workerPath, request.workerArguments),
    ]);
    return {
      kind: this.kind,
      livenessPollIntervalMs: EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS,
      sessionId: session,
      attachCommand: `tmux attach-session -t ${session}`,
      async isAlive() {
        try {
          await executeFile("tmux", ["has-session", "-t", session]);
          return true;
        } catch {
          return false;
        }
      },
      async stop() {
        try {
          await executeFile("tmux", ["kill-session", "-t", session]);
        } catch { /* session already exited */ }
      },
    };
  }
}
