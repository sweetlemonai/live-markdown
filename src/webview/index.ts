// Webview-side script. Bundled as IIFE by esbuild and loaded after Monaco's
// AMD loader has already pulled in `vs/editor/editor.main`.

import type * as Monaco from 'monaco-editor';
import mermaid from 'mermaid';
import { MERMAID_PRESETS, isMermaidNative } from '../mermaidPresets';

mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

declare global {
  interface Window {
    require: {
      (deps: string[], cb: () => void, err?: (e: unknown) => void): void;
      config(opts: { paths: Record<string, string> }): void;
    };
    MonacoEnvironment: unknown;
    monaco: typeof Monaco;
    __MONACO_BASE_URL__: string;
  }
}

type Mode = 'source' | 'preview' | 'split-horizontal' | 'split-vertical';
type SecondRow = 'none' | 'theme' | 'formatting';
interface ViewState { mode: Mode; dividerH: number; dividerV: number; syncScroll: boolean }
interface RenderSettings { showFrontMatter: boolean; showHeadingAnchors: boolean }

interface InitMessage {
  type: 'init';
  text: string;
  languageId: string;
  view: ViewState;
  secondRow: SecondRow;
  settings: RenderSettings;
}
interface RenderSettingsChangedMessage { type: 'renderSettingsChanged'; settings: RenderSettings }
interface ScrollToLineMessage { type: 'scrollToLine'; line: number }
interface InsertImageMessage { type: 'insertImage'; path: string }
interface RequestCopyMessage { type: 'requestCopy'; kind: 'plain' | 'markdown' | 'html' }
interface PrintMessage { type: 'print' }
interface SecondRowChangedMessage { type: 'secondRowChanged'; value: SecondRow }
interface DocUpdateMessage { type: 'docUpdate'; text: string }
interface SetModeMessage { type: 'setMode'; mode: Mode }
interface RenderedHtmlMessage { type: 'renderedHtml'; html: string }
interface ThemeChangedMessage { type: 'themeChanged' }
interface ThemeUpdateMessage {
  type: 'themeUpdate';
  monacoTheme: Monaco.editor.IStandaloneThemeData | null;
  monacoThemeName: string;
  bodyBg: string | null;
  bodyFg: string | null;
  mermaidTheme: string;
  previewOverrides: Record<string, string>;
  previewThemeColors: Record<string, string>;
  mermaidOverrides: Record<string, string>;
}

type IncomingMessage =
  | InitMessage
  | DocUpdateMessage
  | SetModeMessage
  | RenderedHtmlMessage
  | ThemeChangedMessage
  | ThemeUpdateMessage
  | SecondRowChangedMessage
  | RenderSettingsChangedMessage
  | ScrollToLineMessage
  | InsertImageMessage
  | RequestCopyMessage
  | PrintMessage;

const vscode = acquireVsCodeApi();

let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
let model: Monaco.editor.ITextModel | undefined;
let suppressNextEditEvent = false;
let monacoReady = false;
const messageQueue: IncomingMessage[] = [];

// View state mirrored from extension; updated on init and on user actions.
let view: ViewState = { mode: 'preview', dividerH: 50, dividerV: 50, syncScroll: true };
let secondRow: SecondRow = 'none';
let settings: RenderSettings = { showFrontMatter: false, showHeadingAnchors: true };

// DOM
const contentDiv = document.getElementById('content') as HTMLDivElement;
const sourcePane = document.getElementById('source-pane') as HTMLDivElement;
const renderedPane = document.getElementById('rendered-pane') as HTMLDivElement;
const renderedScroll = document.getElementById('rendered-scroll') as HTMLDivElement;
const loadingOverlay = document.getElementById('loading-overlay') as HTMLDivElement | null;

function hideLoadingOverlay(): void {
  if (!loadingOverlay || loadingOverlay.classList.contains('hidden')) return;
  loadingOverlay.classList.add('hidden');
  loadingOverlay.remove();
}
const dividerEl = document.getElementById('divider') as HTMLDivElement;
const monacoContainer = document.getElementById('monaco-container') as HTMLDivElement;
const renderedContent = document.getElementById('rendered-content') as HTMLDivElement;
const syncScrollBtn = document.getElementById('sync-scroll-btn') as HTMLButtonElement;
const formatToggleBtn = document.getElementById('format-toggle-btn') as HTMLButtonElement;
const themeTabBtn = document.getElementById('theme-tab-btn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const formatBtns: HTMLButtonElement[] = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.format-btn'),
);
const modeBtns: HTMLButtonElement[] = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.icon-btn[data-mode]'),
);

themeTabBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'invokeCommand', command: 'liveMarkdown.openThemeTab' });
});
settingsBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'invokeCommand', command: 'liveMarkdown.openSettings' });
});

// ---------- mode + layout ----------

function applyView(): void {
  contentDiv.className = `mode-${view.mode}`;
  if (view.mode === 'split-horizontal') {
    sourcePane.style.flexBasis = `${view.dividerH}%`;
  } else if (view.mode === 'split-vertical') {
    sourcePane.style.flexBasis = `${view.dividerV}%`;
  } else {
    sourcePane.style.flexBasis = '';
  }
  refreshModeButtons();
  refreshSyncButton();
  refreshFormatButtons();
  // Force Monaco to lay out after the className change is committed by the
  // browser. The synchronous editor.layout() runs before reflow, so it reads
  // stale 0×0 dimensions when transitioning from a mode where source-pane
  // was display:none — the editor stays blank until something else triggers
  // a relayout. Re-layout across rAF + a delayed setTimeout to also catch
  // cases where the first frame still hasn't applied the new size.
  if (editor) {
    editor.layout();
    requestAnimationFrame(() => editor?.layout());
    setTimeout(() => editor?.layout(), 60);
  }
}

function refreshModeButtons(): void {
  for (const b of modeBtns) {
    b.classList.toggle('active', b.dataset.mode === view.mode);
    b.setAttribute('aria-checked', b.dataset.mode === view.mode ? 'true' : 'false');
  }
}

