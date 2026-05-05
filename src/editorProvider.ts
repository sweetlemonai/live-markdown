import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type * as Monaco from 'monaco-editor';
import {
  renderMarkdown,
  resolveShikiTheme,
  getShikiThemeRegistration,
} from './renderer';
import {
  type Mode as ThemeMode,
  type ModeThemes,
  currentMode as currentModeFromVSCode,
  readGlobalThemes,
  readPerFileThemes,
  resolveModeThemes,
} from './themeStore';
import type { ThemeTabState } from './themeTab';
import { applyMonacoOverrides } from './themeOverrides';

const CONFIG_SECTION = 'liveMarkdown';

type SecondRow = 'none' | 'theme' | 'formatting';
const CONFIG_KEY_SECOND_ROW = 'secondRow';
const CONFIG_KEY_SHOW_FRONT_MATTER = 'showFrontMatter';
const CONFIG_KEY_SHOW_HEADING_ANCHORS = 'showHeadingAnchors';

function readSecondRow(): SecondRow {
  const v = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(CONFIG_KEY_SECOND_ROW);
  // 'theme' is deprecated — theme controls moved to a dedicated tab.
  return v === 'formatting' ? v : 'none';
}

function readBool(key: string, defaultValue: boolean): boolean {
  const v = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(key);
  return typeof v === 'boolean' ? v : defaultValue;
}

interface RenderSettings {
  showFrontMatter: boolean;
  showHeadingAnchors: boolean;
}

function readRenderSettings(): RenderSettings {
  return {
    showFrontMatter: readBool(CONFIG_KEY_SHOW_FRONT_MATTER, false),
    showHeadingAnchors: readBool(CONFIG_KEY_SHOW_HEADING_ANCHORS, true),
  };
}

export const VIEW_TYPE = 'liveMarkdown.editor';

type Mode = 'source' | 'preview' | 'split-horizontal' | 'split-vertical';
const DEFAULT_MODE: Mode = 'preview';

interface PanelEntry {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  mode: Mode;
  /** Divider position (percentage 0–100) for split-horizontal layout. */
  dividerH: number;
  /** Divider position (percentage 0–100) for split-vertical layout. */
  dividerV: number;
  syncScroll: boolean;
  /** Last text we wrote to the document via WorkspaceEdit (for echo suppression). */
  lastAppliedText: string | null;
  disposables: vscode.Disposable[];
  renderTimer: ReturnType<typeof setTimeout> | undefined;
}

// Used for the legacy overrides field that PanelEntry no longer carries — kept
// here only for the type narrowing when reading legacy webview messages.
// (Pre-spec: per-tab theme overrides existed; theme tab replaces that.)

interface LivePreviewOverlay {
  state: ThemeTabState;
  scope: 'all' | 'this';
  targetFile: string | null;
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private static instance: MarkdownEditorProvider | undefined;
  private readonly entries = new Map<vscode.WebviewPanel, PanelEntry>();
  private readonly onDidChangeActiveModeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeActiveMode = this.onDidChangeActiveModeEmitter.event;

