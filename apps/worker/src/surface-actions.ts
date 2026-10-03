/**
 * The two GUI surfaces the model can act on: how their calls are declared, and how one is turned
 * into the request the runner accepts.
 *
 * Lifted out of tools.ts unchanged. It is the leaf of that file - nothing here reads a tool
 * definition, a policy or an approval - and it is where the two spellings of a surface verb meet,
 * which is a seam that wants to be readable on its own rather than three hundred lines apart in a
 * three-thousand-line module. `tools.ts` re-exports what it always exported, so no caller moved.
 */

/**
 * The action shapes for the browser and the desktop, declared rather than described.
 *
 * Every field is declared and typed. A field name buried in one paragraph of the tool description
 * is exactly where a model guesses `value` for `text`, or `element` for `selector`, and burns a
 * round trip finding out.
 *
 * The encoding is a flat property bag discriminated by a sibling `action` enum, the shape
 * `connector_action` below also has. A twenty-variant `oneOf` would cost about three times the
 * bytes, spent on scaffolding rather than on capability: each variant repeats the object
 * boilerplate, and the selector and tabId definitions would be written out six and seventeen
 * times. `$defs`/`$ref` comes out *worse* at this repetition count. Only the per-action *required
 * set* is in prose; nothing is untyped and nothing is withheld.
 *
 * The runner validates against the BrowserAction and DesktopAction discriminated unions in
 * @garden/contracts - `surfaceActionRequest` below is the single place the two spellings meet.
 */
import { textValue } from './values.js';

const selector = {
  type: 'string',
  description: 'From browser_snapshot or read_elements; frame selectors work too.'
};
const tabId = {
  type: 'string',
  description: 'Omit for the active tab.'
};

const browserActionEnum = [
  'navigate',
  'click',
  'double_click',
  'hover',
  'type',
  'select_option',
  'upload',
  'text_input',
  'press',
  'scroll',
  'wait_for',
  'back',
  'reload',
  'new_tab',
  'select_tab',
  'close_tab',
  'inspect_tab',
  'click_at',
  'dialog',
  'screenshot',
  'batch'
];

export const browserActionProperties: Record<string, unknown> = {
  action: {
    type: 'string',
    enum: browserActionEnum,
    /*
     * The `wait_for` entry names its three conditions and no mechanism. A bare wait falls through
     * to waiting on the page alone in `#waitFor` in services/workspace-runner/src/browser.ts, and
     * that can be satisfied by a single-page application's empty shell;
     * docs/design/browser-automation.md bans network quiescence for the same page shape. Naming no
     * mechanism keeps the description true whichever one the runner uses underneath it.
     */
    description:
      'Fields per action: navigate url. click, double_click, hover selector. type selector, text, mode (keys sends real keystrokes for typeaheads and validators). select_option selector, values. upload selector, paths. text_input text. press key. scroll deltaY, deltaX?, selector?. wait_for selector+state, text or urlIncludes, timeoutMs. new_tab url?, activate?. select_tab, close_tab, inspect_tab tabId. click_at x, y. dialog response, promptText?. screenshot path. batch actions.'
  },
  url: { type: 'string' },
  selector,
  text: {
    type: 'string',
    maxLength: 20_000,
    description: 'Text to type, or for wait_for the text to wait for.'
  },
  mode: { type: 'string', enum: ['auto', 'fill', 'keys'], default: 'auto' },
  values: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
  paths: {
    type: 'array',
    minItems: 1,
    maxItems: 10,
    items: { type: 'string' },
    description: 'Workspace files to attach.'
  },
  key: { type: 'string' },
  deltaX: { type: 'number', minimum: -5_000, maximum: 5_000, default: 0 },
  deltaY: { type: 'number', minimum: -5_000, maximum: 5_000 },
  state: {
    type: 'string',
    enum: ['visible', 'hidden', 'attached', 'detached'],
    default: 'visible'
  },
  urlIncludes: { type: 'string', maxLength: 2_000 },
  timeoutMs: { type: 'integer', minimum: 100, maximum: 60_000, default: 15_000 },
  activate: { type: 'boolean', default: true },
  x: { type: 'number', minimum: 0, maximum: 1_440 },
  y: { type: 'number', minimum: 0, maximum: 900 },
  response: { type: 'string', enum: ['accept', 'dismiss'] },
  promptText: { type: 'string', maxLength: 4_000 },
  path: { type: 'string', maxLength: 1_024 },
  tabId,
  actions: {
    type: 'array',
    minItems: 1,
    maxItems: 24,
    // Repeating the other nineteen shapes here doubled the size of the largest tool in the
    // catalogue, and the catalogue opens the prompt prefix on every request. The runner validates
    // each entry against the same union either way.
    items: { type: 'object' },
    description: 'For batch: steps run in order, stopping at the first failure.'
  },
  purpose: { type: 'string', description: 'What this does for the user.' }
};

