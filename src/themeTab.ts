import * as vscode from 'vscode';
import {
  CATEGORIES,
  type Category,
  type Mode,
  type ModeThemes,
  type ThemeChoice,
  type ThemeConfig,
  SHIKI_DARK_THEMES,
  SHIKI_LIGHT_THEMES,
  MERMAID_DARK_THEMES,
  MERMAID_LIGHT_THEMES,
  readGlobalThemes,
  writeGlobalThemes,
  readPerFileThemes,
  writePerFileThemes,
  currentMode,
} from './themeStore';
import { TOKENS_BY_CATEGORY } from './themeTokens';
import { resolveSourceTokenDefaults } from './themeOverrides';
import { getShikiThemeRegistration } from './renderer';
import { MERMAID_PRESETS, MERMAID_PICKER_TOKENS } from './mermaidPresets';

export interface ThemeTabHost {
  applyLivePreview(state: ThemeTabState, scope: 'all' | 'this', targetFile: string | null): void;
  endLivePreview(): void;
}

export interface ThemeTabState {
  mode: Mode;
  themes: ThemeConfig;
}

const VIEW_TYPE = 'liveMarkdown.themeTab';

export class ThemeTabPanel {
  private static current: ThemeTabPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly state: vscode.Memento;
  private readonly host: ThemeTabHost;

  private saved: ThemeTabState;
  private working: ThemeTabState;
  private scope: 'all' | 'this' = 'all';
  private readonly targetFile: string | null;
  private targetFileSaved: Partial<ModeThemes> | undefined;
  private targetFileWorking: Partial<ModeThemes> | undefined;

