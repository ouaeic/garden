import { describe, expect, it } from 'vitest';
import { WORKSPACE_PREFIX_NOTE, withWorkspacePrefixNote } from './shell-frame.js';

/**
 * Every case is a shape a real command produced on the live box, or the one control each of them
 * needs. The rule is content-triggered, so what is measured is where it stays silent as much as
 * where it speaks: a note on the wrong ENOENT teaches the model a falsehood about its own shell.
 */
const failed = (stderr: string) => ({
  exitCode: 1,
  signal: null,
  stdout: '',
  stderr,
  durationMs: 3,
  timedOut: false
});

describe('the note a workspace/-prefixed miss earns', () => {
  it('fires on the cd that opened the audit, and names the spelling that works', () => {
    const result = withWorkspacePrefixNote(
      { executable: 'bash', args: ['-lc', 'cd workspace/probe-2026-09-03 && python3 -m pytest'] },
      failed('bash: line 1: cd: workspace/probe-2026-09-03: No such file or directory\n')
    );
    expect(result).toMatchObject({
      exitCode: 1,
      note: WORKSPACE_PREFIX_NOTE('workspace/probe-2026-09-03', 'workspace')
    });
    expect(result.note).toBe(
      'The shell already runs inside workspace/, so write that path without the prefix: workspace/probe-2026-09-03 is probe-2026-09-03 here.'
    );
  });

  it('reads the path out of the other shapes a tool prints it in', () => {
    for (const [command, stderr] of [
      [
        'grep -c . workspace/probe-2026-09-03/hubble.md',
        'grep: workspace/probe-2026-09-03/hubble.md: No such file or directory\n'
      ],
      [
        'python3 -c "open(\'workspace/probe-2026-09-03/data.csv\')"',
        'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nFileNotFoundError: [Errno 2] No such file or directory: \'workspace/probe-2026-09-03/data.csv\'\n'
      ],
      [
        'ls -la workspace/probe-2026-09-03',
        "ls: cannot access 'workspace/probe-2026-09-03': No such file or directory\n"
      ]
    ] as const) {
      const result = withWorkspacePrefixNote(
        { executable: 'bash', args: ['-lc', command] },
        failed(stderr)
      );
      expect(result.note, command).toContain('is probe-2026-09-03');
      expect(result.note, command).toContain('already runs inside workspace/');
    }
  });

  /*
   * The runner reads a bare cwd from `workspace/`, so a command run from `probe` is in
   * `workspace/probe` and `workspace/probe/data.txt` is `data.txt` there - not `probe/data.txt`,
   * which is a second miss one directory deeper. The spelling the note offers is computed against
   * the directory the shell is actually in, however that directory was written.
   */
  it('names the spelling relative to a nested working directory', () => {
    for (const [cwd, command, stderr, expected] of [
      [
        'probe',
        'cat workspace/probe/data.txt',
        'cat: workspace/probe/data.txt: No such file or directory\n',
        'workspace/probe/data.txt is data.txt here'
      ],
      [
        'workspace/probe',
        'cat workspace/probe/data.txt',
        'cat: workspace/probe/data.txt: No such file or directory\n',
        'workspace/probe/data.txt is data.txt here'
      ],
      [
        './probe/',
        'cat workspace/probe/data.txt',
        'cat: workspace/probe/data.txt: No such file or directory\n',
        'workspace/probe/data.txt is data.txt here'
      ],
      [
        'probe',
        'cat workspace/x',
        'cat: workspace/x: No such file or directory\n',
        'workspace/x is ../x here'
      ]
    ] as const) {
      const result = withWorkspacePrefixNote(
        { executable: 'bash', args: ['-lc', command], cwd },
        failed(stderr)
      );
      expect(result.note, `${cwd}: ${command}`).toContain(expected);
      expect(result.note, `${cwd}: ${command}`).toContain('already runs inside workspace/probe/');
    }
  });

  it('fires on a bare `workspace` with no slash, which is the cd the catalogue default invites', () => {
    const result = withWorkspacePrefixNote(
      { executable: 'bash', args: ['-lc', 'cd workspace && ls'] },
      failed('bash: line 1: cd: workspace: No such file or directory\n')
    );
    expect(result.note).toBe(WORKSPACE_PREFIX_NOTE('workspace', 'workspace'));
    expect(result.note).toContain('workspace is . here');
  });

  it('stays silent from a working directory the runner does not read inside workspace/', () => {
    for (const cwd of ['.', './', 'workspace/../x', 'x/../y', '..x/..', '.home', '/tmp', '..']) {
      const result = withWorkspacePrefixNote(
        { executable: 'bash', args: ['-lc', 'cat workspace/x'], cwd },
        failed('cat: workspace/x: No such file or directory\n')
      );
      expect(result, cwd).not.toHaveProperty('note');
    }
  });

  it('stays silent on a miss anywhere else', () => {
    for (const [execution, stderr] of [
      // The control the rule is defined against.
      [
        { executable: 'cat', args: ['/etc/missing'] },
        'cat: /etc/missing: No such file or directory\n'
      ],
      // A workspace/ path on the line, and a miss on a different one: the prefix is not why.
      [
        { executable: 'bash', args: ['-lc', 'cat workspace/notes.md && cat /etc/missing'] },
        'cat: /etc/missing: No such file or directory\n'
      ],
      // The same spelling, run from a directory that is not inside workspace/.
      [
        { executable: 'ls', args: ['workspace/x'], cwd: '.garden/artifacts' },
        "ls: cannot access 'workspace/x': No such file or directory\n"
      ],
      // A command that failed for another reason entirely.
      [
        { executable: 'bash', args: ['-lc', 'cd workspace/probe && make'] },
        'make: *** No rule to make target. Stop.\n'
      ],
      // A name that merely begins with the word, and an absolute path that contains it.
      [
        { executable: 'ls', args: ['workspaces/x'] },
        "ls: cannot access 'workspaces/x': No such file or directory\n"
      ],
      [
        { executable: 'ls', args: ['/workspace/x'] },
        "ls: cannot access '/workspace/x': No such file or directory\n"
      ]
    ] as const) {
      const result = withWorkspacePrefixNote(execution, failed(stderr));
      expect(result, JSON.stringify(execution)).not.toHaveProperty('note');
      expect(result, JSON.stringify(execution)).toEqual(failed(stderr));
    }
  });

  it('leaves a background start alone, which has no stderr to read', () => {
    const started = { sessionId: 'proc_1', status: 'running' };
    expect(
      withWorkspacePrefixNote(
        { executable: 'bash', args: ['-lc', 'cd workspace/x && node server.js'] },
        started
      )
    ).toBe(started);
  });
});
