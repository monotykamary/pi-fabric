import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  detectPiHostVersion,
  MINIMUM_PI_HOST_VERSION,
  piHostCompatibilityWarning,
} from "../src/host-compatibility.js";

const roots: string[] = [];

const fakeHost = (version: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-version-"));
  roots.push(root);
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
  );
  const cli = path.join(dist, "cli.js");
  fs.writeFileSync(cli, "");
  return cli;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi host compatibility", () => {
  it("compares release and prerelease versions", () => {
    expect(compareVersions("0.80.5", MINIMUM_PI_HOST_VERSION)).toBeLessThan(0);
    expect(compareVersions("0.80.6", MINIMUM_PI_HOST_VERSION)).toBe(0);
    expect(compareVersions("0.80.10", MINIMUM_PI_HOST_VERSION)).toBeGreaterThan(0);
    expect(compareVersions("0.80.6-beta.1", MINIMUM_PI_HOST_VERSION)).toBeLessThan(0);
    expect(compareVersions("invalid", MINIMUM_PI_HOST_VERSION)).toBeUndefined();
  });

  it("detects the host package from the CLI path", () => {
    expect(detectPiHostVersion(fakeHost("0.80.10"))).toBe("0.80.10");
    expect(detectPiHostVersion("/does/not/exist")).toBeUndefined();
  });

  it("warns only for a detected unsupported host", () => {
    expect(piHostCompatibilityWarning("0.80.5")).toContain("requires Pi >= 0.80.6");
    expect(piHostCompatibilityWarning("0.80.6")).toBeUndefined();
    expect(piHostCompatibilityWarning(undefined)).toBeUndefined();
  });
});
