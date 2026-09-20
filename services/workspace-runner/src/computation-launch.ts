import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComputationRequest } from '@athanor/contracts';
import {
  AGENT_HOME,
  assertUserDataPath,
  createWorkspaceFile,
  deleteWorkspaceFile
} from './files.js';
import { JAVASCRIPT_COMPUTATION, PYTHON_COMPUTATION } from './computation-programs.js';
import { R_COMPUTATION } from './computation-r.js';

export async function computationLaunch(
  root: string,
  request: ComputationRequest,
  token: string
): Promise<{
  executable: string;
  args: string[];
  dispose?: () => Promise<void>;
}> {
  if (request.rLibraryPaths?.length && request.language !== 'r')
    throw Error('R libraries require an R session');
  if (request.language === 'r') {
    const libraries = await Promise.all(
      (request.rLibraryPaths ?? []).map(async (relative) => {
        const absolute = path.join(root, assertUserDataPath(root, relative));
        if ((await realpath(absolute)) !== absolute || !(await stat(absolute)).isDirectory())
          throw Error('R libraries must be real directories inside this workspace');
        return absolute;
      })
    );
    // R's command-line expression transport has a smaller ceiling than a complete kernel program.
    const relative = path.join(AGENT_HOME, `computation-bootstrap-${randomUUID()}.R`);
    await createWorkspaceFile(root, relative, Buffer.from(R_COMPUTATION), 128 * 1024);
    return {
      executable: 'Rscript',
      args: ['--vanilla', path.join(root, relative), token, ...libraries],
      dispose: () => deleteWorkspaceFile(root, relative)
    };
  }
  if (request.language === 'python')
    return { executable: 'python3', args: ['-u', '-c', PYTHON_COMPUTATION, token] };
  if (request.language === 'javascript')
    return { executable: process.execPath, args: ['-e', JAVASCRIPT_COMPUTATION, token] };
  throw Error('Computation start requires a supported language');
}
