import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeOutcomeCase, bundleDigest } from './fixture.js';

export const readText = async (file: string): Promise<string> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const maximum = 1_048_576;
    if (!stat.isFile() || stat.size > maximum)
      throw new Error('Expected a bounded regular JSON file');
    const bytes = Buffer.alloc(maximum + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maximum) throw new Error('JSON file exceeds the input limit');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

export const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readText(file)) as unknown;

export const writePrivateJson = async (file: string, value: unknown): Promise<void> => {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
};

/** New sibling bundles prevent accidentally transferring the private oracle with task inputs. */
export const prepareCase = async (publicDirectory: string, privateDirectory: string) => {
  const canonicalDestination = async (directory: string) =>
    path.join(await realpath(path.dirname(path.resolve(directory))), path.basename(directory));
  const publicRoot = await canonicalDestination(publicDirectory);
  const privateRoot = await canonicalDestination(privateDirectory);
  const contains = (a: string, b: string) => b === a || b.startsWith(a + path.sep);
  if (contains(publicRoot, privateRoot) || contains(privateRoot, publicRoot)) {
    throw new Error('Public and private bundles must be separate directories');
  }
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(publicRoot, { mode: 0o700 });
  const prepared = makeOutcomeCase();
  await writePrivateJson(path.join(privateRoot, 'oracle.json'), prepared.oracle);
  for (const [name, body] of Object.entries(prepared.publicFiles)) {
    const file = await open(path.join(publicRoot, name), 'wx', 0o600);
    try {
      await file.writeFile(body);
    } finally {
      await file.close();
    }
  }
  return {
    caseId: prepared.oracle.caseId,
    publicRoot,
    privateRoot,
    publicDigest: prepared.oracle.publicDigest
  };
};

export const readPublicBundle = async (directory: string, expectedDigest: string) => {
  const files: Record<string, string> = {};
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length === 0 ||
    entries.length > 20 ||
    entries.some((entry) => !entry.isFile() || !/^[a-zA-Z0-9_.-]+$/.test(entry.name))
  ) {
    throw new Error('Expected bounded, unchanged public input files');
  }
  for (const entry of entries) files[entry.name] = await readText(path.join(directory, entry.name));
  if (bundleDigest(files) !== expectedDigest)
    throw new Error('Public input bundle changed after preparation');
  return files;
};
