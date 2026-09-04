import type { LanguageRegistration } from "shiki";

// Resolve bundled language grammars through pi-fabric's dependency graph.
// Shiki's own lazy imports are not resolvable from Pi's jiti extension host.
const LANGUAGE_IMPORTS = {
  bash: () => import("@shikijs/langs/shellscript"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  css: () => import("@shikijs/langs/css"),
} as const satisfies Record<
  string,
  () => Promise<{ default: LanguageRegistration[] }>
>;

/**
 * Resolve the language registrations used during highlighter initialization.
 * Passing objects prevents Shiki from issuing host-fragile lazy imports.
 */
export async function resolveShikiLanguageObjects(
  languageIds: readonly string[],
): Promise<LanguageRegistration[]> {
  const modules = await Promise.all(
    languageIds.map(async (languageId) => {
      const loader = LANGUAGE_IMPORTS[languageId as keyof typeof LANGUAGE_IMPORTS];
      if (!loader) throw new Error(`Unsupported preloaded Shiki language: ${languageId}`);
      return loader();
    }),
  );
  return modules.flatMap((module) => module.default);
}