function refreshSyncButton(): void {
  const inSplit = view.mode === 'split-horizontal' || view.mode === 'split-vertical';
  syncScrollBtn.disabled = !inSplit;
  syncScrollBtn.classList.toggle('active', view.syncScroll && inSplit);
  const tip = inSplit
    ? view.syncScroll ? 'Sync scroll: on (click to disable)' : 'Sync scroll: off (click to enable)'
    : 'Sync scroll (only in split modes)';
  syncScrollBtn.setAttribute('data-tooltip', tip);
  syncScrollBtn.setAttribute('aria-label', tip);
}

function setMode(next: Mode): void {
  if (next === view.mode) return;
  view.mode = next;
  applyView();
  if (next !== 'source') vscode.postMessage({ type: 'requestRender' });
  vscode.postMessage({ type: 'modeChanged', mode: next });
  vscode.setState({ mode: next });
  if (next === 'source' || next === 'split-horizontal' || next === 'split-vertical') {
    editor?.focus();
  }
  // User explicitly switched modes — they expect content immediately. If
  // the loading overlay is still up (e.g. preview render hasn't completed
  // and they switched to source), drop it now so it doesn't sit on top of
  // the source pane and look like an empty editor.
  hideLoadingOverlay();
}

for (const b of modeBtns) {
  b.addEventListener('click', () => {
    const m = b.dataset.mode as Mode | undefined;
    if (m) setMode(m);
  });
}

syncScrollBtn.addEventListener('click', () => {
  if (syncScrollBtn.disabled) return;
  view.syncScroll = !view.syncScroll;
  refreshSyncButton();
  vscode.postMessage({ type: 'setSyncScroll', value: view.syncScroll });
});

// Formatting toolbar toggle. Theme controls moved to a dedicated tab.
function applySecondRow(): void {
  document.body.dataset.secondRow = secondRow;
  formatToggleBtn.classList.toggle('active', secondRow === 'formatting');
  formatToggleBtn.setAttribute(
    'data-tooltip',
    secondRow === 'formatting' ? 'Hide formatting toolbar' : 'Show formatting toolbar',
  );
  refreshFormatButtons();
}

formatToggleBtn.addEventListener('click', () => {
  const next: SecondRow = secondRow === 'formatting' ? 'none' : 'formatting';
  secondRow = next;
  applySecondRow();
  vscode.postMessage({ type: 'changeSecondRow', value: next });
});

function refreshFormatButtons(): void {
  // Disable all formatting buttons in preview-only mode (no source pane).
  const disabled = view.mode === 'preview';
  for (const b of formatBtns) {
    b.disabled = disabled;
    if (disabled) {
      b.setAttribute('data-tooltip-disabled-reason', 'Switch to Source or Split mode to use formatting.');
    } else {
      b.removeAttribute('data-tooltip-disabled-reason');
    }
  }
}

// ---------- divider drag ----------

dividerEl.addEventListener('mousedown', (e: MouseEvent) => {
  if (view.mode !== 'split-horizontal' && view.mode !== 'split-vertical') return;
  e.preventDefault();
  const horizontal = view.mode === 'split-horizontal';
  dividerEl.classList.add('dragging');
  document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
  document.body.style.userSelect = 'none';

  const rect = contentDiv.getBoundingClientRect();
  const onMove = (ev: MouseEvent) => {
    const pct = horizontal
      ? ((ev.clientX - rect.left) / rect.width) * 100
      : ((ev.clientY - rect.top) / rect.height) * 100;
    const clamped = Math.max(5, Math.min(95, pct));
    sourcePane.style.flexBasis = `${clamped}%`;
    if (horizontal) view.dividerH = clamped;
    else view.dividerV = clamped;
    if (editor) editor.layout();
  };

  const onUp = () => {
    dividerEl.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    vscode.postMessage({
      type: 'setDivider',
      axis: horizontal ? 'h' : 'v',
      value: horizontal ? view.dividerH : view.dividerV,
    });
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// (theme dropdowns moved to the dedicated Theme Tab — clicked via the
// header's paintcan icon which posts an `invokeCommand` message.)

// ---------- Monaco theme derivation from VS Code CSS vars ----------

function pickThemeBase(): 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' {
  const cls = document.body.classList;
  if (cls.contains('vscode-high-contrast') && !cls.contains('vscode-high-contrast-light')) return 'hc-black';
  if (cls.contains('vscode-high-contrast-light')) return 'hc-light';
  return cls.contains('vscode-dark') ? 'vs-dark' : 'vs';
}

function getCssVar(name: string): string | undefined {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || undefined;
}

function toMonacoColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  const m = v.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/i);
  if (m) {
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    const r = hex(parseFloat(m[1]));
    const g = hex(parseFloat(m[2]));
    const b = hex(parseFloat(m[3]));
    if (m[4] !== undefined) {
      const a = hex(parseFloat(m[4]) * 255);
      return `#${r}${g}${b}${a}`;
    }
    return `#${r}${g}${b}`;
  }
  return undefined;
}

const VSCODE_TO_MONACO_COLORS: Array<[string, string]> = [
  ['editor.background', '--vscode-editor-background'],
  ['editor.foreground', '--vscode-editor-foreground'],
  ['editor.lineHighlightBackground', '--vscode-editor-lineHighlightBackground'],
  ['editor.lineHighlightBorder', '--vscode-editor-lineHighlightBorder'],
  ['editor.selectionBackground', '--vscode-editor-selectionBackground'],
  ['editor.inactiveSelectionBackground', '--vscode-editor-inactiveSelectionBackground'],
  ['editor.selectionHighlightBackground', '--vscode-editor-selectionHighlightBackground'],
  ['editor.findMatchBackground', '--vscode-editor-findMatchBackground'],
  ['editor.findMatchHighlightBackground', '--vscode-editor-findMatchHighlightBackground'],
  ['editor.wordHighlightBackground', '--vscode-editor-wordHighlightBackground'],
  ['editor.wordHighlightStrongBackground', '--vscode-editor-wordHighlightStrongBackground'],
  ['editorCursor.foreground', '--vscode-editorCursor-foreground'],
  ['editorWhitespace.foreground', '--vscode-editorWhitespace-foreground'],
  ['editorIndentGuide.background', '--vscode-editorIndentGuide-background'],
  ['editorIndentGuide.activeBackground', '--vscode-editorIndentGuide-activeBackground'],
  ['editorLineNumber.foreground', '--vscode-editorLineNumber-foreground'],
  ['editorLineNumber.activeForeground', '--vscode-editorLineNumber-activeForeground'],
  ['editorGutter.background', '--vscode-editorGutter-background'],
  ['editorBracketMatch.background', '--vscode-editorBracketMatch-background'],
  ['editorBracketMatch.border', '--vscode-editorBracketMatch-border'],
  ['editorOverviewRuler.border', '--vscode-editorOverviewRuler-border'],
  ['scrollbar.shadow', '--vscode-scrollbar-shadow'],
  ['scrollbarSlider.background', '--vscode-scrollbarSlider-background'],
  ['scrollbarSlider.hoverBackground', '--vscode-scrollbarSlider-hoverBackground'],
  ['scrollbarSlider.activeBackground', '--vscode-scrollbarSlider-activeBackground'],
  ['focusBorder', '--vscode-focusBorder'],
];

