import type {
  SubagentTransportAdapter,
  SubagentTransportHandle,
  SubagentTransportLaunch,
} from "../types.js";
import { spawnDetached } from "./process-utils.js";

export class ProcessTransport implements SubagentTransportAdapter {
  readonly kind = "process" as const;

  async available(): Promise<boolean> {
    return true;
  }

  async launch(request: SubagentTransportLaunch): Promise<SubagentTransportHandle> {
    const processHandle = spawnDetached(
      request.workerPath,
      request.workerArguments,
      request.cwd,
    );
    return {
      kind: this.kind,
      sessionId: String(processHandle.pid),
      isAlive: processHandle.isAlive,
      stop: processHandle.stop,
    };
  }
}