  static reveal(extensionUri: vscode.Uri, host: ThemeTabHost, state: vscode.Memento): void {
    if (ThemeTabPanel.current) {
      ThemeTabPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Markdown Themes',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );
    panel.iconPath = new vscode.ThemeIcon('paintcan');
    ThemeTabPanel.current = new ThemeTabPanel(panel, extensionUri, host, state);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    host: ThemeTabHost,
    state: vscode.Memento,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.state = state;
    this.host = host;

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    let targetFile: string | null = null;
    if (tab) {
      const input = tab.input;
      if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
        const p = input.uri.path.toLowerCase();
        if (p.endsWith('.md') || p.endsWith('.markdown')) {
          targetFile = input.uri.fsPath;
        }
      }
    }
    this.targetFile = targetFile;

    const config = readGlobalThemes();
    this.saved = { mode: currentMode(), themes: config };
    this.working = cloneState(this.saved);
    if (targetFile) {
      this.targetFileSaved = readPerFileThemes(state, targetFile);
      this.targetFileWorking = this.targetFileSaved
        ? JSON.parse(JSON.stringify(this.targetFileSaved))
        : undefined;
    }

    panel.webview.html = this.buildHtml();
    void this.pushSnapshot('init');

    panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));

    // Best-effort intercept of close/hide with unsaved changes. VS Code has no
    // true "before close" hook for webview panels; onDidChangeViewState is the
    // closest signal — it fires when the user switches tabs or closes the
    // panel. We prompt only on the visible→hidden transition while dirty, and
    // re-reveal the panel if the user picks Cancel. If the panel is force-
    // disposed before the prompt resolves, the modal is dismissed silently.
    let prevVisible = panel.visible;
    panel.onDidChangeViewState(async (e) => {
      const nowVisible = e.webviewPanel.visible;
      if (prevVisible && !nowVisible) {
        await this.handleHiddenWhileDirty();
      }
      prevVisible = nowVisible;
    });

    panel.onDidDispose(() => {
      this.disposed = true;
      ThemeTabPanel.current = undefined;
      this.host.endLivePreview();
    });
  }

  private disposed = false;
  private prompting = false;

  private async handleHiddenWhileDirty(): Promise<void> {
    if (this.prompting || this.disposed || !this.isDirty()) return;
    this.prompting = true;
    try {
      const choice = await vscode.window.showWarningMessage(
        'You have unsaved theme changes. Save before closing?',
        { modal: true },
        'Save',
        'Discard',
      );
      if (this.disposed) return;
      if (choice === 'Save') {
        await this.save();
      } else if (choice === 'Discard') {
        this.discard();
      } else {
        // Cancel / Esc — bring the tab back so the user can keep editing.
        this.panel.reveal(vscode.ViewColumn.Active);
      }
    } finally {
      this.prompting = false;
    }
  }

  private isDirty(): boolean {
    return (
      JSON.stringify(this.saved) !== JSON.stringify(this.working) ||
      JSON.stringify(this.targetFileSaved ?? {}) !== JSON.stringify(this.targetFileWorking ?? {})
    );
  }

  private async snapshot(): Promise<unknown> {
    const defaults = await this.computeResolvedDefaults();
    return {
      mode: this.working.mode,
      scope: this.scope,
      targetFile: this.targetFile,
      working: this.working,
      saved: this.saved,
      perFileWorking: this.targetFileWorking ?? null,
      dirty: this.isDirty(),
      options: getThemeOptions(),
      tokens: TOKENS_BY_CATEGORY,
      resolvedDefaults: defaults,
    };
  }

  /**
   * For each category × current mode, compute the base theme's per-token
   * default colors (used as initial values in the picker UI before the
   * user has overridden anything).
   */
  private async computeResolvedDefaults(): Promise<Record<Category, Record<string, string>>> {
    const empty: Record<Category, Record<string, string>> = {
      source: {}, preview: {}, code: {}, mermaid: {},
    };
    const choice = (cat: Category): ThemeChoice => {
      if (this.scope === 'this' && this.targetFile && this.targetFileWorking?.[cat]) {
        return this.targetFileWorking[cat]!;
      }
      return this.working.themes[this.working.mode][cat];
    };
    // Source / Code blocks share TextMate scopes — pull from shiki theme.
    for (const cat of ['source', 'code'] as const) {
      const c = choice(cat);
      try {
        const reg = await getShikiThemeRegistration(c.theme as Parameters<typeof getShikiThemeRegistration>[0]);
        empty[cat] = resolveSourceTokenDefaults(reg, TOKENS_BY_CATEGORY[cat]);
      } catch { /* keep empty */ }
    }
    // Preview defaults are derived: bg/fg from the preview theme; remainder
    // from a sensible fallback table.
    try {
      const c = choice('preview');
      const reg = await getShikiThemeRegistration(c.theme as Parameters<typeof getShikiThemeRegistration>[0]);
      const fg = reg.colors?.['editor.foreground'] ?? reg.fg ?? '#888888';
      const bg = reg.colors?.['editor.background'] ?? reg.bg ?? '#ffffff';
      empty.preview = previewDefaultsFromBase(bg, fg);
    } catch { /* keep empty */ }
    // Mermaid defaults: per-theme baseline.
    empty.mermaid = mermaidDefaults(choice('mermaid').theme);
    return empty;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as { type?: string; [k: string]: unknown };
    switch (msg.type) {
      case 'changeMode':
        if (msg.value === 'dark' || msg.value === 'light') {
          this.working.mode = msg.value;
          this.applyLive();
          await this.pushSnapshot();
        }
        break;
      case 'changeScope':
        if (msg.value === 'all' || (msg.value === 'this' && this.targetFile)) {
          this.scope = msg.value;
          this.applyLive();
          await this.pushSnapshot();
        }
        break;
      case 'changeTheme': {
        const cat = msg.category as Category;
        const themeName = String(msg.theme ?? '');
        if (!CATEGORIES.includes(cat) || !themeName) break;
        // Switching theme silently discards the previous theme's overrides.
        this.setChoice(cat, { theme: themeName, overrides: {} });
        this.applyLive();
        await this.pushSnapshot();
        break;
      }
      case 'changeTokenColor': {
        const cat = msg.category as Category;
        const token = String(msg.token ?? '');
        const color = String(msg.color ?? '');
        if (!CATEGORIES.includes(cat) || !token) break;
        const existing = this.getChoice(cat);
        const overrides = { ...existing.overrides, [token]: color };
        this.setChoice(cat, { theme: existing.theme, overrides });
        // Color picker fires `input` rapidly during drag — throttle the
        // broadcast so we don't saturate the webview round-trip.
        this.scheduleThrottledBroadcast();
        break;
      }
      case 'resetCategory': {
        const cat = msg.category as Category;
        if (!CATEGORIES.includes(cat)) break;
        const existing = this.getChoice(cat);
        this.setChoice(cat, { theme: existing.theme, overrides: {} });
        this.applyLive();
        await this.pushSnapshot();
        break;
      }
      case 'save':
        await this.save();
        await this.pushSnapshot();
        break;
      case 'discard':
        this.discard();
        await this.pushSnapshot();
        break;
      case 'closeRequested':
        await this.handleCloseRequested();
        break;
    }
  }

  private getChoice(cat: Category): ThemeChoice {
    if (this.scope === 'this' && this.targetFile && this.targetFileWorking?.[cat]) {
      return this.targetFileWorking[cat]!;
    }
    return this.working.themes[this.working.mode][cat];
  }

  private setChoice(cat: Category, value: ThemeChoice): void {
    if (this.scope === 'this' && this.targetFile) {
      if (!this.targetFileWorking) this.targetFileWorking = {};
      this.targetFileWorking[cat] = value;
    } else {
      this.working.themes[this.working.mode][cat] = value;
    }
  }

  private async handleCloseRequested(): Promise<void> {
    if (!this.isDirty()) {
      this.panel.dispose();
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'You have unsaved theme changes. Save before closing?',
      { modal: true },
      'Save',
      'Discard',
    );
    if (choice === 'Save') {
      await this.save();
      this.panel.dispose();
    } else if (choice === 'Discard') {
      this.discard();
      this.panel.dispose();
    }
  }

  private async save(): Promise<void> {
    if (this.scope === 'this' && this.targetFile) {
      await writePerFileThemes(this.state, this.targetFile, this.targetFileWorking);
      this.targetFileSaved = this.targetFileWorking
        ? JSON.parse(JSON.stringify(this.targetFileWorking))
        : undefined;
    } else {
      await writeGlobalThemes(this.working.themes);
      this.saved = cloneState(this.working);
    }
    void vscode.window.showInformationMessage('Theme settings saved.');
    this.applyLive();
  }

  private discard(): void {
    this.working = cloneState(this.saved);
    this.targetFileWorking = this.targetFileSaved
      ? JSON.parse(JSON.stringify(this.targetFileSaved))
      : undefined;
    this.applyLive();
  }

  private applyLive(): void {
    this.host.applyLivePreview(this.working, this.scope, this.targetFile);
  }

  private throttleTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleThrottledBroadcast(): void {
    if (this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = undefined;
      this.applyLive();
      void this.pushSnapshot();
    }, 60);
  }

  private async pushSnapshot(kind: 'init' | 'state' = 'state'): Promise<void> {
    const payload = await this.snapshot();
    this.panel.webview.postMessage({ type: kind, payload });
  }

  private buildHtml(): string {
    const cspSource = this.panel.webview.cspSource;
    const codiconCssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicons', 'codicon.css'),
    );
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:; img-src ${cspSource} data:;" />
<link rel="stylesheet" href="${codiconCssUri}" />
<style>${themeTabCss()}</style>
</head>
<body>
<div id="root">
  <header>
    <h1><i class="codicon codicon-paintcan"></i> Markdown Themes</h1>
    <p id="status" class="status">Loading…</p>
  </header>
  <section class="controls">
    <div class="group">
      <span class="label">Mode</span>
      <div class="segmented" role="radiogroup" aria-label="Mode">
        <button data-act="mode" data-val="dark" role="radio" aria-checked="false">Dark</button>
        <button data-act="mode" data-val="light" role="radio" aria-checked="false">Light</button>
      </div>
    </div>
    <div class="group">
      <span class="label">Apply to</span>
      <div class="segmented" role="radiogroup" aria-label="Scope">
        <button data-act="scope" data-val="all" role="radio" aria-checked="true">All files</button>
        <button data-act="scope" data-val="this" role="radio" aria-checked="false" id="scope-this">This file only</button>
      </div>
    </div>
  </section>
  <section class="categories">
    ${CATEGORIES.map((c) => categoryPanelHtml(c)).join('\n')}
  </section>
  <footer>
    <span id="dirty-indicator" class="dirty-indicator hidden">Unsaved changes</span>
    <button id="discard-btn" class="btn btn-secondary" type="button">Discard</button>
    <button id="save-btn" class="btn btn-primary" type="button">Save</button>
  </footer>
