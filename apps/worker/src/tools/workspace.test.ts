import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GardenError } from '@garden/core';
import { type ModelToolCall } from '@garden/model-gateway';
import { countPostEditPaths, executeWorkspaceTool, forgetPostEditChecks } from './workspace.js';
import { POST_EDIT_CHECKED_LANGUAGES } from './diagnostics.js';
import { forgetReads, recordRead, toLines } from '../edit/index.js';
import { RECENT_TOOL_OUTPUT_CHARS, serializeToolResultForModel } from '../context.js';
import { type AgentState } from '../agent-state.js';
import { CHECKPOINT_EXEMPT_TOOLS } from '../turn-bounds.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * `file_patch` end to end, on the bytes - the line-addressed editor as the model actually reaches it.
 *
 * `tool-dispatch.test.ts` already covers the runner calls a patch makes - the read, the write, the
 * usage re-read - and `edit/edit.test.ts` covers the parser and the applier as units. Nothing here
 * re-tests those. What is tested here is what the shipped ARM does to a file on disk, because an
 * applier that is right and an arm that hands it the wrong snapshot are indistinguishable until
 * somebody reads the file.
 *
 * Every case below is a shape a model actually emits, and the file this replaced tested the quoted
 * editor's move the same way for the same reason. Driven through `executeWorkspaceTool` itself
 * rather than through the dispatch table, so what is under test is the shipped arm and not a model
 * of it. The runner is a two-method fake holding one file in memory; every assertion is about what
 * that file says afterwards.
 */

/** The file the patches are made against: two functions, the second used by the first. */

/**
 * One `file_patch` call against an in-memory tree, with the reads the turn has already made.
 *
 * The reads are stood up through `recordRead`, which is the same function `file_read` calls one
 * arm over - a line number means nothing without a record of what was shown under it, and a test
 * that skipped this would only ever exercise the refusal.
 *
 * Only four of the eighteen fields on a `ToolContext` are reachable from this arm - the task, the
 * runner, the store's storage counter and the turn state that remembers a file's hash - so the
 * other fourteen are deliberately absent rather than stubbed: standing them up would be fourteen
 * ways for this file to go red for a reason that has nothing to do with a patch.
 */
/*
 * The armed post-edit checks are module state keyed by task id, and every helper below drives the
 * same task id, so without this a check left armed by one test would attach its `diagnostics` to
 * an unrelated patch result in the next one. It was harmless only by accident until now - the
 * older helpers hand the runner a stub that makes the arm's directory walk throw, and the tests
 * that do arm sit last in the file - and both of those accidents are one fixture change or one
 * `sequence.shuffle` away from not holding. Reads are NOT cleared here: the helpers clear those
 * themselves, per call rather than per test, and several tests call a helper twice.
 */
beforeEach(() => {
  forgetPostEditChecks();
});

describe('malformed invocation recovery', () => {
  it.each([{}, { command: 'echo fixture' }, { executable: ' ' }])(
    'refuses a missing executable before reaching the runner: %j',
    async (args) => {
      const call = vi.fn();
      const context = {
        task: { id: 'missing-executable', workspaceId: 'fixture' },
        state: {},
        runner: { call }
      } as unknown as ToolContext;
      await expect(
        executeWorkspaceTool(context, { id: 'invalid-shell', name: 'shell', arguments: args })
      ).rejects.toMatchObject({ code: 'shell_invalid' });
      expect(call).not.toHaveBeenCalled();
    }
  );
});

/**
 * The display bound on an unwindowed `file_read`, and the rule about what a bounded read authorises.
 *
 * These two are one feature and are tested together on purpose. A bound on the display alone makes
 * this vertical strictly more dangerous, not less: the model is shown a prefix, and the hash the
 * same read leaves behind still authorises replacing every line of the file - including the ones
 * the bound has just stopped it from seeing. The measurement that started this is in the first case
 * below; the one that decides whether the change was worth making is `destroys the remainder`.
 *
 * Driven through `executeWorkspaceTool` for the same reason the patch cases above are: what is under
 * test is the shipped arm, and a bound proved against a model of the arm is a bound nobody has.
 */
const HASH = 'sha-of-the-whole-file';

interface Read {
  readonly result: Record<string, unknown>;
  readonly state: AgentState;
  readonly written: Map<string, string>;
  readonly run: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * One turn against an in-memory tree, with the calls made in order and the state carried between
 * them. The state is what carries a read's claim to the write that follows it, so a helper that
 * built a fresh one per call would test every guard here against a turn that never happened.
 */
/**
 * What one line costs a budget, the way the runner counts it.
 *
 * Lines are separated by newlines rather than terminated by them, so every line but the file's last
 * carries its separator and the last one carries nothing. One byte, and it is the difference between
 * this fake and the reader it stands in for - which is the difference that produced the defect these
 * cases exist about, so it is not rounded off here.
 */
const lineCost = (line: string, isLast: boolean): number =>
  Buffer.byteLength(line, 'utf8') + (isLast ? 0 : 1);

/** How many leading lines of `text` fit a display budget, whole. `services/…/files.ts` decides it. */
const fitting = (
  lines: readonly string[],
  budget: { maxBytes: number; maxLines: number },
  from = 0
): number => {
  let bytes = 0;
  let taken = 0;
  while (from + taken < lines.length && taken < budget.maxLines) {
    const cost = lineCost(lines[from + taken] ?? '', from + taken === lines.length - 1);
    if (bytes + cost > budget.maxBytes) break;
    bytes += cost;
    taken += 1;
  }
  return taken;
};

const turn = async (
  files: Record<string, string>,
  calls: Array<{ name: string; args: Record<string, unknown> }>
): Promise<Read> => {
  forgetReads();
  const written = new Map<string, string>(Object.entries(files));
  const state = {} as AgentState;
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-read', userId: 'user-1' },
    state,
    key: new Uint8Array(32).fill(7),
    store: { setWorkspaceStorage: async () => undefined, appendTaskEvent: async () => undefined },
    runner: {
      readFileWithHash: async (_w: string, _t: string, path: string) => {
        const content = written.get(path);
        if (content === undefined) throw new Error(`no such file ${path}`);
        return { content, sha256: HASH };
      },
      /*
       * The display read as the runner performs it: the prefix that fits, the whole file's hash, and
       * how much of what came back arrived whole. The arm cannot show what it was not sent, which is
       * the property this fake has to preserve to be worth testing against - a fake that handed back
       * the file and let the arm choose would be testing the arrangement that had the two ledgers
       * disagreeing in the first place.
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
        const whole = fitting(all, budget);
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
      /*
       * The ranged reader, cutting only on line boundaries. The half-line case it also has is left
       * to `services/workspace-runner/src/files.test.ts`, where the real reader is: standing a
       * second implementation of it up here would be two things to keep in agreement rather than one.
       *
       * `truncated` and `partialLine` are still both reported, and honestly, because THE DIFFERENCE
       * BETWEEN THEM IS WHAT THIS FAKE GOT WRONG. It used to answer `truncated: false` to every
       * window, including the ones the byte budget ended - so the arm's record of what it had shown
       * was derived from a flag that was never set here, and a defect that cost a line per window
       * was invisible to all thirty cases below while `services/workspace-runner` and this file
       * both stayed green. A window this reader ends between two lines is truncated and carries no
       * half-line; only the real reader produces the other combination.
       */
      readFileLines: async (
        _w: string,
        _t: string,
        path: string,
        window: { startLine: number; endLine: number; maxBytes: number }
      ) => {
        const all = toLines(written.get(path) ?? '');
        const asked = Math.max(0, Math.min(window.endLine, all.length) - window.startLine + 1);
        const taken = Math.min(
          asked,
          fitting(all, { maxBytes: window.maxBytes, maxLines: asked }, window.startLine - 1)
        );
        const endLine = window.startLine + Math.max(taken, 1) - 1;
        const reachedEnd = window.startLine - 1 + taken >= all.length;
        return {
          content: all.slice(window.startLine - 1, window.startLine - 1 + taken).join('\n'),
          startLine: window.startLine,
          endLine,
          ...(reachedEnd ? { totalLines: all.length } : { nextStartLine: endLine + 1 }),
          truncated: taken < asked,
          partialLine: false,
          fileBytes: Buffer.byteLength(written.get(path) ?? '', 'utf8')
        };
      },
      writeFile: async (_w: string, _t: string, path: string, content: string) => {
        written.set(path, content);
        return { sha256: `written-${path}` };
      },
      call: async () => ({ storageBytes: 1 })
    }
  } as unknown as ToolContext;
  const run = async (name: string, args: Record<string, unknown>) =>
    (await executeWorkspaceTool(context, {
      id: `call-${name}`,
      name,
      arguments: args
    } as unknown as ModelToolCall)) as Record<string, unknown>;
  let result: Record<string, unknown> = {};
  for (const call of calls) result = await run(call.name, call.args);
  return { result, state, written, run };
};

