import * as vscode from 'vscode';

/**
 * DocumentSymbolProvider for markdown that emits each heading as a symbol,
 * nested by level. Powers the built-in Outline view (and the breadcrumbs)
 * in our custom editor's underlying TextDocument.
 */
export class MarkdownSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.DocumentSymbol[] {
    const root: vscode.DocumentSymbol[] = [];
    const stack: { level: number; symbol: vscode.DocumentSymbol }[] = [];

    let inFence = false;
    let fenceMarker = '';
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;

      // Skip fenced code blocks so a `# heading-looking line` inside them
      // isn't interpreted as a heading.
      const fenceMatch = /^\s*(```+|~~~+)/.exec(text);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fenceMatch[1][0]; // ` or ~
        } else if (text.trimStart().startsWith(fenceMarker)) {
          inFence = false;
        }
        continue;
      }
      if (inFence) continue;

      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
      if (!m) continue;
      const level = m[1].length;
      const name = m[2].trim();
      if (!name) continue;
      const range = new vscode.Range(i, 0, i, text.length);
      const symbol = new vscode.DocumentSymbol(
        name,
        '',
        vscode.SymbolKind.String,
        range,
        range,
      );

      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      if (stack.length === 0) {
        root.push(symbol);
      } else {
        stack[stack.length - 1].symbol.children.push(symbol);
      }
      stack.push({ level, symbol });
    }

    // Best-effort: extend each symbol's range to cover its children.
    expandRanges(root, document);
    return root;
  }
}

function expandRanges(symbols: vscode.DocumentSymbol[], document: vscode.TextDocument): void {
  for (let i = 0; i < symbols.length; i++) {
    const next = symbols[i + 1];
    const lastLine = next ? next.range.start.line - 1 : document.lineCount - 1;
    const endLineText = document.lineAt(Math.max(symbols[i].range.start.line, lastLine)).text;
    symbols[i].range = new vscode.Range(
      symbols[i].selectionRange.start,
      new vscode.Position(Math.max(symbols[i].range.start.line, lastLine), endLineText.length),
    );
    if (symbols[i].children.length > 0) expandRanges(symbols[i].children, document);
  }
}