</div>
<script nonce="${nonce}">${themeTabScript()}</script>
</body>
</html>`;
  }
}

interface ThemeOptions {
  dark: { shiki: ReadonlyArray<string>; mermaid: ReadonlyArray<string> };
  light: { shiki: ReadonlyArray<string>; mermaid: ReadonlyArray<string> };
}

function getThemeOptions(): ThemeOptions {
  return {
    dark: { shiki: SHIKI_DARK_THEMES, mermaid: MERMAID_DARK_THEMES },
    light: { shiki: SHIKI_LIGHT_THEMES, mermaid: MERMAID_LIGHT_THEMES },
  };
}

function cloneState(s: ThemeTabState): ThemeTabState {
  return JSON.parse(JSON.stringify(s)) as ThemeTabState;
}

function previewDefaultsFromBase(bg: string, fg: string): Record<string, string> {
  return {
    background: bg,
    foreground: fg,
    heading: fg,
    link: '#0969da',
    'link-hover': '#0550ae',
    'blockquote-border': '#d1d9e0',
    'blockquote-fg': fg,
    'inline-code-bg': '#f0f0f0',
    'inline-code-fg': fg,
    'code-block-bg': '#f0f0f0',
    'table-border': '#d1d9e0',
    'table-header-bg': '#f6f8fa',
    hr: '#d1d9e0',
    strikethrough: fg,
    'mark-bg': '#fff8c5',
  };
}

function mermaidDefaults(theme: string): Record<string, string> {
  // Editor-matching presets seed the picker with the same values mermaid
  // will receive (subset down to the eight tokens the picker exposes).
  const preset = MERMAID_PRESETS[theme];
  if (preset) {
    const out: Record<string, string> = {};
    for (const key of MERMAID_PICKER_TOKENS) {
      const v = preset.vars[key];
      if (typeof v === 'string') out[key] = v;
    }
    return out;
  }
  // Coarse defaults aligned with mermaid's bundled theme variables.
  switch (theme) {
    case 'dark':
      return {
        background: '#1f2020',
        primaryColor: '#1f2020',
        primaryTextColor: '#ddd',
        secondaryColor: '#2a2a2a',
        tertiaryColor: '#3a3a3a',
        lineColor: '#cccccc',
        labelBackground: '#2a2a2a',
        labelTextColor: '#ddd',
      };
    case 'forest':
      return {
        background: '#f4faff',
        primaryColor: '#cde498',
        primaryTextColor: '#13540c',
        secondaryColor: '#cdffb2',
        tertiaryColor: '#bee0aa',
        lineColor: '#6eaa49',
        labelBackground: '#cde498',
        labelTextColor: '#13540c',
      };
    case 'neutral':
      return {
        background: '#ffffff',
        primaryColor: '#eee',
        primaryTextColor: '#333',
        secondaryColor: '#fff',
        tertiaryColor: '#f4f4f4',
        lineColor: '#666',
        labelBackground: '#fff',
        labelTextColor: '#333',
      };
    default: // 'default'
      return {
        background: '#ffffff',
        primaryColor: '#fff4dd',
        primaryTextColor: '#333',
        secondaryColor: '#ffeacc',
        tertiaryColor: '#fff5cc',
        lineColor: '#333',
        labelBackground: '#ffffff',
        labelTextColor: '#333',
      };
  }
}

function categoryPanelHtml(cat: Category): string {
  const labels: Record<Category, string> = {
    source: 'Source',
    preview: 'Preview',
    code: 'Code blocks',
    mermaid: 'Mermaid',
  };
  const descriptions: Record<Category, string> = {
    source: 'Theme of the Monaco source editor.',
    preview: 'Background and prose colors of the rendered markdown view.',
    code: 'Syntax highlighting of fenced code blocks inside the rendered preview.',
    mermaid: 'Color theme of Mermaid diagrams rendered in the preview.',
  };
  return `<div class="category" data-category="${cat}">
    <div class="category-header">
      <h2>${labels[cat]}</h2>
      <p class="muted">${descriptions[cat]}</p>
    </div>
    <div class="category-body">
      <label class="row">
        <span class="row-label">Theme</span>
        <select data-act="theme" data-category="${cat}"></select>
        <span class="modified-indicator hidden" data-category="${cat}">(modified)</span>
      </label>
      <details class="tokens-details">
        <summary>Customize colors</summary>
        <div class="token-list" data-category="${cat}"></div>
        <button class="btn btn-secondary reset-btn" type="button" data-act="reset" data-category="${cat}">Reset to theme defaults</button>
      </details>
    </div>
  </div>`;
}

function themeTabCss(): string {
  return `