/** A file of `count` lines, each one distinguishable from every other by its own number. */
const tall = (count: number, width = 60): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1} ${'x'.repeat(width)}`).join('\n');

describe('reading a file bigger than one result can hold', () => {
  it('shows a prefix, says how long the file really is, and says where to carry on', async () => {
    const { result } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);

    // The claim the unbounded read used to make on this file was `truncated: false, totalLines:
    // 8332` while 5.95% of it reached the model. Every field below is now about what arrived.
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(8_332);
    expect(result.startLine).toBe(1);
    // Fewer lines than the file has, and the continuation picks up at the next one.
    expect(result.endLine).toBeLessThan(8_332);
    expect(result.nextStartLine).toBe((result.endLine as number) + 1);
    expect(String(result.content).split('\n')).toHaveLength(result.endLine as number);
    // Numbering still starts where the file does, so the continuation window lines up.
    expect(String(result.content).startsWith('1:line 1 ')).toBe(true);
  });

  it('keeps the serialised result inside the bound that decides what reaches the model', async () => {
    /*
     * The agreement condition, asserted rather than assumed. `recordToolResult` cuts every tool
     * result at RECENT_TOOL_OUTPUT_CHARS on the way into the window; if a read can exceed that, the
     * cut lands on a file_read again and the record of what was shown stops matching what was sent,
     * which is the entire defect this bound exists to close.
     */
    for (const file of [tall(8_332), tall(50_000, 4), tall(3_000, 400)]) {
      const { result } = await turn({ 'workspace/big.ts': file }, [
        { name: 'file_read', args: { path: 'workspace/big.ts' } }
      ]);
      expect(serializeToolResultForModel(result, Number.MAX_SAFE_INTEGER).length).toBeLessThan(
        RECENT_TOOL_OUTPUT_CHARS
      );
    }
  });

  it('stops on the line cap rather than the byte budget when the lines are short', async () => {
    // 50,000 lines of four characters is 250,000 bytes, so the byte budget alone would hand back
    // 4,500 lines and record every one of them as seen. The line cap is the only thing in the way.
    const { result } = await turn({ 'workspace/narrow.txt': tall(50_000, 0) }, [
      { name: 'file_read', args: { path: 'workspace/narrow.txt' } }
    ]);

    expect(result.endLine).toBe(800);
    expect(result.totalLines).toBe(50_000);
  });

  it('still shows a line that is longer on its own than the whole budget, cut to the budget', async () => {
    // The one case that cannot be served whole and must not be served empty: an answer of no lines
    // is a dead end. One line is still a bound - the file has three - and the line arrives cut to
    // the budget rather than whole, because the budget is about bytes delivered and this is the
    // shape that proves it.
    const { result } = await turn(
      { 'workspace/one.json': `${'a'.repeat(80_000)}\nsecond\nthird` },
      [{ name: 'file_read', args: { path: 'workspace/one.json' } }]
    );

    expect(result.endLine).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.nextStartLine).toBe(2);
    expect(Buffer.byteLength(String(result.content), 'utf8')).toBeLessThan(19_000);
  });

  /*
   * A file with no newlines in it, which is not an exemption from the bound but the case that shows
   * what the bound is about. `apps/desktop/src-tauri/gen/schemas/acl-manifests.json` is 76,478 bytes
   * on one line: measured through this arm against the real runner, it used to answer
   * `truncated: false, totalLines: 1`, hand the whole 76,480-character result to a layer that cuts
   * at 24,000, record nothing, and let the following whole-file write destroy 76,476 bytes.
   *
   * `truncated` is a claim about bytes delivered, so it is true here, and the line is not counted as
   * shown, so nothing rests on it.
   */
  describe('a file whose only line is longer than one read can deliver', () => {
    const ONE_LINE = { 'workspace/acl.json': `{"x":"${'a'.repeat(76_000)}"}` };

    it('reports itself truncated, and offers no continuation because there is none', async () => {
      const { result } = await turn(ONE_LINE, [
        { name: 'file_read', args: { path: 'workspace/acl.json' } }
      ]);

      expect(result).toMatchObject({ startLine: 1, endLine: 1, totalLines: 1, truncated: true });
      // There is no line 2 to carry on at, and resuming at line 1 would hand back the same half
      // forever, so a continuation would be a recovery the model cannot perform.
      expect(result.nextStartLine).toBeUndefined();
      expect(Buffer.byteLength(String(result.content), 'utf8')).toBeLessThan(19_000);
    });

    it('refuses the write that would discard the part of that line it never showed', async () => {
      const { run, written } = await turn(ONE_LINE, [
        { name: 'file_read', args: { path: 'workspace/acl.json' } }
      ]);

      await expect(
        run('file_write', { path: 'workspace/acl.json', content: '{}' })
      ).rejects.toThrow(GardenError);
      expect(written.get('workspace/acl.json')).toHaveLength(76_008);
      // And the refusal names a recovery that exists. Reading a range cannot help a file with one
      // line in it, and neither can a line-addressed edit, so it says to use a program.
      await expect(
        run('file_write', { path: 'workspace/acl.json', content: '{}' })
      ).rejects.toThrow(/from the shell/);
    });
  });

  it('leaves a file that fits exactly as it was', async () => {
    // The bound has to be invisible on the 81% of this repository it never touches, and a read that
    // showed everything still says so - `truncated: false`, no continuation, nothing outstanding.
    const { result, state } = await turn({ 'workspace/small.ts': tall(120) }, [
      { name: 'file_read', args: { path: 'workspace/small.ts' } }
    ]);

    expect(result).toMatchObject({ startLine: 1, endLine: 120, totalLines: 120, truncated: false });
    expect(result.nextStartLine).toBeUndefined();
    expect(state.partialReads?.['workspace/small.ts']).toBeUndefined();
    expect(state.readFileHashes?.['workspace/small.ts']).toBe(HASH);
  });
});

