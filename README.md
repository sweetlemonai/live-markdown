<p align="center">
  <img src="https://raw.githubusercontent.com/sweetlemonai/live-markdown/main/images/logo.png" alt="Live Markdown" width="128" />
</p>

<h1 align="center">Live Markdown</h1>

<p align="center">
  Source and rendered markdown side-by-side in a single tab — with themes, math, mermaid, and a real Monaco editor.
</p>

<p align="center">
  <em>(Hero screenshot / GIF placeholder — drop a 16:9 capture of split mode here before publish.)</em>
</p>

---

## What this is

Live Markdown is a custom editor for `.md` and `.markdown` files. One tab, four view modes — source only, preview only, split horizontal, split vertical — and you flip between them in place without VS Code closing and reopening anything. The source pane is a real Monaco editor; the preview is a styled markdown render with shiki syntax highlighting, KaTeX math, and Mermaid diagrams.

The point: VS Code's built-in markdown preview is a *paired* tab — every preview consumes a slot, and switching back and forth is friction. Markdown Preview Enhanced has more features but a heavier UI, exporters that ship a headless browser, and pinball physics around theming. Live Markdown is the middle path: keep the tab count down, keep the editor fast, keep theming sane (dark/light for source / preview body / code blocks / mermaid all chosen separately), and ship without trying to be a wiki, a slide deck, or a Pandoc replacement.

## What you get

**Editing**
- Monaco source editor with multi-cursor, undo/redo, find, syntax highlighting, soft-wrap on
- 13-button formatting toolbar (Bold, Italic, Strikethrough, Inline code, Heading, Bulleted/Numbered/Task list, Block quote, Code block, Horizontal rule, Link, Image)
- Smart toggle behaviour — clicking Bold on a wrapped word unwraps it
- Keyboard shortcuts: `⌘B` bold, `⌘I` italic, `⌘E` inline code, `⌘K` link
- Image paste from clipboard and drag-and-drop — saved to a workspace folder, link inserted at the cursor

**Layout**
- Four view modes (source / preview / split-horizontal / split-vertical) in one tab
- Drag the divider in either split orientation
- Sync scroll across split panes (toggleable)
- Status bar word count and reading time

**Rendering**
- CommonMark + GFM (tables, strikethrough, task lists, autolinks)
- KaTeX math: `$inline$` and `$$block$$`, with errors styled inline so a typo doesn't tank the page
- Mermaid diagrams (flowcharts, sequence, class, state, gantt, ER, pie — anything Mermaid supports)
- Syntax-highlighted fenced code blocks via shiki
- Heading anchors with hover-to-copy
- Front-matter handling (hidden by default; show it as a styled box via setting)
- Click a task list checkbox in the preview to toggle the source

**Themes**
- Independent theme picks for **source**, **preview body**, **code blocks**, and **mermaid**, separately for dark and light modes
- 19 syntax themes including Noctis (11 variants), Dracula, Tokyo Night, Nord, One Dark Pro, Monokai, Solarized, Vitesse, GitHub
- 25 mermaid theme presets that match the editor themes (no more "the diagram looks fine but doesn't fit my dark theme")
- Per-token color customization (the theme tab opens a colour picker for every prose / syntax slot)
- Per-file theme overrides — set this one document to Dracula without changing the global default
- Live preview while you edit themes — broadcasts to all open markdown tabs

**Find & navigation**
- VS Code's native find widget inside the rendered pane (`⌘F`)
- Outline tree in the Explorer sidebar
- Slide-out outline panel inside the preview itself

**Export**
- Export to HTML — self-contained, CSS inlined, prefers-color-scheme aware
- Export to PDF via the system print dialog (no bundled headless browser)
- Copy as plain text, markdown, or HTML — selection-aware

## Quick start

1. Install the extension and open any `.md` or `.markdown` file. It opens in Live Markdown's preview by default.
2. Use the icons in the header to switch view modes, toggle the formatting toolbar, open the outline, or open the **Theme tab**.
3. `⌘⇧V` (macOS) / `Ctrl+⇧V` (Windows / Linux) toggles between source and preview without leaving the tab.
4. Run **Markdown: Open Theme Tab** from the command palette to manage themes — pick separately for dark and light, save globally or per file.

## What's not included

This is deliberate. Live Markdown is a focused editor, not a knowledge base or a Pandoc front-end:

- **No wikilinks, backlinks, or graph view.** Use Foam, Dendron, or Obsidian if that's your workflow.
- **No collaborative editing.** Use Live Share.
- **No full Vim mode in the source editor.** Monaco itself supports it through extensions, but those extensions don't run inside the custom editor's Monaco instance. If you need Vim, switch the file to VS Code's text editor (right-click in the explorer → **Reopen Editor With… → Text Editor**).
- **No Copilot autocompletion in the source pane.** Same reason — Copilot can't see Monaco running inside a webview. For AI-heavy editing sessions, use VS Code's text editor instead and switch back when you want the preview.
- **No PlantUML, Graphviz, or executable code blocks.** Mermaid only.
- **No spell check.** It conflicted with typing in early versions and was removed.

If you need any of those, [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced) is the one to pair with. The extensions can coexist — Live Markdown only registers as the default editor for `.md` / `.markdown`, which you can override per file.

## Screenshots

*(Add 3–4 captures before publish.)*

- `images/screenshot-split.png` — split mode with the formatting toolbar visible
- `images/screenshot-theme-tab.png` — Theme tab showing dark mode picks
- `images/screenshot-mermaid.png` — Mermaid diagram with a matching editor theme
- `images/screenshot-math.png` — KaTeX block math + matrix

## Issues and feedback

Bug reports and feature requests on GitHub: <https://github.com/sweetlemonai/live-markdown/issues>

## License

[MIT](LICENSE)
