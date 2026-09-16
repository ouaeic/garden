import type { AgentState } from './agent-state.js';

const WORKSPACE_READS = new Set([
  'code_search',
  'repo_overview',
  'file_read',
  'document_read',
  'document_search'
]);

/** A completed read is reusable only until a write or background observation can change its source. */
export function invalidateWorkspaceReadCache(state: Pick<AgentState, 'seenCalls'>): void {
  if (!state.seenCalls) return;
  for (const key of Object.keys(state.seenCalls))
    if (WORKSPACE_READS.has(key.slice(0, key.indexOf(':')))) delete state.seenCalls[key];
}
