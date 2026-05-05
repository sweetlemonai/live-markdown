# Live Markdown — development notes

This file is for contributors. End-user docs are in [README.md](README.md).

## Project structure

```
src/
  extension.ts             # Activation entry. Registers the custom editor,
                           #   commands, status bar, and config listeners.
  editorProvider.ts        # The Custom Editor: webview HTML, message protocol,
                           #   render loop, theme push, image paste, exporters.
  webview/index.ts         # Bundled IIFE that runs in the webview. Owns Monaco
                           #   bootstrap, sync scroll, formatting toolbar
                           #   actions, outline panel, mermaid render.
  renderer.ts              # markdown-it + shiki + KaTeX. Custom Noctis loader.
                           #   Module-level highlighter is shared across panels.
  themeStore.ts            # Theme schema (dark/light × source/preview/code/
                           #   mermaid → { theme, overrides }), config read/
                           #   write, per-file workspaceState. Theme name lists.
  themeTab.ts              # The Theme tab webview panel (`liveMarkdown.themeTab`).
                           #   Mode/scope toggles, dropdowns, color picker grid,
                           #   save/discard, throttled live-preview broadcast.
  themeTokens.ts           # Token IDs exposed in the per-token override picker.
  themeOverrides.ts        # Apply user overrides to Monaco/Shiki theme registrations.
  mermaidPresets.ts        # Curated `theme: 'base'` + themeVariables presets that
                           #   mirror editor themes (github-dark, dracula, ...).
  exporter.ts              # `liveMarkdown.exportHtml` — standalone HTML output.
  outlineTreeProvider.ts   # Explorer sidebar TreeView. Parses headings on each
                           #   text-document change.
  symbolProvider.ts        # DocumentSymbolProvider for breadcrumbs and other
                           #   built-in consumers.
  wordCount.ts             # Status-bar item: words and reading time.
  migration.ts             # One-time migration from `markdownToggle.*` keys.
  themes/                  # JSON theme files for Noctis variants (copied into
                           #   dist/themes at build time and loaded by shiki).

esbuild.js                 # Build script. Two contexts: extension (CJS, node)
                           # and webview (IIFE, browser). Also copies Monaco,
                           # codicons, KaTeX, and custom theme JSON into dist/.

dist/                      # Build output. Webview script, extension script,
                           #   monaco/, codicons/, katex/, themes/.

examples/test.md           # Render fixture covering every supported feature.
images/                    # Marketplace logo, file icon, screenshots.
```

## Build and run

```sh
npm install
npm run build       # one-shot
npm run watch       # esbuild --watch (rebuilds on src changes)
```

Then press **F5** in VS Code with the project open to launch an Extension Development Host. Changes to webview code are picked up after a reload of the host window (`Cmd+R`); changes to the extension main process require restarting the debug session.

```sh
npm run package     # produces a .vsix via @vscode/vsce
npm run lint        # eslint src
```

`npx tsc --noEmit -p .` does a full typecheck (esbuild does not).

## Architecture decision: Custom Editor + Monaco

The "single tab" pitch (source and preview live in one tab, switch in place) ruled out three earlier approaches:

1. **Paired tabs** (what VS Code's built-in markdown preview does) — every preview consumes a slot, switching is friction, the source tab and the preview tab can drift out of sync. Killed because it doubles the tab count.
2. **Single-tab swap** (closing the source tab and opening the preview, or vice versa) — visually flickers, loses cursor and scroll state on every toggle, and forces a full rerender. Killed during prototyping; the flicker was unacceptable.
3. **Native VS Code editor + side panel** — keeps the editor native (Copilot, Vim, all extensions Just Work) but the side panel is a separate VS Code WebviewPanel. That's still two tabs in two slots, just one of them is a panel.

The current shape — **Custom Editor with a single webview that owns both Monaco and the rendered HTML** — is the only one that gives true single-tab behaviour with no flicker, independent per-tab state, and full control over both panes' theming. The cost is that the source editor is Monaco-in-a-webview, not VS Code's actual TextEditor. That has consequences:

- Other extensions that operate on TextEditor (Copilot, Vim, GitLens inline blame, etc.) don't run against the custom editor's Monaco instance.
- Selection / cursor / decorations are not visible to the rest of VS Code.
- Find Widget integration: we use VS Code's webview Find Widget for the rendered pane (`enableFindWidget: true`) and Monaco's built-in Find for the source pane.

The escape hatch for users who want all that: right-click the file in the explorer → **Reopen Editor With… → Text Editor**. That swaps in VS Code's native editor for that document, and they can switch back to Live Markdown the same way. (We're considering shipping a dedicated command for this — see "Open known limitations" below.)

