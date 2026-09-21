import { describe, expect, it, vi } from 'vitest';
import {
  applyNotebookEdit,
  editableNotebook,
  editNotebook,
  moveNotebookHistory,
  notebookHistory
} from './notebook-edit';
import { loadNotebookFile, saveNotebookFile } from './notebook-file';

const source = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3' }, custom: ['retain'] },
  custom_root: { retained: true },
  cells: [
    {
      id: 'intro',
      cell_type: 'markdown',
      metadata: { custom: 1 },
      source: ['# Analysis\n'],
      attachments: { 'plot.png': { 'image/png': 'retained' } }
    },
    {
      id: 'first',
      cell_type: 'code',
      metadata: { trusted: true },
      source: ['x = 1'],
      execution_count: 8,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'old result' }]
    },
    {
      id: 'second',
      cell_type: 'code',
      metadata: {},
      source: 'x + 1',
      execution_count: 9,
      outputs: [{ output_type: 'execute_result', data: { 'text/plain': '2' } }]
    },
    { cell_type: 'future', data: { must: 'remain' } }
  ]
});

describe('notebook edits preserve evidence and document structure', () => {
  it('changes only source and evidence freshness, retaining outputs and unknown fields', () => {
    const before = editableNotebook(source);
    const next = editNotebook(before, { type: 'source', index: 1, source: 'x = 2' });
    expect(next.metadata).toEqual(before.metadata);
    expect(next.custom_root).toEqual({ retained: true });
    expect(next.cells[0]).toBe(before.cells[0]);
    expect(next.cells[3]).toBe(before.cells[3]);
    expect(next.cells[1]).toMatchObject({
      source: 'x = 2',
      execution_count: 8,
      metadata: { trusted: false, garden_outputs_stale: true },
      outputs: [{ text: 'old result' }]
    });
    expect(next.cells[2]).toMatchObject({ metadata: { garden_outputs_stale: true } });
    expect(JSON.stringify(before)).toBe(source);
  });
  it('does not mark outputs stale for prose-only changes', () => {
    const before = editableNotebook(source);
    const next = editNotebook(before, { type: 'source', index: 0, source: '# New heading' });
    expect(next.cells[1]).toBe(before.cells[1]);
    expect(next.cells[0]).toMatchObject({
      attachments: { 'plot.png': { 'image/png': 'retained' } }
    });
  });
  it('preserves attachments across changing formats', () => {
    const before = editableNotebook(source);
    const code = editNotebook(before, { type: 'kind', index: 0, kind: 'code' });
    expect(code.cells[0]).not.toHaveProperty('attachments');
    expect(code.cells[0]).toMatchObject({ outputs: [], execution_count: null });
    const restored = editNotebook(code, { type: 'kind', index: 0, kind: 'markdown' });
    expect(restored.cells[0]).toEqual(before.cells[0]);
  });
  it('marks existing outputs stale on code insertion, removal and reordering', () => {
    const before = editableNotebook(source);
    for (const action of [
      { type: 'insert', index: 0, kind: 'code', id: 'new' },
      { type: 'move', index: 1, to: 0 },
      { type: 'remove', index: 1 }
    ] as const) {
      const next = editNotebook(before, action);
      const remaining = next.cells.filter((cell) => (cell as { id?: string }).id === 'second');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({ metadata: { garden_outputs_stale: true } });
    }
  });
  it('clears recorded output explicitly and retains prose and metadata', () => {
    const before = editableNotebook(source);
    const next = editNotebook(before, { type: 'clear_outputs' });
    expect(next.cells[0]).toBe(before.cells[0]);
    expect(next.cells[1]).toMatchObject({ outputs: [], execution_count: null });
    expect(next.cells[3]).toBe(before.cells[3]);
  });
  it('coalesces typing and restores deleted cells, attachments and outputs through undo/redo', () => {
    const before = editableNotebook(source);
    let state = notebookHistory(before);
    state = applyNotebookEdit(state, { type: 'source', index: 1, source: 'x = 3' });
    state = applyNotebookEdit(state, { type: 'source', index: 1, source: 'x = 31' });
    expect(state.undo).toHaveLength(1);
    const changed = state.document;
    state = applyNotebookEdit(state, { type: 'remove', index: 0 });
    state = moveNotebookHistory(state, 'undo');
    expect(state.document).toBe(changed);
    state = moveNotebookHistory(state, 'undo');
    expect(state.document).toBe(before);
    state = moveNotebookHistory(state, 'redo');
    expect(state.document).toBe(changed);
    state = applyNotebookEdit(state, { type: 'source', index: 1, source: 'x = 42' });
    expect(state.redo).toHaveLength(0);
  });
  it('refuses unknown cells and invalid positions instead of silently rebuilding them', () => {
    const document = editableNotebook(source);
    expect(() => editNotebook(document, { type: 'source', index: 3, source: 'oops' })).toThrow();
    expect(() => editNotebook(document, { type: 'remove', index: -1 })).toThrow();
    expect(() => editNotebook(document, { type: 'move', index: 0, to: 99 })).toThrow();
  });
});

describe('notebook file version binding', () => {
  const sha = 'a'.repeat(64);
  it('requires the complete, hash-bound notebook before editing', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      for (const headers of [{}, { 'x-content-sha256': sha, 'x-truncated': 'true' }]) {
        fetch.mockResolvedValueOnce(new Response(source, { headers }));
        await expect(
          loadNotebookFile('workspace', 'workspace/run.ipynb', new AbortController().signal)
        ).rejects.toThrow('complete notebook');
      }
      fetch.mockResolvedValueOnce(new Response(source, { headers: { 'x-content-sha256': sha } }));
      const file = await loadNotebookFile(
        'workspace',
        'workspace/run.ipynb',
        new AbortController().signal
      );
      expect(file.sha).toBe(sha);
      expect(file.document).toEqual(editableNotebook(source));
    } finally {
      fetch.mockRestore();
    }
  });
  it('sends the read version and preserves a concurrency conflict as a failed save', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'file_changed', message: 'Changed by another conversation' }
        }),
        { status: 409 }
      )
    );
    try {
      await expect(
        saveNotebookFile('workspace', 'workspace/run.ipynb', sha, editableNotebook(source))
      ).rejects.toThrow('Changed by another conversation');
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      expect(typeof url).toBe('string');
      expect(url as string).toContain(`expectSha256=${sha}`);
      expect(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array))).toEqual(
        editableNotebook(source)
      );
    } finally {
      fetch.mockRestore();
    }
  });
});
