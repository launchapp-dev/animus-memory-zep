// Scope-segment normalization for Zep graphId derivation.
//
// Rules (from v0.5-protocol-specs.md §4 "Zep implementation guidance"):
//   1. lowercase
//   2. replace any char not in [a-z0-9_-] with '-'
//   3. collapse repeated '-' into one
//   4. trim leading/trailing '-'
//   5. truncate to 64 chars
//   6. if result is empty, replace with first 16 hex chars of sha256(input)
//
// The same normalization MUST be applied to both graphId pattern construction
// AND to the list_scopes prefix filter — the protocol spec is explicit that
// using raw `project_id` for the prefix would miss any scope whose project_id
// contained mixed case or non-[a-z0-9_-] characters.

import { createHash } from 'node:crypto';

export function normalize(segment: string): string {
  let s = segment.toLowerCase();
  // Replace any character not in [a-z0-9_-] with '-'.
  s = s.replace(/[^a-z0-9_-]/g, '-');
  // Collapse runs of '-' into a single '-'.
  s = s.replace(/-+/g, '-');
  // Trim leading and trailing '-'.
  s = s.replace(/^-+|-+$/g, '');
  // Truncate to 64 chars.
  s = s.slice(0, 64);
  if (s === '') {
    // Fall back to a stable hash of the un-normalized input. We deliberately
    // hash the ORIGINAL input (not the post-lowercase/strip artifact) so two
    // inputs whose normalization collapses to "" produce distinguishable
    // graphIds when their byte content differs.
    const hash = createHash('sha256').update(segment).digest('hex');
    s = hash.slice(0, 16);
  }
  return s;
}

// Public scope→graphId mapping helpers. Always go through these — never build
// graphIds inline.
export function graphIdForProject(projectId: string): string {
  return `proj_${normalize(projectId)}`;
}

export function graphIdForAgent(projectId: string, agentId: string): string {
  return `proj_${normalize(projectId)}__agent_${normalize(agentId)}`;
}

export function graphIdForTask(projectId: string, agentId: string, taskId: string): string {
  return `proj_${normalize(projectId)}__agent_${normalize(agentId)}__task_${normalize(taskId)}`;
}

/**
 * Derive the graphId for a `MemoryScope` value. Throws when the scope shape is
 * invalid (e.g. `task_id` set without `agent_id`).
 */
export function graphIdForScope(scope: {
  project_id: string;
  agent_id?: string | null;
  task_id?: string | null;
}): string {
  if (!scope.project_id || typeof scope.project_id !== 'string') {
    throw new TypeError('scope.project_id is required');
  }
  const hasAgent = scope.agent_id !== undefined && scope.agent_id !== null && scope.agent_id !== '';
  const hasTask = scope.task_id !== undefined && scope.task_id !== null && scope.task_id !== '';
  if (hasTask && !hasAgent) {
    throw new TypeError('scope.task_id requires scope.agent_id');
  }
  if (hasTask) {
    return graphIdForTask(scope.project_id, scope.agent_id as string, scope.task_id as string);
  }
  if (hasAgent) {
    return graphIdForAgent(scope.project_id, scope.agent_id as string);
  }
  return graphIdForProject(scope.project_id);
}

/**
 * Stable prefix used to filter `graph.listAll` results by project. Caller
 * MUST pass the un-normalized project_id; this helper applies `normalize`.
 */
export function listScopesPrefix(projectId: string): string {
  return graphIdForProject(projectId);
}
