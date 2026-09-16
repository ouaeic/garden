import { signatureControl } from './human-input.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { captureSpawnFailure, spawnFailureMessage } from './spawn-guard.js';
import { chromiumDriver } from './playwright.js';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  OwnerStroke,
  DesktopAction,
  DesktopHolder,
  DesktopLaunchRequest
} from '@athanor/contracts';
import {
  DISPLAY_PROTOCOL,
  DisplayEncoder,
  DisplayFrameQueue,
  HOLDER_BORDER_COLORS,
  agentImageGeometry,
  avcCodecString,
  cvtReducedBlankingMode,
  encodeJpegFrame,
  encodeVideoAccessUnit,
  encodeVideoConfig,
  newModeArguments,
  parseRandrState,
  prepareStillCapture,
  resolveTargetGeometry,
  shouldApplyGeometry,
  stillCaptureArguments,
  type DisplayCodec,
  type DisplayEncoderConfig,
  type DisplayGeometry,
  type DisplayStreamFrame,
  type DisplayViewport
} from './desktop-stream.js';
import {
  packageManagerInvocation,
  privilegeEscalationBinary,
  privilegedHelperInvocation,
  resolveExecutable
} from './command-policy.js';
import { hostSearchPath } from './execution.js';
import { resolveCommandDirectory } from './files.js';
import { DesktopControl } from './holder.js';
import { failureCode, runnerLogger } from './log.js';
import { awaitChildExit } from './subprocess.js';

export interface DesktopNode {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  role: string;
  states: string[];
  actions: string[];
  interfaces: string[];
  bounds: { x: number; y: number; width: number; height: number } | null;
  text?: string;
  sensitive: boolean;
}

export interface DesktopSnapshot {
  available: boolean;
  mode: 'semantic_and_visual' | 'visual_fallback' | 'unavailable';
  holder: DesktopHolder;
  /**
   * Bumped by every resize, every control handover and every change of stream transport. Stamped
   * on frames and stills, and recorded on the session when this snapshot is served to the agent,
   * so a coordinate action computed from an observation older than the last of those is refused
   * instead of landing somewhere unintended. `act` is where that refusal is taken.
   */
  generation: number;
  /** Screenshot pixels. Agent coordinates are always in this space. */
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  /** displayWidth * scale === width; the runner converts, the model never does arithmetic. */
  scale: number;
  screenshotMimeType: 'image/jpeg';
  activeApplication: string;
  windows: Array<{ id: string; name: string; role: string }>;
  nodes: DesktopNode[];
  /**
   * Accessibility nodes the screen had that this observation does not carry.
   *
   * Nine hundred were collected and the window keeps twenty-four thousand characters of a tool
   * result, which is about seventy-four of them - so nine in ten were being cut away by a generic
   * middle-truncation that did not know it was cutting JSON, leaving the model a mangled fragment
   * and no idea anything was missing while the snapshot still called itself semantic_and_visual.
   *
   * The selection below is deliberate instead, and this number is what makes it honest: a model
   * that knows the tree is partial can scope its next observation to a window, where one that
   * believes it saw everything concludes the control it wants does not exist.
   */
  nodesOmitted: number;
  screenshotBase64: string;
  message?: string;
}

/**
 * The AT-SPI state names this file matches on, in the spelling `athanor-desktop-bridge.py` emits.
 *
 * Written down because both of them had been wrong, in the same way, for the life of the file: the
 * selection ranked on `'disabled'` and the classifier looked for `'read-only'`, and AT-SPI has
 * neither string. The vocabulary is `ATSPI_STATE_*` with the prefix removed and lowercased, so
 * `ATSPI_STATE_SENSITIVE` is `sensitive` and `ATSPI_STATE_READ_ONLY` is `read_only` - one word,
 * underscore, no hyphen. `state_name` in the bridge is the function that produces them and
 * `athanor-desktop-bridge.test.py` is what pins it; a name invented here rather than read from
 * there is a predicate that silently never fires, which is exactly what happened twice.
 */
export const DESKTOP_STATE = {
  /** The toolkit's word for "not greyed out" - a control the user can operate. */
  sensitive: 'sensitive',
  /** A field that displays a value and refuses to take one. */
  readOnly: 'read_only',
  focused: 'focused'
} as const;

/**
 * How many characters of accessibility nodes one observation may carry.
 *
 * The window bounds a tool result at twenty-four thousand characters, and the rest of the snapshot
 * - windows, geometry, the active application - needs room beside them. Choosing which nodes to
 * drop is the whole point: dropped at this end they leave whole, and the model is told how many
 * went; dropped at the far end they leave a fragment cut mid-structure.
 */
const NODE_BUDGET_CHARS = 18_000;

/**
 * Which nodes survive when they cannot all fit.
 *
 * In three tiers, tree order preserved inside each so the structure still reads: a node the agent
 * could act on and can see; then anything else it could act on; then the named furniture that gives
 * those controls their context. Unnamed structural nodes go first - a `filler` with no name and no
 * actions is the cheapest thing on the screen to lose.
 */
export const selectDesktopNodes = (
  nodes: readonly DesktopNode[],
  budget = NODE_BUDGET_CHARS
): { kept: DesktopNode[]; omitted: number } => {
  const onScreen = (node: DesktopNode): boolean =>
    node.bounds !== null && node.bounds.width > 0 && node.bounds.height > 0;
  /**
   * A control the user could actually operate: it has an accessibility action, and AT-SPI says it
   * is sensitive - which is the toolkit's own word for "not greyed out".
   *
   * This used to read `!node.states.includes('disabled')`, and no AT-SPI node has ever carried
   * `'disabled'`; the vocabulary has `sensitive` and its absence. So the test was constant-true for
   * anything with an action, the top tier filled with greyed-out menu items and toolbar buttons,
   * and the named labels that say what the screen is were dropped underneath them - out of a
   * budget that only holds about seventy nodes.
   */
  const actionable = (node: DesktopNode): boolean =>
    node.actions.length > 0 && node.states.includes(DESKTOP_STATE.sensitive);
  const tier = (node: DesktopNode): number => {
    if (actionable(node) && onScreen(node)) return 0;
    if (actionable(node)) return 1;
    if (node.name.trim() || node.text?.trim()) return 2;
    return 3;
  };
  const ranked = nodes
    .map((node, index) => ({ node, index, tier: tier(node) }))
    .sort((left, right) => left.tier - right.tier || left.index - right.index);

  const keptIndexes = new Set<number>();
  let spent = 0;
  for (const entry of ranked) {
    const cost = JSON.stringify(entry.node).length + 1;
    if (spent + cost > budget) continue;
    spent += cost;
    keptIndexes.add(entry.index);
  }
  // Emitted back in the order the tree walk found them, because a parent before its child is what
  // makes `parentId` readable at all.
  return {
    kept: nodes.filter((_, index) => keptIndexes.has(index)),
    omitted: nodes.length - keptIndexes.size
  };
};

export interface DesktopActionPreflight {
  handoffKind?: 'signature';
  tabId?: string;
  consequential: boolean;
  sensitiveInput: boolean;
  preview: string;
}

export interface DesktopStreamState {
  holder: DesktopHolder;
  /** ISO timestamp of the last handover, so the client can render "Agent has control · 0:14". */
  holderSince: string;
  generation: number;
  width: number;
  height: number;
  transport: 'h264-annexb-v1' | 'jpeg-frame-v1';
  /** Ready for `VideoDecoder.configure({ codec })`, or `image/jpeg` on the fallback path. */
  codec: string;
  protocol: typeof DISPLAY_PROTOCOL;
  activeApplication: string;
  lastAction: string;
}

export interface DesktopSubscriber {
  state: (state: DesktopStreamState) => void;
  /** Receives ready-framed `athanor.display.v1` binary messages; forward them verbatim. */
  frame: (frame: Buffer, state: DesktopStreamState) => void;
  /**
   * Send-buffer depth of the client transport. The WebSocket route should pass
   * `() => socket.bufferedAmount`; without it the runner cannot see congestion and falls
   * back to the bounded queue alone.
   */
  bufferedBytes?: () => number;
  /**
   * Whether this client has a `VideoDecoder` for the H.264 stream, read live because the answer
   * arrives in the client's `hello` a moment after it subscribes.
   *
   * Read as a callback rather than a value for the same reason `bufferedBytes` is: the route owns
   * the fact and the encoder needs it whenever it next reconsiders, not once at join. A client
   * that says no drags the whole session down to JPEG, which is the honest consequence of one
   * encoder per desktop - and far better than the alternative it replaces, which was a viewer
   * with no `VideoDecoder` receiving access units it could not decode and showing nothing at all.
   */
  canDecodeVideo?: () => boolean;
  /** Viewport of the pane that is subscribing, so the display resizes to fit it on join. */
  viewport?: DisplayViewport;
}

interface DesktopSession {
  root: string;
  process: ChildProcess;
  env: NodeJS.ProcessEnv;
  control: DesktopControl;
  subscribers: Map<DesktopSubscriber, DisplayFrameQueue>;
  applicationGroups: Set<number>;
  activeApplication: string;
  lastAction: string;
  geometry: DisplayGeometry;
  bootGeometry: DisplayGeometry;
  ceiling: DisplayGeometry;
  outputName: string;
  currentMode: string | null;
  codec: DisplayCodec;
  encoder: DisplayEncoder;
  congested: boolean;
  /**
   * Whether this session's accessibility stack answered its readiness probe.
   *
   * The bridge's `ping` has always reported it and nothing has ever read it, so a session whose
   * toolkit never joined the accessibility bus was discovered one failed `observe` at a time -
   * each of them a python round trip that could only fail, and each reported to the model as
   * "accessibility bridge failed", which reads like a crash rather than like a desktop that has
   * no semantic layer to offer.
   */
  atspi: boolean;
  /**
   * The display generation of the last observation this session served the agent, or null when it
   * has not observed here at all.
   *
   * Null is let through rather than refused. The refusal names an observation that has been
   * superseded, and an agent that has taken none has nothing to supersede; a coordinate it
   * produced from somewhere else is met by the approval gate instead, which treats a click landing
   * on no control this computer can name as consequential. What this does not cover: a runner
   * restart mints a new session at generation 1 with this back to null, so coordinates read off a
   * screenshot from before the restart are not refused - the screen behind them is a freshly
   * booted display, and the blind-click gate is what stands there.
   */
  observedGeneration: number | null;
  bridge?: BridgeChannel;
  bridgeServe: boolean;
  bridgeQueue: Promise<unknown>;
  pointer: { x: number; y: number };
  poll?: NodeJS.Timeout;
  restore?: NodeJS.Timeout;
}

