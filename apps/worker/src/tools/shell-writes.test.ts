import { describe, expect, it } from 'vitest';
import { GardenError } from '@garden/core';
import { type ModelToolCall } from '@garden/model-gateway';
import { executeWorkspaceTool } from './workspace.js';
import { forgetReads, toLines } from '../edit/index.js';
import { type AgentState } from '../agent-state.js';
import { approvalRequirement } from '../approval-policy.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * The shell forms of `file_write`, held to the same read record `file_write` is held to.
 *
 * `file_write` of a file the turn has read part of is refused until the reads cover it, because a
 * whole-file write after a window is an edit made from memory of lines that were never on screen.
 * `bash -lc 'echo x > app.ts'` is the same write with the same content source - the model's own
 * text - and it reached the disk with no read, no card and no refusal: measured on a real
 * workspace, a reader that had been shown lines 1-50 of a 400-line file ran that command and the
 * file was one line afterwards. Every case here is driven through the shipped shell arm, and the
 * assertion that matters is whether the command reached the runner at all.
 */

const HASH = 'sha-app';

/** A file of `count` lines, each one distinguishable from every other by its own number. */
const tall = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

interface Turn {
  /** Every command that reached the runner, in order, as the arm sent it. */
  readonly executed: Array<Record<string, unknown>>;
  readonly state: AgentState;
  readonly run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * A turn against an in-memory tree: the ranged reader cutting on line boundaries, the display
 * reader handing back the whole file, and a runner that records every command instead of running
 * one. What the shell arm sends to `exec` is the whole of what is under test, so nothing here
 * pretends to run it.
 */
const turn = async (
  files: Record<string, string>,
  calls: Array<{ name: string; args: Record<string, unknown> }>
): Promise<Turn> => {
  forgetReads();
  const written = new Map<string, string>(Object.entries(files));
  const executed: Array<Record<string, unknown>> = [];
  const state = {} as AgentState;
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-shell', userId: 'user-1' },
    state,
    store: { setWorkspaceStorage: async () => undefined },
    runner: {
      /*
       * The display read as the runner performs it: the lines that fit the budget, whole, and a
       * file whose first line does not fit at all comes back as a cut prefix with nothing recorded
       * as displayed - which is the shape that makes the one-line case below a one-line case.
       */
      readFileForDisplay: async (
        _w: string,
        _t: string,
        path: string,
        budget: { maxBytes: number; maxLines: number }
      ) => {
        const text = written.get(path);
        if (text === undefined) throw new Error(`no such file ${path}`);
        const all = toLines(text);
        let bytes = 0;
        let whole = 0;
        while (whole < all.length && whole < budget.maxLines) {
          const cost = Buffer.byteLength(all[whole] ?? '', 'utf8') + 1;
          if (bytes + cost > budget.maxBytes) break;
          bytes += cost;
          whole += 1;
        }
        const partialLine = whole === 0 && text.length > 0;
        return {
          content: partialLine
            ? Buffer.from(text, 'utf8').subarray(0, budget.maxBytes).toString('utf8')
            : all.slice(0, whole).join('\n'),
          sha256: HASH,
          totalLines: all.length,
          displayedLines: whole,
          partialLine
        };
      },
      readFileLines: async (
        _w: string,
        _t: string,
        path: string,
        window: { startLine: number; endLine: number; maxBytes: number }
      ) => {
        const all = toLines(written.get(path) ?? '');
        const endLine = Math.min(window.endLine, all.length);
        const reachedEnd = endLine >= all.length;
        return {
          content: all.slice(window.startLine - 1, endLine).join('\n'),
          startLine: window.startLine,
          endLine,
          ...(reachedEnd ? { totalLines: all.length } : { nextStartLine: endLine + 1 }),
          truncated: false,
          partialLine: false,
          fileBytes: Buffer.byteLength(written.get(path) ?? '', 'utf8')
        };
      },
      call: async (_w: string, _t: string, _scope: unknown, route: string, body?: unknown) => {
        if (route.endsWith('/exec') || route.endsWith('/processes/start')) {
          executed.push(body as Record<string, unknown>);
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        }
        return { storageBytes: 1 };
      }
    }
  } as unknown as ToolContext;
  const run = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    executeWorkspaceTool(context, {
      id: `call-${name}-${executed.length}`,
      name,
      arguments: args
    } as unknown as ModelToolCall);
  for (const call of calls) await run(call.name, call.args);
  return { executed, state, run };
};