function defineVSCodeTheme(): string {
  const monaco = window.monaco;
  if (!monaco) return 'vs';
  const colors: Record<string, string> = {};
  for (const [monKey, cssName] of VSCODE_TO_MONACO_COLORS) {
    const c = toMonacoColor(getCssVar(cssName));
    if (c) colors[monKey] = c;
  }
  monaco.editor.defineTheme('vscode-dynamic', {
    base: pickThemeBase(),
    inherit: true,
    rules: [],
    colors,
  });
  return 'vscode-dynamic';
}

// ---------- Monaco bootstrap ----------

function loadMonaco(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window.require !== 'function') {
      reject(new Error('AMD loader (window.require) is not defined'));
      return;
    }
    window.require.config({ paths: { vs: window.__MONACO_BASE_URL__ } });
    // Pass an error callback to the AMD loader: without it, a failed module
    // fetch leaves the success callback un-fired and the promise hangs
    // forever. With it, AMD load failures reject and the outer bootstrap
    // falls through to its catch path.
    window.require(
      ['vs/editor/editor.main'],
      () => resolve(),
      (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))),
    );
  });
}

function setupEditor(text: string, languageId: string): void {
  const monaco = window.monaco;
  model = monaco.editor.createModel(text, languageId);
  // Monaco's view subsystem doesn't recover well from being created
  // against a 0×0 container. To guarantee real dimensions at create time,
  // force #content into mode-source for this synchronous block — that
  // makes #source-pane visible (display:flex, full size) so the
  // monaco-container measures correctly. The loading overlay is on top
  // during this entire stretch, so the user never sees the mode flicker.
  // applyView() (called right after this in the init handler) restores
  // the correct mode className.
  const previousClassName = contentDiv.className;
  contentDiv.className = 'mode-source';
  editor = monaco.editor.create(monacoContainer, {
    model,
    theme: defineVSCodeTheme(),
    automaticLayout: true,
    wordWrap: 'on',
    minimap: { enabled: false },
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    fontSize: 14,
    renderWhitespace: 'selection',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    bracketPairColorization: { enabled: true },
  });
  contentDiv.className = previousClassName;
  // Force a layout immediately and again on the next frame in case the
  // container started 0-sized while VS Code was finalizing the panel.
  // Without this, the very first open from clicking a .md file in the
  // explorer can leave Monaco showing an empty viewport even though the
  // model already has the text.
  editor.layout();
  setTimeout(() => editor?.layout(), 0);
  requestAnimationFrame(() => editor?.layout());
  // Belt-and-suspenders: Monaco's automaticLayout uses ResizeObserver but
  // doesn't always fire correctly on the display:none → visible transition
  // (the default mode is preview, so the source pane is hidden when the
  // editor is created). Watch the source-pane explicitly and force layout
  // on every size change so switching to source mode actually paints.
  const paneObserver = new ResizeObserver(() => editor?.layout());
  paneObserver.observe(sourcePane);
  // Fallback: if the model came up empty for any reason, write the text we
  // received in the init message back into it.
  if (text && model.getValue().length === 0) {
    suppressNextEditEvent = true;
    model.setValue(text);
  }
  // The editor is up — for source mode this is first paint and the overlay
  // can come down now. For preview/split modes we keep the overlay until
  // renderedHtml so the user doesn't see a flash of empty preview pane.
  if (view.mode === 'source') hideLoadingOverlay();

  model.onDidChangeContent(() => {
    if (suppressNextEditEvent) {
      suppressNextEditEvent = false;
      return;
    }
    vscode.postMessage({ type: 'edit', text: model!.getValue() });
  });

  editor.onDidScrollChange(() => syncFromSource());

  // Keybindings: Cmd/Ctrl+B/I/E/K — registered via Monaco so they fire
  // even though our package.json keybinding can't reach into the webview.
  const KM = monaco.KeyMod, KC = monaco.KeyCode;
  editor.addCommand(KM.CtrlCmd | KC.KeyB, () => runFormat('bold'));
  editor.addCommand(KM.CtrlCmd | KC.KeyI, () => runFormat('italic'));
  editor.addCommand(KM.CtrlCmd | KC.KeyE, () => runFormat('inlineCode'));
  editor.addCommand(KM.CtrlCmd | KC.KeyK, () => runFormat('link'));

  // Paste override is registered once globally in bootstrap via
  // monaco.editor.registerCommand — see the comment there. The Cmd/Ctrl+V
  // keybinding is already bound by Monaco to that command id, so a single
  // registry-level override covers both the shortcut and the right-click
  // → Paste context-menu entry without producing duplicate menu items.

  // Drag-and-drop: image files dropped onto Monaco container.
  monacoContainer.addEventListener('dragover', (e) => {
    if (hasImageFiles(e.dataTransfer)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
  });
  monacoContainer.addEventListener('drop', (e) => {
    if (!hasImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    void handleFileDrop(e);
  });
}

// ---------- clipboard / drop handlers ----------

async function handleClipboardPaste(): Promise<void> {
  if (!editor || !model) return;
  let imageItem: { blob: Blob; type: string } | null = null;
  let textValue = '';

  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const t of item.types) {
        if (t.startsWith('image/') && !imageItem) {
          imageItem = { blob: await item.getType(t), type: t };
        } else if (t === 'text/plain' && !textValue) {
          textValue = await (await item.getType(t)).text();
        }
      }
    }
  } catch {
    // navigator.clipboard.read may reject if the clipboard contains only
    // text on some platforms; fall back to readText.
    try { textValue = await navigator.clipboard.readText(); } catch { /* ignore */ }
  }

  if (imageItem) {
    const buf = new Uint8Array(await imageItem.blob.arrayBuffer());
    const ext = (imageItem.type.split('/')[1] || 'png').toLowerCase();
    vscode.postMessage({ type: 'pasteImage', data: Array.from(buf), ext });
    return;
  }
  if (textValue) {
    const sel = editor.getSelection();
    if (sel) {
      editor.executeEdits('paste-text', [{ range: sel, text: textValue, forceMoveMarkers: true }]);
    }
  }
}

function hasImageFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  for (const f of Array.from(dt.files)) {
    if (f.type.startsWith('image/')) return true;
  }
  // Sometimes the type is empty until you read the file; check items as a backup.
  for (const it of Array.from(dt.items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) return true;
  }
  return false;
}

async function handleFileDrop(e: DragEvent): Promise<void> {
  if (!editor || !model || !e.dataTransfer) return;
  // Move the cursor to the drop position so the inserted link goes there.
  const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
  if (target?.position) editor.setPosition(target.position);
  for (const f of Array.from(e.dataTransfer.files)) {
    if (!f.type.startsWith('image/')) continue;
    const buf = new Uint8Array(await f.arrayBuffer());
    const ext = (f.type.split('/')[1] || 'png').toLowerCase();
    vscode.postMessage({
      type: 'dropImage',
      data: Array.from(buf),
      ext,
      filename: f.name,
    });
  }
}

async function runCopy(kind: 'plain' | 'markdown' | 'html'): Promise<void> {
  const sel = window.getSelection();
  const hasSelection = !!sel && sel.toString().length > 0 && sel.rangeCount > 0;
  let label: string = kind;
  try {
    if (kind === 'plain') {
      const text = hasSelection ? sel!.toString() : (renderedContent.textContent || '');
      await navigator.clipboard.writeText(text);
      label = 'plain text';
    } else if (kind === 'html') {
      let html: string;
      if (hasSelection) {
        const range = sel!.getRangeAt(0);
        const wrap = document.createElement('div');
        wrap.appendChild(range.cloneContents());
        html = wrap.innerHTML;
      } else {
        html = renderedContent.innerHTML;
      }
      await navigator.clipboard.writeText(html);
      label = 'HTML';
    } else {
      // markdown — extension owns the source text. Report selected source-line
      // range when we have a selection inside elements with data-source-line;
      // otherwise ask for the whole document.
      if (hasSelection) {
        const range = sel!.getRangeAt(0);
        const startEl = nearestSourceLineElement(range.startContainer);
        const endEl = nearestSourceLineElement(range.endContainer);
        if (startEl && endEl) {
          const startLine = parseInt(startEl.getAttribute('data-source-line') || '0', 10);
          const endLine = parseInt(endEl.getAttribute('data-source-line') || '0', 10);
          vscode.postMessage({ type: 'copyMarkdownRange', startLine, endLine });
          label = 'markdown';
        } else {
          vscode.postMessage({ type: 'copyMarkdownAll' });
          label = 'markdown (whole doc)';
        }
      } else {
        vscode.postMessage({ type: 'copyMarkdownAll' });
        label = 'markdown';
      }
    }
    if (kind !== 'markdown') {
      vscode.postMessage({ type: 'copyDone', kind, label });
    }
  } catch (e) {
    vscode.postMessage({ type: 'copyDone', kind, label: `${label} (error: ${(e as Error).message})` });
  }
}

function nearestSourceLineElement(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n.nodeType === 1) {
      const el = n as HTMLElement;
      if (el.hasAttribute('data-source-line')) return el;
    }
    n = n.parentNode;
  }
  return null;
}

function insertImageLink(relPath: string): void {
  if (!editor || !model) return;
  const monaco = window.monaco;
  const sel = editor.getSelection();
  if (!sel) return;
  const text = `![](${relPath})`;
  editor.executeEdits('insert-image', [{ range: sel, text, forceMoveMarkers: true }]);
  // Cursor between the [ ] for alt-text typing.
  const start = sel.getStartPosition();
  const altCol = start.column + 2; // after "!["
  editor.setSelection(new monaco.Selection(start.lineNumber, altCol, start.lineNumber, altCol));
  editor.focus();
}

// ---------- formatting actions ----------

function ensureSourceFocus(): boolean {
  if (view.mode === 'preview') return false;
  editor?.focus();
  return true;
}

function toggleWrap(prefix: string, suffix: string): void {
  if (!editor || !model) return;
  const monaco = window.monaco;
  const initial = editor.getSelection();
  if (!initial) return;

  // If there's no selection, expand to the word at the cursor so a click on
  // a bold word toggles it off without the user having to select first.
  let selection = initial;
  if (initial.isEmpty()) {
    const word = model.getWordAtPosition(initial.getStartPosition());
    if (word) {
      selection = new monaco.Selection(
        initial.startLineNumber,
        word.startColumn,
        initial.startLineNumber,
        word.endColumn,
      );
    }
  }

  if (!selection.isEmpty()) {
    const selected = model.getValueInRange(selection);

    // Case A: selection itself includes the wrapping ("**bold**" selected).
    if (
      selected.length >= prefix.length + suffix.length &&
      selected.startsWith(prefix) &&
      selected.endsWith(suffix)
    ) {
      const inner = selected.slice(prefix.length, selected.length - suffix.length);
      editor.executeEdits('mt-format', [
        { range: selection, text: inner, forceMoveMarkers: true },
      ]);
      editor.focus();
      return;
    }

    // Case B: chars immediately before/after the selection are the markers.
    const start = selection.getStartPosition();
    const end = selection.getEndPosition();
    if (start.lineNumber === end.lineNumber) {
      const lineText = model.getLineContent(start.lineNumber);
      const before = lineText.substring(
        Math.max(0, start.column - 1 - prefix.length),
        start.column - 1,
      );
      const after = lineText.substring(end.column - 1, end.column - 1 + suffix.length);
      let isWrapped = before === prefix && after === suffix;

      // For italic (`*`), don't mistake the inner pair of bold (`**`) markers
      // for italic markers — that would convert bold to italic instead of
      // removing italic.
      if (isWrapped && prefix === '*') {
        const outerBefore = lineText[start.column - 1 - prefix.length - 1] ?? '';
        const outerAfter = lineText[end.column - 1 + suffix.length] ?? '';
        if (outerBefore === '*' || outerAfter === '*') isWrapped = false;
      }

      if (isWrapped) {
        // Apply the trailing edit first; otherwise its column range would
        // shift after the leading edit removes characters.
        editor.executeEdits('mt-format', [
          {
            range: new monaco.Range(
              end.lineNumber,
              end.column,
              end.lineNumber,
              end.column + suffix.length,
            ),
            text: '',
          },
          {
            range: new monaco.Range(
              start.lineNumber,
              start.column - prefix.length,
              start.lineNumber,
              start.column,
            ),
            text: '',
          },
        ]);
        editor.focus();
        return;
      }
    }
  }

  // Default: wrap (existing behavior).
  const selected = model.getValueInRange(selection);
  const newText = prefix + selected + suffix;
  editor.executeEdits('mt-format', [
    { range: selection, text: newText, forceMoveMarkers: true },
  ]);
  if (selected.length === 0) {
    const col = selection.startColumn + prefix.length;
    editor.setSelection(
      new monaco.Selection(selection.startLineNumber, col, selection.startLineNumber, col),
    );
  }
  editor.focus();
}

