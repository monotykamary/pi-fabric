# Interface & commands

Fabric's UI is built on the public `pi-code-previews` cooperative shell and a general-purpose, theme-aware activity surface. Users do not need to install `pi-code-previews` separately.

## Code previews

`fabric_exec` inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing without taking ownership of Pi's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase/call activity, and compact phase/nested-call summaries.

Nested `pi.read`/`pi.bash`/`pi.grep`/`pi.find`/`pi.ls`/`pi.write`/`pi.edit` calls render as structured previews (path/command headers, numbered content) instead of raw JSON. `pi.read` and `pi.write` content is syntax-highlighted with the same shiki theme configured for `pi-code-previews`, so colors match Pi's native tool previews; `pi.bash` commands are highlighted in the call title and `pi.edit` operations render as a `+`/`-` line diff (with shared context) using Pi core's diff colors. The highlighter initializes lazily and falls back to plain text until ready. Collapsed previews show the configured expand keybinding (e.g. `Ctrl-O`) to expand, matching Pi's built-in tool previews.

## Activity surface

Fabric owns a general-purpose, theme-aware activity surface for any agent setup:

- A compact widget above the chat (like `pi-supervisor`) follows the current phase in its header and lists only active or completed workers from the `agents` provider. Nested tools, extensions, custom items, shared tasks/state, and actors remain summarized by the header or available in the dashboard instead of occupying widget rows. The widget retains completed agent rows and a per-run high-water height so tool finalization does not pull the chat upward, resets that lease when a newer run starts, and keeps the latest completed summary visible until that newer run replaces it. When a collapsed Fabric result becomes shorter at completion, the card reveals a bounded number of otherwise-hidden TypeScript source lines to replace those rows without blank padding; any residual deficit shrinks naturally.
- `/fabric dashboard` opens a responsive interactive overlay with two top-level views: **Activity** and **Topology**. Topology contains **Run** and **Project mesh** child views. `1` opens Activity, `2` opens Topology on Run, `3` opens Topology on Project mesh, and `r` toggles Activity and Topology · Run.
  - **Activity** places the workflow phase sidebar on the left and the selected phase's activity on the right. The right pane orders entities under type headings for agents, actors, tools, extensions, tasks, custom items, and shared state, with a blank row between groups. Selectable and rendered group order are identical, while agents remain stable in creation order; attention-priority rows summarize current work, errors, or results.
  - **Topology · Run** is the full-width, phase-grouped agent hierarchy for the selected retained run. It connects recursive children to their parents and keeps completed recursive leaves from a bounded in-memory status snapshot after nested run directories are cleaned, until the parent is cleaned up or the Fabric session shuts down. Large runs stay centered on the selected agent and replace omitted regions with directional summaries of hidden, active, blocked, and failed nodes while preserving phase and ancestor context.
  - **Topology · Project mesh** is independent of retained run selection. It roots the live project at the main session, then maps persistent actors and their host-event/delivery configuration, transient agents observed in mesh traffic, project topics and subscriber edges, shared-state ownership, and normalized recent event routes. Route rows aggregate repeated traffic by source, target, topic, and kind; this is a bounded live window, not an audit-history replacement. The two-row recent mesh-event feed remains reserved above the footer, including when it has fewer events, so switching views does not collapse the dashboard. Global actor templates are intentionally absent because they are not live project nodes. Topics and routes are selectable and have read-only detail views; actors retain their normal controls.
  - **Inspection and control** are shared across views. Agent detail includes Markdown-rendered task/results, highlighted YAML values, model, current tool, usage, worktree, and attach metadata. Tool-call details show highlighted command/file/edit inputs and Markdown or YAML outputs; persisted bash calls retain their command text. Space peeks at a live agent transcript and `t` toggles summary/transcript detail. The bounded ring buffer renders Pi RPC and Claude stream-JSON assistant text with native Markdown, compact tool markers, and credential/token redaction; scrolling pauses follow mode and `G` resumes it. One-shot agents can be steered, queued a follow-up, or safely stopped. Persistent actors expose model (`m`), thinking (`e`), host events (`v`), instructions (`i`), mailbox clearing (`c`), and export (`x`) where configured. Global templates remain available from Activity for import (`p`), instruction editing (`i`), and deletion (`d`).
- `/fabric settings` opens an inline settings view that mirrors Pi core's `/settings` (top and bottom borders, fuzzy search, section submenus) and writes changes to `fabric.json`. Trusted projects write to `<project>/.pi/fabric.json`; untrusted sessions write to the global `~/.pi/agent/fabric.json`. Full code mode, capture, executor, approvals, and UI changes apply immediately; mesh, subagent, and MCP changes persist and take effect on the next `/fabric reload`. The Subagents section selects the default runner and keeps independent Pi and runtime-enumerated Claude model pickers. List editors for `subagents.defaultTools` and `capture.keepVisible` toggle known tools on and off; `keepVisible` candidates include `fabric_exec` plus every captured extension tool.

### Keybindings

- `1` opens Activity; `2` and `3` enter the Topology parent on Run and Project mesh respectively. `r` toggles Activity and Topology · Run. Inside Topology, `←`/`→`, `h`/`l`, or Tab switches its Run/Project mesh child view; in Activity those keys switch panes. `↑`/`↓` or `j`/`k` select, `g`/`G` jump to the first/last selectable node, Enter focuses or inspects, `f` cycles status filters, `[`/`]` move through retained runs in Activity or Run topology, and `?` opens contextual help.
- On one-shot agents, Space peeks at the live transcript, `t` toggles transcript/summary detail, `s` opens a steer editor, `u` queues a follow-up, and pressing `x` twice stops an active run.
- On actors, `m` changes the model, `e` thinking, `v` host events, and `i` instructions; `x` exports to global, `p` imports a global template, `d` deletes one, and Esc backs out or closes.

## Data-driven activity

The surface is data-driven. Fabric automatically instruments nested provider calls, subagents, persistent actors, and task-shaped mesh entries. A workflow can add domain-specific labels and arbitrary progress without adding extension UI code:

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
/fabric attach <subagent-id>
/fabric stop <actor-or-subagent-id>
```

Actor slash commands mirror the [global template API](agents.md#global-actor-templates): `/fabric global` lists templates, `/fabric import <name> [as <new>]` stamps one into the project, and `/fabric export <id> [--overwrite]` promotes a project actor. `/fabric log <id>` previews an actor or run transcript; `/fabric export-log <id> [path]` writes the raw `session.jsonl` plus retained `runs/` to disk.

## Headless focused agents

Pi already runs one-shot, non-interactive agents with `pi -p` (`--print`), and it reads piped stdin as part of the prompt — so a focused agent composes with pipes, cron, git hooks, and CI like a Unix program, with no wrapper needed:

```bash
git diff | pi -p --no-session -t read,grep "Review this diff for concrete defects."
pi -p --no-session --mode json -e <path-to-pi-fabric> "Map the persistence layer."
```

`--no-session` keeps the run ephemeral, `-t` restricts the tool allowlist, `--mode json` emits a structured event stream for scripting (`| jq`), and `-e <pi-fabric>` loads Fabric so the agent can use `fabric_exec`. The process exits non-zero on failure. See `pi --help` for the full flag list.
