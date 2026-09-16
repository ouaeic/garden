import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { assertOpenedInPlace, assertUserDataPath, resolveInside } from './files.js';

/** Hold the verified descriptor throughout delivery, even if the named path is replaced. */
export const openDownloadFile = async (root: string, requested: string) => {
  const relative = assertUserDataPath(root, requested);
  const target = resolveInside(root, relative);
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    await assertOpenedInPlace(root, target, handle);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Only regular files can be downloaded');
    return { handle, stat, relative };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