## Webview structure and message protocol

Each open `.md` tab gets its own `WebviewPanel` with a separate webview origin. The extension and webview communicate by `postMessage`. Roughly:

**Extension → Webview**
- `init` — initial document text + view state
- `docUpdate` — out-of-band file change (someone else edited the file on disk)
- `renderedHtml` — newly rendered HTML to display
- `themeUpdate` — Monaco theme, body bg/fg, mermaid theme, preview overrides
- `themeChanged` — VS Code colour theme changed; rerun resolution
- `secondRowChanged` — toggle the formatting toolbar row
- `renderSettingsChanged` — front-matter / heading-anchors / math toggle changed
- `setMode` — programmatic mode change
- `scrollToLine` — scroll the rendered pane to a source line
- `requestCopy` — produce text for copy-as-plain/markdown/html
- `print` — trigger `window.print()` for PDF export
- `insertImage` — pasted/dropped image was saved; insert markdown link

**Webview → Extension**
- `editChange` — Monaco emitted a content change
- `requestRender` — please re-render
- `viewState` — persist mode / divider positions / sync-scroll toggle
- `navigate` — link click in rendered pane
- `imageData` — pasted clipboard image bytes
- `imageDrop` — dropped image file path or bytes
- `toggleTaskList` — checkbox click in preview, line number to toggle
- `copyHeadingAnchor` — write the workspace-relative anchor to the clipboard
- `invokeCommand` — open the Theme tab, settings, etc.

Message types are declared as discriminated unions on both sides. Adding a new message: extend the type union in `webview/index.ts` and the corresponding handler in `editorProvider.ts` (or vice versa). The protocol is loose — there is no shared schema file. If you change a field name, search the other side for the literal string.

## Theme resolution order

When the extension pushes a theme to a webview:

1. **Read the user's theme config**. `themeStore.readGlobalThemes()` returns `{ dark, light } × { source, preview, code, mermaid } → { theme, overrides }`. If a per-file override exists in `workspaceState`, it merges on top.
2. **Pick the active mode**. `currentMode()` reads `vscode.window.activeColorTheme.kind` — Light / HighContrastLight → `'light'`; everything else → `'dark'`.
3. **Resolve the chosen theme name to a shiki theme**. `resolveShikiTheme()` checks:
   - `PRELOAD_THEMES` (the bundled shiki theme list)
   - `NOCTIS_VARIANTS` (custom themes loaded from `dist/themes/*.json`)
   - VS Code's `workbench.colorTheme` value, slugified, in case the user picked an editor theme that maps to a known shiki theme
   - Falls back to `dark-plus` / `light-plus`
4. **Apply per-token overrides**. `applyMonacoOverrides` mutates the Monaco theme rules; `applyShikiOverrides` registers a derived shiki theme variant `${baseTheme}-mt-overrides`.
5. **Push everything to the webview**. The webview defines the Monaco theme, sets the body background/foreground from the theme's `editor.background` / `editor.foreground`, and applies preview prose overrides via CSS custom properties.

### CSS variable fallback chain (preview prose)

Preview prose styling reads CSS variables in this order:

```
--mt-pv-{slot}     # user override from the Theme tab's color picker
--mt-pt-{slot}     # hint extracted from the active theme JSON's `colors` map
--vscode-{chrome}  # VS Code's chrome variable
```

`extractPreviewColors()` (in `editorProvider.ts`) maps theme.colors keys (`editor.background`, `textLink.foreground`, `textBlockQuote.border`, etc.) to preview slot ids (`background`, `link`, `blockquote-border`). The webview applies them as `--mt-pt-*` properties on `#rendered-pane`. The stylesheet is written so every prose slot reads through the chain — minimal themes (Monokai, Dracula) without UI colours fall through to VS Code's chrome variables, which keep the preview legible.

## Per-tab state model

State per panel lives on `PanelEntry` in `editorProvider.ts`:

```ts
interface PanelEntry {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  mode: ViewMode;
  renderTimer?: NodeJS.Timeout;
  lastEditedAt?: number;
  // ... and so on
}
```

Entries live in a `Map<WebviewPanel, PanelEntry>` (`this.entries`). They are created on `resolveCustomTextEditor` and cleaned up on `panel.onDidDispose`. Each tab is fully independent — mode, divider position, scroll, sync-scroll toggle, outline open state, formatting-toolbar visibility.

State that *is* persisted across sessions:

- Per-file theme overrides → `workspaceState['themes.perFile.<absolutePath>']`
- Global theme config → user settings `liveMarkdown.themes`
- Migration completion marker → `globalState['liveMarkdown.migrationCompleted_v1']`

State that is *not* persisted across sessions (lives only in memory):

- View mode, divider positions, scroll position, cursor position, sync-scroll toggle, outline / formatting-toolbar open state.

That choice is intentional for v1 — view state is cheap to reset on reopen, and the alternative is invalidation pain when the file changes shape between sessions. Per-file mode persistence is a candidate for a follow-up.

## Live preview broadcast

When a user is editing the Theme tab, every dropdown change or color-picker drag triggers `applyLivePreview(state, scope, target)` on `MarkdownEditorProvider`. This builds an *overlay* — a `ThemeConfig` shaped like the saved one but holding only the in-flight values — and re-pushes themes to all affected entries. Throttled to ~60 ms in the Theme tab to keep colour-picker drags responsive without saturating message round-trips.

`applyLivePreview` does not write to settings. `endLivePreview` clears the overlay; entries re-resolve from the saved config. **Save** in the Theme tab calls `writeGlobalThemes()` and ends the live preview; **Discard** simply ends the live preview.

Live preview scope:
- `'all'` — every open markdown tab
- `'this'` — only the panel whose document fsPath matches `targetFile`

## Schema migration: `markdownToggle.*` → `liveMarkdown.*`

`migration.ts` runs once per machine (gated on `globalState['liveMarkdown.migrationCompleted_v1']`). It reads the old configuration namespace and copies values into the new one:

- `markdownToggle.themes` (the nested theme blob) → `liveMarkdown.themes`
- `markdownToggle.sourceTheme` / `previewTheme` / `codeTheme` (the legacy flat keys) → `liveMarkdown.sourceTheme` / etc.
- workspaceState keys with the old prefix `markdown-toggle.themes.perFile.*` → `themes.perFile.*`

The old keys are left in place. The new keys are authoritative.

A separate, secondary migration in `themeStore.ts` (`legacyMigrate()`) handles the case where a user installed a fresh build, never had `markdownToggle.*`, and only set the flat `liveMarkdown.sourceTheme` / `previewTheme` / `codeTheme` keys directly. That path runs only when `liveMarkdown.themes` is empty.

To bump the migration to v2 — add a new marker key (`liveMarkdown.migrationCompleted_v2`) and a separate migration function. Don't reuse the v1 marker.

## Adding a new bundled theme

Two cases:

### A bundled shiki theme

If the theme is one shiki ships natively (see `node_modules/shiki/dist/themes/`):

1. Add the theme id to `SUPPORTED_THEMES` in `renderer.ts`.
2. Add it to the appropriate list in `themeStore.ts` (`SHIKI_DARK_THEMES` or `SHIKI_LIGHT_THEMES`).
3. Optionally add a matching mermaid preset in `mermaidPresets.ts` if you want the diagram to follow the editor theme.

### A custom theme (Noctis-style)

If the theme is a TextMate / VS Code theme JSON not in shiki's bundled set:

1. Drop the JSON into `src/themes/`. (esbuild copies the directory to `dist/themes/`.)
2. Add an entry to `NOCTIS_VARIANTS` in `renderer.ts` — file name, id, label, dark/light type. (The variable is named `NOCTIS_VARIANTS` for historical reasons; it's the registry of all custom-loaded themes.)
3. Add the id to the right list in `themeStore.ts`.
4. The shiki highlighter loads the file from disk at activation and registers it.

Verify it appears in the Theme tab dropdown for the appropriate mode.

## Adding a button to the formatting toolbar

1. Add a `FORMAT_BUTTONS` entry in `editorProvider.ts` — group, id, codicon, tooltip, aria.
2. Add a case for the new id in the `formatActions` switch in `webview/index.ts`. Each action receives the Monaco editor and a `selection`. Use `editor.executeEdits()` to make a single undoable change.
3. (Optional) Wire a keyboard shortcut: register it via `editor.addCommand` for the in-Monaco shortcut, and add a case in the document-level `keydown` fallback handler so the shortcut works when focus is in the rendered pane.

The formatting actions are intentionally Monaco-only — they don't go through the extension host. This keeps each click to one synchronous edit (one undo step).

## Known limitations users will hit

- **Other markdown extensions don't run** against Live Markdown's source pane. Examples: Markdown All in One, Markdown Preview Github Styling, MPE. Their commands and decorations bind to VS Code's TextEditor; the custom editor's Monaco instance is a separate world. Users who need them should switch the file to **Reopen Editor With → Text Editor**.
- **Copilot / Codeium / other AI extensions** for the same reason — they hook the TextEditor, not Monaco-in-webview.
- **Vim / VSCodeVim** also TextEditor-bound.
- **Built-in markdown features** (Markdown: Open Preview, Markdown: Open Preview to the Side) still work, but they open VS Code's native preview, not ours. The `Cmd+Shift+V` keybinding is bound by both; we add `resourceExtname` to the `when` clause to take precedence on `.md` and `.markdown`.
- **No spell check.** It was implemented (nspell + dictionary-en) and removed because it interfered with typing. If you bring it back, debounce aggressively and run it off the main thread.
- **PDF export goes through `window.print()`**, not a bundled headless browser. Output quality depends on the user's print stack. Not a regression — a deliberate choice to keep the extension light.

## Performance notes

The renderer runs on every keystroke (debounced via `setTimeout(0)`):

- `extractLangs` regex-scans the whole document for ` ```lang` fences, then `preloadLangs` loads any new shiki languages on demand. Already-loaded languages short-circuit.
- `splitFrontMatter` regex-matches the leading `---` block.
- `markdown-it` parse + render — usually the bulk of the time on large documents.
- `wordCount.computeStats` (status bar) — chained regex replaces, debounced 500 ms.
- `outlineTreeProvider.parseHeadings` and `symbolProvider.provideDocumentSymbols` — line-by-line walks fired on every text-document change.

For very large files (multi-MB), several of these become noticeable. None are O(n²), but the chain of full-document scans per keystroke is a candidate for memoisation if performance complaints surface.

## Settings reference

User-facing settings declared in `package.json`:

| Setting | Default | What |
|---|---|---|
| `liveMarkdown.themes` | `{}` | Theme state — managed via the Theme tab. |
| `liveMarkdown.secondRow` | `"none"` | `"none"` or `"formatting"`. |
| `liveMarkdown.showFrontMatter` | `false` | Render YAML front matter as a styled block. |
| `liveMarkdown.showHeadingAnchors` | `true` | Hover-to-copy `#` anchors next to headings. |
| `liveMarkdown.imagePasteFolder` | `"./assets"` | Workspace-relative folder for pasted/dropped images. |
| `liveMarkdown.readingWordsPerMinute` | `250` | WPM for the reading-time estimate. |
| `liveMarkdown.math.enabled` | `true` | Enable KaTeX rendering. |
| `liveMarkdown.sourceTheme` | `""` | **Legacy.** Read by migration only; set via the Theme tab now. |
| `liveMarkdown.previewTheme` | `""` | **Legacy.** Same. |
| `liveMarkdown.codeTheme` | `""` | **Legacy.** Same. |

The legacy three are kept for migration compatibility and currently feed the HTML exporter as a code-block theme fallback. They will likely be removed in v2 once the migration code path is no longer needed.

## Releasing

1. Bump `version` in `package.json`.
2. Add a section to `CHANGELOG.md` (keepachangelog.com format).
3. `npm run package` to produce a `.vsix`.
4. Verify the .vsix in a fresh window: `code --install-extension live-markdown-<version>.vsix`.
5. `vsce publish` (or upload via the marketplace UI).

## Contributing

PRs welcome. Before sending one:

- `npm run lint` should pass.
- `npx tsc --noEmit -p .` should be clean.
- For UI changes, capture a before/after screenshot in the PR description.
- For new render features, add a section to `examples/test.md` so future audits can verify it.
