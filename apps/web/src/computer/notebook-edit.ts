import { notebookObject, notebookText, parseNotebook } from './notebook';

export interface NotebookFile extends Record<string, unknown> {
  cells: unknown[];
}
export type CellKind = 'code' | 'markdown' | 'raw';
export type NotebookEdit =
  | { type: 'source'; index: number; source: string }
  | { type: 'kind'; index: number; kind: CellKind }
  | { type: 'move'; index: number; to: number }
  | { type: 'remove'; index: number }
  | { type: 'insert'; index: number; kind: CellKind; id: string }
  | { type: 'clear_outputs' };

export function editableNotebook(content: string): NotebookFile {
  parseNotebook(content);
  return JSON.parse(content) as NotebookFile;
}

export function cellEditable(value: unknown): boolean {
  const cell = notebookObject(value);
  return (
    !!cell &&
    ['code', 'markdown', 'raw'].includes(String(cell.cell_type)) &&
    notebookText(cell.source) !== null
  );
}

function stale(value: unknown): unknown {
  const cell = notebookObject(value);
  if (cell?.cell_type !== 'code' || !Array.isArray(cell.outputs) || !cell.outputs.length)
    return value;
  const metadata = notebookObject(cell.metadata) ?? {};
  if (metadata.garden_outputs_stale === true) return value;
  return { ...cell, metadata: { ...metadata, trusted: false, garden_outputs_stale: true } };
}

/** Preserve unknown notebook fields and output bodies; editing never represents a fresh execution. */
export function editNotebook(document: NotebookFile, action: NotebookEdit): NotebookFile {
  let cells = [...document.cells];
  let affectsCode = false;
  if (action.type === 'clear_outputs') {
    cells = cells.map((value) => {
      const cell = notebookObject(value);
      if (cell?.cell_type !== 'code') return value;
      const metadata = { ...(notebookObject(cell.metadata) ?? {}) };
      delete metadata.garden_outputs_stale;
      return { ...cell, outputs: [], execution_count: null, metadata };
    });
  } else if (action.type === 'insert') {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index > cells.length)
      throw Error('Invalid cell position');
    cells.splice(action.index, 0, {
      id: action.id,
      cell_type: action.kind,
      metadata: {},
      source: '',
      ...(action.kind === 'code' ? { outputs: [], execution_count: null } : {})
    });
    affectsCode = action.kind === 'code';
  } else {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= cells.length)
      throw Error('Cell no longer exists');
    const original = cells[action.index];
    const cell = notebookObject(original);
    affectsCode = cell?.cell_type === 'code';
    if (action.type === 'remove') cells.splice(action.index, 1);
    else if (action.type === 'move') {
      if (!Number.isInteger(action.to) || action.to < 0 || action.to >= cells.length)
        throw Error('Invalid cell position');
      if (action.index === action.to) return document;
      cells.splice(action.index, 1);
      cells.splice(action.to, 0, original);
    } else {
      if (!cellEditable(cell))
        throw Error('This cell needs to be edited in its source application');
      if (action.type === 'source') {
        if (notebookText(cell!.source) === action.source) return document;
        cells[action.index] = {
          ...cell,
          source: action.source,
          ...(affectsCode
            ? { metadata: { ...(notebookObject(cell!.metadata) ?? {}), trusted: false } }
            : {})
        };
      } else {
        if (cell!.cell_type === action.kind) return document;
        const next = { ...cell, cell_type: action.kind } as Record<string, unknown>;
        if (action.kind === 'code') {
          next.outputs = [];
          next.execution_count = null;
          affectsCode = true;
        } else {
          delete next.outputs;
          delete next.execution_count;
        }
        // Markdown attachments are retained in metadata when changing the cell's format.
        if (action.kind !== 'markdown' && next.attachments !== undefined) {
          next.metadata = {
            ...(notebookObject(next.metadata) ?? {}),
            garden_attachments: next.attachments
          };
          delete next.attachments;
        } else if (action.kind === 'markdown') {
          const metadata = notebookObject(next.metadata);
          if (metadata?.garden_attachments !== undefined) {
            next.attachments = metadata.garden_attachments;
            const restored = { ...metadata };
            delete restored.garden_attachments;
            next.metadata = restored;
          }
        }
        cells[action.index] = next;
      }
    }
  }
  if (affectsCode) cells = cells.map(stale);
  return { ...document, cells };
}

export interface NotebookHistory {
  document: NotebookFile;
  undo: NotebookFile[];
  redo: NotebookFile[];
  coalesce: number | null;
}

export function notebookHistory(document: NotebookFile): NotebookHistory {
  return { document, undo: [], redo: [], coalesce: null };
}

/** Structural sharing keeps recorded image/output bodies out of the undo copy cost. */
export function applyNotebookEdit(state: NotebookHistory, edit: NotebookEdit): NotebookHistory {
  const document = editNotebook(state.document, edit);
  if (document === state.document) return state;
  const coalesce = edit.type === 'source' ? edit.index : null;
  return {
    document,
    undo:
      coalesce !== null && coalesce === state.coalesce
        ? state.undo
        : [...state.undo.slice(-49), state.document],
    redo: [],
    coalesce
  };
}

export function moveNotebookHistory(
  state: NotebookHistory,
  direction: 'undo' | 'redo'
): NotebookHistory {
  const source = state[direction];
  const document = source.at(-1);
  if (!document) return state;
  return {
    document,
    coalesce: null,
    undo: direction === 'undo' ? source.slice(0, -1) : [...state.undo, state.document],
    redo: direction === 'redo' ? source.slice(0, -1) : [...state.redo, state.document]
  };
}
