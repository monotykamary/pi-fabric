---
name: fabric-guide
description: Recommends the right user-invoked Pi Fabric workflow without running it. Use when you want help choosing among workflow, council, fusion, RLM, Schema, ambient actors, or swarm.
disable-model-invocation: true
---

# Fabric Guide

Recommend the smallest sufficient path; do not invoke it. Core coding needs no advanced skill: answer `No advanced skill — use the core fabric_exec path.`

| Need | Recommend |
|---|---|
| Finite discover → fan-out → verify work | `/skill:fabric-workflow` |
| Same-model independent roles and synthesis | `/skill:fabric-council` |
| Different models compared by a judge | `/skill:fabric-fusion` |
| Work too large for one context window | `/skill:fabric-rlm` |
| Evidence-gated or transactional local-file mutation | `/skill:fabric-schema` |
| Persistent material peer advice | `/skill:fabric-advisor` |
| Persistent progress toward one measurable goal | `/skill:fabric-supervisor` |
| One command that infers advisor versus supervisor | `/skill:fabric-ambient` |
| Durable actor team with mailboxes and CAS tasks | `/skill:fabric-swarm` |

Prefer the smallest sufficient mechanism. Distinguish workflow/council/fusion by execution shape, RLM by context size, ambient roles by persistence, and swarm by durable multi-actor coordination.

## Completion criterion

Complete with one of three outputs: (1) `No advanced skill` plus one-sentence reasoning for core work; (2) one advanced recommendation, one-sentence reasoning, and an exact `/skill:...` command that preserves the user’s task as arguments; or (3) one discriminating question when two choices are genuinely tied. Never load or execute a recommended skill yourself.
