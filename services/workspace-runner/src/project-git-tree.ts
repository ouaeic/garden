import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GitObjectId } from '@athanor/contracts';
import { assertHostStorageWrite } from './host-storage.js';
import {
  durableJson,
  projectPath,
  type ProjectVersionFiles,
  type VersionTree
} from './project-version-files.js';
import { projectGitCommand as command } from './project-git-command.js';

const quotedPath = (filename: string) =>
  '"' +
  [...Buffer.from(filename)]
    .map((byte) =>
      byte >= 32 && byte < 127 && ![34, 92].includes(byte)
        ? String.fromCharCode(byte)
        : '\\' + byte.toString(8).padStart(3, '0')
    )
    .join('') +
  '"';

/** One streaming Git import per tree; content hashes reuse objects without rereading unchanged bodies. */
export async function projectGitTree(
  directory: string,
  store: ProjectVersionFiles,
  prefix: string,
  files: VersionTree,
  progress: (files: number, bytes: number) => Promise<void>
): Promise<string> {
  const git = path.join(directory, 'repository.git');
  const cache = new Map<string, Record<string, string>>();
  const changed = new Set<string>();
  const marks = new Map<string, number>();
  const entries: Array<{ filename: string; mode: string; object: string }> = [];
  const operation = randomUUID(),
    scratch = `refs/garden/trees/${operation}`;
  const marksFile = path.join(directory, `${operation}.marks`);
  let commitMark = 0;
  let completed = 0,
    bytes = 0,
    observed = 0;
  const streams = async function* () {
    for (const [filename, fact] of Object.entries(files)) {
      if (prefix && !filename.startsWith(prefix + '/')) continue;
      const relative = prefix ? filename.slice(prefix.length + 1) : filename;
      if (!relative || projectPath(`workspace/${relative}`) !== relative)
        throw Error('Invalid repository source path');
      const bucket = fact.sha256.slice(0, 2);
      let values = cache.get(bucket);
      if (!values) {
        try {
          values = JSON.parse(
            await readFile(path.join(directory, 'object-cache', bucket + '.json'), 'utf8')
          ) as Record<string, string>;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          values = {};
        }
        cache.set(bucket, values);
      }
      let reference = values[fact.sha256] ? GitObjectId.parse(values[fact.sha256]) : undefined;
      if (!reference) {
        let mark = marks.get(fact.sha256);
        if (!mark) {
          mark = marks.size + 1;
          marks.set(fact.sha256, mark);
          changed.add(bucket);
          await assertHostStorageWrite(directory, fact.bytes + 4096);
          yield `blob\nmark :${mark}\ndata ${fact.bytes}\n`;
          const handle = await open(store.object(fact), constants.O_RDONLY | constants.O_NOFOLLOW);
          const hash = createHash('sha256');
          let size = 0;
          try {
            const chunks: AsyncIterable<unknown> = handle.createReadStream({ autoClose: false });
            for await (const chunk of chunks) {
              if (!Buffer.isBuffer(chunk)) throw Error('Invalid source content bytes');
              size += chunk.length;
              hash.update(chunk);
              yield chunk;
            }
          } finally {
            await handle.close();
          }
          if (size !== fact.bytes || hash.digest('hex') !== fact.sha256)
            throw Error('Published source content changed while Git captured it');
          yield '\n';
        }
        reference = `:${mark}`;
      }
      entries.push({
        filename: relative,
        mode: fact.executable ? '100755' : '100644',
        object: reference
      });
      completed++;
      bytes += fact.bytes;
      if (Date.now() - observed >= 1000) {
        await progress(completed, bytes);
        observed = Date.now();
      }
    }
    commitMark = marks.size + 1;
    yield `commit ${scratch}\nmark :${commitMark}\ncommitter Garden <garden@localhost> 0 +0000\ndata 9\nSnapshot\n\ndeleteall\n`;
    for (const entry of entries)
      yield `M ${entry.mode} ${entry.object} ${quotedPath(entry.filename)}\n`;
    yield `\nget-mark :${commitMark}\ndone\n`;
  };
  let commit: string | undefined;
  try {
    commit = GitObjectId.parse(
      (
        await command(
          git,
          ['fast-import', '--quiet', '--done', `--export-marks=${marksFile}`],
          Readable.from(streams())
        )
      ).trim()
    );
    const objects = new Map<number, string>();
    const handle = await open(marksFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      for await (const line of handle.readLines({ autoClose: false })) {
        const match = /^:([0-9]+) ([a-f0-9]+)$/.exec(line);
        if (!match) throw Error('Invalid Git object receipt');
        objects.set(Number(match[1]), GitObjectId.parse(match[2]));
      }
    } finally {
      await handle.close();
    }
    if (objects.get(commitMark) !== commit) throw Error('Git tree receipt changed');
    for (const [sha256, mark] of marks) {
      const object = objects.get(mark);
      if (!object) throw Error('Missing Git object receipt');
      cache.get(sha256.slice(0, 2))![sha256] = object;
    }
    for (const bucket of changed)
      await durableJson(path.join(directory, 'object-cache', bucket + '.json'), cache.get(bucket));
    const tree = GitObjectId.parse(
      (await command(git, ['rev-parse', '--verify', `${commit}^{tree}`])).trim()
    );
    await progress(completed, bytes);
    return tree;
  } finally {
    await command(git, [
      'update-ref',
      '--no-deref',
      '-d',
      scratch,
      ...(commit ? [commit] : [])
    ]).catch(() => undefined);
    await rm(marksFile, { force: true });
  }
}
