# Components, effects, and committed capabilities

Pi Fabric adds a supervised component plane above the registry, where a **provider** exposes actions and a **component** declares exact requirements. Components can mount providers inside an effect scope that Fabric can unwind. Before each model run, an **actor** may commit the same type of capability view. The [component calculus](component-calculus.md) defines the lifecycle laws and author duties, with a [provider specialization](provider-component-calculus.md) for first-party namespaces and rolling replacement.

## Architectural fit

The core square shows this flow:

```text
component definition ──activate──▶ owned effects + staged providers
        │                                │
        │ requires exact refs            │ commit only after activation
        ▼                                ▼
live provider catalog ──resolve──▶ committed capability view
```

Reload preserves the corresponding observable path:

```text
old component ──dispose dependents/effects──▶ retired provider generation
      │                                             │ retained until quiescent
      │ replacement succeeds                        ▼
      └────────────────────────────────────▶ new provider generation
```

The square commutes when every consumer sees one complete provider generation, old or new, and never a half-mounted set. Provider bindings carry versions. A stale lease identifies one specific versioned binding identity. A retiring generation stays callable for views that already committed to it, and it closes only after its owner, its dependent views, and its in-flight calls release it. Transition epochs stop a late-settling activation from resurrecting after retirement.

These parts add the missing control plane above `ActionRegistry`. The existing data, state, actor, and execution planes stay in place:

- `ActionRegistry` routes capabilities and enforces policy.
- `FabricComponentSupervisor` owns lifecycle and effect scopes.
- `FabricComponentLoader` reconciles declarative entries and catalog revisions transactionally.
- `components.*` exposes lifecycle diagnostics and reload control.
- An actor can declare `requires` and receives a closed-world view with a portable descriptor digest for every run.

## Built-in provider components

The component loader pins each enabled first-party action surface:

```text
fabric.provider.pi
fabric.provider.extensions
fabric.provider.mcp
fabric.provider.mesh
fabric.provider.state
fabric.provider.schema
fabric.provider.compact
fabric.provider.cache
fabric.provider.agents
fabric.provider.memory
fabric.provider.jev
```

Each component preserves its existing provider namespace, including calls such as `memory.recall` and `schema.commit`. Calls through `agents.run` or `mcp.$servers` retain the same descriptors and policy path. The kernel keeps `components.*` as the service that controls the graph.

User configuration reconciliation retains pinned entries whose IDs stay reserved, and the host reserves the `fabric.provider.*` definition prefix across eager registration and discovery. Configuration gates select `pi`, `extensions`, `mesh`, `state`, and `memory`.

`components.reload({ id: "fabric.provider.memory" })` follows this replacement order:

1. Retire the old binding.
2. Let committed calls settle on that generation.
3. Stage the candidate binding through activation.
4. Publish the candidate after commit.

Candidate failure starts restoration of the prior definition. The component status records a failed restoration.

Catalog replacement uses the same path. A newer definition revision rolls every enabled instance of that definition, including pinned and configured entries.

## Registering a component

Registration is versioned. Like an external provider, a component may arrive through an eager event or answer a discovery handshake:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  FABRIC_COMPONENT_REGISTER_EVENT,
  type FabricComponentDefinition,
  type FabricComponentDiscovery,
} from "pi-fabric/protocol";

