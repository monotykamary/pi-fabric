// Static detection lets Fabric start known orchestration programs with the
// longer subagent deadline. The runtime also extends the deadline when a
// blocking agent ref is discovered dynamically through tools.call(), so
// computed and aliased refs cannot fall back to the short executor timeout.
const BLOCKING_ORCHESTRATION_REFS = new Set([
  "agents.run",
  "agents.wait",
  "agents.ask",
]);

export const isBlockingOrchestrationRef = (ref: string): boolean =>
  BLOCKING_ORCHESTRATION_REFS.has(ref);

// Match the documented direct entry points as call sites (a trailing "("),
// tolerating a single-level generic argument such as
// agent<{ items: string[] }>(...). Read-only and non-blocking agents.* calls
// are intentionally excluded because they do not wait for a child turn.
const ORCHESTRATION_RE =
  /\b(?:workflow\.agent|agents\.(?:run|wait|ask)|council\.run|rlm\.query)\s*\(|(?<!\.)\bagent\s*(?:<[^<>]*>)?\s*\(/;

export const codeUsesOrchestration = (code: string): boolean =>
  ORCHESTRATION_RE.test(code);