describe('what a read that showed part of a file lets you do to the rest of it', () => {
  it('refuses a whole-file write that would destroy the lines it never showed', async () => {
    /*
     * THE ATTACK. A model reads a 8,332-line file, is shown a prefix of it, and writes back 200
     * lines under the hash that read left behind. Every guard downstream agrees with the call: the
     * file has not changed, so the runner's 409 does not fire; an unwindowed read records nothing
     * with the runner's seen-line ledger, so its 428 does not fire either. Measured against the
     * real `files.ts` before this refusal existed: ACCEPTED, 8,132 lines destroyed - while the
     * identical write after a WINDOWED read of the same 200 lines is refused by name one layer
     * down. This closes the gap between those two, and the file is asserted first because the
     * message is the consequence and the bytes are the harm.
     */
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: tall(200) })
    ).rejects.toThrow(GardenError);
    expect(toLines(written.get('workspace/big.ts') ?? '')).toHaveLength(8_332);
  });

  it('tells the model the two things that actually get the write through', async () => {
    // A refusal naming a recovery the model cannot perform is the failure this repository has
    // already paid for once, in the truncation marker that said "run the tool again". Both of these
    // are performable, and the case below proves the second one really does lift it.
    const { run } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'replacement' })
    ).rejects.toThrow(/file_patch/);
    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'replacement' })
    ).rejects.toThrow(/startLine and endLine/);
  });

  it('lets the write through once the reads have paged to the end of the file', async () => {
    /*
     * The refusal is about coverage, not about the shape of how it was obtained, so reads that
     * between them cover the file clear it. Without this the bound would be a wall on any file too
     * big for one result, and the only way to change one would be to never have read it.
     *
     * Every window is continued from exactly where the previous read said to carry on, rather than
     * from a number this test picked: a continuation that does not tile is a continuation the model
     * cannot follow, and the loop terminating at all is the assertion that they do tile.
     */
    const {
      run,
      written,
      result: first
    } = await turn({ 'workspace/mid.ts': tall(900) }, [
      { name: 'file_read', args: { path: 'workspace/mid.ts' } }
    ]);

    await expect(run('file_write', { path: 'workspace/mid.ts', content: 'new' })).rejects.toThrow(
      GardenError
    );

    let next = first.nextStartLine as number | undefined;
    let reads = 1;
    while (next !== undefined) {
      const page = await run('file_read', {
        path: 'workspace/mid.ts',
        startLine: next,
        endLine: 900
      });
      reads += 1;
      next = page.nextStartLine as number | undefined;
      expect(reads).toBeLessThan(20);
    }
    await run('file_write', { path: 'workspace/mid.ts', content: 'new' });
    expect(written.get('workspace/mid.ts')).toBe('new');
    // The price of the escape, said out loud: a 900-line file of 70-character lines is four reads.
    expect(reads).toBe(4);
  });

  it('refuses the whole-file write a windowed read used to authorise, and destroys nothing', async () => {
    /*
     * THE SEVERE ONE, and it is the most ordinary read shape in the harness: 47.4% of 14,314 real
     * `file_read` calls on this machine name a window. That arm set no outstanding length and claims
     * no hash - the ranged reader has no whole-file digest to give it - so the worker had nothing to
     * consult and the runner's own guard sat behind a hash this path never produces. Measured
     * through this arm against the real runner on `apps/worker/src/agent-run.test.ts`, 8,332 lines
     * and 354,014 bytes: `file_read {startLine: 1, endLine: 200}` then a whole-file `file_write` was
     * ACCEPTED and destroyed 8,330 lines, 354,002 bytes, with the file's sha256 changed.
     *
     * The comment in this arm asserted the opposite - that the windowed write was "refused by name
     * one layer down". It was not, and that is why nothing here is asserted from a comment.
     */
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 200 } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: tall(200) })
    ).rejects.toThrow(/line 201 onwards has never been shown to you/);
    expect(toLines(written.get('workspace/big.ts') ?? '')).toHaveLength(8_332);
  });

  it('says a window that covered the whole file leaves nothing outstanding', async () => {
    // The other direction of the same guard, and the one that decides whether it survives contact
    // with anybody: a window wide enough to have shown the file is a read of the file, and the write
    // after it is ordinary work rather than something to be refused.
    const { run, written, state } = await turn({ 'workspace/small.ts': tall(120) }, [
      { name: 'file_read', args: { path: 'workspace/small.ts', startLine: 1, endLine: 400 } }
    ]);

    expect(state.partialReads?.['workspace/small.ts']).toBeUndefined();
    await run('file_write', { path: 'workspace/small.ts', content: 'replaced' });
    expect(written.get('workspace/small.ts')).toBe('replaced');
  });

  it('holds a window to the same budget as a read with no window at all', async () => {
    /*
     * A window used to be fetched under a 400,000-byte budget and recorded whole, while
     * `recordToolResult` cut the result to 24,000 characters two layers downstream - so asking for
     * lines 1 to 8,332 vouched for 8,332 lines and showed 5.95% of them. That is the same defect the
     * unwindowed bound was shipped to close, and it also made the refusal above walkable in one
     * call: one wide window and the record claimed the file had been seen.
     */
    const { result, state } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 8_332 } }
    ]);

    expect(result.endLine).toBeLessThan(8_332);
    expect(result.truncated).toBe(true);
    expect(String(result.content).split('\n')).toHaveLength(result.endLine as number);
    expect(serializeToolResultForModel(result, Number.MAX_SAFE_INTEGER).length).toBeLessThan(
      RECENT_TOOL_OUTPUT_CHARS
    );
    // And what it left outstanding is what stops the write: the file goes further than this window.
    expect(state.partialReads?.['workspace/big.ts']).toBeGreaterThan(result.endLine as number);
  });

  it('does not stand between a first write and a file nothing has read', async () => {
    // Creating a file, an upload landing on a name, a generated document: none of them are editing
    // from a read, and holding them to a read record would refuse every file this computer makes.
    const { written } = await turn({}, [
      { name: 'file_write', args: { path: 'workspace/new.md', content: 'hello' } }
    ]);
    expect(written.get('workspace/new.md')).toBe('hello');
  });

  it('does not stand between a whole-file write and a file that was read whole', async () => {
    const { written } = await turn({ 'workspace/small.ts': tall(120) }, [
      { name: 'file_read', args: { path: 'workspace/small.ts' } },
      { name: 'file_write', args: { path: 'workspace/small.ts', content: 'replaced' } }
    ]);
    expect(written.get('workspace/small.ts')).toBe('replaced');
  });

  /*
   * THE ONE A PATCH USED TO OPEN, and it was open on every file, always.
   *
   * This case asserted the opposite until now - that a patch stops the file being held - on the
   * reasoning that the text on disk is text the turn authored. It is not: a line-addressed patch
   * authors a span and leaves the rest of the file exactly where it was. Measured through this arm
   * on an 8,332-line file, one `PUT 12:` after a bounded read cleared the outstanding length AND
   * recorded all 8,332 lines as shown, so the whole-file write below was accepted and destroyed
   * 576,512 bytes of a file the model had seen 258 lines of.
   */
  it('still holds a file against its unread remainder after a patch has changed one line', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);
    await run('file_patch', {
      patches: [{ path: 'workspace/big.ts', oldText: '\nline 12 ', newText: '\nchanged ' }]
    });
    const after = written.get('workspace/big.ts') ?? '';

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'now mine' })
    ).rejects.toThrow(/never been shown to you/);
    expect(written.get('workspace/big.ts')).toBe(after);
    expect(toLines(after)).toHaveLength(8_332);
  });
});

/**
 * The other direction of the write guard: what it must NOT refuse.
 *
 * A guard that refuses legitimate work gets deleted by the first person it inconveniences, and it
 * deserves to be. The record of what has been shown was kept as at most four windows of text per
 * file, and the coverage question was answered off those four - so any file longer than four
 * windows could be read from its first line to its last and the whole-file write of it was still
 * refused, with a message naming the read the model had just performed. Measured on this
 * repository at the time: 37 of 946 tracked files.
 */
