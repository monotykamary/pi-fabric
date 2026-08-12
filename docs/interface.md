# Interface & commands

Fabric's UI is built on the public `pi-code-previews` cooperative shell and a general-purpose, theme-aware activity surface. Users do not need to install `pi-code-previews` separately.

## Code previews

`fabric_exec` inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing without taking ownership of Pi's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase/call activity, and compact phase/nested-call summaries. Preview settings live in the unified Fabric configuration: the `codePreview` section of `~/.pi/agent/fabric.json` (global) or `.pi/fabric.json` (trusted project), editable live under `/fabric settings` → **Code previews**. The standalone `code-previews.json` file and `codePreview` keys in Pi settings are no longer read. `codePreview.shikiTheme` defaults to `"auto"`, which tracks Pi's resolved light/dark variant (GitHub Light on light terminals, Dark+ on dark) as Pi auto-switches; `"<light>/<dark>"` pins both variants, and any other value fixes one shiki theme.

Nested `pi.read`/`pi.bash`/`pi.grep`/`pi.find`/`pi.ls`/`pi.write`/`pi.edit` calls use the same preview settings and presentation vocabulary as `pi-code-previews`: offset-aware read gutters, syntax and secret warnings, grouped/highlighted grep matches, iconized path trees, bash warnings and output metadata, and proposed/applied edit or overwrite diffs with compact context, line gutters, full-row backgrounds, and word-level emphasis. Large inputs fall back to escaped plain text with an explicit notice. The same layer renders in-memory Activity call details. Rich call data is retained only in current-session renderer/activity state; durable traces keep their existing bounded confidentiality projection.

Fabric keeps its orchestration-specific behavior around those previews. Multi-call rows remain compact, live write composition and phase/call progress remain visible, and agent/actor audits can expose their current child tools directly in the parent card with owner, runner, and run metadata. One execution-wide throttle coalesces parallel nested-call updates before they reach Pi without starving continuous streams. Long ANSI rows are bounded without clearing the enclosing tool background, and the widget lease plus result-to-source row transfer continue stabilizing completion height. The highlighter initializes lazily, falls back to plain text until ready, and swaps themes live when Pi switches between its light and dark variants. Collapsed previews use the configured expand keybinding (for example `Ctrl-O`).

## Activity surface

Fabric owns a general-purpose, theme-aware activity surface for any agent setup:

