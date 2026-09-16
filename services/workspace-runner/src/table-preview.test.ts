import { mkdtemp, mkdir, open, rm, symlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTablePage } from './table-preview.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'garden-table-'));
  await mkdir(path.join(root, 'workspace'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const put = async (name: string, content: string | Buffer) => {
  await writeFile(path.join(root, 'workspace', name), content);
  return `workspace/${name}`;
};

describe('bounded table pages', () => {
  it('decodes BOM, escaped quotes, CRLF, embedded newlines, Unicode and final records without coercing identifiers', async () => {
    const file = await put(
      'data.csv',
      '\uFEFF"name",id,note,flag\r\n"Renée 🧬",001,"hello\r\n""world""",true\r\nend,1e2,,false'
    );
    const a = await readTablePage(root, file, undefined, 1);
    expect(a.columns.map((c) => c.name)).toEqual(['name', 'id', 'note', 'flag']);
    expect(a.rows.map((row) => row.map((c) => c.text))).toEqual([
      ['Renée 🧬', '001', 'hello\r\n"world"', 'true']
    ]);
    expect(a.columns.map((c) => c.types)).toEqual([
      ['string'],
      ['string'],
      ['string'],
      ['boolean']
    ]);
    expect(a.nextCursor).toBeTypeOf('string');
    const b = await readTablePage(root, file, a.nextCursor!, 1);
    expect(b.rowStart).toBe(2);
    expect(b.rows.map((row) => row.map((c) => c.text))).toEqual([['end', '1e2', '', 'false']]);
    expect(b.nextCursor).toBeNull();
    expect(b.columns[1]?.types).toEqual(['number']);
    expect(b.schemaScope).toBe('page');
  });

  it('handles a CRLF pair spanning a read boundary and a truncated Unicode field', async () => {
    const file = await put('wide.tsv', 'id\tvalue\n1\t' + '🧬'.repeat(16380) + 'xxxx\r\n2\tend\n');
    const a = await readTablePage(root, file, undefined, 1);
    expect(a.rows[0]?.[1]?.text).toBe('🧬'.repeat(512));
    expect(a.rows[0]?.[1]?.truncated).toBe(true);
    expect(a.columns[1]?.types).toEqual(['unknown']);
    const b = await readTablePage(root, file, a.nextCursor!, 1);
    expect(b.rows.map((row) => row.map((c) => c.text))).toEqual([['2', 'end']]);
    expect(b.nextCursor).toBeNull();
  });

  it('paginates every CSV record exactly once', async () => {
    const expected = Array.from({ length: 251 }, (_, i) => [String(i), `line ${i}\nquoted "text"`]);
    const file = await put(
      'rows.csv',
      'id,value\n' +
        expected
          .map((row) => row.map((cell) => '"' + cell.replaceAll('"', '""') + '"').join(','))
          .join('\n')
    );
    const actual: Array<Array<string | null>> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await readTablePage(root, file, cursor, 37);
      expect(page.rowStart).toBe(actual.length + 1);
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.length).toBeLessThanOrEqual(37);
      actual.push(...page.rows.map((row) => row.map((cell) => cell.text)));
      cursor = page.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(actual).toEqual(expected);
  });

  it('handles JSONL blank lines at chunk boundaries and EOF, unioned columns and missing properties', async () => {
    const file = await put(
      'rows.ndjson',
      '\n'.repeat(65536) + '{"a":1,"toString":"safe","nested":{"b":2}}\n\n{"b":[2],"a":null}\n\n'
    );
    const page = await readTablePage(root, file);
    expect(page.nextCursor).toBeNull();
    expect(page.rows.length).toBe(2);
    expect(page.columns.map((c) => [c.name, c.types])).toEqual([
      ['a', ['null', 'number']],
      ['toString', ['missing', 'string']],
      ['nested', ['missing', 'object']],
      ['b', ['array', 'missing']]
    ]);
    expect(page.rows[0]?.map((c) => c.text)).toEqual(['1', 'safe', '{"b":2}']);
    expect(page.rows[1]?.map((c) => c.text)).toEqual([null, null, null, '[2]']);
  });

  it('limits columns, header lengths and response bytes without claiming whole-file schema', async () => {
    const headers = Array.from({ length: 120 }, (_, i) => `column-${i}`);
    headers[0] = 'h'.repeat(700);
    const file = await put(
      'wide.csv',
      headers.join(',') +
        '\n' +
        Array.from({ length: 80 }, () => headers.map(() => 'x'.repeat(700)).join(',')).join('\n')
    );
    const page = await readTablePage(root, file);
    expect(page.columns).toHaveLength(100);
    expect(page.columns[0]).toMatchObject({ name: 'h'.repeat(512), truncated: true });
    expect(page.columnsOmitted).toBe(20);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.length).toBeLessThan(80);
    expect(page.cellsTruncated).toBe(page.rows.length * 100);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(600 * 1024);
    expect(page.nextCursor).toBeTypeOf('string');
  });

  it('returns a useful short page when long records exhaust the read budget, then continues', async () => {
    const file = await put(
      'long.csv',
      'id,value\n' + Array.from({ length: 12 }, (_, i) => `${i},${'x'.repeat(700_000)}\n`).join('')
    );
    let cursor: string | undefined;
    const ids: string[] = [];
    let pages = 0;
    do {
      const page = await readTablePage(root, file, cursor);
      expect(page.rows.length).toBeGreaterThan(0);
      ids.push(...page.rows.map((row) => row[0]!.text!));
      cursor = page.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(5);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => String(i)));
  });

  it('reads bounded pages of a sparse 20 GB file', async () => {
    const file = await put(
      'large.csv',
      'id,value\n' + Array.from({ length: 250 }, (_, i) => `${i},value\n`).join('')
    );
    const handle = await open(path.join(root, file), 'r+');
    await handle.truncate(20 * 1024 ** 3);
    await handle.close();
    const first = await readTablePage(root, file);
    const second = await readTablePage(root, file, first.nextCursor!);
    expect(first.rows).toHaveLength(100);
    expect(second.rows).toHaveLength(100);
    expect(second.rows[0]?.[0]?.text).toBe('100');
    expect(second.sizeBytes).toBe(20 * 1024 ** 3);
  });

  it('rejects file changes, path changes, forged cursors and replacement between pages', async () => {
    const a = await put('a.csv', 'a\n1\n2\n');
    const b = await put('b.csv', 'a\n1\n2\n');
    const page = await readTablePage(root, a, undefined, 1);
    expect(page.nextCursor).toBeTypeOf('string');
    await expect(readTablePage(root, b, page.nextCursor!)).rejects.toThrow('changed');
    await expect(readTablePage(root, a, page.nextCursor! + 'x')).rejects.toThrow('changed');
    await writeFile(path.join(root, a), 'a\n1\n3\n');
    await expect(readTablePage(root, a, page.nextCursor!)).rejects.toThrow('changed');
    const fresh = await readTablePage(root, a, undefined, 1);
    await rename(path.join(root, b), path.join(root, a));
    await expect(readTablePage(root, a, fresh.nextCursor!)).rejects.toThrow('changed');
  });

  it.each([
    ['unclosed.csv', 'a\n"open', 'Unclosed'],
    ['quotes.csv', 'a\nun"quoted', 'Unexpected quote'],
    ['after.csv', 'a\n"ok"text', 'Unexpected text'],
    ['binary.csv', Buffer.from([97, 10, 0]), 'binary'],
    ['encoding.csv', Buffer.from([97, 10, 255]), 'UTF-8'],
    ['encoding.jsonl', Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125]), 'UTF-8'],
    ['bad.jsonl', '{', 'valid JSON'],
    ['array.jsonl', '[]', 'must be objects'],
    ['oversize.csv', 'a\n' + 'x'.repeat(1024 * 1024 + 1), 'exceeds one MiB'],
    ['oversize.jsonl', '{"a":"' + 'x'.repeat(1024 * 1024) + '"}', 'exceeds one MiB']
  ])('rejects malformed or unpreviewable %s honestly', async (name, bytes, message) => {
    await expect(readTablePage(root, await put(name, bytes))).rejects.toThrow(message);
  });

  it('handles empty files and blank terminal lines without a non-progressing cursor', async () => {
    for (const text of ['', '\uFEFF', 'a\n']) {
      const page = await readTablePage(root, await put('empty.csv', text));
      expect(page.rows).toEqual([]);
      expect(page.nextCursor).toBeNull();
    }
    const json = await readTablePage(root, await put('blank.jsonl', '\n\n\r\n'));
    expect(json.rows).toEqual([]);
    expect(json.nextCursor).toBeNull();
  });

  it('refuses protected paths, links, directories and aborted reads', async () => {
    const file = await put('data.csv', 'id\n1\n');
    await writeFile(path.join(root, 'private.csv'), 'secret');
    await symlink(path.join(root, 'private.csv'), path.join(root, 'workspace/link.csv'));
    await mkdir(path.join(root, 'workspace/directory.csv'));
    await expect(readTablePage(root, '../private.csv')).rejects.toThrow();
    await expect(readTablePage(root, 'workspace/link.csv')).rejects.toThrow();
    await expect(readTablePage(root, 'workspace/directory.csv')).rejects.toThrow('regular');
    await expect(
      readTablePage(root, file, undefined, 10, AbortSignal.abort(new Error('cancelled')))
    ).rejects.toThrow('cancelled');
    await expect(readTablePage(root, 'workspace/data.txt')).rejects.toThrow('supports CSV');
  });
});