function togglePrefixLines(
  addPrefix: string | ((n: number) => string),
  removePattern: RegExp,
): void {
  if (!editor || !model) return;
  const monaco = window.monaco;
  const selection = editor.getSelection();
  if (!selection) return;
  const startLine = selection.startLineNumber;
  let endLine = selection.endLineNumber;
  if (selection.endColumn === 1 && endLine > startLine) endLine -= 1;

  // If every line already has the prefix, toggle it off; otherwise add it.
  let allHave = true;
  for (let line = startLine; line <= endLine; line++) {
    if (!removePattern.test(model.getLineContent(line))) {
      allHave = false;
      break;
    }
  }

  const edits: import('monaco-editor').editor.IIdentifiedSingleEditOperation[] = [];
  if (allHave) {
    for (let line = startLine; line <= endLine; line++) {
      const m = removePattern.exec(model.getLineContent(line));
      if (m) {
        edits.push({
          range: new monaco.Range(line, 1, line, 1 + m[0].length),
          text: '',
        });
      }
    }
  } else {
    for (let line = startLine; line <= endLine; line++) {
      const text =
        typeof addPrefix === 'string' ? addPrefix : addPrefix(line - startLine + 1);
      edits.push({ range: new monaco.Range(line, 1, line, 1), text });
    }
  }
  editor.executeEdits('mt-format', edits);
  editor.focus();
}

function insertText(text: string, cursorOffsetFromEnd = 0): void {
  if (!editor || !model) return;
  const monaco = window.monaco;
  const selection = editor.getSelection();
  if (!selection) return;
  editor.executeEdits('mt-format', [{ range: selection, text, forceMoveMarkers: true }]);
  if (cursorOffsetFromEnd > 0) {
    // Move cursor backward `cursorOffsetFromEnd` chars from the inserted end.
    const endPos = editor.getPosition();
    if (endPos) {
      const newCol = Math.max(1, endPos.column - cursorOffsetFromEnd);
      const pos = new monaco.Position(endPos.lineNumber, newCol);
      editor.setSelection(new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
    }
  }
  editor.focus();
}

function cycleHeading(): void {
  if (!editor || !model) return;
  const monaco = window.monaco;
  const sel = editor.getSelection();
  if (!sel) return;
  const lineNum = sel.startLineNumber;
  const lineText = model.getLineContent(lineNum);
  const m = /^(#{1,6})\s/.exec(lineText);
  let newPrefix: string;
  let oldPrefixLen = 0;
  if (!m) {
    newPrefix = '# ';
  } else {
    oldPrefixLen = m[0].length;
    const level = m[1].length;
    if (level >= 6) newPrefix = '';
    else newPrefix = '#'.repeat(level + 1) + ' ';
  }
  const range = new monaco.Range(lineNum, 1, lineNum, oldPrefixLen + 1);
  editor.executeEdits('mt-format', [{ range, text: newPrefix }]);
  editor.focus();
}

function wrapWithUrl(prefix: string): void {
  // prefix is "[" for link or "![" for image.
  if (!editor || !model) return;
  const monaco = window.monaco;
  const selection = editor.getSelection();
  if (!selection) return;
  const selected = model.getValueInRange(selection);
  if (selected.length === 0) {
    // No selection: insert "[](url)" / "![](url)" with cursor in the text slot.
    const placeholder = prefix === '![' ? 'alt' : 'text';
    const text = `${prefix}${placeholder}](url)`;
    editor.executeEdits('mt-format', [{ range: selection, text, forceMoveMarkers: true }]);
    // Select the placeholder so user can type over it.
    const startCol = selection.startColumn + prefix.length;
    const endCol = startCol + placeholder.length;
    editor.setSelection(new monaco.Selection(selection.startLineNumber, startCol, selection.startLineNumber, endCol));
  } else {
    // With selection: wrap as "[selected](url)" with cursor in the URL slot.
    const text = `${prefix}${selected}](url)`;
    editor.executeEdits('mt-format', [{ range: selection, text, forceMoveMarkers: true }]);
    const endPos = editor.getPosition();
    if (endPos) {
      // Position cursor at "url" slot: 4 chars before end ("url)").
      const urlStart = endPos.column - 4;
      const urlEnd = urlStart + 3;
      editor.setSelection(new monaco.Selection(endPos.lineNumber, urlStart, endPos.lineNumber, urlEnd));
    }
  }
  editor.focus();
}

function runFormat(action: string): void {
  if (!ensureSourceFocus()) return;
  switch (action) {
    case 'bold': toggleWrap('**', '**'); break;
    case 'italic': toggleWrap('*', '*'); break;
    case 'strike': toggleWrap('~~', '~~'); break;
    case 'inlineCode': toggleWrap('`', '`'); break;
    case 'heading': cycleHeading(); break;
    case 'bullet': togglePrefixLines('- ', /^- /); break;
    case 'numbered': togglePrefixLines((n) => `${n}. `, /^\d+\. /); break;
    case 'task': togglePrefixLines('- [ ] ', /^- \[[ xX]\] /); break;
    case 'quote': togglePrefixLines('> ', /^> /); break;
    case 'codeblock': insertText('```\n\n```\n', 5); break;
    case 'hr': insertText('\n---\n'); break;
    case 'link': wrapWithUrl('['); break;
    case 'image': wrapWithUrl('!['); break;
  }
}

for (const b of formatBtns) {
  b.addEventListener('click', () => {
    if (b.disabled) return;
    const action = b.dataset.formatAction;
    if (action) runFormat(action);
  });
}

// ---------- outline panel ----------

const outlineToggleBtn = document.getElementById('outline-toggle-btn') as HTMLButtonElement;
const outlinePanel = document.getElementById('outline-panel') as HTMLDivElement;
const outlineList = document.getElementById('outline-list') as HTMLUListElement;
let outlineObserver: IntersectionObserver | undefined;

function refreshOutlineToggleTooltip(): void {
  const open = renderedPane.classList.contains('outline-open');
  outlineToggleBtn.setAttribute('data-tooltip', open ? 'Hide outline' : 'Show outline');
  outlineToggleBtn.classList.toggle('active', open);
  outlinePanel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

outlineToggleBtn.addEventListener('click', () => {
  renderedPane.classList.toggle('outline-open');
  refreshOutlineToggleTooltip();
});

function rebuildOutline(): void {
  outlineList.innerHTML = '';
  if (outlineObserver) outlineObserver.disconnect();
  const headings = renderedContent.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of Array.from(headings)) {
    const heading = h as HTMLElement;
    const level = parseInt(heading.tagName[1], 10);
    if (!heading.id) {
      // anchor plugin should have set id; fallback if missing
      heading.id = (heading.textContent || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
    }
    const li = document.createElement('li');
    li.className = 'outline-item';
    li.style.paddingLeft = `${(level - 1) * 0.85 + 1}em`;
    // Use textContent to skip the anchor "#" prefix added below.
    const text = (heading.cloneNode(true) as HTMLElement);
    // Remove anchor from cloned heading before extracting text
    text.querySelectorAll('.heading-anchor').forEach((a) => a.remove());
    li.textContent = (text.textContent || '').trim();
    li.dataset.targetId = heading.id;
    li.title = li.textContent || '';
    li.addEventListener('click', () => {
      heading.scrollIntoView({ block: 'start' });
    });
    outlineList.appendChild(li);
  }
  observeHeadings();
}

function observeHeadings(): void {
  if (!('IntersectionObserver' in window)) return;
  outlineObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const id = (e.target as HTMLElement).id;
          for (const item of Array.from(outlineList.children)) {
            (item as HTMLElement).classList.toggle('active', (item as HTMLElement).dataset.targetId === id);
          }
          break;
        }
      }
    },
    { root: renderedPane, threshold: 0, rootMargin: '0px 0px -75% 0px' },
  );
  for (const h of renderedContent.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    outlineObserver.observe(h);
  }
}

