import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, type BigIntStats } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  type FileHandle
} from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFileVersion } from '@athanor/contracts';
import { assertUserDataPath, withWorkspaceDirectory } from './files.js';
import { openDownloadFile } from './file-downloads.js';
import { assertHostStorageWrite, hostStorage, type HostStorage } from './host-storage.js';

export type VersionTree = Record<string, ProjectFileVersion>;
const excluded = (name: string) =>
  [
    '.git',
    '.athanor',
    '.garden',
    '.home',
    'node_modules',
    '.venv',
    '__pycache__',
    '.npmrc',
    '.pypirc',
    '.netrc'
  ].includes(name) ||
  (name.startsWith('.env') && !['.env.example', '.env.sample', '.env.template'].includes(name));
export const projectPath = (value: string): string => {
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    value.split('/').includes('..')
  )
    throw new Error('Use a relative project path');
  const result = assertUserDataPath('/project', value);
  if (result !== 'workspace' && !result.startsWith('workspace/'))
    throw new Error('Choose project source files');
  const relative = result === 'workspace' ? '' : result.slice('workspace/'.length);
  if (relative.split('/').some(excluded))
    throw new Error('Credentials and runtime state cannot be included in a project update');
  return relative;
};
export const sameFile = (a?: ProjectFileVersion | null, b?: ProjectFileVersion | null): boolean =>
  (a?.sha256 ?? null) === (b?.sha256 ?? null) &&
  (a?.executable ?? false) === (b?.executable ?? false);
export const treeDigest = (tree: VersionTree): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(tree)
          .sort()
          .map((name) => [name, tree[name]])
      )
    )
    .digest('hex');
const unchanged = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode;

