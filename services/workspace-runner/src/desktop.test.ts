import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import type { DisplayViewport } from './desktop-stream.js';
import { chromiumDriver } from './playwright.js';
import { buildServer } from './server.js';
import {
  DesktopManager,
  classifyDesktopAction,
  clickCommand,
  dragCommand,
  imageToDisplayPoint,
  pressCommand,
  releaseAllInputCommand,
  scrollCommand,
  nodeUnderPoint,
  selectDesktopNodes,
  splitBridgeLines,
  toX11Keysym,
  typeCommand,
  type DesktopNode,
  type DesktopSubscriber
} from './desktop.js';

/**
 * The words AT-SPI actually uses, copied off a real tree rather than invented.
 *
 * A fixture written from memory - `['enabled']`, `['enabled', 'showing']`, an `interfaces` list in
 * title case - is a set the bridge can never emit, and a predicate keyed on a string that does not
 * exist in the AT-SPI vocabulary, such as `'disabled'` or `'read-only'`, is dead. A fixture built
 * from invented names agrees with an implementation built from invented names, and the suite stays
 * green while the screen the agent is looking at is described by neither.
 *
 * The vocabulary is `ATSPI_STATE_*` with the prefix removed and lowercased, which is what
 * `garden-desktop-bridge.py` emits and what `garden-desktop-bridge.test.py` pins. Note the two
 * that matter here: a control the user can operate is `sensitive`, and one they cannot simply
 * lacks it - there is no `disabled`; and a field that refuses input is `read_only`, one word with
 * an underscore, because the C name is `ATSPI_STATE_READ_ONLY`.
 */
const ENABLED_BUTTON = ['enabled', 'focusable', 'sensitive', 'showing', 'visible'];
/** Greyed out: the toolkit leaves it on screen and takes `sensitive` and `enabled` away. */
const GREYED_BUTTON = ['focusable', 'showing', 'visible'];
const FOCUSED_ENTRY = [
  'editable',
  'enabled',
  'focusable',
  'focused',
  'sensitive',
  'showing',
  'single_line',
  'visible'
];
/** A field that displays a value and refuses to take one - an account number, a computed total. */
const READ_ONLY_ENTRY = [
  'enabled',
  'focusable',
  'read_only',
  'sensitive',
  'showing',
  'single_line',
  'visible'
];

const node = (overrides: Partial<DesktopNode> = {}): DesktopNode => ({
  id: '0/1',
  parentId: '0',
  name: 'Open document',
  description: '',
  role: 'push button',
  states: ENABLED_BUTTON,
  actions: ['click'],
  interfaces: ['action', 'component'],
  bounds: { x: 10, y: 20, width: 100, height: 30 },
  sensitive: false,
  ...overrides
});

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A runner with nothing on it: no X server, no ffmpeg, no snapshots - just the routes. */
const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig => ({
  RUNNER_HOST: '127.0.0.1',
  RUNNER_PORT: 0,
  RUNNER_SHARED_SECRET: secret,
  WORKSPACE_ROOT: workspaceRoot,
  TAR_EXECUTABLE: '/usr/bin/tar',
  SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
  BROWSER_USE_DESKTOP_DISPLAY: false,
  BROWSER_CPU_NICE: 0,
  MAX_EXECUTION_SECONDS: 30,
  RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
  IMAGE_CONVERT_EXECUTABLE: 'magick',
  MAX_BACKGROUND_SECONDS: 120,
  COMMAND_PROCESS_LIMIT: 1024,
  COMMAND_OPEN_FILE_LIMIT: 4096,
  MAX_FILE_BYTES: 1024 * 1024,
  RESERVED_PREVIEW_PORTS: [],
  CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
  CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
  CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
  CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
  CHECKPOINT_RETAIN_TURNS: 20,
  CHECKPOINT_RETAIN_DAILY_DAYS: 14,
  CHECKPOINT_MAX_FILES: 250_000,
  CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
  ISOLATE_AGENT_NETWORK: false
});

/**
 * The accessibility bridge is python, and it decides what the agent believes is on the screen and
 * which widget an approved action lands on. It had no test of any kind - which is how a node id
 * could be an unverified positional path resolved twice, and a state name could be truncated to
 * its last word, for as long as they were.
 *
 * Its own suite is python because the code is; this runs it, so a change to the bridge fails the
 * runner's suite rather than waiting for a box with a desktop on it. `/usr/bin/python3` is the
 * interpreter the runner spawns in production, so it is the one measured here.
 */