describe('a file too long to be remembered four windows at a time', () => {
  /** Pages a file from `startLine` to its end, following only what each read says comes next. */
  const pageThrough = async (
    run: Read['run'],
    path: string,
    startLine: number
  ): Promise<number> => {
    let next: number | undefined = startLine;
    let reads = 0;
    while (next !== undefined) {
      const page: Record<string, unknown> = await run('file_read', {
        path,
        startLine: next,
        endLine: 100_000
      });
      reads += 1;
      next = page.nextStartLine as number | undefined;
      expect(reads).toBeLessThan(80);
    }
    return reads;
  };

  it('lets the whole-file write through once the reads have reached its last line', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, []);
    const reads = await pageThrough(run, 'workspace/big.ts', 1);
    // The price of the escape, said out loud, and it is more than four: 8,332 lines of 67 bytes
    // against an 18,000-byte display budget.
    expect(reads).toBe(33);

    await run('file_write', { path: 'workspace/big.ts', content: 'mine now' });
    expect(written.get('workspace/big.ts')).toBe('mine now');
  });

  it('still refuses it while the reads stop short of the end', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 4_000 } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'mine now' })
    ).rejects.toThrow(GardenError);
    expect(toLines(written.get('workspace/big.ts') ?? '')).toHaveLength(8_332);
  });

  /*
   * THE MESSAGE IS A PROMISE AND THIS IS THE TEST THAT IT IS KEPT. This repository has already paid
   * once for a marker that named a recovery the model could not perform. So the refusal is read for
   * the line it names, that exact read is performed, and the same write is sent again.
   */
  it('names a line to read from, and reading from it lifts the refusal', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 200 } }
    ]);

    const refusal = await run('file_write', {
      path: 'workspace/big.ts',
      content: 'mine now'
    }).catch((error: unknown) => error);
    const named = /read from line (\d+) with file_read/.exec((refusal as Error).message);
    expect(named?.[1]).toBe('201');

    // Thirty-three reads from line 201, against thirty-three from line 1: a window is 253 lines of
    // this file, so the 200 already shown are most of one.
    const reads = await pageThrough(run, 'workspace/big.ts', Number(named?.[1]));
    expect(reads).toBe(33);
    await run('file_write', { path: 'workspace/big.ts', content: 'mine now' });
    expect(written.get('workspace/big.ts')).toBe('mine now');
  });

  /*
   * The refusal for a file whose single line is longer than one read is the other kind: both of the
   * usual recoveries are closed to it, and it says so instead of naming one that cannot be
   * performed. `acl-manifests.json` in this repository is the real one - 76,478 bytes, zero
   * newlines.
   */
  it('sends a file with no newlines in it somewhere else entirely', async () => {
    const { run, written } = await turn({ 'workspace/acl.json': 'x'.repeat(76_478) }, [
      { name: 'file_read', args: { path: 'workspace/acl.json' } }
    ]);

    const refusal = await run('file_write', {
      path: 'workspace/acl.json',
      content: '{}'
    }).catch((error: unknown) => error);
    expect((refusal as Error).message).toMatch(/Transform it with a program from the shell/);
    expect((refusal as Error).message).not.toMatch(/file_read using startLine/);
    expect(written.get('workspace/acl.json')).toHaveLength(76_478);
  });
});

/**
 * The post-edit check, driven through the shipped `file_patch` arm.
 *
 * Every assertion below that matters is a COUNT of runner `exec` calls rather than a reading of
 * what came back, because the property being defended is about what ran on the owner's computer
 * and an implementation that runs `cargo check` and then discards its output has already done the
 * harm. `diagnostics.test.ts` covers the walk and the two output grammars as units; nothing here
 * re-tests those. What is tested here is the trigger as the model reaches it.
 */

/** A tree the walk can climb: what each directory holds, by workspace path. */
type Tree = Record<string, readonly string[]>;

/** The measured shape of a real `tsc --noEmit --pretty false` line. @see postEditDiagnostics. */
const tscError = (relative: string, code = 2322): string =>
  `${relative}(3,7): error TS${code}: Type 'string' is not assignable to type 'number'.`;

interface Rig {
  readonly written: Map<string, string>;
  readonly execs: Array<Record<string, unknown>>;
  /** Held closed, every `exec` waits here - which is how a run is kept in flight across a call. */
  hold: boolean;
  release: () => void;
  /** What the Nth `exec` prints, so two runs of the same checker can be told apart. */
  output: (index: number) => Partial<ExecObservationShape>;
  /**
   * Fires once, inside the next runner call the tool makes, and is what lets a test reach the
   * moment between the drain's two reads: the tool has been entered, the report is in hand, and
   * the awaited call has not returned. Nothing in the product sets it.
   */
  duringCall: (() => void) | undefined;
  patch: (patches: unknown) => Promise<Record<string, unknown>>;
  run: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  settle: () => Promise<void>;
}

interface ExecObservationShape {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const rigFor = (files: Record<string, string>, tree: Tree): Rig => {
  forgetReads();
  forgetPostEditChecks();
  const written = new Map<string, string>(Object.entries(files));
  for (const path of Object.keys(files)) recordRead('task-1', path, 1, written.get(path) ?? '');
  const execs: Array<Record<string, unknown>> = [];
  let releaseGate = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const rig: Rig = {
    written,
    execs,
    hold: false,
    release: () => releaseGate(),
    output: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    duringCall: undefined,
    patch: async () => ({}),
    run: async () => ({}),
    /*
     * One `setImmediate` drains every microtask queued behind it, and the detached arming chain is
     * microtasks all the way down - a listing walk and one `exec`, all of them promises this fake
     * resolves without a timer. Three turns of it is slack, not a race: there is no timer anywhere
     * in the chain for a fourth to be waiting on.
     */
    settle: async () => {
      for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-1', userId: 'user-1' },
    state: {} as AgentState,
    key: new Uint8Array(32).fill(7),
    store: { setWorkspaceStorage: async () => undefined, appendTaskEvent: async () => undefined },
    runner: {
      readFileWithHash: async (_workspace: string, _task: string, path: string) => {
        const content = written.get(path);
        if (content === undefined) throw new Error(`no such file ${path}`);
        return { content, sha256: `sha-${path}` };
      },
      writeFile: async (_workspace: string, _task: string, path: string, content: string) => {
        written.set(path, content);
        return { sha256: `written-${path}` };
      },
      readFileForDisplay: async (_workspace: string, _task: string, path: string) => {
        const content = written.get(path) ?? '';
        const total = toLines(content).length;
        return {
          content,
          sha256: `sha-${path}`,
          totalLines: total,
          displayedLines: total,
          partialLine: false
        };
      },
      call: async (
        _workspace: string,
        _task: string,
        _capability: unknown,
        url: string,
        body?: Record<string, unknown>
      ) => {
        const during = rig.duringCall;
        rig.duringCall = undefined;
        during?.();
        if (url.endsWith('/usage')) return { storageBytes: 1 };
        if (url.includes('/exec')) {
          const index = execs.length;
          execs.push({ ...(body ?? {}) });
          if (rig.hold) await gate;
          return {
            exitCode: 1,
            stdout: '',
            stderr: '',
            timedOut: false,
            signal: null,
            durationMs: 1,
            ...rig.output(index)
          };
        }
        const dir = decodeURIComponent(/path=([^&]*)/.exec(url)?.[1] ?? '');
        return { entries: (tree[dir] ?? []).map((name) => ({ name })) };
      }
    }
  } as unknown as ToolContext;
  rig.patch = async (patches: unknown) =>
    (await executeWorkspaceTool(context, {
      id: 'call-1',
      name: 'file_patch',
      arguments: { patches }
    } as unknown as ModelToolCall)) as Record<string, unknown>;
  rig.run = async (name: string, args: Record<string, unknown> = {}) =>
    (await executeWorkspaceTool(context, {
      id: 'call-2',
      name,
      arguments: args
    } as unknown as ModelToolCall)) as Record<string, unknown>;
  return rig;
};

/** A package that has a checker: a `tsconfig.json` one directory above the file being patched. */
const PACKAGE_TREE: Tree = {
  workspace: ['package.json', 'pnpm-lock.yaml', 'pkg'],
  'workspace/pkg': ['package.json', 'tsconfig.json', 'src'],
  'workspace/pkg/src': ['a.ts', 'b.ts', 'notes.md']
};
const PACKAGE_FILES = {
  'workspace/pkg/src/a.ts': 'export const n: number = 1;\n',
  'workspace/pkg/src/b.ts': 'export const m: number = 2;\n',
  'workspace/pkg/src/notes.md': '# notes\n'
};
const swap = (path: string, text: string, anchor = 'export const') => [
  { path, oldText: `${anchor}`, newText: `${text}` }
];

describe('the checker a patch triggers on what it just wrote', () => {
  it('names the patched file and carries the compiler’s own message, on the next call', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    rig.output = () => ({
      exitCode: 2,
      stdout: `${tscError('src/a.ts')}\n`,
      stderr: '',
      timedOut: false
    });
    const patched = await rig.patch(
      swap('workspace/pkg/src/a.ts', "export const n: number = 'x';")
    );
    // The patch itself carries nothing: the run it armed cannot have finished, and the whole
    // point of the deferral is that it did not wait to find out.
    expect(patched.filesChanged).toHaveLength(1);
    expect(patched.diagnostics).toBeUndefined();

    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    expect(block).toContain('workspace/pkg/src/a.ts(3,7): error TS2322');
    expect(block).toContain('npx --no-install tsc --noEmit --pretty false in workspace/pkg');
  });

  /**
   * A green tree has to cost nothing, and the property is guarded in three places rather than one:
   * the parser returns nothing it did not recognise, the drain keeps an empty check out, and the
   * renderer refuses a header with no lines under it. Deleting any single one of those leaves this
   * green, which is worth knowing before trusting it - it went red only against all three deleted
   * at once.
   */
  it('costs a green tree zero bytes: no key at all, not an empty one', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    // The same patch against a project that compiles. `exitCode: 0` is not consulted anywhere -
    // what makes this silent is that no line of the output parses as a diagnostic.
    const patched = await rig.patch(swap('workspace/pkg/src/a.ts', 'export const n: number = 2;'));
    expect(patched.filesChanged).toHaveLength(1);
    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    expect(rig.execs).toHaveLength(1);
    expect('diagnostics' in next).toBe(false);
  });
});

