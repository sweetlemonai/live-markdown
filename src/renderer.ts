import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
// markdown-it-task-lists has no shipped types
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - no types
import taskLists from 'markdown-it-task-lists';
import katexPlugin from '@vscode/markdown-it-katex';
import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
  type ThemeRegistration,
} from 'shiki';

// Cache the *promise*, not just the resolved highlighter, so two concurrent
// callers share one createHighlighter() + loadExtraThemes() pass. Caching the
// resolved value alone races: the second caller sees `highlighter` still
// undefined during the first await, spawns a second instance, and the second
// instance's loadExtraThemes() short-circuits on `extraThemesLoaded` — so the
// cached highlighter ends up without the Noctis themes loaded.
//
// `highlighter` is the resolved instance for the synchronous `highlight()`
// callback used by markdown-it; it is assigned once the promise settles.
let highlighter: Highlighter | undefined;
let highlighterPromise: Promise<Highlighter> | undefined;
const loadedLangs = new Set<string>();

/** Custom (non-shiki-bundled) themes loaded from dist/themes/*.json. */
export interface CustomThemeInfo {
  id: string;
  label: string;
  type: 'dark' | 'light';
}
let extraThemesLoaded = false;
const extraThemes: CustomThemeInfo[] = [];

const NOCTIS_VARIANTS: Array<{ file: string; id: string; label: string; type: 'dark' | 'light' }> = [
  { file: 'noctis-noctis.json',   id: 'noctis',          label: 'Noctis',           type: 'dark' },
  { file: 'noctis-azureus.json',  id: 'noctis-azureus',  label: 'Noctis Azureus',   type: 'dark' },
  { file: 'noctis-bordo.json',    id: 'noctis-bordo',    label: 'Noctis Bordo',     type: 'dark' },
  { file: 'noctis-lilac.json',    id: 'noctis-lilac',    label: 'Noctis Lilac',     type: 'dark' },
  { file: 'noctis-minimus.json',  id: 'noctis-minimus',  label: 'Noctis Minimus',   type: 'dark' },
  { file: 'noctis-obscuro.json',  id: 'noctis-obscuro',  label: 'Noctis Obscuro',   type: 'dark' },
  { file: 'noctis-sereno.json',   id: 'noctis-sereno',   label: 'Noctis Sereno',    type: 'dark' },
  { file: 'noctis-uva.json',      id: 'noctis-uva',      label: 'Noctis Uva',       type: 'dark' },
  { file: 'noctis-viola.json',    id: 'noctis-viola',    label: 'Noctis Viola',     type: 'dark' },
  { file: 'noctis-hibernus.json', id: 'noctis-hibernus', label: 'Noctis Hibernus',  type: 'light' },
  { file: 'noctis-lux.json',      id: 'noctis-lux',      label: 'Noctis Lux',       type: 'light' },
];

/** Path provided by the extension at activation so we can load JSON themes from disk. */
let themeAssetRoot: string | undefined;
export function setThemeAssetRoot(root: string): void {
  themeAssetRoot = root;
}

async function loadExtraThemes(hl: Highlighter): Promise<void> {
  if (extraThemesLoaded) return;
  if (!themeAssetRoot) {
    console.warn('[live-markdown] themeAssetRoot not set; skipping custom theme load');
    return;
  }
  extraThemesLoaded = true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  for (const v of NOCTIS_VARIANTS) {
    try {
      const filePath = pathMod.join(themeAssetRoot, v.file);
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw);
      json.name = v.id;
      await hl.loadTheme(json);
      extraThemes.push({ id: v.id, label: v.label, type: v.type });
    } catch (e) {
      console.error('[live-markdown] failed to load custom theme', v.file, '→', (e as Error).message);
    }
  }
}

export function getExtraThemes(): ReadonlyArray<CustomThemeInfo> {
  return extraThemes;
}

/**
 * Eagerly create the highlighter (which triggers loadExtraThemes) so that
 * by the time the first panel resolves a theme, custom themes are loaded
 * into shiki's registry.
 */
export async function initRenderer(): Promise<void> {
  await getHighlighter();
}

