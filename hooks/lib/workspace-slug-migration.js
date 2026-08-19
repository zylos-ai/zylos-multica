/**
 * Shared legacy workspace_id -> workspace_slug config migration, used by both
 * post-install and post-upgrade so the canonical `zylos upgrade` path (which
 * only runs post-upgrade) rewrites configs the same way a fresh install does.
 * Mutates `config` in place on success. Best-effort: any server problem defers
 * to the daemon's startup self-heal instead of failing the hook.
 */
export async function migrateWorkspaceSlug(config) {
  if (config.workspace_slug || !config.workspace_id || !config.base_url || !config.pat) {
    return { changed: false };
  }
  try {
    const response = await fetch(new URL('/api/workspaces', config.base_url), {
      headers: { Authorization: `Bearer ${config.pat}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const workspaces = await response.json();
    const match = Array.isArray(workspaces)
      ? workspaces.find((workspace) => workspace && workspace.id === config.workspace_id)
      : undefined;
    if (!match?.slug) {
      return { changed: false, warning: 'workspace_slug migration skipped: stored workspace_id not found for this PAT' };
    }
    config.workspace_slug = match.slug;
    delete config.workspace_id;
    return { changed: true, note: `Migrated workspace_id config to workspace_slug "${match.slug}"` };
  } catch (error) {
    return { changed: false, warning: `workspace_slug migration deferred (${error.message}); the daemon migrates on startup` };
  }
}
