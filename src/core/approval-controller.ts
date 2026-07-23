import {
  DynamicBorder,
  getSelectListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Spacer,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { FabricApprovalConfig } from "../config.js";
import type { FabricRisk } from "../protocol.js";
import type { ResolvedFabricAction } from "./action-registry.js";

const inheritedRisks = (): FabricRisk[] => {
  const allowed = new Set<FabricRisk>(["read", "write", "execute", "network", "agent"]);
  return (process.env.PI_FABRIC_GRANTED_RISKS ?? "")
    .split(",")
    .filter((risk): risk is FabricRisk => allowed.has(risk as FabricRisk));
};

type ApprovalChoice = "allow" | "deny";

const allowLabel = (risk: FabricRisk): string => `Allow ${risk} access`;

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

    const notification = `Fabric permission requested: ${action.ref} needs ${action.risk} access`;
    this.context.ui.notify(notification, "warning");
    const choice = this.context.mode === "tui"
      ? await this.#requestTuiApproval(action)
      : await this.#requestDialogApproval(action);

    if (choice !== "allow") {
      this.context.ui.notify(`Denied ${action.risk} access for ${action.ref}`, "warning");
      throw new Error(`User denied ${action.risk} access for ${action.ref}`);
    }
    this.#approvedRisks.add(action.risk);
    this.context.ui.notify(
      `Allowed ${action.risk} access for the current Fabric execution`,
      "info",
    );
  }

  async #requestDialogApproval(action: ResolvedFabricAction): Promise<ApprovalChoice> {
    const allowed = allowLabel(action.risk);
    const picked = await this.context.ui.select(
      `Pi Fabric permission · ${action.ref} requests ${action.risk} access. ${action.description}`,
      [allowed, "Deny"],
    );
    return picked === allowed ? "allow" : "deny";
  }

  async #requestTuiApproval(action: ResolvedFabricAction): Promise<ApprovalChoice> {
    const choice = await this.context.ui.custom<ApprovalChoice>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(theme.fg("warning", theme.bold("🛡  Pi Fabric permission request")), 1, 0),
      );
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          theme.fg("text", `${action.ref} requests ${action.risk} access.`),
          1,
          0,
        ),
      );
      container.addChild(new Text(theme.fg("muted", action.description), 1, 0));
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          theme.fg("dim", "Approval applies to this risk class for the current Fabric execution."),
          1,
          0,
        ),
      );
      container.addChild(new Spacer(1));
      const items: SelectItem[] = [
        {
          value: "allow",
          label: allowLabel(action.risk),
          description: "Continue this Fabric execution",
        },
        {
          value: "deny",
          label: "Deny",
          description: "Block the requested action",
        },
      ];
      const list = new SelectList(items, items.length, getSelectListTheme());
      list.onSelect = (item) => done(item.value as ApprovalChoice);
      list.onCancel = () => done("deny");
      container.addChild(list);
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate · enter select · esc deny"), 1, 0),
      );
      container.addChild(new Spacer(1));
      container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
    return choice ?? "deny";
  }
}
