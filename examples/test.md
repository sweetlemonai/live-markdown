---
title: Test document
author: Step 3 sample
---

# Live Markdown — Render Test

This file exercises the renderer for step 3. The YAML front matter above should be hidden.

## Headings

### Level 3
#### Level 4
##### Level 5

## Inline elements

This paragraph has **bold**, *italic*, ~~strikethrough~~, `inline code`, and an [external link](https://example.com).

An autolink: https://github.com/shd101wyy/vscode-markdown-preview-enhanced.

## Lists

- Unordered item
- Another item with `code`
  - Nested item
  - Nested item

1. Ordered first
2. Ordered second
3. Ordered third

## Task list

- [x] Set up the project skeleton
- [x] Implement toggle command and status bar
- [ ] Real markdown rendering ← you're testing this now
- [ ] Link & image handling
- [ ] Auto-update + final polish

## Blockquote

> The pitch in one sentence: "Markdown tabs that can flip between source and rendered, independently, in place."
>
> — the spec

## Table

| Feature | Status | Notes |
|---|---|---|
| Toggle command | done | step 2 |
| Status bar | done | step 2 |
| Rendering | testing | step 3 |
| Image handling | todo | step 4 |

## Code blocks

A typescript snippet:

```typescript
function getActiveContext(): ActiveContext | null {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'markdown') {
    return {
      uri: editor.document.uri,
      mode: 'source',
      viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active,
    };
  }
  return null;
}
```

A python snippet:

```python
def render(markdown: str) -> str:
    """Render markdown to HTML."""
    return md.parse(markdown)
```

A bash snippet:

```bash
npm run build && code --extensionDevelopmentPath=. .
```

A snippet with no language:

```
plain text
no highlighting expected
```

## Inline HTML

This paragraph has <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> rendered as inline HTML.

## Math (KaTeX)

Inline: Einstein's identity $E = mc^2$ and Pythagoras $a^2 + b^2 = c^2$.

A bare dollar sign in prose: it costs $5 and $10 — these should NOT render as math.

Block:

$$
\int_0^\infty e^{-x^2}\, dx = \frac{\sqrt{\pi}}{2}
$$

A 3×3 matrix:

$$
A = \begin{pmatrix}
a & b & c \\
d & e & f \\
g & h & i
\end{pmatrix}
$$

Aligned equations:

$$
\begin{aligned}
y &= mx + b \\
y - b &= mx \\
\frac{y - b}{m} &= x
\end{aligned}
$$

Math inside a table cell:

| Expression | Rendered |
|---|---|
| Quadratic | $ax^2 + bx + c = 0$ |
| Sum | $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$ |
| Limit | $\lim_{x \to 0} \frac{\sin x}{x} = 1$ |

A deliberately broken expression to test error rendering: $\frac{1}{$ — should show as a styled error, not crash the page.

Math inside fenced code stays as plain code (must NOT render):

```latex
$E = mc^2$
$$\int x \, dx$$
```

## Horizontal rule

---

End of test file.