  private liveOverlay: LivePreviewOverlay | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
  ) {
    MarkdownEditorProvider.instance = this;
  }

  getWorkspaceState(): vscode.Memento {
    return this.workspaceState;
  }

  static current(): MarkdownEditorProvider | undefined {
    return MarkdownEditorProvider.instance;
  }

  getActiveEntry(): PanelEntry | undefined {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!activeTab) return undefined;
    const input = activeTab.input;
    if (!(input instanceof vscode.TabInputCustom)) return undefined;
    // VS Code may prefix the viewType (e.g. `mainThreadCustomEditor-...`),
    // so accept either exact or suffix match.
    if (input.viewType !== VIEW_TYPE && !input.viewType.endsWith(VIEW_TYPE)) {
      return undefined;
    }
    const uriStr = input.uri.toString();
    for (const entry of this.entries.values()) {
      if (entry.document.uri.toString() === uriStr) return entry;
    }
    return undefined;
  }

  getActiveMode(): Mode | undefined {
    return this.getActiveEntry()?.mode;
  }

  requestCopy(kind: 'plain' | 'markdown' | 'html'): void {
    const entry = this.getActiveEntry();
    if (!entry) {
      void vscode.window.showWarningMessage('No active markdown editor.');
      return;
    }
    entry.panel.webview.postMessage({ type: 'requestCopy', kind });
  }

  async exportPdf(): Promise<void> {
    const entry = this.getActiveEntry();
    if (!entry) {
      void vscode.window.showWarningMessage('No active markdown editor.');
      return;
    }
    // Force a fresh render so the print captures the current document, even
    // if the user is in source-only mode (where renderedContent isn't
    // updated on doc changes).
    await this.pushRender(entry);
    // Brief pause so the webview applies the rendered HTML before print.
    await new Promise((resolve) => setTimeout(resolve, 80));
    entry.panel.webview.postMessage({ type: 'print' });
    void vscode.window.showInformationMessage(
      'Use the system print dialog\'s "Save as PDF" option.',
    );
  }

  async revealHeading(uri: vscode.Uri, line: number): Promise<void> {
    const uriStr = uri.toString();
    let entry: PanelEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.document.uri.toString() === uriStr) { entry = e; break; }
    }
    if (!entry) {
      // The file isn't open in our editor — open it now (vscode.openWith
      // routes to our custom editor since it's the default for *.md/.markdown).
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      // Find the freshly-resolved entry; resolve happens synchronously enough
      // that the panel is in the map by the time openWith resolves.
      for (const e of this.entries.values()) {
        if (e.document.uri.toString() === uriStr) { entry = e; break; }
      }
    } else {
      entry.panel.reveal(entry.panel.viewColumn, false);
    }
    if (!entry) return;
    entry.panel.webview.postMessage({ type: 'scrollToLine', line });
  }

  toggleActive(): void {
    const entry = this.getActiveEntry();
    if (!entry) return;
    // Toggle between source-only and preview-only. From either split mode the
    // toggle goes to preview (the more "different" view from the editor's
    // default split feel).
    const next: Mode = entry.mode === 'preview' ? 'source' : 'preview';
    entry.panel.webview.postMessage({ type: 'setMode', mode: next });
  }

  rerenderAllInRenderedMode(): void {
    for (const entry of this.entries.values()) {
      if (entry.mode !== 'source') void this.pushRender(entry);
    }
  }

  notifyThemeChanged(): void {
    for (const entry of this.entries.values()) {
      entry.panel.webview.postMessage({ type: 'themeChanged' });
      // Auto mode: when no explicit user choice, the resolved theme follows
      // VS Code, so we need to push fresh Monaco theme data and re-render.
      void this.pushThemeUpdate(entry);
    }
  }

  notifySecondRowChanged(): void {
    const value = readSecondRow();
    for (const entry of this.entries.values()) {
      entry.panel.webview.postMessage({ type: 'secondRowChanged', value });
    }
  }

  notifyRenderSettingsChanged(): void {
    const settings = readRenderSettings();
    for (const entry of this.entries.values()) {
      entry.panel.webview.postMessage({ type: 'renderSettingsChanged', settings });
      if (entry.mode !== 'source') void this.pushRender(entry);
    }
  }

  notifyConfigChanged(): void {
    for (const entry of this.entries.values()) void this.pushThemeUpdate(entry);
  }

  applyLivePreview(
    state: ThemeTabState,
    scope: 'all' | 'this',
    targetFile: string | null,
  ): void {
    this.liveOverlay = { state, scope, targetFile };
    for (const entry of this.entries.values()) {
      if (this.entryAffectedByOverlay(entry)) void this.pushThemeUpdate(entry);
    }
  }

  endLivePreview(): void {
    const had = !!this.liveOverlay;
    this.liveOverlay = undefined;
    if (had) {
      for (const entry of this.entries.values()) void this.pushThemeUpdate(entry);
    }
  }

  private entryAffectedByOverlay(entry: PanelEntry): boolean {
    if (!this.liveOverlay) return false;
    if (this.liveOverlay.scope === 'all') return true;
    return entry.document.uri.fsPath === this.liveOverlay.targetFile;
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    const monacoRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs');
    const distRoot = vscode.Uri.joinPath(this.extensionUri, 'dist');

    const localRoots: vscode.Uri[] = [distRoot];
    const ws = vscode.workspace.getWorkspaceFolder(document.uri);
    if (ws) localRoots.push(ws.uri);
    localRoots.push(vscode.Uri.file(path.dirname(document.uri.fsPath)));
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: localRoots,
    };

    // Entry's view fields are filled in below; for the initial HTML we just
    // need its mode for the CSS class.
    const tempEntryMode = DEFAULT_MODE;
    panel.webview.html = this.buildHtml(panel.webview, monacoRoot, tempEntryMode);

    const entry: PanelEntry = {
      panel,
      document,
      mode: DEFAULT_MODE,
      dividerH: 50,
      dividerV: 50,
      syncScroll: true,
      lastAppliedText: null,
      disposables: [],
      renderTimer: undefined,
    };
    this.entries.set(panel, entry);

    const recvDisposable = panel.webview.onDidReceiveMessage((msg: unknown) => {
      void this.handleWebviewMessage(entry, msg);
    });
    entry.disposables.push(recvDisposable);

    const docChangeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const text = e.document.getText();
      // The render always needs to fire — the document genuinely changed.
      if (entry.mode !== 'source') this.scheduleRender(entry);
      // The docUpdate push only fires for changes that didn't originate in
      // this webview — otherwise the webview already has the latest text and
      // pushing it back would (a) be wasteful and (b) potentially loop.
      if (text === entry.lastAppliedText) {
        entry.lastAppliedText = null;
        return;
      }
      entry.lastAppliedText = null;
      panel.webview.postMessage({ type: 'docUpdate', text });
    });
    entry.disposables.push(docChangeDisposable);

    const viewStateDisposable = panel.onDidChangeViewState(() => {
      this.onDidChangeActiveModeEmitter.fire();
    });
    entry.disposables.push(viewStateDisposable);

    panel.onDidDispose(() => {
      for (const d of entry.disposables) d.dispose();
      if (entry.renderTimer) clearTimeout(entry.renderTimer);
      this.entries.delete(panel);
      this.onDidChangeActiveModeEmitter.fire();
    });

    // Hand over initial state. VS Code queues messages until the webview is
    // ready, so this is safe even though Monaco hasn't loaded yet.
    panel.webview.postMessage({
      type: 'init',
      text: document.getText(),
      languageId: document.languageId || 'markdown',
      view: {
        mode: entry.mode,
        dividerH: entry.dividerH,
        dividerV: entry.dividerV,
        syncScroll: entry.syncScroll,
      },
      secondRow: readSecondRow(),
      settings: readRenderSettings(),
    });
    void this.pushThemeUpdate(entry);
    if (entry.mode !== 'source') void this.pushRender(entry);

    // Fire emitter so the status bar updates when the editor first resolves
    // (the activate-on-open state change happens before the listener was
    // registered, so we'd otherwise miss it).
    this.onDidChangeActiveModeEmitter.fire();
  }

  private async handleWebviewMessage(entry: PanelEntry, raw: unknown): Promise<void> {
    const msg = raw as { type?: string; [k: string]: unknown };
    switch (msg.type) {
      case 'ready':
        // Webview finished loading Monaco.
        break;
      case 'edit': {
        const text = String(msg.text ?? '');
        if (text === entry.document.getText()) return;
        entry.lastAppliedText = text;
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          entry.document.positionAt(0),
          entry.document.positionAt(entry.document.getText().length),
        );
        edit.replace(entry.document.uri, fullRange, text);
        await vscode.workspace.applyEdit(edit);
        break;
      }
      case 'modeChanged': {
        const mode = parseMode(msg.mode);
        entry.mode = mode;
        this.onDidChangeActiveModeEmitter.fire();
        break;
      }
      case 'requestRender': {
        await this.pushRender(entry);
        break;
      }
      case 'setDivider': {
        const axis = msg.axis === 'v' ? 'v' : 'h';
        const value = clampPct(Number(msg.value));
        if (axis === 'h') entry.dividerH = value;
        else entry.dividerV = value;
        break;
      }
      case 'setSyncScroll': {
        entry.syncScroll = !!msg.value;
        break;
      }
      case 'changeSecondRow': {
        const next = msg.value === 'theme' || msg.value === 'formatting' ? msg.value : 'none';
        await vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .update(CONFIG_KEY_SECOND_ROW, next, vscode.ConfigurationTarget.Global);
        // Push immediately so the originating webview updates without
        // depending on the config-change listener round-trip.
        for (const e of this.entries.values()) {
          e.panel.webview.postMessage({ type: 'secondRowChanged', value: next });
        }
        break;
      }
      case 'navigate': {
        const href = String(msg.href ?? '');
        await this.handleNavigate(entry, href);
        break;
      }
      case 'toggleTaskList': {
        const line = Number(msg.line);
        if (!Number.isInteger(line) || line < 0) break;
        await this.handleToggleTaskList(entry, line);
        break;
      }
      case 'copyHeadingAnchor': {
        const slug = String(msg.slug ?? '');
        if (!slug) break;
        const filename = path.basename(entry.document.uri.fsPath);
        const wsFolder = vscode.workspace.getWorkspaceFolder(entry.document.uri);
        const filePath = wsFolder
          ? vscode.workspace.asRelativePath(entry.document.uri, false)
          : filename;
        await vscode.env.clipboard.writeText(`${filePath}#${slug}`);
        break;
      }
      case 'pasteImage':
      case 'dropImage': {
        await this.handleImageData(entry, msg);
        break;
      }
      case 'copyMarkdownRange': {
        // Webview has resolved a selection to source line range; we slice
        // the document text and write to the system clipboard.
        const startLine = Math.max(0, Math.floor(Number(msg.startLine ?? 0)));
        const endLine = Math.max(startLine, Math.floor(Number(msg.endLine ?? startLine)));
        const lines: string[] = [];
        const max = Math.min(endLine, entry.document.lineCount - 1);
        for (let i = startLine; i <= max; i++) {
          lines.push(entry.document.lineAt(i).text);
        }
        await vscode.env.clipboard.writeText(lines.join('\n'));
        break;
      }
      case 'copyMarkdownAll': {
        await vscode.env.clipboard.writeText(entry.document.getText());
        break;
      }
      case 'copyDone': {
        const label = msg.label === 'string' ? msg.label : (msg.kind ?? 'content');
        void vscode.window.showInformationMessage(`Copied ${String(label)} to clipboard.`);
        break;
      }
      case 'invokeCommand': {
        // Allow the webview to fire whitelisted commands via the header icons.
        const command = String(msg.command ?? '');
        if (command === 'liveMarkdown.openThemeTab' || command === 'liveMarkdown.openSettings') {
          await vscode.commands.executeCommand(command);
        }
        break;
      }
    }
  }

  private resolveThemes(entry: PanelEntry): { mode: ThemeMode; themes: ModeThemes } {
    if (this.liveOverlay && this.entryAffectedByOverlay(entry)) {
      const m = this.liveOverlay.state.mode;
      return { mode: m, themes: this.liveOverlay.state.themes[m] };
    }
    const global = readGlobalThemes();
    const mode = currentModeFromVSCode();
    const perFile = readPerFileThemes(this.workspaceState, entry.document.uri.fsPath);
    return { mode, themes: resolveModeThemes(global, mode, perFile) };
  }

  private async pushThemeUpdate(entry: PanelEntry): Promise<void> {
    const { themes } = this.resolveThemes(entry);
    const sourceUser = themes.source.theme;
    const previewUser = themes.preview.theme;
    const mermaidUser = themes.mermaid.theme;
    const sourceOverrides = themes.source.overrides ?? {};
    const previewOverrides = themes.preview.overrides ?? {};
    const mermaidOverrides = themes.mermaid.overrides ?? {};

    let monacoTheme: Monaco.editor.IStandaloneThemeData | null = null;
    let monacoThemeName = 'vscode-dynamic';
    if (sourceUser) {
      try {
        const resolved = resolveShikiTheme(sourceUser);
        const reg = await getShikiThemeRegistration(resolved);
        let mt = shikiThemeToMonaco(reg);
        mt = applyMonacoOverrides(mt, sourceOverrides);
        monacoTheme = mt;
        // Use a unique name per render so Monaco's defineTheme applies fresh
        // overrides even when only the override values changed.
        monacoThemeName =
          Object.keys(sourceOverrides).length > 0
            ? `${resolved}-mt-${Date.now().toString(36)}`
            : resolved;
      } catch {
        monacoTheme = null;
      }
    }

    let bodyBg: string | null = null;
    let bodyFg: string | null = null;
    let previewThemeColors: Record<string, string> = {};
    if (previewUser) {
      try {
        const resolved = resolveShikiTheme(previewUser);
        const reg = await getShikiThemeRegistration(resolved);
        const monacoLike = shikiThemeToMonaco(reg);
        bodyBg = monacoLike.colors?.['editor.background'] ?? null;
        bodyFg = monacoLike.colors?.['editor.foreground'] ?? null;
        previewThemeColors = extractPreviewColors(reg.colors ?? {});
      } catch {
        bodyBg = null;
        bodyFg = null;
        previewThemeColors = {};
      }
    }
    // Preview body bg/fg may be explicitly overridden.
    if (previewOverrides.background) bodyBg = previewOverrides.background;
    if (previewOverrides.foreground) bodyFg = previewOverrides.foreground;

    if (this.entries.get(entry.panel) !== entry) return;
    entry.panel.webview.postMessage({
      type: 'themeUpdate',
      monacoTheme,
      monacoThemeName,
      bodyBg,
      bodyFg,
      mermaidTheme: mermaidUser || 'default',
      previewOverrides,
      previewThemeColors,
      mermaidOverrides,
    });
    if (entry.mode !== 'source') void this.pushRender(entry);
  }

  private scheduleRender(entry: PanelEntry): void {
    // setTimeout(0) coalesces multiple synchronous edits into one render
    // pass while still keeping the preview updating effectively in real-time.
    if (entry.renderTimer) return;
    entry.renderTimer = setTimeout(() => {
      entry.renderTimer = undefined;
      void this.pushRender(entry);
    }, 0);
  }

  private async pushRender(entry: PanelEntry): Promise<void> {
    let html: string;
    const settings = readRenderSettings();
    const { themes } = this.resolveThemes(entry);
    try {
      html = await renderMarkdown(
        entry.document.getText(),
        themes.code.theme,
        settings.showFrontMatter,
        themes.code.overrides ?? {},
      );
      html = rewriteImageUrls(html, entry.document, entry.panel.webview);
    } catch (e) {
      html = `<p class="md-error">Render failed: ${escapeHtml((e as Error).message)}</p>`;
    }
    if (this.entries.get(entry.panel) !== entry) return;
    entry.panel.webview.postMessage({ type: 'renderedHtml', html });
  }

  private async handleImageData(
    entry: PanelEntry,
    msg: { type?: string; data?: unknown; ext?: unknown; filename?: unknown },
  ): Promise<void> {
    const ws = vscode.workspace.getWorkspaceFolder(entry.document.uri);
    if (!ws) {
      void vscode.window.showWarningMessage(
        'Sweet Markdown: open a workspace folder to paste/drop images.',
      );
      return;
    }
    const dataArr = Array.isArray(msg.data) ? (msg.data as number[]) : null;
    if (!dataArr || dataArr.length === 0) return;
    const ext = sanitizeExt(typeof msg.ext === 'string' ? msg.ext : 'png');
    const proposedName = typeof msg.filename === 'string' ? msg.filename : null;
    const folderSetting = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>('imagePasteFolder', './assets');
    const folderAbs = path.resolve(ws.uri.fsPath, folderSetting);
    await fs.promises.mkdir(folderAbs, { recursive: true });

    const finalName = pickFilename(folderAbs, proposedName, ext);
    const finalPath = path.join(folderAbs, finalName);
    await fs.promises.writeFile(finalPath, Uint8Array.from(dataArr));

    const docDir = path.dirname(entry.document.uri.fsPath);
    let rel = path.relative(docDir, finalPath).replace(/\\/g, '/');
    if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
    entry.panel.webview.postMessage({ type: 'insertImage', path: rel });
  }

  private async handleToggleTaskList(entry: PanelEntry, line: number): Promise<void> {
    if (line >= entry.document.lineCount) return;
    const lineText = entry.document.lineAt(line).text;
    const m = /^(\s*[-*+]\s+\[)([ xX])(\])/.exec(lineText);
    if (!m) return;
    const startCol = m[1].length;
    const newChar = m[2] === ' ' ? 'x' : ' ';
    const range = new vscode.Range(line, startCol, line, startCol + 1);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(entry.document.uri, range, newChar);
    await vscode.workspace.applyEdit(edit);
  }

  private async handleNavigate(entry: PanelEntry, href: string): Promise<void> {
    if (!href) return;
    if (href.startsWith('#')) {
      // Anchor — webview handles scrolling itself; nothing to do here.
      return;
    }
    let target: vscode.Uri;
    try {
      const parsed = vscode.Uri.parse(href, true);
      if (parsed.scheme === 'http' || parsed.scheme === 'https' || parsed.scheme === 'mailto') {
        await vscode.env.openExternal(parsed);
        return;
      }
      target = parsed;
    } catch {
      // Treat as relative path
      target = vscode.Uri.joinPath(entry.document.uri, '..', href);
    }
    if (target.scheme === 'file' || target.scheme === '') {
      // Strip query/fragment for the open
      const clean = target.with({ query: '', fragment: '' });
      await vscode.commands.executeCommand('vscode.open', clean);
    } else {
      await vscode.env.openExternal(target);
    }
  }

  private buildHtml(webview: vscode.Webview, monacoRoot: vscode.Uri, mode: Mode): string {
    const entry = { mode };
    const secondRow = readSecondRow();
    const monacoBaseUri = webview.asWebviewUri(monacoRoot).toString();
    const loaderUri = webview.asWebviewUri(vscode.Uri.joinPath(monacoRoot, 'loader.js'));
    const editorCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(monacoRoot, 'editor', 'editor.main.css'),
    );
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicons', 'codicon.css'),
    );
    const katexCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'katex', 'katex.min.css'),
    );
    const cspSource = webview.cspSource;
    const nonce = makeNonce();

    // Worker bootstrap is built at runtime via Blob URL — see inline script below.

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-eval' 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource} data:; img-src ${cspSource} https: data:; worker-src ${cspSource} blob: data:;" />
<link rel="stylesheet" href="${editorCssUri}" />
<link rel="stylesheet" href="${codiconCssUri}" />
<link rel="stylesheet" href="${katexCssUri}" />
<style>${stylesheet()}</style>
</head>
<body data-second-row="${secondRow}">
<div id="header">
  <div class="view-icons" role="radiogroup" aria-label="View mode">
    <button class="icon-btn" data-mode="source" type="button" data-tooltip="Source only" aria-label="Source only" role="radio"><i class="codicon codicon-file-code"></i></button>
    <button class="icon-btn" data-mode="preview" type="button" data-tooltip="Preview only" aria-label="Preview only" role="radio"><i class="codicon codicon-eye"></i></button>
    <button class="icon-btn" data-mode="split-horizontal" type="button" data-tooltip="Split: source left, preview right" aria-label="Split horizontal" role="radio"><i class="codicon codicon-split-horizontal"></i></button>
    <button class="icon-btn" data-mode="split-vertical" type="button" data-tooltip="Split: source top, preview bottom" aria-label="Split vertical" role="radio"><i class="codicon codicon-split-vertical"></i></button>
    <span class="icon-divider"></span>
    <button id="sync-scroll-btn" class="icon-btn" type="button" data-tooltip="Sync scroll between source and preview" aria-label="Sync scroll"><i class="codicon codicon-sync"></i></button>
  </div>
  <span class="header-spacer"></span>
  <button id="outline-toggle-btn" class="icon-btn" type="button" data-tooltip="Show outline" aria-label="Outline"><i class="codicon codicon-list-tree"></i></button>
  <button id="format-toggle-btn" class="icon-btn" type="button" data-tooltip="Show formatting toolbar" aria-label="Formatting toolbar"><i class="codicon codicon-symbol-keyword"></i></button>
  <button id="theme-tab-btn" class="icon-btn" type="button" data-tooltip="Open theme management" aria-label="Themes"><i class="codicon codicon-paintcan"></i></button>
  <button id="settings-btn" class="icon-btn" type="button" data-tooltip="Open settings" aria-label="Settings"><i class="codicon codicon-settings-gear"></i></button>
