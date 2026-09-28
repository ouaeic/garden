import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertUserDataPath, readWorkspaceFile, writeWorkspaceFile } from './files.js';
import { assertHostStorageWrite, hostStorage } from './host-storage.js';
import { durableJson } from './project-version-files.js';

const LIMIT = 1024 * 1024;
const File = z.object({
  path: z.string(),
  before: z.string().regex(/^[a-f0-9]{64}$/),
  after: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().max(LIMIT),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(['pending', 'intent', 'applied', 'failed', 'uncertain']),
  reason: z.string().optional()
});
const Record = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  owner: z.string(),
  project: z.string(),
  createdAt: z.number(),
  state: z.enum(['preview', 'applying', 'finished']),
  files: z.array(File).min(1).max(32)
});
type Preview = z.infer<typeof Record>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const locks = new Map<string, Promise<unknown>>();
const directory = (root: string) => path.join(root, '.garden', 'code-edits');

async function save(root: string, record: Preview) {
  const target = path.join(directory(root), `${record.id}.json`);
  const stored =
    record.state === 'finished'
      ? { ...record, files: record.files.map((file) => ({ ...file, content: '' })) }
      : record;
  await durableJson(target, stored);
}

/** A small opaque handle avoids regenerating the source or trusting model-retyped ranges. */
export async function saveCodeEditPreview(
  root: string,
  owner: string,
  project: string,
  files: Array<{ path: string; sha256: string; content: string }>
): Promise<string> {
  const record = Record.parse({
    version: 1,
    id: randomUUID(),
    owner,
    project,
    createdAt: Date.now(),
    state: 'preview',
    files: files.map((file) => ({
      path: assertUserDataPath(root, file.path),
      before: file.sha256,
      after: hash(file.content),
      content: file.content,
      sizeBytes: Buffer.byteLength(file.content),
      status: 'pending'
    }))
  });
  if (new Set(record.files.map((file) => file.path)).size !== record.files.length)
    throw new Error('Code preview contains duplicate files');
  if (record.files.some((file) => file.sizeBytes > LIMIT))
    throw new Error('A code edit exceeds the source file size limit');
  if (record.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > 8 * LIMIT)
    throw new Error('Code preview exceeds its source budget; narrow the change');
  await mkdir(directory(root), { recursive: true, mode: 0o700 });
  const names = (await readdir(directory(root))).filter((name) =>
    /^[a-f0-9-]{36}\.json$/.test(name)
  );
  const retained: Array<{ name: string; record: Preview; bytes: number }> = [];
  for (const name of names) {
    const old = Record.parse(JSON.parse(await readFile(path.join(directory(root), name), 'utf8')));
    if (old.state !== 'applying' && Date.now() - old.createdAt > 24 * 60 * 60_000)
      await rm(path.join(directory(root), name), { force: true });
    else retained.push({ name, record: old, bytes: Buffer.byteLength(JSON.stringify(old)) });
  }
  let retainedBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0);
  let retainedCount = retained.filter((entry) => entry.record.state === 'preview').length;
  const bytes = Buffer.byteLength(JSON.stringify(record));
  for (const entry of retained.sort((a, b) => a.record.createdAt - b.record.createdAt)) {
    if (retainedCount < 128 && retainedBytes + bytes < 32 * LIMIT) break;
    if (entry.record.state !== 'preview') continue;
    await rm(path.join(directory(root), entry.name), { force: true });
    retainedBytes -= entry.bytes;
    retainedCount--;
  }
  if (retainedCount >= 128 || retainedBytes + bytes >= 32 * LIMIT)
    throw new Error(
      'Code preview storage is full of retained receipts; try again after their retention window'
    );
  await assertHostStorageWrite(root, bytes, hostStorage);
  await save(root, record);
  return record.id;
}

export async function applyCodeEditPreview(
  root: string,
  owner: string,
  project: string,
  id: string,
  paths: string[]
) {
  z.string().uuid().parse(id);
  const key = path.join(directory(root), `${id}.json`);
  const previous = locks.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const record = Record.parse(JSON.parse(await readFile(key, 'utf8')));
      if (record.owner !== owner || record.project !== project)
        throw new Error('Code preview belongs to a different task or project');
      const requested = paths.map((file) => assertUserDataPath(root, file)).sort();
      if (
        JSON.stringify(requested) !== JSON.stringify(record.files.map((file) => file.path).sort())
      )
        throw new Error('Approved paths do not match this code preview');
      const receipt = () => ({
        previewId: id,
        applied: record.files.every((file) => file.status === 'applied'),
        files: record.files.map(({ path, before, after, status, reason, sizeBytes }) => ({
          path,
          before,
          after,
          status: status === 'pending' ? 'not_applied' : status,
          reason,
          sizeBytes
        }))
      });
      if (record.state === 'finished') return receipt();
      if (record.state === 'preview' && Date.now() - record.createdAt > 30 * 60_000)
        throw new Error('Code preview expired; request a fresh preview');
      // Check the whole set before the first mutation. Each write checks its hash again.
      for (const file of record.files) {
        if (hash(file.content) !== file.after)
          throw new Error('Code preview integrity check failed');
        const live = await readWorkspaceFile(root, file.path, LIMIT).catch(() => null);
        if (!live) {
          file.status = 'uncertain';
          file.reason = 'Source could not be inspected. No further files were written.';
          record.state = 'finished';
          await save(root, record);
          return receipt();
        }
        if (file.status === 'applied' || file.status === 'intent') {
          if (live.sha256 === file.after) {
            file.status = 'applied';
            continue;
          }
        }
        if (live.sha256 !== file.before) {
          file.status = 'failed';
          file.reason = 'Source changed after the preview. Request a fresh preview.';
          record.state = 'finished';
          await save(root, record);
          return receipt();
        }
      }
      record.state = 'applying';
      await save(root, record);
      for (const file of record.files) {
        if (file.status === 'applied') continue;
        file.status = 'intent';
        await save(root, record);
        try {
          await assertHostStorageWrite(root, Buffer.byteLength(file.content), hostStorage);
          await writeWorkspaceFile(root, file.path, Buffer.from(file.content), LIMIT, file.before);
          file.status = 'applied';
        } catch (cause) {
          const observed = await readWorkspaceFile(root, file.path, LIMIT).catch(() => null);
          file.status =
            observed?.sha256 === file.after
              ? 'applied'
              : observed?.sha256 === file.before
                ? 'failed'
                : 'uncertain';
          file.reason =
            cause instanceof Error ? cause.message : 'Write did not acknowledge completion';
          if (file.status !== 'applied') break;
        }
        await save(root, record);
      }
      record.state = 'finished';
      await save(root, record);
      return receipt();
    });
  locks.set(key, operation);
  try {
    return await operation;
  } finally {
    if (locks.get(key) === operation) locks.delete(key);
  }
}
