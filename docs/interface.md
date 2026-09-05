# Interface & commands

Fabric builds its UI on the public `pi-code-previews` cooperative shell and on a general-purpose, theme-aware activity surface. You do not need to install `pi-code-previews` separately.

## Code previews

`fabric_exec` inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing. It does not take ownership of Pi's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase and call activity, and compact phase and nested-call summaries. Preview settings live in the unified Fabric configuration: the `codePreview` section of `~/.pi/agent/fabric.json` (global) or `.pi/fabric.json` (trusted project). You can edit them live under `/fabric settings` → **Code previews**. Fabric no longer reads the standalone `code-previews.json` file or the `codePreview` keys in Pi settings. `codePreview.shikiTheme` defaults to `"auto"`. That value tracks Pi's resolved light/dark variant (GitHub Light on light terminals, Dark+ on dark) as Pi auto-switches. A `"<light>/<dark>"` value pins both variants. Any other value fixes one shiki theme.

Nested `pi.read`, `pi.bash`, `pi.powershell`, `pi.grep`, `pi.find`, `pi.ls`, `pi.write`, and `pi.edit` calls share the preview settings and presentation vocabulary of `pi-code-previews`: offset-aware read gutters, syntax and secret warnings, grouped and highlighted grep matches, iconized path trees, bash warnings and output metadata, and proposed or applied edit and overwrite diffs with compact context, line gutters, full-row backgrounds, and word-level emphasis. Large inputs fall back to escaped plain text with an explicit notice. The same layer renders in-memory Activity call details. Fabric keeps rich call data only in current-session renderer and activity state. Durable traces keep their existing bounded confidentiality projection.

Fabric keeps its orchestration-specific behavior around those previews. Multi-call rows stay compact, and live write composition with phase/call progress stays visible during the run. Agent and actor audits can expose their current child tools directly in the parent card, with owner, runner, and run metadata. One execution-wide throttle coalesces parallel nested-call updates before they reach Pi, and continuous streams are not starved. Long ANSI rows are bounded without clearing the enclosing tool background. The widget lease plus result-to-source row transfer keep completion height stable. The highlighter initializes lazily and falls back to plain text until it is ready. When Pi switches between its light and dark variants, the highlighter swaps themes live. Collapsed previews use the configured expand keybinding, for example `Ctrl-O`.

## Focused conversations

Press **Ctrl+Shift+A** or run **`/fabric chat`** to open a full-screen conversation without going through the dashboard. `/fabric chat <id-or-name>` opens a specific agent or actor; Tab completes exact participant IDs, including nested agents. Ambiguous names or ID prefixes are rejected; use an exact participant ID to select the intended target. In the dashboard, **Shift+C** opens the selected participant.

The first implicit open prefers a currently active child over stale history; later opens remember a valid selection. The view keeps a lossless native Pi transcript and a multiline Pi editor together, independently of the dashboard’s bounded transcript projection. It uses Pi’s real user, assistant, thinking, tool, skill, custom-message, and summary components, including registered tool renderers such as `fabric_exec`, with complete tool details and native expansion behavior. User backgrounds and editor rules span the terminal width, with Pi's configured output padding, editor padding, and code-block indentation inside them. Markdown and tool previews use the configured Shiki theme. The footer below the editor shows the selected participant's directory, known branch, model, thinking level, and run-scoped token/cache/cost statistics. Unknown usage and context occupancy are marked explicitly; Main's statistics are never substituted. Breadcrumbs preserve `Main → child → grandchild` lineage. Main and other participants keep running: opening, navigating, and closing the view never calls Pi's session-replacement API or starts another worker. Selecting Main restores the original Pi conversation, including its editor. Child drafts and scroll positions survive switching targets and reopening the view for the lifetime of this Pi session.

