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
 * Both used to be a bare `{type:'object'}` with every field name buried in one paragraph of the
 * tool description - which is exactly where a model guesses `value` for `text`, or `element` for
 * `selector`, and burns a round trip finding out. So every field is declared and typed, and it
 * still is.
 *
 * What changed is the encoding. Declaring them as a twenty-variant `oneOf` spent about five
 * kilobytes of every request on scaffolding rather than on capability: each variant repeated
 * `{"type":"object","additionalProperties":false,"description":…,"required":[…],"properties":
 * {"type":{"const":…}}}`, and the selector and tabId definitions were written out six and
 * seventeen times. Measured on browser_action, the union serialised to 8.3 kB of which only
 * 1.5 kB was variant description. `$defs`/`$ref` was measured too and came out *worse* at this
 * repetition count. A flat property bag discriminated by a sibling `action` enum came out at
 * about a third, and it is the shape `connector_action` below already ships. Only the per-action
 * *required set* moved into prose; nothing became untyped and nothing was withheld.
 *
 * The runner still validates against the BrowserAction and DesktopAction discriminated unions in
 * @garden/contracts, which did not move - `surfaceActionRequest` below is the single place the
 * two spellings meet.
 */
import { textValue } from './values.js';

const selector = {
  type: 'string',
  description:
    'A selector from the most recent browser_snapshot or read_elements; a frame selector works the same. With scroll or wait_for it names the container or element to act on instead of the page.'
};
const tabId = {
  type: 'string',
  description: 'Tab id from browser_snapshot. Omit to act on the active tab.'
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
     * The `wait_for` clause used to recommend network quiescence, and it recommended it for the
     * one case docs/design/browser-automation.md bans it for BY NAME, twice - once in its list of
     * what to ban from the codebase ("`waitForLoadState('networkidle')` (deprecated and wrong on
     * SPAs with long-polling/websockets)") and once in its pitfalls ("`networkidle` is deprecated
     * and never fires on SPAs with websockets or long-polling"). Quoted rather than cited by line,
     * because the two line numbers this comment first carried were already stale when it shipped:
     * the same wave that wrote them edited that document. The old sentence read "with none of those three it waits
     * for the network to go idle, which is what a single-page application needs after navigate" -
     * the exact inversion of the design, pointed at the exact page shape the design excludes. The
     * bare form is still what `#waitFor` in services/workspace-runner/src/browser.ts falls through
     * to, so this was the catalogue telling the model to prefer the arm's worst branch.
     *
     * The replacement steers to the three conditions and says what the bare form is worth, WITHOUT
     * naming the mechanism, because the mechanism is being replaced underneath it in this same
     * wave and a description that named one would be stale on arrival. "Waits on the page alone"
     * is true of both: of the `waitForLoadState('networkidle')` this was written against, and of
     * the `waitForLoadState('load')`-plus-settle protocol replacing it in
     * services/workspace-runner/src/browser.ts - read from that lane's working tree rather than
     * assumed. Neither knows a condition inside the application, which is the whole point.
     * "Can satisfy while still empty" is the failure the runner's own `#waitFor` comment already
     * records - "a snapshot taken straight after `navigate` on a single-page application returns
     * the empty shell" - and the replacement arm now says the same thing back in its own result
     * string, "wait on a selector or on text to wait for something in particular". The wire and
     * the arm agree without either quoting the other.
     *
     * It does NOT say what to do when all three conditions are unknowable; there is no fourth
     * branch in the arm to point at. Byte-neutral was the brief and it came in under: the clause
     * went from 125 bytes to 120, measured, so the catalogue moved 55,673 -> 55,668.
     */
    description:
      'Which action, and the fields it takes beyond the optional tabId every one of them accepts. navigate url. click, double_click, hover selector. type selector, text and mode - fill sets the value at once, keys sends real keystrokes, which is what wakes a typeahead or a keydown validator. select_option selector, values - every chosen value for a multiple-select. upload selector, paths. text_input text, into whatever has focus. press key, for example Enter, Tab or Escape. scroll deltaY, optional deltaX and selector. wait_for optional selector with state, or text, or urlIncludes, and timeoutMs; name one of those three, or it waits on the page alone, which a single-page application can satisfy while still empty. back. reload. new_tab optional url and activate. select_tab, close_tab and inspect_tab tabId - inspect_tab reads that tab in place and leaves the active one alone. click_at x, y - coordinate action governed by the selected permission mode; use a selector when the page exposes one. dialog response, optional promptText, to answer a native alert, confirm or prompt reported by browser_snapshot. screenshot path - writes a PNG of the page to that workspace path. batch actions.'
  },
  url: { type: 'string' },
  selector,
  text: {
    type: 'string',
    maxLength: 20_000,
    description: 'The text to type, or with wait_for the text to wait for on the page.'
  },
  mode: { type: 'string', enum: ['auto', 'fill', 'keys'], default: 'auto' },
  values: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
  paths: {
    type: 'array',
    minItems: 1,
    maxItems: 10,
    items: { type: 'string' },
    description: 'Workspace-relative files to attach. Workspace-relative paths only.'
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
    items: {
      type: 'object',
      description: 'One step: its own action plus that action’s fields. Never another batch.'
    },
    description:
      'For batch: up to 24 actions run in order in one round trip, stopping at the first failure. Use it to fill a whole form. The result is steps:[{index,type,ok,url?,error?}] plus completed, so a partial run says exactly how far it got.'
  },
  purpose: { type: 'string', description: 'What this action will do for the user.' }
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
      'Which action, and the fields it takes. invoke nodeId, optional actionIndex - activates a control through its accessibility action: press a button, open a menu item. focus nodeId. set_text nodeId, text - replaces the whole text of an editable control. text_input text, into whatever has focus. zoom x, y, width, height - one rectangle of the screen at its own size rather than the whole screen shrunk to fit; it changes nothing and needs no approval. press key, one key or chord, for example Return or ctrl+s. scroll direction, optional amount, over the focused window. click_at x, y, optional button and clicks - coordinate action governed by the selected permission mode; use a nodeId when the app exposes one. drag fromX, fromY, toX, toY, optional durationMs. wait milliseconds, to let the application settle.'
  },
  nodeId: {
    type: 'string',
    maxLength: 512,
    description: 'Accessibility node id from the most recent desktop_observe.'
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
  purpose: { type: 'string', description: 'What this GUI action will do for the user.' }
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