export default function extension(pi: ExtensionAPI) {
  const component: FabricComponentDefinition<{ prefix?: string }> = {
    name: "issue-observer",
    description: "Maintains an issue observation service",
    requires: ["github.subscription", { ref: "memory.recall", optional: true }],
    provides: ["issues"],
    guarantee: "revertible",
    async activate(context, config) {
      const client = await context.acquire<Client>("github.subscription", {
        query: `${config.prefix ?? ""} is:open`,
      });

      context.provide({
        name: "issues",
        description: "Current issue observations",
        async list() { return descriptors; },
        async describe(name) { return descriptors.find((item) => item.name === name); },
        async invoke(name, args) { return client.call(name, args); },
        async close() { await client.close(); },
      });

      return () => stopObserver();
    },
  };

  pi.events.emit(FABRIC_COMPONENT_REGISTER_EVENT, {
    version: 1,
    component,
    overwrite: true,
  });

  pi.events.on(FABRIC_COMPONENT_DISCOVER_EVENT, (discovery: FabricComponentDiscovery) => {
    discovery.register(component, { overwrite: true });
  });
}
```

Registering a definition name again with `overwrite: true` marks the HMR boundary. Fabric restarts every configured instance of that definition through the rollback-capable replacement path. If candidate activation fails and its cleanup succeeds, Fabric restores the prior definition. Fabric quarantines the instance whenever that cleanup fails. The status makes no claim that rollback succeeded.

## Declarative instances

Declare instances at the root of `fabric.json`:

```json
{
  "components": [
    {
      "id": "project-issues",
      "component": "issue-observer",
      "config": { "prefix": "repo:owner/project" }
    },
    {
      "id": "optional-observer",
      "component": "another-definition",
      "disabled": true
    }
  ]
}
```

A definition may arrive after the configuration that references it. The unresolved instance stays `waiting` and lists `component:<name>` in `missing`. Component discovery activates the instance later. Once the runtime is active, trusted configuration edits reconcile automatically; `/fabric reload` is not required. When a later activation fails during a multi-entry reconciliation, Fabric rolls back the additions and replacements from that pass. Two live component records may never declare the same provider name. Fabric rejects the insertion or replacement before it disturbs either fiber.

### External connectors

Connector packages own their component definitions, provider schemas, transports, credentials, and model-facing guidance. Fabric has no connector-specific registration table or required UI action vocabulary. Install the connector's ordinary Pi extension: it registers through `FABRIC_COMPONENT_REGISTER_EVENT` and answers `FABRIC_COMPONENT_DISCOVER_EVENT`. Configure it with the same generic `components.describe` / `plan` / `apply` surface used by every other component. A configured but undiscovered definition remains `waiting`; configuration never imports arbitrary modules on its own. These generic extension contracts remain available, but existing browser/macOS CLIs do not require a component bridge; see [harness CLI composition and migration](harnesses.md).

### Live configuration control

Components are generic host primitives. Connector packages own browser, desktop, application, and transport behavior; neither component management nor Jev needs a built-in tool for each integration. Register the definition through the ordinary extension protocol, then configure instances through the same live control plane.

A definition may declare `configSchema`, using the same JSON Schema validation engine as tool arguments. Fabric validates config before activation or replacement, including direct supervisor calls. Schema defaults are annotations, not injected values. Without a schema, legacy definitions keep their activation-time validation. `components.describe` returns the schema even when no instance exists; it is a configuration contract, not a connectivity or health check. Effective tool grants are still obtained from the mounted provider's action descriptors.

```ts
const definition = await components.describe({ component: "issue-observer" });
const plan = await components.plan({
  entries: [{ id: "issues", component: definition.name, config: { prefix: "repo:owner/project" } }],
});
// Inspect plan.changes, warnings, and sources before applying. Normal approvals still apply.
await components.apply({ ...plan.request, expectedRevision: plan.revision });
```

- `entries` upserts complete entries by ID; it does not replace unrelated entries or merge nested config. `remove` removes IDs. An ID may occur only once in one request.
- Scope defaults to `session`: no file is written. Session overlays survive file reconciliation and settings saves; they end on runtime/session reload or shutdown. `reset: ["issues"]` in session scope removes an overlay and restores the file-configured value. A session removal masks that ID until reset. The session layer is limited to 256 overrides, including removal masks; the effective manifest is also limited to 256 entries.
- Explicit `scope: "global"` or `"project"` persists only the component array in that layer, preserving unrelated settings. Project arrays shadow global arrays, just like normal configuration. Plans report shadowing; persistent writes do not implicitly clear session overlays. Project writes require current project trust and never silently fall back to global.
- Plans report a revision, declared requirements/provisions, sources, and warnings without running component activation. Apply revalidates and rejects stale revisions after concurrent changes. Missing definitions can be configured and remain waiting. A successful apply may therefore return waiting instances; inspect their status before use.
- Apply runs the loader transaction before persistence. A failed activation leaves disk untouched. A failed compare-before-write triggers runtime compensation, without overwriting the external edit. Failed compensation is reported, never claimed successful. This is not an atomic transaction across multiple processes, files, or remote effects.
- `components.reconcile()` re-reads trusted files without reinitializing Fabric. The active runtime also watches both file paths (250 ms stat interval, 50 ms debounce), including file creation, deletion, and atomic replacement. Content revisions suppress redundant reconciliation. The watcher reads only trusted layers and never repairs or quarantines malformed live files. Invalid edits retain the last applied state and appear in `components.list().configuration.error` and the UI. Its watchers and timers stop with the owning runtime.
- Before first use, bootstrap stays idle: no watcher imports optional engines or starts connectors. First use rereads component configuration. Activation does not imply that a connector has connected or requested OS permissions; connector packages own explicit, lazy acquisition and health reporting.
- `components.list().configuration` reports source paths, trust, selected layers, session override IDs, and warnings. An untrusted project file is reported as ignored without parsing it. Diagnostics report provenance, not raw configuration documents; activation errors remain author-supplied.
- Apply/reconcile are host-control operations, unavailable to committed guest views and in managed hosts or Schema enforce mode. Existing approval and schema policy gates still apply. Built-in `fabric.provider.*` components cannot be changed by this configuration API; their existing reload control remains separate.

Replacement uses the existing retire-before-activate path, not zero-downtime migration. New calls resolve the new generation after commit; unrelated providers and Jev runs are not restarted. Existing committed views may continue using the retired generation until release. Removal uses the same **drain** policy, not immediate security revocation. Owners must retain supporting connections/processes until provider `close()`. Connector session IDs and observed handles must not be silently moved between generations. Cancellation after activation begins does not abandon commit/compensation and cannot undo already-issued external effects.

The host protocol exports `FabricComponentChangeRequest` and `FabricComponentChangePlan` types. Guest provider declarations expose all four new methods; newly mounted namespaces can be called immediately through `tools.call({ref,args})` in the same program. This avoids assuming a new static proxy existed when that program was typechecked.

## Model-facing guidance components

A component can contribute bounded system guidance without adding model-specific prose to Pi Fabric itself. The component repository remains an ordinary Pi extension package: its small extension entry registers the definition through `FABRIC_COMPONENT_REGISTER_EVENT` and the discovery handshake shown above. Install that entry through Pi's normal package mechanism, place it in `~/.pi/agent/extensions/` for all projects, or place it in `.pi/extensions/` for one project. Put only the declarative instance in that project's `fabric.json`:

```json
{
  "components": [
    {
      "id": "deepseek-guidance",
      "component": "deepseek-guidance"
    }
  ]
}
```

Configured components activate eagerly, before the first model turn. A standalone package can therefore contain only its registration bridge and component definition:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  FABRIC_COMPONENT_REGISTER_EVENT,
  FABRIC_EXECUTION_GUIDANCE_SLOT,
  type FabricComponentDefinition,
  type FabricComponentDiscovery,
} from "pi-fabric/protocol";

const component: FabricComponentDefinition = {
  name: "deepseek-guidance",
  description: "DeepSeek-specific Fabric execution guidance",
  guarantee: "revertible",
  activate(context) {
    context.guide({
      label: "deepseek-execution-profile",
      models: ["deepseek/deepseek-*"],
      targets: ["main", "participant"],
      placement: "replace",
      slot: FABRIC_EXECUTION_GUIDANCE_SLOT,
      content: `Use explicit, compact Fabric calls. Keep dependent reads and edits sequential.
