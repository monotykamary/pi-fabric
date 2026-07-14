import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
}

const packageName = (specifier: string): string =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? specifier);

describe("package manifest", () => {
  it("installs every standalone worker import as a runtime dependency", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as PackageManifest;
    const worker = fs.readFileSync(path.join(root, "src", "worker.ts"), "utf8");
    const imports = [...worker.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((specifier): specifier is string =>
        Boolean(specifier && !specifier.startsWith(".") && !specifier.startsWith("node:")),
      )
      .map(packageName);

    for (const dependency of new Set(imports)) {
      expect(
        manifest.dependencies?.[dependency],
        `${dependency} is imported by the standalone worker but is not installed at runtime`,
      ).toBeDefined();
    }
  });
});
