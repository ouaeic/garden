import type * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAction } from '@garden/contracts';
import { DisplayEncoder, DisplayMessageType, type DisplayGeometry } from './desktop-stream.js';
import {
  DesktopManager,
  type DesktopNode,
  type DesktopStreamState,
  type DesktopSubscriber
} from './desktop.js';
import { DesktopControl } from './holder.js';

/**
 * The half of `desktop.ts` that performs actions, rather than the half that classifies them.
 *
 * `desktop.test.ts` covers `classifyDesktopAction`, `selectDesktopNodes`, `toX11Keysym`, the four
 * xdotool argument builders and `DesktopControl` in isolation, and not one of its cases reaches
 * `act` or `#perform`. Everything between the two - the preflight round trip, the approval gate,
 * the control queue, the coordinate conversion that makes the agent's screenshot pixels into
 * display pixels, and which of xdotool, ffmpeg or the accessibility bridge an action becomes - ran
 * under no test at all. Finding cu F2 (`text_input` refused for the agent after the classifier was
 * rewritten to allow it) lives exactly there, and the green suite said nothing.
 *
 * `spawn` is stubbed rather than the private `#run`, so the shipped `run()` helper, its output
 * accounting, its exit handling and the whole NDJSON bridge channel are the real code: a test that
 * replaced `#run` would stop measuring the thing that turns an action into a process.
 */

interface SpawnCall {
  executable: string;
  args: string[];
  stdin: string;
  signal: AbortSignal | undefined;
}

/**
 * What the stubbed processes answer, and what they were asked. Module-level rather than hoisted
 * because the mock factory below only dereferences it when a spawn actually happens, which is
 * inside a test and long after this module has evaluated.
 */
const processes = {
  calls: [] as SpawnCall[],
  /** Every request that reached the accessibility bridge, in order, already parsed. */
  requests: [] as Array<Record<string, unknown>>,
  nodes: [] as DesktopNode[],
  still: Buffer.from('zoomed-jpeg-bytes'),
  /** Executables that exit non-zero, and the diagnostic they print. */
  fails: new Map<string, string>(),
  blocked: new Set<string>(),
  afterExit: undefined as ((call: SpawnCall) => void) | undefined,
  reset(): void {
    processes.calls = [];
    processes.requests = [];
    processes.nodes = [];
    processes.fails = new Map();
    processes.blocked = new Set();
    processes.afterExit = undefined;
  },
  argumentsFor(executable: string): string[][] {
    return processes.calls
      .filter((call) => call.executable === executable)
      .map((call) => call.args);
  },
  operations(): string[] {
    return processes.requests.map((request) => String(request.operation));
  }
};

const bridgeResponse = (request: Record<string, unknown>): Record<string, unknown> => {
  const operation = String(request.operation);
  if (operation === 'ping') return { result: { ok: true, atspi: true } };
  if (operation === 'observe')
    return {
      activeApplication: 'Text Editor',
      windows: [{ id: '0', name: 'Text Editor', role: 'frame' }],
      nodes: processes.nodes
    };
  if (operation === 'node') {
    const found = processes.nodes.find((node) => node.id === request.nodeId);
    if (!found) return { error: `No accessible node at ${String(request.nodeId)}` };
    return { result: found };
  }
  if (operation === 'act') {
    const action = request.action as { type: string; nodeId: string };
    return { result: { ok: true, action: action.type, nodeId: action.nodeId } };
  }
  return { error: `Unsupported desktop bridge operation: ${operation}` };
};

class FakeStream extends EventEmitter {
  setEncoding(): void {
    // The bridge channel asks for utf8; the fake already emits strings on that path.
  }
  resume(): void {
    // `#openBridge` drains stderr so python never blocks on an unread pipe.
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly pid = 4242;
  exitCode: number | null = null;
  stdin: {
    end: (data?: string) => void;
    write: (chunk: string, callback?: (error: Error | null) => void) => boolean;
  } = { end: () => undefined, write: () => true };

  kill(): boolean {
    if (this.exitCode !== null) return false;
    this.exitCode = 137;
    this.emit('exit', null, 'SIGKILL');
    this.emit('close', null, 'SIGKILL');
    return true;
  }
}

/**
 * One process. A `--serve` bridge stays open and answers a line at a time; everything else is the
 * one-shot shape `run()` expects - write stdin, read stdout, exit, close.
 */
function fakeSpawn(
  executable: string,
  args: readonly string[],
  options: { signal?: AbortSignal } = {}
): FakeChild {
  const call: SpawnCall = { executable, args: [...args], stdin: '', signal: options.signal };
  processes.calls.push(call);
  const child = new FakeChild();
  const abort = () => child.kill();
  options.signal?.addEventListener('abort', abort, { once: true });
  child.once('exit', () => options.signal?.removeEventListener('abort', abort));
  if (options.signal?.aborted) queueMicrotask(abort);
  if (args.includes('--serve')) {
    child.stdin = {
      end: () => undefined,
      write: (chunk, callback) => {
        const request = JSON.parse(chunk.trim()) as Record<string, unknown>;
        processes.requests.push(request);
        setImmediate(() =>
          child.stdout.emit('data', `${JSON.stringify(bridgeResponse(request))}\n`)
        );
        callback?.(null);
        return true;
      }
    };
    return child;
  }
  child.stdin = {
    end: (data?: string) => {
      call.stdin = data ?? '';
      setImmediate(() => {
        if (child.exitCode !== null || processes.blocked.has(executable)) return;
        const failure = processes.fails.get(executable);
        if (failure) {
          child.stderr.emit('data', Buffer.from(failure));
          child.exitCode = 1;
          child.emit('exit', 1, null);
          child.emit('close', 1, null);
          return;
        }
        if (executable === '/usr/bin/ffmpeg') child.stdout.emit('data', processes.still);
        if (executable === '/usr/bin/python3') {
          const request = JSON.parse(call.stdin || '{}') as Record<string, unknown>;
          processes.requests.push(request);
          child.stdout.emit('data', Buffer.from(JSON.stringify(bridgeResponse(request))));
        }
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        processes.afterExit?.(call);
      });
    },
    write: () => true
  };
  return child;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    spawn: (executable: string, args: readonly string[], options?: { signal?: AbortSignal }) =>
      fakeSpawn(executable, args, options)
  };
});

