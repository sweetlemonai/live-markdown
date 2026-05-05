import * as vscode from 'vscode';

export function setupWordCountStatusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9);
  item.tooltip = 'Word count and estimated reading time for the active markdown file';
  context.subscriptions.push(item);

  let timer: ReturnType<typeof setTimeout> | undefined;
  function scheduleUpdate(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      update(item);
    }, 500);
  }
  // Initial + change triggers.
  update(item);
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => update(item)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const active = activeMarkdownDocument();
      if (active && e.document.uri.toString() === active.uri.toString()) scheduleUpdate();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('liveMarkdown.readingWordsPerMinute')) update(item);
    }),
  );
}

function update(item: vscode.StatusBarItem): void {
  const doc = activeMarkdownDocument();
  if (!doc) {
    item.hide();
    return;
  }
  const stats = computeStats(doc.getText());
  const wpm = readWpm();
  const minutes = Math.max(1, Math.round(stats.words / wpm));
  item.text = `$(book) ${formatNumber(stats.words)} words • ${minutes} min read`;
  item.show();
}

function activeMarkdownDocument(): vscode.TextDocument | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab) return undefined;
  const input = tab.input;
  if (!(input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText)) return undefined;
  const uri = input.uri;
  const p = uri.path.toLowerCase();
  if (!p.endsWith('.md') && !p.endsWith('.markdown')) return undefined;
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
}

function readWpm(): number {
  const v = vscode.workspace.getConfiguration('liveMarkdown').get<number>('readingWordsPerMinute');
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 250;
  return v;
}

interface DocStats {
  words: number;
}

function computeStats(text: string): DocStats {
  // Strip front matter.
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  const stripped = text.replace(fm, '');

  // Strip fenced code blocks.
  const noCode = stripped.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ');

  // Strip inline code, URLs, and HTML tags before counting words.
  const cleaned = noCode
    .replace(/`[^`]+`/g, ' ')
    .replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const matches = cleaned.match(/\b[\p{L}\p{N}'’\-]+\b/gu);
  return { words: matches ? matches.length : 0 };
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