const shell = (script: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  executable: 'bash',
  args: ['-lc', script],
  ...extra
});

/** Lines 1-50 of a 400-line file, which is the read the measured destruction followed. */
const WINDOWED = [
  { name: 'file_read', args: { path: 'workspace/app.ts', startLine: 1, endLine: 50 } }
];

describe('a shell command that would replace a file the turn has only partly read', () => {
  it('is refused before it reaches the runner, naming the unread lines', async () => {
    const { executed, run } = await turn({ 'workspace/app.ts': tall(400) }, WINDOWED);

    const refusal = await run('shell', shell('echo x > app.ts')).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(GardenError);
    expect((refusal as GardenError).code).toBe('write_unread');
    // The same recovery `file_write` names, because it is the same floor: read the rest, or patch
    // the lines that were shown.
    expect((refusal as Error).message).toMatch(/line 51 onwards has never been shown to you/);
    expect((refusal as Error).message).toMatch(/file_read using startLine and endLine/);
    expect((refusal as Error).message).toMatch(/file_patch/);
    // The assertion that matters: nothing went to the runner, so nothing could have landed.
    expect(executed).toEqual([]);
  });

  it.each([
    ['a redirect with the descriptor written out', 'printf "" 1> app.ts'],
    ['a redirect of both streams', 'true &> app.ts'],
    ['a redirect through the shell built-in', ': > app.ts'],
    ['a redirect that forces past noclobber', 'echo x >| app.ts'],
    ['a heredoc', 'cat > app.ts <<EOF\nx\nEOF'],
    ['tee', 'printf "" | tee app.ts'],
    ['tee under sudo', 'printf "" | sudo tee app.ts'],
    ['cp onto it', 'cp other.ts app.ts'],
    ['mv onto it', 'mv other.ts app.ts'],
    ['install onto it', 'install -m 644 other.ts app.ts'],
    ['truncate', 'truncate -s 0 app.ts'],
    ['dd', 'dd if=/dev/null of=app.ts'],
    ['a redirect in a second command of the line', 'npm test && echo x > app.ts'],
    ['a redirect behind an env prefix', 'FOO=1 echo x > app.ts'],
    ['a redirect inside a nested shell', 'sh -c "echo x > app.ts"']
  ])('sees %s', async (_shape, script) => {
    const { executed, run } = await turn({ 'workspace/app.ts': tall(400) }, WINDOWED);

    await expect(run('shell', shell(script))).rejects.toThrow(GardenError);
    expect(executed).toEqual([]);
  });

  it('sees the same write through a bare executable with no shell in front of it', async () => {
    const { executed, run } = await turn({ 'workspace/app.ts': tall(400) }, WINDOWED);

    await expect(run('shell', { executable: 'tee', args: ['app.ts'], stdin: '' })).rejects.toThrow(
      /would replace workspace\/app\.ts whole/
    );
    await expect(run('shell', { executable: 'cp', args: ['other.ts', 'app.ts'] })).rejects.toThrow(
      GardenError
    );
    expect(executed).toEqual([]);
  });

  it('resolves the target against the cwd the command names', async () => {
    const { executed, run } = await turn({ 'workspace/src/app.ts': tall(400) }, [
      { name: 'file_read', args: { path: 'workspace/src/app.ts', startLine: 1, endLine: 50 } }
    ]);

    await expect(run('shell', shell('echo x > app.ts', { cwd: 'workspace/src' }))).rejects.toThrow(
      GardenError
    );
    // The same spelling from the default cwd names a different file, which nothing has read.
    await run('shell', shell('echo x > app.ts'));
    expect(executed).toHaveLength(1);
  });

  it('holds the background form to the same record', async () => {
    const { executed, run } = await turn({ 'workspace/app.ts': tall(400) }, WINDOWED);

    await expect(run('shell', shell('echo x > app.ts', { background: true }))).rejects.toThrow(
      GardenError
    );
    expect(executed).toEqual([]);
  });

  it('lifts as soon as the reads cover the file, exactly as the file_write floor does', async () => {
    const { executed, run } = await turn({ 'workspace/app.ts': tall(400) }, [
      ...WINDOWED,
      { name: 'file_read', args: { path: 'workspace/app.ts', startLine: 51, endLine: 400 } }
    ]);

    await run('shell', shell('echo x > app.ts'));
    expect(executed).toHaveLength(1);
  });

  it('sends the file with no newlines in it to a program, not to a range read', async () => {
    const { run } = await turn({ 'workspace/acl.json': 'x'.repeat(76_478) }, [
      { name: 'file_read', args: { path: 'workspace/acl.json' } }
    ]);

    const refusal = await run('shell', shell('echo "{}" > acl.json')).catch(
      (error: unknown) => error
    );
    expect((refusal as Error).message).toMatch(/Transform it with a program from the shell/);
    expect((refusal as Error).message).not.toMatch(/file_read using startLine/);
  });
});

