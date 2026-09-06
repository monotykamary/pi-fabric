import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ActionRegistry,
  type FabricCallAudit,
  type FabricCapabilityViewLease,
} from "../core/action-registry.js";
import { formatFabricEffectConflict } from "../core/effect-conflict.js";
import { stableJsonHash } from "../core/stable-hash.js";
import {
  FabricComponentIndependenceError,
  actionEffect,
  compareEffectInfo,
  effectConflictsBetween,
  registrationEffect,
  summarizeEffects,
  trackedRegistration,
} from "./effect-policy.js";
import type {
  FabricInvocationContext,
  FabricScopedProviderResult,
} from "../protocol.js";
import {
  FabricEffectDivertedError,
  FabricEffectScope,
} from "./effect-scope.js";
import {
  MAX_FABRIC_MODEL_GUIDANCE_PER_COMPONENT,
  MAX_FABRIC_MODEL_GUIDANCE_REGISTRATIONS,
  MAX_FABRIC_MODEL_GUIDANCE_SNAPSHOT_CHARS,
  MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS,
  compareFabricOwnedModelGuidance,
  fabricModelGuidanceInfo,
  normalizeFabricModelGuidance,
  type FabricOwnedModelGuidance,
  type NormalizedFabricModelGuidance,
} from "./model-guidance.js";
import type {
  FabricCapabilityRequirement,
  FabricComponentChildOptions,
  FabricComponentContext,
  FabricComponentDefinition,
  FabricComponentDisposer,
  FabricComponentEffectConflict,
  FabricComponentEffectInfo,
  FabricComponentEntry,
  FabricComponentGraph,
  FabricComponentHandle,
  FabricComponentInfo,
  FabricComponentProviderLease,
  FabricComponentState,
  FabricComponentStopOptions,
} from "./types.js";

interface ManagedComponent {
  entry: FabricComponentEntry;
  definition: FabricComponentDefinition;
  parentId?: string;
  state: FabricComponentState;
  guarantee: "managed" | "revertible";
  requirements: FabricCapabilityRequirement[];
  provisions: string[];
  missing: string[];
  optionalMissing: string[];
  revision: number;
  epoch: number;
  retired: boolean;
  activationOrder: number;
  childSequence: number;
  consecutiveDiversions: number;
  removeWhenSettled: boolean;
  createdAt: number;
  updatedAt: number;
  error?: string;
  cleanupErrors?: string[];
  blockedKey?: string;
  blockedOnEffects: boolean;
  scope: FabricEffectScope | undefined;
  viewLease: FabricCapabilityViewLease | undefined;
  providerLeases: FabricComponentProviderLease[];
  actionEffects: FabricComponentEffectInfo[];
  modelGuidance: NormalizedFabricModelGuidance[];
  abortController: AbortController | undefined;
  transition: Promise<void> | undefined;
  tearingDown?: boolean;
}

export interface FabricComponentSupervisorOptions {
  invocationContext?(): FabricInvocationContext;
  invoke?(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown>;
  acquire?(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<FabricScopedProviderResult>;
  maxResultChars?: number;
}

const COMPONENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MAX_COMPONENT_EFFECTS = 256;
const MAX_SUPERVISED_COMPONENTS = 1_024;
const MAX_CHILDREN_PER_COMPONENT = 256;

interface FabricComponentLifecycleFrame {
  supervisor: FabricComponentSupervisor;
  componentId: string;
  phase: "loading" | "unloading";
}

type FabricComponentLifecycleStorage =
  import("node:async_hooks").AsyncLocalStorage<FabricComponentLifecycleFrame>;
let componentLifecycleStorage: FabricComponentLifecycleStorage | undefined;
let componentLifecycleStorageTask: Promise<FabricComponentLifecycleStorage> | undefined;
const lifecycleStorage = (): Promise<FabricComponentLifecycleStorage> => {
  componentLifecycleStorageTask ??= import("node:async_hooks").then(({ AsyncLocalStorage }) => {
    componentLifecycleStorage ??= new AsyncLocalStorage<FabricComponentLifecycleFrame>();
    return componentLifecycleStorage;
  });
  return componentLifecycleStorageTask;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeRequirements = (
  definition: FabricComponentDefinition,
): FabricCapabilityRequirement[] => {
  const normalized = new Map<string, boolean>();
  for (const requirement of definition.requires ?? []) {
    const ref = (typeof requirement === "string" ? requirement : requirement.ref).trim();
    if (!ref || ref.length > 256 || !ref.includes(".")) {
      throw new Error(
        `Fabric component ${definition.name} requirement must use provider.action: ${ref || "<empty>"}`,
      );
    }
    const optional = typeof requirement === "string" ? false : requirement.optional === true;
    normalized.set(ref, (normalized.get(ref) ?? true) && optional);
  }
  return [...normalized]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, optional]) => ({ ref, ...(optional ? { optional: true } : {}) }));
};

