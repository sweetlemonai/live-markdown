import * as vscode from 'vscode';
import { MarkdownEditorProvider, VIEW_TYPE } from './editorProvider';
import { MarkdownSymbolProvider } from './symbolProvider';
import { MarkdownOutlineTreeProvider } from './outlineTreeProvider';
import { exportHtml } from './exporter';
import { setupWordCountStatusBar } from './wordCount';
import { ThemeTabPanel } from './themeTab';
import { runMigrations } from './migration';
import * as path from 'path';
import { setThemeAssetRoot, initRenderer, setMathEnabled } from './renderer';

let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  // Migrate any settings the user had under the old `markdownToggle.*`
  // namespace into `liveMarkdown.*`. Runs once; old keys are left intact.
  void runMigrations(context);

  setThemeAssetRoot(path.join(context.extensionPath, 'dist', 'themes'));
  setMathEnabled(
    vscode.workspace.getConfiguration('liveMarkdown').get<boolean>('math.enabled', true),
  );
  // Kick off shiki + Noctis loading so custom themes are in the registry
  // before any panel resolves. Re-push themes once loading completes so
  // anything that opened during the warm-up gets corrected.
  void initRenderer().then(() => provider.notifyConfigChanged());

  const provider = new MarkdownEditorProvider(context.extensionUri, context.workspaceState);

  const outlineProvider = new MarkdownOutlineTreeProvider();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    // Powers breadcrumbs and any built-in consumer that finds a TextEditor
    // for the document; the Outline view itself is fed by the dedicated
    // tree below since it doesn't query custom editors.
    vscode.languages.registerDocumentSymbolProvider(
      [{ language: 'markdown' }, { pattern: '**/*.{md,markdown}' }],
      new MarkdownSymbolProvider(),
    ),
    vscode.window.registerTreeDataProvider('liveMarkdown.outline', outlineProvider),
    vscode.window.tabGroups.onDidChangeTabs(() => outlineProvider.refresh()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'markdown') outlineProvider.refresh();
    }),
    vscode.commands.registerCommand(
      'liveMarkdown.revealHeading',
      (uri: vscode.Uri, line: number) => provider.revealHeading(uri, line),
    ),
    vscode.commands.registerCommand('liveMarkdown.exportHtml', async (uri?: vscode.Uri) => {
      const target = uri ?? activeMarkdownUri();
      if (!target) {
        void vscode.window.showWarningMessage('Open a markdown file first.');
        return;
      }
      await exportHtml(target);
    }),
    vscode.commands.registerCommand('liveMarkdown.exportPdf', () => provider.exportPdf()),
    vscode.commands.registerCommand('liveMarkdown.copyAsPlainText', () => provider.requestCopy('plain')),
    vscode.commands.registerCommand('liveMarkdown.copyAsMarkdown', () => provider.requestCopy('markdown')),
    vscode.commands.registerCommand('liveMarkdown.copyAsHtml', () => provider.requestCopy('html')),
    vscode.commands.registerCommand('liveMarkdown.openThemeTab', () => {
      ThemeTabPanel.reveal(context.extensionUri, {
        applyLivePreview: (state, scope, target) => provider.applyLivePreview(state, scope, target),
        endLivePreview: () => provider.endLivePreview(),
      }, context.workspaceState);
    }),
    vscode.commands.registerCommand('liveMarkdown.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:sweet-lemon.sweet-markdown');
    }),
  );

  setupWordCountStatusBar(context);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  statusBar.command = 'liveMarkdown.toggle';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('liveMarkdown.toggle', () => {
      provider.toggleActive();
    }),
    provider.onDidChangeActiveMode(() => updateStatusBar(provider)),
    vscode.window.tabGroups.onDidChangeTabs(() => updateStatusBar(provider)),
    vscode.window.onDidChangeActiveColorTheme(() => {
      provider.notifyThemeChanged();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('liveMarkdown.themes')) {
        provider.notifyConfigChanged();
      }
      if (e.affectsConfiguration('liveMarkdown.secondRow')) {
        provider.notifySecondRowChanged();
      }
      if (
        e.affectsConfiguration('liveMarkdown.showFrontMatter') ||
        e.affectsConfiguration('liveMarkdown.showHeadingAnchors')
      ) {
        provider.notifyRenderSettingsChanged();
      }
      if (e.affectsConfiguration('liveMarkdown.math.enabled')) {
        setMathEnabled(
          vscode.workspace
            .getConfiguration('liveMarkdown')
            .get<boolean>('math.enabled', true),
        );
        provider.notifyRenderSettingsChanged();
      }
    }),
  );

  updateStatusBar(provider);
}

export function deactivate(): void {
  // Subscriptions disposed via context.subscriptions.
}

function activeMarkdownUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab) return undefined;
  const input = tab.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
    const u = input.uri;
    const p = u.path.toLowerCase();
    if (p.endsWith('.md') || p.endsWith('.markdown')) return u;
  }
  return undefined;
}

function updateStatusBar(provider: MarkdownEditorProvider): void {
  const mode = provider.getActiveMode();
  if (!mode) {
    statusBar.hide();
    return;
  }
  if (mode === 'source') {
    statusBar.text = '$(file) Source';
    statusBar.tooltip = 'Markdown: render this tab';
  } else {
    statusBar.text = '$(eye) Rendered';
    statusBar.tooltip = 'Markdown: show source';
  }
  statusBar.show();
}