| Control | Action |
| --- | --- |
| Enter | Send a steering message to the selected live participant |
| Follow-up key (Alt+Enter by default; Ctrl+Q on Windows) | Queue a follow-up for the selected participant |
| Shift+Enter | Insert a newline |
| Ctrl+N or `/agents` | Open the searchable participant picker |
| Alt+Left / Alt+Right at an empty editor | Navigate to parent / first child |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle conversations |
| Mouse wheel / configured Pi scroll keys | Scroll locally and fetch older history; prompt, line, and page jumps work in both TUI modes |
| End | Follow the latest output |
| Pi's tool-expand key (Ctrl+O by default) | Toggle tool details |
| `/stop` | Explicitly stop the selected participant after confirmation |
| Esc or `/back` | Return to Main without interrupting any agent |

Direct actor messages appear as normal user text, with paired RPC start/end events shown once. Session branches and compaction remain authoritative over overlapping RPC history. Native message errors remain visible. Use `/fabric log <id>` to inspect worker startup diagnostics. The widget advertises `Ctrl+Shift+A chat` only while an agent or actor is active, and removes the hint when work settles. The command and shortcut remain available for idle and historical conversations.

Pending messages use Pi’s native labels and spacing. When a compatible loaded `pi-queue-steer` provides `queue-steer:conversation-queue:request:v1`, the view uses its actual per-target queue, execution-outline widget, and inline editor. A stopped actor’s Alt+Enter input is parked for editing or explicit Enter release. Accepted sends remain visible until native delivery is observed; they cannot be retracted or edited locally. Queues stay isolated from Main and other targets, survive preview close/reopen within the session, and are cleared on session reset. Older queue-extension releases without the bridge use the native display.

Messages use the same ownership-aware route as `agents.steer` / `agents.followUp`. A failed delivery keeps the draft. Capability and lifecycle checks run again at dispatch, so a child that finishes while you type cannot silently receive a message in Main or be respawned. Persistent actors accept subsequent mailbox messages, including while idle. Finished one-shot runs remain readable but cannot continue; Veda one-shot runs do not support mid-run messaging. A remote participant without an accessible transcript shows an explicit transcript-unavailable notice.

This is a focused view over the existing worker, not a second native Pi runtime. Other Pi slash commands, shell shortcuts (`!`), and child extension dialogs are not routed through this view. Unsupported commands are rejected visibly, never forwarded to Main. Native image attachment and full command/extension parity require a separate worker attachment protocol. The existing dashboard retains model, actor-policy, and configuration controls.

## Activity surface

Fabric ships a general-purpose, theme-aware activity surface that works with any agent setup:

- A compact widget above the chat (like `pi-supervisor`) follows the current phase in its header. It lists active and completed one-shot agents plus active actor workers. Their recent or running child tools nest beneath the owner, with compact edit/write change lines and owner metadata. Extensions, custom items, and shared tasks/state stay summarized by the header or appear in the dashboard, so they never occupy widget rows. The widget retains completed agent rows and a per-run high-water height, which stops tool finalization from pulling the chat upward. It resets that lease when a newer run starts, and the latest completed summary stays visible until that newer run replaces it. Snapshot bounds first preserve every active local agent, then local history, and only then admit remote project records. When a collapsed Fabric result becomes shorter at completion, the card reveals a bounded number of otherwise hidden TypeScript source lines. Those lines replace the removed rows without blank padding, and any residual deficit shrinks naturally.
- `/fabric` (or `/fabric dashboard`) opens a responsive interactive overlay with two views: **Activity** and a unified **Topology**. Press `1` for Activity and `2` for Topology.
  - **Activity** lays out the workflow phase sidebar on the left and the selected phase's activity on the right. The user-facing Pi agent is always present as **Main**, including when no Fabric child exists and regardless of the status filter. Main remains an actionable queue target. The right pane orders entities under type headings for agents, actors, tools, extensions, tasks, custom items, and shared state, with a blank row between groups. The selectable order matches the rendered group order. One-shot agents stay stable in creation order. Attention-priority work keeps the default focus, so Main does not steal it.
  - **Topology** merges the selected retained run with the live project mesh in one graph rooted at **Main**. It deduplicates agents observed through both run and participant data, and it separates execution membership from coordination infrastructure:

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

    Explicit ownership stays intact below those categories. Recursive agents nest under their parents. Actor workers remain under their actor, and remote descendants keep their place under the remote root. State ownership uses a mesh relationship. Owned state remains in the State tree. A state entry that identifies a project-relative file (including every `state/complexity/<file>` ledger) exposes a bounded, line-numbered Shiki source preview in both the topology inspector and full dashboard detail. The preview resolver rejects absolute paths, traversal, symlink escapes, non-files, and binary content. It caches by real path, mtime, and size. Internal membership and control keys (`topology/*`, legacy `sessions/*`, and actor registry `actors/*`) are filtered from shared state, because their canonical entities already appear under Participants. Global actor templates are absent because they are not running project nodes.
  - Topic names accept `.`, `:`, and `/`. A `fabric.*` topic uses the Fabric branch. Every other name uses Project topics, grouped by its first namespace. Built-in host traffic includes `fabric.actor.*`, `fabric.control.*`, `fabric.participant.lifecycle`, `fabric.steer`, and `fabric.compact`. System-only topics stay suppressed as standalone nodes unless someone explicitly subscribes to them, and their traffic can still appear in the bounded event feed. State keys preserve `/` hierarchy. The known durable families are `state/current`, `state/goal`, `state/complexity/<file>`, `schema/workspace`, `schema/hypothesis/<id>`, and `schema/certificate/<hash>`. Every other visible mesh key falls back to Project state without losing its directory structure.
  - The graph renders status-coloured node shapes, orthogonal connectors, animated traffic, an optional fixed-width selected-node inspector, and directional off-canvas summaries. Traffic follows the same structural branches through the source/target lowest common ancestor. It never draws direct lines through unrelated subtrees. A large or deeply recursive graph opens around the attention-priority node. When you move between nodes, a damped spring camera retargets smoothly and the viewport does not snap. Live and replay animation drives renders only while the dashboard is open. Narrow terminals keep the centred graph and drop the inspector.
  - Retained-run selection works as a lens over the same topology. Pressing `[` or `]` changes the highlighted run and its phase context, and live actors and remote project participants stay visible. Route records remain selectable, and they aggregate repeated traffic by source, target, topic, and kind. The recent event feed is a bounded live window. It does not replace audit history.
  - **Inspection and control** work the same way in both views. Agent detail includes Markdown-rendered tasks and results, highlighted YAML values, model, current tool, usage, worktree, and attach metadata. Tool-call details show highlighted command, file, and edit inputs, with Markdown or YAML outputs. Persisted bash calls keep their command text. Space peeks at an agent or actor transcript. `t` toggles between summary and transcript detail. The initial bounded tail is paged directly from Pi RPC, Pi session, and Claude stream-JSON logs. At the loaded top, `k` or Up fetches one older page, `g` loads and jumps to the true beginning, and `G` jumps to the growing tail and resumes follow mode. Assistant text uses native Markdown. Tool calls retain structured arguments and results, so they get the same read, bash, search, edit, and write previews as the parent card. Credential and token redaction applies before rendering. You can steer Main and active one-shot agents or queue them a follow-up, and one-shot agents can also be stopped safely. Persistent actors accept `s` mailbox messages. Where configured, they expose model (`m`), thinking (`e`), the complete session-bound Pi host-event catalog (`v`), instructions (`i`), mailbox clearing (`c`), and export (`x`). Remote participants expose only their advertised capabilities. Control resolves their owner and reports success after acknowledgement. From Activity, global templates stay available for import (`p`), instruction editing (`i`), and deletion (`d`).
- `/fabric settings` opens an inline settings view that mirrors Pi core's `/settings`, with top and bottom borders, fuzzy search, and section submenus, and it writes changes to `fabric.json`. Trusted projects default to `<project>/.pi/fabric.json`. Pressing **Ctrl+G** anywhere in the view switches both the displayed configuration layer and the save destination between project and global `~/.pi/agent/fabric.json`. The global view keeps global edits visible even when a project override remains effective, and its scope banner states that precedence explicitly. Untrusted sessions stay global-only. In RPC hosts, the same hierarchy is exposed through recursive select/input dialogs; a root save-scope action replaces the Ctrl+G shortcut, while Back returns one section at a time. Full code mode, capture, executor, approvals, and UI changes apply immediately when they change the effective configuration. Mesh, agent, retention, and MCP changes persist and take effect on the next `/fabric reload`. The UI section includes **Tool display** (`full` by default or `compact`), a default-on **Agent tool preview** toggle, and a global **Update debounce** (`0`/Off through `1000ms`, default `100ms`); all apply immediately. Compact display makes the declared Fabric display name/description the card header, hides outer TypeScript at every expansion level, and retains bounded nested tool details. The Agents section selects the default runner, keeps independent Pi and runtime-enumerated Claude model pickers, and exposes free-text Veda backend, persona, and model fields for the Veda runner. List editors for `agents.defaultTools` and `capture.keepVisible` toggle known tools on and off. The `keepVisible` candidates include `fabric_exec` plus every captured extension tool.

