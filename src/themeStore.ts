import * as vscode from 'vscode';

export type Mode = 'dark' | 'light';
export type Category = 'source' | 'preview' | 'code' | 'mermaid';
export const CATEGORIES: ReadonlyArray<Category> = ['source', 'preview', 'code', 'mermaid'];

export interface ThemeChoice {
  theme: string;
  overrides: Record<string, string>;
}

export type ModeThemes = Record<Category, ThemeChoice>;

export interface ThemeConfig {
  dark: ModeThemes;
  light: ModeThemes;
}

export const SHIKI_DARK_THEMES = [
  'github-dark',
  'github-dark-default',
  'dark-plus',
  'monokai',
  'dracula',
  'nord',
  'one-dark-pro',
  'tokyo-night',
  'vitesse-dark',
  'solarized-dark',
  'noctis',
  'noctis-azureus',
  'noctis-bordo',
  'noctis-lilac',
  'noctis-minimus',
  'noctis-obscuro',
  'noctis-sereno',
  'noctis-uva',
  'noctis-viola',
] as const;

export const SHIKI_LIGHT_THEMES = [
  'github-light',
  'github-light-default',
  'light-plus',
  'one-light',
  'vitesse-light',
  'solarized-light',
  'noctis-hibernus',
  'noctis-lux',
] as const;

// Mermaid's four native themes plus our editor-matching presets (see
// `mermaidPresets.ts`). Native names go first so the dropdown opens with
// the familiar choices on top.
export const MERMAID_DARK_THEMES = [
  'dark',
  'forest',
  'github-dark',
  'dark-plus',
  'monokai',
  'dracula',
  'nord',
  'one-dark-pro',
  'tokyo-night',
  'vitesse-dark',
  'solarized-dark',
  'noctis',
  'noctis-azureus',
  'noctis-bordo',
  'noctis-obscuro',
] as const;
export const MERMAID_LIGHT_THEMES = [
  'default',
  'forest',
  'neutral',
  'github-light',
  'light-plus',
  'one-light',
  'vitesse-light',
  'solarized-light',
  'noctis-lux',
  'noctis-hibernus',
] as const;

export const DEFAULT_THEMES: ThemeConfig = {
  dark: {
    source: { theme: 'github-dark', overrides: {} },
    preview: { theme: 'github-dark', overrides: {} },
    code: { theme: 'github-dark', overrides: {} },
    mermaid: { theme: 'dark', overrides: {} },
  },
  light: {
    source: { theme: 'github-light', overrides: {} },
    preview: { theme: 'github-light', overrides: {} },
    code: { theme: 'github-light', overrides: {} },
    mermaid: { theme: 'default', overrides: {} },
  },
};

const CONFIG_SECTION = 'liveMarkdown';
const CONFIG_KEY_THEMES = 'themes';
const PER_FILE_PREFIX = 'themes.perFile.';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pickModeFromKind(): Mode {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

function legacyMigrate(): ThemeConfig | null {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const src = cfg.get<string>('sourceTheme');
  const prev = cfg.get<string>('previewTheme');
  const code = cfg.get<string>('codeTheme');
  if (!src && !prev && !code) return null;
  // Decide which mode the legacy values represented based on theme name kind.
  const mode = pickModeFromKind();
  const out = clone(DEFAULT_THEMES);
  const target = out[mode];
  if (src) target.source.theme = src;
  if (prev) target.preview.theme = prev;
  if (code) target.code.theme = code;
  return out;
}

function isModeThemes(v: unknown): v is ModeThemes {
  if (!v || typeof v !== 'object') return false;
  for (const c of CATEGORIES) {
    const sub = (v as Record<string, unknown>)[c];
    if (!sub || typeof sub !== 'object') return false;
  }
  return true;
}

function fillModeThemes(input: unknown, defaults: ModeThemes): ModeThemes {
  const out = clone(defaults);
  if (!input || typeof input !== 'object') return out;
  for (const c of CATEGORIES) {
    const sub = (input as Record<string, unknown>)[c];
    if (sub && typeof sub === 'object') {
      const sObj = sub as { theme?: unknown; overrides?: unknown };
      if (typeof sObj.theme === 'string' && sObj.theme.length > 0) out[c].theme = sObj.theme;
      if (sObj.overrides && typeof sObj.overrides === 'object') {
        out[c].overrides = clone(sObj.overrides as Record<string, string>);
      }
    }
  }
  return out;
}

export function readGlobalThemes(): ThemeConfig {
  const raw = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<unknown>(CONFIG_KEY_THEMES);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      dark: fillModeThemes(obj.dark, DEFAULT_THEMES.dark),
      light: fillModeThemes(obj.light, DEFAULT_THEMES.light),
    };
  }
  const migrated = legacyMigrate();
  return migrated ?? clone(DEFAULT_THEMES);
}

export async function writeGlobalThemes(config: ThemeConfig): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(CONFIG_KEY_THEMES, config, vscode.ConfigurationTarget.Global);
}

export function readPerFileThemes(
  state: vscode.Memento,
  filePath: string,
): Partial<ModeThemes> | undefined {
  const v = state.get<unknown>(PER_FILE_PREFIX + filePath);
  if (!v || typeof v !== 'object') return undefined;
  if (!isModeThemes(v)) return v as Partial<ModeThemes>;
  return v;
}

export async function writePerFileThemes(
  state: vscode.Memento,
  filePath: string,
  themes: Partial<ModeThemes> | undefined,
): Promise<void> {
  await state.update(PER_FILE_PREFIX + filePath, themes);
}

export function resolveModeThemes(
  globalConfig: ThemeConfig,
  mode: Mode,
  perFile?: Partial<ModeThemes>,
): ModeThemes {
  const base = clone(globalConfig[mode]);
  if (!perFile) return base;
  for (const c of CATEGORIES) {
    const override = (perFile as Record<string, ThemeChoice | undefined>)[c];
    if (override) base[c] = clone(override);
  }
  return base;
}

export function currentMode(): Mode {
  return pickModeFromKind();
}
