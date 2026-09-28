import { BrowserActionReceipt } from '@garden/contracts';
import { createHmac } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptJson, encryptJson, type EncryptedEnvelope } from '@garden/core';
import { z } from 'zod';

const Identity = z.string().regex(/^[a-f0-9]{64}$/);
export interface BrowserActionProgress {
  begin(index: number, type: string): void;
  complete(index: number): void;
}

/** Intent is committed before dispatch. An incomplete receipt never authorizes a retry. */
export class BrowserActionJournal {
  readonly #active = new Map<string, { digest: string; work: Promise<unknown> }>();
  constructor(private readonly secret: string) {}

  async #open(root: string) {
    const directory = path.join(root, '.garden', 'browser-actions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Invalid browser receipt directory');
    const filename = path.join(directory, 'receipts.sqlite');
    const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing && !existing.isFile()) throw new Error('Invalid browser receipt store');
    const db = new DatabaseSync(filename);
    try {
      await chmod(filename, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      db.exec(
        'CREATE TABLE IF NOT EXISTS receipts (owner TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner,id))'
      );
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  #key(root: string) {
    return createHmac('sha256', this.secret)
      .update('browser-action-receipts\0' + root)
      .digest();
  }
  #read(db: DatabaseSync, root: string, owner: string, id: string) {
    const row = db
      .prepare('SELECT digest,value FROM receipts WHERE owner=? AND id=?')
      .get(owner, id) as { digest: string; value: string } | undefined;
    if (!row) return null;
    return {
      digest: row.digest,
      receipt: BrowserActionReceipt.parse(
        decryptJson<unknown>(
          JSON.parse(row.value) as EncryptedEnvelope,
          this.#key(root),
          `${owner}:${id}`
        )
      )
    };
  }
  #save(
    db: DatabaseSync,
    root: string,
    owner: string,
    receipt: BrowserActionReceipt,
    actionDigest: string,
    claim = false
  ) {
    const value = JSON.stringify(
      encryptJson(receipt, this.#key(root), `${owner}:${receipt.requestId}`)
    );
    if (Buffer.byteLength(value) > 768 * 1024)
      throw new Error('Browser receipt exceeds its result budget');
    return (
      db
        .prepare(
          claim
            ? 'INSERT INTO receipts(owner,id,digest,value) VALUES (?,?,?,?) ON CONFLICT(owner,id) DO NOTHING'
            : 'INSERT INTO receipts(owner,id,digest,value) VALUES (?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET value=excluded.value'
        )
        .run(owner, receipt.requestId, actionDigest, value).changes === 1
    );
  }
  async read(root: string, owner: string, requestId: string): Promise<BrowserActionReceipt | null> {
    Identity.parse(requestId);
    const db = await this.#open(root);
    try {
      const stored = this.#read(db, root, owner, requestId);
      return stored?.receipt ?? null;
    } finally {
      db.close();
    }
  }
  async run(
    root: string,
    owner: string,
    requestId: string,
    action: unknown,
    perform: (progress: BrowserActionProgress) => Promise<unknown>
  ): Promise<unknown> {
    Identity.parse(requestId);
    const actionDigest = createHmac('sha256', this.#key(root))
        .update(JSON.stringify(action))
        .digest('hex'),
      key = `${root}:${owner}:${requestId}`;
    const active = this.#active.get(key);
    if (active) {
      if (active.digest !== actionDigest)
        throw new Error('Browser request identity was reused with different arguments');
      return active.work;
    }
    const work = this.#run(root, owner, requestId, actionDigest, perform);
    this.#active.set(key, { digest: actionDigest, work });
    try {
      return await work;
    } finally {
      if (this.#active.get(key)?.work === work) this.#active.delete(key);
    }
  }
  async #run(
    root: string,
    owner: string,
    requestId: string,
    actionDigest: string,
    perform: (progress: BrowserActionProgress) => Promise<unknown>
  ) {
    const db = await this.#open(root);
    let accepting = true;
    try {
      const receipt: BrowserActionReceipt = {
        requestId,
        status: 'started',
        startedAt: new Date().toISOString(),
        steps: []
      };
      const claimed = this.#save(db, root, owner, receipt, actionDigest, true);
      if (!claimed) {
        const stored = this.#read(db, root, owner, requestId);
        if (!stored || stored.digest !== actionDigest)
          throw new Error('Browser request identity was reused with different arguments');
        if (stored.receipt.status === 'completed') return stored.receipt.result;
        throw new Error(
          'This browser action may already have taken effect. Inspect the page and its receipt before deciding what to do; it was not repeated.'
        );
      }
      const save = () => this.#save(db, root, owner, receipt, actionDigest);
      try {
        const result = await perform({
          begin: (index, type) => {
            if (!accepting) throw new Error('Browser action receipt is already closed');
            receipt.steps.push({ index, type, status: 'started' });
            save();
          },
          complete: (index) => {
            // A takeover can settle the caller before Playwright returns its late acknowledgement.
            if (!accepting) return;
            const step = receipt.steps.find((entry) => entry.index === index);
            if (!step) throw new Error('Browser step has no durable intent');
            step.status = 'completed';
            save();
          }
        });
        receipt.result = result;
        receipt.status = 'completed';
        receipt.finishedAt = new Date().toISOString();
        save();
        return result;
      } catch (error) {
        receipt.status = 'uncertain';
        delete receipt.result;
        receipt.finishedAt = new Date().toISOString();
        save();
        throw error;
      }
    } finally {
      accepting = false;
      db.close();
    }
  }
}
