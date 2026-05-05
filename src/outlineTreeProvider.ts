import * as vscode from 'vscode';

interface Heading {
  level: number;
  text: string;
  line: number;
  children: Heading[];
}

class HeadingItem extends vscode.TreeItem {
  constructor(
    public readonly heading: Heading,
    public readonly uri: vscode.Uri,
  ) {
    super(
      heading.text,
      heading.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `${uri.toString()}#${heading.line}`;
    this.tooltip = heading.text;
    this.description = '';
    this.iconPath = new vscode.ThemeIcon('symbol-string');
    this.command = {
      command: 'liveMarkdown.revealHeading',
      title: 'Reveal heading',
      arguments: [uri, heading.line],
    };
  }
}

export class MarkdownOutlineTreeProvider implements vscode.TreeDataProvider<HeadingItem> {
  private readonly emitter = new vscode.EventEmitter<HeadingItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: HeadingItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HeadingItem): HeadingItem[] {
    if (element) {
      return element.heading.children.map((h) => new HeadingItem(h, element.uri));
    }
    const doc = currentMarkdownDocument();
    if (!doc) return [];
    const tree = parseHeadings(doc);
    return tree.map((h) => new HeadingItem(h, doc.uri));
  }
}

/** Find the markdown document associated with the currently active tab. */
function currentMarkdownDocument(): vscode.TextDocument | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!activeTab) return undefined;
  let uri: vscode.Uri | undefined;
  const input = activeTab.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
    uri = input.uri;
  }
  if (!uri) return undefined;
  if (!isMarkdownUri(uri)) return undefined;
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri!.toString(),
  );
}

function isMarkdownUri(uri: vscode.Uri): boolean {
  const p = uri.path.toLowerCase();
  return p.endsWith('.md') || p.endsWith('.markdown');
}

function parseHeadings(document: vscode.TextDocument): Heading[] {
  const root: Heading[] = [];
  const stack: Heading[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    const fenceMatch = /^\s*(```+|~~~+)/.exec(text);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (text.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (!m) continue;
    const level = m[1].length;
    const heading: Heading = { level, text: m[2].trim(), line: i, children: [] };
    if (!heading.text) continue;

    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length === 0) {
      root.push(heading);
    } else {
      stack[stack.length - 1].children.push(heading);
    }
    stack.push(heading);
  }
  return root;
}
