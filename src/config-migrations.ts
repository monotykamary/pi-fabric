export const CURRENT_FABRIC_CONFIG_VERSION = 1;

export interface FabricConfigMigrationResult {
  document: Record<string, unknown>;
  fromVersion: number;
  toVersion: number;
  appliedVersions: number[];
  changed: boolean;
}

interface FabricConfigMigration {
  from: number;
  to: number;
  migrate(document: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isObject(current) && isObject(value) ? mergeObjects(current, value) : value;
  }
  return merged;
};

const migrations: readonly FabricConfigMigration[] = [
  {
    from: 0,
    to: 1,
    migrate(document) {
      const migrated = { ...document };
      const legacy = migrated.subagents;
      const canonical = migrated.agents;
      if (legacy !== undefined) {
        if (canonical !== undefined && isObject(legacy) !== isObject(canonical)) {
          throw new Error(
            "Fabric configuration cannot merge legacy subagents with a malformed agents section",
          );
        }
        migrated.agents = isObject(legacy) && isObject(canonical)
          ? mergeObjects(legacy, canonical)
          : canonical ?? legacy;
      }
      delete migrated.subagents;
      return migrated;
    },
  },
];

const configVersion = (document: Readonly<Record<string, unknown>>): number => {
  const value = document.configVersion;
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("Fabric configuration configVersion must be a non-negative integer");
  }
  if (value > CURRENT_FABRIC_CONFIG_VERSION) {
    throw new Error(
      `Fabric configuration version ${value} is newer than supported version ${CURRENT_FABRIC_CONFIG_VERSION}`,
    );
  }
  return value;
};

export const migrateFabricConfigDocument = (
  input: Readonly<Record<string, unknown>>,
): FabricConfigMigrationResult => {
  const fromVersion = configVersion(input);
  let version = fromVersion;
  let document = structuredClone(input) as Record<string, unknown>;
  const appliedVersions: number[] = [];

  while (version < CURRENT_FABRIC_CONFIG_VERSION) {
    const migration = migrations.find((candidate) => candidate.from === version);
    if (!migration || migration.to !== version + 1) {
      throw new Error(`No Fabric configuration migration exists for version ${version}`);
    }
    document = migration.migrate(document);
    version = migration.to;
    document.configVersion = version;
    appliedVersions.push(version);
  }

  if (Object.hasOwn(document, "subagents")) {
    throw new Error("Current Fabric configuration contains removed key subagents");
  }

  return {
    document,
    fromVersion,
    toVersion: version,
    appliedVersions,
    changed: appliedVersions.length > 0,
  };
};
