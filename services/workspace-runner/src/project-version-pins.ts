import { constants } from 'node:fs';
import { open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PinnedProjectVersionCursor, type ProjectVersionPin } from '@garden/contracts';
import { durableJson, syncDirectory } from './project-version-files.js';

const StoredPin = z
  .object({
    revisionId: z.uuid(),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    label: z.string().max(120),
    createdAt: z.iso.datetime()
  })
  .strict();
const filename = (number: number, id: string) => {
  StoredPin.shape.number.parse(number);
  return `${String(number).padStart(16, '0')}_${z.uuid().parse(id)}.json`;
};

/** Pins are durable metadata beside immutable versions; removing a pin never removes content. */
export class ProjectVersionPins {
  constructor(readonly directory: string) {}

  private async read(name: string): Promise<z.infer<typeof StoredPin> | null> {
    const handle = await open(
      path.join(this.directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return null;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) throw new Error('Project pin metadata is invalid.');
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) throw new Error('Project pin metadata is too large.');
      const pin = StoredPin.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
      );
      if (filename(pin.number, pin.revisionId) !== name)
        throw new Error('Project pin identity does not match its file.');
      return pin;
    } finally {
      await handle.close();
    }
  }

  async get(number: number, id: string): Promise<ProjectVersionPin | null> {
    const pin = await this.read(filename(number, id));
    return pin ? { label: pin.label, createdAt: pin.createdAt } : null;
  }

  async set(number: number, id: string, label: string | null): Promise<ProjectVersionPin | null> {
    const name = filename(number, id);
    const previous = await this.read(name);
    if (label === null) {
      if (previous) {
        await rm(path.join(this.directory, name));
        await syncDirectory(this.directory);
      }
      return null;
    }
    const pin = StoredPin.parse({
      revisionId: id,
      number,
      label: label.trim(),
      createdAt: previous?.createdAt ?? new Date().toISOString()
    });
    await durableJson(path.join(this.directory, name), pin);
    return { label: pin.label, createdAt: pin.createdAt };
  }

  async page(
    before?: string
  ): Promise<{ pins: z.infer<typeof StoredPin>[]; nextCursor: string | null }> {
    if (before) PinnedProjectVersionCursor.parse(before);
    const names = (
      await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })
    ).filter((name) => !name.endsWith('.tmp'));
    if (names.some((name) => !PinnedProjectVersionCursor.safeParse(name).success))
      throw new Error('Project pin directory contains invalid metadata.');
    const ordered = names
      .filter((name) => !before || name < before)
      .sort()
      .reverse();
    const selected = ordered.slice(0, 40);
    const pins = await Promise.all(selected.map((name) => this.read(name)));
    return {
      pins: pins.filter((pin) => pin !== null),
      nextCursor: ordered.length > selected.length ? selected.at(-1)! : null
    };
  }
}