/**
 * The positive direction: every command below ran before this floor existed and runs after it.
 * A floor that refuses a legitimate command is a worse harness than the hole it closes, and this
 * is the list that says which commands the floor was measured against.
 */
describe('what the floor leaves alone', () => {
  it.each([
    ['a plain test run', 'npm test'],
    ['a status read', 'git status'],
    ['a build', 'pnpm -s typecheck'],
    ['a package install', 'pip install requests'],
    ['a read of the file', 'cat app.ts'],
    ['a read of the file into somewhere else', 'cat app.ts > /tmp/copy.ts'],
    ['a copy FROM the file', 'cp app.ts app.ts.bak'],
    ['an append, which discards nothing', 'echo x >> app.ts'],
    ['tee in append mode', 'echo x | tee -a app.ts'],
    ['a redirect to a file nothing has read', 'echo x > fresh.ts'],
    // Commands run in `workspace/`, so this spelling names workspace/workspace/app.ts - a
    // different file from the one the read was about, and one nothing has read.
    ['a redirect spelled with the workspace prefix from inside it', 'echo x > workspace/app.ts'],
    ['a redirect to the discard sink', 'npm test > /dev/null 2>&1'],
    ['a comparison inside a program, not a redirect', "awk '$1 > 3' app.ts"]
  ])('does not touch %s', async (_shape, script) => {
    const { executed, run } = await turn(
      { 'workspace/app.ts': tall(400), 'workspace/other.ts': tall(3) },
      WINDOWED
    );

    await run('shell', shell(script));
    expect(executed).toHaveLength(1);
  });

  it('never refuses a file the turn has read whole, or never read at all', async () => {
    const { executed, run } = await turn(
      { 'workspace/app.ts': tall(400), 'workspace/other.ts': tall(3) },
      [{ name: 'file_read', args: { path: 'workspace/app.ts' } }]
    );

    await run('shell', shell('echo x > app.ts'));
    await run('shell', shell('echo x > other.ts'));
    expect(executed).toHaveLength(2);
  });

  it('raises no approval card of its own: the refusal is the arm’s, not the owner’s', () => {
    // The floor deliberately frees a write inside checkpointed content on the grounds that a
    // rewind restores it. This lane does not change that: a partly-read file is refused to the
    // model with the recovery it can perform, and the owner is not asked.
    for (const mode of ['balanced', 'autonomous'] as const) {
      expect(approvalRequirement('shell', shell('echo x > app.ts'), mode, {})).toBeNull();
      expect(approvalRequirement('shell', shell('npm test'), mode, {})).toBeNull();
    }
  });
});