describe('what a patch must never run, counted on the wire', () => {
  it('runs nothing for a file with no project marker anywhere above it', async () => {
    const rig = rigFor(
      { 'workspace/loose/a.ts': 'export const a = 1;\n' },
      { workspace: ['notes.md', 'loose'], 'workspace/loose': ['a.ts'] }
    );
    await rig.patch(swap('workspace/loose/a.ts', 'export const a = 2;'));
    await rig.settle();
    expect(rig.execs).toHaveLength(0);
  });

  /**
   * The refusal sentence is model-facing advice for a question the model did not ask, and running
   * the command it declines to run would be worse. This is this repository's own root: a
   * `package.json`, no `tsconfig.json`, and `tsc` there prints 4,994 bytes of its own usage page.
   */
  it('runs nothing where the marker names a language whose project file is missing', async () => {
    const rig = rigFor(
      { 'workspace/a.ts': 'export const a = 1;\n' },
      { workspace: ['package.json', 'pnpm-lock.yaml', 'a.ts'] }
    );
    await rig.patch(swap('workspace/a.ts', 'export const a = 2;'));
    await rig.settle();
    expect(rig.execs).toHaveLength(0);
  });

  /**
   * The case that protects the owner's machine, and the reason the admission list is six languages
   * and not fifteen. `cargo check` compiles and runs the crate's `build.rs` and its procedural
   * macros, which is a program whoever wrote the repository chose. `code_diagnostics` runs it
   * because the model asked for it by name; an edit to a `.rs` file is not asking.
   *
   * Asserted by counting rather than by reading, because an implementation that runs the build and
   * throws the output away has already done the whole of the harm this is about.
   */
  it('does not run cargo check when a .rs file inside a real crate is patched', async () => {
    const rig = rigFor(
      { 'workspace/crate/src/main.rs': 'fn main() {}\n' },
      {
        workspace: ['crate'],
        'workspace/crate': ['Cargo.toml', 'src'],
        'workspace/crate/src': ['main.rs']
      }
    );
    const patched = await rig.patch(
      swap('workspace/crate/src/main.rs', 'fn main() { }', 'fn main()')
    );
    await rig.settle();
    expect(patched.filesChanged).toHaveLength(1);
    expect(rig.execs).toHaveLength(0);
    expect(POST_EDIT_CHECKED_LANGUAGES.has('rust')).toBe(false);
  });

  it('runs nothing for a patch that wrote no code, in a package that has a checker', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    await rig.patch(swap('workspace/pkg/src/notes.md', '# other notes', '# notes'));
    await rig.settle();
    expect(rig.execs).toHaveLength(0);
  });

  it('runs the project once for two files in it, not once per file', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    await rig.patch([
      ...swap('workspace/pkg/src/a.ts', 'export const n: number = 3;'),
      ...swap('workspace/pkg/src/b.ts', 'export const m: number = 4;')
    ]);
    await rig.settle();
    expect(rig.execs).toHaveLength(1);
    expect(rig.execs[0]).toMatchObject({ cwd: 'workspace/pkg', executable: 'npx' });
  });
});