describe('the accessibility bridge, in the language it is written in', () => {
  const interpreter = '/usr/bin/python3';
  const suite = path.resolve('../../infra/native/garden-desktop-bridge.test.py');

  it.runIf(existsSync(interpreter))('passes its own suite', () => {
    const result = spawnSync(interpreter, [suite], { encoding: 'utf8' });
    // stderr, because unittest reports there; printed whole so a failure here reads like a
    // failure rather than like an exit code.
    expect(`${result.stdout}${result.stderr}`).toContain('OK');
    expect(result.status).toBe(0);
  });
});

describe('what the pixel path may do without stopping the owner', () => {
  /**
   * The mode that exists precisely for applications with no accessibility was close to inert. Every
   * coordinate click was consequential and every keystroke was treated as a secret, so driving such
   * an app meant approving each click and taking over the machine to type. The reason was sound -
   * a bare coordinate is unattributable, so the harness could not write an honest card and could
   * not tell Cancel from Delete - but the answer was to give it something to attribute against.
   */
  const at = (
    x: number,
    y: number,
    width: number,
    height: number,
    over: Partial<DesktopNode> = {}
  ): DesktopNode => ({
    id: `n-${x}-${y}`,
    parentId: null,
    name: 'Save',
    description: '',
    role: 'push button',
    states: ENABLED_BUTTON,
    actions: ['click'],
    interfaces: ['action'],
    bounds: { x, y, width, height },
    sensitive: false,
    ...over
  });

  it('finds the smallest control under a point, because bounds nest', () => {
    const window = at(0, 0, 800, 600, { id: 'window', role: 'frame', name: 'App' });
    const panel = at(10, 10, 400, 300, { id: 'panel', role: 'panel', name: 'Toolbar' });
    const button = at(20, 20, 60, 24, { id: 'button', name: 'Save' });
    expect(nodeUnderPoint([window, panel, button], 40, 30)?.id).toBe('button');
    // A point inside the window but on no control is not attributable to anything smaller.
    expect(nodeUnderPoint([window, panel, button], 700, 500)?.id).toBe('window');
    expect(nodeUnderPoint([panel, button], 700, 500)).toBeUndefined();
  });

  it('judges a click that lands on a control exactly as clicking that control by name', () => {
    const ordinary = classifyDesktopAction(
      { type: 'click_at', x: 40, y: 30, button: 'left', clicks: 1 },
      at(20, 20, 60, 24, { name: 'Save' })
    );
    expect(ordinary.consequential).toBe(false);
    expect(ordinary.preview).toContain('Save');

    // The calibration the semantic path already had, now reaching the pixel path too.
    const grave = classifyDesktopAction(
      { type: 'click_at', x: 40, y: 30, button: 'left', clicks: 1 },
      at(20, 20, 60, 24, { name: 'Delete all messages' })
    );
    expect(grave.consequential).toBe(true);
  });

  it('still stops for a click on nothing this computer can name', () => {
    const blind = classifyDesktopAction({
      type: 'click_at',
      x: 700,
      y: 500,
      button: 'left',
      clicks: 1
    });
    expect(blind.consequential).toBe(true);
    expect(blind.preview).toContain('not on any control');
  });

  it('types into an ordinary field, and hands over only for a secret one', () => {
    const search = classifyDesktopAction(
      { type: 'text_input', text: 'invoices' },
      at(0, 0, 200, 24, { name: 'Search', role: 'text' })
    );
    expect(search.sensitiveInput).toBe(false);

    const password = classifyDesktopAction(
      { type: 'text_input', text: 'hunter2' },
      at(0, 0, 200, 24, { name: 'Password', role: 'password text', sensitive: true })
    );
    expect(password.sensitiveInput).toBe(true);

    // Nothing focused keeps the old answer, which is the case the rule was really protecting.
    expect(classifyDesktopAction({ type: 'text_input', text: 'x' }).sensitiveInput).toBe(true);
  });

  /**
   * A handoff card names the field the owner is being asked to type into, and `knownField` decides
   * whether it can. It asked for the state `'read-only'`, which AT-SPI does not have - the name is
   * `ATSPI_STATE_READ_ONLY`, so the bridge emits `read_only` - so the branch was unreachable and a
   * secure-input handoff for a field that refuses input still told the owner to type into it.
   */
  it('does not name a field the owner cannot type into', () => {
    const editable = classifyDesktopAction(
      { type: 'text_input', text: 'hunter2' },
      at(0, 0, 200, 24, { name: 'Password', role: 'password text', states: FOCUSED_ENTRY })
    );
    expect(editable.sensitiveInput).toBe(true);
    expect(editable.preview).toContain('the password text "Password"');

    const readOnly = classifyDesktopAction(
      { type: 'text_input', text: '4242' },
      at(0, 0, 200, 24, {
        name: 'Account number',
        role: 'text',
        states: READ_ONLY_ENTRY,
        sensitive: true
      })
    );
    expect(readOnly.sensitiveInput).toBe(true);
    expect(readOnly.preview).toContain('the focused desktop field');
    expect(readOnly.preview).not.toContain('Account number');
  });

  it('treats looking closely as a read', () => {
    const zoom = classifyDesktopAction({ type: 'zoom', x: 100, y: 100, width: 200, height: 120 });
    expect(zoom.consequential).toBe(false);
    expect(zoom.sensitiveInput).toBe(false);
  });
});

