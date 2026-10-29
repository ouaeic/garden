import { describe, expect, it } from 'vitest';
import { filePatchCall, knownToolCall, shellCommandCall } from './generate.js';

const shell = (args: Record<string, unknown>) => ({ id: 'call-1', name: 'shell', arguments: args });

/**
 * Every reader after generation - the approval floor, the write classifier, the checkpoint set -
 * knows one spelling of a shell call. A command line has to arrive in it, or it reaches them as a
 * call with no executable at all.
 */
describe('a shell call written as a command line', () => {
  it('arrives as bash -lc with the line as one argument', () => {
    expect(shellCommandCall(shell({ command: 'ls -la | head', cwd: 'workspace' }))).toEqual(
      shell({ executable: 'bash', args: ['-lc', 'ls -la | head'], cwd: 'workspace' })
    );
  });

  it('leaves an executable-and-arguments call exactly as written', () => {
    const call = shell({ executable: 'python3', args: ['-m', 'pytest'] });
    expect(shellCommandCall(call)).toBe(call);
  });

  it('names bash for a script whose interpreter was left out', () => {
    expect(shellCommandCall(shell({ args: ['-lc', 'make test'] }))).toEqual(
      shell({ args: ['-lc', 'make test'], executable: 'bash' })
    );
  });

  it('reads an argument list sent as the JSON text of a list', () => {
    expect(shellCommandCall(shell({ executable: 'bash', args: '["-lc", "make test"]' }))).toEqual(
      shell({ executable: 'bash', args: ['-lc', 'make test'] })
    );
    // Text that is not a list of strings is left for the tool to refuse in its own words.
    const odd = shell({ executable: 'bash', args: 'make test' });
    expect(shellCommandCall(odd)).toBe(odd);
  });

  it('touches no other tool', () => {
    const call = { id: 'call-2', name: 'file_read', arguments: { command: 'rm -rf /' } };
    expect(shellCommandCall(call)).toBe(call);
  });
});

describe('a tool name with stray characters after it', () => {
  const offered = ['file_patch', 'file_read', 'shell'];
  const named = (name: string) => ({ id: 'c1', name, arguments: {} });

  it('is the offered tool it starts with', () => {
    expect(knownToolCall(offered)(named('file_patch活了')).name).toBe('file_patch');
    expect(knownToolCall(offered)(named('shell<|end|>')).name).toBe('shell');
  });

  it('leaves a name that could be a different tool, or an offered one, alone', () => {
    expect(knownToolCall(offered)(named('file_patches')).name).toBe('file_patches');
    expect(knownToolCall(offered)(named('shell_v2')).name).toBe('shell_v2');
    expect(knownToolCall(offered)(named('file_read')).name).toBe('file_read');
    expect(knownToolCall(offered)(named('unknown')).name).toBe('unknown');
  });
});

describe('a tool named by a common synonym', () => {
  const offered = ['shell', 'file_read', 'file_write', 'file_patch', 'files_list'];
  const named = (name: string) => ({ id: 'c1', name, arguments: {} });

  it('is the offered tool it stands for', () => {
    expect(knownToolCall(offered)(named('write_file')).name).toBe('file_write');
    expect(knownToolCall(offered)(named('bash')).name).toBe('shell');
    expect(knownToolCall(offered)(named('list_directory')).name).toBe('files_list');
  });

  it('is left alone when the tool it stands for is not offered', () => {
    expect(knownToolCall(['shell'])(named('write_file')).name).toBe('write_file');
  });
});

describe('a shell call with the whole argv in executable', () => {
  it('splits it into the executable and its arguments', () => {
    const call = shellCommandCall(shell({ executable: ['bash', '-lc', 'make test'] }));
    expect(call.arguments).toMatchObject({ executable: 'bash', args: ['-lc', 'make test'] });
  });
});

/**
 * The argv shapes models carry from other tools, each seen refused on the bench before this
 * existed: a list under `commands`, an argv in `command`, `arguments` for `args`, and an argument
 * list whose first word is the executable.
 */