/**
 * WHAT THE FLOOR DELIBERATELY DOES NOT SEE, stated as tests that fail when it starts to.
 *
 * Each shape below reaches the runner today, on purpose, and the reason is beside it. A change
 * that widens the floor to one of these turns the case red, which is the point: the widening then
 * has to say why the reason stopped holding, rather than arriving as a quiet extra refusal in
 * front of a model that was told the shell is the way through.
 */
describe('what the floor is measured not to see', () => {
  it.each([
    /*
     * An in-place transform reproduces none of the file from memory - the pattern decides what
     * changes, whether or not the model has seen the line - so it is outside the principle the
     * seen-line guard enforces. The floor cannot tell a rename across unseen lines from a blanking
     * of them, and refusing both would close the route the write arm itself names for the file no
     * read can ever cover.
     */
    ['an in-place sed', 'sed -i "s/.*//" app.ts'],
    ['an in-place perl', 'perl -pi -e "s/a/b/" app.ts'],
    /*
     * A program is the documented escape hatch: "transform it with a program from the shell" is
     * what the `file_write` refusal says to do, and the floor has no view into what a program
     * opens for writing.
     */
    ['a write through a language runtime', "python3 -c \"open('app.ts', 'w').write('')\""],
    /*
     * A `cd` inside the script re-bases every path after it, and the floor resolves against the
     * cwd the call named. The write below lands on workspace/src/app.ts, which nothing has read;
     * the floor reads it as workspace/app.ts and would refuse a file the command does not touch,
     * so a script that changes directory is not resolved at all.
     */
    ['a redirect after a cd', 'cd src && echo x > app.ts'],
    /*
     * A path the shell would expand is not a path the floor can name: a variable or a glob is
     * resolved by the shell at run time, and the floor performs no expansion.
     */
    ['a redirect to a variable', 'F=app.ts; echo x > $F'],
    ['a redirect to a glob', 'echo x > app.*'],
    /*
     * Two writers with their own option grammars. `sort -o` and `rsync` replace their destination
     * too; they are left out because neither has been measured as a shape a model reaches for to
     * restate a file from memory, and every writer added here is a grammar this floor has to read
     * correctly in both directions.
     */
    ['sort writing over its input', 'sort -o app.ts app.ts'],
    ['rsync onto it', 'rsync other.ts app.ts']
  ])('lets %s through', async (_shape, script) => {
    const { executed, run } = await turn(
      { 'workspace/app.ts': tall(400), 'workspace/src/app.ts': tall(3) },
      WINDOWED
    );

    await run('shell', shell(script));
    expect(executed).toHaveLength(1);
  });
});

/**
 * The spellings that reached the runner past the first floor, each measured on the real runner:
 * quoting the shell takes off before the name is a name, a combined short flag that hid the whole
 * script, applets and links that replace a file under another program's name, sed's own write
 * command, and the cwd spellings the runner resolves to the same place.
 */