interface BridgeResult {
  activeApplication?: string;
  nodes?: DesktopNode[];
  windows?: Array<{ id: string; name: string; role: string }>;
  result?: unknown;
}

interface BridgeChannel {
  child: ChildProcess;
  buffer: string;
  pending: {
    resolve: (value: BridgeResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null;
}

/** Raised only when the connection itself is unusable, which is the one condition that
 *  justifies falling back to a process per request. */
class BridgeChannelError extends Error {}

/** Newline-delimited framing for the bridge's stdout; a chunk can hold part of a line, many
 *  lines, or both. */
export const splitBridgeLines = (
  buffered: string,
  chunk: string
): { lines: string[]; rest: string } => {
  const combined = `${buffered}${chunk}`;
  const parts = combined.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => line.trim()).filter(Boolean), rest };
};

/** Xvfb boots at the ceiling and RandR only ever shrinks from there - it cannot grow past
 *  the `-screen` geometry, so the ceiling has to be generous and the boot size small. */
const DEFAULT_BOOT_GEOMETRY: DisplayGeometry = { width: 1280, height: 800 };
const DEFAULT_CEILING: DisplayGeometry = { width: 3840, height: 2160 };
const MAXIMUM_GEOMETRY: DisplayGeometry = { width: 2560, height: 1600 };
const MINIMUM_GEOMETRY: DisplayGeometry = { width: 640, height: 400 };
/**
 * The action contract bounds pixel coordinates at 1440x900, so the agent's still is bounded
 * to the same box. That keeps one unambiguous rule - agent coordinates are screenshot pixels -
 * and keeps the still inside a vision model's useful resolution.
 */
const AGENT_IMAGE_LIMIT: DisplayGeometry = { width: 1440, height: 900 };
const STREAM_FRAMERATE = 30;
const STREAM_CRF = 26;
const STREAM_MAX_KBPS = 6_000;
const STREAM_JPEG_QUALITY = 6;
const STILL_JPEG_QUALITY = 3;
const BACKPRESSURE_QUEUE_SIZE = 3;
const HIGH_WATER_BYTES = 2 * 1024 * 1024;
const LOW_WATER_BYTES = 512 * 1024;
const ENCODER_POLL_MS = 250;
/** Human disconnects, display returns to the boot size, so the next agent run is deterministic. */
const RESTORE_GRACE_MS = 60_000;
const DRAG_THRESHOLD_PX = 12;

/**
 * The vocabulary `browser.ts` owns, applied to an accessibility node's name rather than to an
 * element's. Kept byte-identical on purpose and compared by scripts/check-repository.mjs: the two
 * had already drifted - this file carried `install|uninstall` and the browser did not - and that is
 * exactly how one surface stops keeping a documented floor while the other still keeps it. The
 * argument for which words belong here, and for the confirmation words that deliberately do not,
 * is written once beside the owner.
 */
const consequentialText =
  /\b(submit|apply|purchase|buy|pay|send|publish|delete|remove|confirm|place order|sign|accept offer|post|save changes|install|uninstall|erase|wipe|destroy|discard|overwrite|revoke|deactivate|terminate|format|reset|empty trash|empty bin|move to trash|move to bin|accept\w*\s+[a-z ]{0,16}terms|agree\w*\s+[a-z ]{0,16}terms|accept\w*\s+[a-z ]{0,16}licen[cs]e|agree\w*\s+[a-z ]{0,16}licen[cs]e|accept\w*\s+[a-z ]{0,16}eula|agree\w*\s+[a-z ]{0,16}eula)\b/i;
const sensitiveText =
  /\b(password|passcode|one.?time|otp|verification code|credit.?card|cvv|cvc|social security|ssn|passport|bank account|secret|token)\b/i;

const run = async (
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ stdout: Buffer; stderr: string }> => {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    ...(options.signal ? { signal: options.signal } : {})
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  const limit = 25 * 1024 * 1024;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= limit) stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= limit) stderr.push(chunk);
  });
  child.stdin.end(options.stdin);
  const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20_000);
  timeout.unref();
  let code: number | null;
  try {
    ({ exitCode: code } = await awaitChildExit(child));
  } finally {
    clearTimeout(timeout);
  }
  const error = Buffer.concat(stderr).toString('utf8').trim();
  if (code !== 0) throw new Error(error || `${path.basename(executable)} exited with ${code}`);
  return { stdout: Buffer.concat(stdout), stderr: error };
};