describe("a shell call in another tool's shape", () => {
  it('runs a list of command lines as one script', () => {
    expect(shellCommandCall(shell({ commands: ['cd /app', 'make test'] })).arguments).toEqual({
      executable: 'bash',
      args: ['-lc', 'cd /app\nmake test']
    });
  });

  it('reads an argv written in command', () => {
    expect(shellCommandCall(shell({ command: ['bash', '-lc', 'which perf'] })).arguments).toEqual({
      executable: 'bash',
      args: ['-lc', 'which perf']
    });
  });

  it('reads arguments and argv as the argument list', () => {
    expect(shellCommandCall(shell({ arguments: ['-lc', 'make'] })).arguments).toEqual({
      executable: 'bash',
      args: ['-lc', 'make']
    });
    expect(
      shellCommandCall(shell({ executable: 'python3', argv: ['-m', 'pytest'], cwd: 'app' }))
        .arguments
    ).toEqual({ executable: 'python3', args: ['-m', 'pytest'], cwd: 'app' });
  });

  it('takes the first word of an argument list as the executable', () => {
    expect(shellCommandCall(shell({ args: ['bash', '-lc', 'make'] })).arguments).toEqual({
      executable: 'bash',
      args: ['-lc', 'make']
    });
    expect(shellCommandCall(shell({ args: ['python3', 'run.py'] })).arguments).toEqual({
      executable: 'python3',
      args: ['run.py']
    });
  });

  it('reads a flag in executable as bash with that flag', () => {
    expect(
      shellCommandCall(shell({ executable: '-lc', args: ['cd /app && make'] })).arguments
    ).toEqual({ executable: 'bash', args: ['-lc', 'cd /app && make'] });
  });

  it('leaves a call it cannot read for the tool to refuse', () => {
    const garbled = shell({ args: '["file_read", "path": "/app/x.c"]' });
    expect(shellCommandCall(garbled)).toBe(garbled);
    const empty = shell({ cwd: 'app' });
    expect(shellCommandCall(empty)).toBe(empty);
  });
});

/**
 * A server started in the foreground never returns: it held the turn until the runner stopped it,
 * and the approval floor reads `background` to see a service at all.
 */
describe('what a shell call means by its fields', () => {
  it('runs a named service or job in the background', () => {
    expect(shellCommandCall(shell({ command: 'exec sshd -D', service: 'sshd' }))).toEqual(
      shell({
        service: 'sshd',
        executable: 'bash',
        args: ['-lc', 'exec sshd -D'],
        background: true
      })
    );
    expect(shellCommandCall(shell({ command: 'make all', job: 'build' })).arguments).toEqual({
      job: 'build',
      executable: 'bash',
      args: ['-lc', 'make all'],
      background: true
    });
  });

  it('leaves a call that already says background, or names neither, as it was', () => {
    const service = shell({
      executable: 'bash',
      args: ['-lc', 'serve'],
      service: 'web',
      background: true
    });
    expect(shellCommandCall(service)).toBe(service);
    const plain = shell({ executable: 'bash', args: ['-lc', 'ls'], service: '  ' });
    expect(shellCommandCall(plain)).toBe(plain);
  });

  it('runs a cwd of . in the working directory and keeps every other cwd', () => {
    for (const here of ['.', './', ' . '])
      expect(shellCommandCall(shell({ command: 'make', cwd: here })).arguments).toEqual({
        executable: 'bash',
        args: ['-lc', 'make']
      });
    expect(shellCommandCall(shell({ command: 'make', cwd: './src' })).arguments.cwd).toBe('./src');
    expect(shellCommandCall(shell({ command: 'make', cwd: '/tmp' })).arguments.cwd).toBe('/tmp');
  });
});

describe('the short names other tools use', () => {
  const offered = ['shell', 'file_read', 'file_write', 'file_patch', 'files_list'];
  const named = (name: string) => ({ id: 'c1', name, arguments: {} });

  it('are the offered tools they stand for', () => {
    expect(knownToolCall(offered)(named('read')).name).toBe('file_read');
    expect(knownToolCall(offered)(named('write')).name).toBe('file_write');
    expect(knownToolCall(offered)(named('edit')).name).toBe('file_patch');
    expect(knownToolCall(offered)(named('ls')).name).toBe('files_list');
  });

  it('carry an edit list as patches', () => {
    const call = filePatchCall({
      id: 'c1',
      name: 'file_patch',
      arguments: { path: 'a.py', edits: [{ oldText: 'x = 1', newText: 'x = 2' }] }
    });
    expect(call.arguments).toEqual({
      patches: [{ path: 'a.py', oldText: 'x = 1', newText: 'x = 2' }]
    });
  });
});