// ---------- heading anchor links ----------

function attachHeadingAnchors(): void {
  if (!settings.showHeadingAnchors) return;
  for (const h of renderedContent.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const heading = h as HTMLElement;
    if (!heading.id) continue;
    if (heading.querySelector('.heading-anchor')) continue;
    const a = document.createElement('a');
    a.className = 'heading-anchor';
    a.textContent = '#';
    a.href = `#${heading.id}`;
    a.setAttribute('aria-label', 'Copy heading anchor');
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      vscode.postMessage({ type: 'copyHeadingAnchor', slug: heading.id });
      flashAnchorCopied(a);
    });
    heading.insertBefore(a, heading.firstChild);
  }
}

function flashAnchorCopied(anchor: HTMLElement): void {
  anchor.querySelectorAll('.anchor-flash').forEach((n) => n.remove());
  const flash = document.createElement('span');
  flash.className = 'anchor-flash';
  flash.textContent = 'Copied';
  anchor.appendChild(flash);
  setTimeout(() => flash.remove(), 1100);
}

// ---------- task list interactivity ----------

renderedContent.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement | null;
  if (!target) return;
  if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox') return;
  const li = target.closest('[data-source-line]') as HTMLElement | null;
  if (!li) return;
  const lineAttr = li.getAttribute('data-source-line');
  if (lineAttr === null) return;
  const line = parseInt(lineAttr, 10);
  if (!Number.isFinite(line)) return;
  ev.preventDefault();
  // Optimistic UI: flip the checkbox immediately so the click feels live;
  // the rerender from the doc edit will confirm/correct it.
  (target as HTMLInputElement).checked = !(target as HTMLInputElement).checked;
  vscode.postMessage({ type: 'toggleTaskList', line });
});

// Global keyboard fallback. Monaco's addCommand fires when Monaco has focus;
// when focus is in the rendered pane (or anywhere else in the webview), we
// still want Cmd+B/I/E/K to apply formatting after focusing the source.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
  // Skip if Monaco has focus — its own command handler will fire.
  if (monacoContainer.contains(document.activeElement)) return;
  if (view.mode === 'preview') return;
  let action: string | null = null;
  switch (e.key.toLowerCase()) {
    case 'b': action = 'bold'; break;
    case 'i': action = 'italic'; break;
    case 'e': action = 'inlineCode'; break;
    case 'k': action = 'link'; break;
  }
  if (!action) return;
  e.preventDefault();
  runFormat(action);
});

// ---------- sync scroll ----------

// Track which side most recently *initiated* scroll so we can ignore the
// scroll events fired by the receiving side as a result of sync. Origin
// expires after a short window so the user can hand control back-and-forth.
type ScrollOrigin = 'source' | 'rendered';
let scrollOrigin: ScrollOrigin | null = null;
let scrollOriginTimer: number | undefined;
const ORIGIN_HOLD_MS = 200;

function setScrollOrigin(s: ScrollOrigin): void {
  scrollOrigin = s;
  if (scrollOriginTimer !== undefined) clearTimeout(scrollOriginTimer);
  scrollOriginTimer = window.setTimeout(() => {
    scrollOrigin = null;
    scrollOriginTimer = undefined;
  }, ORIGIN_HOLD_MS);
}

