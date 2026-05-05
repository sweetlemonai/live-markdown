// Mermaid presets that mirror the editor / preview themes. Mermaid only ships
// four native themes (default, dark, forest, neutral); to give the user a
// readable diagram against any editor theme, we expose extra presets that map
// to mermaid's `theme: 'base'` mode with curated themeVariables.

export const MERMAID_NATIVE = ['default', 'dark', 'forest', 'neutral'] as const;
export type MermaidNative = (typeof MERMAID_NATIVE)[number];

export interface MermaidPreset {
  type: 'dark' | 'light';
  vars: Record<string, string>;
}

/**
 * Build a preset from a small set of "anchor" colors so the table below
 * stays readable. `bg` / `fg` set the diagram background and text; `panel`
 * is the node fill; `border` / `accent` color borders and edges.
 */
function preset(opts: {
  type: 'dark' | 'light';
  bg: string;
  fg: string;
  panel: string;
  panelAlt: string;
  border: string;
  accent: string;
  noteBg?: string;
  noteFg?: string;
}): MermaidPreset {
  const noteBg = opts.noteBg ?? opts.panel;
  const noteFg = opts.noteFg ?? opts.fg;
  return {
    type: opts.type,
    vars: {
      background: opts.bg,
      primaryColor: opts.panel,
      primaryTextColor: opts.fg,
      primaryBorderColor: opts.accent,
      secondaryColor: opts.panelAlt,
      secondaryTextColor: opts.fg,
      secondaryBorderColor: opts.border,
      tertiaryColor: opts.panelAlt,
      tertiaryTextColor: opts.fg,
      tertiaryBorderColor: opts.border,
      lineColor: opts.accent,
      textColor: opts.fg,
      noteBkgColor: noteBg,
      noteTextColor: noteFg,
      noteBorderColor: opts.border,
      edgeLabelBackground: opts.bg,
      labelBackground: opts.panel,
      labelTextColor: opts.fg,
      clusterBkg: opts.panelAlt,
      clusterBorder: opts.border,
      mainBkg: opts.panel,
    },
  };
}

export const MERMAID_PRESETS: Record<string, MermaidPreset> = {
  // ---- Dark editor themes ----
  'github-dark': preset({
    type: 'dark',
    bg: '#0d1117', fg: '#e6edf3', panel: '#1f2937', panelAlt: '#161b22',
    border: '#30363d', accent: '#4493f8',
  }),
  'dark-plus': preset({
    type: 'dark',
    bg: '#1e1e1e', fg: '#cccccc', panel: '#2d2d30', panelAlt: '#252526',
    border: '#3c3c3c', accent: '#569cd6',
  }),
  'monokai': preset({
    type: 'dark',
    bg: '#272822', fg: '#f8f8f2', panel: '#3e3d32', panelAlt: '#1e1f1c',
    border: '#75715e', accent: '#a6e22e',
  }),
  'dracula': preset({
    type: 'dark',
    bg: '#282a36', fg: '#f8f8f2', panel: '#44475a', panelAlt: '#21222c',
    border: '#6272a4', accent: '#bd93f9',
  }),
  'nord': preset({
    type: 'dark',
    bg: '#2e3440', fg: '#d8dee9', panel: '#3b4252', panelAlt: '#434c5e',
    border: '#5e81ac', accent: '#88c0d0',
  }),
  'one-dark-pro': preset({
    type: 'dark',
    bg: '#282c34', fg: '#abb2bf', panel: '#3e4451', panelAlt: '#21252b',
    border: '#5c6370', accent: '#61afef',
  }),
  'tokyo-night': preset({
    type: 'dark',
    bg: '#1a1b26', fg: '#c0caf5', panel: '#24283b', panelAlt: '#16161e',
    border: '#414868', accent: '#7aa2f7',
  }),
  'vitesse-dark': preset({
    type: 'dark',
    bg: '#121212', fg: '#dbd7ca', panel: '#252525', panelAlt: '#1c1c1c',
    border: '#393a34', accent: '#4d9375',
  }),
  'solarized-dark': preset({
    type: 'dark',
    bg: '#002b36', fg: '#93a1a1', panel: '#073642', panelAlt: '#0d4651',
    border: '#586e75', accent: '#268bd2',
  }),
  'noctis': preset({
    type: 'dark',
    bg: '#072730', fg: '#b2c7cb', panel: '#0b3a48', panelAlt: '#062229',
    border: '#1d535b', accent: '#49d6c5',
  }),
  'noctis-azureus': preset({
    type: 'dark',
    bg: '#07101e', fg: '#b9c8e6', panel: '#142339', panelAlt: '#0a1729',
    border: '#1f3858', accent: '#5ec4ff',
  }),
  'noctis-bordo': preset({
    type: 'dark',
    bg: '#272022', fg: '#d3c2c8', panel: '#3a3033', panelAlt: '#1e1819',
    border: '#5a4548', accent: '#e8a2af',
  }),
  'noctis-obscuro': preset({
    type: 'dark',
    bg: '#011417', fg: '#a3afb0', panel: '#072e34', panelAlt: '#011014',
    border: '#0f4955', accent: '#49d6c5',
  }),

  // ---- Light editor themes ----
  'github-light': preset({
    type: 'light',
    bg: '#ffffff', fg: '#1f2328', panel: '#f6f8fa', panelAlt: '#eaeef2',
    border: '#d1d9e0', accent: '#0969da',
    noteBg: '#fff8c5', noteFg: '#1f2328',
  }),
  'light-plus': preset({
    type: 'light',
    bg: '#ffffff', fg: '#000000', panel: '#f3f3f3', panelAlt: '#e8e8e8',
    border: '#cccccc', accent: '#0451a5',
  }),
  'one-light': preset({
    type: 'light',
    bg: '#fafafa', fg: '#383a42', panel: '#f0f0f0', panelAlt: '#e5e5e6',
    border: '#a0a1a7', accent: '#4078f2',
  }),
  'vitesse-light': preset({
    type: 'light',
    bg: '#ffffff', fg: '#393a34', panel: '#f8f8f8', panelAlt: '#eeeeee',
    border: '#dbd7ca', accent: '#1e754f',
  }),
  'solarized-light': preset({
    type: 'light',
    bg: '#fdf6e3', fg: '#586e75', panel: '#eee8d5', panelAlt: '#eee8d5',
    border: '#93a1a1', accent: '#268bd2',
  }),
  'noctis-lux': preset({
    type: 'light',
    bg: '#fef8ec', fg: '#005661', panel: '#f8f1de', panelAlt: '#f3eed8',
    border: '#bf9c93', accent: '#00a4cc',
  }),
  'noctis-hibernus': preset({
    type: 'light',
    bg: '#f0eee4', fg: '#33555e', panel: '#e3e0d0', panelAlt: '#dad6c4',
    border: '#a4b0b6', accent: '#0099a8',
  }),
};

export function isMermaidPreset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MERMAID_PRESETS, name);
}

export function isMermaidNative(name: string): name is MermaidNative {
  return (MERMAID_NATIVE as readonly string[]).includes(name);
}

/**
 * The eight token IDs the override picker exposes (see `MERMAID_TOKENS`).
 * Used by the picker to seed defaults for any preset.
 */
export const MERMAID_PICKER_TOKENS = [
  'background',
  'primaryColor',
  'primaryTextColor',
  'secondaryColor',
  'tertiaryColor',
  'lineColor',
  'labelBackground',
  'labelTextColor',
] as const;
