import type {
  SubagentTransportAdapter,
  SubagentTransportHandle,
  SubagentTransportLaunch,
} from "../types.js";
import { commandAvailable, executeFile } from "./process-utils.js";

const sessionName = (id: string): string => `pi-fabric-${id.slice(0, 12)}`;

export class ScreenTransport implements SubagentTransportAdapter {
  readonly kind = "screen" as const;

  async available(): Promise<boolean> {
    return commandAvailable("screen");
  }

  async launch(request: SubagentTransportLaunch): Promise<SubagentTransportHandle> {
    const session = sessionName(request.id);
    await executeFile(
      "screen",
      ["-DmS", session, process.execPath, request.workerPath, ...request.workerArguments],
      { cwd: request.cwd },
    );
    return {
      kind: this.kind,
      sessionId: session,
      attachCommand: `screen -r ${session}`,
      async isAlive() {
        try {
          const { stdout } = await executeFile("screen", ["-ls"]);
          return stdout.includes(`.${session}`) || stdout.includes(`\t${session}`);
        } catch {
          return false;
        }
      },
      async stop() {
        try {
          await executeFile("screen", ["-S", session, "-X", "quit"]);
        } catch { /* session already exited */ }
      },
    };
  }
}
