# Changelog

All notable changes to **Sweet Markdown** are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.2] — 2026-05-17

### Fixed

- **Cmd/Ctrl+V regressed in 1.1.1.** The 1.1.1 fix for right-click → Paste replaced the per-editor `editor.addCommand` keybinding with a global `monaco.editor.registerCommand` override, on the assumption that Monaco's keybinding for `editor.action.clipboardPasteAction` would resolve through `CommandsRegistry`. In practice the StandaloneEditor dispatches editor-action keybindings through a path that bypasses that override, so Cmd/Ctrl+V went back to Monaco's webview-broken built-in. Both routes are now wired: per-editor `addCommand` handles the keybinding, the global `registerCommand` handles the right-click menu entry, both hit the same image-aware paste handler.

## [1.1.1] — 2026-05-17

### Fixed

- **Right-click → Paste in the source pane did nothing.** Monaco's built-in `editor.action.clipboardPasteAction` reads the clipboard via `navigator.clipboard.readText`, which fails silently in VS Code webviews because clipboard-read permission isn't granted to the iframe. Cmd/Ctrl+V worked because the webview already had a per-editor override for that keybinding, but the context-menu entry still invoked the broken built-in. The override is now registered on Monaco's global `CommandsRegistry` for that command id, so both the keybinding and the menu entry route through the same image-aware paste handler — single menu entry, working from both paths.

## [1.1.0] — 2026-05-16

### Fixed

- **"Loading editor…" stuck forever on first open after a fresh VS Code launch.** `resolveCustomTextEditor` was posting `init` / `themeUpdate` / `renderedHtml` to the webview immediately after setting `webview.html` — before the webview's `window` message listener was wired up. On cold starts the webview iframe boots slowly enough that those messages could be dropped, leaving the spinner up indefinitely. The webview already sent a `'ready'` message after Monaco finished loading, but the extension's handler was empty. The handler now flips a per-panel `webviewReady` flag and pushes initial state at that point; `pushRender`, `pushThemeUpdate`, the doc-change listener, and the three `notify*` methods early-return until the flag is set. Reopening the file used to "fix" the issue only because the OS disk cache was warm; the race is now eliminated rather than masked.
- **AMD loader hangs on Monaco load failure.** `window.require(['vs/editor/editor.main'], …)` was called without an error callback, so a failed module fetch left the success callback un-fired and the promise hung forever. The error callback now rejects, and the bootstrap catch path drops the loading overlay so the user isn't stuck staring at a spinner.

## [1.0.3] — 2026-05-07

### Changed

- **Empty documents open in source mode.** Opening a `.md` file whose contents are empty (or whitespace-only) now lands in the source pane with a cursor, instead of a blank preview. Non-empty documents still open in preview as before. Saved per-tab modes are unaffected.

## [1.0.2] — 2026-05-05

### Changed

