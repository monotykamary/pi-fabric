import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG, type FabricSchemaMode } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { FabricState } from "../src/fabric-state.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { SchemaProvider } from "../src/providers/schema-provider.js";
import type { FabricInvocationContext, FabricProvider } from "../src/protocol.js";
import { SchemaController } from "../src/schema/controller.js";
import type { SchemaEvidence } from "../src/schema/types.js";
import { StateStore } from "../src/state/store.js";

const roots: string[] = [];
const identity: MeshIdentity = { id: "session:schema", name: "main", kind: "main", sessionId: "schema" };

const sha = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const fixture = (mode: FabricSchemaMode = "enforce", ttl = 30_000) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-schema-workspace-"));
  roots.push(cwd);
  const mesh = new MeshStore(path.join(cwd, ".pi", "fabric", "mesh"), 256 * 1024, 500);
  const config = { ...structuredClone(DEFAULT_FABRIC_CONFIG.schema), mode, certificateTtlMs: ttl };
  const state = new StateStore(mesh);
  const controller = new SchemaController(cwd, config, mesh, identity, state);
  return { cwd, mesh, config, state, controller };
};

const invocation = (cwd: string, parentToolCallId = "invocation", signal?: AbortSignal): FabricInvocationContext => ({
  cwd,
  signal,
  parentToolCallId,
  nestedToolCallId: "nested",
  extensionContext: { cwd, hasUI: false } as ExtensionContext,
  update() {},
});

const hypothesisAndCertificate = async (
  setup: ReturnType<typeof fixture>,
  evidence: SchemaEvidence[],
  parentToolCallId = "invocation",
) => {
  const context = invocation(setup.cwd, parentToolCallId);
  const hypothesis = await setup.controller.hypothesize(
    { label: "change", summary: "the declared local change is valid", evidence },
    context,
  );
  const verified = await setup.controller.verify(String(hypothesis.hypothesisId), context);
  return {
    context,
    hypothesisId: String(hypothesis.hypothesisId),
    certificate: String(verified.certificate),
    verified,
  };
};

const runService = async (mode: FabricSchemaMode, code: string, provider?: FabricProvider) => {
  const setup = fixture(mode);
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(setup.cwd));
  registry.register(new SchemaProvider(setup.controller));
  if (provider) registry.register(provider);
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.schema.mode = mode;
  config.approvals.read = "allow";
  config.approvals.write = "allow";
  config.approvals.execute = "allow";
  const service = new FabricExecutionService(registry, config, undefined, setup.controller);
  const result = await service.execute({
    code,
    signal: undefined,
    parentToolCallId: `service-${mode}-${randomSuffix()}`,
    context: { cwd: setup.cwd, hasUI: false } as ExtensionContext,
    onPartial() {},
  });
  return { setup, result };
};

