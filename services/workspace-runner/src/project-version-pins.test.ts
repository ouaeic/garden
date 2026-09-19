import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectVersionPins } from './project-version-pins.js';

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-pins-'));
  roots.push(root);
  return { root, pins: new ProjectVersionPins(path.join(root, 'pins')) };
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('durable project-version pins', () => {
  it('survives restart, preserves creation identity on relabel and removes only the pin', async () => {
    const { root, pins } = await fixture();
    const id = randomUUID();
    await writeFile(path.join(root, 'result.txt'), 'immutable scientific result');
    expect(await pins.get(7, id)).toBeNull();
    const first = await pins.set(7, id, '  Manuscript α  ');
    expect(first?.label).toBe('Manuscript α');
    const restored = new ProjectVersionPins(path.join(root, 'pins'));
    expect(await restored.get(7, id)).toEqual(first);
    expect(await restored.set(7, id, 'Accepted analysis')).toEqual({
      ...first,
      label: 'Accepted analysis'
    });
    await restored.set(7, id, null);
    await restored.set(7, id, null);
    expect(await pins.get(7, id)).toBeNull();
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe(
      'immutable scientific result'
    );
  });

  it('pages in version order without losing the boundary after a pin is removed', async () => {
    const { root, pins } = await fixture();
    const identities = Array.from({ length: 45 }, () => randomUUID());
    expect(identities).toHaveLength(45);
    for (const [index, id] of identities.entries()) await pins.set(index + 1, id, '');
    const first = await pins.page();
    expect(first.pins).toHaveLength(40);
    expect(first.pins.map((pin) => pin.number)).toEqual(
      Array.from({ length: 40 }, (_, index) => 45 - index)
    );
    expect(first.nextCursor).not.toBeNull();
    const boundary = first.pins.at(-1)!;
    await pins.set(boundary.number, boundary.revisionId, null);
    const second = await pins.page(first.nextCursor!);
    expect(second.pins.map((pin) => pin.number)).toEqual([5, 4, 3, 2, 1]);
    expect(second.nextCursor).toBeNull();
    await writeFile(path.join(root, 'pins', 'interrupted.json.random.tmp'), 'partial');
    expect((await pins.page(first.nextCursor!)).pins).toHaveLength(5);
    await expect(pins.page('../pins')).rejects.toThrow();
  });

  it('refuses damaged, oversized and redirected pin metadata instead of treating it as unpinned', async () => {
    const { root, pins } = await fixture();
    const id = randomUUID();
    await pins.set(1, id, 'Keep');
    const names = await readdir(path.join(root, 'pins'));
    expect(names).toHaveLength(1);
    const file = path.join(root, 'pins', names[0]!);
    const original = await readFile(file, 'utf8');
    await writeFile(file, '{broken');
    await expect(pins.get(1, id)).rejects.toThrow();
    await expect(pins.set(1, id, null)).rejects.toThrow();
    await writeFile(file, JSON.stringify({ ...JSON.parse(original), revisionId: randomUUID() }));
    await expect(pins.get(1, id)).rejects.toThrow('identity');
    await writeFile(file, ' '.repeat(4097));
    await expect(pins.get(1, id)).rejects.toThrow('invalid');
    await rm(file);
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, original);
    await symlink(outside, file);
    await expect(pins.get(1, id)).rejects.toThrow();
    await expect(pins.set(1, id, 'Replace')).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe(original);
  });

  it('keeps unrelated pin writes independent and rejects invalid identities or labels', async () => {
    const { pins } = await fixture();
    const ids = Array.from({ length: 12 }, () => randomUUID());
    expect(ids.length).toBeGreaterThan(0);
    await Promise.all(ids.map((id, index) => pins.set(index + 1, id, `Version ${index + 1}`)));
    expect((await pins.page()).pins).toHaveLength(12);
    await expect(pins.set(1, '../other', '')).rejects.toThrow();
    await expect(pins.set(0, randomUUID(), '')).rejects.toThrow();
    await expect(pins.set(1, randomUUID(), 'x'.repeat(121))).rejects.toThrow();
  });
});
