import path from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';
import { z } from 'zod';
import { ProjectGitExport, ProjectGitExportInput } from '@athanor/contracts';
import type { ProjectGit } from './project-git.js';
import { durableJson, syncDirectory } from './project-version-files.js';
import { acquireDirectoryReference } from './project-reference-lock.js';

/** Export work continues across browser disconnects; a receipt names one immutable branch tip. */
export class ProjectGitExports {
  readonly locks = new Map<string, Promise<unknown>>();
  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pending = this.locks.get(id) ?? Promise.resolve();
    const next = pending.catch(() => undefined).then(action);
    this.locks.set(id, next);
    void next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => undefined);
    return next;
  }
  readonly running = new Map<string, Promise<void>>();
  constructor(
    readonly root: string,
    readonly directory: string,
    readonly git: ProjectGit
  ) {}
  private location(id: string) {
    return path.join(this.directory, z.uuid().parse(id));
  }
  private async read(id: string): Promise<ProjectGitExport | null> {
    try {
      return ProjectGitExport.parse(
        JSON.parse(await readFile(path.join(this.location(id), 'receipt.json'), 'utf8'))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async list(): Promise<ProjectGitExport[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records: ProjectGitExport[] = [];
    for (const name of names.sort())
      if (z.uuid().safeParse(name).success) {
        const value = await this.read(name);
        if (value) records.push(value);
      }
    return records;
  }
  private launch(receipt: ProjectGitExport) {
    if (this.running.has(receipt.requestId)) return;
    const run = (async () => {
      try {
        receipt.bytes = await this.git.exportBundle(
          receipt.repositoryId,
          receipt.commit,
          this.location(receipt.requestId)
        );
        receipt.state = 'ready';
        receipt.detail = null;
      } catch (error) {
        receipt.state = 'failed';
        receipt.detail = String(error);
      }
      await durableJson(path.join(this.location(receipt.requestId), 'receipt.json'), receipt);
    })();
    this.running.set(receipt.requestId, run);
    void run.finally(() => this.running.delete(receipt.requestId)).catch(() => undefined);
  }
  async start(repositoryId: string, raw: unknown): Promise<ProjectGitExport> {
    const input = ProjectGitExportInput.parse(raw);
    return this.locked(input.requestId, async () => {
      const existing = await this.read(input.requestId);
      if (existing && (existing.repositoryId !== repositoryId || existing.commit !== input.commit))
        throw Error('Export request identity changed');
      if (existing?.state === 'ready' || this.running.has(input.requestId)) return existing!;
      await this.git.get(repositoryId);
      const receipt: ProjectGitExport = existing ?? {
        ...input,
        repositoryId,
        state: 'preparing',
        createdAt: new Date().toISOString(),
        bytes: 0,
        detail: null
      };
      receipt.state = 'preparing';
      receipt.detail = null;
      await durableJson(path.join(this.location(input.requestId), 'receipt.json'), receipt);
      this.launch(receipt);
      return structuredClone(receipt);
    });
  }
  async restore() {
    for (const receipt of await this.list())
      if (receipt.state === 'preparing') this.launch(receipt);
  }
  async open(id: string) {
    const directory = this.location(id);
    const held = await acquireDirectoryReference(this.root, directory, 'read');
    try {
      if ((await this.read(id))?.state !== 'ready') throw Error('Repository export is not ready');
      return { root: directory, release: () => held.release() };
    } catch (error) {
      await held.release();
      throw error;
    }
  }
  async remove(id: string) {
    return this.locked(z.uuid().parse(id), async () => {
      if (this.running.has(id))
        throw Error('Wait for the export to finish before removing its download');
      const directory = this.location(id);
      const receipt = await this.read(id);
      if (!receipt) return;
      if (receipt.state === 'preparing') throw Error('This export is still being recovered');
      const held = await acquireDirectoryReference(
        this.root,
        directory,
        'write',
        'This export is being downloaded. Retry after the download finishes.'
      );
      try {
        await rm(directory, { recursive: true });
        await syncDirectory(this.directory);
      } finally {
        await held.release();
      }
    });
  }
  async close() {
    await Promise.allSettled(this.running.values());
  }
}