const randomSuffix = (): string => Math.random().toString(16).slice(2);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Schema transactions", () => {
  it("publishes exact action schemas and rejects model-provided trusted-command fields", async () => {
    const setup = fixture();
    const provider = new SchemaProvider(setup.controller);
    const listed = await provider.list({}, invocation(setup.cwd));
    expect(listed.map((action) => action.name)).toEqual([
      "status",
      "hypothesize",
      "verify",
      "commit",
      "abort",
    ]);
    expect(listed.every((action) => action.inputSchema.additionalProperties === false)).toBe(true);
    const registry = new ActionRegistry();
    registry.register(provider);
    await expect(
      registry.invoke(
        "schema.hypothesize",
        {
          label: "no-shell",
          summary: "model shell is forbidden",
          evidence: [{ kind: "trusted_command", name: "configured", command: "rm -rf ." }],
        },
        {
          ...invocation(setup.cwd),
          approve: async () => {},
          audits: [],
          maxResultChars: 10_000,
        },
      ),
    ).rejects.toThrow("Invalid arguments for schema.hypothesize");
  });

  it("fails closed for empty, nonconfirmed, error, cancellation, and workspace drift evidence", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const context = invocation(setup.cwd);
    await expect(
      setup.controller.hypothesize({ label: "empty", summary: "empty", evidence: [] }, context),
    ).rejects.toThrow("nonempty typed evidence");

    const absent = await setup.controller.hypothesize(
      { label: "wrong", summary: "wrong", evidence: [{ kind: "file_absent", path: "a.txt" }] },
      context,
    );
    expect(await setup.controller.verify(String(absent.hypothesisId), context)).toMatchObject({ verified: false });

    const missing = await setup.controller.hypothesize(
      { label: "error", summary: "error", evidence: [{ kind: "file_exists", path: "missing.txt" }] },
      context,
    );
    expect(await setup.controller.verify(String(missing.hypothesisId), context)).toMatchObject({
      verified: false,
      results: [{ status: "error" }],
    });

    const cancelledController = new AbortController();
    cancelledController.abort();
    const cancelledContext = invocation(setup.cwd, "cancelled", cancelledController.signal);
    const cancelled = await setup.controller.hypothesize(
      { label: "cancel", summary: "cancel", evidence: [{ kind: "file_exists", path: "a.txt" }] },
      cancelledContext,
    );
    expect(await setup.controller.verify(String(cancelled.hypothesisId), cancelledContext)).toMatchObject({
      verified: false,
      results: [{ status: "error", detail: "cancelled" }],
    });

    const stale = await setup.controller.hypothesize(
      { label: "stale", summary: "stale", evidence: [{ kind: "file_exists", path: "a.txt" }] },
      context,
    );
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "drift\n");
    expect(await setup.controller.verify(String(stale.hypothesisId), context)).toMatchObject({
      verified: false,
      reason: "workspace fingerprint changed since hypothesis",
    });
  });

  it("invalidates a hypothesis when the state head changes", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const context = invocation(setup.cwd);
    const hypothesis = await setup.controller.hypothesize(
      { label: "state", summary: "state", evidence: [{ kind: "file_exists", path: "a.txt" }] },
      context,
    );
    await setup.state.transition({ label: "advance", to: "advanced", summary: "advanced" }, identity, setup.cwd);
    expect(await setup.controller.verify(String(hypothesis.hypothesisId), context)).toMatchObject({
      verified: false,
      reason: "state head changed since hypothesis",
    });
  });

  it("runs only trusted configured commands and treats unknown names as nonconfirmed", async () => {
    const setup = fixture();
    setup.config.trustedCommands.node_check = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('trusted')"],
      shell: false,
      timeoutMs: 5_000,
    };
    const context = invocation(setup.cwd);
    const trusted = await setup.controller.hypothesize(
      { label: "trusted", summary: "trusted command exits zero", evidence: [{ kind: "trusted_command", name: "node_check" }] },
      context,
    );
    expect(await setup.controller.verify(String(trusted.hypothesisId), context)).toMatchObject({
      verified: true,
      results: [{ status: "confirmed", output: "trusted" }],
    });

    const unknownContext = invocation(setup.cwd, "unknown-command");
    const unknown = await setup.controller.hypothesize(
      { label: "unknown", summary: "unknown command fails", evidence: [{ kind: "trusted_command", name: "not_configured" }] },
      unknownContext,
    );
    expect(await setup.controller.verify(String(unknown.hypothesisId), unknownContext)).toMatchObject({
      verified: false,
      results: [{ status: "nonconfirmed" }],
    });

    setup.config.trustedCommands.timeout = {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      shell: false,
      timeoutMs: 20,
    };
    const timeoutContext = invocation(setup.cwd, "timeout-command");
    const timeout = await setup.controller.hypothesize(
      { label: "timeout", summary: "timeout fails closed", evidence: [{ kind: "trusted_command", name: "timeout" }] },
      timeoutContext,
    );
    expect(await setup.controller.verify(String(timeout.hypothesisId), timeoutContext)).toMatchObject({
      verified: false,
      results: [{ status: "error", detail: "timeout after 20ms" }],
    });
  });

  it("invalidates certificates after post-verification state or fingerprint drift", async () => {
    const workspaceSetup = fixture();
    fs.writeFileSync(path.join(workspaceSetup.cwd, "a.txt"), "alpha\n");
    const workspaceArtifacts = await hypothesisAndCertificate(workspaceSetup, [{ kind: "file_exists", path: "a.txt" }]);
    fs.writeFileSync(path.join(workspaceSetup.cwd, "a.txt"), "drift\n");
    await expect(
      workspaceSetup.controller.commit(
        {
          hypothesisId: workspaceArtifacts.hypothesisId,
          certificate: workspaceArtifacts.certificate,
          operations: [{ kind: "delete", path: "a.txt", expectedSha256: sha("drift\n") }],
          postconditions: [{ kind: "file_absent", path: "a.txt" }],
        },
        workspaceArtifacts.context,
      ),
    ).rejects.toThrow("fingerprint is stale");

    const stateSetup = fixture();
    fs.writeFileSync(path.join(stateSetup.cwd, "a.txt"), "alpha\n");
    const stateArtifacts = await hypothesisAndCertificate(stateSetup, [{ kind: "file_exists", path: "a.txt" }]);
    await stateSetup.state.transition({ label: "advance", to: "advanced", summary: "advanced" }, identity, stateSetup.cwd);
    await expect(
      stateSetup.controller.commit(
        {
          hypothesisId: stateArtifacts.hypothesisId,
          certificate: stateArtifacts.certificate,
          operations: [{ kind: "delete", path: "a.txt", expectedSha256: sha("alpha\n") }],
          postconditions: [{ kind: "file_absent", path: "a.txt" }],
        },
        stateArtifacts.context,
      ),
    ).rejects.toThrow("state head changed");

    const generationSetup = fixture();
    fs.writeFileSync(path.join(generationSetup.cwd, "a.txt"), "alpha\n");
    const generationArtifacts = await hypothesisAndCertificate(generationSetup, [{ kind: "file_exists", path: "a.txt" }]);
    await generationSetup.mesh.put({
      key: "schema/workspace",
      value: { generation: 1, updatedAt: Date.now() },
      ifVersion: 0,
      identity,
    });
    await expect(
      generationSetup.controller.commit(
        {
          hypothesisId: generationArtifacts.hypothesisId,
          certificate: generationArtifacts.certificate,
          operations: [{ kind: "delete", path: "a.txt", expectedSha256: sha("alpha\n") }],
          postconditions: [{ kind: "file_absent", path: "a.txt" }],
        },
        generationArtifacts.context,
      ),
    ).rejects.toThrow("generation is stale");
  });

  it("commits bounded edits, advances generation, and consumes the certificate once", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const artifacts = await hypothesisAndCertificate(setup, [{ kind: "file_contains", path: "a.txt", literal: "alpha" }]);
    expect(artifacts.verified).toMatchObject({
      verified: true,
      results: [{ observedSha256: sha("alpha\n") }],
    });
    const result = await setup.controller.commit(
      {
        hypothesisId: artifacts.hypothesisId,
        certificate: artifacts.certificate,
        operations: [{ kind: "edit", path: "a.txt", oldText: "alpha", newText: "beta", expectedSha256: sha("alpha\n") }],
        postconditions: [{ kind: "file_contains", path: "a.txt", literal: "beta" }],
      },
      artifacts.context,
    );
    expect(result).toMatchObject({ outcome: "committed", generation: 1 });
    expect(fs.readFileSync(path.join(setup.cwd, "a.txt"), "utf8")).toBe("beta\n");
    expect(setup.controller.status()).toMatchObject({ generation: 1, lastOutcome: "committed" });
    await expect(
      setup.controller.commit(
        {
          hypothesisId: artifacts.hypothesisId,
          certificate: artifacts.certificate,
          operations: [{ kind: "delete", path: "a.txt", expectedSha256: sha("beta\n") }],
          postconditions: [{ kind: "file_absent", path: "a.txt" }],
        },
        artifacts.context,
      ),
    ).rejects.toThrow("consumed");
  });

  it("rejects wrong invocation and expiry", async () => {
    const setup = fixture("enforce", 1_000);
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const artifacts = await hypothesisAndCertificate(setup, [{ kind: "file_exists", path: "a.txt" }]);
    await expect(
      setup.controller.commit(
        {
          hypothesisId: artifacts.hypothesisId,
          certificate: artifacts.certificate,
          operations: [{ kind: "delete", path: "a.txt", expectedSha256: sha("alpha\n") }],
          postconditions: [{ kind: "file_absent", path: "a.txt" }],
        },
        invocation(setup.cwd, "other"),
      ),
    ).rejects.toThrow("different fabric_exec invocation");

    const originalNow = Date.now;
    const now = originalNow();
    Date.now = () => now + 2_000;
    try {
      await expect(
        setup.controller.commit(
          {
            hypothesisId: artifacts.hypothesisId,
            certificate: artifacts.certificate,
            operations: [{ kind: "delete", path: "a.txt", expectedSha256: sha("alpha\n") }],
            postconditions: [{ kind: "file_absent", path: "a.txt" }],
          },
          artifacts.context,
        ),
      ).rejects.toThrow("expired");
    } finally {
      Date.now = originalNow;
    }
  });

  it("fails preconditions, rejects path and symlink escapes, and leaves the certificate unconsumed before mutation", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-schema-outside-"));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(setup.cwd, "link.txt"));
    const artifacts = await hypothesisAndCertificate(setup, [{ kind: "file_exists", path: "a.txt" }]);

    await expect(
      setup.controller.commit(
        {
          hypothesisId: artifacts.hypothesisId,
          certificate: artifacts.certificate,
          operations: [{ kind: "write", path: "../escape.txt", content: "x", expected: { absent: true } }],
          postconditions: [{ kind: "file_exists", path: "a.txt" }],
        },
        artifacts.context,
      ),
    ).rejects.toThrow("escapes");
    await expect(
      setup.controller.commit(
        {
          hypothesisId: artifacts.hypothesisId,
          certificate: artifacts.certificate,
          operations: [{ kind: "delete", path: "link.txt", expectedSha256: sha("secret") }],
          postconditions: [{ kind: "file_absent", path: "link.txt" }],
        },
        artifacts.context,
      ),
    ).rejects.toThrow("symbolic link");

    const rolledBack = await setup.controller.commit(
      {
        hypothesisId: artifacts.hypothesisId,
        certificate: artifacts.certificate,
        operations: [{ kind: "edit", path: "a.txt", oldText: "alpha", newText: "beta", expectedSha256: sha("wrong") }],
        postconditions: [{ kind: "file_contains", path: "a.txt", literal: "beta" }],
      },
      artifacts.context,
    );
    expect(rolledBack).toMatchObject({ outcome: "rolled_back" });
    expect(fs.readFileSync(path.join(setup.cwd, "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("records quarantine when a trusted postcondition makes rollback unsafe", async () => {
    const setup = fixture();
    const target = path.join(setup.cwd, "a.txt");
    const outside = path.join(setup.cwd, "outside.txt");
    fs.writeFileSync(target, "alpha\n");
    fs.writeFileSync(outside, "outside\n");
    setup.config.trustedCommands.unsafe_for_test = {
      command: process.execPath,
      args: [
        "-e",
        `require('node:fs').unlinkSync(${JSON.stringify(target)}); require('node:fs').symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(target)})`,
      ],
      shell: false,
      timeoutMs: 5_000,
    };
    const artifacts = await hypothesisAndCertificate(setup, [{ kind: "file_exists", path: "a.txt" }]);
    const result = await setup.controller.commit(
      {
        hypothesisId: artifacts.hypothesisId,
        certificate: artifacts.certificate,
        operations: [{ kind: "edit", path: "a.txt", oldText: "alpha", newText: "beta", expectedSha256: sha("alpha\n") }],
        postconditions: [{ kind: "trusted_command", name: "unsafe_for_test" }],
      },
      artifacts.context,
    );
    expect(result).toMatchObject({ outcome: "quarantined", rollbackError: expect.stringContaining("symbolic link") });
    expect(setup.controller.status()).toMatchObject({ lastOutcome: "quarantined" });
  });

  it("restores all declared paths when a postcondition fails", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const artifacts = await hypothesisAndCertificate(setup, [{ kind: "file_exists", path: "a.txt" }]);
    const result = await setup.controller.commit(
      {
        hypothesisId: artifacts.hypothesisId,
        certificate: artifacts.certificate,
        operations: [
          { kind: "edit", path: "a.txt", oldText: "alpha", newText: "beta", expectedSha256: sha("alpha\n") },
          { kind: "write", path: "new.txt", content: "new\n", expected: { absent: true } },
        ],
        postconditions: [{ kind: "file_contains", path: "a.txt", literal: "missing" }],
      },
      artifacts.context,
    );
    expect(result).toMatchObject({ outcome: "rolled_back" });
    expect(fs.readFileSync(path.join(setup.cwd, "a.txt"), "utf8")).toBe("alpha\n");
    expect(fs.existsSync(path.join(setup.cwd, "new.txt"))).toBe(false);
  });

  it("uses CAS so concurrent reuse has at most one committed result", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const artifacts = await hypothesisAndCertificate(setup, [{ kind: "file_exists", path: "a.txt" }]);
    const request = {
      hypothesisId: artifacts.hypothesisId,
      certificate: artifacts.certificate,
      operations: [{ kind: "edit" as const, path: "a.txt", oldText: "alpha", newText: "beta", expectedSha256: sha("alpha\n") }],
      postconditions: [{ kind: "file_contains" as const, path: "a.txt", literal: "beta" }],
    };
    const settled = await Promise.allSettled([
      setup.controller.commit(request, artifacts.context),
      setup.controller.commit(request, artifacts.context),
    ]);
    const committed = settled.filter(
      (item) => item.status === "fulfilled" && item.value.outcome === "committed",
    );
    expect(committed).toHaveLength(1);
  });

  it("recovers an applying crash journal before accepting new transactions", () => {
    const setup = fixture();
    const target = path.join(setup.cwd, "a.txt");
    fs.writeFileSync(target, "mutated\n");
    const journalRoot = path.join(setup.mesh.root, "schema-transactions");
    fs.writeFileSync(
      path.join(journalRoot, "crashed.json"),
      JSON.stringify({
        format: 1,
        id: "crashed",
        status: "applying",
        before: [{
          path: "a.txt",
          absolute: target,
          existed: true,
          content: Buffer.from("original\n").toString("base64"),
          mode: 0o644,
        }],
        createdAt: Date.now(),
      }),
    );
    new SchemaController(setup.cwd, setup.config, setup.mesh, identity, setup.state);
    expect(fs.readFileSync(target, "utf8")).toBe("original\n");
    expect(JSON.parse(fs.readFileSync(path.join(journalRoot, "crashed.json"), "utf8"))).toMatchObject({
      status: "rolled_back",
      error: "recovered incomplete transaction",
    });
  });

  it("abandons unclosed artifacts automatically when Fabric runtime execution ends", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const registry = new ActionRegistry();
    registry.register(new SchemaProvider(setup.controller));
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.schema.mode = "enforce";
    const service = new FabricExecutionService(registry, config, undefined, setup.controller);
    const result = await service.execute({
      code: `
const hypothesis = await schema.hypothesize({
  label: "runtime-cleanup",
  summary: "runtime cleanup",
  evidence: [{ kind: "file_exists", path: "a.txt" }],
});
return schema.verify({ hypothesisId: hypothesis.hypothesisId });
`,
      signal: undefined,
      parentToolCallId: "runtime-cleanup",
      context: { cwd: setup.cwd, hasUI: false } as ExtensionContext,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(setup.controller.status("runtime-cleanup").hypotheses).toEqual([
      expect.objectContaining({ status: "abandoned" }),
    ]);
  });

  it("abandons unclosed hypotheses and certificates at invocation end", async () => {
    const setup = fixture();
    fs.writeFileSync(path.join(setup.cwd, "a.txt"), "alpha\n");
    const artifacts = await hypothesisAndCertificate(setup, [{ kind: "file_exists", path: "a.txt" }]);
    await setup.controller.endInvocation(artifacts.context.parentToolCallId);
    const status = setup.controller.status(artifacts.context.parentToolCallId);
    expect(status.hypotheses).toEqual([
      expect.objectContaining({ id: artifacts.hypothesisId, status: "abandoned" }),
    ]);
    await expect(
      setup.controller.commit(
        {
          hypothesisId: artifacts.hypothesisId,
          certificate: artifacts.certificate,
          operations: [{ kind: "delete", path: "a.txt", expectedSha256: sha("alpha\n") }],
          postconditions: [{ kind: "file_absent", path: "a.txt" }],
        },
        artifacts.context,
      ),
    ).rejects.toThrow("abandoned");
  });
});

