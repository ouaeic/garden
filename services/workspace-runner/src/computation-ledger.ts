import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ComputationCellSchema } from '@athanor/contracts';
import { durableJson } from './project-version-files.js';

const Receipt = z
  .object({
    cellId: z.string().min(1).max(120),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['running', 'completed', 'failed', 'interrupted']),
    cell: ComputationCellSchema.optional()
  })
  .strict()
  .refine(
    (value) =>
      !value.cell || (value.cell.cellId === value.cellId && value.cell.state === value.state)
  );
export type ComputationReceipt = z.infer<typeof Receipt>;
const MAX_RECEIPT_BYTES = 256 * 1024;

/** Each cell keeps its request identity on disk; session length does not grow the live journal. */
export class ComputationLedger {
  readonly #writes = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}

  #file(sessionId: string, cellId: string): string {
    if (!/^kernel-[a-f0-9-]{36}$/.test(sessionId)) throw Error('Invalid computation session');
    z.string().min(1).max(120).parse(cellId);
    const key = createHash('sha256').update(cellId).digest('hex');
    return path.join(this.root, sessionId, `${key}.json`);
  }

  async get(sessionId: string, cellId: string): Promise<ComputationReceipt | undefined> {
    const filename = this.#file(sessionId, cellId);
    await this.#writes.get(filename);
    return this.#read(filename, cellId);
  }

  async #read(filename: string, cellId: string): Promise<ComputationReceipt | undefined> {
    let file;
    try {
      file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES)
        throw Error('Invalid computation receipt');
      const receipt = Receipt.parse(JSON.parse(await file.readFile('utf8')));
      if (receipt.cellId !== cellId) throw Error('Computation receipt identity mismatch');
      return receipt;
    } finally {
      await file.close();
    }
  }

  async put(sessionId: string, value: ComputationReceipt): Promise<void> {
    const receipt = Receipt.parse(value);
    if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES)
      throw Error('Computation receipt exceeds limit');
    const filename = this.#file(sessionId, receipt.cellId);
    const write = (this.#writes.get(filename) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const previous = await this.#read(filename, receipt.cellId);
        if (previous && previous.hash !== receipt.hash)
          throw Error('This cellId already names different code or options');
        // A delayed stop or interrupted acknowledgement cannot replace a settled result.
        if (previous && previous.state !== 'running') return;
        await durableJson(filename, receipt);
      });
    this.#writes.set(filename, write);
    try {
      await write;
    } finally {
      if (this.#writes.get(filename) === write) this.#writes.delete(filename);
    }
  }
}
