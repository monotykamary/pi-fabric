import fs from "node:fs";
import path from "node:path";
import type { SessionRef } from "./discovery.js";
import type { LiveSessionBranch, MemoryBranches } from "./lineage.js";
import type { MemoryIndexOptions } from "./index.js";

interface SourceIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

export interface SourceObservation {
  file: string;
  identity: SourceIdentity;
  liveBranchSignature: string | null;
}

type LiveBranchResolver = MemoryIndexOptions["liveBranchForFile"];

const sourceIdentity = (file: string): SourceIdentity | null => {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) return null;
    return {
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      modifiedAt: stat.mtimeNs,
      changedAt: stat.ctimeNs,
    };
  } catch {
    return null;
  }
};

const sameSourceIdentity = (left: SourceIdentity, right: SourceIdentity): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.modifiedAt === right.modifiedAt &&
  left.changedAt === right.changedAt;

const liveBranchSignature = (branch: LiveSessionBranch | undefined): string | null =>
  branch ? `${branch.leafId ?? ""}\0${branch.entries.length}` : null;

export const observeSource = (
  file: string,
  branches: MemoryBranches,
  liveBranch: LiveSessionBranch | undefined,
): SourceObservation | null => {
  const identity = sourceIdentity(file);
  if (!identity) return null;
  return {
    file: path.resolve(file),
    identity,
    liveBranchSignature: branches === "active" ? liveBranchSignature(liveBranch) : null,
  };
};

export const observeSources = (
  refs: readonly SessionRef[],
  branches: MemoryBranches,
  liveResolver: LiveBranchResolver,
): SourceObservation[] | null => {
  const observations: SourceObservation[] = [];
  for (const ref of refs) {
    const liveBranch = branches === "active" ? liveResolver?.(ref.file) : undefined;
    const observation = observeSource(ref.file, branches, liveBranch);
    if (!observation) return null;
    observations.push(observation);
  }
  return observations;
};

export const sameSourceObservation = (left: SourceObservation, right: SourceObservation): boolean =>
  left.file === right.file &&
  sameSourceIdentity(left.identity, right.identity) &&
  left.liveBranchSignature === right.liveBranchSignature;

export const sameSourceObservations = (
  left: readonly SourceObservation[],
  right: readonly SourceObservation[],
): boolean => left.length === right.length && left.every((item, index) =>
  sameSourceObservation(item, right[index]!)
);
