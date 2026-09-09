// Action-name repair for Fabric registry resolution, mirroring the
// argument-shape repair architecture in src/providers/arg-normalization.ts:
//
// 1. The registry resolve stage canonicalizes near-miss action spellings
//    (memory.search → memory.recall) before the provider descriptor is
//    demanded. The repair surface is mostly derived from the provider's
//    declared action names rather than maintained by hand. Exact casing and
//    separator forms and unique authored synonyms authorize repair; plural,
//    prefix, token-alignment, and edit-distance matches only suggest names.
// 2. The resolution failure tier owns the didactic failure: ambiguous or
//    unmatched names fail with the closest declared candidates named, and
//    the original "Unknown Fabric action" prefix is preserved.
//
// As with KEY_SYNONYM_CLASSES in arg-normalization, only genuinely semantic
// verb synonyms need explicit vocabulary, and a spilled name repairs only
// when exactly one declared member fits: ambiguity (or absence) leaves the
// name untouched so the failure tier can enumerate the honest choices.

interface ActionNameRepair {
  /** Canonical declared action name when exactly one candidate fits. */
  repaired?: string;
  /** Ranked declared candidates for the didactic failure message. */
  suggestions: string[];
}

// Verb/concept classes shared across the stable providers. Each class mixes
// plausible spilled verbs with the canonical names providers actually
// declare, so e.g. "search" repairs to memory.recall (sole recall-class
// member declared by memory) while "fetch" on mesh stays ambiguous between
// mesh.get and mesh.read. A class only fires when exactly one member is
// declared by the target provider's catalog.
const ACTION_SYNONYM_CLASSES: ReadonlyArray<ReadonlyArray<string>> = [
  // memory.recall and its spilled search verbs.
  ["recall", "search", "find", "query", "lookup", "grep", "scan", "locate"],
  // memory.expand / read-one-entry verbs.
  ["expand", "get", "read", "fetch", "load", "view", "show"],
  // memory.sessions and list-style catalog reads.
  ["sessions", "list", "ls", "enumerate", "index"],
  // state.transition / mesh.put write verbs.
  ["transition", "write", "put", "set", "save", "update", "store", "upsert", "append", "post"],
  // agents.create family.
  ["create", "spawn", "new", "add", "make", "register"],
  // mesh.publish family ("post" deliberately also sits in the write class,
  // so mesh.post stays ambiguous between publish and put).
  ["publish", "send", "emit", "notify"],
  // teardown verbs.
  ["delete", "remove", "rm", "destroy", "drop", "clear"],
  // components.reload family.
  ["reload", "restart", "refresh", "rebuild", "reboot"],
  // status/introspection reads ("get" is deliberately shared with the
  // expand class: memory.get expands an entry, components.get is status).
  ["status", "info", "inspect", "health", "describe", "get"],
  // execution verbs.
  ["run", "execute", "exec", "invoke", "call", "start", "go"],
  // cancellation verbs.
  ["cancel", "abort", "stop", "kill", "terminate"],
  // verification verbs.
  ["verify", "check", "validate", "assert", "confirm", "certify"],
  // timeline reads.
  ["history", "log", "journal", "events", "timeline", "transitions"],
  // subscription verbs.
  ["subscribe", "watch", "listen", "observe", "follow"],
  // compact.request family.
  ["request", "begin", "initiate", "trigger", "schedule"],
  // schema.commit family.
  ["commit", "apply", "finalize"],
  // agents messaging pair (both declare, so spilled verbs here stay
  // ambiguous and the failure tier enumerates ask vs tell).
  ["ask", "tell", "say", "chat"],
];

// Casing/spacing/underscore/dollar-insensitive action form, mirroring
// normalizeForm in arg-normalization: "$servers" and "servers" share a form.
const normalizeActionForm = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

const ACTION_CLASS_FORMS = ACTION_SYNONYM_CLASSES.map((cls) =>
  new Set(cls.map(normalizeActionForm)),
);

const camelTokens = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);

// Singular/plural near-misses collapse to one form, mirroring the derived
// plural handling of declared schema keys in arg-normalization.
const singularActionForm = (form: string): string =>
  form.length > 3 && form.endsWith("s") ? form.slice(0, -1) : form;

const levenshtein = (left: string, right: string): number => {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = new Array<number>(right.length + 1);
  let current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j++) previous[j] = j;
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length]!;
};

// Edit-distance budget scales with the spilled length; short names keep a
// tight budget so "get" never quietly becomes "set".
const editThreshold = (form: string): number =>
  form.length <= 4 ? 1 : Math.max(2, Math.floor(form.length / 4));

const tokenAligned = (spilled: string[], declared: string[]): boolean => {
  if (spilled.length === 0 || spilled.length !== declared.length) return false;
  return spilled.every((token, index) => {
    const other = declared[index]!;
    if (token === other) return true;
    return token.length >= 3 && other.length >= 3 &&
      (token.startsWith(other) || other.startsWith(token));
  });
};

const sortNames = (names: readonly string[]): string[] =>
  [...new Set(names)].sort((left, right) => left.localeCompare(right));

interface CatalogForm {
  name: string;
  form: string;
  singular: string;
  tokens: string[];
}