/**
 * A display well above the agent's image ceiling, so the two coordinate spaces are genuinely
 * different and the conversion in `#perform` is measured rather than assumed. 2560x1600 reduces to
 * exactly 1440x900 - the box the action contract bounds a coordinate to - at a scale of 0.5625.
 */
const GEOMETRY: DisplayGeometry = { width: 2560, height: 1600 };

const node = (overrides: Partial<DesktopNode> = {}): DesktopNode => ({
  id: '0/2/5',
  parentId: '0/2',
  name: 'Open document',
  description: '',
  role: 'push button',
  states: ['enabled', 'showing', 'sensitive'],
  actions: ['click'],
  interfaces: ['action', 'component'],
  // Display pixels, which is what AT-SPI reports; the runner scales them into the agent's space.
  bounds: { x: 400, y: 200, width: 100, height: 36 },
  sensitive: false,
  ...overrides
});

type Session = Awaited<ReturnType<DesktopManager['ensure']>>;

interface HarnessSession {
  control: DesktopControl;
  geometry: DisplayGeometry;
  lastAction: string;
  pointer: { x: number; y: number };
  bridgeServe: boolean;
  atspi: boolean;
  /** The stream half, which the transport and back-pressure cases below read directly. */
  codec: 'avc1' | 'jpeg';
  congested: boolean;
  encoder: DisplayEncoder;
}

interface Harness {
  manager: DesktopManager;
  session: HarnessSession;
  /** Every holder handover that released latched keys and buttons, in order. */
  released: string[];
}

/**
 * `ensure` spawns the session script, waits up to eight seconds for an environment file and adopts
 * the RandR state. None of that is what this file measures, so it is the one seam replaced;
 * everything below it is the shipped code.
 */
class PerformManager extends DesktopManager {
  constructor(private readonly fake: Session) {
    super('/usr/libexec/garden-desktop-bridge.py', '/usr/libexec/start-desktop-session.sh');
  }

  override async ensure(): Promise<Session> {
    return this.fake;
  }
}

const buildHarness = async (
  actor: 'agent' | 'user' = 'agent',
  settleMs = 500
): Promise<Harness> => {
  const released: string[] = [];
  const control = new DesktopControl({
    settleMs,
    // Production wires this to `#releaseAllInput`; `desktop.test.ts` already holds the ordering
    // rules of the control itself, so this records that the handover happened.
    release: async () => {
      released.push('released');
    },
    onChange: () => undefined
  });
  const session = {
    root: '/nonexistent',
    process: new FakeChild(),
    env: {
      DISPLAY: ':91',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
    },
    control,
    subscribers: new Map<string, unknown>(),
    applicationGroups: new Set<number>(),
    activeApplication: 'Text Editor',
    lastAction: '',
    geometry: GEOMETRY,
    bootGeometry: GEOMETRY,
    ceiling: { width: 3840, height: 2160 },
    outputName: 'screen',
    currentMode: null,
    codec: 'avc1',
    congested: false,
    // What the bridge's readiness probe answered. Production reads it off `ping`; a session that
    // said no is the subject of its own case below.
    atspi: true,
    bridgeServe: true,
    bridgeQueue: Promise.resolve(),
    pointer: { x: 1280, y: 800 },
    encoder: new DisplayEncoder({
      executable: '/usr/bin/ffmpeg',
      spawn: () => ({
        stdout: null,
        stderr: null,
        kill: () => true,
        on: () => undefined
      }),
      onFrame: () => undefined
    })
  };
  const harness: Harness = {
    manager: new PerformManager(session as unknown as Session),
    session: session as unknown as HarnessSession,
    released
  };
  // A control always starts on the agent, so the owner has to take it before their own actions
  // are authorised - which is the same handover the Computer pane's Take over button performs.
  if (actor === 'user') {
    await harness.manager.setHolder('workspace-1', '/nonexistent', 'user');
    released.length = 0;
  }
  return harness;
};

const act = (
  harness: Harness,
  action: Record<string, unknown>,
  actor: 'agent' | 'user',
  consequentialApproved = false
): Promise<unknown> =>
  harness.manager.act(
    'workspace-1',
    '/nonexistent',
    DesktopAction.parse(action),
    actor,
    consequentialApproved
  );

/** The AT-SPI operations an agent pays for before an action of this kind runs at all. */
const preflightOf = (actor: 'agent' | 'user', operations: string[]): string[] =>
  actor === 'agent' ? ['ping', ...operations] : ['ping'];

beforeEach(() => {
  processes.reset();
  processes.nodes = [
    node({
      id: '0',
      parentId: null,
      name: 'Text Editor',
      role: 'frame',
      bounds: { x: 0, y: 0, width: 2560, height: 1600 }
    }),
    node(),
    node({
      id: '0/2/6',
      name: 'Save changes',
      bounds: { x: 1200, y: 680, width: 120, height: 40 }
    }),
    node({
      id: '0/3',
      name: 'Search',
      role: 'text',
      states: ['enabled', 'showing', 'sensitive', 'focused'],
      actions: [],
      bounds: { x: 300, y: 900, width: 600, height: 40 }
    })
  ];
});

