import type * as Monaco from 'monaco-editor';
import type { ThemeRegistration } from 'shiki';

const SOURCE_COLOR_TOKENS = new Set(['editor.background', 'editor.foreground']);

/**
 * Apply user token overrides on top of a Monaco theme that was generated
 * from a shiki theme registration.
 *
 * - `editor.background` / `editor.foreground` override Monaco theme `colors`.
 * - All other token ids are TextMate scopes and override / append rules.
 */
export function applyMonacoOverrides(
  base: Monaco.editor.IStandaloneThemeData,
  overrides: Record<string, string>,
): Monaco.editor.IStandaloneThemeData {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const colors = { ...(base.colors ?? {}) };
  const rules = base.rules ? base.rules.slice() : [];
  for (const [token, color] of Object.entries(overrides)) {
    const hex = normalizeHex(color);
    if (!hex) continue;
    if (SOURCE_COLOR_TOKENS.has(token)) {
      colors[token] = hex;
      continue;
    }
    const monacoFg = stripHash(hex);
    const idx = rules.findIndex((r) => r.token === token);
    if (idx >= 0) {
      rules[idx] = { ...rules[idx], foreground: monacoFg };
    } else {
      rules.push({ token, foreground: monacoFg });
    }
  }
  return { ...base, rules, colors };
}

/**
 * Apply user token overrides to a shiki theme registration so the rendered
 * output reflects them. Returns a cloned registration with a derived name.
 */
export function applyShikiOverrides(
  base: ThemeRegistration,
  overrides: Record<string, string>,
  derivedName: string,
): ThemeRegistration {
  if (!overrides || Object.keys(overrides).length === 0) {
    return base;
  }
  const colors: Record<string, string> = { ...(base.colors ?? {}) };
  const settings = (base.settings ?? base.tokenColors ?? []).map((s) =>
    JSON.parse(JSON.stringify(s)),
  );

  for (const [token, color] of Object.entries(overrides)) {
    const hex = normalizeHex(color);
    if (!hex) continue;
    if (SOURCE_COLOR_TOKENS.has(token)) {
      colors[token] = hex;
      continue;
    }
    const idx = settings.findIndex((s: { scope?: string | string[] }) => {
      const scope = s.scope;
      if (typeof scope === 'string') return scope === token;
      if (Array.isArray(scope)) return scope.includes(token);
      return false;
    });
    if (idx >= 0) {
      const existing = settings[idx];
      existing.scope = token;
      existing.settings = { ...(existing.settings ?? {}), foreground: hex };
    } else {
      settings.push({ scope: token, settings: { foreground: hex } });
    }
  }

  return {
    ...base,
    name: derivedName,
    colors,
    settings,
    tokenColors: undefined,
  } as ThemeRegistration;
}

/** Compute the resolved (current) color for a list of tokens from a shiki theme. */
export function resolveSourceTokenDefaults(
  base: ThemeRegistration,
  tokens: ReadonlyArray<{ id: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const colors = base.colors ?? {};
  const settings = base.settings ?? base.tokenColors ?? [];
  for (const tok of tokens) {
    if (tok.id === 'editor.background') {
      out[tok.id] = normalizeHex(colors['editor.background']) ?? normalizeHex(base.bg) ?? '#000000';
      continue;
    }
    if (tok.id === 'editor.foreground') {
      out[tok.id] = normalizeHex(colors['editor.foreground']) ?? normalizeHex(base.fg) ?? '#ffffff';
      continue;
    }
    const match = settings.find((s) => {
      const scope = s.scope;
      if (typeof scope === 'string') return scope.split(',').map((x) => x.trim()).includes(tok.id);
      if (Array.isArray(scope)) return scope.includes(tok.id);
      return false;
    });
    const fg = match?.settings?.foreground;
    out[tok.id] = normalizeHex(fg) ?? normalizeHex(colors['editor.foreground']) ?? '#888888';
  }
  return out;
}

function normalizeHex(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
    return v.length === 4 || v.length === 5
      ? '#' + v.slice(1).split('').map((c) => c + c).join('')
      : v.toLowerCase();
  }
  return undefined;
}

function stripHash(hex: string): string {
  return hex.startsWith('#') ? hex.slice(1) : hex;
}