describe('the check may not refuse work, and may not claim health', () => {
  /**
   * A hundred pre-existing errors nobody in this turn wrote. The patch succeeds and says so; the
   * block is capped and says how much it left out; and the one error in the file that was actually
   * patched is at the top, because that is the one the model is about to act on.
   */
  it('reports a patch into a broken project as success, capped, and says how much it dropped', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    const noise = Array.from({ length: 99 }, (_, index) =>
      tscError(`src/old/legacy-${index}.ts`, 2345)
    );
    rig.output = () => ({
      exitCode: 2,
      stdout: [...noise, tscError('src/a.ts')].join('\n'),
      stderr: '',
      timedOut: false
    });
    const patched = await rig.patch(
      swap('workspace/pkg/src/a.ts', "export const n: number = 'x';")
    );
    const changed = patched.filesChanged as Array<{ path: string; sha256: string; lines: number }>;
    expect(changed).toHaveLength(1);
    expect(changed[0]?.path).toBe('workspace/pkg/src/a.ts');
    expect(changed[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(patched.filesChanged).toHaveLength(1);
    expect(patched.failed).toBeUndefined();

    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    const lines = block.split('\n');
    expect(lines[1]).toContain('workspace/pkg/src/a.ts');
    expect(block).toContain('and 88 more.');
    expect(block.length).toBeLessThanOrEqual(1_600);
  });

  /**
   * The byte bound, on the block the count bound cannot reach: ONE diagnostic.
   *
   * The renderer admits its first line whatever the length, so that a block is never a header with
   * nothing under it, and that exemption is where the byte bound leaked. `tsc --noEmit --pretty
   * false` prints the inferred type inline, so a single mismatch between two large object types is
   * one line of several kilobytes; driven through this arm at 60,000 bytes of type text, the block
   * came back 60,198 bytes long against its declared 1,600 - past `RECENT_TOOL_OUTPUT_CHARS`
   * entirely, so an uninvited block would have evicted the result the model asked for.
   *
   * Pinned in bytes rather than by looking for the cut marker, because a marker is a string a
   * future edit can keep while the length runs away underneath it.
   */
  it('cuts one diagnostic that is longer than the whole block’s budget', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    const type = 'A'.repeat(60_000);
    rig.output = () => ({
      exitCode: 2,
      stdout: `src/a.ts(3,7): error TS2322: Type '${type}' is not assignable to type 'number'.\n`,
      stderr: '',
      timedOut: false
    });
    await rig.patch(swap('workspace/pkg/src/a.ts', "export const n: number = 'x';"));
    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    // The stated cap and not the stated cap plus a residue: one check reserves nothing for a tail
    // that cannot be written, so the whole 1,600 is this block's.
    expect(block.length).toBeLessThanOrEqual(1_600);
    // And the other direction, or a renderer that met the bound by going quiet would pass: one
    // check reserves nothing for a tail, so this block is entitled to very nearly all of it.
    expect(block.length).toBeGreaterThan(1_500);
    expect(block).toContain('workspace/pkg/src/a.ts(3,7): error TS2322');
    expect(block).toContain('code_diagnostics');
    // Well inside the window the whole result is bounded to, which is the point of the cap.
    expect(block.length).toBeLessThan(RECENT_TOOL_OUTPUT_CHARS);
  });

  /**
   * The byte bound on the block the ONE-check bound cannot reach: a patch across a monorepo.
   *
   * A check is one project, and one `file_patch` may span eight of them - this repository has more
   * than eight packages - so eight landed checks are joined onto one result. The cap was per check
   * and nothing counted the total: eight over-long `tsc` lines delivered 14,246 bytes under a cap
   * that reads 1,600, which is three fifths of `RECENT_TOOL_OUTPUT_CHARS` taken by a block nobody
   * asked for. Pinned in bytes on the whole `diagnostics` value, and asserted to still NAME the
   * projects it could not fit, so a renderer that met the bound by going silent does not pass.
   */
  it('holds the whole block to the budget when one patch arms a check in eight projects', async () => {
    const PROJECTS = 8;
    const rig = rigFor(
      Object.fromEntries(
        Array.from({ length: PROJECTS }, (_unused, index) => [
          `workspace/p${index}/src/a.ts`,
          `export const n${index}: number = 1;\n`
        ])
      ),
      {
        workspace: [
          'package.json',
          'pnpm-lock.yaml',
          ...Array.from({ length: PROJECTS }, (_unused, index) => `p${index}`)
        ],
        ...Object.fromEntries(
          Array.from({ length: PROJECTS }, (_unused, index) => [
            `workspace/p${index}`,
            ['package.json', 'tsconfig.json', 'src']
          ])
        ),
        ...Object.fromEntries(
          Array.from({ length: PROJECTS }, (_unused, index) => [
            `workspace/p${index}/src`,
            ['a.ts']
          ])
        )
      }
    );
    const type = 'A'.repeat(60_000);
    rig.output = () => ({
      exitCode: 2,
      stdout: `src/a.ts(3,7): error TS2322: Type '${type}' is not assignable to type 'number'.\n`,
      stderr: '',
      timedOut: false
    });
    await rig.patch(
      Array.from({ length: PROJECTS }, (_unused, index) => ({
        path: `workspace/p${index}/src/a.ts`,
        oldText: 'export const',
        newText: `export const n${index}: number = 'x'; //`
      }))
    );
    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    expect(rig.execs).toHaveLength(PROJECTS);
    // EVERY byte, not the blocks alone: the `\n\n` joins and the tail line are inside the budget
    // now, and this is the assertion that says so. It was written `1_600 + 200` while they sat
    // outside it, which is a cap that admits its own residue.
    expect(block.length).toBeLessThanOrEqual(1_600);
    // What it could not fit is named, not swallowed.
    expect(block).toContain('7 more projects');
    expect(block).toContain('workspace/p0/src/a.ts(3,7): error TS2322');
    expect(block.length).toBeLessThan(RECENT_TOOL_OUTPUT_CHARS);
  });

  /**
   * The same eight projects with diagnostics small enough that SEVERAL blocks land, which is the
   * only shape in which the `\n\n` between them costs anything.
   *
   * The case above never reaches it: one 60,000-byte line eats the whole budget, one block is
   * emitted and there is no join to pay for. So the separator could be left out of the accounting
   * and every assertion in this file stayed green - it was, and they did. Sized so the budget is
   * SATURATED, six blocks and two counted: the delivered value is 1,600 bytes on the nose, and
   * putting the joins back outside the budget makes it 1,608.
   */
  it('counts the bytes that join the blocks, when more than one of them lands', async () => {
    const PROJECTS = 8;
    const rig = rigFor(
      Object.fromEntries(
        Array.from({ length: PROJECTS }, (_unused, index) => [
          `workspace/p${index}/src/a.ts`,
          `export const n${index}: number = 1;\n`
        ])
      ),
      {
        workspace: [
          'package.json',
          'pnpm-lock.yaml',
          ...Array.from({ length: PROJECTS }, (_unused, index) => `p${index}`)
        ],
        ...Object.fromEntries(
          Array.from({ length: PROJECTS }, (_unused, index) => [
            `workspace/p${index}`,
            ['package.json', 'tsconfig.json', 'src']
          ])
        ),
        ...Object.fromEntries(
          Array.from({ length: PROJECTS }, (_unused, index) => [
            `workspace/p${index}/src`,
            ['a.ts']
          ])
        )
      }
    );
    // 140 characters once the parser has prefixed the project directory, which is the size that
    // leaves the budget with nothing to spare after the sixth block.
    const head = 'src/a.ts(3,7): error TS2322: ';
    const raw = `${head}${'A'.repeat(140 - 'workspace/p0/'.length - head.length)}`;
    rig.output = () => ({ exitCode: 2, stdout: `${raw}\n`, stderr: '', timedOut: false });
    await rig.patch(
      Array.from({ length: PROJECTS }, (_unused, index) => ({
        path: `workspace/p${index}/src/a.ts`,
        oldText: 'export const',
        newText: `export const n${index}: number = 'x'; //`
      }))
    );
    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    // More than one block, or the joins cost nothing and this case is the one above again.
    expect(block.split('\n\n').length).toBeGreaterThan(2);
    expect(block).toContain('workspace/p0/src/a.ts(3,7)');
    expect(block).toContain('workspace/p1/src/a.ts(3,7)');
    expect(block).toContain('more projects');
    expect(block.length).toBeLessThanOrEqual(1_600);
  });

  /**
   * The one shape in which POST_EDIT_MIN_DIAGNOSTIC is load-bearing rather than a matter of taste,
   * and until this case existed nothing pinned it: setting it to 0 left all 56 tests green.
   *
   * `clipDiagnostic` spends the 68-byte cut marker FROM its budget, but only down to zero - below
   * the marker's own length the `Math.max` hands back the marker alone, which is longer than the
   * budget it was given. The minimum is what stops a caller ever reaching that: a header is not
   * written unless the line under it has room for the marker plus 40 bytes. Take the minimum away
   * and the seventh header here is written over a line with 21 bytes of room that delivers 68, so
   * the value the two cases above pin at 1,600 comes back at 1,646.
   *
   * SIZED, not guessed. Eight projects, one 115-byte diagnostic each: six blocks fit, the seventh
   * header has 132 bytes to sit in, and what is left for the line under it is 21 - inside the
   * marker and outside what the minimum admits. The arithmetic is
   * `1,600 - tail - 6 x (header + 3 + 115) - header - 1`, so it moves if the header wording or the
   * tail sentence moves, which is why the assertion is on the delivered bytes rather than on 21.
   */
  it('refuses a block it cannot fit a usable line into, rather than delivering a bare cut marker', async () => {
    const PROJECTS = 8;
    const rig = rigFor(
      Object.fromEntries(
        Array.from({ length: PROJECTS }, (_unused, index) => [
          `workspace/p${index}/src/a.ts`,
          `export const n${index}: number = 1;\n`
        ])
      ),
      {
        workspace: [
          'package.json',
          'pnpm-lock.yaml',
          ...Array.from({ length: PROJECTS }, (_unused, index) => `p${index}`)
        ],
        ...Object.fromEntries(
          Array.from({ length: PROJECTS }, (_unused, index) => [
            `workspace/p${index}`,
            ['package.json', 'tsconfig.json', 'src']
          ])
        ),
        ...Object.fromEntries(
          Array.from({ length: PROJECTS }, (_unused, index) => [
            `workspace/p${index}/src`,
            ['a.ts']
          ])
        )
      }
    );
    const head = 'src/a.ts(3,7): error TS2322: ';
    const raw = `${head}${'A'.repeat(115 - 'workspace/p0/'.length - head.length)}`;
    rig.output = () => ({ exitCode: 2, stdout: `${raw}\n`, stderr: '', timedOut: false });
    await rig.patch(
      Array.from({ length: PROJECTS }, (_unused, index) => ({
        path: `workspace/p${index}/src/a.ts`,
        oldText: 'export const',
        newText: `export const n${index}: number = 'x'; //`
      }))
    );
    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    expect(block.length).toBeLessThanOrEqual(1_600);
    // The refused project is COUNTED and not swallowed, or the bound could be met by going quiet.
    expect(block).toContain('more projects');
    // And no block is a header over nothing but the truncation notice. A cut marker with no line
    // in front of it is the shape the minimum exists to refuse, so its absence is the assertion.
    for (const one of block.split('\n\n')) {
      const lines = one.split('\n');
      if (lines.length > 1) expect(lines[1]?.startsWith(' [cut here')).toBe(false);
    }
  });

  /**
   * The measured shape of `npx --no-install tsc` where TypeScript is not installed: exit 1 and 544
   * bytes of npm's own advice, not one line of which is a diagnostic. It has to read as silence,
   * and nothing in the result may say the file is fine.
   */
  it('says nothing at all when the checker is not installed', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    rig.output = () => ({
      exitCode: 1,
      stdout: '',
      stderr:
        'This is not the tsc command you are looking for\n\nTo get access to the TypeScript compiler, tsc, from the command line either:\n\n- Use npm install typescript to first add TypeScript to your project before using npx\n',
      timedOut: false
    });
    await rig.patch(swap('workspace/pkg/src/a.ts', 'export const n: number = 5;'));
    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    expect(rig.execs).toHaveLength(1);
    expect('diagnostics' in next).toBe(false);
    expect(JSON.stringify(next)).not.toMatch(/passed|clean|healthy|no errors/i);
  });
});

