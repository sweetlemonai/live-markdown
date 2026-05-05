import type { Category } from './themeStore';

export interface TokenDef {
  id: string;
  label: string;
}

const SOURCE_LIKE_TOKENS: TokenDef[] = [
  { id: 'editor.background', label: 'Background' },
  { id: 'editor.foreground', label: 'Default text' },
  { id: 'comment', label: 'Comments' },
  { id: 'keyword', label: 'Keywords' },
  { id: 'string', label: 'Strings' },
  { id: 'number', label: 'Numbers' },
  { id: 'entity.name.function', label: 'Functions' },
  { id: 'variable', label: 'Variables' },
  { id: 'entity.name.type', label: 'Types' },
  { id: 'constant', label: 'Constants' },
  { id: 'keyword.operator', label: 'Operators' },
  { id: 'punctuation', label: 'Punctuation' },
  { id: 'string.regexp', label: 'Regular expressions' },
];

const PREVIEW_TOKENS: TokenDef[] = [
  { id: 'background', label: 'Page background' },
  { id: 'foreground', label: 'Default text' },
  { id: 'heading', label: 'Headings (H1–H6)' },
  { id: 'link', label: 'Link color' },
  { id: 'link-hover', label: 'Link hover' },
  { id: 'blockquote-border', label: 'Block quote border' },
  { id: 'blockquote-fg', label: 'Block quote text' },
  { id: 'inline-code-bg', label: 'Inline code background' },
  { id: 'inline-code-fg', label: 'Inline code text' },
  { id: 'code-block-bg', label: 'Code block background' },
  { id: 'table-border', label: 'Table border' },
  { id: 'table-header-bg', label: 'Table header background' },
  { id: 'hr', label: 'Horizontal rule' },
  { id: 'strikethrough', label: 'Strikethrough' },
  { id: 'mark-bg', label: 'Mark / highlight background' },
];

const MERMAID_TOKENS: TokenDef[] = [
  { id: 'background', label: 'Background' },
  { id: 'primaryColor', label: 'Primary' },
  { id: 'primaryTextColor', label: 'Primary text' },
  { id: 'secondaryColor', label: 'Secondary' },
  { id: 'tertiaryColor', label: 'Tertiary' },
  { id: 'lineColor', label: 'Lines' },
  { id: 'labelBackground', label: 'Label background' },
  { id: 'labelTextColor', label: 'Label text' },
];

export const TOKENS_BY_CATEGORY: Record<Category, TokenDef[]> = {
  source: SOURCE_LIKE_TOKENS,
  preview: PREVIEW_TOKENS,
  code: SOURCE_LIKE_TOKENS,
  mermaid: MERMAID_TOKENS,
};
