/**
 * Gives every conversation that predates the encrypted name index one, at boot.
 *
 * Two passes that have to run in this process rather than in a migration: the tokens are keyed
 * with a key derived from the workspace's own, and SQL has neither the key nor the tokenizer.
 * The legacy-title pass is awaited because it is bounded by how many plaintext titles a box has
 * left; the index drain is not, because it walks the whole history oldest first.
 */

import { encryptJson, unwrapDataKey } from '@garden/core';
import type { ServerBase } from '../http/server-context.js';
import { errorFields } from '../log.js';

export const runNameBackfill = async (context: ServerBase): Promise<void> => {
  const { log, store, masterKey, nameIndexFor, openPrompt, openName } = context;
  for (const task of await store.listLegacyTaskTitles()) {
    const workspace = await store.getWorkspaceById(task.workspaceId);
    if (!workspace?.wrappedKey || !task.legacyTitle) continue;
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    await store.setTaskTitleCiphertext(
      task.id,
      encryptJson({ title: task.legacyTitle }, key, `task-title:${workspace.id}`),
      nameIndexFor(task.legacyTitle, openPrompt(task, key), key)
    );
  }

  /**
   * Gives every conversation that predates the name index one.
   *
   * It has to happen in this process rather than in the migration: the tokens are keyed with a key
   * derived from the workspace's own, and SQL has neither the key nor the tokenizer. It drains to
   * empty instead of taking a batch a boot, because the far end of the history is what the index
   * exists to reach and a batch a boot would leave it unfindable for weeks.
   *
   * Measured on this machine, one conversation costs about 0.7ms to read and tokenize, so a box
   * with fifty thousand of them spends the better part of a minute here. That is why the caller
   * does not wait for it, and why every row hands the loop back before the next one starts: the
   * default database on a single box answers in this process, so awaiting a query is not a yield -
   * it settles a promise and the continuation runs as a microtask, ahead of every timer and every
   * socket. Without a real yield the whole drain runs as one uninterrupted cascade, and the boot it
   * runs on has no server on it until the last row is written. `setImmediate` is the yield: it
   * costs a loop turn a row and it bounds how long the box is busy at one row rather than at all
   * of them. The rows arrive oldest first, which is the half a bounded decrypt window could never
   * see.
   *
   * A conversation this server cannot read is written as an empty vector rather than skipped -
   * whether the workspace key is gone or that one row's envelope will not open. It is unreadable
   * either way, and the alternative is a row that stays NULL and is read again on every boot for
   * the life of the box. What must not happen is the third thing: one such row ending the drain,
   * which on an oldest-first pass leaves every conversation newer than it unindexed for good.
   */
  const backfillConversationNames = async (): Promise<number> => {
    const dataKeys = new Map<string, Buffer | null>();
    const handBack = () => new Promise<void>((resolve) => setImmediate(resolve));
    let written = 0;
    for (;;) {
      await handBack();
      const batch = await store.listTasksMissingNameIndex();
      if (batch.length === 0) return written;
      for (const task of batch) {
        await handBack();
        if (!dataKeys.has(task.workspaceId)) {
          const workspace = await store.getWorkspaceById(task.workspaceId);
          dataKeys.set(
            task.workspaceId,
            workspace?.wrappedKey
              ? unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id)
              : null
          );
        }
        const key = dataKeys.get(task.workspaceId) ?? null;
        const index = key
          ? nameIndexFor(openName(task, key), openPrompt(task, key), key)
          : { nameTokens: '', openingTokens: '' };
        await store.setTaskNameIndex(task.id, index);
        written += 1;
      }
    }
  };
  void backfillConversationNames().then(
    (written) => {
      if (written) log.info('search.names_backfilled', { count: written });
    },
    (error: unknown) => log.error('search.names_backfill_failed', errorFields(error))
  );
  await store.scrubLegacyContentSummaries();
};
