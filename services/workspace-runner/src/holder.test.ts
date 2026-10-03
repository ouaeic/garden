import { describe, expect, it, vi } from 'vitest';
import { DesktopControl } from './holder.js';

/**
 * Who holds the machine, and what a handover is allowed to leave behind.
 *
 * The arbitration cases below moved here with the class, unchanged, when `DesktopControl` came out
 * of `desktop.ts`: it is not the desktop's any more. The browser shares this object when it is
 * drawn on the workspace's own X server, which is the whole point of the move - two surfaces onto
 * one screen had two takeovers and no relation between them.
 *
 * The cases after them are new, and each pins one ordering rule the reorder in `transfer` depends
 * on. They are the reason the reorder is safe: moving `#holder` above the release closes the
 * window at one end and would open an identical one at the other if nothing held the queue shut.
 */
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('desktop control arbitration', () => {
  const build = (settleMs?: number) => {
    const release = vi.fn(async () => undefined);
    const changes: number[] = [];
    const control = new DesktopControl({
      release,
      onChange: (state) => changes.push(state.generation),
      ...(settleMs === undefined ? {} : { settleMs })
    });
    return { control, release, changes };
  };

  it('serializes input so two transactions never interleave', async () => {
    const { control } = build();
    const order: string[] = [];
    const first = control.submit('agent', async () => {
      order.push('first:start');
      await delay(20);
      order.push('first:end');
      return 1;
    });
    const second = control.submit('agent', async () => {
      order.push('second:start');
      return 2;
    });
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('refuses input from anyone but the holder, and stale coordinates from the holder', async () => {
    const { control } = build();
    await expect(control.submit('user', async () => 'nope')).rejects.toThrow(
      'Desktop control is held by agent'
    );
    await expect(control.submit('agent', async () => 'nope', { generation: 99 })).rejects.toThrow(
      'stale'
    );
    await expect(control.submit('agent', async () => 'ok', { generation: 1 })).resolves.toBe('ok');
  });

  it('takes over preemptively: queued agent work is discarded and input is released', async () => {
    const { control, release, changes } = build();
    let ran = 0;
    const inFlight = control.submit('agent', async () => {
      ran += 1;
      await delay(20);
      return 'in-flight';
    });
    const queued = control.submit('agent', async () => {
      ran += 1;
      return 'queued';
    });
    const takeover = control.transfer('user');
    await expect(queued).rejects.toThrow('Desktop control was handed to user');
    await expect(inFlight).resolves.toBe('in-flight');
    const state = await takeover;
    expect(ran).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(state.holder).toBe('user');
    expect(state.generation).toBe(2);
    expect(changes).toEqual([2]);
    await expect(control.submit('agent', async () => 'nope')).rejects.toThrow(
      'Desktop control is held by user'
    );
    await expect(control.submit('user', async () => 'mine')).resolves.toBe('mine');
  });

  it('force-completes a transaction that overruns the settle window', async () => {
    const { control, release } = build(5);
    const drag = control.submit(
      'agent',
      async (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('forced'));
        })
    );
    await control.transfer('user');
    expect(await drag).toBe('forced');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached coordinates on handback and on resize', async () => {
    const { control, changes } = build();
    await control.transfer('user');
    await control.transfer('agent');
    expect(control.holder).toBe('agent');
    expect(control.generation).toBe(3);
    control.bumpGeneration();
    expect(control.generation).toBe(4);
    expect(changes).toEqual([2, 3, 4]);
    await expect(control.submit('agent', async () => 'x', { generation: 3 })).rejects.toThrow(
      'stale'
    );
  });

  it('serializes concurrent handovers instead of racing them', async () => {
    const { control, release } = build();
    const [first, second] = await Promise.all([
      control.transfer('user'),
      control.transfer('secure_input')
    ]);
    expect(first.generation).toBe(2);
    expect(second.generation).toBe(3);
    expect(control.holder).toBe('secure_input');
    expect(release).toHaveBeenCalledTimes(2);
  });
});

/**
 * The two ends of one window.
 *
 * Releasing every latched key and *then* recording the new holder would leave `#holder` naming the
 * side that had just been evicted for the whole of that release - a round trip to an X server, and
 * to a browser page. Its queue discarded and its transaction aborted, a fresh submission arriving
 * in that gap would still be authorized against the outgoing holder and run: the agent typing one
 * more time into a screen the owner had already taken.
 *
 * Recording the holder first closes it, and would open the mirror image if nothing else changed -
 * the incoming holder authorized to act while the outgoing one's modifiers are still latched,
 * which is precisely what the release exists to prevent. So the queue is held shut for the
 * duration of the release. Both halves are asserted here, because either one alone is a defect.
 */
describe('the window a handover must not leave open', () => {
  const parked = () => {
    let finish: (() => void) | undefined;
    const order: string[] = [];
    const control = new DesktopControl({
      release: async () => {
        order.push('release:start');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        order.push('release:end');
      },
      onChange: () => undefined
    });
    return { control, order, finish: () => finish!() };
  };

  it('records the new holder before it unlatches, and admits nobody until the keys are up', async () => {
    const { control, order, finish } = parked();
    const takeover = control.transfer('user');
    await delay(5);
    expect(order).toEqual(['release:start']);

    const straggler = control.submit('agent', async () => {
      order.push('agent:ran');
      return 'nope';
    });
    const owner = control.submit('user', async () => {
      order.push('user:ran');
      return 'mine';
    });
    // Neither side acts while the release is in flight: the agent because it no longer holds the
    // machine, the owner because the keys the agent left down are still latched.
    await delay(5);
    expect(order).toEqual(['release:start']);

    finish();
    await takeover;
    await expect(straggler).rejects.toThrow('Desktop control is held by user');
    expect(await owner).toBe('mine');
    expect(order).toEqual(['release:start', 'release:end', 'user:ran']);
  });

  it('lifts every attached surface, and still reports the one that could not be lifted', async () => {
    const lifted: string[] = [];
    const control = new DesktopControl({
      release: async () => {
        lifted.push('desktop');
      },
      onChange: () => undefined
    });
    control.attach({
      release: async () => {
        lifted.push('browser');
        throw new Error('Target page, context or browser has been closed');
      }
    });
    control.attach({
      release: async () => {
        lifted.push('second-browser');
      }
    });

    await expect(control.transfer('user')).rejects.toThrow('has been closed');
    // A page that has gone must not be the reason the X server keeps its modifiers down.
    expect(lifted).toEqual(['desktop', 'browser', 'second-browser']);
    // And the owner still has the machine. A keyup that could not be delivered is not a reason to
    // hand the screen back to the agent the owner just took it from.
    expect(control.holder).toBe('user');
  });

  it('tells every attached surface who holds it, so two panes cannot disagree', async () => {
    const seen: string[] = [];
    const control = new DesktopControl({
      release: async () => undefined,
      onChange: (state) => seen.push(`desktop:${state.holder}`)
    });
    const detach = control.attach({
      release: async () => undefined,
      onChange: (state) => seen.push(`browser:${state.holder}`)
    });

    await control.transfer('user');
    expect(seen).toEqual(['desktop:user', 'browser:user']);

    // A browser session that closed stops being told, and stops being released.
    detach();
    await control.transfer('agent');
    expect(seen).toEqual(['desktop:user', 'browser:user', 'desktop:agent']);
  });

  it('refuses in the words of the surface that was asked', async () => {
    const control = new DesktopControl({ subject: 'Browser control' });
    await control.transfer('user');
    await expect(control.submit('agent', async () => 'nope')).rejects.toThrow(
      'Browser control is held by user'
    );
  });
});