:root { color-scheme: var(--vscode-color-scheme, dark light); }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  line-height: 1.45;
}
#root { max-width: 60em; margin: 0 auto; padding: 2em 2em 4em; }
header { margin-bottom: 1.6em; }
header h1 { display: flex; align-items: center; gap: 0.5em; font-size: 1.6em; margin: 0 0 0.4em; font-weight: 600; }
header h1 .codicon { font-size: 1em; opacity: 0.85; }
.status { margin: 0; opacity: 0.75; font-size: 0.95em; }
.muted { opacity: 0.7; }
.small { font-size: 0.85em; }
.hidden { display: none !important; }
.controls {
  display: flex; gap: 2em; flex-wrap: wrap;
  padding: 1em 1.2em;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  border-radius: 6px; margin-bottom: 1.6em;
}
.controls .group { display: flex; flex-direction: column; gap: 0.4em; }
.controls .label { font-size: 0.85em; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em; }
.segmented {
  display: inline-flex;
  border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)));
  border-radius: 4px; overflow: hidden;
}
.segmented button {
  background: transparent; color: var(--vscode-foreground); border: 0;
  border-right: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)));
  padding: 0.4em 1em; cursor: pointer;
  font-family: inherit; font-size: inherit;
}
.segmented button:last-child { border-right: 0; }
.segmented button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.segmented button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.segmented button[disabled] { opacity: 0.4; cursor: default; }
.categories { display: grid; grid-template-columns: 1fr; gap: 1.2em; }
.category {
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  border-radius: 6px; overflow: hidden;
  background: var(--vscode-editor-background);
}
.category-header {
  padding: 0.9em 1.2em;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
}
.category-header h2 { font-size: 1.1em; margin: 0 0 0.2em; font-weight: 600; }
.category-header p { margin: 0; font-size: 0.9em; }
.category-body { padding: 1em 1.2em; display: flex; flex-direction: column; gap: 0.7em; }
.row { display: flex; align-items: center; gap: 0.8em; }
.row-label { width: 6em; opacity: 0.85; }
.row select {
  flex: 1; font-family: inherit; font-size: inherit; padding: 0.35em 0.6em;
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground, var(--vscode-foreground)));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border));
  border-radius: 3px; cursor: pointer;
}
.modified-indicator {
  font-size: 0.85em; font-style: italic;
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
}
.tokens-details { border-top: 1px dashed var(--vscode-editorWidget-border, var(--vscode-panel-border)); padding-top: 0.8em; }
.tokens-details summary {
  cursor: pointer; user-select: none; font-weight: 500; opacity: 0.85;
  padding: 0.3em 0;
  list-style: none;
}
.tokens-details summary::-webkit-details-marker { display: none; }
.tokens-details summary::before {
  content: '▸'; display: inline-block; width: 1em; transition: transform 0.15s;
}
.tokens-details[open] summary::before { transform: rotate(90deg); }
.token-list {
  display: grid; grid-template-columns: 1fr auto; gap: 0.4em 1em;
  margin: 0.6em 0;
  padding: 0.6em 0.2em;
  background: var(--vscode-editor-background);
  border-radius: 4px;
}
.token-row { display: contents; }
.token-row .token-label { padding: 0.25em 0; opacity: 0.9; }
.token-row .token-color {
  width: 4em; height: 1.6em; padding: 0; border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border)); border-radius: 3px;
  background: transparent; cursor: pointer;
}
.token-row .token-color::-webkit-color-swatch-wrapper { padding: 0; }
.token-row .token-color::-webkit-color-swatch { border: none; border-radius: 2px; }
.reset-btn { margin-top: 0.6em; align-self: flex-start; }
footer {
  position: sticky; bottom: 0;
  display: flex; align-items: center; gap: 0.8em;
  margin-top: 2em; padding: 1em 0;
  background: linear-gradient(180deg, transparent, var(--vscode-editor-background) 30%);
}
.dirty-indicator { flex: 1; font-size: 0.9em; color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
.btn {
  font-family: inherit; font-size: inherit;
  padding: 0.45em 1.2em; border-radius: 3px;
  cursor: pointer; border: 1px solid transparent;
}
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-primary[disabled] { opacity: 0.5; cursor: default; }
.btn-secondary {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-button-border, var(--vscode-input-border, var(--vscode-editorWidget-border)));
}
.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
`;
}

function themeTabScript(): string {
  return `