export const SUPPORTED_THEMES: ReadonlyArray<{ id: BundledTheme; label: string }> = [
  { id: 'dark-plus', label: 'Dark+ (VS Code)' },
  { id: 'light-plus', label: 'Light+ (VS Code)' },
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'github-dark-default', label: 'GitHub Dark (Default)' },
  { id: 'github-light', label: 'GitHub Light' },
  { id: 'github-light-default', label: 'GitHub Light (Default)' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'solarized-light', label: 'Solarized Light' },
  { id: 'nord', label: 'Nord' },
  { id: 'one-dark-pro', label: 'One Dark Pro' },
  { id: 'one-light', label: 'One Light' },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'vitesse-dark', label: 'Vitesse Dark' },
  { id: 'vitesse-light', label: 'Vitesse Light' },
];

const PRELOAD_THEMES: BundledTheme[] = SUPPORTED_THEMES.map((t) => t.id);

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const hl = await createHighlighter({
        themes: PRELOAD_THEMES,
        langs: [],
      });
      await loadExtraThemes(hl);
      highlighter = hl;
      return hl;
    })();
  }
  return highlighterPromise;
}

function isLight(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

/**
 * Resolve a user-supplied theme id (possibly empty for "auto") into a real
 * shiki theme name based on VS Code's active color theme.
 */
export function resolveShikiTheme(userTheme: string | undefined | null): string {
  if (userTheme && (PRELOAD_THEMES as string[]).includes(userTheme)) {
    return userTheme;
  }
  // Custom themes loaded from disk (Noctis variants, etc.). Match against the
  // static variant table — `extraThemes` only fills in after async loading,
  // and `resolveShikiTheme` is sync, so the table is the reliable source.
  if (userTheme && NOCTIS_VARIANTS.some((v) => v.id === userTheme)) {
    return userTheme;
  }
  // Try to match VS Code's selected theme by name. Many users have themes
  // whose names map cleanly to a shiki bundled theme (e.g. "Default Dark+").
  const vsName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (vsName) {
    const slug = vsName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const candidates = [
      slug,
      slug.replace(/^default-/, ''),
      slug.replace(/^default-/, '').replace(/-modern$/, ''),
      slug.replace(/-default$/, ''),
    ];
    for (const c of candidates) {
      if ((PRELOAD_THEMES as string[]).includes(c)) return c;
      if (NOCTIS_VARIANTS.some((v) => v.id === c)) return c;
    }
  }
  return isLight() ? 'light-plus' : 'dark-plus';
}

function extractLangs(text: string): string[] {
  const langs = new Set<string>();
  const re = /^```([\w+#.-]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    langs.add(m[1].toLowerCase());
  }
  return Array.from(langs);
}

async function preloadLangs(text: string): Promise<void> {
  const hl = await getHighlighter();
  const loaded = new Set(hl.getLoadedLanguages());
  for (const lang of extractLangs(text)) {
    if (loadedLangs.has(lang) || loaded.has(lang)) continue;
    try {
      await hl.loadLanguage(lang as BundledLanguage);
      loadedLangs.add(lang);
    } catch {
      loadedLangs.add(lang);
    }
  }
}

function highlight(code: string, lang: string, themeName: string): string {
  if (!lang) return '';
  if (lang === 'mermaid') {
    // Bypass shiki — emit a marker the webview turns into a rendered diagram.
    return `<pre class="mermaid-source"><code class="language-mermaid">${escapeHtml(code)}</code></pre>`;
  }
  if (!highlighter) return '';
  const loaded = highlighter.getLoadedLanguages();
  if (!loaded.includes(lang as BundledLanguage)) return '';
  const loadedThemes = highlighter.getLoadedThemes();
  if (!loadedThemes.includes(themeName)) return '';
  try {
    return highlighter.codeToHtml(code, {
      lang: lang as BundledLanguage,
      theme: themeName,
    });
  } catch {
    return '';
  }
}

let md: MarkdownIt | null = null;
let currentRenderTheme: string = 'dark-plus';
let mathEnabled = true;

export function setMathEnabled(enabled: boolean): void {
  if (mathEnabled === enabled) return;
  mathEnabled = enabled;
  // Reinstantiate so the plugin chain reflects the toggle.
  md = null;
}

function getMd(): MarkdownIt {
  if (md) return md;
  md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    highlight: (code, lang) => highlight(code, lang, currentRenderTheme),
  });
  // Interactive checkboxes; webview wires click → source toggle.
  md.use(taskLists, { enabled: true, label: false, lineNumber: false });
  md.use(anchor, { permalink: false, slugify: defaultSlugify });

  if (mathEnabled) {
    // KaTeX plugin: parses $...$ and $$...$$. KaTeX errors render as a styled
    // .katex-error span (we color it red in CSS) instead of throwing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    md.use(katexPlugin as any, { throwOnError: false, strict: false });
  }

  // Tag block-level elements with data-source-line so the webview can sync
  // scroll between Monaco (lines) and the rendered HTML.
  md.core.ruler.push('source-lines', (state) => {
    walkTokens(state.tokens as unknown as MdToken[], (t) => {
      if (t.map && (t.type === 'fence' || t.type === 'hr' || t.type.endsWith('_open'))) {
        t.attrSet('data-source-line', String(t.map[0]));
      }
    });
    return false;
  });

  // Custom fence renderer wraps shiki's <pre> in a <div data-source-line=…>
  // so the source-line attribute survives (default fence renderer returns
  // the highlight callback's output verbatim when it starts with <pre>).
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx];
    const inner = defaultFence
      ? defaultFence(tokens, idx, options, env, slf)
      : slf.renderToken(tokens, idx, options);
    const line = token.map ? token.map[0] : 0;
    return `<div data-source-line="${line}">${inner}</div>`;
  };

  return md;
}

// markdown-it's Token type: structurally typed to keep us honest about the
// fields we read without dragging in the namespace types (which differ
// between CJS / ESM type entry points).
interface MdToken {
  type: string;
  map: [number, number] | null;
  children: MdToken[] | null;
  attrSet(name: string, value: string): void;
}
function walkTokens(tokens: ReadonlyArray<MdToken>, fn: (t: MdToken) => void): void {
  for (const t of tokens) {
    fn(t);
    if (t.children) walkTokens(t.children, fn);
  }
}

interface FrontMatterSplit {
  body: string;
  yaml: string | null;
  yamlLineCount: number;
}

function splitFrontMatter(text: string): FrontMatterSplit {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(text);
  if (!m) return { body: text, yaml: null, yamlLineCount: 0 };
  const yaml = m[2];
  const yamlLineCount = m[0].split(/\r?\n/).length - 1;
  return { body: text.slice(m[0].length), yaml, yamlLineCount };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFrontMatterHtml(yaml: string): string {
  const lines = yaml.split(/\r?\n/);
  const items: string[] = [];
  for (const line of lines) {
    const m = /^(\s*)([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (m) {
      const indent = m[1].replace(/ /g, '&nbsp;');
      items.push(
        `<div class="fm-line">${indent}<span class="fm-key">${escapeHtml(m[2])}</span><span class="fm-colon">:</span> <span class="fm-value">${escapeHtml(m[3])}</span></div>`,
      );
    } else if (line.trim()) {
      items.push(`<div class="fm-line fm-raw">${escapeHtml(line)}</div>`);
    }
  }
  return `<div class="front-matter" data-source-line="0">${items.join('')}</div>`;
}

function defaultSlugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export async function renderMarkdown(
  text: string,
  userTheme?: string | null,
  showFrontMatter = false,
  codeOverrides?: Record<string, string>,
): Promise<string> {
  await preloadLangs(text);
  const baseTheme = resolveShikiTheme(userTheme);
  const hasOverrides = !!codeOverrides && Object.keys(codeOverrides).length > 0;
  if (hasOverrides) {
    const variantName = `${baseTheme}-mt-overrides`;
    const hl = await getHighlighter();
    try {
      const baseReg = hl.getTheme(baseTheme);
      const { applyShikiOverrides } = await import('./themeOverrides');
      const overrideReg = applyShikiOverrides(baseReg, codeOverrides!, variantName);
      await hl.loadTheme(overrideReg as Parameters<typeof hl.loadTheme>[0]);
      currentRenderTheme = variantName;
    } catch {
      currentRenderTheme = baseTheme;
    }
  } else {
    currentRenderTheme = baseTheme;
  }
  const split = splitFrontMatter(text);
  let html = getMd().render(split.body);
  if (showFrontMatter && split.yaml !== null) {
    html = renderFrontMatterHtml(split.yaml) + html;
  }
  return html;
}

/** Return the loaded shiki theme registration so the webview can convert it to Monaco's format. */
export async function getShikiThemeRegistration(name: string): Promise<ThemeRegistration> {
  const hl = await getHighlighter();
  return hl.getTheme(name as Parameters<Highlighter['getTheme']>[0]);
}