describe('a check is only worth reporting while it is still about this tree', () => {
  it('reports the newer run and drops the one the second patch outran', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    rig.hold = true;
    rig.output = (index) => ({
      exitCode: 2,
      stdout: `${tscError(index === 0 ? 'src/stale.ts' : 'src/fresh.ts')}\n`,
      stderr: '',
      timedOut: false
    });
    // Both patches are issued before either checker returns, which is the ordinary shape: patch,
    // read the echo, notice the typo, patch again.
    await rig.patch(swap('workspace/pkg/src/a.ts', "export const n: number = 'x';"));
    await rig.patch(swap('workspace/pkg/src/a.ts', "export const n: number = 'y';"));
    rig.release();
    await rig.settle();

    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    expect(rig.execs).toHaveLength(2);
    expect(block).toContain('src/fresh.ts');
    expect(block).not.toContain('src/stale.ts');
  });

  /**
   * The same staleness one beat later, and the case the outstanding-run test above cannot reach:
   * the first check has LANDED before the second patch is issued, so it is fresh at the moment the
   * drain reads it and stale by the moment it is rendered. It must not ride on the result of the
   * write that invalidated it.
   *
   * Asserted as an absence on the second patch AND as the PRESENCE of the second run's own answer
   * on the call after it, because a guard that silenced the drain outright would pass the first
   * half alone. The two runs are told apart by the path each prints.
   */
  it('drops a landed check on the result of the patch that superseded it', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    rig.output = (index) => ({
      exitCode: 2,
      stdout: `${tscError(index === 0 ? 'src/stale.ts' : 'src/fresh.ts')}\n`,
      stderr: '',
      timedOut: false
    });
    await rig.patch(swap('workspace/pkg/src/a.ts', "export const n: number = 'x';"));
    await rig.settle();
    // The repair. What must not appear on it is the answer the checker gave about the file this
    // patch has just replaced.
    const repaired = await rig.patch(swap('workspace/pkg/src/a.ts', 'export const n: number = 9;'));
    expect(repaired.filesChanged).toHaveLength(1);
    expect(repaired.diagnostics).toBeUndefined();

    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    expect(rig.execs).toHaveLength(2);
    expect(block).toContain('src/fresh.ts');
    expect(block).not.toContain('src/stale.ts');
  });

  /**
   * The ledger going while the report is in hand, which is the one shape that reached the second
   * read with nothing to date the answer against.
   *
   * The drain reads the landed checks BEFORE the tool runs and asks again after it, and the second
   * read used to return every captured check unfiltered when the ledger had gone - the opposite
   * direction from every other guard here. Reachable in the product when 64 other tasks arm during
   * one awaited tool call, which is why it is constructed rather than argued: the eviction is
   * driven from inside the call itself, which is exactly where it would happen.
   *
   * Both directions in one case. Without the eviction the same rig delivers the report, so a
   * renderer that had simply gone silent would fail the first half.
   */
  it('delivers nothing when the ledger that dated the answer is gone by the time it is rendered', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    rig.output = () => ({
      exitCode: 2,
      stdout: `${tscError('src/a.ts')}\n`,
      stderr: '',
      timedOut: false
    });
    await rig.patch(swap('workspace/pkg/src/a.ts', "export const n: number = 'x';"));
    await rig.settle();
    // The ledger is emptied inside the awaited call, after the drain has already captured the
    // check and before the render asks whether it is still about the tree.
    rig.duringCall = () => forgetPostEditChecks();
    const evicted = await rig.run('files_list', { path: 'workspace/pkg' });
    expect(evicted.diagnostics).toBeUndefined();

    // The counter-direction, on the same fixture with the eviction taken away: the check is real,
    // it landed, and it is delivered.
    const again = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    again.output = () => ({
      exitCode: 2,
      stdout: `${tscError('src/a.ts')}\n`,
      stderr: '',
      timedOut: false
    });
    await again.patch(swap('workspace/pkg/src/a.ts', "export const n: number = 'x';"));
    await again.settle();
    const kept = await again.run('files_list', { path: 'workspace/pkg' });
    expect(kept.diagnostics).toContain('workspace/pkg/src/a.ts(3,7): error TS2322');
  });
});

describe('what the patch call is charged for, and what has to exist before it runs', () => {
  /**
   * The deferral, asserted where it is falsifiable: at the instant the patch's own promise
   * resolves, the checker has not been dispatched at all - not the walk, not the `exec`. Measured
   * on this machine, `npx --no-install tsc --noEmit` over `apps/worker` is 4.17 s wall, and this is
   * the assertion that says none of it is on the patch's clock.
   */
  it('resolves the patch before the checker has even been dispatched', async () => {
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    rig.hold = true;
    const patched = await rig.patch(swap('workspace/pkg/src/a.ts', 'export const n: number = 6;'));
    expect(patched.filesChanged).toHaveLength(1);
    expect(rig.execs).toHaveLength(0);
    rig.release();
  });

  /**
   * A triggered run may not execute before the turn has something to rewind to, and the way that
   * is guaranteed is that the only arm which arms one is not exempt from the undo point. Pinned
   * from both ends: `file_patch` is outside `CHECKPOINT_EXEMPT_TOOLS`, and the workspace arms that
   * ARE exempt arm nothing, so no exempt tool can reach a checker.
   */
  it('can only be armed by a tool that has already taken the turn’s undo point', async () => {
    expect(CHECKPOINT_EXEMPT_TOOLS.has('file_patch')).toBe(false);
    const rig = rigFor(PACKAGE_FILES, PACKAGE_TREE);
    for (const name of ['file_read', 'files_list']) {
      expect(CHECKPOINT_EXEMPT_TOOLS.has(name), name).toBe(true);
      await rig.run(name, { path: 'workspace/pkg/src/a.ts' });
    }
    await rig.settle();
    expect(rig.execs).toHaveLength(0);
  });
});

/**
 * The one structure here that grows with the SIZE OF THE TREE rather than with the number of runs.
 *
 * `checks` is capped and the task map is capped; the stamp map was neither, and it took an entry
 * per distinct path a task ever patched and never gave one back. The product shape that finds it
 * is the ordinary one: a long autonomous run over a large repository. The numbers below are the
 * module's own - 40 paths is the `file_patch` cap, 8 is `MAX_ARMED_CHECKS`, and their product is
 * what a live check can still be compared against - so a change to either of them should land
 * here.
 */
