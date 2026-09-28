import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertOpenedInPlace,
  assertUserDataPath,
  clearStagedUploads,
  createWorkspaceFile,
  createWorkspaceFolder,
  ensureWorkspace,
  listFiles,
  readWorkspaceFile,
  readWorkspaceFileLines,
  renameWorkspaceEntry,
  resolveInside,
  stageUserFileForUpload,
  workspacePath,
  workspaceUsage,
  writeWorkspaceFile,
  WorkspaceFileError
} from './files.js';
import { displayedLines, fileIdentity, forgetDisplayedLines, readerFor } from './seen-lines.js';

/**
 * The two tasks a workspace can have in it at once. Every read and every write in this file names
 * which of them it is: a read is evidence about one context window, so a test that did not say
 * whose window it was would be asserting the thing this key exists to deny.
 */
const A = { task: 'task-a' };
const B = { task: 'task-b' };

describe('workspace files', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('rejects path traversal', () => {
    expect(() => resolveInside(root, '../escape')).toThrow('escapes workspace');
    expect(() => resolveInside(root, '..')).toThrow('escapes workspace');
    expect(() => resolveInside(root, 'workspace/../../escape')).toThrow('escapes workspace');
    expect(() => workspacePath(root, '..')).toThrow('Invalid workspace ID');
    expect(() => workspacePath(root, 'release-drill')).toThrow('Invalid workspace ID');
    expect(workspacePath(root, '00000000-0000-4000-8000-000000000001')).toBe(
      path.join(root, '00000000-0000-4000-8000-000000000001')
    );
  });

  /*
   * A step upwards is `..` followed by a separator, or `..` alone. It is not "the name begins with
   * two dots": `..gitignore` and `..backup` are ordinary files inside the tree, and refusing them
   * as an escape answered the agent with an accusation instead of a correction - which is exactly
   * the failure the bare-name fold below exists to stop, arriving through the check that runs
   * before it. The agent creates `workspace/..backup/` from a shell command and then cannot list it.
   */
  it('treats a name that merely starts with two dots as a name, not as a step upwards', () => {
    expect(resolveInside(root, '..gitignore')).toBe(path.join(root, '..gitignore'));
    expect(resolveInside(root, 'workspace/..backup')).toBe(
      path.join(root, 'workspace', '..backup')
    );
    expect(assertUserDataPath(root, '..backup')).toBe(path.join('workspace', '..backup'));
    expect(assertUserDataPath(root, 'workspace/..gitignore')).toBe(
      path.join('workspace', '..gitignore')
    );
  });

  it('exposes user files and artifacts without exposing the guest system or credentials', () => {
    expect(assertUserDataPath(root, 'workspace/project/file.txt')).toBe(
      'workspace/project/file.txt'
    );
    expect(assertUserDataPath(root, '.garden/artifacts/result.png')).toBe(
      '.garden/artifacts/result.png'
    );
    expect(() => assertUserDataPath(root, '/etc/shadow')).toThrow('escapes workspace');
    expect(() => assertUserDataPath(root, '.garden/browser/Cookies')).toThrow(
      'Only workspace files'
    );
    expect(() => assertUserDataPath(root, '.config/gh/hosts.yml')).toThrow('Only workspace files');
  });

  /*
   * The agent's `$HOME` is `.home` at the container root (execution.ts `agentHome`), and it holds
   * the coding CLIs' OAuth credentials and the `.bashrc` the owner's own interactive terminal
   * sources. Nothing at the container root has ever resolved - `isUserData` admits `workspace/` and
   * `.garden/artifacts` alone - so the question this pins is what a BARE name means. Answered no,
   * the way `.garden` and `.config` are answered no, rather than folded into `workspace/.home`,
   * which would be a write that looks like it landed somewhere and did not.
   *
   * The refusal is on the container's own name, not on the string: a project directory the agent
   * genuinely made at `workspace/.home` is still reachable by saying so, and this asserts that too,
   * because a bound that refuses legitimate work is the failure on the other side.
   */
  it('answers a bare .home rather than folding it into the workspace', () => {
    expect(() => assertUserDataPath(root, '.home')).toThrow('Only workspace files');
    expect(() => assertUserDataPath(root, '.home/.bashrc')).toThrow('Only workspace files');
    expect(() => assertUserDataPath(root, '.home/.claude/.credentials.json')).toThrow(
      'Only workspace files'
    );
    expect(assertUserDataPath(root, 'workspace/.home/notes.md')).toBe(
      path.join('workspace', '.home', 'notes.md')
    );
  });

  /*
   * Commands run in `workspace/`, so a bare name has to mean there and not in the container above
   * it. It used to mean the container, which is unwritable, and the agent was told only that the
   * path was wrong - so it burned turns guessing prefixes. The refusals above are the other half:
   * a name that reaches for the container's own directories is still answered, not redirected.
   */
  it('reads a bare name from the directory commands actually run in', () => {
    expect(assertUserDataPath(root, 'machine.md')).toBe(path.join('workspace', 'machine.md'));
    expect(assertUserDataPath(root, 'notes/today.md')).toBe(
      path.join('workspace', 'notes', 'today.md')
    );
    expect(assertUserDataPath(root, '.')).toBe('workspace');
    expect(assertUserDataPath(root)).toBe('workspace');
    // Unchanged: an explicit root still means itself rather than a copy nested under workspace.
    expect(assertUserDataPath(root, 'workspace/machine.md')).toBe(
      path.join('workspace', 'machine.md')
    );
    expect(() => assertUserDataPath(root, 'workspace/../.garden/browser/Cookies')).toThrow(
      'Only workspace files'
    );
  });

  /*
   * The file browser had nothing to print on a folder row and printed the word "Folder" - beside a
   * folder icon - because `lstat` on a directory reports the size of the directory record rather
   * than of what is in it. The count is the one honest thing a folder can say about itself, and it
   * is what the row now shows next to when the folder last changed.
   */
  it('counts what is in a folder, and reports no size for one', async () => {
    await mkdir(path.join(root, 'workspace', 'reports'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'reports', 'q1.csv'), 'a,b\n');
    await writeFile(path.join(root, 'workspace', 'reports', 'q2.csv'), 'a,b\n');
    await writeFile(path.join(root, 'workspace', 'notes.md'), 'hello');
    const entries = (await listFiles(root, 'workspace')) as {
      name: string;
      type: string;
      itemCount?: number;
      modifiedAt: string;
    }[];
    const folder = entries.find((entry) => entry.name === 'reports');
    const file = entries.find((entry) => entry.name === 'notes.md');
    expect(folder).toMatchObject({ type: 'directory', itemCount: 2 });
    // Files carry no count at all, so nothing downstream can mistake one for a size.
    expect(file?.itemCount).toBeUndefined();
    expect(Date.parse(folder?.modifiedAt ?? '')).not.toBeNaN();
  });

  /* A folder the listing cannot read still appears - the row says less rather than the whole
     listing failing on one directory the agent's account was denied. */
  it('leaves an unreadable folder without a count instead of failing the listing', async () => {
    await mkdir(path.join(root, 'workspace', 'locked'));
    await chmod(path.join(root, 'workspace', 'locked'), 0o000);
    try {
      const entries = (await listFiles(root, 'workspace')) as {
        name: string;
        itemCount?: number;
      }[];
      const locked = entries.find((entry) => entry.name === 'locked');
      expect(locked).toBeDefined();
      // Running as root reads it anyway, which is a legitimate outcome rather than a failure.
      expect(locked?.itemCount === undefined || locked?.itemCount === 0).toBe(true);
    } finally {
      await chmod(path.join(root, 'workspace', 'locked'), 0o700);
    }
  });

  it('writes inside the workspace, leaving nothing of a longer earlier version', async () => {
    const result = await writeWorkspaceFile(
      root,
      'workspace/result.txt',
      Buffer.from('the long first draft'),
      100
    );
    expect(result.sizeBytes).toBe(20);
    // The descriptor is opened without O_TRUNC so a raced path can be refused before anything is
    // destroyed, which makes the truncation this file's own job rather than the kernel's.
    await writeWorkspaceFile(root, 'workspace/result.txt', Buffer.from('ok'), 100);
    expect(await readFile(path.join(root, 'workspace', 'result.txt'), 'utf8')).toBe('ok');
  });

  /*
   * A compare-and-swap write must land the bytes it was given and nothing else.
   *
   * `handle.writeFile` writes at the descriptor's current position, and reading the old content to
   * check the hash leaves that position at the end of the file - so every write that claimed a hash
   * produced the old file's length in zero bytes followed by the new content. Both callers that
   * claim one are the ones that matter: the owner saving in the file browser, and every `file_patch`
   * since the patch path started claiming its read. Nothing caught it because a file with a hole in
   * front of it still contains every string a test looked for, so this one weighs the file.
   */
  it('replaces the file with exactly the bytes it was given, hash claimed or not', async () => {
    await writeWorkspaceFile(root, 'workspace/notes.md', Buffer.from('the long first draft'), 100);
    const read = await readWorkspaceFile(root, 'workspace/notes.md', 100);
    await writeWorkspaceFile(root, 'workspace/notes.md', Buffer.from('short'), 100, read.sha256);
    const after = await readFile(path.join(root, 'workspace', 'notes.md'));
    expect(after.length).toBe(5);
    expect(after.toString('utf8')).toBe('short');
  });

  it('hands the browser only files the user could already see in the file browser', async () => {
    await writeWorkspaceFile(root, 'workspace/cv.pdf', Buffer.from('cv'), 10);
    const staged = await stageUserFileForUpload(root, 'workspace/cv.pdf', 1024);
    // The name the site is told, and the bytes, are the file's own.
    expect(path.basename(staged)).toBe('cv.pdf');
    expect(await readFile(staged, 'utf8')).toBe('cv');
    // The browser opens this name when the form is submitted, so no part of it may be a name the
    // agent's account can repoint: the copy sits under the runner-only half of the workspace.
    expect(staged.startsWith(path.join(root, '.garden', 'uploads') + path.sep)).toBe(true);
    expect(path.relative(root, staged).startsWith('workspace')).toBe(false);
    expect((await lstat(path.dirname(staged))).mode & 0o077).toBe(0);

    // An upload must never become a way to read the host or the browser profile.
    await expect(stageUserFileForUpload(root, '../../../etc/passwd', 1024)).rejects.toThrow(
      'escapes workspace'
    );
    await expect(stageUserFileForUpload(root, '/etc/passwd', 1024)).rejects.toThrow(
      'escapes workspace'
    );
    await expect(stageUserFileForUpload(root, '.garden/browser/Cookies', 1024)).rejects.toThrow(
      'Only workspace files'
    );
    await expect(stageUserFileForUpload(root, 'workspace', 1024)).rejects.toThrow(
      'not a regular file'
    );
    const outside = await mkdtemp(path.join(tmpdir(), 'garden-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'outside');
      await symlink(outside, path.join(root, 'workspace', 'escape'));
      await expect(
        stageUserFileForUpload(root, 'workspace/escape/secret.txt', 1024)
      ).rejects.toThrow('Symbolic links are not allowed');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    await clearStagedUploads(root);
    await expect(stat(path.join(root, '.garden', 'uploads'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('refuses a descriptor the path no longer names', async () => {
    // The symbolic-link walk and the kernel's own resolution are two separate answers to the same
    // question, and between them the agent's account can turn a directory it owns into a link into
    // `.garden`. An open that resolved through such a component hands back a descriptor for a
    // file the path does not name - which is exactly the second case here.
    await writeWorkspaceFile(root, 'workspace/mine.md', Buffer.from('mine'), 100);
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=live');
    const handle = await open(path.join(root, 'workspace', 'mine.md'), 'r');
    try {
      await expect(
        assertOpenedInPlace(root, path.join(root, 'workspace', 'mine.md'), handle)
      ).resolves.toBeUndefined();
      await expect(
        assertOpenedInPlace(root, path.join(root, '.garden', 'browser', 'Cookies'), handle)
      ).rejects.toThrow('changed while it was being opened');
    } finally {
      await handle.close();
    }
  });

  it('rejects symbolic-link escapes for reads and writes', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'garden-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'outside');
      await symlink(outside, path.join(root, 'workspace', 'escape'));
      await expect(
        writeWorkspaceFile(root, 'workspace/escape/changed.txt', Buffer.from('no'), 10)
      ).rejects.toThrow('Symbolic links are not allowed');
      await expect(readWorkspaceFile(root, 'workspace/escape/secret.txt', 100)).rejects.toThrow(
        'Symbolic links are not allowed'
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('a whole-file write that claims what it is replacing', () => {
  it('reserves a new artifact atomically without replacing a competing writer', async () => {
    const results = await Promise.allSettled([
      createWorkspaceFile(root, 'workspace/export.txt', Buffer.from('first'), 100),
      createWorkspaceFile(root, 'workspace/export.txt', Buffer.from('second'), 100)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toMatchObject({ code: 'EEXIST' });
    expect(['first', 'second']).toContain(
      await readFile(path.join(root, 'workspace/export.txt'), 'utf8')
    );
  });

  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  /*
   * `file_write` is a read-modify-write with the read done in an earlier step, and at least three
   * writers share this tree: the agent's own shell, a second worker slot, and the owner in the file
   * browser. A whole-file write does not fail on a concurrent change - it silently discards it.
   */
  it('refuses when the file moved on after it was read', async () => {
    const target = path.join(root, 'workspace', 'notes.md');
    await writeFile(target, 'the version that was read\n');
    const read = await readWorkspaceFile(root, 'workspace/notes.md', 1_000_000);

    // Somebody else writes between the read and the write.
    await writeFile(target, 'a change made by the owner in the file browser\n');

    await expect(
      writeWorkspaceFile(
        root,
        'workspace/notes.md',
        Buffer.from('agent rewrite\n'),
        1_000_000,
        read.sha256
      )
    ).rejects.toThrow(/changed after you read it/);
    // And the other writer's change is still there.
    expect(await readFile(target, 'utf8')).toContain('file browser');
  });

  it('writes when the claim still holds, and when nothing is claimed at all', async () => {
    await writeFile(path.join(root, 'workspace', 'notes.md'), 'original\n');
    const read = await readWorkspaceFile(root, 'workspace/notes.md', 1_000_000);
    await expect(
      writeWorkspaceFile(
        root,
        'workspace/notes.md',
        Buffer.from('rewritten\n'),
        1_000_000,
        read.sha256
      )
    ).resolves.toMatchObject({ sizeBytes: 10 });

    // No claim: a first write, or a write to something this turn never read. Demanding a hash
    // everywhere would refuse every file this computer creates.
    await expect(
      writeWorkspaceFile(root, 'workspace/new.md', Buffer.from('fresh\n'), 1_000_000)
    ).resolves.toMatchObject({ sizeBytes: 6 });
  });

  it.each([
    { name: 'a populated file', content: 'the version that was read\n', removeParent: false },
    { name: 'an empty file', content: '', removeParent: false },
    { name: 'the containing directory', content: 'the version that was read\n', removeParent: true }
  ])(
    'refuses without recreating anything after deletion of $name',
    async ({ content, removeParent }) => {
      const directory = path.join(root, 'workspace', 'project');
      const target = path.join(directory, 'notes.md');
      await mkdir(directory);
      await writeFile(target, content);
      const read = await readWorkspaceFile(root, 'workspace/project/notes.md', 1_000_000);
      await rm(removeParent ? directory : target, { recursive: true });

      const refusal = await writeWorkspaceFile(
        root,
        'workspace/project/notes.md',
        Buffer.from('stale rewrite\n'),
        1_000_000,
        read.sha256,
        A
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(WorkspaceFileError);
      expect(refusal).toMatchObject({ status: 409 });
      expect((refusal as Error).message).toContain('changed after you read it');
      await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      if (removeParent) await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
});

describe('reading a window of a file', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  /*
   * `file_read` asks for a few hundred lines. It used to be answered by reading the whole file:
   * against the 2 GiB ceiling the installer sets, one look at a database dump buffered a gigabyte
   * inside a service the unit caps at 80% of host memory, and the OOM killer takes the runner down
   * with every other tool running on it. What a read costs must follow what was asked for.
   */
  it('reads a window without pulling the rest of the file into memory', async () => {
    const line = `${'x'.repeat(999)}\n`;
    // 40 MB: small enough to write quickly, large enough that buffering it would show.
    const lines = 40_000;
    await writeFile(path.join(root, 'workspace', 'huge.log'), line.repeat(lines));

    const before = process.memoryUsage().heapUsed;
    const window = await readWorkspaceFileLines(root, 'workspace/huge.log', {
      startLine: 10,
      endLine: 14,
      maxBytes: 1_000_000,
      shownTo: A
    });
    const grew = process.memoryUsage().heapUsed - before;

    expect(window.content.toString('utf8').split('\n')).toHaveLength(5);
    expect(window.startLine).toBe(10);
    expect(window.endLine).toBe(14);
    expect(window.sizeBytes).toBe(lines * 1000);
    // Stopped early, so it cannot know the total without reading what it exists to avoid.
    expect(window.totalLines).toBeUndefined();
    expect(window.nextStartLine).toBe(15);
    // The whole file is 40 MB; a read of five lines must not have cost anything like it.
    expect(grew).toBeLessThan(8 * 1024 * 1024);
  });

  it('reports the total only when it actually reached the end', async () => {
    await writeFile(path.join(root, 'workspace', 'small.txt'), 'one\ntwo\nthree');
    const all = await readWorkspaceFileLines(root, 'workspace/small.txt', {
      startLine: 1,
      endLine: 100,
      maxBytes: 1_000_000,
      shownTo: A
    });
    expect(all.content.toString('utf8')).toBe('one\ntwo\nthree');
    expect(all.totalLines).toBe(3);
    expect(all.nextStartLine).toBeUndefined();
    expect(all.truncated).toBe(false);
  });

  it('stops at maxBytes and says where to continue', async () => {
    await writeFile(
      path.join(root, 'workspace', 'wide.txt'),
      Array.from({ length: 50 }, (_, index) => `${index}:${'y'.repeat(200)}`).join('\n')
    );
    const capped = await readWorkspaceFileLines(root, 'workspace/wide.txt', {
      startLine: 1,
      endLine: 50,
      maxBytes: 500,
      shownTo: A
    });
    expect(capped.truncated).toBe(true);
    expect(capped.content.length).toBeLessThanOrEqual(500);
    // Resumes AT the line the budget cut in half, not after it: the half that did not fit is read
    // again whole rather than silently dropped. Without this the caller is told the read was
    // truncated and given nowhere to continue from, which is a dead end dressed as a bound.
    expect(capped.nextStartLine).toBeGreaterThan(1);
    const rest = await readWorkspaceFileLines(root, 'workspace/wide.txt', {
      startLine: capped.nextStartLine!,
      endLine: 50,
      maxBytes: 1_000_000,
      shownTo: A
    });
    expect(rest.content.toString('utf8').split('\n')[0]).toMatch(/^\d+:y+$/);
  });

  /*
   * The two ways a window can end early, which are not the same fact and were reported as one.
   *
   * `truncated` says the window stopped before what was asked for. It does not say whether the
   * budget ran out inside a line or exactly between two of them, and the seen-line record turns on
   * precisely that: a line delivered in half was not displayed, and a line delivered whole was,
   * even when there was no room to start the next one. Reading the record off `truncated` marked
   * the last whole line of every budget-aligned window unseen - a hole one line wide that no amount
   * of paging could close, because the reader's own `nextStartLine` steps over it.
   *
   * The file below is built so the budget lands exactly on a line boundary: 35 characters and a
   * newline is 36 bytes, so 10 lines are 360 and line 11 cannot begin.
   */
  it('counts the last line of a window the budget ended between, and not one it ended inside', async () => {
    forgetDisplayedLines();
    const row = (index: number): string => `r${String(index).padStart(34, '0')}`;
    const target = path.join(root, 'workspace', 'aligned.txt');
    await writeFile(
      target,
      `${Array.from({ length: 40 }, (_, index) => row(index + 1)).join('\n')}\n`
    );

    const between = await readWorkspaceFileLines(root, 'workspace/aligned.txt', {
      startLine: 1,
      endLine: 40,
      maxBytes: 360,
      shownTo: A
    });
    expect(between.truncated).toBe(true);
    expect(between.partialLine).toBe(false);
    expect(between.content.toString('utf8').split('\n')).toHaveLength(10);
    // Line 10 arrived whole, so it is recorded, and the next read starts after it rather than on
    // it. Those two have to agree or paging leaves a gap behind.
    expect(between.endLine).toBe(10);
    expect(between.nextStartLine).toBe(11);
    expect(displayedLines(A, target, fileIdentity(await stat(target)))).toEqual([
      { start: 1, end: 10 }
    ]);

    forgetDisplayedLines();
    const inside = await readWorkspaceFileLines(root, 'workspace/aligned.txt', {
      startLine: 1,
      endLine: 40,
      maxBytes: 370,
      shownTo: A
    });
    expect(inside.truncated).toBe(true);
    expect(inside.partialLine).toBe(true);
    // The eleventh line is handed over cut short - the caller asked for it - and is not vouched for.
    expect(inside.endLine).toBe(11);
    expect(inside.nextStartLine).toBe(11);
    expect(displayedLines(A, target, fileIdentity(await stat(target)))).toEqual([
      { start: 1, end: 10 }
    ]);
  });

  /*
   * The two read arms have to record the same lines for the same delivered prefix, because the two
   * seen-line ledgers are asked the same question about it. They disagreed by one whenever the
   * budget fell on a line boundary: the whole-file display arm counted the last whole line and the
   * ranged one did not.
   */
  it('records the same lines as the whole-file display arm for the same delivered prefix', async () => {
    const row = (index: number): string => `r${String(index).padStart(34, '0')}`;
    const target = path.join(root, 'workspace', 'agree.txt');
    await writeFile(
      target,
      `${Array.from({ length: 40 }, (_, index) => row(index + 1)).join('\n')}\n`
    );
    const identity = fileIdentity(await stat(target));

    forgetDisplayedLines();
    await readWorkspaceFile(root, 'workspace/agree.txt', 10_000_000, {
      maxBytes: 360,
      maxLines: 800,
      shownTo: A
    });
    const whole = displayedLines(A, target, identity);

    forgetDisplayedLines();
    await readWorkspaceFileLines(root, 'workspace/agree.txt', {
      startLine: 1,
      endLine: 800,
      maxBytes: 360,
      shownTo: A
    });
    expect(displayedLines(A, target, identity)).toEqual(whole);
    expect(whole).toEqual([{ start: 1, end: 10 }]);
  });

  it('advances past one line that is longer than the whole budget, rather than looping on it', () => {
    // The single case with nowhere clean to go: resuming at the line would return the same half
    // forever. It advances and reports `truncated`, which is the only honest answer left.
    return writeFile(path.join(root, 'workspace', 'one-long.txt'), `${'z'.repeat(4_000)}\nnext\n`)
      .then(() =>
        readWorkspaceFileLines(root, 'workspace/one-long.txt', {
          startLine: 1,
          endLine: 10,
          maxBytes: 100,
          shownTo: A
        })
      )
      .then((first) => {
        expect(first.truncated).toBe(true);
        expect(first.nextStartLine).toBe(2);
      });
  });
});

/*
 * A read that says it is a display, which is the only kind that counts as having shown anything.
 *
 * The route answers two callers that used to be identical on the wire: an unbounded `file_read`,
 * which puts lines in front of a model, and the read `file_patch` makes to match against, which puts
 * nothing in front of anybody. Recording neither of them made the guard below refuse edits to lines
 * the model HAD been shown; recording both would make it inert for the tool it exists to guard. So a
 * caller that is about to display what it gets says so by naming the budget it will display within,
 * and gets back that much of the file and no more.
 */
describe('a read that carries a display budget', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-runner-'));
    await ensureWorkspace(root);
    forgetDisplayedLines();
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('hands back the prefix that fits and the hash of the whole file', async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
    const whole = `${lines.join('\n')}\n`;
    await writeFile(path.join(root, 'workspace', 'app.ts'), whole);

    const read = await readWorkspaceFile(root, 'workspace/app.ts', 1_000_000, {
      maxBytes: 1_000_000,
      maxLines: 50,
      shownTo: A
    });

    expect(read.displayedLines).toBe(50);
    expect(read.partialLine).toBe(false);
    // 401 rather than 400: lines are separated by newlines, so a file ending in one has a final
    // empty line, and the numbers a read hands out have to mean what `toLines` means by them.
    expect(read.totalLines).toBe(401);
    expect(read.content.toString('utf8').split('\n')).toHaveLength(50);
    // The hash is of the FILE. It is the claim a later write makes about what it is replacing, and
    // a digest of a prefix would be a claim about nothing at all.
    expect(read.sha256).toBe(createHash('sha256').update(whole).digest('hex'));
  });

  it('counts the last line of a file that does not end in a newline as a line it showed', async () => {
    // The boundary that decides whether a small file with no trailing newline is treated as fully
    // read. Getting it wrong here refuses every write to one of them, forever, with no way out.
    await writeFile(path.join(root, 'workspace', 'notes.md'), 'one\ntwo\nthree');
    const read = await readWorkspaceFile(root, 'workspace/notes.md', 1_000_000, {
      maxBytes: 1_000_000,
      maxLines: 800,
      shownTo: A
    });
    expect(read.totalLines).toBe(3);
    expect(read.displayedLines).toBe(3);
    expect(read.content.toString('utf8')).toBe('one\ntwo\nthree');
  });

  it('shows the start of a line longer than the whole budget and vouches for none of it', async () => {
    /*
     * A file with no newlines in it is not an exemption from the budget, it is the case that proves
     * the budget is about bytes delivered rather than lines delivered.
     * `apps/desktop/src-tauri/gen/schemas/acl-manifests.json` is 76,478 bytes on one line. An answer
     * of no lines would be a dead end the caller cannot act on, so the start of the line is
     * delivered - and it is not counted, for the same reason the ranged reader does not count the
     * line its byte budget cut in half.
     */
    await writeFile(path.join(root, 'workspace', 'acl.json'), 'x'.repeat(76_478));
    const read = await readWorkspaceFile(root, 'workspace/acl.json', 1_000_000, {
      maxBytes: 18_000,
      maxLines: 800,
      shownTo: A
    });

    expect(read.content.length).toBe(18_000);
    expect(read.displayedLines).toBe(0);
    expect(read.partialLine).toBe(true);
    expect(read.totalLines).toBe(1);
    const target = path.join(root, 'workspace', 'acl.json');
    expect(displayedLines(A, target, fileIdentity(await stat(target)))).toBeUndefined();
  });

  it('never cuts a character in half, whatever the budget lands on', async () => {
    // The budget is in bytes and the file is not. A cut through a multi-byte character would hand
    // back a replacement character the caller would then display as if the file contained one.
    await writeFile(path.join(root, 'workspace', 'poem.txt'), '€'.repeat(400));
    const read = await readWorkspaceFile(root, 'workspace/poem.txt', 1_000_000, {
      maxBytes: 100,
      maxLines: 800,
      shownTo: A
    });
    expect(read.content.length).toBe(99);
    expect(read.content.toString('utf8')).toBe('€'.repeat(33));
  });

  it('says nothing about a file when no budget was named', async () => {
    // `file_patch` reads the whole file one call before its write, to match against. If that counted
    // as a display, every patch would announce that the model had just seen the whole file and the
    // guard would be inert for the one tool it exists to guard.
    await writeFile(path.join(root, 'workspace', 'app.ts'), 'a\nb\nc\n');
    const read = await readWorkspaceFile(root, 'workspace/app.ts', 1_000_000);
    expect(read.totalLines).toBeUndefined();
    const target = path.join(root, 'workspace', 'app.ts');
    expect(displayedLines(A, target, fileIdentity(await stat(target)))).toBeUndefined();
  });
});

describe('renaming and folders', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('creates a folder, and creating it twice is not an error', async () => {
    expect(await createWorkspaceFolder(root, 'workspace/applications/acme')).toEqual({
      path: path.join('workspace', 'applications', 'acme')
    });
    expect((await stat(path.join(root, 'workspace', 'applications', 'acme'))).isDirectory()).toBe(
      true
    );
    await expect(createWorkspaceFolder(root, 'workspace/applications/acme')).resolves.toEqual({
      path: path.join('workspace', 'applications', 'acme')
    });
  });

  it('refuses to make a folder where a file already lives', async () => {
    await writeWorkspaceFile(root, 'workspace/cv.pdf', Buffer.from('cv'), 100);
    await expect(createWorkspaceFolder(root, 'workspace/cv.pdf')).rejects.toThrow(
      'A file already exists at that path'
    );
    await expect(createWorkspaceFolder(root, 'workspace/cv.pdf')).rejects.toMatchObject({
      status: 409
    });
  });

  it('renames a file and leaves its contents alone', async () => {
    await writeWorkspaceFile(root, 'workspace/draft.md', Buffer.from('# draft'), 100);
    expect(
      await renameWorkspaceEntry(root, 'workspace/draft.md', 'workspace/cover-letter.md')
    ).toEqual({ path: path.join('workspace', 'cover-letter.md') });
    expect(await readFile(path.join(root, 'workspace', 'cover-letter.md'), 'utf8')).toBe('# draft');
  });

  it('never overwrites, because the owner asked for a new name not for a deletion', async () => {
    await writeWorkspaceFile(root, 'workspace/a.md', Buffer.from('keep me'), 100);
    await writeWorkspaceFile(root, 'workspace/b.md', Buffer.from('other'), 100);
    await expect(renameWorkspaceEntry(root, 'workspace/b.md', 'workspace/a.md')).rejects.toThrow(
      'Something already exists at the new name'
    );
    expect(await readFile(path.join(root, 'workspace', 'a.md'), 'utf8')).toBe('keep me');
  });

  it('reports a missing source as missing rather than as a bad request', async () => {
    await expect(
      renameWorkspaceEntry(root, 'workspace/gone.md', 'workspace/here.md')
    ).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the workspace boundary on both ends of a rename', async () => {
    await writeWorkspaceFile(root, 'workspace/a.md', Buffer.from('x'), 100);
    await expect(renameWorkspaceEntry(root, 'workspace/a.md', '../escaped.md')).rejects.toThrow(
      'escapes workspace'
    );
    await expect(renameWorkspaceEntry(root, 'workspace', 'workspace-2')).rejects.toThrow(
      'Workspace root cannot be renamed'
    );
    const outside = await mkdtemp(path.join(tmpdir(), 'garden-outside-'));
    try {
      await symlink(outside, path.join(root, 'workspace', 'escape'));
      await expect(
        renameWorkspaceEntry(root, 'workspace/a.md', 'workspace/escape/a.md')
      ).rejects.toThrow('Symbolic links are not allowed');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes a print target inside the workspace, creating its folder', async () => {
    // What print-to-PDF does now that the bytes come back to the runner instead of the browser
    // being handed a path to open on its own: the boundary check, then an ordinary write.
    const relative = assertUserDataPath(root, 'workspace/applications/cv.pdf');
    expect(relative).toBe(path.join('workspace', 'applications', 'cv.pdf'));
    await writeWorkspaceFile(root, relative, Buffer.from('%PDF-1.7'), 100);
    expect((await stat(path.join(root, 'workspace', 'applications'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(root, 'workspace', 'applications', 'cv.pdf'), 'utf8')).toBe(
      '%PDF-1.7'
    );
    expect(() => assertUserDataPath(root, '../../etc/cron.d/garden')).toThrow('escapes workspace');
    expect(() => assertUserDataPath(root, '.garden/browser/Cookies')).toThrow(
      'Only workspace files'
    );
    // A traversal that lands back inside is still refused rather than folded into a write.
    expect(() => assertUserDataPath(root, '../garden/escape.pdf')).toThrow('escapes workspace');
  });

  it('carries a status the file browser can act on', () => {
    expect(new WorkspaceFileError('taken', 409).status).toBe(409);
  });

  it('still reports storage when part of the tree belongs to the agent account', async () => {
    // On a real box the agent's own account owns ~/.cache, and GLib creates it at mode 0700 the
    // first time a GUI program runs - so the runner cannot open it. Refusing to report any figure
    // because of one unreadable directory would take the storage reading away from the owner for
    // every workspace that had ever opened a document. chmod 0 reproduces that here without
    // needing two accounts.
    await writeWorkspaceFile(root, 'workspace/notes.txt', Buffer.from('12345'), 100);
    const opaque = path.join(root, '.cache');
    await mkdir(opaque, { recursive: true });
    await writeFile(path.join(opaque, 'inside'), 'hidden');
    await chmod(opaque, 0o000);
    try {
      expect(await workspaceUsage(root)).toBeGreaterThanOrEqual(5);
    } finally {
      await chmod(opaque, 0o700);
    }
  });
});

/*
 * The line a read actually put on screen, and an edit that rests on one it never did.
 *
 * `file_patch` proves `oldText` occurs exactly once in the file. It does not prove the model ever
 * read that part of the file, so a window read of lines 1-50 followed by an anchor at line 300 was
 * indistinguishable from an anchor at line 20: both match, both apply, and one of them is an edit
 * made from memory of a region that was never displayed. Every sequence below is the worker's real
 * one - window read, then the whole-file read `file_patch` makes to match on, then the write that
 * claims the hash from it.
 */
describe('the seen-line guard', () => {
  let root: string;
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
  const file = 'workspace/app.ts';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-runner-'));
    await ensureWorkspace(root);
    forgetDisplayedLines();
    await writeFile(path.join(root, 'workspace', 'app.ts'), `${lines.join('\n')}\n`);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  // One task doing all of it unless a case says otherwise, which is the single-slot workspace.
  const look = (
    startLine: number,
    endLine: number,
    maxBytes = 400_000,
    shownTo = A
  ): Promise<unknown> =>
    readWorkspaceFileLines(root, file, { startLine, endLine, maxBytes, shownTo });
  // What `file_patch` does: read the whole file to match `oldText` on, keep the runner's hash.
  const prepare = async (
    find: string,
    replace: string
  ): Promise<{ content: Buffer; expect: string }> => {
    const read = await readWorkspaceFile(root, file, 10_000_000);
    return {
      content: Buffer.from(read.content.toString('utf8').replace(find, replace)),
      expect: read.sha256
    };
  };
  const write = (patch: { content: Buffer; expect: string }, heldTo = A): Promise<unknown> =>
    writeWorkspaceFile(root, file, patch.content, 10_000_000, patch.expect, heldTo);

  it('applies an edit anchored on a line the read displayed', async () => {
    await look(1, 50);
    await write(await prepare('line 20', 'line 20 // touched'));
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain(
      'line 20 // touched'
    );
  });

  /*
   * THE INVERTED REFUSAL, which is the failure that would have got this guard deleted.
   *
   * The worker's ordinary sequence is an unwindowed read, which displays a bounded prefix, and then
   * a window over the rest. Only the window was recorded here, so the two records of what the model
   * had been shown disagreed about the prefix - and editing line 20, a line the FIRST read had put
   * on screen, was refused by name while editing line 300 sailed through. A guard that refuses
   * legitimate edits gets deleted by the first person it inconveniences and deserves to be. So the
   * positive case is the one asserted first: shown means editable.
   */
  it('applies an edit anchored in the prefix an unwindowed read displayed', async () => {
    const shown = await readWorkspaceFile(root, file, 10_000_000, {
      maxBytes: 1_000_000,
      maxLines: 50,
      shownTo: A
    });
    expect(shown.displayedLines).toBe(50);
    await look(51, 100);

    await write(await prepare('line 20', 'line 20 // touched'));
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain(
      'line 20 // touched'
    );
    // And it has not become permissive on the way: line 300 is past everything either read showed.
    await expect(write(await prepare('line 300', 'line 300 // blind'))).rejects.toMatchObject({
      status: 428
    });
  });

  /*
   * The agent's whole-file write after a WINDOW, which claims no hash because the ranged reader has
   * no whole-file digest to give it. The guard was opened only for callers that claim one, so on the
   * commonest read shape in the harness - 47.4% of 14,314 real reads on this machine - it never ran:
   * measured through the shipped tool on an 8,332-line file, `file_read` of lines 1-200 followed by a
   * whole-file write was accepted and destroyed 8,330 lines.
   */
  it('holds an agent to what it was shown even when it claims no hash', async () => {
    await look(1, 50);
    const blind = Buffer.from(`${lines.join('\n')}\n`.replace('line 300', 'line 300 // blind'));
    await expect(
      writeWorkspaceFile(root, file, blind, 10_000_000, undefined, A)
    ).rejects.toMatchObject({ status: 428 });
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).not.toContain('blind');

    // And it is a guard rather than a wall: the same unclaimed write, aimed at a line that read did
    // show, lands.
    const seen = Buffer.from(`${lines.join('\n')}\n`.replace('line 20', 'line 20 // seen'));
    await writeWorkspaceFile(root, file, seen, 10_000_000, undefined, A);
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain(
      'line 20 // seen'
    );
  });

  /*
   * The refusal has to carry the truth with it. A refusal that costs a round trip is barely better
   * than the wrong edit it prevented: the model re-reads, re-derives the same patch, and the owner
   * pays for two turns to get one edit. So the real text arrives inline, the refusal counts as
   * having shown it, and the same call sent again applies.
   */
  it('refuses an edit anchored on a line no read displayed, and hands back what is there', async () => {
    await look(1, 50);
    const patch = await prepare('line 300', 'line 300 // touched');
    // One attempt, both assertions: the second attempt is the retry, and it is meant to succeed.
    const refusal = await write(patch).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 428 });
    expect((refusal as Error).message).toContain('no read has shown you those lines');
    expect((refusal as Error).message).toContain('300| line 300');
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).not.toContain('touched');
  });

  it('lets the very same call through once the refusal has shown those lines', async () => {
    await look(1, 50);
    const patch = await prepare('line 300', 'line 300 // touched');
    await expect(write(patch)).rejects.toMatchObject({ status: 428 });
    await write(patch);
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain(
      'line 300 // touched'
    );
  });

  /*
   * A file that moved under the caller is a different failure with a different answer, and the
   * compare-and-swap must still be the one that answers it. Telling the model about anchors here
   * would send it back to patch a version that no longer exists, and merging silently would lose
   * the other writer's work - which is what this tree has three other writers to worry about.
   */
  it('lets the compare-and-swap answer a file that changed on disk, rather than the guard', async () => {
    await look(1, 50);
    const patch = await prepare('line 300', 'line 300 // mine');
    await writeFile(
      path.join(root, 'workspace', 'app.ts'),
      `${lines.join('\n')}\n`.replace('line 300', 'line 300 // theirs')
    );
    await expect(write(patch)).rejects.toMatchObject({ status: 409 });
    await expect(write(patch)).rejects.toThrow('changed after you read it');
    // And still, once a fresh window read has given the guard something to say about the file it
    // is now. Both refusals are live at this point and only one of them is true: the model's read
    // is stale, and telling it about anchors would send it back to patch a version that is gone.
    await look(1, 50);
    await expect(write(patch)).rejects.toThrow('changed after you read it');
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain('// theirs');
  });

  /* A line the byte budget cut in half was not displayed; counting it would vouch for the half
   * that never arrived. */
  it('does not vouch for the line a read stopped in the middle of', async () => {
    await writeFile(
      path.join(root, 'workspace', 'app.ts'),
      ['aaa', 'bbb', 'c'.repeat(500), 'ddd', 'eee'].join('\n')
    );
    await look(1, 5, 20);
    await expect(write(await prepare('ccc', 'xxx'))).rejects.toMatchObject({ status: 428 });
    await write(await prepare('bbb', 'BBB'));
  });

  /*
   * Without the record following the file across its own write, the guard is one edit deep: the
   * write changes size and modification time, the identity stops matching, and the next patch - the
   * one aimed at line 300 after the first one tidied line 20 - goes through unexamined.
   */
  it('still guards the second edit of a turn, after its own write moved the file', async () => {
    await look(1, 50);
    await write(await prepare('line 20', 'line 20 // touched'));
    await expect(write(await prepare('line 300', 'line 300 // blind'))).rejects.toMatchObject({
      status: 428
    });
  });

  /*
   * The file browser reads whole files and writes them back and never reads a window. It must be
   * exactly as unguarded as it was, or the owner's second save is refused for lines the first did
   * not touch - and `file_read` without a window is the same request on the wire, so neither can
   * be treated as a display.
   */
  it('has no opinion at all about a file no window read has shown', async () => {
    await write(await prepare('line 300', 'line 300 // from the file browser'));
    await write(await prepare('line 7', 'line 7 // and again'));
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain('and again');
  });

  /*
   * A caller with no hash to offer is not editing from a read. The owner pressing Replace on a file
   * the pane once paged through, an upload landing on a name, a printed document: none of them
   * claimed to have read anything, and refusing them for lines they never pretended to have seen
   * would put a lecture about anchors in front of a person who has no idea what one is.
   */
  it('has nothing to say to a writer that never claimed to have read the file', async () => {
    await look(1, 50);
    await writeWorkspaceFile(root, file, Buffer.from('replaced wholesale\n'), 10_000_000);
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toBe(
      'replaced wholesale\n'
    );
  });

  /* Lines are not what binary is made of, so there are no anchors in it to have seen. */
  it('has nothing to say about binary content', async () => {
    const binary = Buffer.concat([Buffer.from('PDF'), Buffer.from([0]), Buffer.alloc(64, 7)]);
    await writeFile(path.join(root, 'workspace', 'app.ts'), binary);
    await look(1, 5);
    const read = await readWorkspaceFile(root, file, 10_000_000);
    await writeWorkspaceFile(
      root,
      file,
      Buffer.concat([binary, Buffer.from([0, 9, 9])]),
      10_000_000,
      read.sha256
    );
  });

  /*
   * THE FALSE REFUSAL, and it is the shape a model reaches for on a large file: read a window here,
   * read a window there, change one line in each of them in a single patch.
   *
   * What the guard is handed is a whole-file write, so it recovers what changed by comparing the
   * two versions - and comparing only from the two ends answers with the hull from the first change
   * to the last. Measured here before this: one write changing line 20 and line 320, both of them
   * lines a read had displayed, refused with "this edit changes app.ts at line 51-299" - 249 lines
   * it does not touch, named as though it did.
   */
  it('applies one write that changes two lines far apart, both of them shown', async () => {
    await look(1, 50);
    await look(300, 350);
    const read = await readWorkspaceFile(root, file, 10_000_000);
    const after = read.content
      .toString('utf8')
      .replace('line 20\n', 'line 20 // near\n')
      .replace('line 320\n', 'line 320 // far\n');
    await writeWorkspaceFile(root, file, Buffer.from(after), 10_000_000, read.sha256);
    const now = await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8');
    expect(now).toContain('line 20 // near');
    expect(now).toContain('line 320 // far');
  });

  /*
   * And it has not become permissive on the way, which is the direction that matters: the same
   * two-place write, with one of the two places never displayed, is still refused - and the
   * refusal names that place and not the distance between them.
   */
  it('still refuses the far half of a two-place write when no read showed it', async () => {
    await look(1, 50);
    const read = await readWorkspaceFile(root, file, 10_000_000);
    const after = read.content
      .toString('utf8')
      .replace('line 20\n', 'line 20 // near\n')
      .replace('line 320\n', 'line 320 // blind\n');
    const refusal = await writeWorkspaceFile(
      root,
      file,
      Buffer.from(after),
      10_000_000,
      read.sha256,
      A
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 428 });
    expect((refusal as Error).message).toContain('at line 320');
    expect((refusal as Error).message).not.toContain('51-299');
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).not.toContain('// near');
  });

  /*
   * THE ATTACK ON THE SPLIT ITSELF. Reporting several spans instead of one is only safe if every
   * line the write destroys is inside one of them, and the two shapes that could slip through a
   * split that was too clever are both here: a whole-file write that keeps its shown prefix and
   * discards everything after it, and a write that deletes a block in the middle nothing showed.
   * Any line the split calls unchanged is a line present in both versions, so neither can.
   */
  it('refuses a write that discards the part of the file no read reached', async () => {
    await look(1, 50);
    const read = await readWorkspaceFile(root, file, 10_000_000);
    await expect(
      writeWorkspaceFile(
        root,
        file,
        Buffer.from(`${lines.slice(0, 50).join('\n')}\n`),
        10_000_000,
        read.sha256,
        A
      )
    ).rejects.toMatchObject({ status: 428 });

    const gutted = await readWorkspaceFile(root, file, 10_000_000);
    const without = [...lines.slice(0, 200), ...lines.slice(300)].join('\n');
    const refusal = await writeWorkspaceFile(
      root,
      file,
      Buffer.from(`${without}\n`),
      10_000_000,
      gutted.sha256,
      A
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 428 });
    expect((refusal as Error).message).toContain('201-300');
    expect(
      (await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).split('\n')
    ).toHaveLength(401);
  });

  /*
   * The record follows the file across a write that touched it in several places, and each place is
   * carried at the numbers the ones before it moved it to. Without that, the second edit of a turn
   * is either refused for lines the first one shifted or allowed anywhere at all.
   */
  it('carries the record across a write that changed the file in two places and its length', async () => {
    await look(1, 60);
    const read = await readWorkspaceFile(root, file, 10_000_000);
    const after = read.content
      .toString('utf8')
      .replace('line 10\n', 'line 10 // first\nline 10 // and a half\n')
      .replace('line 50\n', 'line 50 // second\n');
    await writeWorkspaceFile(root, file, Buffer.from(after), 10_000_000, read.sha256, A);

    // Line 55 of the new file is line 54 of the old one, which that read displayed: editable.
    const next = await readWorkspaceFile(root, file, 10_000_000);
    await writeWorkspaceFile(
      root,
      file,
      Buffer.from(next.content.toString('utf8').replace('line 54\n', 'line 54 // third\n')),
      10_000_000,
      next.sha256,
      A
    );
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain('// third');

    // And line 300, which nothing has shown, is still refused after both of them.
    const last = await readWorkspaceFile(root, file, 10_000_000);
    await expect(
      writeWorkspaceFile(
        root,
        file,
        Buffer.from(last.content.toString('utf8').replace('line 300\n', 'line 300 // blind\n')),
        10_000_000,
        last.sha256,
        A
      )
    ).rejects.toMatchObject({ status: 428 });
  });

  /*
   * Past a glance, inlining the truth is the wrong answer: dribbling a screenful per round trip
   * costs the owner more than the read would have. The refusal names the range instead, and
   * discloses nothing - so it does not quietly become a pass on the retry.
   */
  it('sends the model to read a range too wide to hand back, and stays refused until it does', async () => {
    await look(1, 5);
    const patch = await prepare(lines.slice(99, 200).join('\n'), 'collapsed');
    await expect(write(patch)).rejects.toThrow('Read it with file_read');
    await expect(write(patch)).rejects.toMatchObject({ status: 428 });
    await look(100, 200);
    await write(await prepare(lines.slice(99, 200).join('\n'), 'collapsed'));
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain('collapsed');
  });
});

/*
 * WHOSE READ IT WAS, which is the question the record was answering with somebody else's answer.
 *
 * A workspace holds more than one writer: a second slot of the same worker, the owner in the Files
 * pane, the agent's own shell. Keyed by resolved path, the record said "this file has been read"
 * when the only question that means anything is "has THIS WRITER been shown these lines" - so task
 * B, which had seen fifty lines, was credited with the four hundred task A had seen, and a
 * whole-file write from B changed a line only A had ever looked at. Measured through this same
 * `writeWorkspaceFile` before the key changed: refused when B was alone in the workspace, landed
 * when A had read the file, and the two runs differed in nothing else.
 *
 * Every case here is the worker's real sequence - window read, the whole-file read `file_patch`
 * makes to match on, then the write that claims the hash from it - and each is asserted in both
 * directions, because a guard that only ever refuses is a guard that gets deleted.
 */
describe('who the seen-line record is about', () => {
  let root: string;
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
  const file = 'workspace/app.ts';
  const onDisk = (): Promise<string> => readFile(path.join(root, 'workspace', 'app.ts'), 'utf8');
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-runner-'));
    await ensureWorkspace(root);
    forgetDisplayedLines();
    await writeFile(path.join(root, 'workspace', 'app.ts'), `${lines.join('\n')}\n`);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  const look = (
    shownTo: { task: string } | undefined,
    startLine: number,
    endLine: number
  ): Promise<unknown> =>
    readWorkspaceFileLines(root, file, { startLine, endLine, maxBytes: 400_000, shownTo });
  const prepare = async (
    ...edits: Array<[string, string]>
  ): Promise<{ content: Buffer; expect: string }> => {
    const read = await readWorkspaceFile(root, file, 10_000_000);
    let after = read.content.toString('utf8');
    for (const [find, replace] of edits) after = after.replace(find, replace);
    return { content: Buffer.from(after), expect: read.sha256 };
  };
  const writeAs = (
    heldTo: { task: string } | undefined,
    patch: { content: Buffer; expect: string }
  ): Promise<unknown> =>
    writeWorkspaceFile(root, file, patch.content, 10_000_000, patch.expect, heldTo);

  /*
   * THE ATTACK. B has read fifty lines and A has read four hundred, and B aims a whole-file write
   * at line 300. B's own ledger in the worker is per-task and correctly has nothing to say for it;
   * the runner's was per-path and answered with A's reading, so the write landed. The two tasks are
   * deliberately given overlapping reads of the same file, because the crediting is only visible
   * where B has a record of its own to be topped up.
   */
  it('refuses task B the line that only task A was ever shown', async () => {
    await look(B, 1, 50);
    await look(A, 1, 401);
    const patch = await prepare(['line 300', 'line 300 // from B']);
    await expect(writeAs(B, patch)).rejects.toMatchObject({ status: 428 });
    expect(await onDisk()).not.toContain('from B');
  });

  /* The same write, from the task that actually read the file, has to land. */
  it('lets task A write the line that task A was shown', async () => {
    await look(B, 1, 50);
    await look(A, 1, 401);
    await writeAs(A, await prepare(['line 300', 'line 300 // from A']));
    expect(await onDisk()).toContain('line 300 // from A');
  });

  /*
   * A file paged end to end stays writable whole - the case commit 13a05c4 got right, and the one
   * a per-reader key could quietly have broken by scattering one task's four windows across four
   * records. It is the same four windows and the same whole-file write; only the reader is asserted.
   */
  it('lets a task that paged the whole file rewrite the whole file', async () => {
    for (const [from, to] of [
      [1, 100],
      [101, 200],
      [201, 300],
      [301, 401]
    ] as const)
      await look(A, from, to);
    await writeAs(
      A,
      await prepare(
        ['line 20', 'line 20 // top'],
        ['line 200', 'line 200 // middle'],
        ['line 380', 'line 380 // bottom']
      )
    );
    const now = await onDisk();
    expect(now).toContain('line 20 // top');
    expect(now).toContain('line 200 // middle');
    expect(now).toContain('line 380 // bottom');
  });

  /* And the paging is A's. B, which paged nothing, is not carried by it. */
  it("does not let one task's paging make the file writable by another", async () => {
    for (const [from, to] of [
      [1, 100],
      [101, 200],
      [201, 300],
      [301, 401]
    ] as const)
      await look(A, from, to);
    await look(B, 1, 50);
    const patch = await prepare(['line 380', 'line 380 // from B']);
    await expect(writeAs(B, patch)).rejects.toMatchObject({ status: 428 });
    expect(await onDisk()).not.toContain('from B');
  });

  /*
   * The refusal is a display, so it counts as a read - for the task it was handed to. It arrives in
   * one task's tool result and nowhere else, and crediting the workspace with it would hand the
   * second task lines that were printed into the first one's context window.
   */
  it('counts a refusal as a read for the task that was shown it, and for no other', async () => {
    await look(A, 1, 50);
    await look(B, 1, 50);
    const patch = await prepare(['line 300', 'line 300 // touched']);
    await expect(writeAs(A, patch)).rejects.toMatchObject({ status: 428 });
    // B was told nothing, so B is still refused - and A, which was shown the text, now applies.
    await expect(writeAs(B, patch)).rejects.toMatchObject({ status: 428 });
    await writeAs(A, patch);
    expect(await onDisk()).toContain('line 300 // touched');
  });

  /*
   * THE OWNER IN THE FILES PANE, which is what the role decides and `readerFor` reasons about.
   *
   * This is her sequence, and it is the shipped one: the pane pages a file through the WINDOWED
   * read - `apps/api` forwards `startLine`, `endLine` and `maxBytes` on the same route the agent
   * uses, and `apps/web` asks for a window whenever a file is past its preview limit - and then she
   * presses Replace, which claims a hash. That windowed read used to file a record unconditionally,
   * under the path, for anyone at all to be answered with.
   *
   * She is not a reader, so she files nothing and is held to nothing. Making her one instead is the
   * tempting symmetry, and it puts her saves inside a guard built for a model editing from a window:
   * her second save is refused for lines her first did not touch, and the refusal is a lecture about
   * anchors in front of a person who has no idea what one is.
   */
  it('holds the owner to nothing, whatever the pane paged for her', async () => {
    const owner = readerFor({ role: 'user', sub: 'owner-1' });
    await look(owner, 1, 50);
    await writeAs(owner, await prepare(['line 300', 'line 300 // from the pane']));
    expect(await onDisk()).toContain('line 300 // from the pane');
  });

  /*
   * And her paging is hers. Before the key, the pane paging a large file put a record at that path
   * and the next agent write was measured against it - the same defect as the two-task one, with the
   * owner as the source of the credit rather than another task.
   */
  it("lends the owner's paging to nobody", async () => {
    await look(readerFor({ role: 'user', sub: 'owner-1' }), 1, 401);
    await look(A, 1, 50);
    const patch = await prepare(['line 320', 'line 320 // from A']);
    await expect(writeAs(A, patch)).rejects.toMatchObject({ status: 428 });
    expect(await onDisk()).not.toContain('from A');

    // The same agent, held to a line it did read, still writes.
    await writeAs(A, await prepare(['line 20', 'line 20 // from A']));
    expect(await onDisk()).toContain('line 20 // from A');
  });
});
