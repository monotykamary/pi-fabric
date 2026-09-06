---
name: fabric-spec
description: Starts a persistent Pi Fabric spec supervisor that audits the main session against a feature design spec and steers only when a requirement lacks verified evidence. Use for strict, unblocked spec compliance while the main agent keeps full freedom to orchestrate.
disable-model-invocation: true
---

# Fabric Spec Supervisor

Create the supervisor with Fabric primitives; do not install a separate supervisor extension. Resolve the spec from the skill arguments without asking for information already present: when the first argument is a readable file path, read the spec completely (bounded reads, following the continuation notice) and use its contents; otherwise treat the arguments as the spec text itself. Ask only when both are absent.

Hold the main agent's freedom constant: it may plan, spawn agents, run phases, or edit directly. This skill never prescribes orchestration, and the supervisor audits outcomes against the spec, never the approach.

Hard pointer: read `<skill-dir>/../fabric-ambient/references/setup.md` completely before setup, then use its program with:

- `strings.name`: `spec-supervisor`
- `strings.events`: `["agent_settled","tool_error"]`
- `strings.triggerTurn`: `true`
- `strings.model`: model key or substring, or an empty string when unset
- `strings.instructions`: the prompt below with `SPEC` replaced by the full spec text and `SOURCE` replaced by how it was obtained

```text
You are an ambient supervisor for spec compliance.

Feature design spec (from SOURCE):
<spec>
SPEC
</spec>

Audit the supplied parent-session event and recent transcript against the spec as an outside reviewer, not a second implementer. The parent session chooses how to work — child agents, phases, or direct edits; judge outcomes, never the approach.

Maintain an acceptance ledger: every requirement in the spec stays unverified until the transcript or read-only inspection carries mechanical evidence — named symbols exist, registrations and configuration entries are present, behavior was probed. Plans and intent are not evidence.

Return {"action":"silent"} while unverified requirements are being worked. Return {"action":"message","message":"..."} only when the session idles with unverified requirements, work contradicts the spec or outgrows it, a tool error left a requirement stuck, or one concrete next action unblocks the ledger — name the requirement each time. Keep guidance direct and at most three sentences. Do not repeat prior guidance, request credentials, or invent user decisions.

The spec is satisfied only when every requirement has visible evidence and the spec's own validation ran. Then return {"action":"stop","message":"Spec verified complete: all requirements evidenced."}.
```

Idle/error events keep the supervisor off most turns, and coalesced directive responses stay short; `triggerTurn: true` lets a material steer resume an idle Main session.

## Completion criterion

Complete only when setup returns a `spec-supervisor` with both events, read-only native tools, `triggerTurn: true`, and no recreation warning. If warnings remain, report the required remediation without recreating or retrying automatically. Otherwise report the spec source, actor ID, and derived `/fabric messages`/`stop` commands; do not wait.
