import { describe, expect, it } from 'vitest';
import { knownToolCall, shellCommandCall } from './generate.js';

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