function inSplitMode(): boolean {
  return view.mode === 'split-horizontal' || view.mode === 'split-vertical';
}

function syncFromSource(): void {
  if (!view.syncScroll || !inSplitMode() || !editor) return;
  // Ignore scroll events that the rendered-pane sync caused on the source.
  if (scrollOrigin === 'rendered') return;
  setScrollOrigin('source');

  const visible = editor.getVisibleRanges();
  if (visible.length === 0) return;
  const sourceLine0 = visible[0].startLineNumber - 1;
  const elements = renderedContent.querySelectorAll<HTMLElement>('[data-source-line]');
  if (elements.length === 0) return;

  let target: HTMLElement | null = null;
  for (const el of Array.from(elements)) {
    const line = parseInt(el.getAttribute('data-source-line') || '0', 10);
    if (line >= sourceLine0) { target = el; break; }
    target = el;
  }
  if (!target) return;
  const containerTop = renderedScroll.getBoundingClientRect().top;
  const delta = target.getBoundingClientRect().top - containerTop;
  renderedScroll.scrollTop += delta;
}

function syncFromRendered(): void {
  if (!view.syncScroll || !inSplitMode() || !editor) return;
  if (scrollOrigin === 'source') return;
  setScrollOrigin('rendered');

  const containerTop = renderedScroll.getBoundingClientRect().top;
  const elements = renderedContent.querySelectorAll<HTMLElement>('[data-source-line]');
  if (elements.length === 0) return;

  // Topmost element at least partly visible: bottom edge below the container's top.
  let line0 = 0;
  for (const el of Array.from(elements)) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom - containerTop > 0) {
      line0 = parseInt(el.getAttribute('data-source-line') || '0', 10);
      break;
    }
  }
  // Monaco.editor.ScrollType.Immediate === 1; bypass smooth-scroll animation
  // so the editor doesn't keep firing onDidScrollChange after the sync call.
  editor.revealLineNearTop(line0 + 1, 1);
}

renderedScroll.addEventListener('scroll', () => syncFromRendered());

// ---------- inbound message handling ----------

let currentMermaidTheme = 'default';
let currentMermaidOverrides: Record<string, string> = {};

async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLPreElement>('pre.mermaid-source');
  if (blocks.length === 0) return;
  // Re-init with current theme + overrides each render so theme changes take
  // effect. Mermaid only ships four named themes; for our editor-matching
  // presets we switch to `theme: 'base'` and feed mermaid the preset's
  // themeVariables (user overrides win on top).
  const preset = MERMAID_PRESETS[currentMermaidTheme];
  if (preset) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: { ...preset.vars, ...currentMermaidOverrides },
      securityLevel: 'loose',
    });
  } else {
    const native = isMermaidNative(currentMermaidTheme) ? currentMermaidTheme : 'default';
    mermaid.initialize({
      startOnLoad: false,
      theme: native,
      themeVariables: Object.keys(currentMermaidOverrides).length > 0
        ? currentMermaidOverrides
        : undefined,
      securityLevel: 'loose',
    });
  }

  for (let i = 0; i < blocks.length; i++) {
    const pre = blocks[i];
    const source = pre.textContent || '';
    const id = `mt-mermaid-${Date.now()}-${i}`;
    try {
      const { svg } = await mermaid.render(id, source);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-diagram';
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (e) {
      const err = document.createElement('pre');
      err.className = 'mermaid-error';
      err.textContent = `Mermaid render failed: ${(e as Error).message}\n\n${source}`;
      pre.replaceWith(err);
    }
  }
}

const PREVIEW_THEME_SLOTS: ReadonlyArray<string> = [
  'background', 'foreground', 'heading',
  'link', 'link-hover',
  'blockquote-border', 'blockquote-fg',
  'inline-code-bg', 'inline-code-fg', 'code-block-bg',
  'table-border', 'table-header-bg', 'hr',
  'strikethrough', 'mark-bg',
];

/**
 * Theme-color hints extracted from the active theme JSON's `colors` map.
 * Slot ids match the user-override token ids so the same name maps to the
 * same `--mt-pt-*` variable, used as the second link in the fallback chain
 * (user override → theme.colors → VS Code chrome).
 */
function applyPreviewThemeColors(themeColors: Record<string, string>): void {
  for (const slot of PREVIEW_THEME_SLOTS) {
    renderedPane.style.removeProperty(`--mt-pt-${slot}`);
  }
  for (const [slot, color] of Object.entries(themeColors)) {
    if (color) renderedPane.style.setProperty(`--mt-pt-${slot}`, color);
  }
}

/**
 * Apply preview token overrides as CSS custom properties on the rendered
 * pane root. The stylesheet (in editorProvider.ts) reads these via fallback
 * variables, so unset values fall through to the base preview theme.
 */
function applyPreviewOverrides(overrides: Record<string, string>): void {
  const map: Record<string, string> = {
    background: '--mt-pv-bg',
    foreground: '--mt-pv-fg',
    heading: '--mt-pv-heading',
    link: '--mt-pv-link',
    'link-hover': '--mt-pv-link-hover',
    'blockquote-border': '--mt-pv-bq-border',
    'blockquote-fg': '--mt-pv-bq-fg',
    'inline-code-bg': '--mt-pv-inline-bg',
    'inline-code-fg': '--mt-pv-inline-fg',
    'code-block-bg': '--mt-pv-code-bg',
    'table-border': '--mt-pv-table-border',
    'table-header-bg': '--mt-pv-table-header',
    hr: '--mt-pv-hr',
    strikethrough: '--mt-pv-strike',
    'mark-bg': '--mt-pv-mark-bg',
  };
  // Clear all then re-apply so removed overrides actually clear.
  for (const v of Object.values(map)) renderedPane.style.removeProperty(v);
  for (const [token, color] of Object.entries(overrides)) {
    const cssVar = map[token];
    if (cssVar && color) renderedPane.style.setProperty(cssVar, color);
  }
}

