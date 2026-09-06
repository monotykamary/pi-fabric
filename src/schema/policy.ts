const allowedEnforceRefs = new Set([
  "pi.read",
  "pi.grep",
  "pi.find",
  "pi.ls",
  "memory.recall",
  "memory.expand",
  "memory.sessions",
  "state.get",
  "state.history",
  "state.complexity",
  "mesh.self",
  "mesh.read",
  "mesh.members",
  "mesh.get",
  "mesh.list",
  "compact.status",
  "components.list",
  "components.status",
  "components.graph",
  "schema.status",
  "schema.hypothesize",
  "schema.verify",
  "schema.commit",
  "schema.abort",
]);

// Pure policy lookup: speculative eligibility must not emit authorization audits.
export const schemaRefAllowedInEnforce = (ref: string): boolean => allowedEnforceRefs.has(ref);
