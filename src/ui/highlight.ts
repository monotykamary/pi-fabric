import { basename, extname } from "node:path";
import {
  bundledLanguages,
  bundledThemesInfo,
  createHighlighter,
  type Highlighter,
} from "shiki";

const configuredMaxHighlightChars = Number.parseInt(
  process.env.CODE_PREVIEW_MAX_HIGHLIGHT_CHARS ?? "",
  10,
);
const MAX_HIGHLIGHT_CHARS =
  Number.isFinite(configuredMaxHighlightChars) && configuredMaxHighlightChars > 0
    ? configuredMaxHighlightChars
    : 80_000;
const CACHE_LIMIT = 192;
const CACHE_CHAR_LIMIT = 4_000_000;

const PRELOADED_LANGUAGES = [
  "bash",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "yaml",
  "toml",
  "css",
] as const;

const LANGUAGE_ALIASES = new Map<string, string>([
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["ts", "typescript"],
  ["js", "javascript"],
  ["md", "markdown"],
  ["yml", "yaml"],
  ["py", "python"],
  ["rs", "rust"],
  ["rb", "ruby"],
  ["cs", "csharp"],
  ["fs", "fsharp"],
  ["ps1", "powershell"],
]);

const EXACT_BASENAMES = new Map<string, string>([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["gnumakefile", "makefile"],
  ["justfile", "makefile"],
  ["procfile", "shellscript"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["cargo.lock", "toml"],
  ["package-lock.json", "json"],
  ["composer.lock", "json"],
  ["pnpm-lock.yaml", "yaml"],
  ["pnpm-lock.yml", "yaml"],
  ["yarn.lock", "yaml"],
]);

const EXTENSION_ALIASES = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".json", "json"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".toml", "toml"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".css", "css"],
  [".html", "html"],
  [".htm", "html"],
  [".py", "python"],
  [".rs", "rust"],
  [".go", "go"],
  [".rb", "ruby"],
  [".php", "php"],
  [".sql", "sql"],
  [".xml", "xml"],
  [".svg", "xml"],
  [".vue", "vue"],
  [".svelte", "svelte"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".hpp", "cpp"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".swift", "swift"],
  [".lua", "lua"],
  [".r", "r"],
  [".scala", "scala"],
  [".clj", "clojure"],
  [".ex", "elixir"],
  [".exs", "elixir"],
  [".erl", "erlang"],
  [".hs", "haskell"],
  [".ml", "ocaml"],
  [".fs", "fsharp"],
  [".fsx", "fsharp"],
  [".cs", "csharp"],
  [".ps1", "powershell"],
  [".graphql", "graphql"],
  [".prisma", "prisma"],
  [".dockerfile", "dockerfile"],
]);

const THEME_TYPE = new Map(bundledThemesInfo.map((theme) => [theme.id, theme.type]));
const LOW_CONTRAST_FALLBACK = "\x1b[38;2;139;148;158m";

let highlighter: Highlighter | undefined;
let initializingTheme: string | undefined;
let initVersion = 0;
let highlighterGeneration = 0;
let currentTheme = "dark-plus";
let enabled = true;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Set<string>();
const languageLoadCallbacks = new Map<string, Set<() => void>>();
const highlighterReadyCallbacks = new Set<() => void>();
const renderCache = new Map<string, { value: string[]; size: number }>();
let renderCacheChars = 0;

const hashString = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return hash;
};

const escapeControlChars = (text: string): string =>
  text
    .replace(/\x1b/g, "␛")
    .replace(/\r/g, "␍")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "�");

const normalizeLanguage = (language: string): string => {
  const normalized = language.toLowerCase();
  return LANGUAGE_ALIASES.get(normalized) ?? normalized;
};

/** Resolve a shiki language id from a file path, or undefined if unsupported. */
export function languageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const name = basename(filePath).toLowerCase();
  if (name.startsWith(".env")) {
    const candidate = "dotenv";
    return candidate in bundledLanguages ? candidate : undefined;
  }
  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return "dockerfile" in bundledLanguages ? "dockerfile" : undefined;
  }
  const exact = EXACT_BASENAMES.get(name);
  if (exact && exact in bundledLanguages) return exact;
  const byExt = EXTENSION_ALIASES.get(extname(name));
  return byExt && byExt in bundledLanguages ? byExt : undefined;
}

/** Initialize (or reinitialize) the shared shiki highlighter. Fire-and-forget safe. */
export async function initHighlighting(theme: string, syntaxEnabled = true): Promise<void> {
  currentTheme = theme;
  enabled = syntaxEnabled;
  if (!enabled) return;
  const version = ++initVersion;
  initializingTheme = theme;
  try {
    const next = await createHighlighter({
      themes: [theme],
      langs: [...PRELOADED_LANGUAGES],
    });
    if (version !== initVersion) {
      next.dispose();
      return;
    }
    highlighter?.dispose();
    highlighter = next;
    initializingTheme = undefined;
    highlighterGeneration++;
    loadedLanguages.clear();
    for (const lang of PRELOADED_LANGUAGES) loadedLanguages.add(lang);
    notifyReady();
  } catch (error) {
    if (version !== initVersion) return;
    initializingTheme = undefined;
    console.warn("[pi-fabric] Shiki failed to initialize; previews will be plain text.", error);
    highlighter?.dispose();
    highlighter = undefined;
    highlighterGeneration++;
    loadedLanguages.clear();
    highlighterReadyCallbacks.clear();
  }
}

