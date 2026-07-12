import type {
  SubagentTransportAdapter,
  SubagentTransportHandle,
  SubagentTransportLaunch,
} from "../types.js";
import {
  commandAvailable,
  executeFile,
  workerCommand,
} from "./process-utils.js";

interface LocaltermSession {
  id: string;
}

export class LocaltermTransport implements SubagentTransportAdapter {
  readonly kind = "localterm" as const;

  async available(): Promise<boolean> {
    if (!(await commandAvailable("localterm"))) return false;
    try {
      await executeFile("localterm", ["session", "ls", "--json"], { timeoutMs: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  async launch(request: SubagentTransportLaunch): Promise<SubagentTransportHandle> {
    const command = `${workerCommand(request.workerPath, request.workerArguments)}; exit $?`;
    const { stdout } = await executeFile("localterm", [
      "session",
      "new",
      "--cwd",
      request.cwd,
      "--cmd",
      command,
      "--name",
      request.name,
      "--json",
    ]);
    const session = JSON.parse(stdout) as LocaltermSession;
    if (!session.id) throw new Error("LocalTerm did not return a session id");
    return {
      kind: this.kind,
      sessionId: session.id,
      attachCommand: `localterm session attach ${session.id}`,
      async isAlive() {
        try {
          const result = await executeFile("localterm", ["session", "ls", "--json"]);
          const sessions = JSON.parse(result.stdout) as LocaltermSession[];
          return sessions.some((candidate) => candidate.id === session.id);
        } catch {
          return false;
        }
      },
      async stop() {
        try {
          await executeFile("localterm", ["session", "kill", session.id]);
        } catch {}
      },
    };
  }
}
