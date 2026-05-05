<h1 align="center">Sweet Markdown</h1>

<p align="center">
  Write and read markdown in the same tab. No more flipping panes.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/sweetlemonai/sweet-markdown/main/images/hero.png" alt="Sweet Markdown" />
</p>

---

## Why

Most markdown extensions split your screen into two: your file on one side, a preview on the other. Two windows for one document. Open another file and the whole layout shuffles.

Sweet Markdown puts everything in one tab. You see your markdown rendered. When you want to edit, switch the same tab to the source view. When you want both, split the tab. Each file remembers its own setup.

That's it. That's the whole pitch.

## What it does

**Four ways to view a file**, switchable from icons in the header: source only, rendered only, side-by-side, top-and-bottom. Each tab keeps its own setup.

**Live preview while you type.** Updates as you go. No save-and-reload, no flipping panes.

**Sync scrolling.** When you scroll the source, the rendered side scrolls with it.

**A formatting toolbar** with the basics: bold, italic, headings, lists, links, images, code blocks. Toggle it on from the header icon. Keyboard shortcuts (⌘B, ⌘I, ⌘K) work whether the toolbar is visible or not.

**Math equations** render inline with `$...$` and as blocks with `$$...$$`.

**Diagrams** with Mermaid: flowcharts, sequences, gantt charts, the lot. Just write a `mermaid` code block.

**Code blocks** get proper syntax colors, like in a real editor.

**Themes** for everything: source, preview, code, diagrams. Pick separately for light and dark mode. Plus per-file overrides if you want this one document to look different.

**Outline view** of your headings, both in the sidebar and as a slide-out panel inside the preview.

**Drag images in or paste them from your clipboard.** They get saved to your workspace and linked at the cursor.

**Export** to HTML or PDF when you need to share.

**Word count and reading time** in the status bar.

## Try it

Open any `.md` file. It'll show up rendered. Use the icons at the top to switch views, toggle the formatting toolbar, or open the theme tab.

`⌘⇧V` (Mac) / `Ctrl+Shift+V` (Windows/Linux) flips between source and rendered without leaving the tab.

## What it doesn't do

This is on purpose. Sweet Markdown stays focused.

- No wikilinks, no backlinks, no knowledge graph. If you want a second brain, use Obsidian or Dendron.
- No live collaboration. Use Live Share.
- No fancy export pipelines. HTML and PDF, that's it.
- No PlantUML, no Graphviz. Just Mermaid.

Some VS Code features that work in regular `.md` files won't work inside Sweet Markdown's editor: Vim mode, Copilot, spell-check extensions. If you need them for a particular file, right-click → **Reopen Editor With… → Text Editor** and you're back in VS Code's normal editor.

## Screenshots

**Theme tab.** Pick how source, preview, code, and diagrams look, separately for light and dark.

<p align="center">
  <img src="https://raw.githubusercontent.com/sweetlemonai/sweet-markdown/main/images/theme.png" alt="Theme tab" />
</p>

**Mermaid diagrams** that match your theme.

<p align="center">
  <img src="https://raw.githubusercontent.com/sweetlemonai/sweet-markdown/main/images/mermaid.png" alt="Mermaid diagram" />
</p>

**KaTeX math.** Inline `$...$` and block `$$...$$`, including matrices and aligned environments.

<p align="center">
  <img src="https://raw.githubusercontent.com/sweetlemonai/sweet-markdown/main/images/math.png" alt="KaTeX math rendering" />
</p>

## Feedback

Bug reports and feature requests on [GitHub](https://github.com/sweetlemonai/sweet-markdown/issues).

## License

[MIT](LICENSE)
