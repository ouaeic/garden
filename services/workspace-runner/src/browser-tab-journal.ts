import { createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BrowserRecoveredTab } from '@athanor/contracts';
import { decryptJson, encryptJson, isPublicHttpUrl, type EncryptedEnvelope } from '@athanor/core';

export type RecoverableBrowserTab = z.infer<typeof BrowserRecoveredTab>;
const State = z.object({
  version: z.literal(1),
  tabs: z.array(BrowserRecoveredTab).max(200),
  omitted: z.number().int().nonnegative()
});
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Page addresses are recovery hints, never permission to replay an action or a form. */
export function recoverableTabUrl(value: string): boolean {
  if (value.length > 2000 || !isPublicHttpUrl(value)) return false;
  const url = new URL(value);
  if (url.username || url.password || url.hash) return false;
  return ![...url.searchParams.keys()].some((key) =>
    /(?:token|password|secret|authorization|^code$|^state$|api.?key|signature|^sig$)/i.test(key)
  );
}

export class BrowserTabJournal {
  #writes = new Map<string, Promise<void>>();
  constructor(private readonly secret: string) {}
  #key(root: string) {
    return createHmac('sha256', this.secret)
      .update('browser-tab-recovery\0' + root)
      .digest();
  }
  #path(root: string) {
    return path.join(root, '.athanor', 'browser-tabs', 'state.json');
  }
  async read(root: string): Promise<{ tabs: RecoverableBrowserTab[]; omitted: number }> {
    await this.#writes.get(root);
    let file;
    try {
      file = await open(this.#path(root), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tabs: [], omitted: 0 };
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        throw new Error('Invalid browser recovery store');
      const state = State.parse(
        decryptJson<unknown>(
          JSON.parse(await file.readFile('utf8')) as EncryptedEnvelope,
          this.#key(root),
          'browser-tabs:1'
        )
      );
      const safe = state.tabs.filter((tab) => recoverableTabUrl(tab.url));
      return { tabs: safe, omitted: state.omitted + state.tabs.length - safe.length };
    } finally {
      await file.close();
    }
  }
  save(root: string, tabs: RecoverableBrowserTab[], omitted = 0): Promise<void> {
    const unique = [
      ...new Map(
        tabs.filter((tab) => recoverableTabUrl(tab.url)).map((tab) => [tab.tabId, tab])
      ).values()
    ];
    const state = State.parse({
      version: 1,
      tabs: unique.slice(0, 200),
      omitted: omitted + Math.max(0, unique.length - 200)
    });
    const work = (this.#writes.get(root) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const filename = this.#path(root),
          directory = path.dirname(filename);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await lstat(directory)).isDirectory())
          throw new Error('Invalid browser recovery directory');
        await chmod(directory, 0o700);
        const temporary = path.join(directory, randomUUID() + '.tmp');
        try {
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(
              JSON.stringify(encryptJson(state, this.#key(root), 'browser-tabs:1'))
            );
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, filename);
          const parent = await open(directory, constants.O_RDONLY);
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.#writes.set(root, work);
    void work
      .finally(() => {
        if (this.#writes.get(root) === work) this.#writes.delete(root);
      })
      .catch(() => undefined);
    return work;
  }
}
