import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireScope } from './auth.js';
import { assertUserDataPath, workspacePath } from './files.js';
import { execute, type ExecutionOptions } from './execution.js';

// Landlock is additive to the workspace sandbox: metadata reads cannot write files or execute helpers.
export const READ_ONLY_GIT = String.raw`
import ctypes, os, platform, sys
try:
    if sys.platform != 'linux' or sys.argv[1] not in ('status', 'files'):
        raise RuntimeError('unsupported metadata reader')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    def call(number, *args):
        result = libc.syscall(ctypes.c_long(number), *args)
        if result < 0:
            raise OSError(ctypes.get_errno(), 'metadata isolation unavailable')
        return result
    abi = call(444, 0, 0, 1)
    if abi < 3:
        raise RuntimeError('metadata reader needs Landlock ABI 3')
    class Rules(ctypes.Structure):
        _fields_ = [('handled_access_fs', ctypes.c_uint64)]
    class Beneath(ctypes.Structure):
        _layout_ = 'ms'
        _pack_ = 1
        _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]
    rules = Rules((1 << 15) - 1)
    descriptor = call(444, ctypes.byref(rules), ctypes.sizeof(rules), 0)
    for filename, access in [('/', 1 | (1 << 2) | (1 << 3)), ('/dev/null', (1 << 1) | (1 << 2))]:
        parent = os.open(filename, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = Beneath(access, parent)
            call(445, descriptor, 1, ctypes.byref(rule), 0)
        finally:
            os.close(parent)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot restrict metadata privileges')
    call(446, descriptor, 0)
    os.close(descriptor)
    # The loader needs executable mappings. Permit only the initial fexecve syscall, then close its fd.
    arch, execute, execute_at = {
        'x86_64': (0xc000003e, 59, 322), 'aarch64': (0xc00000b7, 221, 281)
    }[platform.machine()]
    git = os.open('/usr/bin/git', os.O_PATH | os.O_CLOEXEC)
    class Instruction(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Instruction))]
    deny = 0x00050001
    instructions = [
        (0x20,0,0,4), (0x15,1,0,arch), (0x06,0,0,0x80000000),
        (0x20,0,0,0), (0x35,0,1,0x40000000), (0x06,0,0,deny),
        (0x15,0,1,execute), (0x06,0,0,deny),
        (0x15,1,0,execute_at), (0x06,0,0,0x7fff0000),
        (0x20,0,0,16), (0x15,1,0,git), (0x06,0,0,deny),
        (0x20,0,0,48), (0x15,1,0,0x1000), (0x06,0,0,deny),
        (0x06,0,0,0x7fff0000)
    ]
    filters = (Instruction * len(instructions))(*(Instruction(*i) for i in instructions))
    program = Program(len(instructions), filters)
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise RuntimeError('cannot restrict metadata execution')
    command = ['status', '--short', '--branch', '--ignore-submodules=all'] if sys.argv[1] == 'status' else ['ls-files', '-z']
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0',
           'GIT_NO_LAZY_FETCH': '1'}
    os.execve(git, ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', *command], env)
except Exception:
    sys.stderr.write('Read-only Git metadata is unavailable; no unrestricted fallback was run.\n')
    sys.exit(125)
`;

const Request = z.object({ path: z.string().min(1).max(4096) }).strict();
export async function readRepositoryGit(
  root: string,
  input: unknown,
  options: ExecutionOptions,
  run: typeof execute = execute
) {
  const request = Request.parse(input);
  const path = assertUserDataPath(root, request.path);
  if (path !== 'workspace' && !path.startsWith('workspace/'))
    throw new Error('Choose a directory inside the workspace');
  if (!options.sandbox?.confineFilesystem || options.sandbox.networkIsolation !== true)
    return {
      status: '',
      files: '',
      limited: true,
      reason: 'Read-only Git metadata needs filesystem and network isolation.'
    };
  const results = await Promise.all(
    ['status', 'files'].map((action) =>
      run(
        root,
        {
          executable: '/usr/bin/python3',
          args: ['-I', '-c', READ_ONLY_GIT, action],
          cwd: path,
          network: false,
          timeoutSeconds: 30,
          maxOutputBytes: 1_048_576
        },
        { ...options, isolateNetwork: true, allowSystemPackages: false }
      )
    )
  );
  const [status, files] = results;
  const limited = results.some(
    (result) =>
      result.exitCode !== 0 ||
      result.timedOut ||
      result.signal !== null ||
      result.stderr.trim().length > 0 ||
      result.stdout.includes('bytes omitted from stdout')
  );
  return {
    status: status!.exitCode === 0 ? status!.stdout : '',
    files: files!.exitCode === 0 ? files!.stdout : '',
    limited,
    ...(limited
      ? {
          reason:
            'Git metadata is incomplete or unavailable. Repository hooks and filters are not executed by this reader.'
        }
      : {})
  };
}

export function registerRepositoryGitRoute(
  app: FastifyInstance,
  root: string,
  options: ExecutionOptions
) {
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/repository-git',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const controller = new AbortController();
      const closed = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', closed);
      try {
        return await readRepositoryGit(
          workspacePath(root, request.params.workspaceId),
          request.body,
          { ...options, abortSignal: controller.signal }
        );
      } finally {
        reply.raw.removeListener('close', closed);
      }
    }
  );
}