const normalizeProvisions = (definition: FabricComponentDefinition): string[] => {
  const names = (definition.provides ?? []).map((provision) =>
    (typeof provision === "string" ? provision : provision.provider).trim(),
  );
  for (const name of names) {
    if (!PROVIDER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid provider declaration on ${definition.name}: ${name}`);
    }
  }
  return [...new Set(names)].sort();
};

const defaultInvocationContext = (): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "fabric-component",
  nestedToolCallId: "fabric-component",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const targetKey = (
  revision: number,
  digest: string | undefined,
  missing: readonly string[],
  provisionOccupancy: readonly boolean[],
): string => stableJsonHash({ revision, digest, missing, provisionOccupancy });

export class FabricComponentSupervisor {
  readonly #components = new Map<string, ManagedComponent>();
  readonly #listeners = new Set<(componentId?: string) => void>();
  readonly #unsubscribeRegistry: () => void;
  #requested = false;
  #reconciling: Promise<void> | undefined;
  #closed = false;
  #activationSequence = 0;

  constructor(
    readonly registry: ActionRegistry,
    readonly options: FabricComponentSupervisorOptions = {},
  ) {
    this.#unsubscribeRegistry = registry.subscribeProviderChanges(() => this.refresh());
  }

  subscribe(listener: (componentId?: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  assertLifecycleEntryAllowed(operation: string): void {
    this.#assertLifecycleCallAllowed(operation);
  }

  list(): FabricComponentInfo[] {
    const components = [...this.#components.values()]
      .sort((left, right) => left.entry.id.localeCompare(right.entry.id));
    const effects = new Map(components.map((component) => [
      component.entry.id,
      this.#effects(component),
    ]));
    const summaries = new Map(components.map((component) => [
      component.entry.id,
      summarizeEffects(effects.get(component.entry.id)!),
    ]));
    const conflicts = new Map(components.map((component) => [
      component.entry.id,
      [] as FabricComponentEffectConflict[],
    ]));
    for (let leftIndex = 0; leftIndex < components.length; leftIndex++) {
      const left = components[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex++) {
        const right = components[rightIndex]!;
        if (left.guarantee !== "revertible" && right.guarantee !== "revertible") continue;
        const bases = effectConflictsBetween(
          summaries.get(left.entry.id)!,
          summaries.get(right.entry.id)!,
        );
        for (const basis of bases) {
          if (
            left.guarantee === "revertible" &&
            conflicts.get(left.entry.id)!.length < 64
          ) {
            conflicts.get(left.entry.id)!.push({ withComponent: right.entry.id, ...basis });
          }
          if (
            right.guarantee === "revertible" &&
            conflicts.get(right.entry.id)!.length < 64
          ) {
            conflicts.get(right.entry.id)!.push({ withComponent: left.entry.id, ...basis });
          }
        }
      }
    }
    return components.map((component) => this.#info(
      component,
      effects.get(component.entry.id),
      conflicts.get(component.entry.id),
    ));
  }

  status(id: string): FabricComponentInfo {
    return this.#info(this.#require(id));
  }

  guidance(): FabricOwnedModelGuidance[] {
    return [...this.#components.values()]
      .filter((component) => component.state === "active")
      .flatMap((component) => component.modelGuidance.map((guidance) => ({
        ...structuredClone(guidance),
        componentId: component.entry.id,
        component: component.definition.name,
        revision: component.revision,
      })))
      .sort(compareFabricOwnedModelGuidance);
  }

  graph(): FabricComponentGraph {
    const providers = new Map<string, string>();
    for (const component of this.#components.values()) {
      for (const provider of component.provisions) providers.set(provider, component.entry.id);
    }
    const dependencyEdges: FabricComponentGraph["edges"] = [];
    const ownershipEdges: FabricComponentGraph["edges"] = [];
    for (const component of this.#components.values()) {
      for (const requirement of component.requirements) {
        const provider = requirement.ref.slice(0, requirement.ref.indexOf("."));
        const source = providers.get(provider);
        if (source) {
          dependencyEdges.push({
            from: component.entry.id,
            to: source,
            ref: requirement.ref,
            kind: "dependency",
          });
        }
      }
      if (component.parentId) {
        ownershipEdges.push({
          from: component.entry.id,
          to: component.parentId,
          ref: "component:parent",
          kind: "ownership",
        });
      }
    }
    const edges = [...dependencyEdges, ...ownershipEdges].sort((left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.ref.localeCompare(right.ref),
    );
    return { components: this.list(), edges, cycles: this.#cycles(dependencyEdges) };
  }

  async start(
    entry: FabricComponentEntry,
    definition: FabricComponentDefinition,
  ): Promise<FabricComponentInfo> {
    this.#assertOpen();
    this.#assertLifecycleCallAllowed("start Fabric components");
    const component = this.#insert(entry, definition);
    await this.#requestReconcile();
    if (component.state === "failed" || component.state === "quarantined") {
      throw new Error(component.error ?? `Fabric component ${entry.id} failed to start`);
    }
    return this.#info(component);
  }

  async replace(
    id: string,
    entry: FabricComponentEntry,
    definition: FabricComponentDefinition,
  ): Promise<FabricComponentInfo> {
    this.#assertOpen();
    this.#assertLifecycleCallAllowed("replace Fabric components");
    const component = this.#require(id);
    if (entry.id !== id) throw new Error("Fabric component replacement cannot change its entry id");
    this.#validateEntry(entry, definition);
    const nextProvisions = normalizeProvisions(definition);
    this.#assertProvisionsAvailable(id, nextProvisions);
    const previous = {
      entry: structuredClone(component.entry),
      definition: component.definition,
      requirements: component.requirements,
      provisions: component.provisions,
      guarantee: component.guarantee,
      revision: component.revision,
      parentId: component.parentId,
    };

    component.removeWhenSettled = false;
    this.#retire(component);
    await this.#unload(component, new Set());
    const unloadedState = component.state as FabricComponentState;
    if (unloadedState === "quarantined") {
      throw new Error(component.error ?? `Fabric component ${id} cleanup failed`);
    }
    this.#applyReplacement(component, entry, definition, previous.revision + 1, nextProvisions);
    await this.#requestReconcile();
    const candidateState = component.state as FabricComponentState;
    if (candidateState !== "failed" && candidateState !== "quarantined") {
      return this.#info(component);
    }

    const replacementError = component.error ?? `Fabric component ${id} replacement failed`;
    if (candidateState === "quarantined") throw new Error(replacementError);
    this.#retire(component);
    await this.#unload(component, new Set());
    component.entry = previous.entry;
    component.definition = previous.definition;
    component.requirements = previous.requirements;
    component.provisions = previous.provisions;
    component.guarantee = previous.guarantee;
    if (previous.parentId) component.parentId = previous.parentId;
    else delete component.parentId;
    component.revision = previous.revision + 2;
    component.epoch++;
    component.retired = false;
    component.state = "waiting";
    component.missing = [];
    component.optionalMissing = [];
    component.actionEffects = [];
    component.modelGuidance = [];
    component.consecutiveDiversions = 0;
    component.removeWhenSettled = false;
    delete component.error;
    delete component.cleanupErrors;
    component.blockedOnEffects = false;
    delete component.blockedKey;
    component.updatedAt = Date.now();
    await this.#requestReconcile();
    const rollbackState = component.state as FabricComponentState;
    if (rollbackState === "failed" || rollbackState === "quarantined") {
      throw new AggregateError(
        [new Error(replacementError), new Error(component.error ?? "rollback failed")],
        `Fabric component ${id} replacement and rollback failed`,
      );
    }
    throw new Error(`${replacementError}; previous revision restored`);
  }

  async stop(id: string, options: FabricComponentStopOptions = {}): Promise<void> {
    const component = this.#require(id);
    if (this.#selfLifecycleStop(id)) {
      component.removeWhenSettled = true;
      this.#retire(component);
      return;
    }
    this.#assertLifecycleCallAllowed("stop Fabric components");
    this.#retire(component);
    await this.#unload(component, new Set());
    if (this.#components.get(id) !== component) return;
    if (component.state === "quarantined" && !options.force) {
      throw new Error(component.error ?? `Fabric component ${id} cleanup failed`);
    }
    component.state = "disposed";
    component.updatedAt = Date.now();
    this.#emit(id);
    this.#components.delete(id);
    this.#emit(id);
    await this.#requestReconcile();
  }

  refresh(): void {
    if (this.#closed) return;
    void this.#requestReconcile().catch(() => undefined);
  }

  async settle(): Promise<void> {
    this.#assertLifecycleCallAllowed("settle Fabric components");
    await this.#waitForReconcile();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#assertLifecycleCallAllowed("close Fabric components");
    this.#closed = true;
    this.#unsubscribeRegistry();
    const components = [...this.#components.values()].sort((left, right) =>
      right.activationOrder - left.activationOrder ||
      right.createdAt - left.createdAt ||
      right.entry.id.localeCompare(left.entry.id),
    );
    for (const component of components) this.#retire(component);
    const visited = new Set<string>();
    for (const component of components) await this.#unload(component, visited);
    for (const component of this.#components.values()) {
      if (component.state !== "quarantined") component.state = "disposed";
      component.updatedAt = Date.now();
      this.#emit(component.entry.id);
    }
    this.#components.clear();
    this.#emit();
    this.#listeners.clear();
  }

  #insert(
    entry: FabricComponentEntry,
    definition: FabricComponentDefinition,
    parentId?: string,
  ): ManagedComponent {
    this.#validateEntry(entry, definition);
    if (this.#components.size >= MAX_SUPERVISED_COMPONENTS) {
      throw new Error(
        `Fabric component supervisor supports at most ${MAX_SUPERVISED_COMPONENTS} fibers`,
      );
    }
    if (this.#components.has(entry.id)) {
      throw new Error(`Fabric component already exists: ${entry.id}`);
    }
    const provisions = normalizeProvisions(definition);
    this.#assertProvisionsAvailable(entry.id, provisions);
    const now = Date.now();
    const component: ManagedComponent = {
      entry: structuredClone(entry),
      definition,
      ...(parentId ? { parentId } : {}),
      state: "waiting",
      guarantee: definition.guarantee ?? "managed",
      requirements: normalizeRequirements(definition),
      provisions,
      missing: [],
      optionalMissing: [],
      revision: 1,
      epoch: 0,
      retired: false,
      activationOrder: 0,
      childSequence: 0,
      consecutiveDiversions: 0,
      removeWhenSettled: false,
      createdAt: now,
      updatedAt: now,
      scope: undefined,
      viewLease: undefined,
      providerLeases: [],
      actionEffects: [],
      modelGuidance: [],
      abortController: undefined,
      transition: undefined,
      blockedOnEffects: false,
    };
    this.#components.set(entry.id, component);
    this.#emit(entry.id);
    return component;
  }

  #insertChild<TConfig>(
    parent: ManagedComponent,
    definition: FabricComponentDefinition<TConfig>,
    options: FabricComponentChildOptions<TConfig> = {},
  ): FabricComponentHandle {
    if (
      parent.retired ||
      parent.tearingDown ||
      parent.state !== "loading" ||
      parent.scope?.state !== "open"
    ) {
      throw new Error(`Fabric component ${parent.entry.id} can only use children while activating`);
    }
    const childCount = [...this.#components.values()].filter(
      (component) => component.parentId === parent.entry.id,
    ).length;
    if (childCount >= MAX_CHILDREN_PER_COMPONENT) {
      throw new Error(
        `Fabric component ${parent.entry.id} supports at most ${MAX_CHILDREN_PER_COMPONENT} children`,
      );
    }
    const sequence = ++parent.childSequence;
    const rawLocalId = options.id ?? `${definition.name}-${sequence}`;
    const localId = options.id
      ? rawLocalId
      : rawLocalId
          .replace(/[^a-zA-Z0-9._-]/g, "-")
          .replace(/^[^a-zA-Z0-9]+/, "") || `child-${sequence}`;
    if (!COMPONENT_ID_PATTERN.test(localId)) {
      throw new Error(`Invalid Fabric child component id: ${rawLocalId}`);
    }
    const joined = `${parent.entry.id}.${localId}`;
    const id = joined.length <= 128
      ? joined
      : `${parent.entry.id.slice(0, 94)}.${stableJsonHash(joined).slice(0, 32)}`;
    const entry: FabricComponentEntry = {
      id,
      component: definition.name,
      ...(Object.prototype.hasOwnProperty.call(options, "config")
        ? { config: options.config }
        : {}),
    };
    const child = this.#insert(entry, definition, parent.entry.id);
    this.#requested = true;
    parent.scope.defer(
      () => this.#retireOwnedChild(parent.entry.id, child.entry.id),
      `component:child:${child.entry.id}`,
    );
    return {
      id: child.entry.id,
      status: () => {
        if (this.#components.get(child.entry.id) !== child) {
          throw new Error(`Fabric child component is no longer installed: ${child.entry.id}`);
        }
        return this.#info(child);
      },
      stop: async (stopOptions) => {
        if (this.#components.get(child.entry.id) !== child) return;
        if (this.#selfLifecycleStop(child.entry.id)) {
          child.removeWhenSettled = true;
          this.#retire(child);
          return;
        }
        this.#assertLifecycleCallAllowed("stop a child component");
        this.#retire(child);
        await this.#unload(child, new Set());
        if (this.#components.get(child.entry.id) !== child) return;
        if (child.state === "quarantined" && !stopOptions?.force) {
          throw new Error(child.error ?? `Fabric component ${child.entry.id} cleanup failed`);
        }
        child.state = "disposed";
        child.updatedAt = Date.now();
        this.#emit(child.entry.id);
        this.#components.delete(child.entry.id);
        this.#emit(child.entry.id);
        this.#requested = true;
      },
    };
  }

  #validateEntry(entry: FabricComponentEntry, definition: FabricComponentDefinition): void {
    if (!COMPONENT_ID_PATTERN.test(entry.id)) {
      throw new Error(`Invalid Fabric component id: ${entry.id}`);
    }
    if (entry.component !== definition.name) {
      throw new Error(
        `Fabric component entry ${entry.id} selects ${entry.component}, not ${definition.name}`,
      );
    }
  }

  #assertProvisionsAvailable(id: string, provisions: readonly string[]): void {
    for (const component of this.#components.values()) {
      if (component.entry.id === id) continue;
      const overlap = provisions.filter((provider) => component.provisions.includes(provider));
      if (overlap.length > 0) {
        throw new Error(
          `Fabric components ${id} and ${component.entry.id} declare the same providers: ${overlap.join(", ")}`,
        );
      }
    }
    const owner = this.#components.get(id);
    const occupied = provisions.filter((provider) =>
      this.registry.has(provider) &&
      !owner?.providerLeases.some((lease) => lease.name === provider && lease.active),
    );
    if (occupied.length > 0) {
      throw new Error(
        `Fabric component ${id} providers are already registered outside the component: ${occupied.join(", ")}`,
      );
    }
  }

  #applyReplacement(
    component: ManagedComponent,
    entry: FabricComponentEntry,
    definition: FabricComponentDefinition,
    revision: number,
    provisions = normalizeProvisions(definition),
  ): void {
    component.entry = structuredClone(entry);
    component.definition = definition;
    component.requirements = normalizeRequirements(definition);
    component.provisions = provisions;
    component.guarantee = definition.guarantee ?? "managed";
    component.revision = revision;
    component.epoch++;
    component.retired = false;
    component.state = "waiting";
    component.missing = [];
    component.optionalMissing = [];
    component.actionEffects = [];
    component.modelGuidance = [];
    component.childSequence = 0;
    component.consecutiveDiversions = 0;
    component.removeWhenSettled = false;
    delete component.error;
    delete component.cleanupErrors;
    component.blockedOnEffects = false;
    delete component.blockedKey;
    component.updatedAt = Date.now();
  }

  #retire(component: ManagedComponent): void {
    if (component.retired) return;
    component.retired = true;
    component.epoch++;
    component.updatedAt = Date.now();
  }

  #requestReconcile(): Promise<void> {
    this.#requested = true;
    this.#startReconcile();
    return this.#waitForReconcile();
  }

  #startReconcile(): void {
    if (this.#reconciling || this.#closed) return;
    const task = this.#drainReconcile();
    this.#reconciling = task;
    void task.finally(() => {
      if (this.#reconciling === task) this.#reconciling = undefined;
      if (this.#requested && !this.#closed) this.#startReconcile();
    }).catch(() => undefined);
  }

  async #waitForReconcile(): Promise<void> {
    for (;;) {
      this.#startReconcile();
      const task = this.#reconciling;
      if (!task) return;
      await task;
      if (!this.#requested && !this.#reconciling) return;
    }
  }

  async #drainReconcile(): Promise<void> {
    while (this.#requested && !this.#closed) {
      this.#requested = false;
      for (const component of this.#components.values()) {
        await this.#reconcile(component);
      }
    }
  }

  async #reconcile(component: ManagedComponent): Promise<void> {
    if (
      component.retired ||
      component.state === "loading" ||
      component.state === "unloading" ||
      component.state === "disposed" ||
      component.state === "quarantined"
    ) {
      return;
    }
    const baseContext = this.#invocationContext(component);
    const resolution = await this.registry.inspectCapabilities(
      component.requirements,
      baseContext,
    );
    component.missing = resolution.missing;
    component.optionalMissing = resolution.optionalMissing;
    const key = targetKey(
      component.revision,
      resolution.view?.digest,
      resolution.missing,
      component.provisions.map((provider) => this.registry.has(provider)),
    );
    const effectiveKey = component.blockedOnEffects
      ? stableJsonHash({ key, effects: this.#effectEnvironmentDigest(component) })
      : key;

    if (component.state === "active") {
      const provisionsActive = component.providerLeases.length === component.provisions.length &&
        component.providerLeases.every((lease) => lease.active);
      if (
        provisionsActive &&
        resolution.satisfied &&
        resolution.view?.digest === component.viewLease?.view?.digest
      ) return;
      await this.#unload(component, new Set());
      const unloadedState = component.state as FabricComponentState;
      if (component.retired || unloadedState === "quarantined") return;
    }
    if (!resolution.satisfied) {
      component.state = "waiting";
      component.blockedOnEffects = false;
      component.updatedAt = Date.now();
      component.blockedKey = effectiveKey;
      this.#emit(component.entry.id);
      return;
    }
    if (component.state === "failed" && component.blockedKey === effectiveKey) return;
    await this.#load(component, baseContext, key);
  }

  async #load(
    component: ManagedComponent,
    baseContext: FabricInvocationContext,
    key: string,
  ): Promise<void> {
    if (component.transition) await component.transition;
    if (component.retired || this.#closed) return;
    const epoch = component.epoch;
    const storage = await lifecycleStorage();
    if (component.retired || this.#closed) return;
    const task = storage.run(
      { supervisor: this, componentId: component.entry.id, phase: "loading" },
      () => this.#performLoad(component, baseContext, key, epoch),
    );
    component.transition = task;
    try {
      await task;
    } finally {
      if (component.transition === task) component.transition = undefined;
      this.#removeRetiredAfterTransition(component);
    }
  }

  async #performLoad(
    component: ManagedComponent,
    baseContext: FabricInvocationContext,
    key: string,
    epoch: number,
  ): Promise<void> {
    component.state = "loading";
    component.updatedAt = Date.now();
    component.missing = [];
    component.actionEffects = [];
    component.modelGuidance = [];
    component.consecutiveDiversions = 0;
    component.removeWhenSettled = false;
    delete component.error;
    delete component.cleanupErrors;
    this.#emit(component.entry.id);

    const controller = new AbortController();
    let scope: FabricEffectScope | undefined;
    let viewLease: FabricCapabilityViewLease | undefined;
    const providerLeases: FabricComponentProviderLease[] = [];
    const actionEffects: FabricComponentEffectInfo[] = [];
    const modelGuidance: NormalizedFabricModelGuidance[] = [];
    try {
      viewLease = await this.registry.acquireCapabilityView(
        component.requirements,
        { ...baseContext, signal: controller.signal },
      );
      if (!viewLease.satisfied || !viewLease.view) {
        const missing = [...viewLease.missing];
        const optionalMissing = [...viewLease.optionalMissing];
        await viewLease.release();
        viewLease = undefined;
        if (this.#transitionCurrent(component, epoch)) {
          component.state = "waiting";
          component.missing = missing;
          component.optionalMissing = optionalMissing;
          component.updatedAt = Date.now();
          this.#emit(component.entry.id);
        }
        return;
      }
      if (!this.#transitionCurrent(component, epoch)) throw new FabricEffectDivertedError();
      const committedView = viewLease.view;
      scope = new FabricEffectScope({
        guard: () => this.#targetMatches(component, epoch, committedView.digest, baseContext),
      });
      component.scope = scope;
      component.viewLease = viewLease;
      component.abortController = controller;
      component.providerLeases = providerLeases;
      component.actionEffects = actionEffects;
      component.modelGuidance = modelGuidance;
      const declared = new Set(component.provisions);
      const assertRegistrationOpen = (): void => {
        if (component.tearingDown || scope?.state !== "open") {
          throw new Error(
            `Fabric component ${component.entry.id} cannot register effects during teardown`,
          );
        }
      };
      const invocation: FabricInvocationContext = {
        ...baseContext,
        signal: controller.signal,
        capabilityView: committedView,
        effectPolicy: component.guarantee === "revertible" ? "strict" : "advisory",
      };
      const context: FabricComponentContext = {
        id: component.entry.id,
        signal: controller.signal,
        invocation,
        view: committedView,
        effect: async (setup, registration) => {
          assertRegistrationOpen();
          const tracked = trackedRegistration(registration, "anonymous");
          if (component.guarantee === "revertible") {
            this.#assertEffectCapacity(component, 1);
            if (tracked.kind === "emission") {
              throw new Error(
                `Revertible Fabric component ${component.entry.id} cannot register an emission effect`,
              );
            }
            this.#assertIndependent(component, [registrationEffect(tracked)]);
          }
          const dispose = await scope!.effect(setup, tracked);
          return async () => {
            await dispose();
            this.refresh();
          };
        },
        defer: (disposer, registration) => {
          assertRegistrationOpen();
          const tracked = trackedRegistration(registration, "deferred");
          const dispose = scope!.defer(disposer, tracked);
          if (component.guarantee === "revertible") this.#assertEffectCapacity(component);
          if (component.guarantee === "revertible" && tracked.kind === "emission") {
            throw new Error(
              `Revertible Fabric component ${component.entry.id} cannot defer an emission effect`,
            );
          }
          return async () => {
            await dispose();
            this.refresh();
          };
        },
        guide: (guidance) => {
          assertRegistrationOpen();
          const normalized = normalizeFabricModelGuidance(guidance);
          if (modelGuidance.some((entry) => entry.label === normalized.label)) {
            throw new Error(
              `Fabric component ${component.entry.id} registered guidance label ${normalized.label} more than once`,
            );
          }
          if (modelGuidance.length >= MAX_FABRIC_MODEL_GUIDANCE_PER_COMPONENT) {
            throw new Error(
              `Fabric component ${component.entry.id} supports at most ${MAX_FABRIC_MODEL_GUIDANCE_PER_COMPONENT} guidance registrations`,
            );
          }
          const totalChars = modelGuidance.reduce((sum, entry) => sum + entry.content.length, 0) +
            normalized.content.length;
          if (totalChars > MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS) {
            throw new Error(
              `Fabric component ${component.entry.id} guidance exceeds ${MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS} characters`,
            );
          }
          const projection = [...this.#components.values()]
            .flatMap((candidate) => candidate.modelGuidance);
          if (projection.length >= MAX_FABRIC_MODEL_GUIDANCE_REGISTRATIONS) {
            throw new Error(
              `Fabric component guidance supports at most ${MAX_FABRIC_MODEL_GUIDANCE_REGISTRATIONS} registrations`,
            );
          }
          const projectionChars = projection.reduce((sum, entry) => sum + entry.content.length, 0) +
            normalized.content.length;
          if (projectionChars > MAX_FABRIC_MODEL_GUIDANCE_SNAPSHOT_CHARS) {
            throw new Error(
              `Fabric component guidance snapshot exceeds ${MAX_FABRIC_MODEL_GUIDANCE_SNAPSHOT_CHARS} characters`,
            );
          }
          const registration = {
            label: `guidance:${normalized.label}`,
            kind: "transactional" as const,
            resources: [`fabric:guidance:${component.entry.id}:${normalized.label}`],
            ordering: "commutative" as const,
          };
          if (component.guarantee === "revertible") {
            this.#assertEffectCapacity(component, 1);
            this.#assertIndependent(component, [registrationEffect(registration)]);
          }
          let registered = true;
          const unregister = (): void => {
            if (!registered) return;
            registered = false;
            const index = modelGuidance.indexOf(normalized);
            if (index >= 0) modelGuidance.splice(index, 1);
            component.updatedAt = Date.now();
            if (component.state === "active") this.#emit(component.entry.id);
          };
          modelGuidance.push(normalized);
          let dispose: FabricComponentDisposer;
          try {
            dispose = scope!.defer(unregister, registration);
          } catch (error) {
            unregister();
            throw error;
          }
          component.updatedAt = Date.now();
          if (component.state === "active") this.#emit(component.entry.id);
          return async () => {
            await dispose();
            this.refresh();
          };
        },
        provide: (provider) => {
          assertRegistrationOpen();
          if (component.guarantee === "revertible" && !provider.close) {
            throw new Error(
              `Revertible Fabric component ${component.entry.id} provider ${provider.name} must implement close()`,
            );
          }
          if (!declared.has(provider.name)) {
            throw new Error(
              `Fabric component ${component.entry.id} mounted undeclared provider ${provider.name}`,
            );
          }
          if (providerLeases.some((lease) => lease.name === provider.name)) {
            throw new Error(
              `Fabric component ${component.entry.id} mounted provider ${provider.name} more than once`,
            );
          }
          const lease = this.registry.mount(provider, { staged: true });
          providerLeases.push(lease);
          return lease;
        },
        use: <TConfig>(
          definition: FabricComponentDefinition<TConfig>,
          options?: FabricComponentChildOptions<TConfig>,
        ) => this.#insertChild(component, definition, options),
        acquire: async <T = unknown>(ref: string, args?: Record<string, unknown>) => {
          if (!committedView.bindings[ref]) {
            throw new Error(
              `Fabric component ${component.entry.id} acquired undeclared or unavailable capability ${ref}`,
            );
          }
          const action = await this.registry.describe(ref, invocation);
          if (action.effect?.kind !== "scoped") {
            throw new Error(`Fabric action is not a scoped acquisition: ${ref}`);
          }
          const effect = actionEffect(action)!;
          if (component.guarantee === "revertible") {
            this.#assertEffectCapacity(component, 1);
            this.#assertIndependent(component, [effect]);
          }
          const acquired = this.options.acquire
            ? await this.options.acquire(ref, args ?? {}, invocation)
            : await this.registry.acquireScoped(ref, args ?? {}, invocation);
          try {
            scope!.defer(acquired.dispose, {
              label: `acquire:${ref}`,
              kind: effect.kind,
              resources: effect.resources,
              ordering: effect.ordering,
            });
          } catch (error) {
            await acquired.dispose();
            throw error;
          }
          return acquired.value as T;
        },
        call: async (ref, args) => {
          if (!committedView.bindings[ref]) {
            throw new Error(
              `Fabric component ${component.entry.id} called undeclared or unavailable capability ${ref}`,
            );
          }
          const callInvocation: FabricInvocationContext = {
            ...invocation,
            signal: component.tearingDown ? undefined : invocation.signal,
          };
          const action = await this.registry.describe(ref, callInvocation);
          if (action.effect?.kind === "scoped") {
            throw new Error(`Fabric scoped action ${ref} must be used through context.acquire()`);
          }
          if (
            component.guarantee === "revertible" &&
            action.effect?.kind !== "none" &&
            action.effect?.kind !== "transactional"
          ) {
            throw new Error(
              `Revertible Fabric component ${component.entry.id} cannot emit non-revertible action ${ref}`,
            );
          }
          const effect = actionEffect(action);
          if (effect && component.guarantee === "revertible") {
            this.#assertEffectCapacity(component, 1);
            this.#assertIndependent(component, [effect]);
          }
          const callArgs = args ?? {};
          const value = this.options.invoke
            ? await this.options.invoke(ref, callArgs, callInvocation)
            : await this.registry.invoke(ref, callArgs, {
                ...callInvocation,
                approve: async () => {},
                audits: [] as FabricCallAudit[],
                maxResultChars: this.options.maxResultChars ?? 2_000_000,
              });
          if (effect && actionEffects.length < MAX_COMPONENT_EFFECTS) actionEffects.push(effect);
          return value;
        },
      };

      await scope.effect(
        () => component.definition.activate(context, component.entry.config),
        "component:activate",
        { beforeCleanup: () => { component.tearingDown = true; } },
      );
      const unprovided = component.provisions.filter(
        (name) => !providerLeases.some((lease) => lease.name === name),
      );
      if (unprovided.length > 0) {
        throw new Error(
          `Fabric component ${component.entry.id} did not mount declared providers: ${unprovided.join(", ")}`,
        );
      }
      if (!(await this.#targetMatches(component, epoch, committedView.digest, baseContext))) {
        throw new FabricEffectDivertedError(
          `Fabric component ${component.entry.id} capability target changed during activation`,
        );
      }
      if (component.guarantee === "revertible") {
        this.#assertIndependent(component, this.#effects(component));
      }
      this.registry.activateProviderBindings(
        providerLeases.map((lease) => lease.bindingId),
      );
      if (!this.#transitionCurrent(component, epoch)) {
        throw new FabricEffectDivertedError(
          `Fabric component ${component.entry.id} was retired during activation`,
        );
      }
      component.state = "active";
      component.blockedOnEffects = false;
      component.consecutiveDiversions = 0;
      component.activationOrder = ++this.#activationSequence;
      component.optionalMissing = viewLease.optionalMissing;
      component.blockedKey = key;
      component.updatedAt = Date.now();
      this.#emit(component.entry.id);
    } catch (error) {
      component.tearingDown = true;
      controller.abort(error);
      for (const lease of providerLeases) lease.retire();
      const report = scope
        ? await scope.dispose()
        : { status: "disposed" as const, failures: [] };
      const providerCleanup = await Promise.allSettled(
        providerLeases.map((lease) => lease.release()),
      );
      const viewCleanup = viewLease
        ? (await Promise.allSettled([viewLease.release()]))[0]
        : undefined;
      if (component.scope === scope) component.scope = undefined;
      if (component.viewLease === viewLease) component.viewLease = undefined;
      if (component.abortController === controller) component.abortController = undefined;
      if (component.providerLeases === providerLeases) component.providerLeases = [];
      if (component.actionEffects === actionEffects) component.actionEffects = [];
      if (component.modelGuidance === modelGuidance) component.modelGuidance = [];
      component.tearingDown = false;
      component.updatedAt = Date.now();
      const cleanupErrors = [
        ...report.failures.map((failure) => `${failure.label}: ${failure.error}`),
        ...(error instanceof FabricEffectDivertedError && error.cleanupError !== undefined
          ? [`iterator-close: ${errorMessage(error.cleanupError)}`]
          : []),
        ...providerCleanup.flatMap((result) =>
          result.status === "rejected" ? [`provider: ${errorMessage(result.reason)}`] : [],
        ),
        ...providerLeases.flatMap((lease) =>
          lease.active ? [`provider:${lease.name}: binding remained active after rollback`] : [],
        ),
        ...(viewCleanup?.status === "rejected"
          ? [`capability-view: ${errorMessage(viewCleanup.reason)}`]
          : []),
      ];
      let diverted = error instanceof FabricEffectDivertedError ||
        !this.#transitionCurrent(component, epoch);
      if (!diverted && viewLease?.view) {
        try {
          diverted = !(await this.#targetMatches(
            component,
            epoch,
            viewLease.view.digest,
            baseContext,
          ));
        } catch {
          // A target probe failure does not erase the activation error that triggered cleanup.
        }
      }
      let retryDelayMs = 0;
      if (cleanupErrors.length > 0) {
        component.state = "quarantined";
        component.consecutiveDiversions = 0;
        component.error = errorMessage(error);
        component.cleanupErrors = cleanupErrors;
      } else if (diverted) {
        component.state = "waiting";
        component.consecutiveDiversions++;
        retryDelayMs = Math.min(2 ** (component.consecutiveDiversions - 1), 100);
        delete component.error;
        delete component.cleanupErrors;
        component.blockedOnEffects = false;
        delete component.blockedKey;
      } else {
        component.state = "failed";
        component.consecutiveDiversions = 0;
        component.blockedOnEffects = error instanceof FabricComponentIndependenceError;
        component.error = errorMessage(error);
        component.blockedKey = component.blockedOnEffects
          ? stableJsonHash({ key, effects: this.#effectEnvironmentDigest(component) })
          : key;
      }
      this.#emit(component.entry.id);
      if (diverted && !component.retired && !this.#closed) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        if (!component.retired && !this.#closed) this.#requested = true;
      }
    }
  }

  async #targetMatches(
    component: ManagedComponent,
    epoch: number,
    digest: string,
    baseContext: FabricInvocationContext,
  ): Promise<boolean> {
    if (!this.#transitionCurrent(component, epoch)) return false;
    const { capabilityView: _committedView, ...uncommittedContext } = baseContext;
    const resolution = await this.registry.inspectCapabilities(component.requirements, {
      ...uncommittedContext,
      signal: undefined,
    });
    return this.#transitionCurrent(component, epoch) &&
      resolution.satisfied &&
      resolution.view?.digest === digest;
  }

  #transitionCurrent(component: ManagedComponent, epoch: number): boolean {
    return !component.retired &&
      component.epoch === epoch &&
      this.#components.get(component.entry.id) === component &&
      !this.#closed;
  }

  async #unload(component: ManagedComponent, visited: Set<string>): Promise<void> {
    if (visited.has(component.entry.id)) return;
    visited.add(component.entry.id);
    component.abortController?.abort(
      new Error(`Fabric component ${component.entry.id} is unloading`),
    );
    if (component.transition) await component.transition;
    if (!component.scope && !component.viewLease && component.providerLeases.length === 0) {
      if (component.state !== "disposed" && component.state !== "quarantined") {
        component.state = "waiting";
      }
      return;
    }
    const storage = await lifecycleStorage();
    const task = storage.run(
      { supervisor: this, componentId: component.entry.id, phase: "unloading" },
      () => this.#performUnload(component, visited),
    );
    component.transition = task;
    try {
      await task;
    } finally {
      if (component.transition === task) component.transition = undefined;
      this.#removeRetiredAfterTransition(component);
    }
  }

  async #performUnload(component: ManagedComponent, visited: Set<string>): Promise<void> {
    component.state = "unloading";
    component.tearingDown = true;
    component.updatedAt = Date.now();
    component.abortController?.abort(
      new Error(`Fabric component ${component.entry.id} is unloading`),
    );
    for (const lease of component.providerLeases) lease.retire();
    this.#emit(component.entry.id);

    const childCleanupErrors: string[] = [];
    const children = [...this.#components.values()]
      .filter((candidate) => candidate.parentId === component.entry.id)
      .sort((left, right) =>
        right.activationOrder - left.activationOrder ||
        right.createdAt - left.createdAt ||
        right.entry.id.localeCompare(left.entry.id),
      );
    for (const child of children) {
      try {
        await this.#retireOwnedChild(component.entry.id, child.entry.id, visited);
      } catch (error) {
        childCleanupErrors.push(`child:${child.entry.id}: ${errorMessage(error)}`);
      }
    }

    const bindingIds = new Set(component.providerLeases.map((lease) => lease.bindingId));
    for (const dependent of this.#components.values()) {
      if (dependent === component || !dependent.viewLease?.view) continue;
      const depends = Object.values(dependent.viewLease.view.bindings).some((binding) =>
        bindingIds.has(binding.providerBindingId),
      );
      if (depends) await this.#unload(dependent, visited);
    }

    const leases = component.providerLeases;
    const scope = component.scope;
    const viewLease = component.viewLease;
    const report = await scope?.dispose();
    const providerCleanup = await Promise.allSettled(leases.map((lease) => lease.release()));
    const viewCleanup = viewLease
      ? (await Promise.allSettled([viewLease.release()]))[0]
      : undefined;
    component.scope = undefined;
    component.viewLease = undefined;
    component.abortController = undefined;
    component.providerLeases = [];
    component.actionEffects = [];
    component.modelGuidance = [];
    component.tearingDown = false;
    component.updatedAt = Date.now();
    const cleanupErrors = [
      ...childCleanupErrors,
      ...(report?.failures ?? []).map(
        (failure) => `${failure.label}: ${failure.error}`,
      ),
      ...providerCleanup.flatMap((result) =>
        result.status === "rejected" ? [`provider: ${errorMessage(result.reason)}`] : [],
      ),
      ...leases.flatMap((lease) =>
        lease.active ? [`provider:${lease.name}: binding remained active after unload`] : [],
      ),
      ...(viewCleanup?.status === "rejected"
        ? [`capability-view: ${errorMessage(viewCleanup.reason)}`]
        : []),
    ];
    if (cleanupErrors.length > 0) {
      component.state = "quarantined";
      component.error = `Fabric component ${component.entry.id} cleanup failed`;
      component.cleanupErrors = cleanupErrors;
    } else {
      component.state = "waiting";
      delete component.cleanupErrors;
    }
    this.#emit(component.entry.id);
  }

  async #retireOwnedChild(
    parentId: string,
    childId: string,
    visited = new Set<string>(),
  ): Promise<void> {
    const child = this.#components.get(childId);
    if (!child || child.parentId !== parentId) return;
    this.#retire(child);
    await this.#unload(child, visited);
    if (this.#components.get(childId) !== child) return;
    const cleanupError = child.state === "quarantined"
      ? new Error(child.error ?? `Fabric child component ${childId} cleanup failed`)
      : undefined;
    child.state = child.state === "quarantined" ? "quarantined" : "disposed";
    child.updatedAt = Date.now();
    this.#emit(childId);
    this.#components.delete(childId);
    this.#emit(childId);
    this.#requested = true;
    if (cleanupError) throw cleanupError;
  }

  #removeRetiredAfterTransition(component: ManagedComponent): void {
    if (
      !component.removeWhenSettled ||
      component.state === "quarantined" ||
      this.#components.get(component.entry.id) !== component
    ) return;
    component.removeWhenSettled = false;
    component.state = "disposed";
    component.updatedAt = Date.now();
    this.#emit(component.entry.id);
    this.#components.delete(component.entry.id);
    this.#emit(component.entry.id);
    this.#requested = true;
  }

  #effects(component: ManagedComponent): FabricComponentEffectInfo[] {
    const scopedLimit = Math.max(0, MAX_COMPONENT_EFFECTS - component.actionEffects.length);
    const effects = [
      ...(component.scope?.footprint(scopedLimit) ?? []),
      ...component.actionEffects.slice(0, MAX_COMPONENT_EFFECTS),
    ].slice(0, MAX_COMPONENT_EFFECTS);
    return effects
      .map((effect) => ({ ...effect, resources: [...effect.resources] }))
      .sort(compareEffectInfo);
  }

  #effectConflicts(
    component: ManagedComponent,
    effects = this.#effects(component),
  ): FabricComponentEffectConflict[] {
    const summary = summarizeEffects(effects);
    const conflicts: FabricComponentEffectConflict[] = [];
    for (const other of this.#components.values()) {
      if (other === component) continue;
      for (const conflict of effectConflictsBetween(
        summary,
        summarizeEffects(this.#effects(other)),
      )) {
        conflicts.push({ withComponent: other.entry.id, ...conflict });
        if (conflicts.length >= 64) break;
      }
      if (conflicts.length >= 64) break;
    }
    return conflicts.sort((left, right) =>
      left.withComponent.localeCompare(right.withComponent) ||
      left.reason.localeCompare(right.reason) ||
      left.resources.join("\0").localeCompare(right.resources.join("\0")),
    );
  }

  #effectEnvironmentDigest(component: ManagedComponent): string {
    const environment = [...this.#components.values()]
      .filter((other) => other !== component)
      .sort((left, right) => left.entry.id.localeCompare(right.entry.id))
      .flatMap((other) => {
        const effects = this.#effects(other);
        return effects.length > 0
          ? [{ id: other.entry.id, guarantee: other.guarantee, effects }]
          : [];
      });
    return stableJsonHash(environment);
  }

  #assertEffectCapacity(component: ManagedComponent, additional = 0): void {
    if (component.guarantee !== "revertible") return;
    const count = (component.scope?.footprint(MAX_COMPONENT_EFFECTS + 1).length ?? 0) +
      component.actionEffects.length + additional;
    if (count > MAX_COMPONENT_EFFECTS) {
      throw new Error(
        `Revertible Fabric component ${component.entry.id} exceeds ${MAX_COMPONENT_EFFECTS} tracked effects`,
      );
    }
  }

  #assertIndependent(
    component: ManagedComponent,
    effects: readonly FabricComponentEffectInfo[],
  ): void {
    const conflicts = this.#effectConflicts(component, [...effects]);
    if (conflicts.length === 0) return;
    throw new FabricComponentIndependenceError(
      `Revertible Fabric component ${component.entry.id} has non-independent effects: ` +
      conflicts.map((conflict) =>
        formatFabricEffectConflict(
          conflict.withComponent,
          conflict.resources,
          conflict.reason,
        )
      ).join("; "),
    );
  }

  #invocationContext(component: ManagedComponent): FabricInvocationContext {
    const base = this.options.invocationContext?.() ?? defaultInvocationContext();
    return {
      ...base,
      parentToolCallId: `component:${component.entry.id}:${component.revision}`,
      nestedToolCallId: `component:${component.entry.id}:${component.revision}`,
    };
  }

  #info(
    component: ManagedComponent,
    projectedEffects?: FabricComponentEffectInfo[],
    projectedConflicts?: FabricComponentEffectConflict[],
  ): FabricComponentInfo {
    const effects = projectedEffects ?? this.#effects(component);
    const effectConflicts = component.guarantee === "revertible"
      ? projectedConflicts ?? this.#effectConflicts(component, effects)
      : [];
    return {
      id: component.entry.id,
      component: component.definition.name,
      ...(component.parentId ? { parentId: component.parentId } : {}),
      state: component.state,
      guarantee: component.guarantee,
      revision: component.revision,
      requirements: component.requirements.map((requirement) => requirement.ref),
      provisions: [...component.provisions],
      missing: [...component.missing],
      optionalMissing: [...component.optionalMissing],
      effects,
      ...(effectConflicts.length > 0 ? { effectConflicts } : {}),
      ...(component.state === "active" && component.modelGuidance.length > 0
        ? { guidance: component.modelGuidance.map(fabricModelGuidanceInfo) }
        : {}),
      ...(component.viewLease?.view?.digest
        ? { targetDigest: component.viewLease.view.digest }
        : {}),
      ...(component.error ? { error: component.error } : {}),
      ...(component.cleanupErrors
        ? { cleanupErrors: [...component.cleanupErrors] }
        : {}),
      createdAt: component.createdAt,
      updatedAt: component.updatedAt,
    };
  }

  #cycles(edges: FabricComponentGraph["edges"]): string[][] {
    const adjacent = new Map<string, string[]>();
    for (const edge of edges) {
      const targets = adjacent.get(edge.from) ?? [];
      targets.push(edge.to);
      adjacent.set(edge.from, targets);
    }
    const cycles = new Map<string, string[]>();
    const visit = (node: string, path: string[], positions: Map<string, number>): void => {
      const position = positions.get(node);
      if (position !== undefined) {
        const cycle = path.slice(position);
        const rotations = cycle.map((_, index) => [
          ...cycle.slice(index),
          ...cycle.slice(0, index),
        ]);
        rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
        const canonical = rotations[0]!;
        cycles.set(canonical.join("\0"), canonical);
        return;
      }
      if (path.length > this.#components.size) return;
      const nextPositions = new Map(positions).set(node, path.length);
      for (const target of adjacent.get(node) ?? []) {
        visit(target, [...path, node], nextPositions);
      }
    };
    for (const id of this.#components.keys()) visit(id, [], new Map());
    return [...cycles.values()].sort((left, right) =>
      left.join("\0").localeCompare(right.join("\0")),
    );
  }

  #selfLifecycleStop(id: string): boolean {
    const frame = componentLifecycleStorage?.getStore();
    return frame?.supervisor === this && frame.componentId === id;
  }

  #assertLifecycleCallAllowed(operation: string): void {
    const frame = componentLifecycleStorage?.getStore();
    if (!frame || frame.supervisor !== this) return;
    throw new Error(
      `Cannot ${operation} from ${frame.phase} transition ${frame.componentId}`,
    );
  }

  #require(id: string): ManagedComponent {
    const component = this.#components.get(id);
    if (!component) throw new Error(`Unknown Fabric component: ${id}`);
    return component;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Fabric component supervisor is closed");
  }

  #emit(componentId?: string): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(componentId);
      } catch {
        // Lifecycle observers cannot affect component ownership.
      }
    }
  }
}
