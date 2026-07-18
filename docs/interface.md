# Interface & commands

Fabric's UI is built on the public `pi-code-previews` cooperative shell and a general-purpose, theme-aware activity surface. Users do not need to install `pi-code-previews` separately.

## Code previews

`fabric_exec` inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing without taking ownership of Pi's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase/call activity, and compact phase/nested-call summaries.

Nested `pi.read`/`pi.bash`/`pi.grep`/`pi.find`/`pi.ls`/`pi.write`/`pi.edit` calls render as structured previews (path/command headers, numbered content) instead of raw JSON. `pi.read` and `pi.write` content is syntax-highlighted with the same shiki theme configured for `pi-code-previews`, so colors match Pi's native tool previews; `pi.bash` commands are highlighted in the call title and `pi.edit` operations render as a `+`/`-` line diff (with shared context) using Pi core's diff colors. The highlighter initializes lazily and falls back to plain text until ready. Collapsed previews show the configured expand keybinding (e.g. `Ctrl-O`) to expand, matching Pi's built-in tool previews.

## Activity surface

Fabric owns a general-purpose, theme-aware activity surface for any agent setup:

- A compact widget above the chat (like `pi-supervisor`) follows the current phase and shows one highest-priority activity type at a time, so agent rows are not mixed with custom items, tools, shared tasks, or actors. Its header still summarizes the full run, and it disappears after ordinary runs become quiet while persistent actors remain visible as a compact ambient fallback.
- `/fabric dashboard` opens a responsive interactive overlay with the workflow phase sidebar on the left and the selected phase's activity on the right. The right pane omits the redundant selected-phase heading and orders entities under type headings for agents, actors, tools, extensions, tasks, custom items, and shared state, with a blank row between groups. The selectable entity order is identical to the rendered group order, while agents remain stable in creation order. Agent rows prioritize attention and summarize current work, errors, or results. Agent detail includes Markdown-rendered task and result fields, highlighted YAML for structured result values, model, current tool, usage, worktree, and attach metadata. Tool-call details show highlighted command/file/edit inputs and Markdown or YAML outputs, matching the nested preview renderers; persisted bash calls retain and display their command text. Press Space on an agent for a live transcript peek, or press `t` in its detail to switch between summary and transcript. The bounded ring-buffer transcript renders Pi RPC and Claude stream-JSON assistant text with Pi's native Markdown treatment while keeping tool activity as compact one-line markers; common credential fields and token shapes are redacted from tool previews. Oldest activity rolls off the top, scrolling pauses follow mode, and `G` resumes it. One-shot agent model and thinking settings are fixed when spawned, but selected agents can be steered, given a queued follow-up, or safely stopped from the dashboard. Persistent actors are editable: select an actor to see the available shortcuts, then press `m` for its model, `e` for thinking (reasoning effort), `v` for host events, or `i` for its default instruction. Model/thinking changes persist to the actor registry and take effect on the actor's next run; the model picker uses Pi's registry for Pi actors and Claude's runtime catalog for Claude actors, and Inherit falls back to that runner's Fabric/runtime default. Actor mailboxes, mesh state, recent mesh events, and global actor templates use the same view rather than role-specific screens. Press `x` to export a project actor to the global library, `p` to import a global template as a fresh project actor, or `d` to delete a global template.
- `/fabric settings` opens an inline settings view that mirrors Pi core's `/settings` (top and bottom borders, fuzzy search, section submenus) and writes changes to `fabric.json`. Trusted projects write to `<project>/.pi/fabric.json`; untrusted sessions write to the global `~/.pi/agent/fabric.json`. Full code mode, capture, executor, approvals, and UI changes apply immediately; mesh, subagent, and MCP changes persist and take effect on the next `/fabric reload`. The Subagents section selects the default runner and keeps independent Pi and runtime-enumerated Claude model pickers. List editors for `subagents.defaultTools` and `capture.keepVisible` toggle known tools on and off; `keepVisible` candidates include `fabric_exec` plus every captured extension tool.

### Keybindings

- `↑`/`↓` or `j`/`k` select, `←`/`→`, `h`/`l`, or Tab switch between the phase sidebar and activity pane, Enter focuses or drills into details, `f` cycles status filters, `[` selects an older retained run, `]` a newer one, and `?` opens contextual help.
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