- **README clarification.** The formatting toolbar bullet now notes that the toolbar is toggled on from the header icon (it's hidden by default) and that the ⌘B / ⌘I / ⌘K shortcuts work regardless of toolbar visibility.

## [1.0.1] — 2026-05-05

### Fixed

- **Blank preview on first open.** The renderer awaited the on-disk load of all 11 Noctis theme JSONs before the first markdown render could complete, so the very first preview after activation could sit blank for a noticeable beat. The hot path now resolves as soon as the bundled shiki themes are ready; Noctis loads in the background and any panel using a Noctis variant re-renders automatically once it finishes.
- **Blank source pane on first open / when switching modes during loading.** Monaco was being created against `#monaco-container` while `#source-pane` was `display: none` (preview is the default mode), reading 0×0 dimensions. Once Monaco's view subsystem initialized at 0×0 it never fully painted content even after `editor.layout()` calls. `setupEditor` now temporarily forces `#content` into `mode-source` for the synchronous `monaco.editor.create` call so the container measures correctly, then restores the previous mode immediately. The user never sees the flicker because the loading overlay is on top throughout.
- **Spurious 403 console errors for missing images.** Markdown referencing an image file that doesn't exist on disk left the relative `src` intact, which the webview tried to fetch against its own origin (`vscode-webview://<hash>/<src>`) and got 403. Missing-file `<img>` tags are now replaced with a styled `<span class="md-img-missing">` placeholder — no fetch, no console noise, and a visible cue in the preview.
- **Mode-switch race with the loading overlay.** Switching to source while the preview was still rendering left the overlay covering the source pane, making it look empty. Overlay now drops instantly (no fade) on any user-driven mode switch.

### Added

- **Loading overlay.** Small spinner + "Loading editor…" label centered over the content area on first open. Hidden the moment first paint arrives (editor created in source mode, or first rendered HTML in preview/split modes), or as soon as the user clicks a mode button.

### Changed

- **Faster cold activation.** The 11 Noctis theme JSON reads now run in parallel via `Promise.all` instead of sequentially. Only `shiki.loadTheme` registration stays sequential to keep shiki's registry mutations safe.

## [1.0.0] — 2026-05-04

First marketplace release.

### Added

- **One-tab editing.** Custom editor for `.md` and `.markdown` files with four view modes — source only, preview only, split-horizontal, split-vertical — switchable in place from the header without VS Code closing or reopening the tab.
- **Monaco source pane** with multi-cursor, undo/redo, find, and language-aware syntax highlighting.
- **Sync scroll** in split modes; toggleable via a header icon.
- **Draggable divider** in both split orientations, with the divider position remembered per session for the open tab.
- **Sticky outline panel** that slides in from the right of the preview and stays pinned to the visible viewport while the document scrolls.
- **Markdown Outline tree** in the Explorer sidebar, plus a `DocumentSymbolProvider` that powers VS Code breadcrumbs.
- **Formatting toolbar** with thirteen actions — Bold, Italic, Strikethrough, Inline code, Heading (cycles H1→H6→none), Bulleted list, Numbered list, Task list, Block quote, Code block, Horizontal rule, Link, Image — each click is a single undo step. Smart toggles unwrap/remove markers when applied to already-formatted text.
- **Keyboard shortcuts** in the source pane: ⌘B / ⌘I / ⌘E / ⌘K (Bold / Italic / Inline code / Link). The shortcuts also fire when focus is in the rendered pane.
- **Theme tab** — a dedicated webview panel with mode toggle (Dark / Light), apply-scope toggle (All files / This file only), four category dropdowns (Source / Preview / Code blocks / Mermaid), per-token color customization, save/discard buttons, and a best-effort unsaved-changes prompt on close. Live preview broadcasts to all open markdown tabs while editing.
- **Custom Noctis theme bundle** — eleven variants (Noctis, Azureus, Bordo, Hibernus, Lilac, Lux, Minimus, Obscuro, Sereno, Uva, Viola) loaded from disk into shiki's registry at activation.
- **Mermaid theme presets** — twenty-five total, including curated `theme: 'base'` presets that mirror the editor themes (GitHub Dark/Light, Dracula, Tokyo Night, Nord, One Dark Pro, Monokai, Solarized, Vitesse, Noctis variants) so diagram colors match the rest of the page.
- **`theme.colors` fallback chain** for preview prose styling — user override → theme JSON `colors` hint → VS Code chrome variable. Minimal TextMate themes (Monokai, Dracula) fall through cleanly to legible chrome colors instead of going unstyled.
- **KaTeX math** — inline (`$...$`) and block (`$$...$$`) rendering, with errors styled inline so a typo doesn't break the rest of the page. Toggleable via `liveMarkdown.math.enabled`.
- **Mermaid diagrams** — flowcharts, sequence, class, state, gantt, ER, pie, etc. Errors render as a styled error block with the source so one broken diagram doesn't tank the document.
- **Code-block syntax highlighting** via shiki (16 bundled themes plus 11 Noctis variants). Languages are loaded on demand from the document's fence info strings.
- **Front matter handling** — YAML front matter is hidden by default; `liveMarkdown.showFrontMatter` renders it as a styled box at the top of the preview.
- **Heading anchors** — hover any heading in the preview to reveal a `#` link; clicking copies a workspace-relative anchor (`<path>#<slug>`) to the clipboard.
- **Internal anchor link navigation** — clicking a link such as `[See Foo](#foo)` smooth-scrolls the preview to the matching heading.
- **Task list interactivity** — clicking a checkbox in the preview toggles `[ ]`/`[x]` in the source.
- **Image paste from clipboard** and drag-and-drop — saved to a workspace-relative folder (default `./assets`, configurable) with the markdown link inserted at the cursor.
- **Find widget** in the rendered pane (`⌘F`) via the custom editor's `enableFindWidget` option; Monaco's built-in find covers the source pane.
- **Export to HTML** — self-contained file with CSS inlined and `prefers-color-scheme` aware styling; no external dependencies.
- **Export to PDF** via the system print dialog (no bundled headless browser).
- **Copy as Plain Text / Markdown / HTML** commands — selection-aware, falling back to the full document when nothing is selected.
- **Word count and reading time** in the status bar — excludes content in code blocks and front matter; words-per-minute configurable.
- **Status-bar toggle** — the right-aligned indicator shows "Source" or "Rendered" for the active tab and toggles when clicked.
- **Schema migration** from the legacy `markdownToggle.*` configuration namespace to `liveMarkdown.*`. Runs once per machine; the old keys are left in place. Workspace-state per-file theme overrides carry over.
- **Settings** — `liveMarkdown.themes`, `liveMarkdown.secondRow`, `liveMarkdown.showFrontMatter`, `liveMarkdown.showHeadingAnchors`, `liveMarkdown.imagePasteFolder`, `liveMarkdown.readingWordsPerMinute`, `liveMarkdown.math.enabled`. The Theme tab is the canonical place to manage themes.
- **Marketplace metadata** — extension icon, file icon for `.md` files, repository / bugs / homepage URLs.

### Notes

- The custom editor is the default for `.md` and `.markdown`. Switch back to VS Code's native text editor for any individual file via right-click → **Reopen Editor With… → Text Editor** (useful for Copilot, Vim, and other extensions that bind to the underlying TextEditor rather than Monaco-in-webview).
- `Cmd+Shift+V` / `Ctrl+Shift+V` toggles between source and preview. The keybinding scopes itself to `.md` / `.markdown` files so it doesn't conflict with the built-in markdown preview's binding on other languages.