Inspect a failed nested result before retrying with changed arguments.`,
    });

    context.guide({
      label: "deepseek-provider-notes",
      models: ["deepseek/deepseek-*"],
      targets: ["main", "participant"],
      content: "Prefer described provider refs over guessed action names.",
    });
  },
};

export default function extension(pi: ExtensionAPI) {
  pi.events.emit(FABRIC_COMPONENT_REGISTER_EVENT, {
    version: 1,
    component,
    overwrite: true,
  });
  pi.events.on(FABRIC_COMPONENT_DISCOVER_EVENT, (discovery: FabricComponentDiscovery) => {
    discovery.register(component, { overwrite: true });
  });
}
```

`context.guide()` accepts these fields:

- `label`: a stable label unique within that component instance.
- `models`: one or more canonical `provider/model` globs. `*` and `?` are supported; matching is case-sensitive. Guidance does not apply when the target model is unknown.
- `targets`: `main`, `participant`, or both. Omitting it selects both.
- `content`: the model-visible text.
- `placement`: `append` by default, or `replace` for a named slot.
- `slot`: required for `replace` and forbidden for `append`.

`FABRIC_EXECUTION_GUIDANCE_SLOT` (`fabric.execution`) is Pi Fabric's replaceable execution profile. Replacing it removes the built-in examples, provider-navigation hints, and other tunable execution prose for matching model turns. It does **not** replace the small Fabric kernel, active Schema gate, selected-skill references, or live core-override contracts. This lets users swap the upstream profile without weakening the host invariants that describe the actual tool surface. Two active components may not win by load order: if both replace the same slot for one model and target, that model launch fails with a conflict naming both registrations.

