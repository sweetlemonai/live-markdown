import * as path from 'path';
import * as vscode from 'vscode';
import { renderMarkdown } from './renderer';

const CONFIG_SECTION = 'liveMarkdown';

function readConfigString(key: string, fallback: string): string {
  const v = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(key);
  return v ?? fallback;
}
function readConfigBool(key: string, fallback: boolean): boolean {
  const v = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(key);
  return typeof v === 'boolean' ? v : fallback;
}

export async function exportHtml(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const codeTheme = readConfigString('codeTheme', '') || readConfigString('previewTheme', '');
  const showFM = readConfigBool('showFrontMatter', false);
  const html = await renderMarkdown(doc.getText(), codeTheme, showFM);

  const titleBase = path.basename(uri.fsPath, path.extname(uri.fsPath));
  const standalone = wrapStandaloneHtml(html, titleBase);

  const defaultUri = uri.with({
    path: uri.path.replace(/\.[^./]+$/, '') + '.html',
  });
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { HTML: ['html', 'htm'] },
  });
  if (!saveUri) return;

  await vscode.workspace.fs.writeFile(saveUri, Buffer.from(standalone, 'utf-8'));
  void vscode.window.showInformationMessage(`Exported HTML: ${path.basename(saveUri.fsPath)}`);
}

function wrapStandaloneHtml(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${exportedCss()}</style>
</head>
<body>
<div id="content">
${bodyHtml}
</div>
</body>
</html>`;
}

/**
 * Self-contained CSS for exported HTML. Doesn't depend on VS Code variables.
 * Auto-light/dark via prefers-color-scheme.
 */
function exportedCss(): string {
  return `
:root {
  --fg: #1f2328; --bg: #ffffff;
  --muted: #59636e; --link: #0969da; --link-hover: #0550ae;
  --border: #d1d9e0; --code-bg: #f6f8fa; --quote-border: #d1d9e0;
  --table-header: #f6f8fa; --shadow: rgba(0,0,0,0.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3; --bg: #0d1117;
    --muted: #9198a1; --link: #4493f8; --link-hover: #58a6ff;
    --border: #30363d; --code-bg: #161b22; --quote-border: #30363d;
    --table-header: #161b22; --shadow: rgba(0,0,0,0.3);
  }
}
html, body { margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px; line-height: 1.6;
  color: var(--fg); background: var(--bg);
}
#content { max-width: 64em; margin: 0 auto; padding: 2em 2em 4em; }
h1, h2, h3, h4, h5, h6 { color: var(--fg); margin-top: 1.4em; line-height: 1.25; }
h1, h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
a { color: var(--link); text-decoration: none; }
a:hover { color: var(--link-hover); text-decoration: underline; }
code:not(pre code) {
  font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.9em; background: var(--code-bg);
  padding: 0.15em 0.4em; border-radius: 3px;
}
pre {
  font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  background: var(--code-bg); padding: 1em; overflow-x: auto;
  border-radius: 4px; font-size: 0.9em;
}
pre code { background: transparent; padding: 0; }
pre.shiki { background: var(--code-bg) !important; }
pre.shiki code { background: transparent !important; }
blockquote {
  border-left: 4px solid var(--quote-border);
  padding: 0.5em 1em; margin: 1em 0; color: var(--muted);
}
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid var(--border); padding: 0.4em 0.8em; }
th { background: var(--table-header); font-weight: 600; }
hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
img { max-width: 100%; }
ul.contains-task-list { list-style: none; padding-left: 1em; }
.front-matter {
  font-family: SFMono-Regular, Consolas, monospace;
  font-size: 0.85em; background: var(--code-bg);
  border: 1px solid var(--border); border-left: 3px solid var(--link);
  padding: 0.6em 1em; margin: 0 0 1em; border-radius: 4px;
}
.fm-key { color: var(--link); font-weight: 500; }
.fm-colon { opacity: 0.6; }
.fm-raw { opacity: 0.7; font-style: italic; }
.heading-anchor { display: none; }
.mermaid-diagram { margin: 1em 0; text-align: center; }
.mermaid-error {
  background: var(--code-bg);
  border-left: 3px solid #f44;
  padding: 0.6em 1em; border-radius: 4px;
  font-size: 0.85em; white-space: pre-wrap;
}
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
