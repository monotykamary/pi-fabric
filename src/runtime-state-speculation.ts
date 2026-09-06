import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricConfig } from "./config.js";
import type { ActionRegistry, ResolvedFabricAction } from "./core/action-registry.js";
import type { FabricInvocationContext } from "./protocol.js";
import {
  isSpeculationEligible,
  mcpAllowlistMatch,
  TIER_A_SPECULATION_REFS,
} from "./speculation/eligibility.js";
import { createFreshnessChecker } from "./speculation/freshness.js";
import { FabricSpeculationStore } from "./speculation/store.js";
import { FabricSpeculationStreamTap } from "./speculation/stream-tap.js";
import type { FabricSpeculationCandidate, FabricSpeculationReplay } from "./speculation/types.js";

/** Session-local speculative execution; runtime state owns reset ordering. */
export class RuntimeStateSpeculation {
  #store: FabricSpeculationStore | undefined;
  readonly tap: FabricSpeculationStreamTap | undefined;

  // Speculative PTC: the store is the epoch-checked promise cache consumed by
  // ActionRegistry.invoke; the tap watches fabric_exec argument streaming and
  // launches literal-args Tier-A calls early (docs/speculation.md).
  constructor(
    readonly registry: ActionRegistry,
    readonly readConfig: () => FabricConfig["speculation"] | undefined,
    readonly readCapabilityView: () => FabricInvocationContext["capabilityView"],
  ) {
    const speculation = readConfig();
    if (!speculation?.enabled) return;
    const store = new FabricSpeculationStore(speculation);
    registry.setSpeculation(store, (action: ResolvedFabricAction) =>
      isSpeculationEligible(
        {
          ref: action.ref,
          provider: action.provider,
          risk: action.risk,
          effectKind: action.effect?.kind,
          ...(action.annotations ? { annotations: action.annotations } : {}),
        },
        speculation.mcpAllowlist,
      ));
    this.#store = store;
    this.tap = new FabricSpeculationStreamTap({
      enabled: () => this.readConfig()?.enabled === true,
      maxBufferBytes: () => this.readConfig()?.maxBufferBytes ?? 2 * 1024 * 1024,
      isEligible: (ref) =>
        TIER_A_SPECULATION_REFS.has(ref) ||
        (ref.startsWith("mcp.") &&
          mcpAllowlistMatch(
            ref.slice("mcp.".length),
            this.readConfig()?.mcpAllowlist ?? [],
          )),
      launch: (toolCallId, candidate, extensionContext) => {
        void this.#launchSpeculation(toolCallId, candidate, extensionContext).catch(
          () => undefined,
        );
      },
    });
    // The scanner pulls in the TypeScript compiler; load it in the background
    // so session startup never pays. Streams that open first are re-scanned in
    // full once the factory lands (their extractors buffered the prefix).
    void import("./speculation/scanner.js").then(
      (module) => {
        this.tap?.setScannerFactory(() => new module.LiteralCallScanner());
      },
      () => undefined,
    );
  }

  async #launchSpeculation(
    toolCallId: string,
    candidate: FabricSpeculationCandidate,
    context: ExtensionContext,
  ): Promise<void> {
    const registry = this.registry;
    const store = this.#store;
    if (!registry || !store || this.readConfig()?.enabled !== true) return;
    const replay: FabricSpeculationReplay = {};
    const capabilityView = this.readCapabilityView();
    const lightContext: FabricInvocationContext = {
      cwd: context.cwd,
      signal: undefined,
      parentToolCallId: toolCallId,
      nestedToolCallId: "fabric-speculation",
      extensionContext: context,
      update() {},
      ...(capabilityView
        ? { capabilityView }
        : {}),
    };
    const speculation = await registry.speculate(
      candidate.ref,
      candidate.args,
      lightContext,
      replay,
    );
    if (!speculation) return;
    store.launch(
      toolCallId,
      candidate.ref,
      speculation.preparedArgs,
      speculation.execute,
      createFreshnessChecker(candidate.ref, speculation.preparedArgs, context.cwd),
      replay,
      speculation.bindingToken,
    );
  }

  reset(): void {
    this.tap?.reset();
    this.#store?.reset();
  }
}