- A compact widget above the chat (like `pi-supervisor`) follows the current phase in its header and lists active/completed one-shot agents plus active actor workers. Their recent or running child tools are nested beneath the owner with compact edit/write change lines and owner metadata. Extensions, custom items, and shared tasks/state remain summarized by the header or available in the dashboard instead of occupying widget rows. The widget retains completed agent rows and a per-run high-water height so tool finalization does not pull the chat upward, resets that lease when a newer run starts, and keeps the latest completed summary visible until that newer run replaces it. Snapshot bounds preserve every active local agent, then local history, before admitting remote project records. When a collapsed Fabric result becomes shorter at completion, the card reveals a bounded number of otherwise-hidden TypeScript source lines to replace those rows without blank padding; any residual deficit shrinks naturally.
- `/fabric` (or `/fabric dashboard`) opens a responsive interactive overlay with two views: **Activity** and a unified **Topology**. `1` opens Activity and `2` opens Topology.
  - **Activity** places the workflow phase sidebar on the left and the selected phase's activity on the right. The user-facing Pi agent is always present as **Main**, including when no Fabric child exists and regardless of the status filter, so it remains an actionable queue target. The right pane orders entities under type headings for agents, actors, tools, extensions, tasks, custom items, and shared state, with a blank row between groups. Selectable and rendered group order are identical, while one-shot agents remain stable in creation order; attention-priority work keeps default focus instead of Main stealing it.
  - **Topology** combines the selected retained run with the live project mesh in one graph rooted at **Main**. It deduplicates agents observed through both run and participant data, then separates execution membership from coordination infrastructure:

    ```text
    Main
    ├─ Participants
    │  ├─ Sessions       peers and remote root Pi sessions
    │  ├─ Agents         local, remote, and recursively owned agents
    │  └─ Actors         local and remote persistent actors
    └─ Mesh
       ├─ Topics
       │  ├─ Fabric      fabric.state, fabric.schema, and fabric.<family>.*
       │  └─ Project     arbitrary topics grouped by their first namespace
       └─ State
          ├─ World state
          │  ├─ current
          │  ├─ goal
          │  └─ Complexity
          │     └─ <project directories> → <file ledger>
          ├─ Schema
          │  ├─ workspace
          │  ├─ Hypotheses → <id>
          │  ├─ Certificates → <token hash>
          │  └─ <future schema namespaces>
          └─ Project state
             └─ <key directories> → <entry>
    ```

    Explicit ownership remains intact below those categories: recursive agents stay beneath parents, actor workers stay beneath actors, and remote descendants stay beneath their remote root. State ownership is a mesh relationship rather than structural parentage, so owned state remains in the State tree. State entries that identify a project-relative file (including every `state/complexity/<file>` ledger) expose a bounded, line-numbered Shiki source preview in both the topology inspector and full dashboard detail. Preview resolution rejects absolute paths, traversal, symlink escapes, non-files, and binary content, and caches by real path, mtime, and size. Internal membership/control keys (`topology/*`, legacy `sessions/*`, and actor registry `actors/*`) are filtered from shared state because their canonical entities already appear under Participants. Global actor templates are absent because they are not running project nodes.
  - Topic names accept `.`, `:`, and `/`; `fabric.*` topics use the Fabric branch, while every other name uses Project topics and its first namespace. Built-in host traffic includes `fabric.actor.*`, `fabric.control.*`, `fabric.participant.lifecycle`, `fabric.steer`, and `fabric.compact`; system-only topics remain suppressed as standalone nodes unless explicitly subscribed, while their traffic can still appear in the bounded event feed. State keys preserve `/` hierarchy. Known durable families are `state/current`, `state/goal`, `state/complexity/<file>`, `schema/workspace`, `schema/hypothesis/<id>`, and `schema/certificate/<hash>`; every other visible mesh key falls back to Project state without losing its directory structure.
  - The graph uses status-coloured node shapes, orthogonal connectors, animated traffic, an optional fixed-width selected-node inspector, and directional off-canvas summaries. Traffic follows the same structural branches through the source/target lowest common ancestor instead of drawing direct lines through unrelated subtrees. Large or deeply recursive graphs open around the attention-priority node. Moving between nodes retargets a damped spring camera instead of snapping the viewport; live/replay animation drives renders only while the dashboard is open. Narrow terminals retain the centred graph without the inspector.
  - Retained-run selection remains a lens rather than a separate topology. `[`/`]` changes the highlighted run and its phase context without hiding live actors or remote project participants. Route records remain selectable and aggregate repeated traffic by source, target, topic, and kind; the recent event feed is a bounded live window, not an audit-history replacement.
  - **Inspection and control** are shared across views. Agent detail includes Markdown-rendered task/results, highlighted YAML values, model, current tool, usage, worktree, and attach metadata. Tool-call details show highlighted command/file/edit inputs and Markdown or YAML outputs; persisted bash calls retain their command text. Space peeks at an agent or actor transcript and `t` toggles summary/transcript detail. The initial bounded tail is paged directly from Pi RPC, Pi session, and Claude stream-JSON logs; `k`/Up at the loaded top fetches one older page, `g` loads and jumps to the true beginning, and `G` jumps to the growing tail and resumes follow mode. Assistant text uses native Markdown, while tool calls retain structured arguments/results for the same read/bash/search/edit/write previews used by the parent card. Credential/token redaction applies before rendering. Main and active one-shot agents can be steered or queued a follow-up; one-shot agents can also be safely stopped. Persistent actors accept `s` mailbox messages and expose model (`m`), thinking (`e`), the complete session-bound Pi host-event catalog (`v`), instructions (`i`), mailbox clearing (`c`), and export (`x`) where configured. Remote participants expose only advertised capabilities; control resolves their owner and reports success after acknowledgement. Global templates remain available from Activity for import (`p`), instruction editing (`i`), and deletion (`d`).