</div>
<div id="format-row" class="second-row" data-second-row-target="formatting">
  ${formatToolbarHtml()}
</div>
<div id="content" class="mode-${entry.mode}">
  <div id="source-pane">
    <div id="monaco-container"></div>
  </div>
  <div id="divider" role="separator" aria-orientation="vertical"></div>
  <div id="rendered-pane">
    <div id="outline-panel" aria-hidden="true">
      <div id="outline-header">Outline</div>
      <ul id="outline-list"></ul>
    </div>
    <div id="rendered-scroll">
      <div id="rendered-content"></div>
    </div>
  </div>
</div>
<script nonce="${nonce}">
window.__MONACO_BASE_URL__ = ${JSON.stringify(monacoBaseUri)};
// Build a Blob-URL worker bootstrap. Blob workers are same-origin as the
// page that created them (the webview), so they can importScripts the
// AMD loader from the webview's vscode-resource origin. data: URLs run in
// an opaque origin and the importScripts call gets blocked.
(function () {
  var bootSrc =
    "self.MonacoEnvironment={baseUrl:'" + ${JSON.stringify(monacoBaseUri)} + "'};" +
    "importScripts('" + ${JSON.stringify(monacoBaseUri)} + "/loader.js');";
  var workerUrl = URL.createObjectURL(new Blob([bootSrc], { type: 'application/javascript' }));
  self.MonacoEnvironment = {
    baseUrl: ${JSON.stringify(monacoBaseUri)},
    getWorkerUrl: function () { return workerUrl; }
  };
})();
</script>
<script nonce="${nonce}" src="${loaderUri}"></script>
<script nonce="${nonce}" src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}