// Callers speak DOM key names, xdotool speaks X11 keysyms, and the two disagree on every
// key that matters: 'Enter', 'Escape', 'ArrowUp' and friends are silently rejected.
const X11_KEYSYMS = new Map<string, string>([
  ['enter', 'Return'],
  ['return', 'Return'],
  ['numpadenter', 'KP_Enter'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['arrowup', 'Up'],
  ['arrowdown', 'Down'],
  ['arrowleft', 'Left'],
  ['arrowright', 'Right'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
  [' ', 'space'],
  ['space', 'space'],
  ['spacebar', 'space'],
  ['backspace', 'BackSpace'],
  ['del', 'Delete'],
  ['delete', 'Delete'],
  ['tab', 'Tab'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'Prior'],
  ['prior', 'Prior'],
  ['pagedown', 'Next'],
  ['next', 'Next'],
  ['insert', 'Insert'],
  ['clear', 'Clear'],
  ['capslock', 'Caps_Lock'],
  ['numlock', 'Num_Lock'],
  ['scrolllock', 'Scroll_Lock'],
  ['pause', 'Pause'],
  ['printscreen', 'Print'],
  ['print', 'Print'],
  ['contextmenu', 'Menu'],
  ['menu', 'Menu'],
  ['help', 'Help'],
  ['control', 'ctrl'],
  ['ctrl', 'ctrl'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['altgraph', 'ISO_Level3_Shift'],
  ['altgr', 'ISO_Level3_Shift'],
  ['shift', 'shift'],
  ['meta', 'super'],
  ['cmd', 'super'],
  ['command', 'super'],
  ['os', 'super'],
  ['super', 'super'],
  // The numeric keypad is a distinct set of keysyms; sending 'plus' where an application
  // listens for KP_Add is a silent no-op in spreadsheets and calculators.
  ['numpad0', 'KP_0'],
  ['numpad1', 'KP_1'],
  ['numpad2', 'KP_2'],
  ['numpad3', 'KP_3'],
  ['numpad4', 'KP_4'],
  ['numpad5', 'KP_5'],
  ['numpad6', 'KP_6'],
  ['numpad7', 'KP_7'],
  ['numpad8', 'KP_8'],
  ['numpad9', 'KP_9'],
  ['numpadadd', 'KP_Add'],
  ['numpadsubtract', 'KP_Subtract'],
  ['numpadmultiply', 'KP_Multiply'],
  ['numpaddivide', 'KP_Divide'],
  ['numpaddecimal', 'KP_Decimal'],
  ['numpadequal', 'KP_Equal'],
  ['audiovolumeup', 'XF86AudioRaiseVolume'],
  ['audiovolumedown', 'XF86AudioLowerVolume'],
  ['audiovolumemute', 'XF86AudioMute'],
  ['mediaplaypause', 'XF86AudioPlay'],
  ['mediastop', 'XF86AudioStop'],
  ['mediatracknext', 'XF86AudioNext'],
  ['mediatrackprevious', 'XF86AudioPrev'],
  ['browserback', 'XF86Back'],
  ['browserforward', 'XF86Forward'],
  ['browserrefresh', 'XF86Refresh'],
  ['browserhome', 'XF86HomePage'],
  ['browsersearch', 'XF86Search'],
  ['!', 'exclam'],
  ['"', 'quotedbl'],
  ['#', 'numbersign'],
  ['$', 'dollar'],
  ['%', 'percent'],
  ['&', 'ampersand'],
  ["'", 'apostrophe'],
  ['(', 'parenleft'],
  [')', 'parenright'],
  ['*', 'asterisk'],
  ['+', 'plus'],
  [',', 'comma'],
  ['-', 'minus'],
  ['.', 'period'],
  ['/', 'slash'],
  [':', 'colon'],
  [';', 'semicolon'],
  ['<', 'less'],
  ['=', 'equal'],
  ['>', 'greater'],
  ['?', 'question'],
  ['@', 'at'],
  ['[', 'bracketleft'],
  ['\\', 'backslash'],
  [']', 'bracketright'],
  ['^', 'asciicircum'],
  ['_', 'underscore'],
  ['`', 'grave'],
  ['{', 'braceleft'],
  ['|', 'bar'],
  ['}', 'braceright'],
  ['~', 'asciitilde']
]);

const keysym = (key: string): string => {
  const mapped = X11_KEYSYMS.get(key.toLowerCase());
  if (mapped) return mapped;
  const points = [...key];
  const point = points.length === 1 ? (points[0]?.codePointAt(0) ?? 0) : 0;
  // XStringToKeysym understands 'U<hex>', which is how a character reaches an X server whose
  // layout cannot produce it. Without this, every non-Latin key is dropped.
  if (point > 0x7f) return `U${point.toString(16).toUpperCase().padStart(4, '0')}`;
  return key;
};

/** Translates a DOM key name, or a `ctrl+Enter` style chord, into xdotool keysyms. */
export const toX11Keysym = (key: string): string => {
  const parts = key.split('+');
  if (parts.length < 2 || parts.some((part) => part === '')) return keysym(key);
  return parts.map(keysym).join('+');
};

export interface PointerPoint {
  x: number;
  y: number;
}

const round = (value: number): string => String(Math.round(value));

export const clickCommand = (
  at: PointerPoint,
  button: 'left' | 'middle' | 'right',
  clicks: number
): string[] => {
  const physical = { left: '1', middle: '2', right: '3' }[button];
  const repeat = Math.max(1, Math.min(3, Math.round(clicks)));
  return [
    'mousemove',
    '--sync',
    round(at.x),
    round(at.y),
    'click',
    ...(repeat > 1 ? ['--repeat', String(repeat), '--delay', '100'] : []),
    physical
  ];
};

/**
 * Run separately from active-window positioning: an empty xdotool window stack sends physical
 * wheel input through XTEST instead of window-targeted synthetic events that toolkits can ignore.
 */
export const scrollCommand = (
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number
): string[] => {
  const button = { up: '4', down: '5', left: '6', right: '7' }[direction];
  // A trackpad fling can otherwise queue hundreds of synthetic clicks behind the next action.
  const ticks = Math.max(1, Math.min(12, Math.round(amount)));
  return ['click', '--repeat', String(ticks), '--delay', '0', button];
};

const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;

/**
 * One chained xdotool invocation: press, interpolated motion, release.
 *
 * `xdotool mousemove` has no `--steps` option, so the previous implementation's argument list
 * was rejected outright and drags never worked. Toolkits also need a motion past their drag
 * threshold (8 px in GTK) early in the gesture or drag-and-drop never starts, so the first
 * sample is pushed out to at least that distance.
 */
export const dragCommand = (from: PointerPoint, to: PointerPoint, durationMs: number): string[] => {
  const steps = Math.max(4, Math.min(60, Math.round(durationMs / 16)));
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const pause = (durationMs / steps / 1000).toFixed(3);
  const args = ['mousemove', '--sync', round(from.x), round(from.y), 'mousedown', '1'];
  for (let step = 1; step <= steps; step += 1) {
    let progress = easeInOut(step / steps);
    if (step === 1 && distance > 0)
      progress = Math.max(progress, Math.min(1, DRAG_THRESHOLD_PX / distance));
    args.push(
      'sleep',
      pause,
      'mousemove',
      '--sync',
      round(from.x + (to.x - from.x) * progress),
      round(from.y + (to.y - from.y) * progress)
    );
  }
  return [...args, 'sleep', '0.05', 'mouseup', '1'];
};

export const pressCommand = (key: string): string[] => ['key', toX11Keysym(key)];

/**
 * xdotool's own default is 12 ms because toolkits process MappingNotify asynchronously; the
 * previous `--delay 1` garbled or dropped characters that need a keymap change, which is every
 * character the remote layout cannot produce.
 */
export const typeCommand = (text: string): string[] => ['type', '--delay', '12', '--', text];

const HELD_MODIFIERS = [
  'Control_L',
  'Control_R',
  'Shift_L',
  'Shift_R',
  'Alt_L',
  'Alt_R',
  'Super_L',
  'Super_R',
  'Meta_L',
  'Meta_R',
  'ISO_Level3_Shift',
  'ISO_Level5_Shift'
];

/**
 * An agent interrupted mid-chord leaves Ctrl and Shift latched at the X server, and every
 * later human keystroke silently becomes a chord. Released on every holder transition.
 */
export const releaseAllInputCommand = (): string[] => [
  ...HELD_MODIFIERS.flatMap((modifier) => ['keyup', modifier]),
  ...['1', '2', '3', '8', '9'].flatMap((button) => ['mouseup', button])
];

/** Converts a point the agent read off its screenshot into display pixels. */
export const imageToDisplayPoint = (
  point: PointerPoint,
  image: DisplayGeometry,
  display: DisplayGeometry
): PointerPoint => ({
  x: Math.min(display.width - 1, Math.max(0, Math.round((point.x * display.width) / image.width))),
  y: Math.min(
    display.height - 1,
    Math.max(0, Math.round((point.y * display.height) / image.height))
  )
});

/**
 * The smallest node whose bounds contain a point, which is what a click there will land on.
 *
 * Smallest rather than first: bounds nest, so a button inside a panel inside a window matches three
 * times and only the innermost is the thing being clicked.
 */
export const nodeUnderPoint = (
  nodes: readonly DesktopNode[],
  x: number,
  y: number
): DesktopNode | undefined => {
  let best: DesktopNode | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const bounds = node.bounds;
    if (!bounds) continue;
    if (x < bounds.x || y < bounds.y) continue;
    if (x > bounds.x + bounds.width || y > bounds.y + bounds.height) continue;
    const area = bounds.width * bounds.height;
    if (area < bestArea) {
      bestArea = area;
      best = node;
    }
  }
  return best;
};

/**
 * The actions whose meaning is a place on a picture, and which therefore go stale.
 *
 * `DesktopSnapshot.generation` is stamped on every snapshot, every still and every frame, and
 * `DesktopControl.authorize` has refused work naming a generation that is no longer current since
 * the day it was written. Nothing supplied one: `/desktop/action` called `act` with five
 * arguments, the stream route with four, and `DesktopAction` carries no `generation` on any of its
 * ten variants - so the whole mechanism was reachable only from a test, while the field it is
 * stamped on went on saying in writing that a stale coordinate was refused. The owner closes a dialog, the
 * `click_at(820, 410)` the agent computed from the screen before it lands on whatever is under
 * those pixels now, and nothing refuses.
 *
 * The supplier is the runner, not the model: `snapshot` records which generation it served the
 * agent and `act` names that one. A field on the contract would have cost bytes on every request
 * of every turn and handed the model arithmetic that the coordinate discipline - the runner
 * converts, the model never does - exists to keep it out of.
 *
 * These three and no others. `scroll` is aimed at the pointer the runner itself is holding,
 * `press` and `text_input` at whatever has focus, and the semantic actions carry a node id the
 * bridge resolves against the tree as it is now; none of those is a number read off a picture,
 * so refusing them would be ceremony rather than protection.
 */
const COORDINATE_ACTIONS: ReadonlySet<DesktopAction['type']> = new Set([
  'click_at',
  'drag',
  'zoom'
]);

export const classifyDesktopAction = (
  action: DesktopAction,
  node?: DesktopNode
): DesktopActionPreflight => {
  if (
    node &&
    signatureControl(node.name) &&
    ['invoke', 'set_text', 'text_input', 'click_at'].includes(action.type)
  )
    return {
      consequential: true,
      sensitiveInput: false,
      handoffKind: 'signature',
      preview: 'Review and sign this document yourself on the desktop.'
    };
  // Looking closer is a read. It moves nothing, types nothing and cannot be the thing that goes
  // wrong, so making it ask would be the ceremony that stopped the pixel path being usable.
  if (action.type === 'zoom')
    return {
      consequential: false,
      sensitiveInput: false,
      preview: `Look closely at ${Math.round(action.width)}x${Math.round(action.height)} pixels around ${Math.round(action.x)}, ${Math.round(action.y)}`
    };
  /**
   * A coordinate click was always consequential, and that made the pixel path close to unusable:
   * the mode that exists precisely for applications with no accessibility stopped for the owner on
   * every single click. The reason was sound - the harness could not say what a bare coordinate
   * would hit, so it could not write an honest card and could not tell Cancel from Delete.
   *
   * It can say, when the point lands inside a control the accessibility tree already described. A
   * click there is exactly as attributable as clicking that control by name, so it is judged the
   * same way and the card appears for the same reasons. A point that lands on nothing known is
   * still a blind click and still stops, which is the case the original rule was really about.
   */
  if (action.type === 'click_at' && node)
    return {
      consequential: consequentialText.test(`${node.name} ${node.description} ${node.role}`.trim()),
      sensitiveInput: false,
      preview: `Click ${node.role} "${node.name || 'unnamed'}" at ${Math.round(action.x)}, ${Math.round(action.y)}`
    };
  if (action.type === 'click_at' || action.type === 'drag')
    return {
      consequential: true,
      sensitiveInput: false,
      preview:
        action.type === 'click_at'
          ? `Coordinate click at ${Math.round(action.x)}, ${Math.round(action.y)}, which is not on any control this computer can name`
          : `Coordinate drag from ${Math.round(action.fromX)}, ${Math.round(action.fromY)} to ${Math.round(action.toX)}, ${Math.round(action.toY)}`
    };
  if (action.type === 'press' && toX11Keysym(action.key) === 'Return')
    return {
      consequential: true,
      sensitiveInput: false,
      preview: 'Press Enter in the focused desktop control'
    };
  /**
   * Typing at the keyboard was always treated as entering a secret, which meant the owner had to
   * take over the machine and type it themselves - for any text at all. On the semantic path the
   * same judgement is made properly: `set_text` is sensitive when the FIELD is, and ordinary
   * otherwise. The pixel path had no field to look at, so it assumed the worst about all of them,
   * and an application with no accessibility could not be typed into.
   *
   * It has a field to look at when something is focused. A password box is still a handoff; a
   * search box is typing. Nothing focused, or nothing the computer can name, keeps the old answer,
   * which is the case the rule was actually protecting.
   */
  if (action.type === 'text_input') {
    const focusedLabel =
      `${node?.name ?? ''} ${node?.description ?? ''} ${node?.role ?? ''}`.trim();
    // A field that refuses input is not one to name in a handoff card: telling the owner to type
    // into a read-only control is worse than telling them a field is focused and letting them look.
    // The state is `read_only` - `ATSPI_STATE_READ_ONLY` with the prefix off - and this asked for
    // `'read-only'`, a spelling AT-SPI does not use, so the branch had never once been taken.
    const knownField = Boolean(node) && !node?.states.includes(DESKTOP_STATE.readOnly);
    const secret = !node || Boolean(node.sensitive) || sensitiveText.test(focusedLabel);
    return {
      consequential: false,
      sensitiveInput: secret,
      preview: secret
        ? `Enter private text in ${knownField ? `the ${node?.role} "${node?.name || 'unnamed'}"` : 'the focused desktop field'}`
        : `Type into ${node?.role} "${node?.name || 'unnamed'}"`
    };
  }
  const label = `${node?.name ?? ''} ${node?.description ?? ''} ${node?.role ?? ''}`.trim();
  const sensitiveInput =
    action.type === 'set_text' && Boolean(node?.sensitive || sensitiveText.test(label));
  const consequential = action.type === 'invoke' && consequentialText.test(label);
  return {
    consequential,
    sensitiveInput,
    preview: `${action.type === 'invoke' ? 'Invoke' : action.type === 'set_text' ? 'Edit' : 'Focus'} “${node?.name || node?.role || 'desktop control'}”`
  };
};

const parseGeometry = (value: string | undefined, fallback: DisplayGeometry): DisplayGeometry => {
  const parsed = /^(\d{2,5})x(\d{2,5})$/.exec((value ?? '').trim());
  if (!parsed) return fallback;
  return { width: Number(parsed[1]), height: Number(parsed[2]) };
};

/**
 * What to say when a desktop program is not here, including what IS.
 *
 * Measured on the box. A turn was asked to use the desktop, tried `gedit`, then `xterm`, then
 * `mousepad`, got nothing from any of them and reported the desktop dead. It was not dead: X11,
 * xdotool, wmctrl and xrandr are all provisioned, and the desktop was serving. What the host has
 * no GUI application at all - the capability table in `scripts/athanor-host.sh` provisions the
 * desktop's plumbing and no programs to run in it - except the one athanor manages itself.
 *
 * So the refusal names it. A browser is the surface most desktop work wants anyway, and it is the
 * only program this computer can promise is present, because it is the one it installs. Guessing
 * three editors and concluding the screen is broken is the failure this sentence exists to end.
 */
const launchAdvice = async (
  executable: string,
  failure: NodeJS.ErrnoException
): Promise<string> => {
  const said = spawnFailureMessage(executable, failure);
  if (failure.code !== 'ENOENT') return said;
  try {
    const at = (await chromiumDriver()).executablePath();
    if (!at || !existsSync(at)) return said;
    return `${said} The one GUI program this computer manages is the browser, at ${at} - it opens on the desktop like any other window.`;
  } catch {
    return said;
  }
};

export class DesktopManager {
  readonly #sessions = new Map<string, DesktopSession>();
  readonly #starting = new Map<string, Promise<DesktopSession>>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #reservedDisplays = new Set<string>();
  readonly #failedStarts = new Map<string, () => Promise<void>>();
  readonly #closed = new WeakSet<DesktopSession>();
  readonly #lifetimes = new WeakMap<DesktopSession, AbortController>();
  readonly #lastUsed = new WeakMap<DesktopSession, number>();

  constructor(
    private readonly bridgeExecutable?: string,
    private readonly sessionExecutable?: string,
    /** Root-owned helpers a launched program may not name; see `launch`. */
    private readonly privilegedHelpers: readonly (string | undefined)[] = []
  ) {}

  get configured(): boolean {
    return Boolean(this.bridgeExecutable && this.sessionExecutable);
  }

  async sessions(workspaceId: string) {
    const session = this.#sessions.get(workspaceId);
    if (!session) return null;
    const privateInput = session.control.holder === 'secure_input';
    return {
      holder: session.control.holder,
      activeApplication: privateInput ? '' : session.activeApplication,
      windows: privateInput ? [] : await this.#visibleWindows(session)
    };
  }

  async ownerStroke(workspaceId: string, root: string, stroke: OwnerStroke): Promise<void> {
    const session = await this.ensure(workspaceId, root);
    await session.control.submit('user', async (signal) => {
      if (session.control.holder === 'secure_input')
        throw new Error('End private input before drawing');
      if (stroke.generation !== session.control.generation)
        throw new Error('The desktop changed. Draw again on the current screen.');
      const points = stroke.points.map((p) =>
        imageToDisplayPoint(p, session.geometry, session.geometry)
      );
      const first = points[0]!;
      const args = [
        'mousemove',
        '--sync',
        String(Math.round(first.x)),
        String(Math.round(first.y)),
        'mousedown',
        '1'
      ];
      for (const point of points.slice(1))
        args.push('mousemove', '--sync', String(Math.round(point.x)), String(Math.round(point.y)));
      args.push('mouseup', '1');
      try {
        await this.#run(session, '/usr/bin/xdotool', args, {
          env: session.env,
          timeoutMs: 15000,
          signal
        });
      } finally {
        await this.#run(session, '/usr/bin/xdotool', ['mouseup', '1'], {
          env: session.env,
          timeoutMs: 2000
        }).catch(() => undefined);
      }
    });
  }

  hasSubscribers(workspaceId: string): boolean {
    return Boolean(this.#sessions.get(workspaceId)?.subscribers.size);
  }

  /**
   * The X11 environment of this workspace's desktop, starting it if it is not already up. The
   * browser uses it to run on the same screen the Computer pane streams, so a page sees an
   * ordinary desktop and a person taking over finds the browser where they are already looking.
   * Only the display variables are handed out: the rest of a session's environment is its own.
   */
  async displayEnvironment(
    workspaceId: string,
    root: string
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if (!this.configured) return undefined;
    const session = await this.ensure(workspaceId, root);
    return {
      DISPLAY: session.env.DISPLAY,
      XAUTHORITY: session.env.XAUTHORITY,
      XDG_RUNTIME_DIR: session.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: session.env.DBUS_SESSION_BUS_ADDRESS
    };
  }

  /**
   * The control object for this workspace's screen, which the browser shares.
   *
   * There is one screen and there must be one answer to who holds it. Before this, the browser
   * kept a `holder` field of its own while the desktop kept a `DesktopControl`, so an owner who
   * pressed Take over on the Computer pane and an agent that had been handed the browser could
   * both believe they held the machine - and both send input to the same X server. The browser
   * asks for this the same way and at the same moment it asks for `displayEnvironment`, which is
   * the point at which the desktop it is about to run on has been started.
   */
  async controlFor(workspaceId: string, root: string): Promise<DesktopControl | undefined> {
    if (!this.configured) return undefined;
    const session = await this.ensure(workspaceId, root);
    return session.control;
  }

  async ensure(workspaceId: string, root: string): Promise<DesktopSession> {
    while (this.#closing.has(workspaceId)) await this.#closing.get(workspaceId);
    if (this.#failedStarts.has(workspaceId)) {
      await this.close(workspaceId);
      return this.ensure(workspaceId, root);
    }
    const pending = this.#starting.get(workspaceId);
    if (pending) return pending;
    const existing = this.#sessions.get(workspaceId);
    if (existing && this.#closed.has(existing)) {
      await this.close(workspaceId);
      return this.ensure(workspaceId, root);
    }
    if (existing && existing.process.exitCode === null && existing.process.signalCode === null) {
      this.#lastUsed.set(existing, Date.now());
      return existing;
    }
    const starting = this.#start(workspaceId, root);
    this.#starting.set(workspaceId, starting);
    try {
      const session = await starting;
      this.#lastUsed.set(session, Date.now());
      return session;
    } finally {
      if (this.#starting.get(workspaceId) === starting) this.#starting.delete(workspaceId);
    }
  }

  async retireIdle(
    hasBrowser: (workspaceId: string) => boolean,
    idleMs: number
  ): Promise<string[]> {
    const retired: string[] = [];
    for (const [workspaceId, session] of this.#sessions) {
      const eligible = () =>
        !this.#closing.has(workspaceId) &&
        !hasBrowser(workspaceId) &&
        Date.now() - (this.#lastUsed.get(session) ?? Date.now()) >= idleMs &&
        session.control.holder === 'agent' &&
        !session.control.busy &&
        session.subscribers.size === 0 &&
        session.applicationGroups.size === 0;
      if (!eligible()) continue;
      // A program may have been opened from the terminal rather than through launch().
      const windowList = await this.#run(session, '/usr/bin/xprop', ['-root', '_NET_CLIENT_LIST'], {
        env: session.env,
        timeoutMs: 5_000
      })
        .then((result) => result.stdout.toString('utf8'))
        .catch(() => null);
      if (
        !windowList ||
        !/^_NET_CLIENT_LIST\(WINDOW\): window id #\s*$/.test(windowList) ||
        !eligible()
      )
        continue;
      await this.close(workspaceId);
      retired.push(workspaceId);
    }
    return retired;
  }

  async #start(workspaceId: string, root: string): Promise<DesktopSession> {
    if (!this.configured)
      throw new Error('GUI desktop runtime is not enabled on this workspace runner');
    const usedDisplays = new Set(
      [...this.#sessions.values()].map((session) =>
        String(session.env.DISPLAY ?? '').replace(':', '')
      )
    );
    const display = Array.from({ length: 101 }, (_, index) => String(90 + index)).find(
      (candidate) =>
        !usedDisplays.has(candidate) &&
        !this.#reservedDisplays.has(candidate) &&
        !existsSync(`/tmp/.X${candidate}-lock`) &&
        !existsSync(`/tmp/.X11-unix/X${candidate}`)
    );
    if (!display) throw new Error('No GUI desktop display is available');
    // A starting X server has not created its socket or entered the session map yet.
    this.#reservedDisplays.add(display);
    let child: ChildProcess | undefined;
    let session: DesktopSession | undefined;
    try {
      const envFile = path.join(root, '.athanor', 'desktop', 'environment');
      await rm(envFile, { force: true });
      const process = spawn(this.sessionExecutable!, [root, display], {
        cwd: root,
        env: { ...processEnv(root) },
        // The session's own stderr is the only account of why it did not come up, and discarding it
        // left "GUI desktop session failed to start" as the whole story - which cost a long
        // afternoon the first time a real box refused. Kept to a few kilobytes because this is a
        // failure path, not a log.
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false
      });
      child = process;
      // Same reason as the launch path below, and reachable by the same call: this spawn is followed
      // by an await, so a session script that is missing or not executable would emit its error with
      // nobody listening and take the runner down before the loop could report anything.
      const sessionFailure = captureSpawnFailure(process);
      let complaint = '';
      process.stderr?.setEncoding('utf8');
      process.stderr?.on('data', (chunk: string) => {
        if (complaint.length < 4_000) complaint += chunk;
      });
      let serialized = '';
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const failedToSpawn = sessionFailure();
        // Checked before `exitCode`, because a spawn that never happened has no exit code at all and
        // would otherwise spin out the whole eight seconds before reporting the wrong sentence.
        if (failedToSpawn)
          throw new Error(
            `GUI desktop session failed to start: ${spawnFailureMessage(this.sessionExecutable!, failedToSpawn)}`
          );
        if (process.exitCode !== null || process.signalCode !== null)
          throw new Error(
            `GUI desktop session failed to start${complaint.trim() ? `: ${complaint.trim().split('\n').slice(-3).join(' ')}` : ''}`
          );
        try {
          serialized = await readFile(envFile, 'utf8');
          if (serialized.includes('DBUS_SESSION_BUS_ADDRESS=')) {
            ready = true;
            break;
          }
        } catch {
          // The session writes its environment only after X11 and D-Bus are ready.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) {
        throw new Error(
          `GUI desktop session did not become ready${complaint.trim() ? `: ${complaint.trim().split('\n').slice(-3).join(' ')}` : ''}`
        );
      }
      const values = Object.fromEntries(
        serialized
          .trim()
          .split('\n')
          .map((line) => {
            const separator = line.indexOf('=');
            if (separator < 1) throw new Error('GUI desktop environment is malformed');
            return [line.slice(0, separator), line.slice(separator + 1)] as [string, string];
          })
      );
      if (!values.XAUTHORITY) throw new Error('GUI desktop environment has no X11 authorization');
      // The control and the session reference each other: the control's release callback needs the
      // session, and the session holds the control. The binding is therefore declared before it can
      // be assigned and captured by the closure below, which const cannot express.
      const control = new DesktopControl({
        release: async () => {
          if (session) await this.#releaseAllInput(session);
        },
        onChange: () => {
          if (!session) return;
          this.#broadcastState(session);
          this.#syncEncoder(session);
        }
      });
      const boot = parseGeometry(values.ATHANOR_BOOT_RES, DEFAULT_BOOT_GEOMETRY);
      const env: NodeJS.ProcessEnv = {
        ...processEnv(root),
        DISPLAY: values.DISPLAY,
        XAUTHORITY: values.XAUTHORITY,
        DBUS_SESSION_BUS_ADDRESS: values.DBUS_SESSION_BUS_ADDRESS,
        XDG_RUNTIME_DIR: values.XDG_RUNTIME_DIR,
        NO_AT_BRIDGE: '0',
        GTK_MODULES: 'gail:atk-bridge',
        QT_ACCESSIBILITY: '1',
        QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
        SAL_ACCESSIBILITY_ENABLED: '1'
      };
      session = {
        root,
        process,
        env,
        control,
        subscribers: new Map(),
        applicationGroups: new Set(),
        activeApplication: '',
        lastAction: '',
        geometry: boot,
        bootGeometry: boot,
        ceiling: parseGeometry(values.ATHANOR_MAX_RES, DEFAULT_CEILING),
        outputName: 'screen',
        currentMode: null,
        codec: 'avc1',
        congested: false,
        atspi: true,
        // Nothing has been served yet, and `#adoptDisplay` below takes a generation of its own
        // bringing the display down to the boot size - so a fixed starting number here would refuse
        // the agent's first action for a resize that happened before it ever looked.
        observedGeneration: null,
        bridgeServe: true,
        bridgeQueue: Promise.resolve(),
        pointer: { x: Math.round(boot.width / 2), y: Math.round(boot.height / 2) },
        encoder: new DisplayEncoder({
          executable: '/usr/bin/ffmpeg',
          spawn: (executable, args) =>
            spawn(executable, [...args], {
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: false
            }),
          onFrame: (frame) => {
            if (session) this.#publish(session, frame);
          },
          /**
           * An encoder that cannot run is the pane going still, and it used to be silent.
           *
           * `onFailure` was declared, documented and never supplied, so a host with no
           * `/usr/bin/ffmpeg` restarted the child every half second for as long as anybody watched,
           * wrote nothing to the journal, and left the owner looking at a frozen screenshot with a
           * healthy socket. The encoder now backs off, and this is the line that says why - which is
           * the whole difference between "the Computer pane is broken" and "install ffmpeg".
           */
          onFailure: (cause) => {
            runnerLogger.warn('desktop.encoder_failed', {
              code: failureCode(cause),
              executable: '/usr/bin/ffmpeg'
            });
          }
        })
      };
      const active = session;
      process.once('exit', () => {
        this.#teardown(active);
        if (this.#sessions.get(workspaceId) === active) this.#sessions.delete(workspaceId);
      });
      await this.#adoptDisplay(session);
      if (process.exitCode !== null || process.signalCode !== null)
        throw new Error('GUI desktop session exited during startup');
      this.#sessions.set(workspaceId, session);
      return session;
    } catch (cause) {
      if (session) this.#teardown(session);
      if (child) {
        try {
          await this.#stopProcess(child);
        } catch (cleanupFailure) {
          const unfinished = child;
          this.#failedStarts.set(workspaceId, async () => {
            await this.#stopProcess(unfinished);
            this.#reservedDisplays.delete(display);
          });
          throw new AggregateError([cause, cleanupFailure], 'GUI desktop startup cleanup failed');
        }
      }
      throw cause;
    } finally {
      if (!this.#failedStarts.has(workspaceId)) this.#reservedDisplays.delete(display);
    }
  }

  /** Reads the real RandR state, then brings the display down to the boot size that the
   *  agent's coordinates and the encoder both assume. */
  async #adoptDisplay(session: DesktopSession): Promise<void> {
    const state = await this.#run(session, '/usr/bin/xrandr', ['--query'], {
      env: session.env,
      timeoutMs: 5_000
    })
      .then((result) => parseRandrState(result.stdout.toString('utf8')))
      .catch(() => null);
    if (!state) return;
    session.outputName = state.output;
    session.ceiling = state.maximum;
    session.geometry = state.current;
    session.currentMode = state.athanorModes[0] ?? null;
    if (
      state.current.width !== session.bootGeometry.width ||
      state.current.height !== session.bootGeometry.height
    )
      await this.#applyGeometry(session, session.bootGeometry).catch(() => undefined);
  }

  /**
   * One AT-SPI request at a time, over a connection that outlives the request.
   *
   * Spawning python3 per operation cost a full GObject-introspection import - hundreds of
   * milliseconds on every observe, every preflight and every semantic action. A bridge that
   * cannot hold a connection open falls back to the old one-process-per-request path for the
   * rest of the session.
   */
  async #bridge(session: DesktopSession, body: unknown): Promise<BridgeResult> {
    const request = session.bridgeQueue.then(async () => {
      this.#assertOpen(session);
      if (session.bridgeServe) {
        try {
          return await this.#bridgeOverChannel(session, body);
        } catch (cause) {
          this.#assertOpen(session);
          if (!(cause instanceof BridgeChannelError)) throw cause;
          session.bridgeServe = false;
        }
      }
      const result = await this.#run(session, '/usr/bin/python3', [this.bridgeExecutable!], {
        env: session.env,
        stdin: JSON.stringify(body),
        timeoutMs: 15_000
      });
      return JSON.parse(result.stdout.toString('utf8')) as BridgeResult;
    });
    session.bridgeQueue = request.then(
      () => undefined,
      () => undefined
    );
    return request;
  }

  async #bridgeOverChannel(session: DesktopSession, body: unknown): Promise<BridgeResult> {
    const channel = session.bridge ?? (await this.#openBridge(session));
    return this.#sendToBridge(session, channel, body, 15_000);
  }

  async #openBridge(session: DesktopSession): Promise<BridgeChannel> {
    this.#assertOpen(session);
    const child = spawn('/usr/bin/python3', [this.bridgeExecutable!, '--serve'], {
      env: session.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    const channel: BridgeChannel = { child, buffer: '', pending: null };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const { lines, rest } = splitBridgeLines(channel.buffer, chunk);
      channel.buffer = rest;
      for (const line of lines) this.#settleBridge(channel, line);
    });
    // Diagnostics are not part of the protocol, but an unread pipe eventually blocks python.
    child.stderr?.resume();
    const fail = (): void => {
      if (session.bridge === channel) delete session.bridge;
      const pending = channel.pending;
      channel.pending = null;
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.reject(new BridgeChannelError('Desktop accessibility bridge connection closed'));
    };
    child.once('exit', fail);
    child.once('error', fail);
    session.bridge = channel;
    try {
      // Doubles as a readiness handshake: a bridge that does not understand --serve waits for
      // end-of-input and never answers, which is exactly what this detects.
      const ready = await this.#sendToBridge(session, channel, { operation: 'ping' }, 8_000);
      this.#assertOpen(session);
      // The answer the probe was always giving and nobody was reading. A bridge that starts but
      // cannot import pyatspi can serve nothing semantic, so the session records it once here
      // rather than rediscovering it on every observation.
      session.atspi = (ready.result as { atspi?: boolean } | undefined)?.atspi !== false;
    } catch (cause) {
      this.#closeBridge(session);
      this.#assertOpen(session);
      throw new BridgeChannelError(
        cause instanceof Error ? cause.message : 'Desktop accessibility bridge did not start'
      );
    }
    return channel;
  }

  #settleBridge(channel: BridgeChannel, line: string): void {
    const pending = channel.pending;
    channel.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    try {
      const parsed = JSON.parse(line) as BridgeResult & { error?: string };
      if (typeof parsed.error === 'string') pending.reject(new Error(parsed.error));
      else pending.resolve(parsed);
    } catch {
      pending.reject(new Error('Desktop accessibility bridge returned malformed output'));
    }
  }

  async #sendToBridge(
    session: DesktopSession,
    channel: BridgeChannel,
    body: unknown,
    timeoutMs: number
  ): Promise<BridgeResult> {
    this.#assertOpen(session);
    return new Promise<BridgeResult>((resolve, reject) => {
      const stdin = channel.child.stdin;
      if (!stdin) {
        reject(new BridgeChannelError('Desktop accessibility bridge has no input stream'));
        return;
      }
      const timer = setTimeout(() => {
        this.#closeBridge(session, new Error('Desktop accessibility bridge timed out'));
      }, timeoutMs);
      timer.unref();
      channel.pending = { resolve, reject, timer };
      stdin.write(`${JSON.stringify(body)}\n`, (error) => {
        if (!error || channel.pending?.timer !== timer) return;
        channel.pending = null;
        clearTimeout(timer);
        reject(new BridgeChannelError(error.message));
      });
    });
  }

  #closeBridge(
    session: DesktopSession,
    cause: Error = new BridgeChannelError('Desktop accessibility bridge connection closed')
  ): void {
    const channel = session.bridge;
    if (!channel) return;
    delete session.bridge;
    const pending = channel.pending;
    channel.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    channel.child.kill('SIGKILL');
  }

  async #capture(session: DesktopSession, image: DisplayGeometry): Promise<Buffer> {
    const display = session.env.DISPLAY;
    if (!display) throw new Error('Desktop display is unavailable');
    const result = await this.#run(
      session,
      '/usr/bin/ffmpeg',
      stillCaptureArguments({
        display,
        geometry: session.geometry,
        image,
        quality: STILL_JPEG_QUALITY
      }),
      { env: session.env, timeoutMs: 10_000 }
    );
    return result.stdout;
  }

  async #visibleWindows(session: DesktopSession): Promise<DesktopSnapshot['windows']> {
    try {
      const result = await this.#run(
        session,
        '/usr/bin/xdotool',
        ['search', '--onlyvisible', '--name', '.', 'getwindowname', '%@'],
        { env: session.env, timeoutMs: 5_000 }
      );
      return result.stdout
        .toString('utf8')
        .split('\n')
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 100)
        .map((name, index) => ({ id: `x11:${index}`, name, role: 'window' }));
    } catch {
      this.#assertOpen(session);
      return [];
    }
  }

  async #run(
    session: DesktopSession,
    executable: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      stdin?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ) {
    const lifetime = this.#lifetime(session);
    const result = await run(executable, args, {
      ...options,
      signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal
    });
    this.#assertOpen(session);
    return result;
  }

  #assertOpen(session: DesktopSession): void {
    if (this.#closed.has(session)) throw new Error('Desktop session is closed');
  }

  #lifetime(session: DesktopSession): AbortController {
    this.#assertOpen(session);
    let lifetime = this.#lifetimes.get(session);
    if (!lifetime) {
      lifetime = new AbortController();
      this.#lifetimes.set(session, lifetime);
    }
    return lifetime;
  }

  async #releaseAllInput(session: DesktopSession): Promise<void> {
    await this.#run(session, '/usr/bin/xdotool', releaseAllInputCommand(), {
      env: session.env,
      timeoutMs: 5_000
    }).catch(() => undefined);
  }

  async snapshot(
    workspaceId: string,
    root: string,
    actor: 'agent' | 'user'
  ): Promise<DesktopSnapshot> {
    if (!this.configured)
      return {
        available: false,
        mode: 'unavailable',
        holder: 'agent',
        generation: 0,
        width: DEFAULT_BOOT_GEOMETRY.width,
        height: DEFAULT_BOOT_GEOMETRY.height,
        displayWidth: DEFAULT_BOOT_GEOMETRY.width,
        displayHeight: DEFAULT_BOOT_GEOMETRY.height,
        scale: 1,
        screenshotMimeType: 'image/jpeg',
        activeApplication: '',
        windows: [],
        nodes: [],
        nodesOmitted: 0,
        screenshotBase64: '',
        message: 'This Linux host does not have the Athanor GUI dependencies configured.'
      };
    const session = await this.ensure(workspaceId, root);
    const holder = session.control.holder;
    this.#assertOpen(session);
    if (holder === 'secure_input' && actor === 'agent')
      throw new Error('Desktop is in secure input mode');
    if (holder === 'user' && actor === 'agent') throw new Error('Desktop is held by the user');
    const image = agentImageGeometry(session.geometry, AGENT_IMAGE_LIMIT);
    if (holder === 'secure_input')
      return {
        available: true,
        mode: 'visual_fallback',
        holder,
        generation: session.control.generation,
        width: image.width,
        height: image.height,
        displayWidth: session.geometry.width,
        displayHeight: session.geometry.height,
        scale: image.scale,
        screenshotMimeType: 'image/jpeg',
        activeApplication: session.activeApplication,
        windows: [],
        nodes: [],
        nodesOmitted: 0,
        screenshotBase64: ''
      };
    let observation: BridgeResult = {};
    let mode: DesktopSnapshot['mode'] = 'semantic_and_visual';
    // Falling back to pixels is a real loss - the agent reads a picture of a document whose text it
    // could have had - so the reason travels with the snapshot instead of being swallowed. It is
    // what tells a reader the difference between a bridge that crashed and a toolkit that never
    // joined the accessibility bus.
    let reason = '';
    if (!session.atspi) {
      mode = 'visual_fallback';
      reason =
        'this desktop session has no accessibility stack, so only the screenshot is readable';
    } else
      try {
        observation = await this.#bridge(session, { operation: 'observe', maxNodes: 900 });
      } catch (error) {
        this.#assertOpen(session);
        mode = 'visual_fallback';
        reason = `accessibility bridge failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    let windows = observation.windows ?? [];
    if (!(observation.nodes?.length ?? 0)) {
      mode = 'visual_fallback';
      windows = await this.#visibleWindows(session);
      observation.activeApplication ||= windows[0]?.name ?? '';
      reason ||= windows.length
        ? 'the windows on screen expose no accessibility tree, so only the screenshot is readable'
        : 'nothing is on screen yet';
    }
    const screenshot = await this.#capture(session, image).catch(() => Buffer.alloc(0));
    this.#assertOpen(session);
    session.activeApplication = observation.activeApplication ?? session.activeApplication;
    // Scaled first, then selected, because the bounds decide whether a node is on screen and the
    // agent's coordinate space is the one that answers that.
    const selected = selectDesktopNodes(
      scaleNodeBounds(observation.nodes ?? [], session.geometry, image)
    );
    // Which observation the agent's next coordinates will have been read off, recorded here
    // because this return is the only place any are handed to it. The owner's pane polls this same
    // route, and their observation must not clear the agent's mark: the owner is usually the one
    // who moved the thing underneath it.
    if (actor === 'agent') session.observedGeneration = session.control.generation;
    return {
      available: true,
      mode,
      holder,
      generation: session.control.generation,
      width: image.width,
      height: image.height,
      displayWidth: session.geometry.width,
      displayHeight: session.geometry.height,
      scale: image.scale,
      screenshotMimeType: 'image/jpeg',
      activeApplication: session.activeApplication,
      windows,
      // AT-SPI reports screen coordinates in display pixels; the model reads them off the
      // screenshot, so they have to arrive in the same space the screenshot is in.
      nodes: selected.kept,
      nodesOmitted: selected.omitted,
      screenshotBase64: screenshot.toString('base64'),
      ...(reason ? { message: reason } : {})
    };
  }

  async launch(workspaceId: string, root: string, request: DesktopLaunchRequest) {
    const session = await this.ensure(workspaceId, root);
    if (session.control.holder !== 'agent')
      throw new Error(`Desktop control is held by ${session.control.holder}`);
    // The shell's reading of a bare cwd, so a program and a command started from `probe` open in
    // the same directory.
    const cwd = resolveCommandDirectory(root, request.cwd);
    // A desktop program is spawned directly, so without this the same command the shell refuses
    // runs unchecked simply by asking for a window. Resolved as well as literal, so a symbolic
    // link inside the workspace cannot present a harmless basename.
    const resolved = await resolveExecutable(
      request.executable,
      String(session.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'),
      cwd
    );
    const asResolved = resolved ? { ...request, executable: resolved } : request;
    if (
      privilegeEscalationBinary(request) ??
      privilegeEscalationBinary(asResolved) ??
      packageManagerInvocation(request) ??
      packageManagerInvocation(asResolved) ??
      privilegedHelperInvocation(request, this.privilegedHelpers) ??
      privilegedHelperInvocation(asResolved, this.privilegedHelpers)
    ) {
      throw new Error(
        'Privilege escalation and system-package commands cannot be started as desktop programs'
      );
    }
    const safeEnv = Object.fromEntries(
      Object.entries(request.env).filter(([key]) =>
        /^(?:LANG|LC_[A-Z_]+|TZ|NO_COLOR|SAL_USE_VCLPLUGIN)$/.test(key)
      )
    );
    // Without '=complete' Chromium may downgrade its accessibility mode mid-session and the
    // agent's node list silently thins out.
    const extraArgs = /(?:chromium|chrome|electron)$/i.test(path.basename(request.executable))
      ? ['--force-renderer-accessibility=complete']
      : [];
    this.#assertOpen(session);
    const child = spawn(request.executable, [...extraArgs, ...request.args], {
      cwd,
      env: { ...session.env, ...safeEnv },
      stdio: 'ignore',
      detached: true,
      shell: false
    });
    // Attached BEFORE the first await, because the error arrives on the next tick and an error
    // event nobody is listening for takes the whole runner down. This is the exact call that did:
    // `gedit` is not installed here, and asking for it killed the service five times over.
    const spawnFailure = captureSpawnFailure(child);
    if (child.pid) session.applicationGroups.add(child.pid);
    await new Promise((resolve) => setTimeout(resolve, 350));
    this.#assertOpen(session);
    const failed = spawnFailure();
    if (failed) throw new Error(await launchAdvice(request.executable, failed));
    if (child.exitCode !== null && child.exitCode !== 0)
      throw new Error(`${path.basename(request.executable)} failed to launch`);
    return { pid: child.pid, executable: request.executable, args: request.args };
  }

  async preflight(
    workspaceId: string,
    root: string,
    action: DesktopAction,
    actor: 'agent' | 'user'
  ): Promise<DesktopActionPreflight> {
    const session = await this.ensure(workspaceId, root);
    // No staleness argument here, deliberately. This route performs nothing: `#classify` re-reads
    // the tree and judges the action against the screen as it is at this instant, so its answer is
    // about the world now rather than about the observation the caller was holding. `act` is where
    // a superseded coordinate is refused, because `act` is what moves the pointer.
    session.control.authorize(actor);
    return this.#classify(session, action);
  }

  /**
   * What this action would do, judged against the tree as it is now.
   *
   * Split out of `preflight` so `act` can reach it with the session it already has. `act` used to
   * call the public `preflight`, which resolved the workspace a second time, took the control
   * authorization a second time, and left the judgement and the action holding two different
   * views of the machine between them. One session, one lookup, and the node id the lookup
   * returned is the one the bridge then verifies before it acts - which is what makes the card
   * and the action refer to the same widget.
   */
  async #classify(session: DesktopSession, action: DesktopAction): Promise<DesktopActionPreflight> {
    this.#assertOpen(session);
    // A coordinate click is looked up against the tree before it is judged, so a click that lands
    // on a control the computer can name is treated as what it is rather than as a blind one.
    if (action.type === 'click_at' || action.type === 'text_input') {
      // With no accessibility stack there is nothing to look it up against, and the round trip
      // could only time out. The conservative answer is the one the rule was written for.
      const observed = session.atspi
        ? await this.#bridge(session, { operation: 'observe', maxNodes: 900 }).catch(
            () => ({}) as BridgeResult
          )
        : ({} as BridgeResult);
      this.#assertOpen(session);
      const image = agentImageGeometry(session.geometry, AGENT_IMAGE_LIMIT);
      const scaled = scaleNodeBounds(observed.nodes ?? [], session.geometry, image);
      const target =
        action.type === 'click_at'
          ? nodeUnderPoint(scaled, action.x, action.y)
          : scaled.find((candidate) => candidate.states.includes(DESKTOP_STATE.focused));
      return classifyDesktopAction(action, target);
    }
    if (!['invoke', 'focus', 'set_text'].includes(action.type))
      return classifyDesktopAction(action);
    const observation = await this.#bridge(session, {
      operation: 'node',
      nodeId: (action as { nodeId: string }).nodeId
    });
    return classifyDesktopAction(action, observation.result as DesktopNode | undefined);
  }

  async act(
    workspaceId: string,
    root: string,
    action: DesktopAction,
    actor: 'agent' | 'user',
    consequentialApproved = false
  ) {
    const session = await this.ensure(workspaceId, root);
    /*
     * Which observation these coordinates were read off - taken from the session, so that the two
     * routes that reach this method get the check without passing anything and cannot forget to.
     * A sixth argument is how this shipped unwired the first time: it existed, it was tested, and
     * neither caller supplied it.
     *
     * Only the agent, and only the coordinate actions. The owner drags in the Computer pane while
     * looking at a live stream of the screen they are dragging on, so there is no earlier picture
     * for them to be stale against, and refusing them would be refusing the person the takeover
     * exists to serve.
     *
     * Passed to `submit` as well as to `authorize` on purpose: the second check runs inside the
     * queue slot, so a handover or a resize that lands between admitting this action and executing
     * it refuses the click rather than letting it land on the screen that replaced the one it was
     * computed from. That gap is the whole failure this is here for.
     */
    const expected =
      actor === 'agent' && COORDINATE_ACTIONS.has(action.type)
        ? (session.observedGeneration ?? undefined)
        : undefined;
    session.control.authorize(actor, expected);
    if (actor === 'agent') {
      const policy = await this.#classify(session, action);
      if (policy.handoffKind)
        throw new Error('A personal signature requires the owner to take control');
      if (policy.sensitiveInput) throw new Error('Secure desktop input takeover is required');
      if (policy.consequential && !consequentialApproved)
        throw new Error('A desktop consequential-action approval capability is required');
    }
    return session.control.submit(
      actor,
      async (signal) => this.#perform(session, action, actor, signal),
      expected === undefined ? {} : { generation: expected }
    );
  }

  async #perform(
    session: DesktopSession,
    action: DesktopAction,
    actor: 'agent' | 'user',
    signal: AbortSignal
  ): Promise<unknown> {
    this.#assertOpen(session);
    session.lastAction = classifyDesktopAction(action).preview;
    this.#broadcastState(session);
    if (['invoke', 'focus', 'set_text'].includes(action.type))
      return this.#bridge(session, { operation: 'act', action });
    if (action.type === 'wait') {
      await delay(action.milliseconds, undefined, {
        signal: AbortSignal.any([signal, this.#lifetime(session).signal])
      });
      return { waitedMilliseconds: action.milliseconds };
    }
    if (action.type === 'zoom') {
      // Given in the agent's own coordinates, like every other action, and converted here so the
      // model never does arithmetic - which is the rule the whole coordinate discipline rests on.
      const image = agentImageGeometry(session.geometry, AGENT_IMAGE_LIMIT);
      const origin = imageToDisplayPoint({ x: action.x, y: action.y }, image, session.geometry);
      const corner = imageToDisplayPoint(
        { x: action.x + action.width, y: action.y + action.height },
        image,
        session.geometry
      );
      const region = {
        x: origin.x,
        y: origin.y,
        width: Math.max(16, corner.x - origin.x),
        height: Math.max(16, corner.y - origin.y)
      };
      const capture = prepareStillCapture({
        display: session.env.DISPLAY ?? '',
        geometry: session.geometry,
        image,
        quality: STILL_JPEG_QUALITY,
        region
      });
      const pixels = await this.#run(session, '/usr/bin/ffmpeg', capture.args, {
        env: session.env,
        timeoutMs: 10_000,
        signal
      });
      return {
        // Named so the worker attaches it as an image the way it does a snapshot, and reported in
        // display pixels so the model can tell how much closer it is actually looking.
        screenshotBase64: pixels.stdout.toString('base64'),
        screenshotMimeType: 'image/jpeg',
        region: capture.region,
        displayWidth: session.geometry.width,
        displayHeight: session.geometry.height
      };
    }
    const xdotool = async (args: string[], timeoutMs = 10_000) =>
      this.#run(session, '/usr/bin/xdotool', args, { env: session.env, timeoutMs, signal });
    // The agent's coordinates are screenshot pixels and the human's are display pixels,
    // because those are the surfaces each of them is actually looking at.
    const image = agentImageGeometry(session.geometry, AGENT_IMAGE_LIMIT);
    const toDisplay = (point: PointerPoint): PointerPoint =>
      actor === 'agent'
        ? imageToDisplayPoint(point, image, session.geometry)
        : imageToDisplayPoint(point, session.geometry, session.geometry);
    if (action.type === 'click_at') {
      const at = toDisplay({ x: action.x, y: action.y });
      session.pointer = at;
      await xdotool(clickCommand(at, action.button, action.clicks));
    } else if (action.type === 'drag') {
      const from = toDisplay({ x: action.fromX, y: action.fromY });
      const to = toDisplay({ x: action.toX, y: action.toY });
      session.pointer = to;
      await xdotool(dragCommand(from, to, action.durationMs), action.durationMs + 10_000);
    } else if (action.type === 'press') {
      await xdotool(pressCommand(action.key));
    } else if (action.type === 'text_input') {
      /*
       * No actor check. This line read `if (actor !== 'user') throw` and made the classifier's
       * whole non-sensitive branch unreachable: `classifyDesktopAction` was deliberately rewritten
       * so that a password box is a handoff and a search box is typing, `#classify` pays a bridge
       * round trip to resolve the focused node for exactly that judgement, and the tool
       * description offers the agent `text_input` by name. Three things saying yes and one line
       * saying no, which the agent met as a hard error rather than as a handoff card.
       *
       * What still stops the agent is in `act`, where it belongs: `sensitiveInput` throws 'Secure
       * desktop input takeover is required'. That covers more than a password box - a field the
       * computer cannot see at all is judged secret, so a screen with no accessibility tree, or
       * with nothing focused, is still handed to the owner rather than typed into blind.
       */
      await xdotool(typeCommand(action.text), 10_000 + action.text.length * 20);
    } else if (action.type === 'scroll') {
      await xdotool([
        'getactivewindow',
        'mousemove',
        '--sync',
        '--window',
        '%1',
        '--polar',
        '0',
        '0'
      ]);
      signal.throwIfAborted();
      await xdotool(scrollCommand(action.direction, action.amount));
    }
    return { ok: true, action: action.type, generation: session.control.generation };
  }

  async setHolder(workspaceId: string, root: string, holder: DesktopHolder) {
    const session = await this.ensure(workspaceId, root);
    const state = await session.control.transfer(holder);
    return { holder: state.holder, generation: state.generation };
  }

  /**
   * Points the display at the client's viewport. Never letterbox a human: the agent adapts
   * by re-observing, which costs nothing, and the human cannot.
   */
  async resize(
    workspaceId: string,
    root: string,
    viewport: DisplayViewport
  ): Promise<{ width: number; height: number; generation: number; applied: boolean }> {
    const session = await this.ensure(workspaceId, root);
    return this.#resizeSession(session, viewport);
  }

  async #resizeSession(
    session: DesktopSession,
    viewport: DisplayViewport
  ): Promise<{ width: number; height: number; generation: number; applied: boolean }> {
    this.#assertOpen(session);
    const target = resolveTargetGeometry(viewport, {
      ceiling: session.ceiling,
      maximum: MAXIMUM_GEOMETRY,
      minimum: MINIMUM_GEOMETRY
    });
    if (!shouldApplyGeometry(session.geometry, target))
      return {
        width: session.geometry.width,
        height: session.geometry.height,
        generation: session.control.generation,
        applied: false
      };
    // A resize under an in-flight drag lands the release somewhere else entirely.
    await session.control.settle(2_000);
    await this.#applyGeometry(session, target);
    return {
      width: session.geometry.width,
      height: session.geometry.height,
      generation: session.control.generation,
      applied: true
    };
  }

  async #applyGeometry(session: DesktopSession, target: DisplayGeometry): Promise<void> {
    this.#assertOpen(session);
    const mode = cvtReducedBlankingMode(target.width, target.height);
    const xrandr = async (args: string[]) =>
      this.#run(session, '/usr/bin/xrandr', args, { env: session.env, timeoutMs: 5_000 });
    // A repeated size finds its mode already present; that is not an error.
    await xrandr(newModeArguments(mode)).catch(() => undefined);
    await xrandr(['--addmode', session.outputName, mode.name]).catch(() => undefined);
    await xrandr(['--output', session.outputName, '--mode', mode.name]);
    this.#assertOpen(session);
    const previous = session.currentMode;
    session.currentMode = mode.name;
    session.geometry = target;
    if (previous && previous !== mode.name) {
      // Modes accumulate otherwise, and some toolkits enumerate every one of them on each
      // screen-change event.
      await xrandr(['--delmode', session.outputName, previous]).catch(() => undefined);
      await xrandr(['--rmmode', previous]).catch(() => undefined);
    }
    session.control.bumpGeneration();
    this.#announceVideoConfig(session);
  }

  #state(session: DesktopSession): DesktopStreamState {
    return {
      holder: session.control.holder,
      holderSince: new Date(session.control.holderSince).toISOString(),
      generation: session.control.generation,
      width: session.geometry.width,
      height: session.geometry.height,
      transport: session.codec === 'jpeg' ? 'jpeg-frame-v1' : 'h264-annexb-v1',
      codec:
        session.codec === 'jpeg'
          ? 'image/jpeg'
          : avcCodecString(session.geometry, STREAM_FRAMERATE),
      protocol: DISPLAY_PROTOCOL,
      activeApplication: session.activeApplication,
      lastAction: session.lastAction
    };
  }

  #broadcastState(session: DesktopSession): void {
    if (this.#closed.has(session)) return;
    const state = this.#state(session);
    for (const subscriber of session.subscribers.keys()) subscriber.state(state);
  }

  #videoConfig(session: DesktopSession): Buffer {
    return encodeVideoConfig({
      codec:
        session.codec === 'jpeg'
          ? 'image/jpeg'
          : avcCodecString(session.geometry, STREAM_FRAMERATE),
      format: session.codec === 'jpeg' ? 'jpeg' : 'annexb',
      width: session.geometry.width,
      height: session.geometry.height,
      framerate: STREAM_FRAMERATE,
      generation: session.control.generation
    });
  }

  #announceVideoConfig(session: DesktopSession): void {
    if (this.#closed.has(session)) return;
    const state = this.#state(session);
    const config = this.#videoConfig(session);
    for (const [subscriber, queue] of session.subscribers) {
      // Anything queued was encoded for the previous geometry.
      queue.clear();
      subscriber.frame(config, state);
    }
  }

  #encoderConfig(session: DesktopSession): DisplayEncoderConfig {
    return {
      display: session.env.DISPLAY ?? ':90',
      geometry: session.geometry,
      codec: session.codec,
      framerate: STREAM_FRAMERATE,
      crf: STREAM_CRF,
      maxBitrateKbps: STREAM_MAX_KBPS,
      jpegQuality: STREAM_JPEG_QUALITY,
      // Burned into the stream so control is unambiguous even in a client that has not
      // implemented the overlay. Agent stills deliberately stay clean.
      border: { color: HOLDER_BORDER_COLORS[session.control.holder], thickness: 3 },
      generation: session.control.generation
    };
  }

  /**
   * Decides whether the encoder should be running at all: nobody watching means no encoder,
   * and secure input stops it outright rather than letting frames pile up to be flushed when
   * the mode ends.
   */
  #syncEncoder(session: DesktopSession): void {
    if (this.#closed.has(session)) return;
    const subscribers = [...session.subscribers.keys()];
    // One encoder serves every viewer, so the transport is the lowest common denominator: one
    // client without a `VideoDecoder` puts the session on JPEG rather than leaving that client
    // staring at a blank pane. `session.codec` was set to `avc1` at creation and never assigned
    // again, so the whole JPEG half of the encoder, the frame reader, the wire format and the
    // state's `transport` field were unreachable - shipped, tested in isolation, and impossible
    // to arrive at from a running system.
    const wantedCodec: DisplayCodec = subscribers.every(
      (subscriber) => subscriber.canDecodeVideo?.() ?? true
    )
      ? 'avc1'
      : 'jpeg';
    if (subscribers.length > 0 && session.codec !== wantedCodec) {
      session.codec = wantedCodec;
      // A generation bump for the same reason a resize takes one: frames already in flight were
      // produced by the old encoder in the old format, and `#publish` drops anything stamped with
      // a generation that is no longer current. Without it the first JPEG-era frames would be run
      // through `encodeVideoAccessUnit`, or the reverse.
      //
      // It is now also what `act` holds the agent's coordinates to, and this is the one bumper of
      // the three that does not move a single pixel: the display is the same size and the holder
      // is the same, so an agent refused here has lost nothing but one observation. Paid rather
      // than fixed with a second counter, because two answers to "is this observation current" is
      // how the frame filter and the coordinate check would drift apart. The price is one
      // re-observation each time the transport changes, and it changes only when a viewer without
      // a `VideoDecoder` joins or when the last such viewer leaves somebody else still watching.
      session.control.bumpGeneration();
      this.#broadcastState(session);
      this.#announceVideoConfig(session);
    }
    // Hysteresis: production stops at the high watermark and only resumes once somebody has
    // drained back below the low one, so a bufferbloat stall is a brief freeze rather than
    // an oscillation.
    if (
      session.congested &&
      subscribers.some((subscriber) => (subscriber.bufferedBytes?.() ?? 0) < LOW_WATER_BYTES)
    )
      session.congested = false;
    const wanted =
      subscribers.length > 0 && session.control.holder !== 'secure_input' && !session.congested;
    if (!wanted) {
      session.encoder.stop();
      return;
    }
    session.encoder.apply(this.#encoderConfig(session));
  }

  #publish(session: DesktopSession, frame: DisplayStreamFrame): void {
    if (this.#closed.has(session)) return;
    if (frame.generation !== session.control.generation) return;
    const state = this.#state(session);
    let starved = false;
    let congested = session.subscribers.size > 0;
    for (const [subscriber, queue] of session.subscribers) {
      queue.push(frame);
      if ((subscriber.bufferedBytes?.() ?? 0) >= HIGH_WATER_BYTES) continue;
      congested = false;
      for (;;) {
        const next = queue.shift();
        if (!next) break;
        subscriber.frame(
          session.codec === 'jpeg'
            ? encodeJpegFrame(next, session.geometry)
            : encodeVideoAccessUnit(next),
          state
        );
      }
      starved ||= queue.starved;
    }
    // Stop producing frames nobody can take, rather than burning CPU to throw them away.
    if (congested) {
      session.congested = true;
      session.encoder.stop();
    } else if (starved) session.encoder.requestKeyframe();
  }

  /**
   * Reconsiders the encoder for a workspace whose viewers have changed what they can take.
   *
   * The stream socket learns a client's decoding ability from its `hello`, which arrives after
   * the subscription is already live. Without a door back in, the answer would not be acted on
   * until the next 250 ms heartbeat - and on a client that cannot decode video, every frame
   * until then is one it discards.
   */
  async refreshStream(workspaceId: string, root: string): Promise<void> {
    this.#syncEncoder(await this.ensure(workspaceId, root));
  }

  async subscribeStream(
    workspaceId: string,
    root: string,
    subscriber: DesktopSubscriber
  ): Promise<() => Promise<void>> {
    const session = await this.ensure(workspaceId, root);
    this.#assertOpen(session);
    if (session.restore) {
      clearTimeout(session.restore);
      delete session.restore;
    }
    session.subscribers.set(subscriber, new DisplayFrameQueue(BACKPRESSURE_QUEUE_SIZE));
    if (subscriber.viewport)
      await this.#resizeSession(session, subscriber.viewport).catch(() => undefined);
    this.#assertOpen(session);
    subscriber.state(this.#state(session));
    subscriber.frame(this.#videoConfig(session), this.#state(session));
    this.#syncEncoder(session);
    if (!session.poll) {
      // Congestion clears silently, so the encoder needs a heartbeat to notice it may resume.
      session.poll = setInterval(() => this.#syncEncoder(session), ENCODER_POLL_MS);
      session.poll.unref();
    }
    return async () => {
      session.subscribers.delete(subscriber);
      if (this.#closed.has(session)) return;
      if (session.subscribers.size) return;
      session.encoder.stop();
      if (session.poll) {
        clearInterval(session.poll);
        delete session.poll;
      }
      if (session.restore) clearTimeout(session.restore);
      session.restore = setTimeout(() => {
        delete session.restore;
        if (this.#closed.has(session)) return;
        if (
          session.geometry.width === session.bootGeometry.width &&
          session.geometry.height === session.bootGeometry.height
        )
          return;
        void this.#applyGeometry(session, session.bootGeometry).catch(() => undefined);
      }, RESTORE_GRACE_MS);
      session.restore.unref();
    };
  }

  async close(workspaceId: string): Promise<void> {
    const pending = this.#closing.get(workspaceId);
    if (pending) return pending;
    const closing = this.#close(workspaceId);
    this.#closing.set(workspaceId, closing);
    try {
      await closing;
    } finally {
      if (this.#closing.get(workspaceId) === closing) this.#closing.delete(workspaceId);
    }
  }

  async #close(workspaceId: string): Promise<void> {
    await this.#starting.get(workspaceId)?.catch(() => undefined);
    const cleanup = this.#failedStarts.get(workspaceId);
    if (cleanup) {
      await cleanup();
      this.#failedStarts.delete(workspaceId);
    }
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    this.#teardown(session);
    await this.#stopProcess(session.process);
    if (this.#sessions.get(workspaceId) === session) this.#sessions.delete(workspaceId);
    this.#signalApplications(session, 'SIGKILL');
  }

  async #stopProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    let exited: (() => void) | undefined;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
      child.once('exit', resolve);
    });
    const wait = async (milliseconds: number) => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exit,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, milliseconds);
            timeout.unref();
          })
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    try {
      child.kill('SIGTERM');
      await wait(2_000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await wait(1_000);
      }
      if (child.exitCode === null && child.signalCode === null)
        throw new Error('GUI desktop session did not exit');
    } finally {
      if (exited) child.off('exit', exited);
    }
  }

  #teardown(session: DesktopSession): void {
    if (this.#closed.has(session)) return;
    this.#closed.add(session);
    this.#lifetimes.get(session)?.abort();
    session.encoder.stop();
    this.#closeBridge(session, new Error('Desktop session is closed'));
    for (const queue of session.subscribers.values()) queue.clear();
    session.subscribers.clear();
    if (session.poll) clearInterval(session.poll);
    if (session.restore) clearTimeout(session.restore);
    delete session.poll;
    delete session.restore;
    this.#signalApplications(session, 'SIGTERM');
    const timeout = setTimeout(() => this.#signalApplications(session, 'SIGKILL'), 1_000);
    timeout.unref();
  }

  #signalApplications(session: DesktopSession, signal: NodeJS.Signals): void {
    for (const processGroup of session.applicationGroups) {
      try {
        process.kill(-processGroup, signal);
      } catch {
        // The application and all of its descendants already exited.
      }
    }
    if (signal === 'SIGKILL') session.applicationGroups.clear();
  }
}

const scaleNodeBounds = (
  nodes: DesktopNode[],
  display: DisplayGeometry,
  image: DisplayGeometry
): DesktopNode[] => {
  if (display.width === image.width && display.height === image.height) return nodes;
  const x = image.width / display.width;
  const y = image.height / display.height;
  return nodes.map((node) =>
    node.bounds
      ? {
          ...node,
          bounds: {
            x: Math.round(node.bounds.x * x),
            y: Math.round(node.bounds.y * y),
            width: Math.round(node.bounds.width * x),
            height: Math.round(node.bounds.height * y)
          }
        }
      : node
  );
};

const processEnv = (root: string): NodeJS.ProcessEnv => ({
  // The same system-only list the runner's other helpers resolve against, read from one place
  // rather than spelled twice. It was written out here first; `hostSearchPath` is that spelling
  // given a name so `audio.ts`, `render-proof.ts` and `toolchain.ts` could stop using the agent's.
  PATH: hostSearchPath,
  HOME: root,
  LANG: 'C.UTF-8'
});