for (const actor of ['agent', 'user'] as const) {
  describe(`every desktop action, performed by the ${actor}`, () => {
    it('invokes a named control through the accessibility bridge', async () => {
      const harness = await buildHarness(actor);
      const result = await act(harness, { type: 'invoke', nodeId: '0/2/5' }, actor);
      expect(result).toEqual({ result: { ok: true, action: 'invoke', nodeId: '0/2/5' } });
      // The agent pays a second round trip: the node is described before it is judged.
      expect(processes.operations()).toEqual(preflightOf(actor, ['node']).concat('act'));
      expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
    });

    it('focuses a named control through the accessibility bridge', async () => {
      const harness = await buildHarness(actor);
      const result = await act(harness, { type: 'focus', nodeId: '0/3' }, actor);
      expect(result).toEqual({ result: { ok: true, action: 'focus', nodeId: '0/3' } });
      expect(processes.operations()).toEqual(preflightOf(actor, ['node']).concat('act'));
    });

    it('sets a field’s text through the accessibility bridge rather than the keyboard', async () => {
      const harness = await buildHarness(actor);
      const result = await act(
        harness,
        { type: 'set_text', nodeId: '0/3', text: 'invoices' },
        actor
      );
      expect(result).toEqual({ result: { ok: true, action: 'set_text', nodeId: '0/3' } });
      expect(processes.operations()).toEqual(preflightOf(actor, ['node']).concat('act'));
      // Nothing was typed: the semantic path never touches X11 input.
      expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
    });

    it('clicks a coordinate in the space that actor is looking at', async () => {
      const harness = await buildHarness(actor);
      await act(harness, { type: 'click_at', x: 250, y: 120 }, actor);
      // The agent reads its coordinates off a 1440x900 still of a 2560x1600 screen; the owner
      // reads theirs off the screen itself. The same pair of numbers is therefore two places.
      expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([
        actor === 'agent'
          ? ['mousemove', '--sync', '444', '213', 'click', '1']
          : ['mousemove', '--sync', '250', '120', 'click', '1']
      ]);
      expect(harness.session.lastAction).not.toBe('');
    });

    it('repeats a multiple click with a delay the toolkit can see', async () => {
      const harness = await buildHarness(actor);
      await act(harness, { type: 'click_at', x: 250, y: 120, button: 'right', clicks: 2 }, actor);
      expect(processes.argumentsFor('/usr/bin/xdotool')[0]?.slice(4)).toEqual([
        'click',
        '--repeat',
        '2',
        '--delay',
        '100',
        '3'
      ]);
    });

    it('drags as one chained invocation, pressing, moving and releasing', async () => {
      const harness = await buildHarness(actor);
      await act(
        harness,
        { type: 'drag', fromX: 100, fromY: 100, toX: 500, toY: 400, durationMs: 500 },
        actor,
        true
      );
      const args = processes.argumentsFor('/usr/bin/xdotool')[0] ?? [];
      const from = actor === 'agent' ? ['178', '178'] : ['100', '100'];
      expect(args.slice(0, 6)).toEqual(['mousemove', '--sync', ...from, 'mousedown', '1']);
      expect(args.slice(-4)).toEqual(['sleep', '0.05', 'mouseup', '1']);
      // Coordinate bookkeeping uses display pixels for both actors.
      expect(harness.session.pointer).toEqual(
        actor === 'agent' ? { x: 889, y: 711 } : { x: 500, y: 400 }
      );
    });

    it('presses a key by its X11 keysym rather than its DOM name', async () => {
      const harness = await buildHarness(actor);
      await act(harness, { type: 'press', key: 'Tab' }, actor);
      expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([['key', 'Tab']]);
    });

    it('scrolls with a bounded wheel burst', async () => {
      const harness = await buildHarness(actor);
      await act(harness, { type: 'scroll', direction: 'down', amount: 40 }, actor);
      const args = processes.argumentsFor('/usr/bin/xdotool')[1] ?? [];
      // Bounded at twelve ticks: a trackpad fling otherwise queues hundreds of synthetic clicks
      // behind the next action.
      expect(args).toEqual(['click', '--repeat', '12', '--delay', '0', '5']);
    });

    it('waits for the interval it was given, and says how long it waited', async () => {
      const harness = await buildHarness(actor);
      const started = Date.now();
      const result = await act(harness, { type: 'wait', milliseconds: 60 }, actor);
      expect(result).toEqual({ waitedMilliseconds: 60 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
      // No process at all: a wait is the one action that is entirely the runner's own.
      expect(processes.calls).toEqual([]);
    });

    /**
     * Zoom converts the agent's rectangle into display pixels and crops there, so the model never
     * does arithmetic. Note what comes back: `screenshotBase64` on a `desktop_action` result, which
     * the worker attaches for `browser_snapshot` and `desktop_observe` only (ledger #7). Until that
     * is keyed on the field rather than the tool name, this image reaches the model as base64 text.
     */
    it('zooms by cropping the display where the agent’s rectangle lands', async () => {
      const harness = await buildHarness(actor);
      const result = await act(
        harness,
        { type: 'zoom', x: 100, y: 200, width: 300, height: 120 },
        actor
      );
      expect(result).toEqual({
        screenshotBase64: processes.still.toString('base64'),
        screenshotMimeType: 'image/jpeg',
        region: { x: 178, y: 356, width: 533, height: 213 },
        displayWidth: 2560,
        displayHeight: 1600
      });
      const args = processes.argumentsFor('/usr/bin/ffmpeg')[0] ?? [];
      expect(args).toContain('-vf');
      expect(args[args.indexOf('-vf') + 1]).toBe('crop=533:213:178:356');
      expect(args).toContain(':91');
    });

    it('reports what the command printed when a tool is missing, rather than a bare exit code', async () => {
      const harness = await buildHarness(actor);
      processes.fails.set('/usr/bin/xdotool', 'xdotool: command not found');
      await expect(act(harness, { type: 'press', key: 'Tab' }, actor)).rejects.toThrow(
        /command not found/
      );
    });
  });
}

describe('typing at the desktop keyboard', () => {
  it('types for the owner, at a delay the keymap can keep up with', async () => {
    const harness = await buildHarness();
    await harness.manager.setHolder('workspace-1', '/nonexistent', 'user');
    await act(harness, { type: 'text_input', text: 'invoices' }, 'user');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([
      ['type', '--delay', '12', '--', 'invoices']
    ]);
  });

  /**
   * `classifyDesktopAction` was deliberately rewritten so the agent may type into an ordinary
   * field - "a password box is still a handoff; a search box is typing" - and `#classify` resolves
   * the focused node for exactly that purpose. `#perform` then threw `Private desktop text is
   * user-only` for any actor but the owner, so the whole non-sensitive branch was unreachable and
   * an ordinary field hard-errored where it should have typed. No test reached it because every
   * existing case called the classifier directly (#8, cu F2).
   *
   * Driven through `act`, with the same five arguments the route passes, because calling the
   * classifier is what missed it.
   */
  it('types into an ordinary field for the agent, as the classifier already allows', async () => {
    const harness = await buildHarness();
    // The focused node in the default tree is the "Search" text field: named, not read-only, and
    // nothing about it reads as a secret.
    await act(harness, { type: 'text_input', text: 'invoices' }, 'agent');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([
      ['type', '--delay', '12', '--', 'invoices']
    ]);
    // The round trip that resolves the focused node is what the judgement was made on, not a
    // pessimistic guess about all typing.
    expect(processes.operations()).toEqual(['ping', 'observe']);
  });

  it('still hands a focused password field to the owner rather than typing into it', async () => {
    const harness = await buildHarness();
    processes.nodes = [
      node({
        id: '0/4',
        name: 'Password',
        role: 'password text',
        states: ['enabled', 'showing', 'sensitive', 'focused'],
        sensitive: true,
        actions: []
      })
    ];
    await expect(act(harness, { type: 'text_input', text: 'hunter2' }, 'agent')).rejects.toThrow(
      /Secure desktop input takeover is required/
    );
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
  });

  /**
   * The other half of what the deleted line was doing by accident: a screen the computer cannot
   * read is not a screen to type a value into, and `classifyDesktopAction` judges an unknown
   * focused field secret for that reason. Pinned because deleting the actor check is only safe
   * while this holds.
   */
  it('hands typing to the owner when nothing focused can be identified at all', async () => {
    const harness = await buildHarness();
    harness.session.atspi = false;
    await expect(act(harness, { type: 'text_input', text: 'invoices' }, 'agent')).rejects.toThrow(
      /Secure desktop input takeover is required/
    );
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
  });
});

describe('what the desktop refuses', () => {
  it('refuses the agent while the owner holds the machine, and releases input on the way', async () => {
    const harness = await buildHarness();
    const state = await harness.manager.setHolder('workspace-1', '/nonexistent', 'user');
    expect(state).toEqual({ holder: 'user', generation: 2 });
    expect(harness.released).toEqual(['released']);
    await expect(act(harness, { type: 'press', key: 'Tab' }, 'agent')).rejects.toThrow(
      /Desktop control is held by user/
    );
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
  });

  it('lets the owner act during secure input, and keeps the agent out', async () => {
    const harness = await buildHarness();
    await harness.manager.setHolder('workspace-1', '/nonexistent', 'secure_input');
    await expect(act(harness, { type: 'press', key: 'Tab' }, 'agent')).rejects.toThrow(
      /Desktop control is held by secure_input/
    );
    await act(harness, { type: 'press', key: 'Tab' }, 'user');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([['key', 'Tab']]);
  });

  it('stops a coordinate click that lands on nothing this computer can name', async () => {
    const harness = await buildHarness();
    // Only the two buttons, so a point outside them resolves to no control at all.
    processes.nodes = [node(), node({ id: '0/2/6', name: 'Save changes' })];
    await expect(act(harness, { type: 'click_at', x: 1400, y: 880 }, 'agent')).rejects.toThrow(
      /consequential-action approval capability is required/
    );
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
    await act(harness, { type: 'click_at', x: 1400, y: 880 }, 'agent', true);
    expect(processes.argumentsFor('/usr/bin/xdotool')).toHaveLength(1);
  });

  /**
   * The relaxation the pixel path was rebuilt around: a coordinate that lands inside a control the
   * accessibility tree already described is judged as clicking that control, so an ordinary button
   * needs no card and a grave one still does.
   */
  it('lets a coordinate click on a named ordinary control through, and stops one on a grave one', async () => {
    const harness = await buildHarness();
    // Image space: the ordinary button is at 225,113 and "Save changes" at 675,383.
    await act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toHaveLength(1);
    await expect(act(harness, { type: 'click_at', x: 700, y: 390 }, 'agent')).rejects.toThrow(
      /consequential-action approval capability is required/
    );
  });

  it('stops Enter, which submits whatever has focus', async () => {
    const harness = await buildHarness();
    await expect(act(harness, { type: 'press', key: 'Enter' }, 'agent')).rejects.toThrow(
      /consequential-action approval capability is required/
    );
    await act(harness, { type: 'press', key: 'Enter' }, 'agent', true);
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([['key', 'Return']]);
  });

  it('hands a password field to the owner rather than writing into it', async () => {
    const harness = await buildHarness();
    processes.nodes = [
      node({ id: '0/4', name: 'Password', role: 'password text', sensitive: true, actions: [] })
    ];
    await expect(
      act(harness, { type: 'set_text', nodeId: '0/4', text: 'hunter2' }, 'agent')
    ).rejects.toThrow(/Secure desktop input takeover is required/);
    expect(processes.operations()).toEqual(['ping', 'node']);
  });

  it('carries the bridge’s own refusal back rather than reporting a success', async () => {
    const harness = await buildHarness();
    await expect(act(harness, { type: 'invoke', nodeId: '9/9/9' }, 'agent')).rejects.toThrow(
      /No accessible node at 9\/9\/9/
    );
  });

  it('falls back to one process per request when the serve channel will not hold', async () => {
    const harness = await buildHarness('user');
    harness.session.bridgeServe = false;
    const result = await act(harness, { type: 'invoke', nodeId: '0/2/5' }, 'user');
    expect(result).toEqual({ result: { ok: true, action: 'invoke', nodeId: '0/2/5' } });
    // No `--serve`, and the request arrived on the child's stdin instead.
    expect(processes.argumentsFor('/usr/bin/python3')).toEqual([
      ['/usr/libexec/garden-desktop-bridge.py']
    ]);
    expect(processes.operations()).toEqual(['act']);
  });
});

/**
 * The staleness mechanism, reached the way production reaches it.
 *
 * `DesktopControl.authorize` has refused work computed from a superseded observation since it was
 * written, and for that whole time nothing named a generation: `/desktop/action` called `act` with
 * five arguments, the stream route with four, and `DesktopAction` has no field for the model to
 * echo - so the refusal existed only in a test that passed a sixth argument by hand (ledger #9).
 * The supplier is now the session: `snapshot` records what it served the agent and `act` names it.
 *
 * Every case below goes through the same five-argument `act` helper the route uses. That is the
 * point: an argument only a test passes is how this shipped unwired, so no case here may pass one.
 */
describe('a coordinate action computed from an observation the screen has moved under', () => {
  /** What the agent doing its job looks like: observe, then act on what it saw. */
  const observe = (harness: Harness): Promise<unknown> =>
    harness.manager.snapshot('workspace-1', '/nonexistent', 'agent');

  /** A handover and back - what the owner closing a dialog does, twice over the generation. */
  const ownerTakesAndReturns = async (harness: Harness): Promise<void> => {
    await harness.manager.setHolder('workspace-1', '/nonexistent', 'user');
    await harness.manager.setHolder('workspace-1', '/nonexistent', 'agent');
  };

  it('performs it while the observation it was read off is still the current one', async () => {
    const harness = await buildHarness();
    await observe(harness);
    await act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toHaveLength(1);
  });

  it('refuses it once the holder has moved underneath it', async () => {
    const harness = await buildHarness();
    await observe(harness);
    await ownerTakesAndReturns(harness);
    processes.calls = [];
    processes.requests = [];
    await expect(act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent')).rejects.toThrow(
      /is stale; observe the desktop again/
    );
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
    // And the refusal comes before the preflight round trip, not after it.
    expect(processes.operations()).toEqual([]);
  });

  it('refuses a drag and a zoom on the same evidence, and lets a keystroke through', async () => {
    const harness = await buildHarness();
    await observe(harness);
    await ownerTakesAndReturns(harness);
    await expect(
      act(
        harness,
        { type: 'drag', fromX: 100, fromY: 100, toX: 500, toY: 400, durationMs: 500 },
        'agent',
        true
      )
    ).rejects.toThrow(/is stale; observe the desktop again/);
    await expect(
      act(harness, { type: 'zoom', x: 100, y: 200, width: 300, height: 120 }, 'agent')
    ).rejects.toThrow(/is stale; observe the desktop again/);
    // A keystroke goes to whatever has focus, not to a place on a picture, so it is not stale.
    await act(harness, { type: 'press', key: 'Tab' }, 'agent', true);
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([['key', 'Tab']]);
  });

  it('performs the same click again once the agent has observed the new screen', async () => {
    const harness = await buildHarness();
    await observe(harness);
    await ownerTakesAndReturns(harness);
    await expect(act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent')).rejects.toThrow(
      /is stale/
    );
    // The refusal is one the model can answer, and this is the answer: look again.
    await observe(harness);
    await act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toHaveLength(1);
  });

  it('does not let the owner’s own observation clear the mark the agent is held to', async () => {
    const harness = await buildHarness();
    await observe(harness);
    await ownerTakesAndReturns(harness);
    // The Computer pane polls the same route. If a human's look counted, the owner watching would
    // be what re-armed the agent's coordinates - and the owner is who moved things.
    await harness.manager.snapshot('workspace-1', '/nonexistent', 'user');
    await expect(act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent')).rejects.toThrow(
      /is stale; observe the desktop again/
    );
  });

  /**
   * The owner is never held to the agent's observation, and this is the case that says why it has
   * to be written as a condition rather than left to the mark being empty: here the mark is set,
   * by the agent, and then the owner takes the machine. Without the actor test they would be
   * refused from the pane they are watching the screen in - the takeover refusing the person the
   * takeover is for.
   */
  it('does not hold the owner to an observation the agent took', async () => {
    const harness = await buildHarness();
    await observe(harness);
    await harness.manager.setHolder('workspace-1', '/nonexistent', 'user');
    await act(harness, { type: 'click_at', x: 250, y: 120 }, 'user');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toHaveLength(1);
  });

  /**
   * An agent that has observed nothing has no observation to be superseded, so the refusal - whose
   * words are "observe the desktop again" - would be describing something that did not happen. The
   * blind-click gate is what stands there instead, and it is what this case actually measures: the
   * click needs an approval, not a re-observation.
   */
  it('does not refuse an agent that has not observed this session at all', async () => {
    const harness = await buildHarness();
    await ownerTakesAndReturns(harness);
    await act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toHaveLength(1);
  });
});

/**
 * A session whose toolkit never joined the accessibility bus.
 *
 * The bridge's `ping` has always answered `atspi: false` on such a host and the runner has always
 * thrown that answer away, so the condition was rediscovered one failed `observe` at a time - each
 * a python round trip that could only fail, each reported to the model as "accessibility bridge
 * failed", which reads like a crash rather than like a desktop with no semantic layer to offer.
 */
describe('a desktop with no accessibility stack', () => {
  it('says so, once, instead of failing an observation every time', async () => {
    const harness = await buildHarness();
    harness.session.atspi = false;
    const snapshot = await harness.manager.snapshot('workspace-1', '/nonexistent', 'agent');
    expect(snapshot.mode).toBe('visual_fallback');
    expect(snapshot.message).toContain('no accessibility stack');
    expect(snapshot.nodes).toEqual([]);
    // No `observe`: the round trip could only have timed out.
    expect(processes.operations()).toEqual([]);
    // The screenshot is still there, which is the half of the surface that does work.
    expect(snapshot.screenshotBase64).toBe(processes.still.toString('base64'));
  });

  it('judges a coordinate click as blind, because there is nothing to attribute it to', async () => {
    const harness = await buildHarness();
    harness.session.atspi = false;
    await expect(act(harness, { type: 'click_at', x: 250, y: 120 }, 'agent')).rejects.toThrow(
      /consequential-action approval capability is required/
    );
    expect(processes.operations()).toEqual([]);
  });
});

/**
 * What happens on a host that has no `/usr/bin/ffmpeg`.
 *
 * `spawn` does not throw for a missing executable - it hands back a child and reports ENOENT
 * asynchronously on `'error'` - so the `try` around the spawn call caught nothing, and nothing
 * listened for `'error'`. That is the one event node re-raises as an uncaught exception: the first
 * viewer to open the Computer pane on such a host ended the runner process, killing every command,
 * terminal and turn on the box, because a video encoder was not installed.
 */
describe('an encoder that cannot run', () => {
  class EncoderChild extends EventEmitter {
    readonly stdout = null;
    readonly stderr = null;
    killed = false;
    kill(): boolean {
      this.killed = true;
      return true;
    }
  }

  const config = {
    display: ':91',
    geometry: GEOMETRY,
    codec: 'avc1' as const,
    framerate: 30,
    crf: 26,
    maxBitrateKbps: 6_000,
    jpegQuality: 6,
    border: { color: '#f97316', thickness: 3 },
    generation: 1
  };

  const failing = (): { encoder: DisplayEncoder; children: EncoderChild[]; failures: Error[] } => {
    const children: EncoderChild[] = [];
    const failures: Error[] = [];
    const encoder = new DisplayEncoder({
      executable: '/usr/bin/ffmpeg',
      spawn: () => {
        const child = new EncoderChild();
        children.push(child);
        return child as never;
      },
      onFrame: () => undefined,
      onFailure: (error) => failures.push(error),
      restartDelayMs: 500,
      maxRestartDelayMs: 8_000
    });
    return { encoder, children, failures };
  };

  it('survives the missing executable rather than ending the process', () => {
    const { encoder, children, failures } = failing();
    encoder.apply(config);
    expect(children).toHaveLength(1);
    // An unlistened `'error'` throws out of `emit`; this assertion is the whole defect.
    expect(() =>
      children[0]?.emit('error', new Error('spawn /usr/bin/ffmpeg ENOENT'))
    ).not.toThrow();
    expect(failures.map((error) => error.message)).toEqual(['spawn /usr/bin/ffmpeg ENOENT']);
    expect(encoder.running).toBe(false);
    encoder.stop();
  });

  it('backs off while the failure keeps happening, and starts over once it stops', () => {
    vi.useFakeTimers();
    try {
      const { encoder, children, failures } = failing();
      encoder.apply(config);
      const delays: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        children[attempt]?.emit('error', new Error('spawn /usr/bin/ffmpeg ENOENT'));
        delays.push(encoder.retryDelayMs);
        vi.advanceTimersByTime(encoder.retryDelayMs);
      }
      // Doubling from the configured first wait, and held at the ceiling rather than growing for
      // ever: a transient failure still recovers within a frame or two, and a permanent one costs
      // a spawn every eight seconds instead of two a second for as long as anybody watches.
      expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
      expect(failures).toHaveLength(5);
      encoder.stop();
      // A viewer left and came back: nothing is being carried over from what was failing.
      encoder.apply(config);
      expect(encoder.retryDelayMs).toBe(500);
      encoder.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('where a wheel burst lands', () => {
  const targetFocusedWindow = [
    'getactivewindow',
    'mousemove',
    '--sync',
    '--window',
    '%1',
    '--polar',
    '0',
    '0'
  ];

  for (const actor of ['agent', 'user'] as const) {
    it.each([
      ['up', '4'],
      ['down', '5'],
      ['left', '6'],
      ['right', '7']
    ])(
      `targets the focused window before a physical wheel burst for ${actor}: %s`,
      async (direction, button) => {
        const harness = await buildHarness(actor);
        harness.session.pointer = { x: 12, y: 34 };
        await act(harness, { type: 'scroll', direction, amount: 3 }, actor);
        expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([
          targetFocusedWindow,
          ['click', '--repeat', '3', '--delay', '0', button]
        ]);
      }
    );
  }

  it('does not scroll at the stale pointer when the focused window cannot be resolved', async () => {
    const harness = await buildHarness();
    processes.fails.set('/usr/bin/xdotool', 'No active window');
    await expect(
      act(harness, { type: 'scroll', direction: 'down', amount: 3 }, 'agent')
    ).rejects.toThrow('No active window');
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([targetFocusedWindow]);
  });

  it('cancels a queued scroll when the owner takes control', async () => {
    const harness = await buildHarness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = harness.session.control.submit('agent', async () => gate);
    const scrolling = act(harness, { type: 'scroll', direction: 'down', amount: 3 }, 'agent');
    const rejected = expect(scrolling).rejects.toThrow('Desktop control was handed to user');
    await vi.waitFor(() => expect(harness.session.control.pending).toBe(1));
    const takeover = harness.manager.setHolder('workspace-1', '/nonexistent', 'user');
    await vi.waitFor(() => expect(harness.session.control.pending).toBe(0));
    release();
    await Promise.all([active, takeover, rejected]);
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([]);
    expect(harness.released).toEqual(['released']);
  });

  it('aborts focus positioning on takeover and sends no wheel input afterward', async () => {
    const harness = await buildHarness('agent', 1);
    processes.blocked.add('/usr/bin/xdotool');
    const scrolling = act(harness, { type: 'scroll', direction: 'down', amount: 3 }, 'agent');
    const rejected = expect(scrolling).rejects.toThrow();
    await vi.waitFor(() => expect(processes.argumentsFor('/usr/bin/xdotool')).toHaveLength(1));
    await harness.manager.setHolder('workspace-1', '/nonexistent', 'user');
    await rejected;
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([targetFocusedWindow]);
    expect(
      processes.calls.find((call) => call.executable === '/usr/bin/xdotool')?.signal?.aborted
    ).toBe(true);
    expect(harness.released).toEqual(['released']);
    processes.blocked.clear();
    await act(harness, { type: 'press', key: 'Tab' }, 'user');
    expect(processes.argumentsFor('/usr/bin/xdotool').at(-1)).toEqual(['key', 'Tab']);
  });

  it('checks cancellation after positioning succeeds before launching the wheel process', async () => {
    const harness = await buildHarness();
    const cancellation = new AbortController();
    const submit = harness.session.control.submit.bind(harness.session.control);
    vi.spyOn(harness.session.control, 'submit').mockImplementation((actor, task, options) =>
      submit(actor, (signal) => task(AbortSignal.any([signal, cancellation.signal])), options)
    );
    processes.afterExit = (call) => {
      if (call.executable === '/usr/bin/xdotool') cancellation.abort();
    };
    await expect(
      act(harness, { type: 'scroll', direction: 'down', amount: 3 }, 'agent')
    ).rejects.toThrow();
    expect(processes.argumentsFor('/usr/bin/xdotool')).toEqual([targetFocusedWindow]);
  });
});

/**
 * The stream's back pressure, and the transport it negotiates.
 *
 * `subscribeStream` and `refreshStream` are the two public doors into `#syncEncoder`, so
 * everything below drives the real one: the fake session carries a real `DisplayEncoder` whose
 * ffmpeg is the module-level spawn stub, and the states and configs asserted on are the ones the
 * WebSocket route forwards verbatim.
 */
describe('what the desktop stream negotiates with the client watching it', () => {
  interface Watcher {
    states: DesktopStreamState[];
    frames: Array<{ frame: Buffer; state: DesktopStreamState }>;
  }

  const watch = (
    extra: Partial<DesktopSubscriber> = {}
  ): { watcher: Watcher; subscriber: DesktopSubscriber } => {
    const watcher: Watcher = { states: [], frames: [] };
    return {
      watcher,
      subscriber: {
        state: (state) => {
          watcher.states.push(state);
        },
        frame: (frame, state) => {
          watcher.frames.push({ frame, state });
        },
        ...extra
      }
    };
  };

  /** The `video_config` message the client configures its decoder from, read back off the wire. */
  const videoConfig = (frame: Buffer): Record<string, unknown> => {
    expect(frame.readUInt8(0)).toBe(DisplayMessageType.videoConfig);
    return JSON.parse(frame.subarray(1).toString('utf8')) as Record<string, unknown>;
  };

  /**
   * Written against the decision in the UI plan's 1C-3, and against what the code did before it:
   * `session.codec` was assigned `'avc1'` once, at session creation, and never again. Every branch
   * that reads `'jpeg'` - the encoder's mjpeg arguments, `JpegFrameReader`, `encodeJpegFrame`, the
   * `jpeg-frame-v1` transport and the `image/jpeg` codec string on the state - was therefore
   * unreachable from a running system, and a viewer without `VideoDecoder` was sent H.264 access
   * units and showed a blank pane with no error at all.
   */
  it('drops the whole session to jpeg for a viewer that cannot decode video', async () => {
    const harness = await buildHarness();
    const { watcher, subscriber } = watch({ canDecodeVideo: () => false });
    await harness.manager.subscribeStream('workspace-1', '/nonexistent', subscriber);

    expect(harness.session.codec).toBe('jpeg');
    // The last state and the last config are what a client acts on, and the two have to agree.
    expect(watcher.states.at(-1)).toMatchObject({
      transport: 'jpeg-frame-v1',
      codec: 'image/jpeg'
    });
    expect(videoConfig(watcher.frames.at(-1)!.frame)).toMatchObject({
      format: 'jpeg',
      codec: 'image/jpeg'
    });
    // The framing changed under a client that may already hold frames in the old one, which is
    // the same reason a resize takes a generation.
    expect(watcher.states.at(-1)!.generation).toBeGreaterThan(watcher.states[0]!.generation);
  });

  it('stays on h264 while every viewer can decode it, and says so on the state', async () => {
    const harness = await buildHarness();
    const { watcher, subscriber } = watch({ canDecodeVideo: () => true });
    await harness.manager.subscribeStream('workspace-1', '/nonexistent', subscriber);
    expect(harness.session.codec).toBe('avc1');
    expect(watcher.states.at(-1)).toMatchObject({ transport: 'h264-annexb-v1' });
    expect(videoConfig(watcher.frames.at(-1)!.frame)).toMatchObject({ format: 'annexb' });
  });

  it('answers a hello that arrives after the subscription, without waiting for the heartbeat', async () => {
    const harness = await buildHarness();
    // What the route does: subscribe first, then apply whatever the client's `hello` said. The
    // 250 ms poll would eventually notice, and every frame until then is one the client discards.
    let canDecodeVideo = true;
    const { watcher, subscriber } = watch({ canDecodeVideo: () => canDecodeVideo });
    await harness.manager.subscribeStream('workspace-1', '/nonexistent', subscriber);
    expect(harness.session.codec).toBe('avc1');

    canDecodeVideo = false;
    await harness.manager.refreshStream('workspace-1', '/nonexistent');
    expect(harness.session.codec).toBe('jpeg');
    expect(watcher.states.at(-1)).toMatchObject({ transport: 'jpeg-frame-v1' });
  });

  /**
   * The hysteresis `#syncEncoder` describes in its own comment - "production stops at the high
   * watermark and only resumes once somebody has drained back below the low one" - had no way to
   * run: the only caller of `subscribeStream` passed `{state, frame}` and no `bufferedBytes`, so
   * the depth read `0` everywhere and `session.congested` could never become true. This drives it
   * through the door the route now uses.
   */
  it('leaves a congested session stopped until the client has actually drained', async () => {
    const harness = await buildHarness();
    let buffered = 4 * 1024 * 1024;
    const { subscriber } = watch({ bufferedBytes: () => buffered });
    await harness.manager.subscribeStream('workspace-1', '/nonexistent', subscriber);
    harness.session.congested = true;

    // Still above the low watermark: a client a megabyte behind has not recovered.
    buffered = 1024 * 1024;
    await harness.manager.refreshStream('workspace-1', '/nonexistent');
    expect(harness.session.congested).toBe(true);
    expect(harness.session.encoder.running).toBe(false);

    buffered = 64 * 1024;
    await harness.manager.refreshStream('workspace-1', '/nonexistent');
    expect(harness.session.congested).toBe(false);
    expect(harness.session.encoder.running).toBe(true);
  });
});

/**
 * The zoom bound, at the caller that produces the arguments rather than at the argument builder.
 *
 * `stillCaptureArguments` is where the crop and the reduction are written, and `#perform` is the
 * only thing in production that passes it a region: it converts the agent's rectangle into display
 * pixels and hands over the same `image` box the full screenshot is reduced into. Pinned here so
 * that a bound proved in the builder is also proved to be reached.
 */
describe('a zoom that asks for more pixels than a screenshot carries', () => {
  it.each([
    { name: 'right edge', x: 1439, y: 20, capturedX: 1424, capturedY: 20 },
    { name: 'bottom edge', x: 20, y: 899, capturedX: 20, capturedY: 884 },
    { name: 'bottom right corner', x: 1439, y: 899, capturedX: 1424, capturedY: 884 },
    { name: 'interior', x: 100, y: 200, capturedX: 100, capturedY: 200 }
  ])(
    'reports the rectangle actually captured at the $name',
    async ({ x, y, capturedX, capturedY }) => {
      const harness = await buildHarness();
      harness.session.geometry = { width: 1440, height: 900 };
      const result = await act(harness, { type: 'zoom', x, y, width: 16, height: 16 }, 'agent');
      const calls = processes.argumentsFor('/usr/bin/ffmpeg');
      expect(calls).toHaveLength(1);
      const args = calls[0]!;
      expect(args[args.indexOf('-vf') + 1]).toBe(`crop=16:16:${capturedX}:${capturedY}`);
      expect(result).toMatchObject({
        region: { x: capturedX, y: capturedY, width: 16, height: 16 }
      });
    }
  );

  it('crops the region and reduces it into the box the full still is bounded to', async () => {
    const harness = await buildHarness();
    // The whole screen, in the agent's own coordinates. 1440x900 of image is the whole of a
    // 2560x1600 display - 4.1 megapixels, which is what came back before this was bounded - less
    // the one pixel `imageToDisplayPoint` keeps every coordinate inside the far edge by.
    const result = await act(
      harness,
      { type: 'zoom', x: 0, y: 0, width: 1440, height: 900 },
      'agent'
    );
    const args = processes.argumentsFor('/usr/bin/ffmpeg')[0] ?? [];
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=2559:1599:0:0,scale=1440:900:flags=lanczos');
    // The region is still reported in display pixels, because that is which part of the screen the
    // picture is of. What it does not say, and what the model is not told, is that this particular
    // one came back no closer than the screenshot it already had.
    expect(result).toMatchObject({ region: { x: 0, y: 0, width: 2559, height: 1599 } });
  });

  it('leaves a small region at its own density, which is what a zoom is for', async () => {
    const harness = await buildHarness();
    await act(harness, { type: 'zoom', x: 100, y: 200, width: 300, height: 120 }, 'agent');
    const args = processes.argumentsFor('/usr/bin/ffmpeg')[0] ?? [];
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=533:213:178:356');
  });
});