- `/fabric settings` opens an inline settings view that mirrors Pi core's `/settings` (top and bottom borders, fuzzy search, section submenus) and writes changes to `fabric.json`. Trusted projects default to `<project>/.pi/fabric.json`; **Ctrl+G** switches both the displayed configuration layer and save destination anywhere in the view between project and global `~/.pi/agent/fabric.json`. The global view keeps global edits visible even when a project override remains effective, and its scope banner makes that precedence explicit. Untrusted sessions remain global-only. Full code mode, capture, executor, approvals, and UI changes apply immediately when they change the effective configuration; mesh, agent, retention, and MCP changes persist and take effect on the next `/fabric reload`. The UI section includes a default-on **Nested tool calls** toggle and a global **Nested tool debounce** (`0`/Off through `1000ms`, default `100ms`); both apply immediately. The Agents section selects the default runner, keeps independent Pi and runtime-enumerated Claude model pickers, and exposes free-text Veda backend, persona, and model fields for the Veda runner. List editors for `agents.defaultTools` and `capture.keepVisible` toggle known tools on and off; `keepVisible` candidates include `fabric_exec` plus every captured extension tool.

### Keybindings

- In `/fabric settings`, **Ctrl+G** switches the displayed values and save destination between project overrides and global defaults; untrusted sessions remain global-only.
- `1` opens Activity and `2` opens the unified Topology. In Topology, arrow keys move spatially between graph nodes, `h`/`l` mirror left/right, `j`/`k` follow deterministic entity order, and Tab advances to the next node. In Activity, arrows or Tab switch panes and select rows. `g`/`G` jump to the first/last selectable entity, Enter inspects, `f` cycles status filters, `[`/`]` change the retained-run lens, and `?` opens contextual help.
- On Main, `s` sends a user-authored message/steer and `u` queues a user-authored follow-up through Pi's host queue.
- On agents and actors, Space peeks at the transcript and `t` toggles transcript/summary detail; inside a transcript, `g` loads/jumps to the true top and `G` jumps to the bottom and follows new output. On active one-shot agents, `s` opens a steer editor, `u` queues a follow-up, and pressing `x` twice stops the run. Remote participants expose capability-aware, owner-acknowledged `s`/`u`/`x` controls.
- On actors, `s` queues a serial mailbox message, `m` changes the model, `e` thinking, `v` host events, and `i` instructions; `x` exports to global, `p` imports a global template, `d` deletes one, and Esc backs out or closes.

## Data-driven activity

The surface is data-driven. Fabric automatically instruments nested provider calls, agents, persistent actors, and task-shaped mesh entries. A workflow can add domain-specific labels and arbitrary progress without adding extension UI code:

```ts
await workflow.configure({ name: "Release train", description: "Build, verify, and publish" });
await phase("Build", { total: packages.length });
await workflow.item({
  id: "docs",
  label: "Documentation",
  status: "running",
  completed: 2,
  total: 5,
});
await workflow.event({ message: "Canary passed", level: "success" });
```

External Fabric providers can emit structured `context.activity()` updates for an entity, progress message, or metrics. This keeps the TUI generic while allowing a virtual provider to expose richer live state.

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Commands

```text
/fabric status
/fabric dashboard
/fabric settings
/fabric reload
/fabric providers
/fabric captured [query]
/fabric agents
/fabric actors
/fabric messages <actor-id>
/fabric attach <agent-id>
/fabric stop <actor-or-agent-id>
```

Actor slash commands mirror the [global template API](agents.md#global-actor-templates): `/fabric global` lists templates, `/fabric import <name> [as <new>]` stamps one into the project, and `/fabric export <id> [--overwrite]` promotes a project actor. `/fabric log <id>` previews an actor or run transcript; `/fabric export-log <id> [path]` writes the raw `session.jsonl` plus retained `runs/` to disk.

## Headless focused agents

Pi already runs one-shot, non-interactive agents with `pi -p` (`--print`), and it reads piped stdin as part of the prompt — so a focused agent composes with pipes, cron, git hooks, and CI like a Unix program, with no wrapper needed:

```bash
git diff | pi -p --no-session -t read,grep "Review this diff for concrete defects."
pi -p --no-session --mode json -e <path-to-pi-fabric> "Map the persistence layer."
```

`--no-session` keeps the run ephemeral, `-t` restricts the tool allowlist, `--mode json` emits a structured event stream for scripting (`| jq`), and `-e <pi-fabric>` loads Fabric so the agent can use `fabric_exec`. The process exits non-zero on failure. See `pi --help` for the full flag list.
