import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonProof } from '@athanor/contracts';
import { compareJson, JSON_PROOF_MAX_BYTES, proveJson } from './json-proof.js';

describe('exact JSON evidence', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'garden-json-proof-'));
    await mkdir(path.join(root, 'workspace'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const json = {
    equals: { '/summary/ready': 1 },
    lengths: { '/records': 2 },
    uniqueBy: { '/records': 'id' }
  };
  const source = {
    records: [
      { id: 'one', ready: true },
      { id: 'two', ready: false }
    ],
    summary: { ready: 1 }
  };
  it('binds a complete proof to exact file bytes and detects changed values', async () => {
    const content = JSON.stringify(source);
    await writeFile(path.join(root, 'workspace/result.json'), content);
    const proof = await proveJson(root, { path: 'workspace/result.json', json });
    expect(proof).toMatchObject({
      passed: true,
      assertions: 3,
      failures: [],
      sha256: createHash('sha256').update(content).digest('hex')
    });
    await writeFile(
      path.join(root, 'workspace/result.json'),
      JSON.stringify({ ...source, summary: { ready: 2 } })
    );
    const changed = await proveJson(root, { path: 'workspace/result.json', json });
    expect(changed.passed).toBe(false);
    expect(changed.sha256).not.toBe(proof.sha256);
    expect(changed.failures).toEqual(['"/summary/ready" does not equal the declared value']);
  });
  it.each([
    { records: [{ id: 'one' }, { id: 'one' }] },
    { records: [{ id: 'one' }, {}] },
    { records: [] },
    { records: [{ id: {} }] }
  ])('refuses missing, repeated or non-scalar IDs and empty coverage: %j', (value) => {
    expect(compareJson(value, { uniqueBy: json.uniqueBy }).failures).toHaveLength(1);
  });
  it('compares types and complete nested objects without coercion', () => {
    expect(
      compareJson({ a: false, b: { one: 1, two: 2 } }, { equals: { '/a': 0, '/b': { one: 1 } } })
        .failures
    ).toHaveLength(2);
    expect(
      compareJson({ a: null, records: [] }, { equals: { '/a': null }, lengths: { '/records': 0 } })
        .failures
    ).toEqual([]);
  });
  it('uses JSON Pointer escapes and only own properties and canonical array indexes', () => {
    const value: unknown = JSON.parse('{"a/b":{"~key":7},"array":[9],"__proto__":{"safe":true}}');
    expect(
      compareJson(value, { equals: { '/a~1b/~0key': 7, '/array/0': 9, '/__proto__/safe': true } })
        .failures
    ).toEqual([]);
    expect(
      compareJson(value, {
        equals: { '/constructor': null, '/array/length': 1, '/array/00': 9, '/absent': null }
      }).failures
    ).toHaveLength(4);
  });
  it.each([
    {},
    { equals: {} },
    { equals: { 'not/a/pointer': true } },
    { equals: { '/bad~2escape': true } },
    { lengths: { '/x': -1 } },
    { other: true }
  ])('refuses vacuous or malformed declarations: %j', (value) => {
    expect(JsonProof.safeParse(value).success).toBe(false);
  });
  it('refuses incomplete, oversized or non-UTF8 evidence', async () => {
    const target = path.join(root, 'workspace/result.json');
    for (const content of ['{"records":', Buffer.from([0xff])]) {
      await writeFile(target, content);
      await expect(proveJson(root, { path: 'workspace/result.json', json })).rejects.toThrow();
    }
    await truncate(target, JSON_PROOF_MAX_BYTES + 1);
    await expect(proveJson(root, { path: 'workspace/result.json', json })).rejects.toThrow(
      /byte read limit/
    );
  });
  it('refuses runtime-private paths and symlink sources', async () => {
    await writeFile(path.join(root, 'private.json'), JSON.stringify(source));
    await symlink(path.join(root, 'private.json'), path.join(root, 'workspace/result.json'));
    await expect(proveJson(root, { path: 'workspace/result.json', json })).rejects.toThrow();
    await expect(proveJson(root, { path: '.athanor/private.json', json })).rejects.toThrow();
    await expect(proveJson(root, { path: '../other/result.json', json })).rejects.toThrow();
  });
});
