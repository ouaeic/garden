import { sha256 } from '@garden/core';
import type { ModelToolCall } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import { asRecord } from './values.js';

/** Only observed source content counts; IDs, timestamps, plans and repeated polls do not. */
export function evidenceProgressKey(call: ModelToolCall, result: unknown): string | undefined {
  if (
    ![
      'file_read',
      'web_search',
      'parallel_web_read',
      'browser_snapshot',
      'read_elements',
      'document_read'
    ].includes(call.name)
  )
    return undefined;
  const value = asRecord(result);
  if (!value || value.error || value.success === false) return undefined;
  const entries: Array<[unknown, string]> = [];
  const observe = (item: unknown) => {
    const row = asRecord(item);
    if (!row || row.error || row.success === false) return;
    const content = [row.content, row.text, row.markdown, row.answer, row.snippet].find(
      (part) => typeof part === 'string' && part.trim()
    );
    if (typeof content !== 'string') return;
    const source = row.url ?? row.path ?? call.arguments.url ?? call.arguments.path ?? '';
    entries.push([source, content]);
  };
  observe(value);
  for (const field of ['pages', 'results'])
    if (Array.isArray(value[field])) for (const item of value[field]) observe(item);
  if (!entries.length) return undefined;
  return sha256(JSON.stringify([...new Set(entries.map((entry) => JSON.stringify(entry)))].sort()));
}

export function turnEvidenceCount(results: AgentState['turnToolResults']): number {
  return new Set(
    Object.values(results ?? {})
      .filter((value) => value.success && value.progressKey)
      .map((value) => value.progressKey)
  ).size;
}