describe('what a task holding a stamp per patched path is allowed to accumulate', () => {
  const BATCH = 40;
  const TRACKED = 320;
  const BATCHES = 9;

  const FLOOD_NAMES = Array.from({ length: BATCHES * BATCH }, (_unused, index) => `f${index}.ts`);
  const FLOOD_FILES = Object.fromEntries(
    FLOOD_NAMES.map((name, index) => [
      `workspace/pkg/src/${name}`,
      `export const n${index}: number = 1;\n`
    ])
  );
  const FLOOD_TREE: Tree = {
    workspace: ['package.json', 'pnpm-lock.yaml', 'pkg'],
    'workspace/pkg': ['package.json', 'tsconfig.json', 'src'],
    'workspace/pkg/src': FLOOD_NAMES
  };

  /** Nine full patches, so the oldest of them is past the eight a check can be armed for. */
  const flood = async (rig: Rig): Promise<void> => {
    for (let batch = 0; batch < BATCHES; batch += 1) {
      await rig.patch(
        FLOOD_NAMES.slice(batch * BATCH, (batch + 1) * BATCH).map((name) => ({
          path: `workspace/pkg/src/${name}`,
          oldText: `export const`,
          newText: `export const changed${batch}: number = 1;`
        }))
      );
      await rig.settle();
    }
  };

  it('drops the stamps of paths no armed check can still ask about', async () => {
    const rig = rigFor(FLOOD_FILES, FLOOD_TREE);
    await flood(rig);
    expect(rig.execs).toHaveLength(BATCHES);
    // 360 distinct paths went through the arm and 320 stamps are held: the bound bites, and it
    // bites at the reachable set rather than at a round number somebody liked.
    expect(FLOOD_NAMES).toHaveLength(360);
    expect(countPostEditPaths('task-1')).toBe(TRACKED);
  });

  /**
   * The other direction, which is the one a cap gets wrong: pruning may not cost a report. A full
   * 40-path patch is what a too-small cap loses first, because ONE missing stamp among the paths a
   * check names is enough to read the whole run as superseded - so this re-patches all of batch
   * zero, every stamp of which the flood had dropped. Each takes a NEW stamp, higher than the
   * pruned entry held, and the run armed for them is delivered whole.
   */
  it('still delivers the check armed by a full patch of paths the prune had dropped', async () => {
    const rig = rigFor(FLOOD_FILES, FLOOD_TREE);
    await flood(rig);
    rig.output = () => ({
      exitCode: 2,
      stdout: `${tscError('src/f0.ts')}\n`,
      stderr: '',
      timedOut: false
    });
    await rig.patch(
      FLOOD_NAMES.slice(0, BATCH).map((name) => ({
        path: `workspace/pkg/src/${name}`,
        oldText: `export const`,
        newText: `export const repaired: number = 1;`
      }))
    );
    await rig.settle();
    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    expect(block).toContain('workspace/pkg/src/f0.ts(3,7): error TS2322');
  });

  /**
   * Why the number is a STAMP and not a per-path write count, pinned rather than reasoned.
   *
   * An arm whose files have no project marker above them arms no check, so it spends stamps
   * without spending one of the eight check slots - which is how a check that is still in flight
   * gets its own path pruned while it is alive. Eight of them here, and the held check's path is
   * gone. Patch that path again and a write count would restart at 1, which is exactly what the
   * dead check is holding, so `superseded` would read it as fresh and the checker's answer about
   * the file before BOTH writes would be rendered onto the result of the repair.
   *
   * Asserted as the absence of the first run's answer AND the presence of the second's, so a
   * change that silenced the drain outright does not pass it. The two runs are told apart by the
   * path each prints, as in the staleness describe above.
   */
  it('drops an in-flight check whose path the prune dropped and a later patch rewrote', async () => {
    const LOOSE = Array.from({ length: TRACKED }, (_unused, index) => `l${index}.ts`);
    const rig = rigFor(
      {
        'workspace/pkg/src/a.ts': 'export const n: number = 1;\n',
        ...Object.fromEntries(
          LOOSE.map((name, index) => [`workspace/loose/${name}`, `export const q${index} = 1;\n`])
        )
      },
      {
        workspace: ['package.json', 'pnpm-lock.yaml', 'pkg', 'loose'],
        'workspace/pkg': ['package.json', 'tsconfig.json', 'src'],
        'workspace/pkg/src': ['a.ts'],
        // No marker of its own, and the climb stops at a `workspace` that has a `package.json`
        // with no `tsconfig.json` beside it - so nothing here can ever arm a check.
        'workspace/loose': LOOSE
      }
    );
    rig.hold = true;
    rig.output = (index) => ({
      exitCode: 2,
      stdout: `${tscError(index === 0 ? 'src/stale.ts' : 'src/fresh.ts')}\n`,
      stderr: '',
      timedOut: false
    });
    await rig.patch(swap('workspace/pkg/src/a.ts', "export const n: number = 'x';"));
    await rig.settle();
    for (let batch = 0; batch < BATCHES - 1; batch += 1) {
      await rig.patch(
        LOOSE.slice(batch * BATCH, (batch + 1) * BATCH).map((name) => ({
          path: `workspace/loose/${name}`,
          oldText: `export const`,
          newText: `export const changed${batch} = 1;`
        }))
      );
      await rig.settle();
    }
    expect(rig.execs).toHaveLength(1);
    await rig.patch(swap('workspace/pkg/src/a.ts', 'export const n: number = 9;'));
    rig.release();
    await rig.settle();

    const next = await rig.run('files_list', { path: 'workspace/pkg' });
    const block = typeof next.diagnostics === 'string' ? next.diagnostics : '';
    expect(rig.execs).toHaveLength(2);
    expect(block).not.toContain('src/stale.ts');
    expect(block).toContain('src/fresh.ts');
  });
});

describe('multi-file mutation receipts', () => {
  const exercise = (failure: 'none' | 'write' | 'ack' | 'changed' | 'unreadable' | 'usage') => {
    forgetReads();
    const files = new Map([
      ['workspace/a.txt', 'alpha\n'],
      ['workspace/b.txt', 'bravo\n']
    ]);
    for (const [path, content] of files) recordRead('task-1', path, 1, content);
    let writing = false;
    const context = {
      task: { id: 'task-1', workspaceId: 'ws-1', userId: 'user-1' },
      state: {},
      key: new Uint8Array(32).fill(7),
      store: { setWorkspaceStorage: async () => undefined, appendTaskEvent: async () => undefined },
      runner: {
        readFileWithHash: async (_workspace: string, _task: string, path: string) => {
          if (writing && failure === 'unreadable') throw new Error('disconnected');
          return { content: files.get(path), sha256: 'observed-hash' };
        },
        writeFile: async (
          _workspace: string,
          _task: string,
          path: string,
          content: string,
          expected: string
        ) => {
          expect(expected).toBe('observed-hash');
          if (path.endsWith('b.txt')) {
            writing = true;
            if (failure === 'changed') files.set(path, 'concurrent owner edit\n');
            if (['write', 'changed', 'unreadable'].includes(failure))
              throw new Error('connection lost');
          }
          files.set(path, content);
          if (path.endsWith('b.txt') && failure === 'ack') throw new Error('response lost');
          return { sha256: 'written-hash' };
        },
        call: async () => {
          if (failure === 'usage') throw new Error('accounting unavailable');
          return { storageBytes: 20 };
        }
      }
    } as unknown as ToolContext;
    const run = (
      patches: unknown[] = [
        { path: 'workspace/a.txt', oldText: 'alpha', newText: 'ALPHA' },
        { path: 'workspace/b.txt', oldText: 'bravo', newText: 'BRAVO' }
      ]
    ) =>
      executeWorkspaceTool(context, {
        id: 'patch-receipt',
        name: 'file_patch',
        arguments: { patches }
      });
    return { files, run };
  };

  it.each([{ path: 'workspace/b.txt' }, null])(
    'validates the complete envelope before writing: %j',
    async (invalid) => {
      const { files, run } = exercise('none');
      await expect(
        run([{ path: 'workspace/a.txt', oldText: 'alpha', newText: 'ALPHA' }, invalid])
      ).rejects.toThrow();
      expect([...files.values()]).toEqual(['alpha\n', 'bravo\n']);
    }
  );

  it('reports the first write when the second fails without changing its file', async () => {
    const { files, run } = exercise('write');
    expect(await run()).toMatchObject({
      filesChanged: [{ path: 'workspace/a.txt' }],
      failed: [{ path: 'workspace/b.txt' }]
    });
    expect([...files.values()]).toEqual(['ALPHA\n', 'bravo\n']);
  });

  it('reconciles a lost acknowledgement by reading, without replaying the write', async () => {
    const { run } = exercise('ack');
    expect(await run()).toMatchObject({
      filesChanged: [{ path: 'workspace/a.txt' }, { path: 'workspace/b.txt' }]
    });
  });

  it.each(['changed', 'unreadable'] as const)(
    'preserves uncertain outcomes and never rolls back concurrent edits: %s',
    async (failure) => {
      const { files, run } = exercise(failure);
      expect(await run()).toMatchObject({
        filesChanged: [{ path: 'workspace/a.txt' }],
        uncertain: [{ path: 'workspace/b.txt' }]
      });
      expect(files.get('workspace/a.txt')).toBe('ALPHA\n');
      if (failure === 'changed')
        expect(files.get('workspace/b.txt')).toBe('concurrent owner edit\n');
    }
  );

  it('does not discard applied receipts when storage accounting fails', async () => {
    const { run } = exercise('usage');
    expect(await run()).toMatchObject({
      warnings: [expect.stringContaining('Storage accounting')]
    });
  });
});
