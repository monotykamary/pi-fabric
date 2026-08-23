import type { ThemeRegistration } from "shiki";

// Theme resolution for issue #46.
//
// Pi's extension host cannot resolve shiki's internal lazy
// `import("@shikijs/themes/<id>)` (triggered when createHighlighter is handed
// a bare theme *id string*), so previews fell back to plain text. We resolve
// each theme object from pi-fabric's own module graph with static imports and
// hand createHighlighter the *object*, so shiki never performs that
// host-fragile subpath import at runtime.
//
// Each entry is a static dynamic import so the module is only fetched when a
// theme is actually selected, and so vitest can intercept it.

const THEME_IMPORTS = {
  "andromeeda": () => import("@shikijs/themes/andromeeda"),
  "aurora-x": () => import("@shikijs/themes/aurora-x"),
  "ayu-dark": () => import("@shikijs/themes/ayu-dark"),
  "ayu-light": () => import("@shikijs/themes/ayu-light"),
  "ayu-mirage": () => import("@shikijs/themes/ayu-mirage"),
  "catppuccin-frappe": () => import("@shikijs/themes/catppuccin-frappe"),
  "catppuccin-latte": () => import("@shikijs/themes/catppuccin-latte"),
  "catppuccin-macchiato": () => import("@shikijs/themes/catppuccin-macchiato"),
  "catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
  "dark-plus": () => import("@shikijs/themes/dark-plus"),
  "dracula": () => import("@shikijs/themes/dracula"),
  "dracula-soft": () => import("@shikijs/themes/dracula-soft"),
  "everforest-dark": () => import("@shikijs/themes/everforest-dark"),
  "everforest-light": () => import("@shikijs/themes/everforest-light"),
  "github-dark": () => import("@shikijs/themes/github-dark"),
  "github-dark-default": () => import("@shikijs/themes/github-dark-default"),
  "github-dark-dimmed": () => import("@shikijs/themes/github-dark-dimmed"),
  "github-dark-high-contrast": () =>
    import("@shikijs/themes/github-dark-high-contrast"),
  "github-light": () => import("@shikijs/themes/github-light"),
  "github-light-default": () => import("@shikijs/themes/github-light-default"),
  "github-light-high-contrast": () =>
    import("@shikijs/themes/github-light-high-contrast"),
  "gruvbox-dark-hard": () => import("@shikijs/themes/gruvbox-dark-hard"),
  "gruvbox-dark-medium": () => import("@shikijs/themes/gruvbox-dark-medium"),
  "gruvbox-dark-soft": () => import("@shikijs/themes/gruvbox-dark-soft"),
  "gruvbox-light-hard": () => import("@shikijs/themes/gruvbox-light-hard"),
  "gruvbox-light-medium": () => import("@shikijs/themes/gruvbox-light-medium"),
  "gruvbox-light-soft": () => import("@shikijs/themes/gruvbox-light-soft"),
  "horizon": () => import("@shikijs/themes/horizon"),
  "horizon-bright": () => import("@shikijs/themes/horizon-bright"),
  "houston": () => import("@shikijs/themes/houston"),
  "kanagawa-dragon": () => import("@shikijs/themes/kanagawa-dragon"),
  "kanagawa-lotus": () => import("@shikijs/themes/kanagawa-lotus"),
  "kanagawa-wave": () => import("@shikijs/themes/kanagawa-wave"),
  "laserwave": () => import("@shikijs/themes/laserwave"),
  "light-plus": () => import("@shikijs/themes/light-plus"),
  "material-theme": () => import("@shikijs/themes/material-theme"),
  "material-theme-darker": () => import("@shikijs/themes/material-theme-darker"),
  "material-theme-lighter": () => import("@shikijs/themes/material-theme-lighter"),
  "material-theme-ocean": () => import("@shikijs/themes/material-theme-ocean"),
  "material-theme-palenight": () =>
    import("@shikijs/themes/material-theme-palenight"),
  "min-dark": () => import("@shikijs/themes/min-dark"),
  "min-light": () => import("@shikijs/themes/min-light"),
  "monokai": () => import("@shikijs/themes/monokai"),
  "night-owl": () => import("@shikijs/themes/night-owl"),
  "night-owl-light": () => import("@shikijs/themes/night-owl-light"),
  "nord": () => import("@shikijs/themes/nord"),
  "one-dark-pro": () => import("@shikijs/themes/one-dark-pro"),
  "one-light": () => import("@shikijs/themes/one-light"),
  "plastic": () => import("@shikijs/themes/plastic"),
  "poimandres": () => import("@shikijs/themes/poimandres"),
  "red": () => import("@shikijs/themes/red"),
  "rose-pine": () => import("@shikijs/themes/rose-pine"),
  "rose-pine-dawn": () => import("@shikijs/themes/rose-pine-dawn"),
  "rose-pine-moon": () => import("@shikijs/themes/rose-pine-moon"),
  "slack-dark": () => import("@shikijs/themes/slack-dark"),
  "slack-ochin": () => import("@shikijs/themes/slack-ochin"),
  "snazzy-light": () => import("@shikijs/themes/snazzy-light"),
  "solarized-dark": () => import("@shikijs/themes/solarized-dark"),
  "solarized-light": () => import("@shikijs/themes/solarized-light"),
  "synthwave-84": () => import("@shikijs/themes/synthwave-84"),
  "tokyo-night": () => import("@shikijs/themes/tokyo-night"),
  "vesper": () => import("@shikijs/themes/vesper"),
  "vitesse-black": () => import("@shikijs/themes/vitesse-black"),
  "vitesse-dark": () => import("@shikijs/themes/vitesse-dark"),
  "vitesse-light": () => import("@shikijs/themes/vitesse-light"),
} as const satisfies Record<string, () => Promise<{ default: ThemeRegistration }>>;

/**
 * Resolve a shiki theme id to its loaded theme object. Returns undefined when
 * the id is not a bundled shiki theme, so callers can fall back gracefully.
 */
export async function resolveShikiThemeObject(
  themeId: string,
): Promise<ThemeRegistration | undefined> {
  const loader = THEME_IMPORTS[themeId as keyof typeof THEME_IMPORTS];
  if (!loader) return undefined;
  const mod = await loader();
  return mod.default;
}