describe("Schema central gate", () => {
  it("applies existing Schema policy to synthetic top-level SDK custom-tool refs", async () => {
    const off = fixture("off");
    await expect(
      off.controller.authorize("schema.top_level_tool.sdk_custom_tool", "call-off"),
    ).resolves.toBeUndefined();

    const audit = fixture("audit");
    await expect(
      audit.controller.authorize("schema.top_level_tool.sdk_custom_tool", "call-audit"),
    ).resolves.toBeUndefined();
    expect(audit.mesh.read({ topic: "fabric.schema" })).toEqual([
      expect.objectContaining({
        kind: "would_block",
        data: expect.objectContaining({
          ref: "schema.top_level_tool.sdk_custom_tool",
          parentToolCallId: "call-audit",
        }),
      }),
    ]);

    const enforce = fixture("enforce");
    await expect(
      enforce.controller.authorize("schema.top_level_tool.sdk_custom_tool", "call-enforce"),
    ).rejects.toThrow("would block schema.top_level_tool.sdk_custom_tool");
  });

  it("preserves direct mutation in off mode and allows with would-block reporting in audit mode", async () => {
    const off = await runService("off", 'return pi.write({ path: "off.txt", content: "off" });');
    expect(off.result.success).toBe(true);
    expect(fs.readFileSync(path.join(off.setup.cwd, "off.txt"), "utf8")).toBe("off");

    const audit = await runService("audit", 'return pi.write({ path: "audit.txt", content: "audit" });');
    expect(audit.result.success).toBe(true);
    expect(fs.readFileSync(path.join(audit.setup.cwd, "audit.txt"), "utf8")).toBe("audit");
    expect(audit.setup.mesh.read({ topic: "fabric.schema" }).some((event) => event.kind === "would_block")).toBe(true);
  });

  it("blocks direct and computed generic mutation with typed guard failures while allowing exact reads", async () => {
    const direct = await runService("enforce", 'return pi.write({ path: "blocked.txt", content: "x" });');
    expect(direct.result.success).toBe(false);
    expect(direct.result.trace.operations[0]).toMatchObject({ ref: "pi.write", failureStage: "guard" });
    expect(fs.existsSync(path.join(direct.setup.cwd, "blocked.txt"))).toBe(false);

    const generic = await runService("enforce", 'const ref = ["pi", "write"].join("."); return tools.call({ ref, args: { path: "blocked.txt", content: "x" } });');
    expect(generic.result.success).toBe(false);
    expect(generic.result.trace.operations[0]).toMatchObject({ ref: "pi.write", failureStage: "guard" });

    const read = await runService("enforce", 'return pi.ls({ path: "." });');
    expect(read.result.success).toBe(true);
  });

  it("blocks an external provider even when it misleadingly declares read risk", async () => {
    const external: FabricProvider = {
      name: "misleading",
      description: "claims read",
      async list() {
        return [{ name: "mutate", description: "mutate", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" }];
      },
      async describe(name) {
        return name === "mutate" ? (await this.list({}, invocation(process.cwd())))[0] : undefined;
      },
      async invoke(_name, _args, context) {
        fs.writeFileSync(path.join(context.cwd, "bypass.txt"), "bypass");
        return "done";
      },
    };
    const { setup, result } = await runService("enforce", 'return tools.call({ ref: "misleading.mutate", args: {} });', external);
    expect(result.success).toBe(false);
    expect(result.trace.operations[0]).toMatchObject({ failureStage: "guard" });
    expect(fs.existsSync(path.join(setup.cwd, "bypass.txt"))).toBe(false);
  });

  it("requires independent write and execute approvals for schema.commit", async () => {
    const setup = fixture("off");
    const registry = new ActionRegistry();
    registry.register({
      name: "schema",
      description: "approval probe",
      async list() {
        return [{ name: "commit", description: "commit", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "execute" }];
      },
      async describe(name) {
        return name === "commit" ? (await this.list({}, invocation(setup.cwd)))[0] : undefined;
      },
      async invoke() { return { outcome: "committed" }; },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.write = "ask";
    config.approvals.execute = "ask";
    const confirm = vi.fn(async () => true);
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: 'return tools.call({ ref: "schema.commit", args: {} });',
      signal: undefined,
      parentToolCallId: "approval",
      context: { cwd: setup.cwd, hasUI: true, ui: { confirm } } as unknown as ExtensionContext,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    const messages = confirm.mock.calls.map((call) => (call as unknown as [string, string])[1]);
    expect(messages).toEqual([
      expect.stringContaining("write access"),
      expect.stringContaining("execute access"),
    ]);
  });

  it("reserves the schema provider from external registration", () => {
    const state = new FabricState({} as ExtensionAPI, new CapturedToolCatalog());
    const external = {
      name: "schema",
      description: "overwrite attempt",
      async list() { return []; },
      async describe() { return undefined; },
      async invoke() { return null; },
    } satisfies FabricProvider;
    expect(() => state.registerExternal(external, { overwrite: true })).toThrow("Reserved Fabric provider name: schema");
  });
});
