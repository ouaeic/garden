import { randomUUID } from 'node:crypto';
import { openDownloadFile } from './open-download-file.js';
import { rm } from 'node:fs/promises';
import type { ProjectGitWorkingCopy } from '@athanor/contracts';
import { withWorkspaceDirectory, workspacePath } from './files.js';
import type { ProjectGit } from './project-git.js';
import type { ProjectCheckExecution } from './project-updates.js';

// The existing workspace sandbox supplies PID/filesystem/network isolation. This additional
// Landlock layer denies working-copy writes and limits execution to Git, its object packer and their ELF loader.
export const CAPTURE_GIT_HISTORY = String.raw`
import ctypes, json, os, platform, re, subprocess, sys
try:
    base, output = sys.argv[1:]
    if sys.platform != 'linux' or not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', base):
        raise RuntimeError('unsupported history capture')
    if not os.path.isabs(output) or not re.fullmatch(r'\.garden-history-[a-f0-9-]{36}\.bundle', os.path.basename(output)) or os.path.basename(os.path.dirname(output)) != '.garden' or os.path.commonpath([os.getcwd(), os.path.dirname(os.path.dirname(output))]) != os.path.dirname(os.path.dirname(output)):
        raise RuntimeError('invalid history destination')
    # Hold every destination component before creating the one permitted output file.
    parent = os.open('/', os.O_PATH | os.O_DIRECTORY)
    try:
        for component in output.split('/')[1:-1]:
            child = os.open(component, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        result = os.open(output.rsplit('/', 1)[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640, dir_fd=parent)
    finally:
        os.close(parent)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    def call(number, *args):
        value = libc.syscall(ctypes.c_long(number), *args)
        if value < 0:
            raise OSError(ctypes.get_errno(), 'history isolation unavailable')
        return value
    if call(444, 0, 0, 1) < 3:
        raise RuntimeError('history capture requires Landlock ABI 3')
    class Rules(ctypes.Structure):
        _fields_ = [('handled_access_fs', ctypes.c_uint64)]
    class Beneath(ctypes.Structure):
        _layout_ = 'ms'
        _pack_ = 1
        _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]
    rules = Rules((1 << 15) - 1)
    descriptor = call(444, ctypes.byref(rules), ctypes.sizeof(rules), 0)
    loader = {'x86_64': '/lib64/ld-linux-x86-64.so.2', 'aarch64': '/lib/ld-linux-aarch64.so.1'}[platform.machine()]
    for filename, access in [('/', (1 << 2) | (1 << 3)), ('/usr/bin/git', 1), ('/usr/lib/git-core/git-pack-objects', 1), (loader, 1), ('/dev/null', (1 << 1) | (1 << 2))]:
        parent = os.open(filename, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = Beneath(access, parent)
            call(445, descriptor, 1, ctypes.byref(rule), 0)
        finally:
            os.close(parent)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot restrict history privileges')
    call(446, descriptor, 0)
    os.close(descriptor)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0',
           'GIT_NO_LAZY_FETCH': '1', 'GIT_ATTR_NOSYSTEM': '1'}
    git = ['/usr/bin/git', '--no-replace-objects', '--no-optional-locks',
           '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
           '-c', 'protocol.allow=never', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
           '-c', 'core.alternateRefsCommand=', '-c', 'uploadpack.packObjectsHook=',
           '-c', 'safe.directory=' + os.getcwd()]
    head = subprocess.check_output(git + ['rev-parse', '--verify', 'HEAD^{commit}'], env=env).decode().strip()
    if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', head):
        raise RuntimeError('invalid history identity')
    with os.fdopen(result, 'wb') as stream:
        if head != base:
            # Exclude an established base only when this working copy actually contains it.
            known = subprocess.run(git + ['cat-file', '-e', base + '^{commit}'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            subprocess.run(git + ['bundle', 'create', '-', 'HEAD'] + (['^' + base] if known else []), env=env, stdout=stream, check=True)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'head': head, 'unchanged': head == base}))
except Exception:
    sys.stderr.write('Conversation Git history could not be captured safely; no unrestricted fallback was run.\n')
    sys.exit(125)
`;

export async function captureConversationHistory(options: {
  root: string;
  git: ProjectGit;
  copy: ProjectGitWorkingCopy;
  updateId: string;
  execution: ProjectCheckExecution;
  active: () => void;
}): Promise<string> {
  const { root, git, copy, updateId, execution, active } = options;
  const previous = await git.conversationHead(copy.repositoryId, copy.taskId, updateId);
  if (previous) return previous;
  if (!execution.captureGit) throw Error('Safe conversation Git capture is unavailable');
  const workspace = workspacePath(root, copy.workspaceId);
  const filename = `.garden-history-${randomUUID()}.bundle`;
  let sessionId: string | undefined;
  try {
    await withWorkspaceDirectory(workspace, 'workspace/.garden', true, async () => {});
    ({ sessionId } = await execution.captureGit(
      copy,
      `${workspace}/workspace/.garden/${filename}`
    ));
    for (;;) {
      active();
      const process = await execution.poll(copy.workspaceId, copy.taskId, sessionId, true);
      if (process.status !== 'running') {
        if (process.status !== 'completed' || process.exitCode !== 0)
          throw Error(
            'Conversation Git history capture failed. Its files and commits remain intact.'
          );
        const result = JSON.parse(process.stdout ?? '') as { head?: string; unchanged?: boolean };
        if (result.unchanged && result.head === copy.base)
          return git.retainConversationHead(copy.repositoryId, copy.taskId, updateId, copy.base);
        const bundle = await openDownloadFile(workspace, `workspace/.garden/${filename}`);
        try {
          return await git.importConversationHistory(
            copy.repositoryId,
            copy.taskId,
            updateId,
            bundle.handle,
            result.head
          );
        } finally {
          await bundle.handle.close();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    try {
      if (sessionId) await execution.stop(copy.workspaceId, copy.taskId, sessionId);
    } finally {
      await withWorkspaceDirectory(workspace, 'workspace/.garden', false, async (directory) => {
        await rm(`${directory}/${filename}`, { force: true });
      });
    }
  }
}
