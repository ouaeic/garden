import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { withWorkspaceDirectory, WorkspaceFileError } from './files.js';

// Directory rename must refuse even an empty destination created after the existence check.
const MOVE = `import ctypes, errno, os, sys
lib = ctypes.CDLL(None, use_errno=True)
if sys.platform == "linux":
    move, flag = lib.renameat2, 1
elif sys.platform == "darwin":
    move, flag = lib.renameatx_np, 4
else:
    sys.exit(77)
move.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
move.restype = ctypes.c_int
if move(3, os.fsencode(sys.argv[1]), 4, os.fsencode(sys.argv[2]), flag):
    code = ctypes.get_errno()
    sys.exit(75 if code in (errno.EEXIST, errno.ENOTEMPTY) else 76)
`;

export async function moveVersionDirectory(
  root: string,
  source: string,
  target: string
): Promise<void> {
  await withWorkspaceDirectory(root, path.dirname(source), false, async (from) => {
    const left = await open(
      `${from}/.`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      await withWorkspaceDirectory(root, path.dirname(target), false, async (to) => {
        const right = await open(
          `${to}/.`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              '/usr/bin/python3',
              ['-I', '-S', '-c', MOVE, path.basename(source), path.basename(target)],
              { stdio: ['ignore', 'ignore', 'ignore', left.fd, right.fd], env: {} }
            );
            const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
            child.once('error', (cause) => {
              clearTimeout(timeout);
              reject(new Error('Atomic version move is unavailable.', { cause }));
            });
            child.once('exit', (code) => {
              clearTimeout(timeout);
              if (code === 0) resolve();
              else if (code === 75)
                reject(
                  new WorkspaceFileError(
                    'The version destination is occupied. No files were overwritten.',
                    409
                  )
                );
              else
                reject(
                  new Error(
                    'Atomic version move did not complete. The saved operation can be retried.'
                  )
                );
            });
          });
        } finally {
          await right.close();
        }
      });
    } finally {
      await left.close();
    }
  });
}
