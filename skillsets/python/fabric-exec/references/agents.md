# Agents and recursive queries — Python

Use native dictionaries and await host methods. Every call accepts one dictionary or keyword arguments. Discover exact optional fields with `await tools.describe(ref="agents.run")`. Advanced workflows are user-invoked; never load `/skill:fabric-council` or other advanced skills autonomously. All references in this tree target Python; sibling [mesh.md](mesh.md) covers coordination.

## One-shot children

`agents.run` returns a dictionary with id, runner, optional kernel, status, text, optional value/error, usage, turns, toolCalls and runnerSessionId. Check `status == "completed"` before relying on text/value; a returned failure status does not raise automatically. Structured schema output is in `value`.

```python
result = await agents.run(name="security-review", task="Review the current diff for concrete security defects. Do not edit files.", tools=["read", "grep", "find", "ls"])
return {"status": result["status"], "text": result["text"], "error": result.get("error")}
```

Request fields include task, name, runner, kernel, transport, model, persona, thinking, tools, timeoutMs, extensions, recursive, cwd, worktree, schema. Omit timeoutMs normally; per-call values below the configured agent timeout floor are ignored. Use top-level agentBudget for bounded calls; the Python guest has no callback-helper tokenBudget API. Host concurrency and settled-usage checks still apply.

- Pi children inherit Python and its configured backend, including recursive and alternate-cwd launches. Explicit child kernel selection changes only the child, never this invocation. Claude/Veda and extensions=False reject concrete Fabric kernels; omitted/inherit leaves their harness native. Do not hop interpreters to run this program.
- `runner` defaults to configured policy; Pi, Claude, and Veda are available. Only Pi supports recursion. Veda persona/model follow its backend; Claude keys come from `await agents.models(runner="claude")`.
- Pi models must resolve in the owner's visible registry. `await tools.models()` lists Pi models; `agents.models` uses the requested or configured runner. Use canonical keys; report unresolved/ambiguous choices rather than guessing.
- `tools` is a native allowlist, inherited by nested calls for extension-enabled full-code Pi children. Claude maps supported core tools to its native names. `extensions=False` disables Fabric, not ordinary tools.
- `cwd` is a real directory, relative to the caller or absolute; symlinks canonicalize. Invalid/non-directory paths fail without fallback. Leaf cwd does not grant project trust; Pi applies its own saved decisions. Recursive requests reject cwd.
- `worktree=True` creates a retained dedicated Git worktree in the selected repository. Verify canonical repository identity, never infer it from directory naming. Abort with zero changes on mismatch. Partition concurrent edit ownership; never edit shared files concurrently. Inspect and stop active work before cleanup; leave unrelated worktrees alone.
- `schema` requests validated structured output. `thinking` is configured/clamped reasoning effort.

`agents.spawn` returns a handle; `wait`, `status`, `stop`, and `cleanup` take its id. Detached runs notify Main on terminal completion by default; `wait` makes the run foreground and suppresses that notification. `residency="durable"` is a spawn-only opt-in to outlive Main, requiring trusted mesh and no Schema enforce.

```python
handle = await agents.spawn(task="Map the persistence layer.", tools=["read", "grep", "find", "ls"])
return await agents.wait(id=handle["id"])
```

`agents.list(scope="local")` lists local children; lineage/project include federated participants. Peer is reserved for another root Pi session: query `await agents.peers()` first, not children. `agents.self`, `members`, and `main` expose participant identity and capabilities. Cross-process steer/followUp/stop route through the authenticated owner and return after acknowledgment; do not publish control topics yourself. Prefer steering useful running children over destroying their context. Check status before steering a finished child.

## Lifecycle subscriptions

`agents.subscribe` takes exact from/to participant ids (`main` aliases the caller's root), events, delivery (steer/followUp), explicit triggerTurn, and optional once. subscriptions/unsubscribe list and remove routes. Events include pi.input, pi.agent_start, pi.agent_end, pi.turn_end, pi.agent_settled, pi.tool_error, pi.session_compact, and runner-neutral run.completed/failed/stopped/timed_out. pi.agent_settled means no retries/queued continuations remain, not permanent termination. Subscriptions start at the current cursor; crash recovery is at-least-once, so deduplicate effects by event id.

```python
peers = await agents.peers()
if not peers:
    return {"subscribed": False}
return await agents.subscribe({"from": peers[0]["id"], "events": ["pi.agent_settled"], "to": "main", "delivery": "followUp", "triggerTurn": True, "once": True})
```

## Persistent actors

`agents.create` returns an actor dictionary; runner and resolved kernel are fixed at creation. Pi actors are Fabric-equipped; native Claude actors use their own tools while the host manages mailboxes/events. Use `ask` for a blocking reply or `tell` for asynchronous mail. Neither switches the actor kernel. Durable residency requires trusted mesh and is unavailable in Schema enforce. Actor state can be session/private or project-shared; the authenticated owner serializes activations.

```python
return await agents.create(name="auth-supervisor", instructions="Watch until the auth migration is complete and tested. Prefer silence; emit a directive only for material drift, blockers, or verified completion.", events=["agent_settled", "tool_error"], responseMode="directive", delivery="steer", triggerTurn=True, coalesce=True, tools=["read", "grep", "find", "ls"])
```

- `responseMode="directive"` validates action silent/message/stop. `delivery` is mailbox/steer/followUp/nextTurn. Steer/followUp require explicit triggerTurn; mailbox/nextTurn reject True. Actors cannot escalate delivery themselves.
- `events` observe public Pi lifecycle events asynchronously; synthetic tool_error is supported. Observers cannot block/mutate the originating event. Host event images attach automatically, with credential-shaped fields redacted from persisted envelopes. Topics subscribe to durable mesh channels.
- `coalesce` defaults on. Native tool allowlists persist; an empty list disables optional tools, not Pi's host-required fabric_exec when extensions remain enabled.
- `setInstructions`, `setTools`, `setEvents`, `setDeliveryPolicy` update future activations. Model/thinking use per-call override → session binding → project default → configured default. `setModel`/`setThinking` default to session scope; project defaults require owner authority.
- `actors`, `actorStatus`, `messages`, and `log` inspect state/history. `remove` deletes through the owner. Use discovered schemas for scope and bounded history options; avoid transcript dumps.
- Python must not supply guest callback predicates (`validWhile`, handoff predicates); those are not native Python host-call functions. Use supported host fields and explicit checks instead.

## Recursive work and handoff

Use `await agents.run(task="...", runner="pi", recursive=True)` only for oversized context; plain children handle bounded leaves. Host maxDepth (0 disables spawning), approvals, concurrency, and budget limits remain active. Recursion delegates agent risk only, not filesystem/network/execute permissions. Keep durable context in mesh keys or project-relative files plus digests, not whole-corpus child prompts.

`agents.handoff` without a predicate schedules an explicit Pi-to-Pi trajectory handoff at the completed outer fabric_exec boundary; later calls in the program still run. It is not a subroutine result. Use host schemas and a canonical target model; no Python guest predicate callbacks. Preserve successful effects rather than retrying the original program blindly.