// Catalog identity is weakly held; validate its contents so mutable provider
// registrations cannot retain stale names, ambiguity, or authorization targets.
interface CatalogSnapshot {
  forms: CatalogForm[];
  repairs: Map<string, ActionNameRepair>;
}

const catalogCache = new WeakMap<readonly string[], CatalogSnapshot>();
const catalogSnapshot = (declared: readonly string[]): CatalogSnapshot => {
  const cached = catalogCache.get(declared);
  if (cached?.forms.length === declared.length && cached.forms.every((entry, index) => entry.name === declared[index])) {
    return cached;
  }
  const forms = declared.map((name) => {
    const form = normalizeActionForm(name);
    return { name, form, singular: singularActionForm(form), tokens: camelTokens(name) };
  });
  const snapshot = { forms, repairs: new Map<string, ActionNameRepair>() };
  catalogCache.set(declared, snapshot);
  return snapshot;
};

/**
 * Repair a spilled action name against the provider's declared names.
 * Returns the canonical name when exactly one declared candidate fits, or
 * ranked suggestions for the didactic failure message.
 */
const computeActionRepair = (
  catalog: readonly CatalogForm[],
  actionName: string,
): ActionNameRepair => {
  const spilledForm = normalizeActionForm(actionName);
  if (spilledForm.length === 0) return { suggestions: [] };
  if (catalog.some((entry) => entry.name === actionName)) return { suggestions: [] };
  const forms = [...new Map(catalog.map((entry) => [entry.name, entry])).values()];

  // Exact case/separator forms prove identity before semantic aliases.
  const exact = forms.filter((entry) => entry.form === spilledForm).map((entry) => entry.name);
  if (exact.length === 1) return { repaired: exact[0]!, suggestions: exact };
  if (exact.length > 1) return { suggestions: sortNames(exact) };
  if (forms.length === 0) return { suggestions: [] };

  // Tier 1 — semantic verb classes: the spilled verb belongs to a shared
  // synonym class; repair only when exactly one class member is declared.
  const classCandidates = sortNames(ACTION_CLASS_FORMS
    .filter((classForms) => classForms.has(spilledForm))
    .flatMap((classForms) =>
      forms.filter((entry) => classForms.has(entry.form)).map((entry) => entry.name)
    ));
  if (classCandidates.length === 1) {
    return { repaired: classCandidates[0]!, suggestions: [classCandidates[0]!] };
  }
  if (classCandidates.length > 1) {
    return { suggestions: sortNames(classCandidates) };
  }

  // Similarity is only didactic evidence, even with a unique candidate.
  // Singular/plural, token alignment, and prefixes never authorize repair.
  const spilledTokens = camelTokens(actionName);
  const spilledSingular = singularActionForm(spilledForm);
  const derived: string[] = [];
  for (const entry of forms) {
    if (
      entry.form === spilledForm ||
      entry.singular === spilledSingular ||
      (spilledTokens.length > 0 && tokenAligned(spilledTokens, entry.tokens)) ||
      (spilledForm.length >= 4 && entry.form.startsWith(spilledForm))
    ) {
      derived.push(entry.name);
    }
  }
  if (derived.length > 0) return { suggestions: sortNames(derived) };

  // Bounded edit distance ranks suggestions, never semantic proof.
  const distances = forms.map((entry) => ({
    name: entry.name,
    distance: levenshtein(spilledForm, entry.form),
  }));
  const min = Math.min(...distances.map((entry) => entry.distance));
  const threshold = editThreshold(spilledForm);
  if (min <= threshold) {
    const nearest = sortNames(
      distances.filter((entry) => entry.distance === min).map((entry) => entry.name),
    );
    return { suggestions: nearest };
  }

  // Failure tier — rank a few close names so the error teaches the catalog.
  const suggestions = distances
    .filter((entry) => entry.distance <= Math.max(3, Math.floor(spilledForm.length / 2)))
    .sort((left, right) =>
      left.distance - right.distance || left.name.localeCompare(right.name)
    )
    .slice(0, 3)
    .map((entry) => entry.name);
  return { suggestions: sortNames(suggestions) };
};

// Bound memoized near-misses per live catalogue. Every call revalidates the
// names above, so replacement/removal invalidates repairs as well as forms.
export const repairActionName = (declared: readonly string[], actionName: string): ActionNameRepair => {
  const catalog = catalogSnapshot(declared);
  let result = catalog.repairs.get(actionName);
  if (!result) {
    result = computeActionRepair(catalog.forms, actionName);
    if (actionName.length <= 512) {
      if (catalog.repairs.size >= 128) catalog.repairs.delete(catalog.repairs.keys().next().value!);
      catalog.repairs.set(actionName, result);
    }
  }
  // Callers own suggestions; never expose mutable cached values.
  return { ...result, suggestions: [...result.suggestions] };
};

/**
 * The didactic unknown-action failure message. The original
 * "Unknown Fabric action: <ref>" prefix is preserved verbatim; declared
 * candidates are appended only when repair found close misses.
 */
export const formatUnknownActionMessage = (
  ref: string,
  suggestions: readonly string[],
): string =>
  suggestions.length > 0
    ? `Unknown Fabric action: ${ref} (did you mean: ${suggestions.slice(0, 3).join(", ")}?)`
    : `Unknown Fabric action: ${ref}`;
