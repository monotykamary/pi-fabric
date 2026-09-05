<div align="center">

# 🧵 pi-fabric

**A programmable tool and agent runtime for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_One type-checked program for tools, MCP, agents, workflows, actors, mesh, councils, and recursion._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fabric/main/media/banner.svg" alt="Animated banner: one checked TypeScript program weaving pi core tools, MCP servers, agents, and mesh into a single result" width="100%">
</p>

[![npm version](https://img.shields.io/npm/v/pi-fabric?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-fabric)
[![ARC-AGI-3 scorecard](https://img.shields.io/badge/ARC--AGI--3-100%25%20across%2025%20envs-16a34a?style=for-the-badge)](https://arcprize.org/scorecards/d4c56c67-136b-4643-b648-62ae28fe2a54)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-fabric/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-fabric/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

<p align="center">
  🏆 <strong><a href="https://arcprize.org/scorecards/d4c56c67-136b-4643-b648-62ae28fe2a54">100% on ARC-AGI-3</a></strong>. A Fabric-powered agent won <strong>all 25 environments</strong> in one 22.4-hour session with 4 minutes of human time ($1,349 in model spend).
</p>

</div>

---

Fabric gives Pi one programmable tool called `fabric_exec`, which composes core tools and MCP servers with captured extension tools in a checked TypeScript program. That program can call agents or actors, use durable coordination, and run inside QuickJS. Trusted workloads that exceed WASM32 memory may use the unsafe Node process. After execution, the conversation receives the result of the program's branches, loops, fan-out, and data flow.

## Why Fabric?

|     | Capability | What it unlocks |
| :-: | ---------- | --------------- |
| ⚡ | **Code mode** | One flat tool schema; branching, loops, fan-out, and data flow live in checked TypeScript. |
| 🧰 | **Capability routing** | Call Pi core tools, MCP servers, captured extension tools, or Fabric providers through one runtime. |
| 🧑‍🤝‍🧑 | **Agent runtime** | One-shot workers, durable resident agents, persistent event-driven actors, councils, and bounded recursive queries. |
| 🕸️ | **Workflows + mesh** | Phased progress plus durable topics, shared tasks, and compare-and-swap state. |
| 🛡️ | **Guardrails** | Approvals, isolation, timeouts, concurrency, recursion depth, and shared cost budgets. |
| 🎛️ | **Native TUI** | Live activity, an interactive dashboard, and settings without leaving Pi. |

## How it works

1. **You ask** in plain language.
2. **Pi writes one program** that calls the required tools and agents.
3. **The type checker validates the program** before execution.
4. **The result returns** to your conversation. Intermediate work stays in the sandbox and appears in the activity panel and dashboard.

The model can write this program:

```ts
const [manifest, sources] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.find({ pattern: "**/*.ts", path: "src" }),
]);
return {
  package: JSON.parse(manifest).name,
  sourceCount: sources.split("\n").filter(Boolean).length,
};
```

Independent calls run in parallel, and the returned object enters the model context. Known providers support concise direct calls such as `mcp.fal_ai.get_model_schema(...)`, `memory.recall(...)`, `state.get()`, `schema.status()`, and `compact.status()`. Refs found or computed at runtime use `tools.call({ ref, args })`.

## Install

Requires Node.js 24+ and Pi 0.80.6+. Fabric also checks a detectable Pi host version at startup and warns when an older host may ignore continuation APIs such as actor `triggerTurn`.

```bash
pi install npm:pi-fabric
```

<details>
<summary>Other install methods</summary>

From GitHub:

```bash
pi install git:github.com/monotykamary/pi-fabric
```

From a local checkout:

```bash
pnpm install
pnpm build
pi install /absolute/path/to/pi-fabric
```

For one development run:

```bash
pi -e /absolute/path/to/pi-fabric
```

</details>

## What you can ask for

Pi loads advanced patterns after direct user invocation. Run `/skill:fabric-guide` for one recommendation, or invoke the exact `/skill:<name>` yourself. An ordinary coding task keeps Pi on the core `fabric-exec` path.

| You want | Run |
| -------- | --- |
| Help choosing the smallest advanced mechanism | `/skill:fabric-guide Choose a mechanism to audit every auth file and verify the findings.` |
| Parallel audits, migrations, or research with verification | `/skill:fabric-workflow Audit every auth file and synthesize verified findings.` |
| Work too big for one context window | `/skill:fabric-rlm Produce a compact architecture map of this repo.` |
| A persistent watcher for one measurable goal | `/skill:fabric-supervisor Watch this migration until it is complete and tested.` |
| A strict auditor for one feature design spec | `/skill:fabric-spec Implement docs/specs/checkout.md to the tee; nothing missing, nothing extra.` |
| A quiet decision-point reviewer | `/skill:fabric-advisor Focus on migration correctness.` |
| Same-model independent reviewers and one decision | `/skill:fabric-council Review this design for correctness, security, and operability.` |
| Multi-model compare-not-merge deliberation or act mode | `/skill:fabric-fusion Deliberate this design across models.` |
| One command that chooses advisor or supervisor | `/skill:fabric-ambient advisor Focus on migration correctness.` |
| A durable team coordinating through versioned tasks | `/skill:fabric-swarm Coordinate this migration across owned task partitions.` |
| Evidence-gated edits with postconditions | `/skill:fabric-schema Make this parser change only if focused tests stay green.` |

The foundation is the `fabric-exec` reference skill: the model loads it before its first `fabric_exec` call and again when a call errors on argument shape.

## Agent conversations

Press **Ctrl+Shift+A** or run **`/fabric chat <agent-id-or-name>`** to open a live, full-screen child conversation with a multiline editor. Send steering or follow-ups directly, switch between nested agents, and return to Main without stopping its work. Drafts and scroll positions stay with each conversation. Completed one-shot agents are read-only; persistent actors accept further messages. See [focused conversations](docs/interface.md#focused-conversations) for controls and current limitations.

## The dashboard

Fabric includes a live activity surface in Pi:

- A compact widget above the chat (like `pi-supervisor`) whose header follows the current phase while its rows show active/completed agents, active actors, and their recent nested tool or code-change activity.
- `/fabric` (or `/fabric dashboard`): opens the **Activity** and **Topology** views. The user-facing Pi session appears as **Main**. You can queue or steer participants and inspect the project topology.
- `/fabric settings`: mirrors Pi's `/settings` and writes changes to `fabric.json`. TUI hosts get the searchable settings component; RPC hosts get the same nested sections, value/input/model pickers, list editors, and project/global save scopes through native dialog primitives.
- `Tool display` (`compact` by default, or `full`) is configured under `/fabric settings` → **UI**; compact elevates the declared display intent, hides the outer TypeScript, and applies to the current transcript immediately. Pi's tool-expand keybinding (`ctrl+o` by default) expands a compact card to the full transcript.

See the [interface & commands reference](docs/interface.md) for every view, keybinding, and slash command.

## Reference

- [Configuration](docs/configuration.md): `fabric.json`, code modes, tool capture, approvals, and budgets.
- [Memory & recall](docs/memory-recall.md): compact ranked hits, uniform follow calls, lossless expansion, and guest-local `memory.walk` computation.
- [Interface & commands](docs/interface.md): dashboard, settings, keybindings, slash commands, and headless runs.
- [Agents, actors & mesh](docs/agents.md): model handoff, `/fabric prewalk`, runners, transports, actors, councils, recursive queries, and durable coordination.
- [Durable residency through Pi](docs/residency-runtime.md): background host lifecycle and the Pi-runtime launcher boundary.
- [Components & committed capabilities](docs/components.md): supervised effects, exact requirements, external per-model guidance and execution-profile replacement, rolling provider generations, actor commitments, and both formal calculi.
- [External providers](docs/providers.md): the versioned provider protocol for extensions.
- [Architecture & security](docs/architecture.md): the host bridge, sandboxing, tool-call robustness, and limits.
- [Catalog repairs](docs/repairs.md): unique extra keys and unknown actions promoted into silent schema maps.
- [Tool entropy](docs/entropy.md): the deterministic entropy meter, on-demand session measurement, reduction proposals, the autonomous compile loop with its ratchet gate, and `certify:entropy`.
- [Speculative PTC](docs/speculation.md): pre-launching literal read calls while the program streams, with epoch + freshness guarantees.
- [Skills](docs/skills.md): the core-first invocation policy and user-invoked advanced patterns.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The test suite covers:

- configuration and schema validation
- provider dispatch, registered-tool execution, QuickJS isolation, and Pi built-in calls
- agent fixtures for Claude and Veda
- workflows, durable mesh state, actor mailboxes, subscriptions, and actor restoration

Claude and Veda fixtures use local test processes with zero billable requests.

## Acknowledgments

- Thanks to [@hazrid93](https://github.com/hazrid93), whose request for a token-efficient LLM advisor pattern led to Fabric's advisor.
- Thanks to Chad Gibson at [Neuralwatt](https://neuralwatt.com), who supported extended tests of long MCR sessions and the related debugging work.

## License

MIT