const shouldSkipHighlight = (text: string): boolean => text.length > MAX_HIGHLIGHT_CHARS;

const ansiFg = (hex: string): string => {
  const clean = hex.replace(/^#/, "").slice(0, 6);
  const n = Number.parseInt(clean, 16);
  return Number.isFinite(n)
    ? `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
    : "";
};

const ansiFromToken = (token: { content: string; color?: string; fontStyle?: number }): string => {
  let open = token.color ? ansiFg(token.color) : "";
  let close = token.color ? "\x1b[39m" : "";
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 2) {
    open += "\x1b[1m";
    close = "\x1b[22m" + close;
  }
  if (fontStyle & 1) {
    open += "\x1b[3m";
    close = "\x1b[23m" + close;
  }
  if (fontStyle & 4) {
    open += "\x1b[4m";
    close = "\x1b[24m" + close;
  }
  return open + escapeControlChars(token.content) + close;
};

const isLowContrastFg = (params: string): boolean => {
  if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return true;
  if (!params.startsWith("38;2;")) return false;
  const parts = params.split(";").map(Number);
  const r = parts[2];
  const g = parts[3];
  const b = parts[4];
  if (r === undefined || g === undefined || b === undefined) return false;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 72;
};

const normalizeContrast = (ansi: string): string => {
  if (THEME_TYPE.get(currentTheme) === "light") return ansi;
  return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) =>
    isLowContrastFg(params) ? LOW_CONTRAST_FALLBACK : seq,
  );
};

const cacheRendered = (key: string, value: string[]): void => {
  const size = value.reduce((total, line) => total + line.length, 0);
  renderCache.set(key, { value, size });
  renderCacheChars += size;
  while (renderCache.size > CACHE_LIMIT || renderCacheChars > CACHE_CHAR_LIMIT) {
    const first = renderCache.keys().next().value;
    if (first === undefined) break;
    const cached = renderCache.get(first);
    if (cached) renderCacheChars -= cached.size;
    renderCache.delete(first);
  }
};

const requestInit = (invalidate?: () => void): void => {
  if (invalidate) highlighterReadyCallbacks.add(invalidate);
  if (initializingTheme === currentTheme) return;
  void initHighlighting(currentTheme, enabled);
};

const notifyReady = (): void => {
  const callbacks = [...highlighterReadyCallbacks];
  highlighterReadyCallbacks.clear();
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // A stale invalidate callback is harmless.
    }
  }
};

const requestLanguageLoad = (lang: string, invalidate?: () => void): void => {
  if (invalidate) {
    const callbacks = languageLoadCallbacks.get(lang) ?? new Set();
    callbacks.add(invalidate);
    languageLoadCallbacks.set(lang, callbacks);
  }
  if (pendingLanguages.has(lang)) return;
  const instance = highlighter;
  if (!instance) return;
  pendingLanguages.add(lang);
  const generation = highlighterGeneration;
  void instance
    .loadLanguage(lang as never)
    .then(() => {
      if (generation !== highlighterGeneration) return;
      loadedLanguages.add(lang);
      const callbacks = languageLoadCallbacks.get(lang);
      languageLoadCallbacks.delete(lang);
      for (const callback of callbacks ?? []) {
        try {
          callback();
        } catch {
          // Stale invalidate; ignore.
        }
      }
    })
    .catch(() => {
      if (generation === highlighterGeneration) languageLoadCallbacks.delete(lang);
    })
    .finally(() => {
      if (generation === highlighterGeneration) pendingLanguages.delete(lang);
    });
};

/**
 * Highlight `text` as `lang`, returning per-line truecolor ANSI strings that match
 * pi-code-previews' rendering (same shiki theme + token conversion). Returns null
 * when highlighting is disabled, the language is unsupported, the highlighter is
 * not yet ready, or the content is too large. Pass `invalidate` to request a
 * re-render once the highlighter/language becomes ready.
 */
export function highlightCode(
  text: string,
  lang: string,
  invalidate?: () => void,
): string[] | null {
  if (!enabled || !lang || shouldSkipHighlight(text)) return null;
  if (!highlighter) {
    requestInit(invalidate);
    return null;
  }
  const shikiLang = normalizeLanguage(lang);
  if (!(shikiLang in bundledLanguages)) return null;
  const cacheKey = `${currentTheme}\0${shikiLang}\0${text.length}\0${hashString(text)}`;
  const cached = renderCache.get(cacheKey);
  if (cached) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached.value;
  }
  if (!loadedLanguages.has(shikiLang)) {
    requestLanguageLoad(shikiLang, invalidate);
    return null;
  }
  try {
    const tokens = highlighter.codeToTokensBase(text, {
      lang: shikiLang as never,
      theme: currentTheme as never,
    });
    const rendered = tokens.map((line) =>
      normalizeContrast(line.map(ansiFromToken).join("")),
    );
    cacheRendered(cacheKey, rendered);
    return rendered;
  } catch {
    return null;
  }
}
