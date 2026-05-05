import * as vscode from 'vscode';

const OLD_NAMESPACE = 'markdownToggle';
const NEW_NAMESPACE = 'liveMarkdown';
const KEYS = [
  'sourceTheme',
  'previewTheme',
  'codeTheme',
  'secondRow',
  'showFrontMatter',
  'showHeadingAnchors',
  'imagePasteFolder',
  'themes',
  'readingWordsPerMinute',
];

const MIGRATION_MARKER_KEY = 'liveMarkdown.migrationCompleted_v1';

export async function runMigrations(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATION_MARKER_KEY)) return;

  const oldCfg = vscode.workspace.getConfiguration(OLD_NAMESPACE);
  const newCfg = vscode.workspace.getConfiguration(NEW_NAMESPACE);
  for (const key of KEYS) {
    const oldVal = oldCfg.inspect(key);
    if (!oldVal) continue;
    // Only copy values explicitly set by the user — never the default.
    const userValue = oldVal.globalValue ?? oldVal.workspaceValue;
    if (userValue === undefined) continue;
    const existing = newCfg.inspect(key);
    if (existing && (existing.globalValue !== undefined || existing.workspaceValue !== undefined)) {
      continue; // user already has a value under the new namespace
    }
    try {
      await newCfg.update(key, userValue, vscode.ConfigurationTarget.Global);
    } catch {
      // Setting may not be declared in the new namespace's schema; ignore.
    }
  }

  // Workspace state — migrate per-file theme overrides.
  const oldPrefix = 'themes.perFile.';
  // Memento doesn't expose key enumeration, so we rely on the legacy pattern
  // that was used for per-file entries. We attempt to migrate any keys that
  // were stored with the old prefix during prior versions.
  const memento = context.workspaceState as vscode.Memento & { keys?: () => readonly string[] };
  if (typeof memento.keys === 'function') {
    for (const key of memento.keys()) {
      if (!key.startsWith(oldPrefix)) continue;
      const value = memento.get(key);
      if (value === undefined) continue;
      // Already in the new layout (no namespace prefix in workspaceState
      // keys); nothing to migrate. Left here as a hook if future versions
      // namespace these keys.
      void value;
    }
  }

  await context.globalState.update(MIGRATION_MARKER_KEY, true);
}
