import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { TableCell, TablePage } from '@garden/contracts';
import { openDownloadFile } from './open-download-file.js';
import { WorkspaceFileError, assertOpenedInPlace } from './files.js';

const MAX_COLUMNS = 100,
  CELL_CHARS = 512,
  RECORD_BYTES = 1024 * 1024;
const PAGE_READ_BYTES = 4 * 1024 * 1024,
  PAGE_RENDER_BYTES = 512 * 1024;
const cursorKey = randomBytes(32);
const Cursor = z
  .object({
    identity: z.string(),
    offset: z.number().int().nonnegative().safe(),
    row: z.number().int().nonnegative().safe()
  })
  .strict();
const fail = (message: string) => new WorkspaceFileError(message, 400);
const stale = () =>
  new WorkspaceFileError(
    'This table changed or its view expired. Refresh to start from the first page.',
    409
  );
const stamp = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const mac = (body: string) => createHmac('sha256', cursorKey).update(body).digest();
const encode = (value: z.infer<typeof Cursor>) => {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return body + '.' + mac(body).toString('base64url');
};
const decode = (value: string) => {
  const [body, signature, ...extra] = value.split('.');
  if (!body || !signature || extra.length || value.length > 2048) throw stale();
  const given = Buffer.from(signature, 'base64url'),
    expected = mac(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw stale();
  return Cursor.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
};

class PageReadBudget extends Error {}
const crop = (text: string) => {
  const chars = Array.from(text);
  return { text: chars.slice(0, CELL_CHARS).join(''), truncated: chars.length > CELL_CHARS };
};

/** Bytes are read from one held descriptor; no whole-file read or line-offset index is built. */
class Reader {
  offset: number;
  readBytes = 0;
  #buffer = Buffer.alloc(0);
  #index = 0;
  constructor(
    readonly file: FileHandle,
    start: number,
    private readonly signal?: AbortSignal
  ) {
    this.offset = start;
  }
  async load() {
    this.signal?.throwIfAborted();
    if (this.#index < this.#buffer.length) return true;
    if (this.readBytes >= PAGE_READ_BYTES) throw new PageReadBudget();
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await this.file.read(buffer, 0, buffer.length, this.offset);
    this.#buffer = buffer.subarray(0, bytesRead);
    this.#index = 0;
    if (
      this.offset === 0 &&
      bytesRead >= 3 &&
      buffer.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
    ) {
      this.#index = 3;
      this.offset = 3;
    }
    this.readBytes += bytesRead;
    return this.ready;
  }
  get ready() {
    return this.#index < this.#buffer.length;
  }
  take() {
    this.offset++;
    return this.#buffer[this.#index++]!;
  }
  async afterCr() {
    if (await this.load()) if (this.#buffer[this.#index] === 10) this.take();
  }
  async csv(delimiter: number): Promise<{ cells: TableCell[]; columns: number } | null> {
    const start = this.offset,
      cells: TableCell[] = [];
    let mode: 'plain' | 'quoted' | 'closed' = 'plain',
      bytes: number[] = [],
      fieldBytes = 0,
      columns = 0,
      started = false;
    const push = () => {
      if (columns < MAX_COLUMNS) {
        const clipped = fieldBytes > bytes.length;
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes), {
            stream: clipped
          });
        } catch {
          throw fail('Table preview expects UTF-8 text.');
        }
        const cell = crop(text);
        cells.push({ ...cell, truncated: clipped || cell.truncated });
      }
      columns++;
      bytes = [];
      fieldBytes = 0;
      mode = 'plain';
    };
    const append = (byte: number) => {
      fieldBytes++;
      if (columns < MAX_COLUMNS && bytes.length < CELL_CHARS * 4) bytes.push(byte);
    };
    while (true) {
      if (!this.ready && !(await this.load())) {
        if (!started) return null;
        if (mode === 'quoted') throw fail('Unclosed quoted field in this table.');
        push();
        return { cells, columns };
      }
      const byte = this.take();
      started = true;
      if (this.offset - start > RECORD_BYTES)
        throw fail('A table record exceeds one MiB. Download it or inspect it with a script.');
      if (byte === 0)
        throw fail('This file contains binary data; table preview expects UTF-8 text.');
      if (mode === 'quoted') {
        if (byte === 34) mode = 'closed';
        else append(byte);
        continue;
      }
      if (mode === 'closed' && byte === 34) {
        append(34);
        mode = 'quoted';
        continue;
      }
      if (byte === delimiter) {
        push();
        continue;
      }
      if (byte === 10 || byte === 13) {
        if (byte === 13) await this.afterCr();
        push();
        return { cells, columns };
      }
      if (mode === 'closed') {
        if (byte === 32 || byte === 9) continue;
        throw fail('Unexpected text after a quoted table field.');
      }
      if (byte === 34) {
        if (fieldBytes) throw fail('Unexpected quote inside an unquoted table field.');
        mode = 'quoted';
        continue;
      }
      append(byte);
    }
  }
  async jsonLine(): Promise<Record<string, unknown> | null> {
    while (true) {
      const bytes: number[] = [];
      let eof = false;
      while (true) {
        if (!this.ready && !(await this.load())) {
          eof = true;
          break;
        }
        const byte = this.take();
        if (byte === 10) break;
        if (bytes.length >= RECORD_BYTES)
          throw fail('A JSONL record exceeds one MiB. Download it or inspect it with a script.');
        bytes.push(byte);
      }
      if (!bytes.length && eof) return null;
      let line: string;
      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes)).trim();
      } catch {
        throw fail('Table preview expects UTF-8 text.');
      }
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw fail('A JSONL line is not valid JSON.');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw fail('JSONL table rows must be objects.');
      return value as Record<string, unknown>;
    }
  }
}
const csvType = (cell: TableCell) =>
  cell.truncated
    ? 'unknown'
    : cell.text === ''
      ? 'empty'
      : /^(?:true|false)$/i.test(cell.text ?? '')
        ? 'boolean'
        : /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(cell.text ?? '') &&
            Number.isFinite(Number(cell.text))
          ? 'number'
          : 'string';
