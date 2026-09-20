import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  acquireProjectReference,
  ProjectReferences,
  withProjectReference,
  type ProjectReferenceLock
} from './project-reference-lock.js';

const roots: string[] = [];
const held: ProjectReferenceLock[] = [];
afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-project-reference-'));
  roots.push(root);
  const project = randomUUID();
  const directory = path.join(root, '.project-store', project, 'public');
  await mkdir(directory, { recursive: true, mode: 0o755 });
  return { root, project, directory };
}
async function acquire(root: string, project: string, mode: 'read' | 'write') {
  const lock = await acquireProjectReference(root, project, mode);
  held.push(lock);
  return lock;
}

it('keeps readers protected after the acquisition helper exits and until the last reader releases', async () => {
  const { root, project } = await fixture();
  const first = await acquire(root, project, 'read');
  const second = await acquire(root, project, 'read');
  await expect(acquire(root, project, 'write')).rejects.toMatchObject({ status: 409 });
  await first.release();
  await first.release();
  await expect(acquire(root, project, 'write')).rejects.toMatchObject({ status: 409 });
  await second.release();
  const exclusive = await acquire(root, project, 'write');
  await expect(acquire(root, project, 'read')).rejects.toMatchObject({ status: 409 });
  await expect(acquire(root, project, 'write')).rejects.toMatchObject({ status: 409 });
  await exclusive.release();
  await expect(acquire(root, project, 'read')).resolves.toBeDefined();
});

it('releases on an operation failure while another project remains independently writable', async () => {
  const { root, project } = await fixture();
  const other = randomUUID();
  await mkdir(path.join(root, '.project-store', other, 'public'), { recursive: true, mode: 0o755 });
  await acquire(root, project, 'read');
  await expect(
    withProjectReference(root, other, 'write', async () => {
      await expect(acquire(root, other, 'read')).rejects.toMatchObject({ status: 409 });
      throw Error('interrupted operation');
    })
  ).rejects.toThrow('interrupted operation');
  await expect(acquire(root, other, 'write')).resolves.toBeDefined();
  await expect(acquire(root, project, 'write')).rejects.toMatchObject({ status: 409 });
});

it('refuses symlinked and writable public roots instead of locking an unprotected inode', async () => {
  const { root, project, directory } = await fixture();
  await chmod(directory, 0o777);
  await expect(acquire(root, project, 'read')).rejects.toThrow('could not be verified');
  await rm(directory, { recursive: true });
  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(elsewhere, { mode: 0o755 });
  await symlink(elsewhere, directory);
  await expect(acquire(root, project, 'read')).rejects.toThrow();
});

it('overlapping pooled readers retain protection after their originating operation returns', async () => {
  const { root, project } = await fixture();
  const references = new ProjectReferences(root);
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let background: Promise<void> | undefined;
  await references.run(project, async () => {
    background = references.run(project, () => running);
  });
  await expect(acquire(root, project, 'write')).rejects.toMatchObject({ status: 409 });
  finish();
  await background;
  const exclusive = await acquire(root, project, 'write');
  await expect(references.acquire(project)).rejects.toMatchObject({ status: 409 });
  await exclusive.release();
  await references.run(project, async () => undefined);
  await expect(acquire(root, project, 'write')).resolves.toBeDefined();
});