Append contributions are ordered by component ID and label, not activation timing. Each registration is a transactional, commutative component effect. It becomes visible only when activation commits, disappears immediately when unload begins, rolls back on activation failure, and can be removed early through the disposer returned by `context.guide()`. A component may register at most 64 entries, each entry is capped at 32,000 characters, and its combined guidance is capped at 64,000 characters. One supervisor accepts at most 1,024 registrations and 1,000,000 stored guidance characters; one resolved prompt projection is capped at 64,000 characters. Status reports selectors, placement, character count, and a content hash. It omits the prompt text.

### Prompt-cache and cold-prefill behavior

[Prompt-cache observations and scoped warming](prompt-cache.md) expose runtime interest separately from the stable prompt projection described here.

With an unchanged host prompt, skill catalog, model, target, Fabric mode, core-override catalog, and committed component projection, Fabric emits a byte-identical system prompt. Slot order is fixed, append entries sort by component ID and label, and no component revision, timestamp, run ID, message ID, or projection hash enters the model-visible text. Fabric appends its stable sections in this order: kernel, resolved slots, Schema notice, core-override guidance, and component appends. Turn-derived skill dependency guidance comes last. A turn that adds such guidance therefore retains the ordinary turn's complete system prompt as its cacheable prefix. Turn-derived guidance stays in a transcript message and does not mutate that system prefix.

Participant task text and actor message envelopes remain user content. They are not interpolated into component guidance. Direct runs with the same role prompt, selected model, and committed guidance receive the same Fabric append-system prompt even when their tasks differ. Persistent actors keep a stable actor system prompt across mailbox activations; an actor identity or binding change intentionally creates a different prefix.

Component authors control the remaining cache behavior:

- Keep `content` deterministic. Do not embed clocks, random values, current message data, run IDs, or session-local diagnostics unless every turn needs a new prefill.
- Narrow `models` and `targets` so unrelated models and participants do not pay the cold-prefill cost.
- Prefer replacing `FABRIC_EXECUTION_GUIDANCE_SLOT` when a model-specific profile supersedes the default. Appending both profiles spends context and prefill on duplicate advice.
- Keep large guidance stable after activation. Reloading, disposing, or re-registering content intentionally invalidates the changed suffix while leaving the preceding host and Fabric kernel prefix reusable.

A provider may still choose not to cache, may impose a minimum cacheable token count, or may scope caches by API key and model. Fabric preserves reusable prefix structure; it cannot guarantee a provider cache hit.

Propagation depends on the participant kind:

- The main Pi process resolves the complete execution slot and appends matching additions on every turn, so model switches take effect without reloading the component.
- A non-recursive agent or actor keeps its role/instructions and receives matching `participant` append guidance after them. Slot replacements are ignored because that child has no Pi Fabric execution profile to replace. Role routers that dispatch through `agents.run`, `agents.spawn`, or `agents.create` already supply the selected canonical model on those requests, so matching occurs after route selection and leaves the routed role text first.
- A recursive Pi agent loads Pi Fabric and the same project/package components. It resolves the complete `participant` slot in its own `before_agent_start` hook; the parent deliberately does not append guidance again.
- A durable agent or actor resolves append guidance in its resident owner. The main process writes each committed projection atomically, and an already-running resident host rereads the latest snapshot before every launch.

This propagation is a prompt projection, not an authority grant. Guidance components gain no provider access unless they declare it through `requires`, and their model text cannot widen a participant's tools, committed capability view, Schema policy, or approval boundary. Component extension code itself remains trusted host code.

## Exact requirements and committed views

`requires` accepts `provider.action` strings or `{ ref, optional: true }`. Fabric resolves each present action to:

- the exact provider binding ID and generation.
- the action descriptor hash, which covers the input/output schema, the risk, and the effect metadata.
- a runtime-local digest that changes when the provider is replaced.
- a portable semantic digest that child actor runtimes can check.

The view is closed-world. A call outside the view fails even when the live registry gains that action later. Fabric also rejects a call when the descriptor of a pinned action changes in place. A missing optional ref lets activation proceed. That ref stays absent from the view, so calls to it fail.

When a dependency disappears, or when its generation or descriptor target changes, the supervisor retires the providers and unloads the dependent components first. It then unwinds effects in LIFO order, releases the old view, and reconciles against the new target.

## Effects and guarantees

Every activation runs inside a `FabricEffectScope`:

- `context.effect(setup, labelOrOptions)` records one or more disposers that the setup returns or yields.
- `context.defer(disposer, labelOrOptions)` records a disposer that already exists.
- the options may declare `label`, `kind`, `resources`, and `ordering` for lifetime-independence checks.
- `context.defer()` describes an effect that already happened, so a rejected emission registration stays recorded long enough for rollback to invoke its disposer.
- `context.acquire(ref, args)` requires `effect.kind: "scoped"`, and it records the provider's single-shot disposer automatically.
- `context.guide(definition)` stages model guidance as a transactional registration effect and returns an early-unregister disposer.
- Fabric treats the value returned by `activate()` as an effect result too.
- a setup failure rolls back the effects already installed.
- a target change diverts generators at yield boundaries, after an asynchronous step lands and before its stale continuation resumes.
- on unload, Fabric requests `context.signal` cancellation before it awaits the in-flight transition. Cleanup and state publication still wait for that transition to settle.
- disposal is asynchronous, runs in LIFO order, and is idempotent.
- Fabric aggregates cleanup failures and moves the component into the `quarantined` state.

`guarantee: "managed"` puts every effect registered through this API under Fabric's management. `guarantee: "revertible"` adds restrictions the runtime can enforce. Every provided service implements `close()`, and all scoped actions go through `context.acquire()`. Ordinary calls may carry only `none` or `transactional` effects. Each installed lifetime footprint must stay pairwise independent from the other installed component effects under the declared resource relation. Fabric rejects emissions, whether component code invokes them as actions or registers them directly. Ambient side effects that component code performs behind Fabric's back sit outside both guarantees. Component extensions run as trusted host code.

Action descriptors carry effect metadata:

```ts
effect: {
  kind: "none" | "scoped" | "transactional" | "emission",
  resources: ["optional:resource-identity"],
  ordering: "commutative" | "ordered" | "unknown"
}
```