function formatToolbarHtml(): string {
  return FORMAT_BUTTONS.map((b, i) => {
    const prevGroup = i > 0 ? FORMAT_BUTTONS[i - 1].group : b.group;
    const sep = b.group !== prevGroup ? '<span class="format-divider"></span>' : '';
    return `${sep}<button class="icon-btn format-btn" data-format-action="${b.id}" type="button" data-tooltip="${b.tooltip}" aria-label="${b.aria}"><i class="codicon ${b.codicon}"></i></button>`;
  }).join('\n  ');
}

interface FormatButtonDef {
  group: number;
  id: string;
  codicon: string;
  tooltip: string;
  aria: string;
}

const FORMAT_BUTTONS: FormatButtonDef[] = [
  // Group 1 — inline formatting
  { group: 1, id: 'bold', codicon: 'codicon-bold', tooltip: 'Bold (⌘B)', aria: 'Bold' },
  { group: 1, id: 'italic', codicon: 'codicon-italic', tooltip: 'Italic (⌘I)', aria: 'Italic' },
  { group: 1, id: 'strike', codicon: 'codicon-strikethrough', tooltip: 'Strikethrough', aria: 'Strikethrough' },
  { group: 1, id: 'inlineCode', codicon: 'codicon-code', tooltip: 'Inline code (⌘E)', aria: 'Inline code' },
  // Group 2 — block elements
  { group: 2, id: 'heading', codicon: 'codicon-symbol-text', tooltip: 'Heading (cycles H1→H6→none)', aria: 'Heading' },
  { group: 2, id: 'bullet', codicon: 'codicon-list-unordered', tooltip: 'Bulleted list', aria: 'Bulleted list' },
  { group: 2, id: 'numbered', codicon: 'codicon-list-ordered', tooltip: 'Numbered list', aria: 'Numbered list' },
  { group: 2, id: 'task', codicon: 'codicon-checklist', tooltip: 'Task list', aria: 'Task list' },
  { group: 2, id: 'quote', codicon: 'codicon-quote', tooltip: 'Block quote', aria: 'Block quote' },
  { group: 2, id: 'codeblock', codicon: 'codicon-code-oss', tooltip: 'Code block', aria: 'Code block' },
  { group: 2, id: 'hr', codicon: 'codicon-horizontal-rule', tooltip: 'Horizontal rule', aria: 'Horizontal rule' },
  // Group 3 — links & media
  { group: 3, id: 'link', codicon: 'codicon-link', tooltip: 'Link (⌘K)', aria: 'Link' },
  { group: 3, id: 'image', codicon: 'codicon-file-media', tooltip: 'Image', aria: 'Image' },
];

