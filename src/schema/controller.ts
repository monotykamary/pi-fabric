import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FabricTraceSafeError } from "../audit/trace.js";
import { schemaRefAllowedInEnforce } from "./policy.js";
import { writeJsonAtomic } from "../core/atomic-write.js";
import type { FabricSchemaConfig, FabricSchemaTrustedCommand } from "../config.js";
import type { MeshIdentity, MeshStateEntry, MeshStore } from "../mesh/store.js";
import type { FabricInvocationContext } from "../protocol.js";
import type { StateStore } from "../state/store.js";
import {
  type SchemaCertificateRecord,
  type SchemaEvidence,
  type SchemaEvidenceResult,
  type SchemaFileOperation,
  type SchemaHypothesisRecord,
  type SchemaWorkspaceRecord,
  stateBinding,
} from "./types.js";
import {
  resolveWorkspaceFile,
  sha256File,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "./workspace.js";

const SCHEMA_TOPIC = "fabric.schema";
const WORKSPACE_KEY = "schema/workspace";
const HYPOTHESIS_PREFIX = "schema/hypothesis/";
const CERTIFICATE_PREFIX = "schema/certificate/";
const OUTPUT_LIMIT = 64 * 1024;

interface BeforeImage {
  path: string;
  absolute: string;
  existed: boolean;
  content?: string;
  mode?: number;
}

interface TransactionJournal {
  format: 1;
  id: string;
  status: "prepared" | "applying" | "committed" | "rolled_back" | "quarantined";
  before: BeforeImage[];
  createdAt: number;
  error?: string;
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const sameBinding = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const atomicJsonWrite = (filePath: string, value: unknown): void => {
  writeJsonAtomic(filePath, value, { newline: true });
};



const operationPath = (operation: SchemaFileOperation): string => operation.path;

export class SchemaController {
  readonly #activeHypotheses = new Map<string, string>();
  readonly #activeCertificates = new Map<string, string>();
  readonly #journalRoot: string;
  readonly #lockPath: string;

  constructor(
    readonly cwd: string,
    readonly config: FabricSchemaConfig,
    readonly mesh: MeshStore,
    readonly identity: MeshIdentity,
    readonly state?: StateStore,
  ) {
    this.cwd = fs.realpathSync(cwd);
    this.#journalRoot = path.join(mesh.root, "schema-transactions");
    this.#lockPath = path.join(this.#journalRoot, ".commit.lock");
    this.#recoverJournals();
  }

  async authorize(ref: string, parentToolCallId: string): Promise<void> {
    if (this.config.mode === "off" || schemaRefAllowedInEnforce(ref)) return;
    const message = `Schema ${this.config.mode} policy would block ${ref}: protected workspace mutations and external effects must use schema.commit`;
    if (this.config.mode === "audit") {
      try {
        await this.#publish("would_block", { ref, parentToolCallId, message });
      } catch {
        // Audit reporting is best-effort; audit mode must preserve current behavior.
      }
      return;
    }
    try {
      await this.#publish("blocked", { ref, parentToolCallId, message });
    } catch {
      // The authorization decision remains fail-closed if reporting is unavailable.
    }
    throw new FabricTraceSafeError(message);
  }

  status(parentToolCallId?: string): Record<string, unknown> {
    const workspace = this.#workspaceEntry();
    const hypotheses = this.mesh
      .list(HYPOTHESIS_PREFIX, this.mesh.maxReadEvents)
      .map((entry) => entry.value as SchemaHypothesisRecord)
      .filter((record) => !parentToolCallId || record.parentToolCallId === parentToolCallId)
      .map((record) => ({
        id: record.id,
        label: record.label,
        status: record.status,
        generation: record.generation,
        updatedAt: record.updatedAt,
      }));
    return {
      mode: this.config.mode,
      certificateTtlMs: this.config.certificateTtlMs,
      maxFiles: this.config.maxFiles,
      maxBytes: this.config.maxBytes,
      trustedCommands: Object.keys(this.config.trustedCommands).sort(),
      generation: (workspace?.value as SchemaWorkspaceRecord | undefined)?.generation ?? 0,
      lastOutcome: (workspace?.value as SchemaWorkspaceRecord | undefined)?.lastOutcome ?? null,
      hypotheses,
    };
  }

  async hypothesize(
    input: {
      label: string;
      summary: string;
      evidence: SchemaEvidence[];
      complexityReduction?: boolean;
    },
    context: FabricInvocationContext,
  ): Promise<Record<string, unknown>> {
    if (!input.label.trim() || !input.summary.trim()) throw new Error("Schema hypothesis label and summary must not be empty");
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new Error("Schema hypothesis requires nonempty typed evidence");
    }
    if (input.evidence.length > this.config.maxFiles) {
      throw new Error(`Schema hypothesis exceeds ${this.config.maxFiles} evidence items`);
    }
    this.#assertPayloadBound(input);
    const snapshot = snapshotWorkspace(this.cwd, [this.mesh.root]);
    const generation = this.#generation();
    const now = Date.now();
    const record: SchemaHypothesisRecord = {
      id: randomUUID(),
      label: input.label,
      summary: input.summary,
      evidence: input.evidence,
      complexityReduction: input.complexityReduction === true,
      parentToolCallId: context.parentToolCallId,
      state: stateBinding(this.state?.getHead() ?? null),
      fingerprint: snapshot.fingerprint,
      generation,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.#publish("hypothesized", record);
    await this.mesh.put({
      key: `${HYPOTHESIS_PREFIX}${record.id}`,
      value: record,
      ifVersion: 0,
      identity: this.identity,
    });
    this.#activeHypotheses.set(record.id, context.parentToolCallId);
    context.update(`Schema hypothesis recorded: ${record.label}`);
    return {
      hypothesisId: record.id,
      status: record.status,
      state: record.state,
      fingerprint: record.fingerprint,
      generation,
    };
  }

  async verify(
    hypothesisId: string,
    context: FabricInvocationContext,
  ): Promise<Record<string, unknown>> {
    const entry = this.#requireHypothesis(hypothesisId);
    const record = entry.value as SchemaHypothesisRecord;
    this.#assertInvocation(record.parentToolCallId, context.parentToolCallId);
    if (record.status !== "active") throw new Error(`Schema hypothesis is not active: ${record.status}`);
    if (record.evidence.length === 0) return this.#failedVerification(record, [], "missing evidence");

    let before: WorkspaceSnapshot;
    try {
      before = snapshotWorkspace(this.cwd, [this.mesh.root]);
    } catch (error) {
      return this.#failedVerification(record, [], `workspace snapshot failed: ${errorMessage(error)}`);
    }
    const currentState = stateBinding(this.state?.getHead() ?? null);
    if (!sameBinding(record.state, currentState)) {
      return this.#failedVerification(record, [], "state head changed since hypothesis");
    }
    if (record.generation !== this.#generation()) {
      return this.#failedVerification(record, [], "workspace generation changed since hypothesis");
    }
    if (record.fingerprint !== before.fingerprint) {
      return this.#failedVerification(record, [], "workspace fingerprint changed since hypothesis");
    }

    const results = await this.#verifyEvidence(record.evidence, context);
    let after: WorkspaceSnapshot;
    try {
      after = snapshotWorkspace(this.cwd, [this.mesh.root]);
    } catch (error) {
      return this.#failedVerification(record, results, `post-evidence snapshot failed: ${errorMessage(error)}`);
    }
    const allConfirmed = results.length > 0 && results.every((result) => result.status === "confirmed");
    if (!allConfirmed || before.fingerprint !== after.fingerprint) {
      const reason = before.fingerprint !== after.fingerprint
        ? "workspace fingerprint changed while evidence ran"
        : "one or more evidence items were not confirmed";
      return this.#failedVerification(record, results, reason);
    }

    const certificate = randomBytes(32).toString("hex");
    const issuedAt = Date.now();
    const certificateRecord: SchemaCertificateRecord = {
      tokenHash: hashToken(certificate),
      hypothesisId: record.id,
      parentToolCallId: context.parentToolCallId,
      state: record.state,
      fingerprint: record.fingerprint,
      generation: record.generation,
      issuedAt,
      expiresAt: issuedAt + this.config.certificateTtlMs,
      status: "active",
    };
    const certificateKey = `${CERTIFICATE_PREFIX}${certificateRecord.tokenHash}`;
    await this.mesh.put({
      key: certificateKey,
      value: certificateRecord,
      ifVersion: 0,
      identity: this.identity,
    });
    try {
      await this.mesh.put({
        key: entry.key,
        value: { ...record, status: "verified", updatedAt: Date.now() },
        ifVersion: entry.version,
        identity: this.identity,
      });
    } catch (error) {
      const certificateEntry = this.mesh.get(certificateKey);
      if (certificateEntry) {
        await this.mesh.put({
          key: certificateKey,
          value: { ...certificateRecord, status: "aborted" },
          ifVersion: certificateEntry.version,
          identity: this.identity,
        });
      }
      throw error;
    }
    this.#activeCertificates.set(certificateRecord.tokenHash, context.parentToolCallId);
    try {
      await this.#publish("verified", {
        hypothesisId: record.id,
        tokenHash: certificateRecord.tokenHash,
        results: results.map((result) => ({
          kind: result.evidence.kind,
          status: result.status,
          detail: result.detail,
        })),
        state: record.state,
        fingerprint: record.fingerprint,
        generation: record.generation,
        issuedAt,
        expiresAt: certificateRecord.expiresAt,
      });
    } catch {
      // The certificate and verified hypothesis records are already durable.
    }
    context.update(`Schema evidence confirmed; certificate expires in ${this.config.certificateTtlMs}ms`);
    return {
      verified: true,
      hypothesisId: record.id,
      certificate,
      issuedAt,
      expiresAt: certificateRecord.expiresAt,
      results,
    };
  }

  async commit(
    input: {
      hypothesisId: string;
      certificate: string;
      operations: SchemaFileOperation[];
      postconditions: SchemaEvidence[];
    },
    context: FabricInvocationContext,
  ): Promise<Record<string, unknown>> {
    if (input.operations.length === 0) throw new Error("Schema commit requires at least one file operation");
    if (input.postconditions.length === 0) throw new Error("Schema commit requires nonempty typed postconditions");
    if (input.operations.length > this.config.maxFiles) {
      throw new Error(`Schema transaction exceeds ${this.config.maxFiles} operations`);
    }
    if (input.postconditions.length > this.config.maxFiles) {
      throw new Error(`Schema transaction exceeds ${this.config.maxFiles} postconditions`);
    }
    this.#assertPayloadBound(input);
    const release = this.#acquireCommitLock();
    const transactionId = randomUUID();
    const journalPath = path.join(this.#journalRoot, `${transactionId}.json`);
    let journal: TransactionJournal | undefined;
    let consumed = false;
    let committed = false;
    try {
      const tokenHash = hashToken(input.certificate);
      const certificateEntry = this.mesh.get(`${CERTIFICATE_PREFIX}${tokenHash}`);
      if (!certificateEntry) throw new Error("Unknown Schema certificate");
      const certificate = certificateEntry.value as SchemaCertificateRecord;
      if (certificate.status !== "active") throw new Error(`Schema certificate is ${certificate.status}`);
      if (certificate.hypothesisId !== input.hypothesisId) throw new Error("Schema certificate is bound to a different hypothesis");
      this.#assertInvocation(certificate.parentToolCallId, context.parentToolCallId);
      if (Date.now() > certificate.expiresAt) throw new Error("Schema certificate expired");
      const hypothesisEntry = this.#requireHypothesis(input.hypothesisId);
      const hypothesis = hypothesisEntry.value as SchemaHypothesisRecord;
      if (hypothesis.status !== "verified") throw new Error(`Schema hypothesis is not verified: ${hypothesis.status}`);
      if (!sameBinding(certificate.state, stateBinding(this.state?.getHead() ?? null))) {
        throw new Error("Schema state head changed after verification");
      }
      if (certificate.generation !== this.#generation()) throw new Error("Schema workspace generation is stale");
      const baseline = snapshotWorkspace(this.cwd, [this.mesh.root]);
      if (baseline.fingerprint !== certificate.fingerprint) throw new Error("Schema workspace fingerprint is stale");

      const declared = new Map<string, ReturnType<typeof resolveWorkspaceFile>>();
      let payloadBytes = 0;
      for (const operation of input.operations) {
        const resolved = resolveWorkspaceFile(this.cwd, operationPath(operation), {
          allowAbsent: true,
        });
        declared.set(resolved.relative, resolved);
        if (operation.kind === "write") payloadBytes += Buffer.byteLength(operation.content);
        if (operation.kind === "edit") payloadBytes += Buffer.byteLength(operation.newText);
      }
      if (declared.size > this.config.maxFiles) throw new Error(`Schema transaction exceeds ${this.config.maxFiles} files`);
      const before: BeforeImage[] = [];
      let beforeBytes = 0;
      for (const resolved of declared.values()) {
        if (!resolved.exists) {
          before.push({ path: resolved.relative, absolute: resolved.absolute, existed: false });
          continue;
        }
        const content = fs.readFileSync(resolved.absolute);
        beforeBytes += content.byteLength;
        before.push({
          path: resolved.relative,
          absolute: resolved.absolute,
          existed: true,
          content: content.toString("base64"),
          mode: fs.statSync(resolved.absolute).mode & 0o777,
        });
      }
      if (payloadBytes + beforeBytes > this.config.maxBytes) {
        throw new Error(`Schema transaction exceeds ${this.config.maxBytes} bytes`);
      }
      journal = { format: 1, id: transactionId, status: "prepared", before, createdAt: Date.now() };
      atomicJsonWrite(journalPath, journal);

      await this.mesh.put({
        key: certificateEntry.key,
        value: { ...certificate, status: "consumed", consumedAt: Date.now() },
        ifVersion: certificateEntry.version,
        identity: this.identity,
      });
      consumed = true;
      journal.status = "applying";
      atomicJsonWrite(journalPath, journal);
      const afterConsume = snapshotWorkspace(this.cwd, [this.mesh.root]);
      if (afterConsume.fingerprint !== certificate.fingerprint) {
        throw new Error("Schema workspace drifted while consuming the certificate");
      }

      for (const operation of input.operations) this.#applyOperation(operation);
      const applied = snapshotWorkspace(this.cwd, [this.mesh.root]);
      this.#assertNoOutsideDrift(baseline, applied, new Set(declared.keys()));
      const postconditionResults = await this.#verifyEvidence(input.postconditions, context);
      const afterPostconditions = snapshotWorkspace(this.cwd, [this.mesh.root]);
      if (applied.fingerprint !== afterPostconditions.fingerprint) {
        throw new Error("Schema workspace changed while postconditions ran");
      }
      if (!postconditionResults.every((result) => result.status === "confirmed")) {
        throw new Error("Schema commit postconditions were not all confirmed");
      }

      const workspaceEntry = this.#workspaceEntry();
      const nextGeneration = certificate.generation + 1;
      await this.mesh.put({
        key: WORKSPACE_KEY,
        value: {
          generation: nextGeneration,
          lastOutcome: "committed",
          lastTransactionId: transactionId,
          updatedAt: Date.now(),
        } satisfies SchemaWorkspaceRecord,
        ifVersion: workspaceEntry?.version ?? 0,
        identity: this.identity,
      });
      committed = true;
      journal.status = "committed";
      try {
        atomicJsonWrite(journalPath, journal);
      } catch {
        // Recovery cross-checks the authoritative committed workspace record.
      }

      let stateTransition: unknown = null;
      try {
        stateTransition = this.state
          ? await this.state.transition(
              {
                label: `schema:${hypothesis.label}`,
                ...(certificate.state ? { from: certificate.state.to } : {}),
                to: `schema-commit-${nextGeneration}`,
                summary: hypothesis.summary,
              },
              this.identity,
              this.cwd,
            )
          : null;
      } catch (error) {
        stateTransition = { error: errorMessage(error) };
      }
      try {
        await this.mesh.put({
          key: hypothesisEntry.key,
          value: { ...hypothesis, status: "committed", updatedAt: Date.now() },
          ifVersion: hypothesisEntry.version,
          identity: this.identity,
        });
      } catch {
        // The committed workspace generation and outcome remain authoritative.
      }
      try {
        await this.#publish("committed", {
          transactionId,
          hypothesisId: hypothesis.id,
          generation: nextGeneration,
          paths: [...declared.keys()],
          postconditions: postconditionResults.map((result) => ({
            kind: result.evidence.kind,
            status: result.status,
            detail: result.detail,
          })),
          complexityReductionCertified: hypothesis.complexityReduction,
          stateTransition,
        });
      } catch {
        // schema/workspace is the authoritative durable committed outcome.
      }
      this.#activeHypotheses.delete(hypothesis.id);
      this.#activeCertificates.delete(tokenHash);
      context.update(`Schema transaction committed at generation ${nextGeneration}`);
      return {
        outcome: "committed",
        transactionId,
        generation: nextGeneration,
        paths: [...declared.keys()],
        postconditions: postconditionResults,
        complexityReductionCertified: hypothesis.complexityReduction,
        stateTransition,
      };
    } catch (error) {
      if (!consumed) throw error;
      if (committed) throw error;
      const rollbackError = journal ? this.#restoreBeforeImages(journal.before) : undefined;
      const outcome = rollbackError ? "quarantined" : "rolled_back";
      if (journal) {
        journal.status = outcome;
        journal.error = rollbackError
          ? `${errorMessage(error)}; rollback failed: ${rollbackError}`
          : errorMessage(error);
        try {
          atomicJsonWrite(journalPath, journal);
        } catch {
          // The mesh outcome record below remains the durable fallback.
        }
      }
      await this.#recordFailedOutcome(outcome, transactionId, errorMessage(error), rollbackError);
      context.update(`Schema transaction ${outcome}`);
      return {
        outcome,
        transactionId,
        error: errorMessage(error),
        ...(rollbackError ? { rollbackError } : {}),
      };
    } finally {
      release();
    }
  }

  async abort(
    input: { hypothesisId: string; certificate?: string },
    context: FabricInvocationContext,
  ): Promise<Record<string, unknown>> {
    const hypothesisEntry = this.#requireHypothesis(input.hypothesisId);
    const hypothesis = hypothesisEntry.value as SchemaHypothesisRecord;
    this.#assertInvocation(hypothesis.parentToolCallId, context.parentToolCallId);
    if (hypothesis.status === "committed") throw new Error("Committed Schema hypotheses cannot be aborted");
    if (input.certificate) {
      const tokenHash = hashToken(input.certificate);
      const certificateEntry = this.mesh.get(`${CERTIFICATE_PREFIX}${tokenHash}`);
      if (!certificateEntry) throw new Error("Unknown Schema certificate");
      const certificate = certificateEntry.value as SchemaCertificateRecord;
      this.#assertInvocation(certificate.parentToolCallId, context.parentToolCallId);
      if (certificate.status !== "active") throw new Error(`Schema certificate is ${certificate.status}`);
      await this.mesh.put({
        key: certificateEntry.key,
        value: { ...certificate, status: "aborted" },
        ifVersion: certificateEntry.version,
        identity: this.identity,
      });
      this.#activeCertificates.delete(tokenHash);
    }
    await this.mesh.put({
      key: hypothesisEntry.key,
      value: { ...hypothesis, status: "aborted", updatedAt: Date.now() },
      ifVersion: hypothesisEntry.version,
      identity: this.identity,
    });
    this.#activeHypotheses.delete(hypothesis.id);
    await this.#publish("aborted", { hypothesisId: hypothesis.id, parentToolCallId: context.parentToolCallId });
    return { aborted: true, hypothesisId: hypothesis.id };
  }

  async endInvocation(parentToolCallId: string): Promise<void> {
    for (const [tokenHash, invocation] of [...this.#activeCertificates]) {
      if (invocation !== parentToolCallId) continue;
      const entry = this.mesh.get(`${CERTIFICATE_PREFIX}${tokenHash}`);
      if (entry) {
        const record = entry.value as SchemaCertificateRecord;
        if (record.status === "active") {
          try {
            await this.mesh.put({
              key: entry.key,
              value: { ...record, status: "abandoned" },
              ifVersion: entry.version,
              identity: this.identity,
            });
          } catch {
            // A concurrent consume wins; the certificate is no longer active.
          }
        }
      }
      this.#activeCertificates.delete(tokenHash);
    }
    for (const [hypothesisId, invocation] of [...this.#activeHypotheses]) {
      if (invocation !== parentToolCallId) continue;
      const entry = this.mesh.get(`${HYPOTHESIS_PREFIX}${hypothesisId}`);
      if (entry) {
        const record = entry.value as SchemaHypothesisRecord;
        if (record.status === "active" || record.status === "verified") {
          try {
            await this.mesh.put({
              key: entry.key,
              value: { ...record, status: "abandoned", updatedAt: Date.now() },
              ifVersion: entry.version,
              identity: this.identity,
            });
          } catch {
            // A concurrent terminal transition wins.
          }
        }
      }
      this.#activeHypotheses.delete(hypothesisId);
    }
  }

  async #failedVerification(
    record: SchemaHypothesisRecord,
    results: SchemaEvidenceResult[],
    reason: string,
  ): Promise<Record<string, unknown>> {
    try {
      await this.#publish("verification_failed", {
        hypothesisId: record.id,
        reason,
        results: results.map((result) => ({ kind: result.evidence.kind, status: result.status, detail: result.detail })),
      });
    } catch {
      // Returning the fail-closed result must not depend on audit capacity.
    }
    return { verified: false, hypothesisId: record.id, reason, results };
  }

  async #verifyEvidence(
    evidence: SchemaEvidence[],
    context: FabricInvocationContext,
  ): Promise<SchemaEvidenceResult[]> {
    if (evidence.length === 0) return [];
    const results: SchemaEvidenceResult[] = [];
    for (const item of evidence) {
      if (context.signal?.aborted) {
        results.push({ evidence: item, status: "error", detail: "cancelled" });
        continue;
      }
      try {
        if (item.kind === "trusted_command") {
          const command = this.config.trustedCommands[item.name];
          if (!command) {
            results.push({ evidence: item, status: "nonconfirmed", detail: `trusted command is not configured: ${item.name}` });
          } else {
            results.push(await this.#runTrustedCommand(item, command, context.signal));
          }
          continue;
        }
        const resolved = resolveWorkspaceFile(this.cwd, item.path, {
          allowAbsent: item.kind === "file_absent",
        });
        if (item.kind === "file_absent") {
          results.push({
            evidence: item,
            status: resolved.exists ? "nonconfirmed" : "confirmed",
            detail: resolved.exists ? "file exists" : "file is absent",
          });
        } else if (item.kind === "file_exists") {
          results.push({
            evidence: item,
            status: "confirmed",
            detail: "file exists",
            observedSha256: sha256File(resolved.absolute),
          });
        } else if (item.kind === "file_contains") {
          const confirmed = fs.readFileSync(resolved.absolute, "utf8").includes(item.literal);
          results.push({
            evidence: item,
            status: confirmed ? "confirmed" : "nonconfirmed",
            detail: confirmed ? "literal found" : "literal not found",
            observedSha256: sha256File(resolved.absolute),
          });
        } else {
          const actual = sha256File(resolved.absolute);
          results.push({
            evidence: item,
            status: actual === item.sha256 ? "confirmed" : "nonconfirmed",
            detail: actual,
            observedSha256: actual,
          });
        }
      } catch (error) {
        results.push({ evidence: item, status: "error", detail: errorMessage(error) });
      }
    }
    return results;
  }

  #runTrustedCommand(
    evidence: Extract<SchemaEvidence, { kind: "trusted_command" }>,
    command: FabricSchemaTrustedCommand,
    signal?: AbortSignal,
  ): Promise<SchemaEvidenceResult> {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (status: SchemaEvidenceResult["status"], detail: string, exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ evidence, status, detail, exitCode, output });
      };
      let child;
      try {
        child = spawn(command.command, command.shell ? [] : command.args, {
          cwd: this.cwd,
          shell: command.shell,
          stdio: ["ignore", "pipe", "pipe"],
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        resolve({ evidence, status: "error", detail: errorMessage(error), exitCode: null });
        return;
      }
      const append = (chunk: Buffer): void => {
        if (output.length < OUTPUT_LIMIT) output += chunk.toString().slice(0, OUTPUT_LIMIT - output.length);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => finish("error", error.message, null));
      child.on("close", (code) => {
        const exitCode = typeof code === "number" ? code : null;
        finish(exitCode === 0 ? "confirmed" : exitCode === null ? "error" : "nonconfirmed", exitCode === 0 ? "exit 0" : `exit ${exitCode ?? "signal"}`, exitCode);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish("error", `timeout after ${command.timeoutMs}ms`, null);
      }, command.timeoutMs);
      timer.unref?.();
    });
  }

  #applyOperation(operation: SchemaFileOperation): void {
    const resolved = resolveWorkspaceFile(this.cwd, operation.path, { allowAbsent: operation.kind === "write" });
    if (operation.kind === "write") {
      if ("absent" in operation.expected) {
        if (resolved.exists) throw new Error(`Schema precondition failed; expected absent: ${operation.path}`);
      } else {
        if (!resolved.exists || sha256File(resolved.absolute) !== operation.expected.sha256) {
          throw new Error(`Schema precondition SHA-256 mismatch: ${operation.path}`);
        }
      }
      fs.writeFileSync(resolved.absolute, operation.content, "utf8");
      return;
    }
    if (sha256File(resolved.absolute) !== operation.expectedSha256) {
      throw new Error(`Schema precondition SHA-256 mismatch: ${operation.path}`);
    }
    if (operation.kind === "delete") {
      fs.unlinkSync(resolved.absolute);
      return;
    }
    const content = fs.readFileSync(resolved.absolute, "utf8");
    const first = content.indexOf(operation.oldText);
    if (first < 0 || content.indexOf(operation.oldText, first + operation.oldText.length) >= 0) {
      throw new Error(`Schema edit requires oldText to occur exactly once: ${operation.path}`);
    }
    fs.writeFileSync(resolved.absolute, `${content.slice(0, first)}${operation.newText}${content.slice(first + operation.oldText.length)}`, "utf8");
  }

  #assertNoOutsideDrift(before: WorkspaceSnapshot, after: WorkspaceSnapshot, declared: Set<string>): void {
    if (before.git !== after.git || before.head !== after.head || before.indexDigest !== after.indexDigest) {
      throw new Error("Schema detected Git HEAD or index drift during commit");
    }
    const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
    for (const file of paths) {
      if (declared.has(file)) continue;
      if (before.entries[file] !== after.entries[file]) {
        throw new Error(`Schema detected undeclared workspace drift: ${file}`);
      }
    }
  }

  #restoreBeforeImages(images: BeforeImage[]): string | undefined {
    const errors: string[] = [];
    for (const image of [...images].reverse()) {
      try {
        const resolved = resolveWorkspaceFile(this.cwd, image.path, { allowAbsent: true });
        if (!image.existed) {
          if (resolved.exists) fs.unlinkSync(resolved.absolute);
        } else {
          fs.writeFileSync(resolved.absolute, Buffer.from(image.content ?? "", "base64"));
          if (image.mode !== undefined) fs.chmodSync(resolved.absolute, image.mode);
        }
      } catch (error) {
        errors.push(`${image.path}: ${errorMessage(error)}`);
      }
    }
    return errors.length > 0 ? errors.join("; ") : undefined;
  }

  async #recordFailedOutcome(
    outcome: "rolled_back" | "quarantined",
    transactionId: string,
    error: string,
    rollbackError?: string,
  ): Promise<void> {
    try {
      const entry = this.#workspaceEntry();
      await this.mesh.put({
        key: WORKSPACE_KEY,
        value: {
          generation: (entry?.value as SchemaWorkspaceRecord | undefined)?.generation ?? 0,
          lastOutcome: outcome,
          lastTransactionId: transactionId,
          updatedAt: Date.now(),
        } satisfies SchemaWorkspaceRecord,
        ifVersion: entry?.version ?? 0,
        identity: this.identity,
      });
      await this.#publish(outcome, { transactionId, error, ...(rollbackError ? { rollbackError } : {}) });
    } catch {
      // The journal is the durable fallback when mesh outcome recording fails.
    }
  }

  #generation(): number {
    return (this.#workspaceEntry()?.value as SchemaWorkspaceRecord | undefined)?.generation ?? 0;
  }

  #workspaceEntry(): MeshStateEntry | undefined {
    return this.mesh.get(WORKSPACE_KEY);
  }

  #requireHypothesis(id: string): MeshStateEntry {
    const entry = this.mesh.get(`${HYPOTHESIS_PREFIX}${id}`);
    if (!entry) throw new Error(`Unknown Schema hypothesis: ${id}`);
    return entry;
  }

  #assertInvocation(expected: string, actual: string): void {
    if (expected !== actual) throw new Error("Schema artifact belongs to a different fabric_exec invocation");
  }

  #assertPayloadBound(value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.config.maxBytes) throw new Error(`Schema request exceeds ${this.config.maxBytes} bytes`);
  }

  #publish(kind: string, data: unknown): Promise<unknown> {
    return this.mesh.publish({ topic: SCHEMA_TOPIC, kind, from: this.identity, data });
  }

  #acquireCommitLock(): () => void {
    fs.mkdirSync(this.#journalRoot, { recursive: true, mode: 0o700 });
    try {
      const descriptor = fs.openSync(this.#lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n${Date.now()}\n`);
      fs.closeSync(descriptor);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("Another Schema transaction is in progress");
      }
      throw error;
    }
    return () => fs.rmSync(this.#lockPath, { force: true });
  }

  #recoverJournals(): void {
    fs.mkdirSync(this.#journalRoot, { recursive: true, mode: 0o700 });
    try {
      const [pidText] = fs.readFileSync(this.#lockPath, "utf8").split("\n");
      const pid = Number(pidText);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return;
        } catch {
          // The owner is gone; recover its applying journal below.
        }
      }
      fs.rmSync(this.#lockPath, { force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const name of fs.readdirSync(this.#journalRoot)) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(this.#journalRoot, name);
      try {
        const journal = JSON.parse(fs.readFileSync(filePath, "utf8")) as TransactionJournal;
        if (journal.format !== 1 || journal.status !== "applying" || !Array.isArray(journal.before)) continue;
        const workspace = this.#workspaceEntry()?.value as SchemaWorkspaceRecord | undefined;
        if (
          workspace?.lastOutcome === "committed" &&
          workspace.lastTransactionId === journal.id
        ) {
          journal.status = "committed";
          atomicJsonWrite(filePath, journal);
          continue;
        }
        const rollbackError = this.#restoreBeforeImages(journal.before);
        journal.status = rollbackError ? "quarantined" : "rolled_back";
        journal.error = rollbackError ? `crash recovery failed: ${rollbackError}` : "recovered incomplete transaction";
        atomicJsonWrite(filePath, journal);
      } catch {
        // An unreadable journal is retained for operator quarantine and inspection.
      }
    }
  }
}
