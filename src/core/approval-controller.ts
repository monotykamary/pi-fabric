import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricApprovalConfig } from "../config.js";
import type { FabricRisk } from "../protocol.js";
import type { ResolvedFabricAction } from "./action-registry.js";

const inheritedRisks = (): FabricRisk[] => {
  const allowed = new Set<FabricRisk>(["read", "write", "execute", "network", "agent"]);
  return (process.env.PI_FABRIC_GRANTED_RISKS ?? "")
    .split(",")
    .filter((risk): risk is FabricRisk => allowed.has(risk as FabricRisk));
};

export class ApprovalController {
  readonly #approvedRisks = new Set<FabricRisk>(inheritedRisks());
  readonly #pendingApprovals = new Map<FabricRisk, Promise<void>>();

  constructor(
    readonly config: FabricApprovalConfig,
    readonly context: ExtensionContext,
  ) {}

  async approve(action: ResolvedFabricAction): Promise<void> {
    const mode = this.config[action.risk];
    if (mode === "allow" || this.#approvedRisks.has(action.risk)) return;
    if (mode === "deny") {
      throw new Error(`${action.ref} is denied by the Fabric ${action.risk} policy`);
    }
    const pending = this.#pendingApprovals.get(action.risk);
    if (pending) return pending;
    const approval = this.#requestApproval(action);
    this.#pendingApprovals.set(action.risk, approval);
    try {
      await approval;
    } finally {
      this.#pendingApprovals.delete(action.risk);
    }
  }

  async #requestApproval(action: ResolvedFabricAction): Promise<void> {
    if (!this.context.hasUI) {
      throw new Error(`${action.ref} requires approval, but no interactive UI is available`);
    }
    const approved = await this.context.ui.confirm(
      "Pi Fabric permission",
      `${action.ref} requests ${action.risk} access. Allow this access for the current Fabric execution?`,
    );
    if (!approved) throw new Error(`User denied ${action.risk} access for ${action.ref}`);
    this.#approvedRisks.add(action.risk);
  }
}