function stylesheet(): string {
  return `
html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
body {
  font-family: var(--vscode-font-family);
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  display: flex;
  flex-direction: column;
}
#header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.35em 0.75em;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  font-size: 0.85em;
  user-select: none;
}
#toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.25em 0.7em;
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-contrastBorder, transparent);
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
}
#toggle-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
}
#toggle-btn:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.view-icons { display: inline-flex; align-items: center; gap: 2px; }
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  background: transparent;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.75;
}
.icon-btn .codicon { font-size: 14px; line-height: 1; }
.icon-btn { position: relative; }
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.icon-btn.active { opacity: 1; background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); }
.icon-btn[disabled] { opacity: 0.35; cursor: default; }
.icon-btn[disabled]:hover { background: transparent; }
.icon-btn[disabled][data-tooltip-disabled-reason]:hover::after {
  content: attr(data-tooltip-disabled-reason) !important;
}
.icon-btn[data-tooltip]:hover::after {
  content: attr(data-tooltip);
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  max-width: min(40ch, 80vw);
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)));
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 0.85em;
  z-index: 1000;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.icon-btn[data-tooltip]:hover::before {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-bottom-color: var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)));
  margin-top: -4px;
  pointer-events: none;
  z-index: 1000;
}
/* Tooltips on the first icon (Source) anchor to the icon's left edge so
   they extend rightward instead of being clipped by the webview frame. */
.view-icons > .icon-btn:first-child[data-tooltip]:hover::after {
  left: 0;
  transform: none;
}
.icon-divider {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--vscode-editorWidget-border, var(--vscode-panel-border));
  opacity: 0.6;
}
.header-spacer { flex: 1 1 auto; }
.theme-pair { display: inline-flex; align-items: center; gap: 0.3em; opacity: 0.95; }
.theme-pair > span { opacity: 0.8; }
#header select {
  font-family: inherit;
  font-size: inherit;
  background: var(--vscode-dropdown-background, var(--vscode-input-background, transparent));
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground, var(--vscode-foreground)));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
  border-radius: 3px;
  padding: 0.2em 0.5em;
  cursor: pointer;
}
#header select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
#scope-label { display: inline-flex; align-items: center; gap: 0.3em; cursor: pointer; user-select: none; opacity: 0.85; }
#scope-label input { margin: 0; }

/* Second row (theme controls or formatting toolbar). */
.second-row {
  display: none;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.5em;
  padding: 0.3em 0.75em;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  font-size: 0.85em;
  user-select: none;
}
body[data-second-row="theme"] #theme-row { display: flex; }
body[data-second-row="formatting"] #format-row { display: flex; }
.format-divider {
  display: inline-block;
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--vscode-editorWidget-border, var(--vscode-panel-border));
  opacity: 0.6;
}
.icon-btn[disabled] { opacity: 0.35; cursor: default; }
.icon-btn[disabled]:hover { background: transparent; }

#content {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  min-width: 0;
}
#content.mode-split-horizontal { flex-direction: row; }
#content.mode-split-vertical { flex-direction: column; }
#content.mode-source { flex-direction: row; }
#content.mode-preview { flex-direction: row; }

#source-pane, #rendered-pane { min-width: 0; min-height: 0; flex: 0 0 50%; position: relative; }
#source-pane { overflow: hidden; }
/* The pane itself does NOT scroll; the inner #rendered-scroll does. That
   keeps absolutely-positioned children (notably #outline-panel) anchored
   to the visible viewport instead of riding the scrolling content. */
#rendered-pane {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--mt-theme-bg, var(--vscode-editor-background));
  color: var(--mt-theme-fg, var(--vscode-editor-foreground));
}
#rendered-scroll {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  overflow: auto;
}

/* Outline panel slides in from the right of the rendered pane. The toggle
   button itself lives in the main header; clicking it toggles the panel. */
#outline-panel {
  position: absolute;
  top: 0; right: 0; bottom: 0;
  width: 280px;
  background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
  border-left: 1px solid var(--vscode-sideBar-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)));
  transform: translateX(100%);
  transition: transform 0.18s ease-out;
  overflow-y: auto;
  padding: 0.5em 0;
  z-index: 5;
  font-size: 0.85em;
}
#rendered-pane.outline-open #outline-panel { transform: translateX(0); }
#outline-header {
  padding: 0.4em 1em 0.5em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.8;
  font-size: 0.9em;
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  margin-bottom: 0.3em;
}
#outline-list { list-style: none; padding: 0; margin: 0; }
.outline-item {
  padding: 0.25em 1em;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  border-left: 2px solid transparent;
}
.outline-item:hover { background: var(--vscode-list-hoverBackground); }
.outline-item.active {
  background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
  border-left-color: var(--vscode-focusBorder);
}

/* Heading anchor links — hidden until heading hover. */
#rendered-content .heading-anchor {
  display: inline-block;
  margin-left: -1em;
  margin-right: 0.15em;
  width: 0.85em;
  text-align: center;
  text-decoration: none;
  color: var(--vscode-textLink-foreground);
  opacity: 0;
  transition: opacity 0.12s;
  position: relative;
  font-weight: normal;
}
#rendered-content h1:hover .heading-anchor,
#rendered-content h2:hover .heading-anchor,
#rendered-content h3:hover .heading-anchor,
#rendered-content h4:hover .heading-anchor,
#rendered-content h5:hover .heading-anchor,
#rendered-content h6:hover .heading-anchor { opacity: 0.55; }
#rendered-content .heading-anchor:hover { opacity: 1 !important; }
.anchor-flash {
  position: absolute;
  top: -1.6em;
  left: 50%;
  transform: translateX(-50%);
  font-size: 0.75em;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border));
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

/* Front matter styled box. */
#rendered-content .front-matter {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.85em;
  background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  border-left-width: 3px;
  border-left-color: var(--vscode-textLink-foreground);
  padding: 0.6em 1em;
  margin: 0 0 1em 0;
  border-radius: 4px;
}
#rendered-content .fm-line { line-height: 1.5; }
#rendered-content .fm-key { color: var(--vscode-symbolIcon-keyForeground, var(--vscode-textLink-foreground)); font-weight: 500; }
#rendered-content .fm-colon { opacity: 0.6; }
#rendered-content .fm-value { color: var(--vscode-symbolIcon-stringForeground, var(--vscode-foreground)); }
#rendered-content .fm-raw { opacity: 0.7; font-style: italic; }

/* Task list checkbox: interactive in rendered pane. */
#rendered-content input[type="checkbox"] { cursor: pointer; }

/* KaTeX math integration: inherit the preview's text color so math is
   readable in any theme; style errors with the preview's error chrome. */
#rendered-content .katex { color: inherit; }
#rendered-content .katex-display { margin: 1em 0; }
#rendered-content .katex-display > .katex { display: block; text-align: center; }
#rendered-content .katex-error {
  color: var(--vscode-editorError-foreground, #f44);
  background: var(--vscode-inputValidation-errorBackground, transparent);
  border: 1px solid var(--vscode-editorError-foreground, #f44);
  border-radius: 3px;
  padding: 0 0.3em;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
}

@media print {
  #header, .second-row, #source-pane, #divider,
  #outline-panel, #outline-toggle-btn { display: none !important; }
  body { display: block !important; height: auto !important; overflow: visible !important; }
  #content { display: block !important; flex: none !important; }
  #rendered-pane {
    position: static !important;
    overflow: visible !important;
    display: block !important;
    width: 100% !important;
    background: white !important;
    color: black !important;
  }
  #rendered-scroll {
    overflow: visible !important;
    height: auto !important;
    flex: none !important;
  }
  #rendered-content {
    max-width: none !important;
    padding: 0 !important;
    color: black !important;
  }
  pre, pre.shiki, pre.shiki code, pre code {
    background: #f6f8fa !important;
    color: inherit !important;
  }
}

/* Mermaid diagrams. */
#rendered-content .mermaid-diagram { margin: 1em 0; text-align: center; }
#rendered-content .mermaid-diagram svg { max-width: 100%; height: auto; }
#rendered-content pre.mermaid-error {
  background: var(--vscode-inputValidation-errorBackground, var(--vscode-textCodeBlock-background));
  border-left: 3px solid var(--vscode-editorError-foreground, #f44);
  color: var(--vscode-editor-foreground);
  padding: 0.6em 1em;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.85em;
  white-space: pre-wrap;
  border-radius: 4px;
}

/* Single-pane modes: the visible pane fills the container; the other pane and divider hide. */
#content.mode-source #source-pane { flex: 1 1 auto; }
#content.mode-source #divider, #content.mode-source #rendered-pane { display: none; }
#content.mode-preview #rendered-pane { flex: 1 1 auto; }
#content.mode-preview #divider, #content.mode-preview #source-pane { display: none; }

/* Split modes: source-pane gets explicit flex-basis from JS, rendered-pane fills remainder. */
#content.mode-split-horizontal #rendered-pane,
#content.mode-split-vertical #rendered-pane { flex: 1 1 auto; }

#divider {
  flex: 0 0 6px;
  background: var(--vscode-editorWidget-border, var(--vscode-panel-border));
  opacity: 0.5;
}
#divider:hover, #divider.dragging { background: var(--vscode-focusBorder); opacity: 1; }
#content.mode-split-horizontal #divider { cursor: col-resize; }
#content.mode-split-vertical #divider { cursor: row-resize; }

#monaco-container { height: 100%; width: 100%; }
#rendered-content {
  padding: 1.5em 2em 4em;
  line-height: 1.6;
  max-width: 64em;
  margin: 0 auto;
  font-size: var(--vscode-font-size);
  color: inherit;
}
/* Fallback chain for preview prose styling:
   user override (--mt-pv-*) -> theme.colors hint (--mt-pt-*) -> VS Code chrome.
   applyPreviewOverrides (webview side) sets/clears --mt-pv-* per token;
   applyPreviewThemeColors sets --mt-pt-* from the active theme JSON. */
#rendered-pane {
  background: var(--mt-pv-bg, var(--mt-pt-background, var(--mt-theme-bg, var(--vscode-editor-background))));
  color: var(--mt-pv-fg, var(--mt-pt-foreground, var(--mt-theme-fg, var(--vscode-editor-foreground))));
}
#rendered-content h1, #rendered-content h2, #rendered-content h3,
#rendered-content h4, #rendered-content h5, #rendered-content h6 {
  color: var(--mt-pv-heading, var(--mt-pt-heading, inherit));
  margin-top: 1.2em;
}
#rendered-content h1, #rendered-content h2 {
  border-bottom: 1px solid var(--mt-pv-table-border, var(--mt-pt-table-border, var(--vscode-editorWidget-border, var(--vscode-panel-border))));
  padding-bottom: 0.2em;
}
#rendered-content h1 { font-size: 2em; }
#rendered-content h2 { font-size: 1.5em; }
#rendered-content h3 { font-size: 1.25em; }
#rendered-content a { color: var(--mt-pv-link, var(--mt-pt-link, var(--vscode-textLink-foreground))); text-decoration: none; }
#rendered-content a:hover { color: var(--mt-pv-link-hover, var(--mt-pt-link-hover, var(--vscode-textLink-activeForeground))); text-decoration: underline; }
#rendered-content code:not(pre code) {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
  background: var(--mt-pv-inline-bg, var(--mt-pt-inline-code-bg, var(--vscode-textCodeBlock-background)));
  color: var(--mt-pv-inline-fg, var(--mt-pt-inline-code-fg, inherit));
  padding: 0.1em 0.4em;
  border-radius: 3px;
}
#rendered-content pre {
  font-family: var(--vscode-editor-font-family);
  background: var(--mt-pv-code-bg, var(--mt-pt-code-block-bg, var(--vscode-textCodeBlock-background))) !important;
  padding: 1em;
  overflow-x: auto;
  border-radius: 4px;
  font-size: 0.9em;
}
#rendered-content pre code { background: transparent; padding: 0; }
#rendered-content pre.shiki { background: var(--mt-pv-code-bg, var(--mt-pt-code-block-bg, var(--vscode-textCodeBlock-background))) !important; }
#rendered-content pre.shiki code { background: transparent !important; }
#rendered-content blockquote {
  border-left: 4px solid var(--mt-pv-bq-border, var(--mt-pt-blockquote-border, var(--vscode-textBlockQuote-border, var(--vscode-editorWidget-border))));
  background: var(--vscode-textBlockQuote-background, transparent);
  color: var(--mt-pv-bq-fg, var(--mt-pt-blockquote-fg, inherit));
  padding: 0.5em 1em;
  margin: 1em 0;
}
#rendered-content table { border-collapse: collapse; margin: 1em 0; }
#rendered-content th, #rendered-content td {
  border: 1px solid var(--mt-pv-table-border, var(--mt-pt-table-border, var(--vscode-editorWidget-border, var(--vscode-panel-border))));
  padding: 0.4em 0.8em;
}
#rendered-content th { background: var(--mt-pv-table-header, var(--mt-pt-table-header-bg, var(--vscode-editor-inactiveSelectionBackground, transparent))); font-weight: 600; }
#rendered-content hr { border: none; border-top: 1px solid var(--mt-pv-hr, var(--mt-pt-hr, var(--vscode-editorWidget-border, var(--vscode-panel-border)))); margin: 2em 0; }
#rendered-content del, #rendered-content s { color: var(--mt-pv-strike, var(--mt-pt-strikethrough, inherit)); }
#rendered-content mark { background: var(--mt-pv-mark-bg, var(--mt-pt-mark-bg, #fff8c5)); color: inherit; }
#rendered-content img { max-width: 100%; }
#rendered-content ul.contains-task-list { list-style: none; padding-left: 1em; }
#rendered-content input[type="checkbox"] { margin-right: 0.5em; }
.md-error { color: var(--vscode-errorForeground); font-style: italic; }
`;
}