describe('which accessibility nodes an observation carries', () => {
  /**
   * Nine hundred nodes were collected and the window keeps twenty-four thousand characters of a
   * tool result - about seventy-four of them. So nine in ten were cut away by a generic
   * middle-truncation that did not know it was cutting JSON: the model got a fragment ending
   * mid-structure, no signal that anything was missing, and a snapshot still calling itself
   * semantic_and_visual. Dropping whole nodes at this end, worst first, and saying how many went,
   * is the difference between a partial answer and a corrupted one.
   */
  const node = (id: string, over: Partial<DesktopNode> = {}): DesktopNode => ({
    id,
    parentId: null,
    name: `control ${id}`,
    description: 'a control with a reasonably long description so the budget is realistic',
    role: 'push button',
    states: ENABLED_BUTTON,
    actions: ['click'],
    interfaces: ['action', 'component'],
    bounds: { x: 10, y: 10, width: 80, height: 24 },
    sensitive: false,
    ...over
  });

  it('keeps what can be acted on and seen, and counts what it dropped', () => {
    const nodes = [
      // Structural furniture with no name and nothing to do: the cheapest thing to lose.
      ...Array.from({ length: 400 }, (_, index) =>
        node(`filler-${index}`, { name: '', actions: [], bounds: null, role: 'filler' })
      ),
      // The one control that matters, deliberately last in tree order so a head-truncation
      // would have thrown it away.
      node('save', { name: 'Save' })
    ];
    const { kept, omitted } = selectDesktopNodes(nodes);
    expect(kept.some((entry) => entry.id === 'save')).toBe(true);
    expect(omitted).toBeGreaterThan(0);
    expect(kept.length + omitted).toBe(nodes.length);
  });

  it('retains form fields when generic native panels expose ancestor and context-menu actions', () => {
    const nodes = [
      ...Array.from({ length: 300 }, (_, index) =>
        node(`panel-${index}`, {
          name: '',
          role: 'panel',
          actions: ['clickAncestor', 'showContextMenu']
        })
      ),
      node('answer', {
        name: 'Project answer',
        role: 'entry',
        states: FOCUSED_ENTRY,
        actions: ['activate'],
        interfaces: ['component', 'text']
      }),
      node('accept', { name: 'Accept example', actions: ['press'] })
    ];
    const { kept, omitted } = selectDesktopNodes(nodes, 1_500);
    expect(kept.map((item) => item.id)).toContain('answer');
    expect(kept.map((item) => item.id)).toContain('accept');
    expect(omitted).toBeGreaterThan(0);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(1_501);
  });

  it('fits inside the budget a tool result actually has', () => {
    const nodes = Array.from({ length: 900 }, (_, index) => node(`n-${index}`));
    const { kept, omitted } = selectDesktopNodes(nodes);
    expect(JSON.stringify(kept).length).toBeLessThan(24_000);
    expect(omitted).toBe(900 - kept.length);
    // And it is not so cautious that the screen becomes unusable.
    expect(kept.length).toBeGreaterThan(20);
  });

  /**
   * `actionable` ranked a node above named furniture whenever it had an action and did not carry
   * the state `'disabled'`. No AT-SPI node carries `'disabled'`: a control the user cannot operate
   * is one that lacks `sensitive`. So the predicate was constant-true for everything with an
   * action, and the top of the budget filled with greyed-out menu items and toolbar buttons while
   * the labels that say what the screen is were dropped underneath them.
   */
  it('ranks a control the user could actually operate above one that is greyed out', () => {
    const greyed = node('greyed', { name: '', states: GREYED_BUTTON });
    const named = node('named', { name: 'Recipient', actions: [], states: ENABLED_BUTTON });
    // Room for exactly one of them, so the ranking is the whole of what decides which survives.
    const budget = Math.max(JSON.stringify(greyed).length, JSON.stringify(named).length) + 1;
    expect(selectDesktopNodes([greyed, named], budget).kept.map((entry) => entry.id)).toEqual([
      'named'
    ]);
    // And the live one still outranks the label, which is the tier order this is not disturbing.
    const live = node('live', { name: 'Send', states: ENABLED_BUTTON });
    const pair = Math.max(JSON.stringify(named).length, JSON.stringify(live).length) + 1;
    expect(selectDesktopNodes([named, live], pair).kept.map((entry) => entry.id)).toEqual(['live']);
  });

  it('emits in tree order, so parentId still reads', () => {
    const nodes = [node('a'), node('b', { parentId: 'a' }), node('c', { parentId: 'b' })];
    expect(selectDesktopNodes(nodes).kept.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('desktop action policy', () => {
  it('detects consequential semantic controls', () => {
    expect(
      classifyDesktopAction(
        { type: 'invoke', nodeId: '0/1', actionIndex: 0 },
        node({ name: 'Submit job application' })
      )
    ).toMatchObject({ consequential: true, sensitiveInput: false });
  });

  /**
   * The destructive half of the floor GARDEN_BLUEPRINT.md:104, docs/AGENT_RUNTIME.md:416 and
   * docs/CAPABILITIES.md:97 all promise. Until ATH-001 was repaired, `#approvalForCall` turned every
   * verdict here into an approval row, so a benign answer for a control named "Erase" cost nothing
   * and nobody could see that this list only ever knew the transactional verbs. It costs something
   * now, which is why the words are here.
   */
  it('calls a control consequential for every way an application spells destruction', () => {
    for (const name of [
      'Erase',
      'Format Disk',
      'Reset to factory settings',
      'Overwrite existing file',
      'Empty Trash',
      'Revoke access',
      'Deactivate account',
      'Move to Bin',
      'Discard changes'
    ])
      expect(
        classifyDesktopAction({ type: 'invoke', nodeId: '0/1', actionIndex: 0 }, node({ name }))
      ).toMatchObject({ consequential: true });
  });

  /**
   * The other side of the same decision. What "OK" does is a property of the dialog around it, which
   * nothing on this path can read, and stopping for all of them is the ceremony that made the pixel
   * path unusable before ATH-001. The floor's other promise - that an ambiguous coordinate always
   * confirms - is kept unconditionally by the worker instead, which is where it belongs.
   */
  it('does not stop for a confirmation word, whose meaning it cannot see', () => {
    for (const name of ['OK', 'Yes', 'Continue', 'Save', 'Read documentation'])
      expect(
        classifyDesktopAction({ type: 'invoke', nodeId: '0/1', actionIndex: 0 }, node({ name }))
      ).toMatchObject({ consequential: false });
  });

  it('routes password fields to secure user input', () => {
    expect(
      classifyDesktopAction(
        { type: 'set_text', nodeId: '0/2', text: 'never expose this' },
        node({ name: 'Password', role: 'password text', sensitive: true })
      )
    ).toMatchObject({ consequential: false, sensitiveInput: true });
  });

  it('treats pixel clicks and Enter as ambiguous consequential actions', () => {
    expect(
      classifyDesktopAction({ type: 'click_at', x: 10, y: 20, button: 'left', clicks: 1 })
        .consequential
    ).toBe(true);
    expect(classifyDesktopAction({ type: 'press', key: 'Enter' }).consequential).toBe(true);
    expect(classifyDesktopAction({ type: 'press', key: 'Return' }).consequential).toBe(true);
  });
});

describe('desktop key names', () => {
  it('translates DOM key names into X11 keysyms xdotool accepts', () => {
    expect(toX11Keysym('Enter')).toBe('Return');
    expect(toX11Keysym('Esc')).toBe('Escape');
    expect(toX11Keysym('Escape')).toBe('Escape');
    expect(toX11Keysym('ArrowUp')).toBe('Up');
    expect(toX11Keysym('ArrowDown')).toBe('Down');
    expect(toX11Keysym('ArrowLeft')).toBe('Left');
    expect(toX11Keysym('ArrowRight')).toBe('Right');
    expect(toX11Keysym(' ')).toBe('space');
    expect(toX11Keysym('Backspace')).toBe('BackSpace');
    expect(toX11Keysym('Delete')).toBe('Delete');
    expect(toX11Keysym('Tab')).toBe('Tab');
    expect(toX11Keysym('Home')).toBe('Home');
    expect(toX11Keysym('End')).toBe('End');
    expect(toX11Keysym('PageUp')).toBe('Prior');
    expect(toX11Keysym('PageDown')).toBe('Next');
  });

  it('keeps chords and ordinary characters usable', () => {
    expect(toX11Keysym('ctrl+Enter')).toBe('ctrl+Return');
    expect(toX11Keysym('Control+s')).toBe('ctrl+s');
    expect(toX11Keysym('Meta+ArrowLeft')).toBe('super+Left');
    expect(toX11Keysym('a')).toBe('a');
    expect(toX11Keysym('F5')).toBe('F5');
    expect(toX11Keysym('+')).toBe('plus');
  });

  it('covers the function, numpad, media and modifier keys the old map dropped', () => {
    expect(toX11Keysym('F13')).toBe('F13');
    expect(toX11Keysym('Numpad5')).toBe('KP_5');
    expect(toX11Keysym('NumpadAdd')).toBe('KP_Add');
    expect(toX11Keysym('NumpadEnter')).toBe('KP_Enter');
    expect(toX11Keysym('AudioVolumeUp')).toBe('XF86AudioRaiseVolume');
    expect(toX11Keysym('MediaPlayPause')).toBe('XF86AudioPlay');
    expect(toX11Keysym('AltGraph')).toBe('ISO_Level3_Shift');
    expect(toX11Keysym('ContextMenu')).toBe('Menu');
    expect(toX11Keysym('PrintScreen')).toBe('Print');
    expect(toX11Keysym('CapsLock')).toBe('Caps_Lock');
    expect(toX11Keysym('-')).toBe('minus');
    expect(toX11Keysym('/')).toBe('slash');
    expect(toX11Keysym('ctrl+AltGraph+F12')).toBe('ctrl+ISO_Level3_Shift+F12');
  });

  it('routes characters no layout can produce through the unicode keysym range', () => {
    expect(toX11Keysym('é')).toBe('U00E9');
    expect(toX11Keysym('漢')).toBe('U6F22');
    expect(toX11Keysym('€')).toBe('U20AC');
    // Astral-plane characters are one code point, not two UTF-16 units.
    expect(toX11Keysym('😀')).toBe('U1F600');
  });
});

describe('desktop input commands', () => {
  it('moves the pointer before clicking and only paces repeated clicks', () => {
    expect(clickCommand({ x: 12.4, y: 40.6 }, 'right', 1)).toEqual([
      'mousemove',
      '--sync',
      '12',
      '41',
      'click',
      '3'
    ]);
    expect(clickCommand({ x: 0, y: 0 }, 'left', 2)).toEqual([
      'mousemove',
      '--sync',
      '0',
      '0',
      'click',
      '--repeat',
      '2',
      '--delay',
      '100',
      '1'
    ]);
  });

  it('sends physical wheel buttons without changing the pointer or delaying each tick', () => {
    expect(scrollCommand('down', 3)).toEqual(['click', '--repeat', '3', '--delay', '0', '5']);
    expect(scrollCommand('left', 1)).toContain('6');
    expect(scrollCommand('right', 1)).toContain('7');
    expect(scrollCommand('up', 1)).toContain('4');
    // A trackpad fling must not wedge the queue behind hundreds of synthetic clicks.
    expect(scrollCommand('down', 100)).toContain('12');
  });

  it('drags with interpolated motion that clears the toolkit drag threshold', () => {
    const args = dragCommand({ x: 0, y: 0 }, { x: 400, y: 0 }, 960);
    // 'xdotool mousemove' has no --steps option; passing one made every drag fail.
    expect(args).not.toContain('--steps');
    const down = args.indexOf('mousedown');
    expect(down).toBeGreaterThan(0);
    const firstMove = args.indexOf('mousemove', down);
    expect(Number(args[firstMove + 2])).toBeGreaterThanOrEqual(8);
    expect(args.filter((value) => value === 'mousemove').length).toBeGreaterThan(3);
    expect(args.slice(-2)).toEqual(['mouseup', '1']);
    expect(args[args.length - 3]).toBe('0.05');
    const lastMove = args.lastIndexOf('mousemove');
    expect(args.slice(lastMove, lastMove + 4)).toEqual(['mousemove', '--sync', '400', '0']);
  });

  it('releases every latched modifier and button on a handover', () => {
    const args = releaseAllInputCommand();
    expect(args.join(' ')).toContain('keyup Control_L');
    expect(args.join(' ')).toContain('keyup Shift_R');
    expect(args.join(' ')).toContain('keyup ISO_Level3_Shift');
    expect(args.join(' ')).toContain('mouseup 1');
    expect(args.join(' ')).toContain('mouseup 3');
  });

  it('types at the keymap settle time and never clears modifiers behind the caller', () => {
    expect(typeCommand('héllo')).toEqual(['type', '--delay', '12', '--', 'héllo']);
    expect(pressCommand('ctrl+Enter')).toEqual(['key', 'ctrl+Return']);
    expect(typeCommand('x')).not.toContain('--clearmodifiers');
    expect(pressCommand('a')).not.toContain('--clearmodifiers');
  });

  it('converts screenshot coordinates into display pixels', () => {
    expect(
      imageToDisplayPoint(
        { x: 720, y: 450 },
        { width: 1440, height: 900 },
        { width: 2560, height: 1600 }
      )
    ).toEqual({ x: 1280, y: 800 });
    expect(
      imageToDisplayPoint(
        { x: 0, y: 0 },
        { width: 1440, height: 900 },
        { width: 1440, height: 900 }
      )
    ).toEqual({ x: 0, y: 0 });
    // Never let a rounded edge coordinate land outside the display.
    expect(
      imageToDisplayPoint(
        { x: 1440, y: 900 },
        { width: 1440, height: 900 },
        { width: 1280, height: 800 }
      )
    ).toEqual({ x: 1279, y: 799 });
  });
});

describe('desktop accessibility bridge framing', () => {
  it('reassembles newline delimited responses split across pipe reads', () => {
    const first = splitBridgeLines('', '{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.rest).toBe('{"b":');
    const second = splitBridgeLines(first.rest, '2}\n\n{"c":3}\n');
    expect(second.lines).toEqual(['{"b":2}', '{"c":3}']);
    expect(second.rest).toBe('');
    expect(splitBridgeLines('', 'partial').lines).toEqual([]);
  });
});

describe('desktop session lifecycle', () => {
  const withSession = async (
    body: (manager: DesktopManager, root: string) => Promise<void>
  ): Promise<void> => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-desktop-'));
    const script = path.join(root, 'session.sh');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        'set -eu',
        'mkdir -p "$1/.garden/desktop"',
        'printf "DISPLAY=:99\\nXAUTHORITY=/nonexistent/authority\\nDBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null\\n' +
          'XDG_RUNTIME_DIR=%s\\nGARDEN_BOOT_RES=1600x1000\\nGARDEN_MAX_RES=3840x2160\\n"' +
          ' "$1" > "$1/.garden/desktop/environment"',
        'exec sleep 30'
      ].join('\n'),
      { mode: 0o755 }
    );
    const manager = new DesktopManager('/nonexistent/bridge.py', script, [
      '/usr/local/lib/garden/garden-package-helper'
    ]);
    try {
      await body(manager, root);
    } finally {
      await manager.close('workspace');
      await rm(root, { recursive: true, force: true });
    }
  };

  it('takes its geometry from the session and reports the agent image space', async () => {
    await withSession(async (manager, root) => {
      // No X11 on the test host: every X tool fails and the snapshot degrades, which is
      // exactly the path that must still produce a coherent coordinate space.
      const snapshot = await manager.snapshot('workspace', root, 'agent');
      expect(snapshot).toMatchObject({
        available: true,
        mode: 'visual_fallback',
        holder: 'agent',
        generation: 1,
        displayWidth: 1600,
        displayHeight: 1000,
        width: 1440,
        height: 900,
        screenshotMimeType: 'image/jpeg'
      });
      expect(snapshot.scale).toBeCloseTo(0.9, 6);
    });
  }, 20_000);

  it('hands control over and refuses the previous holder afterwards', async () => {
    await withSession(async (manager, root) => {
      const before = await manager.snapshot('workspace', root, 'agent');
      const handover = await manager.setHolder('workspace', root, 'user');
      expect(handover).toEqual({ holder: 'user', generation: before.generation + 1 });
      await expect(
        manager.act('workspace', root, { type: 'press', key: 'Enter' }, 'agent', true)
      ).rejects.toThrow('Desktop control is held by user');
      await expect(manager.snapshot('workspace', root, 'agent')).rejects.toThrow(
        'held by the user'
      );
    });
  }, 20_000);

  it('applies the same command policy a shell command gets, which it used to skip entirely', async () => {
    // desktop_launch spawned whatever it was handed. Everything the shell refuses ran unchecked
    // simply by asking for a window instead of a pipe.
    await withSession(async (manager, root) => {
      const refused = [
        { executable: '/usr/bin/sudo', args: ['id'] },
        { executable: 'pkexec', args: ['id'] },
        { executable: '/usr/bin/apt-get', args: ['install', '-y', 'openssh-server'] },
        { executable: '/usr/local/lib/garden/garden-package-helper', args: ['install', 'nmap'] }
      ];
      for (const request of refused)
        await expect(
          manager.launch('workspace', root, { ...request, cwd: 'workspace', env: {} })
        ).rejects.toThrow('cannot be started as desktop programs');
    });
  }, 20_000);

  /*
   * A PROGRAM THAT IS NOT THERE MUST NOT TAKE THE RUNNER WITH IT.
   *
   * Measured on the box. A turn asked the desktop for `gedit`, which is not installed, and the
   * workspace runner died - not the call, the whole service - on Node's own
   * `throw er; // Unhandled 'error' event` under `Error: spawn gedit ENOENT`. `Restart=always`
   * brought it back, the turn asked again, and every other task on the machine lost its runner
   * three times over for a missing text editor. `NRestarts=5`.
   *
   * `ChildProcess` is an EventEmitter and an EventEmitter with no `error` listener rethrows the
   * event as an uncaught exception. Every other spawn in this service is followed synchronously by
   * `awaitChildExit`, whose `once(child, 'exit')` attaches one; this path launches a detached
   * window and never awaits it, which is exactly why it was the one without.
   *
   * This test would not have failed before the fix - it would have KILLED THE TEST PROCESS, which
   * is the same thing happening to the runner and is the point.
   */
  it('reports a program that is not installed instead of dying with it', async () => {
    await withSession(async (manager, root) => {
      await expect(
        manager.launch('workspace', root, {
          executable: '/usr/bin/garden-no-such-desktop-program',
          args: [],
          cwd: 'workspace',
          env: {}
        })
      ).rejects.toThrow('is not installed on this computer');
      // Still serving afterwards, which is the half that matters: the runner survived.
      expect((await manager.snapshot('workspace', root, 'agent')).available).toBe(true);
    });
  }, 20_000);

  /*
   * And says what IS here, because the turn that found this tried three editors and concluded the
   * screen was broken. The capability table provisions the desktop's plumbing - X11, xdotool,
   * wmctrl, xrandr - and no programs to run in it, except the browser garden installs itself.
   */
  it('names the browser it manages when the program asked for is absent', async () => {
    /*
     * Asserted in both directions, because whether a managed browser is on THIS host is an
     * environment fact and not the contract. The contract is: when there is one, the refusal names
     * it; when there is not, the refusal does not promise one. A test that only checked the first
     * would pass on the box and fail on a laptop with no browsers installed.
     */
    const managed = await chromiumDriver()
      .then((driver) => driver.executablePath())
      .catch(() => undefined);
    const here = managed !== undefined && managed !== '' && existsSync(managed);
    await withSession(async (manager, root) => {
      const refusal = await manager
        .launch('workspace', root, {
          executable: '/usr/bin/garden-no-such-desktop-program',
          args: [],
          cwd: 'workspace',
          env: {}
        })
        .then(
          () => new Error('the launch was expected to be refused'),
          (cause: Error) => cause
        );
      expect(refusal.message).toContain('is not installed on this computer');
      if (here) expect(refusal.message).toContain(managed);
      else expect(refusal.message).not.toContain('opens on the desktop');
    });
  }, 20_000);
});

/**
 * What the stream socket hands the desktop, which for three separate capabilities was nothing.
 *
 * Every defect this covers is the same shape: the runner grew a mechanism, the one route that
 * could reach it did not pass the argument, and nothing failed - the pane simply froze, stayed at
 * 1280x800, or showed a blank rectangle. So these cases drive the real route over a real socket
 * with the desktop itself replaced, because the argument list is the thing under test.
 */
describe('the desktop stream socket', () => {
  const disposers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  class RecordingDesktop extends DesktopManager {
    subscriber: DesktopSubscriber | undefined;
    readonly resized: DisplayViewport[] = [];
    readonly refreshed: string[] = [];

    constructor() {
      super('/nonexistent/bridge.py', '/nonexistent/session.sh');
    }

    override async subscribeStream(
      _workspaceId: string,
      _root: string,
      subscriber: DesktopSubscriber
    ): Promise<() => Promise<void>> {
      this.subscriber = subscriber;
      return async () => undefined;
    }

    override async resize(_workspaceId: string, _root: string, viewport: DisplayViewport) {
      this.resized.push(viewport);
      return { width: viewport.cssWidth, height: viewport.cssHeight, generation: 2, applied: true };
    }

    override async refreshStream(workspaceId: string): Promise<void> {
      this.refreshed.push(workspaceId);
    }
  }

  const WORKSPACE = '00000000-0000-4000-8000-0000000000d1';
  const SECRET = 'runner-desktop-stream-secret-at-least-32-chars';

  const openStream = async (): Promise<{ socket: WebSocket; desktop: RecordingDesktop }> => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-desktop-stream-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const desktop = new RecordingDesktop();
    const app = await buildServer(runnerConfig(workspaceRoot, SECRET), {
      desktop,
      // The disk this suite reads is stated, not measured: see `checkpoints.test.ts`.
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: WORKSPACE,
        role: 'user',
        scopes: ['desktop.read', 'desktop.control', 'desktop.takeover'],
        nonce: 'desktop-stream-test',
        // One audience covers the whole socket: the holder, action and viewport frames are all
        // authorized against the upgrade request that opened it, not against routes of their own.
        aud: capabilityAudience('GET', `/v1/workspaces/${WORKSPACE}/desktop/stream`)
      },
      SECRET,
      120
    );
    const socket = new WebSocket(
      `${address.replace('http://', 'ws://')}/v1/workspaces/${WORKSPACE}/desktop/stream`,
      ['garden-capability', token]
    );
    disposers.push(async () => socket.close());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    // The subscription is established off the upgrade, one microtask turn behind the handshake.
    for (let attempt = 0; attempt < 200 && !desktop.subscriber; attempt += 1) await delay(10);
    return { socket, desktop };
  };

  /** Sends one control message and resolves with the ack or the error the route answers with. */
  const send = async (socket: WebSocket, message: unknown): Promise<Record<string, unknown>> => {
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (raw: Buffer, binary: boolean) => {
        if (binary) return;
        socket.off('message', onMessage);
        resolve(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
      };
      socket.on('message', onMessage);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ requestId: 'r1', ...(message as object) }));
    return reply;
  };

  /**
   * The frozen pane. `server.ts` built the subscriber with `{state, frame}` and kept a rule of its
   * own - drop the frame above 2 MiB buffered, tell nobody - so `bufferedBytes`, `session.congested`,
   * the bounded queue's `starved` flag and `requestKeyframe()` were all unreachable. The encoder
   * runs an infinite GOP by design, so a dropped delta stranded the client's `VideoDecoder` and no
   * keyframe ever followed: a still photograph of the agent's screen, a healthy socket, no error,
   * no spinner, for the rest of the session.
   */
  it('hands the desktop the socket depth instead of dropping frames behind its back', async () => {
    const { desktop } = await openStream();
    expect(typeof desktop.subscriber?.bufferedBytes).toBe('function');
    expect(desktop.subscriber?.bufferedBytes?.()).toBe(0);
  }, 20_000);

  it('resizes the display to the viewport the pane reports', async () => {
    const { socket, desktop } = await openStream();
    // Shaped like the `holder` and `action` messages beside it: a type, and the payload under a
    // key of its own name.
    const ack = await send(socket, {
      type: 'viewport',
      viewport: { cssWidth: 1600, cssHeight: 900, devicePixelRatio: 2, mode: 'native' }
    });
    expect(ack).toMatchObject({ type: 'control_ack', requestId: 'r1' });
    expect(desktop.resized).toEqual([
      { cssWidth: 1600, cssHeight: 900, devicePixelRatio: 2, mode: 'native' }
    ]);
  }, 20_000);

  it('carries a hello through to the encoder, so a client without a decoder can be served', async () => {
    const { socket, desktop } = await openStream();
    expect(desktop.subscriber?.canDecodeVideo?.()).toBe(true);
    const ack = await send(socket, { type: 'hello', canDecodeVideo: false });
    expect(ack).toMatchObject({ type: 'control_ack' });
    expect(desktop.subscriber?.canDecodeVideo?.()).toBe(false);
    expect(desktop.refreshed).toEqual([WORKSPACE]);
  }, 20_000);

  it('still refuses a message it does not know, rather than acking it', async () => {
    const { socket } = await openStream();
    const answer = await send(socket, { type: 'teleport' });
    expect(answer).toMatchObject({ type: 'control_error', requestId: 'r1' });
  }, 20_000);
});