function attachLinkHandlers(root: HTMLElement): void {
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    a.addEventListener('click', (ev: Event) => {
      ev.preventDefault();
      const href = (a as HTMLAnchorElement).getAttribute('href');
      if (!href) return;
      // Same-document anchors are scrolled locally — the host returns early
      // for `#`-prefixed hrefs, expecting us to handle it.
      if (href.startsWith('#')) {
        const id = href.slice(1);
        if (id) {
          const target = renderedContent.querySelector<HTMLElement>(
            `#${CSS.escape(id)}`,
          );
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
      vscode.postMessage({ type: 'navigate', href });
    });
  }
}

function handleMessage(msg: IncomingMessage): void {
  switch (msg.type) {
    case 'init':
      view = { ...msg.view };
      secondRow = msg.secondRow;
      settings = { ...msg.settings };
      setupEditor(msg.text, msg.languageId);
      applyView();
      applySecondRow();
      refreshOutlineToggleTooltip();
      vscode.setState({ mode: view.mode });
      break;
    case 'secondRowChanged':
      secondRow = msg.value;
      applySecondRow();
      break;
    case 'renderSettingsChanged':
      settings = { ...msg.settings };
      // Re-process the existing rendered HTML so new heading-anchor setting
      // applies; for showFrontMatter the extension also re-renders.
      attachHeadingAnchors();
      break;
    case 'insertImage':
      insertImageLink(msg.path);
      break;
    case 'requestCopy':
      void runCopy(msg.kind);
      break;
    case 'print':
      window.print();
      break;
    case 'scrollToLine': {
      const line = Math.max(0, Math.floor(msg.line));
      // Monaco uses 1-based line numbers; our doc-source-line attrs are 0-based.
      if (editor && view.mode !== 'preview') {
        editor.revealLineNearTop(line + 1, 1);
        editor.setPosition({ lineNumber: line + 1, column: 1 });
      }
      if (view.mode !== 'source') {
        const target = renderedContent.querySelector<HTMLElement>(
          `[data-source-line="${line}"]`,
        );
        if (target) {
          const containerTop = renderedScroll.getBoundingClientRect().top;
          renderedScroll.scrollTop += target.getBoundingClientRect().top - containerTop;
        }
      }
      break;
    }
    case 'themeUpdate':
      if (msg.bodyBg) document.body.style.setProperty('--mt-theme-bg', msg.bodyBg);
      else document.body.style.removeProperty('--mt-theme-bg');
      if (msg.bodyFg) document.body.style.setProperty('--mt-theme-fg', msg.bodyFg);
      else document.body.style.removeProperty('--mt-theme-fg');
      if (window.monaco) {
        if (msg.monacoTheme) {
          window.monaco.editor.defineTheme(msg.monacoThemeName, msg.monacoTheme);
          window.monaco.editor.setTheme(msg.monacoThemeName);
        } else {
          window.monaco.editor.setTheme(defineVSCodeTheme());
        }
      }
      applyPreviewOverrides(msg.previewOverrides || {});
      applyPreviewThemeColors(msg.previewThemeColors || {});
      currentMermaidTheme = msg.mermaidTheme || 'default';
      currentMermaidOverrides = msg.mermaidOverrides || {};
      // Re-render existing diagrams so they pick up the new theme.
      void renderMermaidBlocks(renderedContent);
      break;
    case 'docUpdate':
      if (model && model.getValue() !== msg.text) {
        suppressNextEditEvent = true;
        const range = model.getFullModelRange();
        model.applyEdits([{ range, text: msg.text }]);
      }
      if (view.mode !== 'source') vscode.postMessage({ type: 'requestRender' });
      break;
    case 'setMode':
      setMode(msg.mode);
      break;
    case 'renderedHtml': {
      // Preserve scroll position so the rendered view stays put while typing.
      const scrollTop = renderedScroll.scrollTop;
      renderedContent.innerHTML = msg.html;
      attachLinkHandlers(renderedContent);
      attachHeadingAnchors();
      rebuildOutline();
      void renderMermaidBlocks(renderedContent);
      renderedScroll.scrollTop = scrollTop;
      hideLoadingOverlay();
      break;
    }
    case 'themeChanged':
      if (window.monaco) window.monaco.editor.setTheme(defineVSCodeTheme());
      if (view.mode !== 'source') vscode.postMessage({ type: 'requestRender' });
      break;
  }
}

async function bootstrap(): Promise<void> {
  try {
    await loadMonaco();
  } catch (e) {
    // Monaco failed to load — overlay must come down so the user isn't
    // staring at a stuck spinner forever. The editor pane will be empty
    // (no source editing) but the rendered pane can still arrive once the
    // extension pushes renderedHtml.
    console.error('[sweet-markdown] Monaco load failed:', e);
    hideLoadingOverlay();
    return;
  }
  // Override Monaco's built-in Paste. Monaco's default
  // `editor.action.clipboardPasteAction` uses navigator.clipboard.readText,
  // which fails silently in VS Code webviews because clipboard-read
  // permission isn't granted to the iframe — the right-click → Paste
  // menu entry appears to do nothing. Registering on the global
  // CommandsRegistry (which Monaco resolves via "most-recent wins") sends
  // *both* the Cmd/Ctrl+V keybinding and the context-menu entry through
  // our image-aware handler, without adding a duplicate menu item.
  window.monaco.editor.registerCommand(
    'editor.action.clipboardPasteAction',
    () => { void handleClipboardPaste(); },
  );
  monacoReady = true;
  // Signal the extension that the webview is fully wired up. The extension
  // defers init/themeUpdate/renderedHtml until this arrives — sending them
  // before the webview's message listener is registered is exactly what
  // caused the "Loading editor… forever" race on cold VS Code launches.
  vscode.postMessage({ type: 'ready' });
  while (messageQueue.length > 0) {
    try {
      handleMessage(messageQueue.shift()!);
    } catch (err) {
      console.error('[sweet-markdown] queued message handler failed:', err);
    }
  }
}

window.addEventListener('message', (e) => {
  const msg = e.data as IncomingMessage;
  if (!monacoReady) {
    messageQueue.push(msg);
    return;
  }
  try {
    handleMessage(msg);
  } catch (err) {
    console.error('[sweet-markdown] message handler failed:', err);
    hideLoadingOverlay();
  }
});

// VS Code mutates `body.classList` on theme change. Re-derive Monaco's theme.
const themeObserver = new MutationObserver(() => {
  if (window.monaco) window.monaco.editor.setTheme(defineVSCodeTheme());
});
themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

void bootstrap();