function parseMode(raw: unknown): Mode {
  if (raw === 'source' || raw === 'preview' || raw === 'split-horizontal' || raw === 'split-vertical') {
    return raw;
  }
  return DEFAULT_MODE;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 50;
  if (n < 5) return 5;
  if (n > 95) return 95;
  return n;
}


interface ShikiTokenSetting {
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
  // legacy alternative shape
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

interface ShikiThemeLike {
  name?: string;
  type?: 'dark' | 'light';
  settings?: ShikiTokenSetting[];
  tokenColors?: ShikiTokenSetting[];
  colors?: Record<string, string>;
  bg?: string;
  fg?: string;
}

function shikiThemeToMonaco(theme: unknown): Monaco.editor.IStandaloneThemeData {
  const t = theme as ShikiThemeLike;
  const isDark = t.type === 'dark';
  const sourceRules = (t.settings ?? t.tokenColors ?? []) as ShikiTokenSetting[];
  const rules: Monaco.editor.ITokenThemeRule[] = [];
  for (const s of sourceRules) {
    const settings = s.settings ?? {
      foreground: s.foreground,
      background: s.background,
      fontStyle: s.fontStyle,
    };
    if (!settings.foreground && !settings.background && !settings.fontStyle) continue;
    const scopes: string[] = Array.isArray(s.scope)
      ? s.scope
      : typeof s.scope === 'string'
      ? s.scope.split(',').map((x) => x.trim()).filter(Boolean)
      : [];
    if (scopes.length === 0) continue;
    for (const scope of scopes) {
      const rule: Monaco.editor.ITokenThemeRule = { token: scope };
      if (settings.foreground) rule.foreground = settings.foreground.replace(/^#/, '');
      if (settings.background) rule.background = settings.background.replace(/^#/, '');
      if (settings.fontStyle) rule.fontStyle = settings.fontStyle;
      rules.push(rule);
    }
  }
  const colors: Record<string, string> = {};
  if (t.colors) {
    for (const [k, v] of Object.entries(t.colors)) {
      if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) colors[k] = v;
    }
  }
  // Ensure the editor has a sane bg/fg even if the theme didn't specify
  // them in `colors`.
  if (!colors['editor.background'] && t.bg) colors['editor.background'] = t.bg;
  if (!colors['editor.foreground'] && t.fg) colors['editor.foreground'] = t.fg;
  return {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules,
    colors,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pull prose-relevant UI colors out of a shiki theme registration's `colors`
 * map. Themes that ship full UI color sets (GitHub, Noctis, Dracula) populate
 * most slots; minimal themes (Monokai) populate few. Anything missing simply
 * isn't returned and the webview falls through to VS Code's chrome.
 *
 * Mapping (theme color key → preview slot id, applied as --mt-pt-<slot>):
 *   editor.background           → background
 *   editor.foreground           → foreground, heading
 *   textLink.foreground         → link
 *   textLink.activeForeground   → link-hover
 *   textBlockQuote.border       → blockquote-border
 *   descriptionForeground       → blockquote-fg, strikethrough
 *   textCodeBlock.background    → inline-code-bg, code-block-bg
 *   editorWidget.background     → table-header-bg (and code-block fallback)
 *   editorWidget.border         → table-border, hr
 *   panel.border                → fallback for table-border, hr
 *   editor.selectionBackground  → mark-bg
 */
function extractPreviewColors(themeColors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (slot: string, value: string | undefined): void => {
    if (typeof value === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(value)) {
      out[slot] = value;
    }
  };
  set('background', themeColors['editor.background']);
  set('foreground', themeColors['editor.foreground']);
  set('heading', themeColors['editor.foreground']);
  set('link', themeColors['textLink.foreground']);
  set('link-hover', themeColors['textLink.activeForeground']);
  set('blockquote-border', themeColors['textBlockQuote.border']);
  set('blockquote-fg', themeColors['descriptionForeground']);
  set('inline-code-bg', themeColors['textCodeBlock.background']);
  set('inline-code-fg', themeColors['editor.foreground']);
  set('code-block-bg',
    themeColors['textCodeBlock.background'] ?? themeColors['editorWidget.background'],
  );
  set('table-border',
    themeColors['editorWidget.border'] ?? themeColors['panel.border'],
  );
  set('table-header-bg', themeColors['editorWidget.background']);
  set('hr',
    themeColors['editorWidget.border'] ?? themeColors['panel.border'],
  );
  set('strikethrough', themeColors['descriptionForeground']);
  set('mark-bg', themeColors['editor.selectionBackground']);
  return out;
}

function rewriteImageUrls(
  html: string,
  doc: vscode.TextDocument,
  webview: vscode.Webview,
): string {
  const docDir = path.dirname(doc.uri.fsPath);
  return html.replace(/<img\s+([^>]*?)src="([^"]+)"/gi, (match, attrs: string, src: string) => {
    if (/^(https?:|data:|blob:|vscode-webview:)/i.test(src)) return match;
    let absPath = src;
    if (!path.isAbsolute(absPath)) absPath = path.resolve(docDir, decodeURI(src));
    try {
      if (!fs.existsSync(absPath)) return match;
    } catch {
      return match;
    }
    const webviewSrc = webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
    return `<img ${attrs}src="${webviewSrc}"`;
  });
}

function sanitizeExt(raw: string): string {
  const lc = raw.toLowerCase().replace(/^\./, '');
  if (lc === 'jpeg') return 'jpg';
  if (/^[a-z0-9]{1,8}$/.test(lc)) return lc;
  return 'png';
}

function pickFilename(folderAbs: string, proposed: string | null, ext: string): string {
  const stamp = isoStamp();
  // Replace whitespace with `-` so the resulting markdown link parses cleanly
  // (markdown-it's link syntax doesn't accept bare spaces in URLs).
  const cleaned = proposed
    ? proposed.replace(/\s+/g, '-').replace(/[^\w\-.]/g, '')
    : null;
  const safe = cleaned && cleaned.length > 0 ? cleaned : null;
  if (!safe) return `paste-${stamp}.${ext}`;
  const candidate = path.join(folderAbs, safe);
  if (!fs.existsSync(candidate)) return safe;
  const parsed = path.parse(safe);
  const baseExt = parsed.ext || `.${ext}`;
  return `${parsed.name}-${stamp}${baseExt}`;
}

function isoStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