(() => {
  const vscode = acquireVsCodeApi();
  let state = null;

  const statusEl = document.getElementById('status');
  const dirtyEl = document.getElementById('dirty-indicator');
  const saveBtn = document.getElementById('save-btn');
  const discardBtn = document.getElementById('discard-btn');
  const scopeThisBtn = document.getElementById('scope-this');

  function modeButtons() { return document.querySelectorAll('button[data-act="mode"]'); }
  function scopeButtons() { return document.querySelectorAll('button[data-act="scope"]'); }
  function categorySelect(cat) { return document.querySelector('select[data-category="' + cat + '"]'); }
  function tokenList(cat) { return document.querySelector('.token-list[data-category="' + cat + '"]'); }
  function modifiedIndicator(cat) { return document.querySelector('.modified-indicator[data-category="' + cat + '"]'); }
  function resetBtn(cat) { return document.querySelector('button[data-act="reset"][data-category="' + cat + '"]'); }

  for (const b of modeButtons()) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'changeMode', value: b.dataset.val }));
  }
  for (const b of scopeButtons()) {
    b.addEventListener('click', () => vscode.postMessage({ type: 'changeScope', value: b.dataset.val }));
  }
  for (const cat of ['source', 'preview', 'code', 'mermaid']) {
    const sel = categorySelect(cat);
    if (sel) sel.addEventListener('change', () => vscode.postMessage({ type: 'changeTheme', category: cat, theme: sel.value }));
    const btn = resetBtn(cat);
    if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'resetCategory', category: cat }));
  }
  saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'save' }));
  discardBtn.addEventListener('click', () => vscode.postMessage({ type: 'discard' }));

  function activeChoice(cat) {
    if (state.scope === 'this' && state.perFileWorking && state.perFileWorking[cat]) {
      return state.perFileWorking[cat];
    }
    return state.working.themes[state.mode][cat];
  }

  function renderTokens(cat) {
    const list = tokenList(cat);
    if (!list) return;
    const tokens = state.tokens[cat] || [];
    const choice = activeChoice(cat);
    const overrides = choice.overrides || {};
    const defaults = (state.resolvedDefaults && state.resolvedDefaults[cat]) || {};

    // Build rows once — never rebuild while the user might be interacting
    // with a system color picker, otherwise the picker closes mid-drag.
    if (list.dataset.built !== '1' || list.children.length !== tokens.length) {
      list.innerHTML = '';
      for (const tok of tokens) {
        const row = document.createElement('div');
        row.className = 'token-row';
        row.dataset.tokenId = tok.id;

        const label = document.createElement('span');
        label.className = 'token-label';
        label.textContent = tok.label;

        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'token-color';
        input.dataset.tokenId = tok.id;
        input.addEventListener('input', () => {
          vscode.postMessage({ type: 'changeTokenColor', category: cat, token: tok.id, color: input.value });
        });

        row.appendChild(label);
        row.appendChild(input);
        list.appendChild(row);
      }
      list.dataset.built = '1';
    }

    // Update values in place, skipping any input that's currently focused
    // so the open picker doesn't lose its target node.
    for (const tok of tokens) {
      const input = list.querySelector('input[data-token-id="' + tok.id + '"]');
      if (!input) continue;
      if (document.activeElement === input) continue;
      const value = normalizeHex(overrides[tok.id] || defaults[tok.id] || '#888888');
      if (input.value !== value) input.value = value;
    }

    const ind = modifiedIndicator(cat);
    if (ind) ind.classList.toggle('hidden', Object.keys(overrides).length === 0);
  }

  function normalizeHex(hex) {
    if (typeof hex !== 'string') return '#888888';
    if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    if (/^#[0-9a-f]{8}$/i.test(hex)) return hex.slice(0, 7);
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
      const r = hex[1], g = hex[2], b = hex[3];
      return '#' + r + r + g + g + b + b;
    }
    return '#888888';
  }

  function render() {
    if (!state) return;
    for (const b of modeButtons()) {
      const active = b.dataset.val === state.mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    scopeThisBtn.disabled = !state.targetFile;
    for (const b of scopeButtons()) {
      const active = b.dataset.val === state.scope;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    const fileLabel = state.targetFile ? state.targetFile.split('/').pop() : null;
    const scopeText = state.scope === 'this' && fileLabel
      ? 'this file (' + fileLabel + ')'
      : 'all markdown files';
    statusEl.textContent =
      'Editing ' + state.mode + ' mode theme, applied to ' + scopeText + '.';
    dirtyEl.classList.toggle('hidden', !state.dirty);
    saveBtn.disabled = !state.dirty;
    discardBtn.disabled = !state.dirty;
    const opts = state.options[state.mode];
    for (const cat of ['source', 'preview', 'code', 'mermaid']) {
      const sel = categorySelect(cat);
      if (!sel) continue;
      const list = cat === 'mermaid' ? opts.mermaid : opts.shiki;
      const choice = activeChoice(cat);
      const activeTheme = choice.theme;
      sel.innerHTML = '';
      let foundActive = false;
      for (const id of list) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        if (id === activeTheme) { opt.selected = true; foundActive = true; }
        sel.appendChild(opt);
      }
      if (!foundActive) {
        const opt = document.createElement('option');
        opt.value = activeTheme;
        opt.textContent = activeTheme + ' (custom)';
        opt.selected = true;
        sel.appendChild(opt);
      }
      renderTokens(cat);
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'init' || msg.type === 'state') {
      state = msg.payload;
      render();
    }
  });
})();
`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