### Keybindings

- In `/fabric settings`, **Ctrl+G** switches the displayed values and the save destination between project overrides and global defaults. Untrusted sessions remain global-only.
- Press `1` for Activity and `2` for the unified Topology. In Topology, arrow keys move spatially between graph nodes, `h`/`l` mirror left and right, `j`/`k` follow deterministic entity order, and Tab advances to the next node. In Activity, arrows or Tab switch panes and select rows. `g` and `G` jump to the first and last selectable entity, Enter inspects, `f` cycles status filters, `[`/`]` change the retained-run lens, and `?` opens contextual help.
- On Main, `s` sends a user-authored message or steer, and `u` queues a user-authored follow-up through Pi's host queue.
- On agents and actors, Space peeks at the transcript and `t` toggles transcript/summary detail. Inside a transcript, `g` loads and jumps to the true top, and `G` jumps to the bottom and follows new output. On active one-shot agents, `s` opens a steer editor, `u` queues a follow-up, and pressing `x` twice stops the run. Remote participants expose capability-aware, owner-acknowledged `s`, `u`, and `x` controls.
- On actors, `s` queues a serial mailbox message. Lowercase `m` and `e` change this Pi session's model and thinking. Uppercase `M` and `E` change the shared project defaults and appear only on the owner. Actor detail shows both layers, the effective values, and the live owner.
- Owner views also expose `v` for host events, `i` for instructions, and other shared actor settings. Passive views hide those controls but keep session bindings, messaging, reads, and `x` export. `p` imports a global template, `d` deletes one, and Esc backs out or closes.

## Data-driven activity

The surface is data-driven. Fabric automatically instruments nested provider calls, agents, persistent actors, and task-shaped mesh entries. A workflow can add domain-specific labels and arbitrary progress, and it needs no extension UI code:

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

External Fabric providers can emit structured `context.activity()` updates for an entity, a progress message, or metrics. The TUI stays generic, and a virtual provider can still expose richer live state.

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
/fabric chat [participant-id-or-name]
/fabric settings
/fabric reload
/fabric providers
/fabric captured [query]
/fabric agents
/fabric actors
/fabric messages <actor-id>
/fabric attach <agent-id>
/fabric stop <actor-or-agent-id>
/fabric repairs
/fabric entropy
```

Actor slash commands mirror the [global template API](agents.md#global-actor-templates). `/fabric global` lists templates. `/fabric import <name> [as <new>]` stamps one into the project. `/fabric export <id> [--overwrite]` promotes a project actor. `/fabric log <id>` previews an actor or run transcript, and `/fabric export-log <id> [path]` writes the raw `session.jsonl` plus retained `runs/` to disk.

## Headless focused agents

Pi already runs one-shot, non-interactive agents with `pi -p` (`--print`), and it reads piped stdin as part of the prompt. A focused agent composes with pipes, cron, git hooks, and CI like a Unix program, and it needs no wrapper:

```bash
git diff | pi -p --no-session -t read,grep "Review this diff for concrete defects."
pi -p --no-session --mode json -e <path-to-pi-fabric> "Map the persistence layer."
```

`--no-session` keeps the run ephemeral. `-t` restricts the tool allowlist. `--mode json` emits a structured event stream for scripting through `| jq`. `-e <pi-fabric>` loads Fabric so the agent can use `fabric_exec`. The process exits non-zero on failure. Run `pi --help` for the full flag list.