export const desktopActionProperties: Record<string, unknown> = {
  action: {
    type: 'string',
    enum: [
      'invoke',
      'focus',
      'set_text',
      'text_input',
      'zoom',
      'press',
      'scroll',
      'click_at',
      'drag',
      'wait'
    ],
    description:
      'Fields per action: invoke nodeId, actionIndex?. focus nodeId. set_text nodeId, text (replaces it). text_input text. zoom x, y, width, height (full-resolution crop, changes nothing). press key or chord. scroll direction, amount?. click_at x, y, button?, clicks?. drag fromX, fromY, toX, toY, durationMs?. wait milliseconds.'
  },
  nodeId: {
    type: 'string',
    maxLength: 512,
    description: 'From the latest desktop_observe.'
  },
  actionIndex: { type: 'integer', minimum: 0, maximum: 100, default: 0 },
  text: { type: 'string', maxLength: 200_000 },
  key: { type: 'string', maxLength: 100 },
  direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
  amount: { type: 'integer', minimum: 1, maximum: 100, default: 3 },
  x: { type: 'number', minimum: 0, maximum: 1_440 },
  y: { type: 'number', minimum: 0, maximum: 900 },
  width: { type: 'number', minimum: 16, maximum: 1_440 },
  height: { type: 'number', minimum: 16, maximum: 900 },
  button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' },
  clicks: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
  fromX: { type: 'number', minimum: 0, maximum: 1_440 },
  fromY: { type: 'number', minimum: 0, maximum: 900 },
  toX: { type: 'number', minimum: 0, maximum: 1_440 },
  toY: { type: 'number', minimum: 0, maximum: 900 },
  durationMs: { type: 'integer', minimum: 50, maximum: 10_000, default: 500 },
  milliseconds: { type: 'integer', minimum: 50, maximum: 30_000 },
  purpose: { type: 'string', description: 'What this does for the user.' }
};

/** Everything a surface action call carries except the discriminator and the model's own sentence. */
/**
 * The verb a surface call is asking for, resolved once so the gate and the runner cannot disagree.
 *
 * `action` is the spelling the tool declares. `type` is the spelling the runner's own union uses,
 * the one the tool's `steps:[{index,type,…}]` result reports back, and the one a turn already in
 * flight replays out of its own history after a deploy - so it arrives in practice, and it has to
 * mean the same thing to the approval broker as it does to the request builder. Reading it in one
 * place is what guarantees that; reading it in two is how `{action:'hover', type:'click_at'}` got a
 * click past a gate that had been told it was a hover.
 */
export const surfaceActionVerb = (bag: Record<string, unknown>): string =>
  textValue(bag.action) || textValue(bag.type);

/*
 * `type` is dropped along with the rest, and that is the whole of what keeps this safe.
 *
 * The verb now travels as `action` and the runner still reads a nested `type`, so a stray `type` in
 * the bag would spread after the computed discriminator and win. Gate and executor would then read
 * two different verbs out of one call: `{action:'hover', type:'click_at', x:500, y:400}` raises no
 * card, because `hover` is on the review-mode read-only list, and executes a click at coordinates.
 * The same shape inside a `batch` step skipped the per-step scan entirely while rebuilding into a
 * request the runner accepts.
 *
 * It does not take an adversary to produce one. `type` is the spelling the runner, the contracts
 * package and this tool's own `steps:[{index,type,…}]` result all use, and a turn already in flight
 * across a deploy replays its own earlier calls out of history in the old shape.
 */
const surfaceActionFields = (bag: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(bag).filter(
      (entry) =>
        !['action', 'type', 'purpose', 'actions'].includes(entry[0]) && entry[1] !== undefined
    )
  );

/**
 * The flat bag the model writes, turned into the nested action the runner's union wants.
 *
 * `browser_action` and `desktop_action` are declared as one property bag discriminated by a sibling
 * `action` string, because a twenty-variant `oneOf` cost about five kilobytes of every request in
 * scaffolding. BrowserAction and DesktopAction in @garden/contracts are still discriminated on a
 * nested `type`, and deliberately so - the runner's acceptance surface did not widen by a byte.
 * This is the one place the two spellings meet, and it is also where `purpose` is dropped: it is
 * the model's sentence for the owner's card, and forwarding it would put it in the request.
 *
 * A batch carries the same bag per step, so each step is remapped too - but never recursively: the
 * runner's union has no nested batch, and refusing to descend keeps this bounded whatever arrives.
 */
export const surfaceActionRequest = (args: Record<string, unknown>): Record<string, unknown> => {
  const type = surfaceActionVerb(args);
  const fields = surfaceActionFields(args);
  if (type !== 'batch') return { type, ...fields };
  return {
    type,
    ...fields,
    actions: (Array.isArray(args.actions) ? args.actions : []).map((step) => {
      const bag = (step && typeof step === 'object' ? step : {}) as Record<string, unknown>;
      return { type: surfaceActionVerb(bag), ...surfaceActionFields(bag) };
    })
  };
};
