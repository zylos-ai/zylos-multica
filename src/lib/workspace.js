/** Workspace slug -> UUID resolution against the account's /api/workspaces. */

import { multicaRequest } from './multica-api.js';

// Mirrors the server's workspace slug validation pattern.
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function fetchWorkspaces(config, request) {
  const response = await request(config, 'GET', '/api/workspaces');
  if (!Array.isArray(response)) {
    throw new Error('GET /api/workspaces returned an unexpected shape');
  }
  return response.filter((entry) => entry && typeof entry === 'object');
}

function describeAvailable(workspaces) {
  const slugs = workspaces.map((workspace) => workspace.slug).filter(Boolean).sort();
  return slugs.length ? `available slugs: ${slugs.join(', ')}` : 'the account has no workspaces';
}

/**
 * Ensures config.workspace_id carries the UUID for config.workspace_slug,
 * resolving through the PAT's workspace listing when it does not. A legacy
 * config (workspace_id without workspace_slug) is reverse-mapped to its slug
 * and reported through onMigrated so the caller can persist the rewrite; the
 * in-memory config is updated either way.
 */
export async function ensureWorkspaceResolved(config, { request = multicaRequest, onMigrated } = {}) {
  if (config.workspace_slug && config.workspace_id) return config.workspace_id;

  if (!config.workspace_slug && config.workspace_id) {
    const workspaces = await fetchWorkspaces(config, request);
    const match = workspaces.find((workspace) => workspace.id === config.workspace_id);
    if (!match?.slug) {
      throw new Error(
        `legacy workspace_id ${config.workspace_id} does not belong to this PAT's account; ${describeAvailable(workspaces)}`,
      );
    }
    config.workspace_slug = match.slug;
    await onMigrated?.(match);
    return config.workspace_id;
  }

  const workspaces = await fetchWorkspaces(config, request);
  const match = workspaces.find((workspace) => workspace.slug === config.workspace_slug);
  if (!match?.id) {
    throw new Error(
      `workspace slug "${config.workspace_slug}" not found for this PAT; ${describeAvailable(workspaces)}`,
    );
  }
  config.workspace_id = match.id;
  return config.workspace_id;
}