const jsonCell = (value: unknown): TableCell => {
  if (value === null || value === undefined) return { text: null, truncated: false };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return crop(text);
};

export async function readTablePage(
  root: string,
  requested: string,
  cursor?: string,
  limit = 100,
  signal?: AbortSignal
): Promise<TablePage> {
  const ext = path.extname(requested).toLowerCase(),
    format =
      ext === '.csv'
        ? 'csv'
        : ext === '.tsv'
          ? 'tsv'
          : ext === '.jsonl' || ext === '.ndjson'
            ? 'jsonl'
            : null;
  if (!format) throw fail('Table preview supports CSV, TSV and JSONL files.');
  const pageSize = z.number().int().min(1).max(100).parse(limit);
  const after = cursor ? decode(cursor) : null;
  const opened = await openDownloadFile(root, requested),
    { handle, relative } = opened;
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw fail('This table is too large for byte-addressed preview.');
    const identity = createHash('sha256')
      .update(JSON.stringify([root, relative, format, stamp(before)]))
      .digest('hex');
    if (after && (after.identity !== identity || BigInt(after.offset) > before.size)) throw stale();
    const reader = new Reader(handle, 0, signal);
    let headers: string[] = [],
      headerClipped: boolean[] = [],
      columnsOmitted = 0;
    if (format !== 'jsonl') {
      const header = await reader.csv(format === 'tsv' ? 9 : 44);
      headers = header?.cells.map((cell, index) => cell.text || `Column ${index + 1}`) ?? [];
      headerClipped = header?.cells.map((cell) => cell.truncated) ?? [];
      columnsOmitted = Math.max(0, (header?.columns ?? 0) - MAX_COLUMNS);
    }
    const data = after ? new Reader(handle, after.offset, signal) : reader;
    const rows: TableCell[][] = [],
      types: Array<Set<string>> = headers.map(() => new Set());
    let renderBytes = 0,
      nextOffset = data.offset;
    while (rows.length < pageSize) {
      const start = data.offset;
      let cells: TableCell[],
        rowTypes: string[],
        count: number,
        extras = 0;
      const nextHeaders = [...headers];
      try {
        if (format === 'jsonl') {
          const value = await data.jsonLine();
          if (value === null) {
            nextOffset = data.offset;
            break;
          }
          const keys = Object.keys(value),
            known = new Set(nextHeaders);
          count = keys.length;
          for (const key of keys) {
            if (!known.has(key)) {
              if (nextHeaders.length < MAX_COLUMNS) {
                nextHeaders.push(key);
                known.add(key);
              } else extras++;
            }
          }
          cells = nextHeaders.map((name) =>
            jsonCell(Object.hasOwn(value, name) ? value[name] : undefined)
          );
          rowTypes = nextHeaders.map((name) =>
            !Object.hasOwn(value, name)
              ? 'missing'
              : value[name] === null
                ? 'null'
                : Array.isArray(value[name])
                  ? 'array'
                  : typeof value[name]
          );
        } else {
          const row = await data.csv(format === 'tsv' ? 9 : 44);
          if (!row) {
            nextOffset = data.offset;
            break;
          }
          cells = row.cells;
          count = row.columns;
          while (nextHeaders.length < cells.length)
            nextHeaders.push(`Column ${nextHeaders.length + 1}`);
          rowTypes = cells.map(csvType);
        }
      } catch (error) {
        if (!(error instanceof PageReadBudget)) throw error;
        if (!rows.length)
          throw fail(
            'This page exceeds the preview read budget. Download the file or inspect it with a script.'
          );
        nextOffset = start;
        break;
      }
      const size = Buffer.byteLength(JSON.stringify(cells));
      if (rows.length && renderBytes + size > PAGE_RENDER_BYTES) {
        nextOffset = start;
        break;
      }
      headers = nextHeaders;
      while (types.length < headers.length) types.push(new Set(rows.length ? ['missing'] : []));
      renderBytes += size;
      columnsOmitted = Math.max(columnsOmitted, count - MAX_COLUMNS, extras);
      rows.push(cells);
      for (let index = 0; index < headers.length; index++)
        types[index]!.add(rowTypes[index] ?? 'missing');
      nextOffset = data.offset;
    }
    const current = await handle.stat({ bigint: true });
    await assertOpenedInPlace(root, path.resolve(root, relative), handle);
    if (stamp(before) !== stamp(current)) throw stale();
    return {
      path: relative,
      format,
      identity,
      sizeBytes: Number(before.size),
      rowStart: (after?.row ?? 0) + 1,
      columns: headers.map((name, index) => {
        const clipped = crop(name);
        return {
          name: clipped.text,
          truncated: clipped.truncated || (headerClipped[index] ?? false),
          types: [...types[index]!].sort()
        };
      }),
      rows,
      nextCursor:
        BigInt(nextOffset) < before.size
          ? encode({ identity, offset: nextOffset, row: (after?.row ?? 0) + rows.length })
          : null,
      columnsOmitted,
      cellsTruncated: rows.flat().filter((cell) => cell.truncated).length,
      schemaScope: 'page'
    };
  } finally {
    await handle.close();
  }
}