export async function syncDirectory(target: string): Promise<void> {
  const directory = await open(
    target,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function durableMkdir(target: string, mode: number): Promise<void> {
  const created = await mkdir(target, { recursive: true, mode });
  if (!created) return;
  for (let folder = target; ; folder = path.dirname(folder)) {
    await syncDirectory(folder);
    if (folder === path.dirname(created)) break;
  }
}

export async function durableJson(filename: string, value: unknown): Promise<void> {
  await durableMkdir(path.dirname(filename), 0o700);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
    const directory = await open(
      path.dirname(filename),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Immutable blobs are streamed; the bounds on a rendered diff never limit a dataset. */
export class ProjectVersionFiles {
  constructor(
    readonly directory: string,
    readonly storage: (root: string) => Promise<HostStorage> = hostStorage
  ) {}
  object(fact: ProjectFileVersion): string {
    if (!/^[a-f0-9]{64}$/.test(fact.sha256)) throw new Error('Invalid version content identity');
    return path.join(this.directory, 'objects', `${fact.sha256}.${fact.executable ? 'x' : 'r'}`);
  }
  async lineChanges(base: ProjectFileVersion | null, proposed: ProjectFileVersion | null) {
    // Measurement is bounded independently of the datasets this workspace can store or process.
    if ((base?.bytes ?? 0) + (proposed?.bytes ?? 0) > 2 * 1024 * 1024) return null;
    const args = [
      '-c',
      'core.hooksPath=/dev/null',
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '--',
      base ? this.object(base) : '/dev/null',
      proposed ? this.object(proposed) : '/dev/null'
    ];
    let output: string;
    try {
      output = (
        await promisify(execFile)('/usr/bin/git', args, {
          timeout: 3000,
          maxBuffer: 8192,
          env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
        })
      ).stdout;
    } catch (error) {
      const result = error as { code?: number; stdout?: string };
      if (result.code !== 1 || typeof result.stdout !== 'string') return null;
      output = result.stdout;
    }
    if (!output) return { added: 0, removed: 0 };
    const match = /^(\d+)\t(\d+)\t/.exec(output);
    return match ? { added: Number(match[1]), removed: Number(match[2]) } : null;
  }
  async copy(
    fact: ProjectFileVersion,
    destination: string,
    active: () => void = () => undefined,
    progress: (bytes: number) => void = () => undefined
  ): Promise<void> {
    active();
    let copied = 0;
    await assertHostStorageWrite(path.dirname(destination), 0, this.storage);
    try {
      await copyFile(
        this.object(fact),
        destination,
        constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL
      );
    } catch (error) {
      if (
        !['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      )
        throw error;
      await assertHostStorageWrite(path.dirname(destination), fact.bytes, this.storage);
      const output = await open(destination, 'wx', 0o600);
      let source: FileHandle | undefined;
      let lastProbe = Date.now();
      try {
        source = await open(this.object(fact), constants.O_RDONLY | constants.O_NOFOLLOW);
        for await (const chunk of source.createReadStream({ autoClose: false })) {
          active();
          if (Date.now() - lastProbe > 2000) {
            await assertHostStorageWrite(path.dirname(destination), 0, this.storage);
            lastProbe = Date.now();
          }
          const buffer = chunk as Buffer;
          let offset = 0;
          while (offset < buffer.length)
            offset += (await output.write(buffer, offset)).bytesWritten;
          copied += buffer.length;
          progress(copied);
        }
        await output.sync();
      } finally {
        await source?.close();
        await output.close();
      }
    }
    progress(fact.bytes);
    await chmod(destination, fact.executable ? 0o770 : 0o660);
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async put(content: Buffer, executable = false): Promise<ProjectFileVersion> {
    const fact = {
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
      executable
    };
    await durableMkdir(path.join(this.directory, 'objects'), 0o700);
    await assertHostStorageWrite(this.directory, content.length, this.storage);
    const temporary = path.join(this.directory, 'objects', `.capture-${randomUUID()}`);
    const file = await open(temporary, 'wx', fact.executable ? 0o555 : 0o444);
    try {
      await file.writeFile(content);
      await file.sync();
      await file.close();
      await link(temporary, this.object(fact)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await syncDirectory(path.dirname(this.object(fact)));
    } finally {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
    return fact;
  }
  async read(fact: ProjectFileVersion, maximum = 512 * 1024): Promise<Buffer | null> {
    if (fact.bytes > maximum) return null;
    const bytes = await readFile(this.object(fact));
    if (
      bytes.length !== fact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== fact.sha256
    )
      throw new Error('Stored project content failed its integrity check');
    return bytes;
  }
  async capture(
    root: string,
    selections: string[],
    progress: (files: number, bytes: number) => void,
    active: () => void
  ): Promise<VersionTree> {
    const tree: VersionTree = {};
    const visited = new Set<string>();
    const observed: Array<{ relative: string; stat: BigIntStats }> = [];
    let bytes = 0,
      count = 0;
    await durableMkdir(path.join(this.directory, 'objects'), 0o700);
    const captureFile = async (relative: string) => {
      const source = await openDownloadFile(root, `workspace/${relative}`);
      const temporary = path.join(this.directory, 'objects', `.capture-${randomUUID()}`);
      let output: FileHandle | undefined;
      try {
        const before = await source.handle.stat({ bigint: true });
        const hash = createHash('sha256');
        for await (const raw of source.handle.createReadStream({ autoClose: false, start: 0 })) {
          active();
          const chunk = raw as Buffer;
          hash.update(chunk);
          bytes += chunk.length;
          progress(count, bytes);
        }
        if (!unchanged(before, await source.handle.stat({ bigint: true })))
          throw new Error(`Source changed while preparing: ${relative}`);
        const fact = {
          sha256: hash.digest('hex'),
          bytes: Number(before.size),
          executable: Boolean(before.mode & 0o111n)
        };
        const existing = await lstat(this.object(fact)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existing && (!existing.isFile() || existing.size !== fact.bytes))
          throw new Error('Stored project content is damaged');
        if (!existing) {
          await assertHostStorageWrite(this.directory, fact.bytes, this.storage);
          output = await open(temporary, 'wx', 0o400);
          const copiedHash = createHash('sha256');
          let copied = 0,
            lastProbe = Date.now();
          for await (const raw of source.handle.createReadStream({ autoClose: false, start: 0 })) {
            active();
            const chunk = raw as Buffer;
            copiedHash.update(chunk);
            copied += chunk.length;
            if (Date.now() - lastProbe > 2000) {
              await assertHostStorageWrite(this.directory, 0, this.storage);
              lastProbe = Date.now();
            }
            let offset = 0;
            while (offset < chunk.length)
              offset += (await output.write(chunk, offset)).bytesWritten;
          }
          if (
            copiedHash.digest('hex') !== fact.sha256 ||
            copied !== fact.bytes ||
            !unchanged(before, await source.handle.stat({ bigint: true }))
          )
            throw new Error(`Source changed while preparing: ${relative}`);
          await output.chmod(fact.executable ? 0o555 : 0o444);
          await output.sync();
          await output.close();
          output = undefined;
          await link(temporary, this.object(fact)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
          await syncDirectory(path.dirname(this.object(fact)));
        }
        tree[relative] = fact;
        observed.push({ relative: `workspace/${relative}`, stat: before });
        count++;
        progress(count, bytes);
      } finally {
        await output?.close();
        await source.handle.close();
        await rm(temporary, { force: true });
      }
    };
    const visit = async (relative: string, depth: number): Promise<void> => {
      active();
      if (visited.has(relative)) return;
      visited.add(relative);
      if (depth > 128) throw new Error('Project directory nesting is too deep');
      const target = path.join(root, 'workspace', relative);
      const stat = await lstat(target, { bigint: true });
      if (stat.isSymbolicLink())
        throw new Error(`Project updates cannot follow symlinks: ${relative}`);
      if (stat.isFile()) {
        await captureFile(relative);
        return;
      }
      if (!stat.isDirectory())
        throw new Error(`Project updates require regular files: ${relative}`);
      observed.push({ relative: path.posix.join('workspace', relative), stat });
      await withWorkspaceDirectory(
        root,
        path.posix.join('workspace', relative),
        false,
        async (anchored) => {
          const directory = await opendir(anchored);
          for await (const entry of directory)
            if (!excluded(entry.name))
              await visit(path.posix.join(relative, entry.name), depth + 1);
        }
      );
    };
    for (const selection of selections) await visit(projectPath(selection), 0);
    // All final observations happen after the last file was captured, so a set assembled across
    // changing sources cannot be mistaken for one coherent input version.
    for (const entry of observed) {
      active();
      if (!unchanged(entry.stat, await lstat(path.join(root, entry.relative), { bigint: true })))
        throw new Error(`Source changed while preparing: ${entry.relative}`);
    }
    return tree;
  }
  async materialize(
    tree: VersionTree,
    target: string,
    writable: boolean,
    active: () => void = () => undefined,
    progress: (files: number, bytes: number) => void = () => undefined
  ): Promise<void> {
    await durableMkdir(target, writable ? 0o770 : 0o755);
    const directories = new Set([target]);
    let completedFiles = 0,
      completedBytes = 0;
    for (const relative of Object.keys(tree).sort()) {
      active();
      if (projectPath(`workspace/${relative}`) !== relative || !relative)
        throw new Error('Invalid project version path');
      const fact = tree[relative]!;
      const filename = path.join(target, relative);
      await mkdir(path.dirname(filename), { recursive: true, mode: writable ? 0o770 : 0o755 });
      for (
        let folder = path.dirname(filename);
        folder.startsWith(target);
        folder = path.dirname(folder)
      )
        directories.add(folder);
      if (writable) {
        await this.copy(fact, filename, active, (bytes) =>
          progress(completedFiles, completedBytes + bytes)
        );
      } else {
        // Only protected immutable objects are linked. No writable working copy shares their inode.
        await link(this.object(fact), filename);
      }
      completedFiles++;
      completedBytes += fact.bytes;
      progress(completedFiles, completedBytes);
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length))
      await syncDirectory(directory);
  }
  async matches(
    root: string,
    tree: VersionTree,
    active: () => void = () => undefined
  ): Promise<boolean> {
    for (const [relative, fact] of Object.entries(tree)) {
      let file: Awaited<ReturnType<typeof openDownloadFile>>;
      try {
        file = await openDownloadFile(root, `workspace/${relative}`);
      } catch {
        return false;
      }
      try {
        if (file.stat.size !== fact.bytes || Boolean(file.stat.mode & 0o111) !== fact.executable)
          return false;
        const hash = createHash('sha256');
        for await (const chunk of file.handle.createReadStream({ autoClose: false })) {
          active();
          hash.update(chunk as Buffer);
        }
        if (hash.digest('hex') !== fact.sha256) return false;
      } finally {
        await file.handle.close();
      }
    }
    return true;
  }
  async merge(
    base: ProjectFileVersion,
    current: ProjectFileVersion,
    proposed: ProjectFileVersion
  ): Promise<ProjectFileVersion | null> {
    const buffers = await Promise.all([this.read(base), this.read(current), this.read(proposed)]);
    if (
      buffers.some(
        (bytes) => !bytes || bytes.includes(0) || bytes.toString('utf8').includes('\ufffd')
      )
    )
      return null;
    if (
      current.executable !== base.executable &&
      proposed.executable !== base.executable &&
      current.executable !== proposed.executable
    )
      return null;
    const mergeRoot = path.join(this.directory, `merge-${randomUUID()}`);
    await mkdir(mergeRoot, { mode: 0o700 });
    try {
      const names = ['base', 'current', 'proposed'];
      for (let i = 0; i < names.length; i++) {
        const handle = await open(path.join(mergeRoot, names[i]!), 'wx', 0o600);
        try {
          await handle.writeFile(buffers[i]!);
        } finally {
          await handle.close();
        }
      }
      const merged = await new Promise<Buffer | null>((resolve, reject) => {
        const child = spawn(
          '/usr/bin/git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            'merge-file',
            '-p',
            '--diff3',
            '--',
            'current',
            'base',
            'proposed'
          ],
          {
            cwd: mergeRoot,
            env: {
              PATH: '/usr/bin:/bin',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_TERMINAL_PROMPT: '0'
            },
            stdio: ['ignore', 'pipe', 'pipe']
          }
        );
        const chunks: Buffer[] = [];
        let size = 0;
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 2 * 1024 * 1024) chunks.push(chunk);
          else child.kill('SIGKILL');
        });
        child.stderr.resume();
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? Buffer.concat(chunks) : null);
        });
      });
      return merged
        ? this.put(
            merged,
            proposed.executable === base.executable ? current.executable : proposed.executable
          )
        : null;
    } finally {
      await rm(mergeRoot, { recursive: true, force: true });
    }
  }
}