When a descriptor omits this metadata, Fabric normalizes it conservatively. A `read` risk becomes commutative `none`, and any other risk becomes an unknown-order `emission`. Missing resource identities normalize to `*`, the top/unknown footprint. An unknown noncommutative footprint conflicts with every effect. Shared named resources commute only when both declarations say `commutative`. On a `revertible` component, a plain string label stays conservative until the author supplies explicit resources and ordering. These declarations are author witnesses, and the runtime accepts them as claims it cannot prove.

`[*] (unknown resource footprint)` in an error or dashboard describes effect metadata; it grants no wildcard capability or tool access. Fabric-owned provider holders use `fabric:provider:<name>:holder`, which keeps framework bookkeeping disjoint from unrelated component effects. Changing a component to `managed` suppresses strict independence rejection. Choose that guarantee when advisory independence is intended. Treat an unexplained `*` as missing metadata to investigate.

## Parent-owned components

A component may install another supervised component as a registration effect:

```ts
const child = context.use(workerDefinition, {
  id: "worker",
  config: { queue: "reviews" },
});
```

The child receives the global ID `<parent>.<local-id>` and reports `parentId`. In every other way it behaves like any component. It resolves its own committed view and can provide services. If the child fails, the parent and siblings keep running. `context.use()` is a synchronous registration operation available only while `activate()` runs. Child activation begins after the parent transition finishes, so parent activation must never wait for child readiness. When the parent unloads, Fabric retires the descendants and their dependents before it runs the parent's own inverse. Calling `child.stop()` is identity-safe and idempotent. Parent cleanup still completes eventually, even after the child record is gone. Ownership by itself grants no capabilities. A component receives capabilities only through its own `requires` list. Each parent may own at most 256 live children, and one supervisor may host at most 1,024 fibers.

Never call or await supervisor or loader lifecycle operations from component activation or teardown closures. Such a call would wait on the transition that is running the closure. Fabric rejects the call to prevent a queue deadlock. When a component asks to stop itself, Fabric folds that request into the current retirement transition. Use `context.use()` for child registration, and run unrelated orchestration outside lifecycle callbacks.

## Actor commitments

A persistent actor accepts the same exact requirement syntax:

```ts
await agents.create({
  name: "release-watcher",
  instructions: "Watch releases and report actionable changes.",
  events: ["turn_end"],
  requires: ["mcp.github.latest_release", { ref: "memory.recall", optional: true }],
});
```

Before each run, the host acquires a committed view and retains it. It sends the resolved refs and the portable semantic digest to the Pi child. The child resolves the refs on its own. It rejects a digest mismatch, and it pins every `fabric_exec` call to that closed-world view. Actor status and run metadata record the requirements and the digest. When a requirement is unavailable at run time, that mailbox activation stays queued and the actor reports `missingCapabilities`. Provider or catalog changes retry the activation. The retry never widens authority silently. Non-Pi runners still receive host-side commitment checks. Only recursive Pi actors have a Fabric guest surface that enforces the commitment inside the child.

## Diagnostics

```ts
const all = await components.list();
const one = await components.status({ id: "project-issues" });
const graph = await components.graph();
await components.reload({ id: "project-issues" });
```

The dashboard renders components in a separate topology group. It draws exact requirement-to-provision edges and cycle paths, and it keeps component lifecycle separate from participant ownership. Managed components expose bounded effect evidence, and their status stays free of strict conflict warnings. Fabric reserves `effectConflicts` for fibers that opted into the `revertible` guarantee. When mesh lifecycle delivery is enabled, Fabric also publishes each changed state as an attributed `component.state` event with bounded identity and state metadata. That delivery stays observational and never drives local correctness.

The states are `waiting`, `loading`, `active`, `unloading`, `failed`, `quarantined`, and `disposed`. A status response includes parent ownership, missing and optional requirements, provisions, model-guidance selectors and content hashes, up to 256 effect-evidence records, strict non-independence diagnostics, revision, target digest, activation error, and cleanup failures. The graph reports requirement-to-provider dependency edges, parent ownership edges, and dependency cycles. A programmatic supervisor may force-remove a quarantined record with `stop(id, { force: true })`. Force removal deletes the registry record. It makes no claim that leaked ambient state was recovered.