describe('the spellings of a replacement the floor has to read as the shell reads them', () => {
  it.each([
    ['quote concatenation in the name', "echo x > app''.ts"],
    ['a quoted stem', 'echo x > "app".ts'],
    ['a backslash in the name', 'echo x > app\\.ts'],
    ['ANSI-C quoting', "echo x > $'app.ts'"],
    ['a busybox applet', 'busybox tee app.ts'],
    ['a busybox copy', 'busybox cp other.ts app.ts'],
    ['a forced symbolic link', 'ln -sf other.ts app.ts'],
    ['a forced hard link', 'ln -f other.ts app.ts'],
    ["sed's w command", "sed -n 'w app.ts' other.ts"],
    ["sed's w closing a substitution", "sed 's/x/y/w app.ts' other.ts"],
    [
      'a temporary written from a literal and moved over the file',
      'echo x > app.ts.tmp && mv app.ts.tmp app.ts'
    ]
  ])('sees %s', async (_shape, script) => {
    const { executed, run } = await turn(
      { 'workspace/app.ts': tall(400), 'workspace/other.ts': tall(3) },
      WINDOWED
    );

    await expect(run('shell', shell(script))).rejects.toThrow(GardenError);
    expect(executed).toEqual([]);
  });

  it.each([
    ['bash -ec', { executable: 'bash', args: ['-ec', 'echo x > app.ts'] }],
    ['sh -euc', { executable: 'sh', args: ['-euc', 'echo x > app.ts'] }],
    ['bash -xc', { executable: 'bash', args: ['-xc', 'echo x > app.ts'] }],
    ['a bare busybox applet', { executable: 'busybox', args: ['tee', 'app.ts'], stdin: '' }]
  ])('sees the script behind %s', async (_shape, args) => {
    const { executed, run } = await turn({ 'workspace/app.ts': tall(400) }, WINDOWED);

    await expect(run('shell', args)).rejects.toThrow(GardenError);
    expect(executed).toEqual([]);
  });

  it('reads the cwd as the runner reads it: the container root, and a path that folds', async () => {
    const { executed, run } = await turn({ 'workspace/app.ts': tall(400) }, WINDOWED);

    // `''` is the container root at the runner, so `workspace/app.ts` from there is the file.
    await expect(run('shell', shell('echo x > workspace/app.ts', { cwd: '' }))).rejects.toThrow(
      GardenError
    );
    await expect(
      run('shell', shell('echo x > workspace/app.ts', { cwd: 'workspace/..' }))
    ).rejects.toThrow(GardenError);
    await expect(
      run('shell', shell('echo x > app.ts', { cwd: 'workspace/src/..' }))
    ).rejects.toThrow(GardenError);
    expect(executed).toEqual([]);
    // And from the container root a bare name is a file at the root, which nothing has read.
    await run('shell', shell('echo x > app.ts', { cwd: '' }));
    expect(executed).toHaveLength(1);
  });
});

/**
 * The positive direction, on the shapes the first floor refused because it read a `>` anywhere in
 * the text as a redirect and any `-e` value as a script: a search for the generator of the file,
 * a commit message, a config value, a comparison, and a restore from the file's own backup.
 */
describe('what the floor leaves alone once it reads quoting', () => {
  it.each([
    [
      'a grep whose pattern looks like a redirect',
      { executable: 'grep', args: ['-rn', '-e', '> app.ts', '.'] }
    ],
    ['the same grep through the shell', shell('grep -rn -e "> app.ts" .')],
    ['a ripgrep for the same pattern', shell('rg -n "> app.ts" scripts/')],
    [
      'a commit message naming a redirect',
      shell('git commit -am "Pipe generator output > app.ts"')
    ],
    ['a git config value', shell("git -c x='> app.ts' status")],
    ['an awk comparison against a string', shell(`awk '$1 > "app.ts"' data.txt`)],
    ['an escaped comparison inside test', shell('[ "$a" \\> app.ts ] && echo yes')],
    ['a restore from the backup', shell('mv app.ts.bak app.ts')],
    ['a restore from the original', shell('cp app.ts.orig app.ts')],
    [
      'the transform idiom, which reproduces nothing from memory',
      shell("sed 's/x/y/' app.ts > app.ts.tmp && mv app.ts.tmp app.ts")
    ],
    ['an unforced link, which fails rather than replaces', shell('ln -s other.ts app.ts')],
    [
      'a redirect at the container root, which is a different file',
      shell('echo x > app.ts', { cwd: '' })
    ]
  ])('does not touch %s', async (_shape, args) => {
    const { executed, run } = await turn(
      { 'workspace/app.ts': tall(400), 'workspace/other.ts': tall(3) },
      WINDOWED
    );

    await run('shell', args);
    expect(executed).toHaveLength(1);
  });
});
