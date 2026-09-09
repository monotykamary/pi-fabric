#!/usr/bin/env node
// Offline deterministic certification of schema-bound normal forms.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENTROPY_METRIC_VERSION, applyCompiledSurface, applyNormalFormPlan,
  compileEntropySurface, compileEntropySurfaceAsync, deriveNormalFormPlan,
  emptyCompiledSurface, entropyReportHash, entropySessionEvidenceFromJsonl,
  entropySurfaceHash, loadCompiledSurface, measureEntropy, mergeCompiledSurfaces,
  parseCompiledSurfaceArtifact, provesNormalFormPlan, runEntropyTrial,
  saveCompiledSurface, schemaDigest, surfaceFreedomReport,
} from "../../dist/entropy/index.js";

const ingestionJsonl = () => {
  const envelope = {
    kind: "pi-fabric.execution",
    version: 1,
    outcome: "succeeded",
    phases: ["build"],
    operations: [
      {
        type: "call",
        sequence: 0,
        ref: "pi.read",
        args: { path: "src/a.ts", limit: 10 },
        outcome: "succeeded",
      },
      {
        type: "call",
        sequence: 1,
        ref: "pi.bash",
        args: { command: "ls" },
        outcome: "failed",
        failureStage: "invoke",
        error: "boom",
      },
    ],
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
  };
  // A second execution whose MCP calls keep no trace arguments but persist
  // verbatim audit args: the advisory value corpus must come from audits.
  const renderFormats = [
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "pdf",
    "html",
  ];
  const renderEnvelope = {
    kind: "pi-fabric.execution",
    version: 1,
    outcome: "succeeded",
    phases: ["build"],
    operations: renderFormats.map((format, index) => ({
      type: "call",
      sequence: index,
      ref: "mcp.report.render",
      args: {},
      outcome: "succeeded",
    })),
    counts: {
      droppedValues: 0,
      truncatedValues: 0,
      redactedValues: 0,
      droppedOperations: 0,
    },
  };
  const renderAudits = renderFormats.map((format) => ({
    ref: "mcp.report.render",
    args: { format },
  }));
  const sessionLine = (id, trace, audits) =>
    JSON.stringify({
      id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${id}`,
        toolName: "fabric_exec",
        content: [{ type: "text", text: "ok" }],
        details: { success: true, trace, audits, phases: ["build"] },
      },
    });
  return [
    "{ not json",
    JSON.stringify({
      id: "entry-0",
      type: "message",
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      id: "entry-model-1",
      type: "model_change",
      provider: "zro",
      modelId: "kimi-k3",
    }),
    sessionLine(
      "entry-1",
      envelope,
      [
        { ref: "pi.read", args: { path: "src/a.ts", limit: 10 } },
        { ref: "pi.bash", args: { command: "ls" } },
      ],
    ),
    JSON.stringify({
      id: "entry-model-2",
      type: "model_change",
      provider: "coralbricks",
      modelId: "glm-5.3-fp4",
    }),
    sessionLine("entry-2", renderEnvelope, renderAudits),
    "",
  ].join("\n");
};

export const runEntropyCertification = async (options = {}) => {
  const checks = [];
  const check = (id, passed, evidence = "") => checks.push({ id, passed: Boolean(passed), evidence });
  const same = (a, b) => schemaDigest(a) === schemaDigest(b);
  const ref = "mcp.report.render";
  const schema = {
    type: "object", additionalProperties: false,
    properties: {
      outputFormat: { type: "string", enum: ["pdf", "html", "rare-format"] },
      limit: { type: "integer", minimum: 1 }, note: { type: "string" },
    }, required: ["outputFormat", "limit"],
  };
  const live = { version: 1, actions: [{ ref, inputSchema: schema }] };
  const canonical = { outputFormat: "rare-format", limit: 2 };
  const spilled = { "output-format": "RARE FORMAT", limit: "2", note: null };
  const traces = [{ model: "fixture/model", operations: [
    { ref, args: spilled, outcome: "failed", failureStage: "validate" },
    { ref, args: canonical, outcome: "succeeded" },
    { ref, args: canonical, outcome: "failed", failureStage: "invoke" },
    { ref: "fabric.discovery.search", args: {}, outcome: "succeeded" },
  ] }];
  const input = { traces, surface: live };
  const snapshot = JSON.stringify(input);
  const report = measureEntropy(input);
  const repeated = measureEntropy({ ...input, traces: [...traces, ...traces, ...traces] });
  check("metric-v3-exact", ENTROPY_METRIC_VERSION === 3 && report.score === 0.333333 && report.behavioralScore === report.score && report.totals.invocationRejections === 1);
  check("sample-count-invariance", repeated.score === report.score && repeated.staticScore === report.staticScore && repeated.byModel[0].behavioralScore === report.byModel[0].behavioralScore);
  check("diagnostics-not-objective", report.staticScore > 0 && measureEntropy({ traces }).score === report.score);
  const allfail = measureEntropy({ traces: [{ operations: traces[0].operations.slice(0, 1) }] });
  check("allfail-nonzero", allfail.score === 1 && allfail.behavioralScore === 1);
  check("determinism-double-run", entropyReportHash(report) === entropyReportHash(measureEntropy(input)));
  const compiled = compileEntropySurface(input);
  const artifact = compiled.artifact;
  const plan = artifact?.normalizations?.[0];
  check("static-compilation", compiled.status === "compiled" && artifact.version === 2 && artifact.actions.length === 0 && artifact.quarantined.length === 0 && provesNormalFormPlan(plan, schema));
  check("empty-corpus-compilation", same(compileEntropySurface({ traces: [], surface: live }).artifact.normalizations, artifact.normalizations));
  check("historical-outcomes-unchanged", compiled.after === compiled.report && compiled.after.score === report.score && compiled.gate.delta === 0 && JSON.stringify(input) === snapshot);
  check("compile-determinism", same(compiled, compileEntropySurface(input)) && same(compiled, await compileEntropySurfaceAsync(input)));
  const converged = compileEntropySurface({ ...input, artifact });
  check("identical-plans-converge", converged.status === "converged" && converged.artifact === artifact);
  check("static-preservation", applyCompiledSurface(live, artifact) === live && same(live.actions[0].inputSchema, schema));
  check("canonical-identity", schema.properties.outputFormat.enum.every((outputFormat) => {
    const args = { outputFormat, limit: 1 };
    const result = applyNormalFormPlan(ref, schema, args, plan);
    return result.args === args && result.witness === undefined;
  }));
  const normalized = applyNormalFormPlan(ref, schema, spilled, plan);
  const twice = applyNormalFormPlan(ref, schema, normalized.args, plan);
  check("normalization-idempotence", same(normalized.args, canonical) && normalized.witness?.rules.length === 4 && twice.args === normalized.args && !twice.witness);
  const refused = [
    { ...canonical, "output-format": "PDF" },
    { "output-format": "PDF", output_format: "HTML", limit: 1 },
    { ...canonical, limit: "02" }, { ...canonical, limit: "9007199254740993" },
    { ...spilled, unknown: true },
  ];
  const ambiguous = { ...schema, properties: { ...schema.properties, outputFormat: { type: "string", enum: ["a-b", "a_b"] } } };
  const ambiguousArgs = { outputFormat: "A B", limit: 1 };
  check("ambiguity-and-loss-refusal", refused.every((args) => applyNormalFormPlan(ref, schema, args, plan).args === args) && applyNormalFormPlan(ref, ambiguous, ambiguousArgs, deriveNormalFormPlan(ref, ambiguous)).args === ambiguousArgs);
  check("unsupported-schema-no-plan", deriveNormalFormPlan(ref, { ...schema, additionalProperties: true }) === undefined);
  const forged = { ...plan, rules: plan.rules.slice(1) };
  const drift = { ...schema, required: ["note"] };
  const merged = mergeCompiledSurfaces(undefined, { ...artifact, normalizations: [forged] }, live);
  check("forged-plan-refusal", !provesNormalFormPlan(forged, schema) && merged.droppedNormalizations === 1 && merged.file.normalizations.length === 0 && applyNormalFormPlan(ref, schema, spilled, forged).args === spilled);
  check("schema-drift-refusal", !provesNormalFormPlan(plan, drift) && applyNormalFormPlan(ref, drift, spilled, plan).args === spilled && mergeCompiledSurfaces(undefined, artifact, { version: 1, actions: [{ ref, inputSchema: drift }] }).droppedNormalizations === 1);
  check("exact-plan-merge", same(mergeCompiledSurfaces(undefined, artifact, live).file.normalizations, artifact.normalizations));
  const legacy = { ...emptyCompiledSurface(), version: 1, metricVersion: 2,
    actions: [{ ref, inputSchema: { ...schema, properties: { ...schema.properties, outputFormat: { type: "string", enum: ["pdf"] } } }, baseSchemaDigest: schemaDigest(schema) }],
    quarantined: [{ ref, baseSchemaDigest: schemaDigest(schema) }],
  };
  const migrated = mergeCompiledSurfaces(undefined, legacy, live);
  check("legacy-inert-migration", parseCompiledSurfaceArtifact(legacy) !== undefined && applyCompiledSurface(live, legacy) === live && migrated.droppedOverlays === 1 && migrated.droppedQuarantines === 1 && migrated.file.actions.length === 0 && migrated.file.quarantined.length === 0 && compileEntropySurface({ ...input, artifact: legacy }).artifact.version === 2);
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-entropy-cert-"));
  try {
    saveCompiledSurface(storeDir, artifact);
    check("artifact-store-roundtrip", same(loadCompiledSurface(storeDir).file, artifact));
  } finally { fs.rmSync(storeDir, { recursive: true, force: true }); }

  const evidence = entropySessionEvidenceFromJsonl(ingestionJsonl().split("\n"));
  const ingestionReport = measureEntropy({ traces: evidence.traces });
  const unguarded = entropySessionEvidenceFromJsonl([JSON.stringify({
    type: "message", message: { role: "toolResult", toolName: "fabric_exec",
      details: { audits: [{ ref, args: { format: "invented" } }], trace: { version: 1 } },
    },
  })]);
  check("ingestion-requires-trace-envelope", unguarded.traces.length === 0 && unguarded.auditCalls.length === 0 && unguarded.valueObservations.length === 0);
  check("ingestion-verbatim-audits", evidence.traces.length === 2 && ingestionReport.totals.operations === 10 && evidence.auditCalls.filter((call) => call.ref === ref).length === 8 && evidence.auditCalls.some((call) => call.args.format === "html") && evidence.traces[1].operations.every((op) => same(op.args, {})));
  check("ingestion-model-attribution", same(ingestionReport.byModel.map((row) => [row.model, row.actionOperations]), [["coralbricks/glm-5.3-fp4", 8], ["zro/kimi-k3", 2]]));
  check("ingestion-value-observations", evidence.valueObservations.some((row) => row.ref === ref && row.key === "format" && row.value === "html"));
  const auditSchema = { type: "object", additionalProperties: false, properties: { format: { type: "string", enum: ["pdf", "html", "rare"] } }, required: ["format"] };
  const auditLive = { version: 1, actions: [{ ref, inputSchema: auditSchema }] };
  const auditTrial = runEntropyTrial({ traces: evidence.traces, auditCalls: evidence.auditCalls, live: auditLive, artifact: compileEntropySurface({ traces: [], surface: auditLive }).artifact });
  check("ingestion-trial-verbatim", auditTrial.totals.operations === 8 && auditTrial.totals.bothAccept === 8 && auditTrial.totals.bothReject === 0);
  const trial = runEntropyTrial({ traces, live, artifact, auditCalls: [{ ref, args: spilled }, { ref, args: canonical }] });
  check("same-normalizer-trial", trial.totals.normalizationWin === 1 && trial.totals.bothAccept === 1 && trial.totals.operations === 2 && trial.totals.canonicalIdentityChecks === 1 && trial.totals.canonicalIdentityCost === 0 && trial.totals.idempotenceCost === 0 && trial.declaredScore === report.score && trial.effectiveScore === report.score && trial.delta === 0);
  const legacyTrial = runEntropyTrial({ traces, live, artifact: legacy });
  check("no-quarantine-wins", legacyTrial.totals.quarantineWin === 0 && legacyTrial.totals.typedFailureWin === 0 && legacyTrial.totals.tighteningCost === 0 && legacyTrial.totals.bothAccept === 2 && legacyTrial.verdict === "no-evidence");
  if (options.trial && !options.sessionsDir) check("trial-mode", false, "--trial requires --sessions and --surface");
  if (options.artifactPath && !options.trial) check("artifact-mode", false, "--artifact requires --trial");
  let corpus;
  let surfaceSummary;
  let trialSummary;
  if (options.surfacePath && !options.sessionsDir) {
    check("corpus-mode", false, "--surface requires --sessions");
  }
  if (options.sessionsDir) {
    const sessionsDir = options.sessionsDir;
    if (!fs.existsSync(sessionsDir)) {
      check("corpus-mode", false, `sessions directory not found: ${sessionsDir}`);
    } else {
      const files = fs
        .readdirSync(sessionsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort();
      // A model cursor belongs to one session, never the next file.
      const evidence = { traces: [], auditCalls: [], valueObservations: [] };
      for (const file of files) {
        const scanned = entropySessionEvidenceFromJsonl(
          fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n"),
        );
        for (const key of Object.keys(evidence)) {
          for (const row of scanned[key]) evidence[key].push(row);
        }
      }
      const traces = evidence.traces;
      let surface;
      let catalogDigest = "(sessions)";
      if (options.surfacePath) {
        const raw = JSON.parse(fs.readFileSync(options.surfacePath, "utf8"));
        if (!raw || raw.version !== 1 || !Array.isArray(raw.actions)) {
          throw new Error("surface snapshot must be { version: 1, actions: [...] }");
        }
        surface = {
          version: 1,
          actions: raw.actions.filter(
            (action) => action && typeof action.ref === "string",
          ),
        };
        catalogDigest = entropySurfaceHash(surface);
        const freedom = surfaceFreedomReport(surface);
        surfaceSummary = {
          path: options.surfacePath,
          actions: freedom.actions.length,
          freedomTotal: freedom.total,
          freedomMean: freedom.mean,
          digest: catalogDigest,
        };
      }
      corpus = measureEntropy({
        traces,
        ...(surface ? { surface } : {}),
        catalogDigest,
      });
      check(
        "corpus-mode",
        corpus.totals.operations > 0,
        `files ${files.length} traces ${traces.length} operations ${corpus.totals.operations}`,
      );
      // Replay representations, never counterfactual execution outcomes.
      if (options.trial) {
        if (!surface) {
          check("trial-mode", false, "--trial requires --surface");
        } else {
          let artifact;
          if (options.artifactPath) {
            const raw = JSON.parse(fs.readFileSync(options.artifactPath, "utf8"));
            artifact = parseCompiledSurfaceArtifact(raw);
            if (!artifact) {
              check("trial-mode", false, `artifact is invalid: ${options.artifactPath}`);
            }
          } else {
            const agentDir =
              process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
            const loaded = loadCompiledSurface(agentDir);
            artifact = loaded.file;
            if (!artifact) {
              check(
                "trial-mode",
                false,
                loaded.error ?? "no compiled surface in the agent dir (pass --artifact <path>)",
              );
            }
          }
          if (artifact) {
            const trial = runEntropyTrial({
              traces,
              live: surface,
              artifact,
              auditCalls: evidence.auditCalls,
            });
            trialSummary = {
              verdict: trial.verdict,
              declaredScore: trial.declaredScore,
              effectiveScore: trial.effectiveScore,
              delta: trial.delta,
              totals: trial.totals,
              divergences: trial.divergences,
            };
            check(
              "trial-costs",
              trial.totals.tighteningCost + trial.totals.quarantineCost + trial.totals.canonicalIdentityCost + trial.totals.idempotenceCost === 0,
              JSON.stringify(trial.totals),
            );
          }
        }
      }
    }
  }

  const evaluation = {
    passed: checks.every((entry) => entry.passed), checks,
    failed: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
  };
  return {
    kind: "pi-fabric.entropy-certification", version: 2, metricVersion: ENTROPY_METRIC_VERSION,
    fixtures: { metric: report, allfail, compiler: { status: compiled.status, normalizations: artifact.normalizations.length }, ingestion: { traces: evidence.traces.length, byModel: ingestionReport.byModel }, trial },
    ...(corpus ? { corpus } : {}), ...(surfaceSummary ? { surface: surfaceSummary } : {}),
    ...(trialSummary ? { trial: trialSummary } : {}), evaluation,
  };
};

export const formatEntropyHumanReport = (report) => {
  const lines = [`Entropy certification (metric v${report.metricVersion}; offline normal forms)`];
  if (report.corpus) lines.push(`  corpus: ${report.corpus.totals.actionOperations} action operations; rejection rate ${report.corpus.score}`);
  if (report.surface) lines.push(`  surface: ${report.surface.actions} actions; digest ${report.surface.digest.slice(0, 12)}`);
  if (report.trial) lines.push(`  trial: ${report.trial.verdict}; representation wins ${report.trial.totals.normalizationWin}; historical score unchanged ${report.trial.declaredScore}`);
  for (const entry of report.evaluation.checks) lines.push(`  ${entry.passed ? "PASS" : "FAIL"} ${entry.id}${entry.passed ? "" : ` — ${entry.evidence}`}`);
  lines.push(report.evaluation.passed ? "  PASS" : "  FAIL");
  return lines.join("\n");
};
