import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserAction } from '@athanor/contracts';
import {
  BotWallLedger,
  BrowserManager,
  BrowserDownloadHistory,
  type BrowserStreamState
} from './browser.js';
import { DesktopControl } from './holder.js';

/**
 * The half of `browser.ts` that performs actions, rather than the half that classifies them.
 *
 * `browser.test.ts` covers every pure function in the file - the classifier, the ref resolver, the
 * element folder, the wall ledger, the launch ladder - and nothing in it executes `act`, `#perform`,
 * `#guardStep` or `#enforce`. Those are the 300 lines of switch that decide which Playwright call an
 * agent's tool call becomes, and no test reached them: a refusal that never fires, a verb sent to
 * the wrong locator, or a gate skipped for one actor would all have shipped green.
 *
 * So `Page` is stubbed rather than launched. Every fake verb appends one line to a trace, and the
 * assertions are almost all "which Playwright call, against which selector, with which argument" -
 * which is what `#perform` is for. The gates are driven through the door the route uses,
 * `act(workspaceId, root, action, actor, consequentialApproved)`, with both actors, because `actor`
 * decides whether the address policy, the challenge check and the approval gate run at all.
 */

/** A literal address: public, and checked without a DNS lookup, so the suite never leaves the box. */
const PAGE_URL = 'https://93.184.216.34/checkout';
const OTHER_URL = 'https://93.184.216.34/receipt';
const LOOPBACK_URL = 'http://127.0.0.1:8080/admin';
/** Frame ordinal 0, so `resolveBrowserTarget` looks in the page's own frame first. */
const REF = '[data-athanor-ref="oc-0-3"]';
const SUBMIT_REF = '[data-athanor-ref="oc-0-9"]';
const WORKSPACE_ROOT = '/nonexistent';

/**
 * What one control answers when the runner asks about it.
 *
 * `evaluate` cannot run the real page function here, so it answers with whatever the fixture
 * registered. The default answers the union of the two shapes the runner asks for - the policy
 * input `#classify` reads and the typing descriptor `type` reads - because both are read off the
 * same element, and a fixture that had to know which one was coming would be asserting call order
 * rather than behaviour. `upload` asks a third question, a bare boolean, and its fixtures say so.
 */
interface FakeElement {
  /** How many nodes this ref resolves to: `resolveBrowserTarget` refuses 0 and refuses 2. */
  count?: number;
  evaluate?: unknown;
  /** The message this element's verbs throw, for driving a step that fails inside a batch. */
  fails?: string;
  /**
   * Its `pressSequentially` never resolves, which is what a real one looks like while it is still
   * working: it paces itself at 30 ms a character with a 60-second ceiling, so a long string is
   * most of a minute of typing that a takeover arriving halfway through has to end.
   */
  stalls?: boolean;
  /** Acting on it starts a download, the way a link to a file does. */
  downloadUrl?: string;
}

const CONTROL: Record<string, unknown> = {
  tag: 'input',
  type: 'text',
  name: 'Full name',
  autocomplete: '',
  formAction: '',
  inForm: true,
  role: '',
  ariaAutocomplete: '',
  hasList: false,
  contentEditable: false
};

/** A submit button inside a form, which `classifyBrowserAction` calls consequential. */
const SUBMIT_CONTROL: Record<string, unknown> = {
  ...CONTROL,
  tag: 'button',
  type: 'submit',
  name: 'Place order'
};

/**
 * One interactive element as the page reports it, so `inspect_tab`'s scan has something to fold and
 * the result carries the selector the agent would act on next.
 */
const RAW_ELEMENT = {
  ref: 'oc-0-1',
  tag: 'input',
  role: null,
  ariaLabel: 'Full name',
  labelledByText: '',
  labelText: '',
  placeholder: '',
  title: '',
  text: '',
  type: 'text',
  href: null,
  elementId: 'name',
  fieldName: 'name',
  valueBearing: true,
  value: 'Ada',
  password: false,
  checked: null,
  disabled: false,
  required: false,
  maxLength: null,
  pattern: '',
  invalid: false,
  description: '',
  options: null,
  labelFor: null,
  closedShadowRoot: false
};

type Session = Awaited<ReturnType<BrowserManager['ensure']>>;
type ActResult = Awaited<ReturnType<BrowserManager['act']>>;

/** The session `ensure` hands back, in the shape these tests read rather than Playwright's. */
interface HarnessSession {
  page: { url: () => string };
  /**
   * Who holds the screen. It was a `holder` field on the session until the browser and the desktop
   * stopped keeping one answer each, so the cases below take the browser through `setHolder` - the
   * same door the pane's Take over button uses - rather than assigning to it.
   */
  control: DesktopControl;
  tabs: Map<string, { url: () => string; isClosed: () => boolean }>;
  walls: BotWallLedger;
  downloads: BrowserDownloadHistory;
  /**
   * Playwright's `Dialog` handle, in the two shapes the tests need: `type`/`message` are what the
   * stream state projects and are optional here because most cases only answer the thing.
   */
  pendingDialog?: {
    type?: () => string;
    message?: () => string;
    accept: (text?: string) => Promise<void>;
    dismiss: () => Promise<void>;
  };
  streamTitle: string;
}

interface Harness {
  manager: BrowserManager;
  session: HarnessSession;
  /** Every Playwright verb the run reached, tab-qualified, in order. */
  trace: string[];
  elements: Map<string, FakeElement>;
  /** What the pages answer about themselves, and where a navigation actually ended up. */
  world: {
    title: string;
    text: string;
    serverIp: string;
    landsOn: string | null;
    /** The page-side scan's answer, which is what `elementsOmitted` is arithmetic on. */
    scan: { elements: unknown[]; matched: number };
    /** Whether `waitForLoadState` rejects, which is what a page that never finishes looks like. */
    loadFails: boolean;
    /** How many iframes the page has beyond its own main frame. */
    extraFrames: number;
    /**
     * How many times anything asked the page for its title. `page.title()` is a CDP round trip
     * to the page's main thread, so on the stream path it is the number that matters.
     */
    titleReads: number;
  };
  /** The screencast the stream route is fed from, once something has subscribed. */
  cdp: FakeCdp;
  /**
   * Every CDP session the run attached, in order, including the ones it detached again. The
   * screencast's lifecycle is four awaits long and three callers reach it, so "how many are still
   * attached" is the question, not "did one attach".
   */
  cdpSessions: FakeCdp[];
  /**
   * Runs at the one instant the screencast's lifecycle is halfway through - `session.stream` has
   * been torn down and its replacement not yet assigned. Concurrency here is not something a test
   * can arrange by starting two calls and hoping; this puts the second caller exactly in the gap.
   */
  hooks: { onAttachCdp: (() => void) | null };
}

/**
 * `ensure` launches Chromium, cleans profile locks and wires eight page listeners. None of that is
 * what this file is measuring, and all of it needs a browser on the machine, so the one seam is
 * overridden and everything below it - `act`, `#guardStep`, `#enforce`, `#classify`, `#perform`,
 * `#waitFor`, `#assertNavigationClean`, `#settleDownloads` - is the shipped code.
 */
class PerformManager extends BrowserManager {
  constructor(private readonly fake: Session) {
    super({ maxFileBytes: 1024 * 1024 });
  }

  override async ensure(): Promise<Session> {
    return this.fake;
  }
}

/**
 * The CDP session the screencast rides on.
 *
 * `#startStream` attaches a `Page.screencastFrame` listener and acks each frame; this records the
 * order of everything it sends, because the order is the defect: the ack used to sit in a
 * `finally` behind an awaited `page.title()`, and Chromium sends no further frame until the
 * previous one is acked.
 */
class FakeCdp {
  readonly sent: string[] = [];
  /** False once `detach` has run, which is what "one session survives" is counted over. */
  attached = true;
  #frame: ((frame: { data: string; sessionId: number }) => void) | undefined;

  on(event: string, handler: (frame: { data: string; sessionId: number }) => void): void {
    if (event === 'Page.screencastFrame') this.#frame = handler;
  }

  async send(method: string): Promise<void> {
    this.sent.push(method);
  }

  async detach(): Promise<void> {
    this.sent.push('detach');
    this.attached = false;
  }

  /** One frame off the wire, as Chromium would deliver it. */
  deliver(data = 'aGVsbG8='): void {
    this.#frame?.({ data, sessionId: 1 });
  }
}

const buildHarness = (): Harness => {
  const trace: string[] = [];
  const elements = new Map<string, FakeElement>();
  const world: Harness['world'] = {
    title: 'Checkout',
    text: 'Total 42.00',
    serverIp: '93.184.216.34',
    landsOn: null,
    titleReads: 0,
    // What the page-side scan answers: the window it collected, and how many visible interactive
    // elements the frame actually had before the budget cut it.
    scan: { elements: [RAW_ELEMENT], matched: 1 },
    loadFails: false,
    extraFrames: 0
  };
  const cdpSessions: FakeCdp[] = [];
  const hooks: Harness['hooks'] = { onAttachCdp: null };
  const downloads = new BrowserDownloadHistory();
  const tabs = new Map<string, ReturnType<typeof makePage>>();
  let nextTabId = 1;

  function makePage(initialUrl: string) {
    let url = initialUrl;
    let closed = false;
    // Assigned when the page is registered. The trace is tab-qualified, so a step that acted on
    // the tab the owner is watching rather than the one it named is visible in the assertion.
    let tabId = '';
    const say = (line: string): void => {
      trace.push(`${tabId} ${line}`);
    };
    const landed = () => {
      // Where the browser ended up, which is not where it was sent when anything redirected.
      if (world.landsOn !== null) url = world.landsOn;
      return {
        status: () => 200,
        headers: () => ({}),
        serverAddr: async () => ({ ipAddress: world.serverIp, port: 443 })
      };
    };
    const locator = (selector: string) => {
      const element = elements.get(selector) ?? {};
      const verb = async (line: string): Promise<void> => {
        say(`${line} ${selector}`);
        if (element.stalls && line.startsWith('keys ')) return new Promise<never>(() => undefined);
        if (element.fails) throw new Error(element.fails);
        if (element.downloadUrl) {
          downloads.record({
            path: 'workspace/downloads/2026-01-01/invoice.pdf',
            url: element.downloadUrl
          });
        }
      };
      const self = {
        first: () => self,
        count: async () => element.count ?? 1,
        click: () => verb('click'),
        dblclick: () => verb('dblclick'),
        hover: () => verb('hover'),
        fill: (text: string) => verb(`fill ${JSON.stringify(text)}`),
        pressSequentially: (text: string) => verb(`keys ${JSON.stringify(text)}`),
        selectOption: (values: string | string[]) =>
          verb(`select ${JSON.stringify([values].flat())}`),
        setInputFiles: (files: string[]) =>
          verb(`attach ${JSON.stringify(files.map((file) => path.basename(file)))}`),
        waitFor: (input: { state: string }) => verb(`await-${input.state}`),
        innerText: async () => world.text,
        evaluate: async () => element.evaluate ?? CONTROL
      };
      return self;
    };
    const page = {
      url: () => url,
      title: async () => {
        world.titleReads += 1;
        return world.title;
      },
      isClosed: () => closed,
      // The page is its own main frame, which is what `resolveBrowserTarget` and `#scanPage` walk.
      // `world.extraFrames` stands in for iframes: enough of them and the scan stops before the
      // last ones, which is where consent and payment frames live.
      frames: () => [
        page,
        ...Array.from({ length: world.extraFrames }, () => ({
          url: () => 'https://93.184.216.34/consent',
          evaluate: async () => ({ elements: [], matched: 0 })
        }))
      ],
      locator,
      getByText: (text: string) => locator(`text=${text}`),
      // Three different page functions come through here. The settle sleep is the one that takes
      // a number, and it is traced because the wait protocol is what several cases are about; the
      // element scan answers `world.scan`; the image scan is the remaining shape.
      evaluate: async (_fn: unknown, argument?: unknown) => {
        if (typeof argument === 'number') {
          say(`settle ${argument}`);
          return undefined;
        }
        if (argument && typeof argument === 'object' && 'query' in argument) return world.scan;
        return [];
      },
      viewportSize: () => ({ width: 1440, height: 900 }),
      goto: async (destination: string) => {
        url = destination;
        say(`goto ${destination}`);
        return landed();
      },
      goBack: async () => {
        say('goBack');
        return landed();
      },
      reload: async () => {
        say('reload');
        return landed();
      },
      bringToFront: async () => say('bringToFront'),
      screenshot: async (options: { type: string }) => {
        say(`screenshot ${options.type}`);
        return Buffer.from('png-bytes');
      },
      close: async () => {
        say('close');
        closed = true;
        // Production removes it from the registry on the page's own close event.
        tabs.delete(tabId);
      },
      waitForURL: async () => say('waitForURL'),
      waitForLoadState: async (state: string) => {
        say(`waitForLoadState ${state}`);
        // A page still loading when the wait's ceiling arrives: Playwright rejects, and what the
        // runner does with that rejection is the whole of item 2.
        if (world.loadFails) throw new Error(`Timeout exceeded waiting for ${state}`);
      },
      waitForEvent: async (event: string) => {
        say(`waitForEvent ${event}`);
        return { setFiles: async (files: string[]) => say(`chooser ${files.length}`) };
      },
      mouse: {
        click: async (x: number, y: number) => say(`mouse.click ${x},${y}`),
        move: async (x: number, y: number) => say(`mouse.move ${x},${y}`),
        wheel: async (deltaX: number, deltaY: number) => say(`mouse.wheel ${deltaX},${deltaY}`),
        // What a handover lifts. Playwright latches these per page, so a drag that threw between
        // down and up, or an interrupted chord, stays held until something says otherwise.
        up: async (options: { button: string }) => say(`mouse.up ${options.button}`)
      },
      keyboard: {
        press: async (key: string) => say(`keyboard.press ${key}`),
        insertText: async (text: string) => say(`keyboard.insertText ${JSON.stringify(text)}`),
        up: async (key: string) => say(`keyboard.up ${key}`)
      },
      register: (assigned: string) => {
        tabId = assigned;
      }
    };
    return page;
  }

  const attach = (page: ReturnType<typeof makePage>): ReturnType<typeof makePage> => {
    const assigned = `tab-${nextTabId}`;
    nextTabId += 1;
    page.register(assigned);
    tabs.set(assigned, page);
    return page;
  };

  const active = attach(makePage(PAGE_URL));
  attach(makePage(OTHER_URL));

  const session = {
    // `new_tab` is the one action that mints a page. Production registers it from the context's own
    // `page` event, which `ensure` wires and this stands in for.
    context: {
      newPage: async () => attach(makePage('about:blank')),
      // A fresh session per attach, because the defect is how many of them survive.
      newCDPSession: async () => {
        hooks.onAttachCdp?.();
        const minted = new FakeCdp();
        cdpSessions.push(minted);
        return minted;
      }
    },
    page: active,
    root: WORKSPACE_ROOT,
    tabs,
    nextTabId,
    // Production mints this in `ensure`, or adopts the desktop's when the browser is drawn on the
    // workspace's own X server. `subject` is what a refusal calls itself to the agent.
    control: new DesktopControl({ subject: 'Browser control' }),
    streamQueue: Promise.resolve(),
    walls: new BotWallLedger(),
    consoleMessages: [],
    failedRequests: [],
    streamTitle: '',
    downloadsDirectory: path.join('workspace', 'downloads', '2026-01-01'),
    downloads,
    pendingDownloads: new Set<Promise<void>>()
  };

  return {
    manager: new PerformManager(session as unknown as Session),
    session: session as unknown as HarnessSession,
    trace,
    elements,
    world,
    // The one in use, which is the last one attached; `cdpSessions` holds the whole history.
    get cdp() {
      return cdpSessions[cdpSessions.length - 1]!;
    },
    cdpSessions,
    hooks
  };
};

/**
 * Takes the browser the way the Computer pane's Take over button does.
 *
 * These cases used to assign to `session.holder`. There is no such field any more - the holder is
 * the control object the desktop shares - so they drive the shipped route instead, which is the
 * better test in any case. The handover lifts the keyboard and the mouse on its way through, and
 * that is asserted where it is the subject; everything else is measuring the action that follows.
 */
const hold = async (harness: Harness, holder: 'agent' | 'user' | 'secure_input'): Promise<void> => {
  await harness.manager.setHolder('workspace-1', WORKSPACE_ROOT, holder);
  harness.trace.length = 0;
};

const act = (
  harness: Harness,
  action: unknown,
  actor: 'agent' | 'user',
  consequentialApproved = false,
  root = WORKSPACE_ROOT
): Promise<ActResult> =>
  harness.manager.act(
    'workspace-1',
    root,
    BrowserAction.parse(action),
    actor,
    consequentialApproved
  );

/** `act` answers two shapes; these say which one a test is reading, rather than casting past it. */
type BatchResult = Extract<ActResult, { steps: unknown }>;
type StepResult = Exclude<ActResult, { steps: unknown }>;

const batchResult = (result: ActResult): BatchResult => {
  if (!('steps' in result)) throw new Error('expected a batch result');
  return result;
};
const stepResult = (result: ActResult): StepResult => {
  if ('steps' in result) throw new Error('expected a single-action result');
  return result;
};

/**
 * Every primitive the contract declares, driven through `act` with both actors.
 *
 * The trace is the assertion: an action performs the same page operation whichever side asked for
 * it, and the two actors differ only in which gates they pass on the way. That is the property the
 * owner's takeover rests on - it must not silently change what an action does, only who may ask.
 */
const SURFACE: Array<{
  name: string;
  action: Record<string, unknown>;
  /** Registered before the run, so a ref resolves and the classifier has something to read. */
  elements?: Record<string, FakeElement>;
  approved?: boolean;
  trace: string[];
}> = [
  {
    name: 'navigate',
    action: { type: 'navigate', url: OTHER_URL },
    trace: [`tab-1 goto ${OTHER_URL}`]
  },
  { name: 'click', action: { type: 'click', selector: REF }, trace: [`tab-1 click ${REF}`] },
  {
    name: 'double_click',
    action: { type: 'double_click', selector: REF },
    trace: [`tab-1 dblclick ${REF}`]
  },
  { name: 'hover', action: { type: 'hover', selector: REF }, trace: [`tab-1 hover ${REF}`] },
  {
    name: 'click_at',
    action: { type: 'click_at', x: 700, y: 400 },
    approved: true,
    trace: ['tab-1 mouse.click 700,400']
  },
  {
    // `auto` on a plain field is `fill`: one assignment, no keystrokes.
    name: 'type (auto, plain field)',
    action: { type: 'type', selector: REF, text: 'Ada Lovelace' },
    trace: [`tab-1 fill "Ada Lovelace" ${REF}`]
  },
  {
    // A combobox is the case `keys` exists for, and it clears the field before typing rather than
    // appending - the opposite of what `web-form-filling` §3 tells the model it does.
    name: 'type (auto, typeahead)',
    action: { type: 'type', selector: REF, text: 'Lond' },
    elements: { [REF]: { evaluate: { ...CONTROL, role: 'combobox' } } },
    trace: [`tab-1 fill "" ${REF}`, `tab-1 keys "Lond" ${REF}`]
  },
  {
    name: 'type (explicit keys)',
    action: { type: 'type', selector: REF, text: 'Ada', mode: 'keys' },
    trace: [`tab-1 fill "" ${REF}`, `tab-1 keys "Ada" ${REF}`]
  },
  {
    // fill() throws on a <select>, so the text is read as the option the agent means.
    name: 'type (select element)',
    action: { type: 'type', selector: REF, text: 'United Kingdom' },
    elements: { [REF]: { evaluate: { ...CONTROL, tag: 'select' } } },
    trace: [`tab-1 select ["United Kingdom"] ${REF}`]
  },
  {
    name: 'select_option',
    action: { type: 'select_option', selector: REF, values: ['gb'] },
    trace: [`tab-1 select ["gb"] ${REF}`]
  },
  { name: 'press', action: { type: 'press', key: 'Tab' }, trace: ['tab-1 keyboard.press Tab'] },
  {
    name: 'scroll (targeted)',
    action: { type: 'scroll', selector: REF, deltaY: 600 },
    trace: [`tab-1 hover ${REF}`, 'tab-1 mouse.wheel 0,600']
  },
  {
    // A wheel event lands under the pointer, which starts in the corner, so an untargeted scroll
    // parks it in the middle of the viewport first.
    name: 'scroll (untargeted)',
    action: { type: 'scroll', deltaY: -300 },
    trace: ['tab-1 mouse.move 720,450', 'tab-1 mouse.wheel 0,-300']
  },
  {
    name: 'wait_for (selector)',
    action: { type: 'wait_for', selector: REF, state: 'visible' },
    trace: [`tab-1 await-visible ${REF}`]
  },
  {
    name: 'wait_for (text)',
    action: { type: 'wait_for', text: 'Order placed' },
    trace: ['tab-1 await-visible text=Order placed']
  },
  {
    name: 'wait_for (urlIncludes)',
    action: { type: 'wait_for', urlIncludes: '/receipt' },
    trace: ['tab-1 waitForURL']
  },
  {
    // The doc's own protocol, and deliberately not `networkidle`: `load`, then a settle inside the
    // page. The old fallback burned its whole 15,000 ms and threw on a long-polling page.
    name: 'wait_for (bare)',
    action: { type: 'wait_for' },
    trace: ['tab-1 waitForLoadState load', 'tab-1 settle 500']
  },
  { name: 'back', action: { type: 'back' }, trace: ['tab-1 goBack'] },
  { name: 'reload', action: { type: 'reload' }, trace: ['tab-1 reload'] },
  { name: 'new_tab (background, no url)', action: { type: 'new_tab', activate: false }, trace: [] },
  {
    name: 'new_tab (activated, with url)',
    action: { type: 'new_tab', url: OTHER_URL },
    trace: [`tab-3 goto ${OTHER_URL}`]
  },
  {
    name: 'select_tab',
    action: { type: 'select_tab', tabId: 'tab-2' },
    trace: ['tab-2 bringToFront']
  },
  { name: 'close_tab', action: { type: 'close_tab', tabId: 'tab-2' }, trace: ['tab-2 close'] },
  {
    // A read, deliberately without bringing the tab forward: nothing the owner is watching moves.
    name: 'inspect_tab',
    action: { type: 'inspect_tab', tabId: 'tab-2' },
    trace: []
  },
  {
    name: 'dialog (dismiss)',
    action: { type: 'dialog', response: 'dismiss' },
    trace: ['dialog dismiss']
  }
];

describe('every browser action, performed', () => {
  for (const actor of ['agent', 'user'] as const) {
    for (const entry of SURFACE) {
      it(`performs ${entry.name} for the ${actor}`, async () => {
        const harness = buildHarness();
        await hold(harness, actor);
        for (const [selector, element] of Object.entries(entry.elements ?? {}))
          harness.elements.set(selector, element);
        harness.session.pendingDialog = {
          accept: async () => {
            harness.trace.push('dialog accept');
          },
          dismiss: async () => {
            harness.trace.push('dialog dismiss');
          }
        };
        const result = await act(harness, entry.action, actor, entry.approved ?? false);
        expect(harness.trace).toEqual(entry.trace);
        expect(result.url).toEqual(expect.any(String));
      });
    }
  }

  it('reports where a wait actually settled, so a batch step is legible afterwards', async () => {
    const harness = buildHarness();
    const result = stepResult(
      await act(harness, { type: 'wait_for', text: 'Order placed' }, 'agent')
    );
    expect(result).toMatchObject({ waited: 'text “Order placed” is visible', tabId: 'tab-1' });
  });

  it('waits on the page without asking the network to go quiet, and does not throw when it does not settle', async () => {
    /*
     * The bare `wait_for` used to be `waitForLoadState('networkidle')`, which
     * `docs/design/browser-automation.md` bans by name at :302 and :526. Measured against a real
     * Chromium on a page holding one unanswered request: `networkidle` took 15,004 ms and threw,
     * where `load` plus a 500 ms in-page settle took 504 ms on the same page.
     */
    const harness = buildHarness();
    const settled = stepResult(await act(harness, { type: 'wait_for' }, 'agent'));
    expect(settled.waited).toBe('page finished loading and settled');
    expect(harness.trace).toEqual(['tab-1 waitForLoadState load', 'tab-1 settle 500']);

    // And when the page never finishes: no throw, and a report that says which of the two things
    // happened rather than claiming the page settled.
    const stuck = buildHarness();
    stuck.world.loadFails = true;
    const late = stepResult(await act(stuck, { type: 'wait_for' }, 'agent'));
    expect(late.waited).toMatch(/had not finished loading/);
  });

  it('lets the steps after a bare wait run, which a thrown wait used to take with it', async () => {
    // A thrown step ends the batch, so one badly-advised wait cost fifteen seconds AND the rest of
    // the form fill. This is the half of item 2 that is worth more than the fifteen seconds.
    const harness = buildHarness();
    harness.world.loadFails = true;
    const result = batchResult(
      await act(
        harness,
        {
          type: 'batch',
          actions: [
            { type: 'wait_for' },
            { type: 'type', selector: REF, text: 'Ada' },
            { type: 'press', key: 'Tab' }
          ]
        },
        'agent'
      )
    );
    expect(result.completed).toBe(3);
    expect(result.steps.map((step) => step.ok)).toEqual([true, true, true]);
    expect(harness.trace).toEqual([
      'tab-1 waitForLoadState load',
      'tab-1 settle 500',
      `tab-1 fill "Ada" ${REF}`,
      'tab-1 keyboard.press Tab'
    ]);
  });

  it('says how many controls the budget cut, rather than handing over a short list as a complete one', async () => {
    // The elements that go are the ones at the END of the document, which is where consent,
    // payment and submit frames live - so a truncated list read as complete is how the model
    // concludes a control does not exist. `desktop_observe` has said this since it started
    // selecting nodes; this is the same number on the browser surface.
    const harness = buildHarness();
    // A long main frame with a consent iframe after it: 306 controls, a budget of 250.
    harness.world.scan = {
      elements: Array.from({ length: 250 }, (_, index) => ({
        ...RAW_ELEMENT,
        ref: `oc-0-${index}`
      })),
      matched: 306
    };
    harness.world.extraFrames = 4;
    const result = await harness.manager.readElements('workspace-1', WORKSPACE_ROOT, {}, 'agent');
    expect(result.elements).toHaveLength(250);
    expect(result.elementsOmitted).toBe(56);
    // The budget ran out inside the main frame, so every iframe after it went unread - and it is
    // the LAST frames that go, which is exactly where a consent or payment frame sits.
    expect(result.framesOmitted).toBe(4);
  });

  it('counts the frames past the frame limit as well as the ones the budget never reached', () => {
    // Two different ways a frame goes unread, and the model needs the same answer for both.
    const cap = buildHarness();
    cap.world.extraFrames = 14;
    return cap.manager.readElements('workspace-1', WORKSPACE_ROOT, {}, 'agent').then((result) => {
      // 15 frames, 12 scanned: SNAPSHOT_FRAME_LIMIT is the bound, and it is not silent.
      expect(result.framesOmitted).toBe(3);
      expect(result.elementsOmitted).toBe(0);
    });
  });

  it('reports zero omitted when the whole page fitted, so the count means something when it is not zero', async () => {
    const harness = buildHarness();
    const result = await harness.manager.readElements('workspace-1', WORKSPACE_ROOT, {}, 'agent');
    expect(result.elements).toHaveLength(1);
    expect(result.elementsOmitted).toBe(0);
  });

  it('reads a background tab in place, and answers with its elements rather than the active tab’s', async () => {
    const harness = buildHarness();
    const result = stepResult(await act(harness, { type: 'inspect_tab', tabId: 'tab-2' }, 'agent'));
    expect(result.url).toBe(OTHER_URL);
    expect(result.tabId).toBe('tab-2');
    expect(result.elements).toEqual([
      expect.objectContaining({
        index: 0,
        selector: '[data-athanor-ref="oc-0-1"]',
        name: 'Full name'
      })
    ]);
    expect(result.text).toBe('Total 42.00');
    // A background tab's list is cut by the same budget, so it says the same thing about itself.
    expect(result.elementsOmitted).toBe(0);
    expect(result.framesOmitted).toBe(0);
    // Reading a tab must not activate it: nothing was brought to the front.
    expect(harness.trace).toEqual([]);
  });

  it('answers a page dialog and forgets it, so the next action is not judged against a stale one', async () => {
    const harness = buildHarness();
    const answered: string[] = [];
    harness.session.pendingDialog = {
      accept: async (text?: string) => {
        answered.push(`accept ${text ?? ''}`);
      },
      dismiss: async () => {
        answered.push('dismiss');
      }
    };
    await act(harness, { type: 'dialog', response: 'accept' }, 'agent', true);
    expect(answered).toEqual(['accept ']);
    expect(harness.session.pendingDialog).toBe(undefined);
    await expect(act(harness, { type: 'dialog', response: 'dismiss' }, 'agent')).rejects.toThrow(
      /No page dialog is waiting/
    );
  });

  /**
   * Text typed into a `prompt()` is text typed at a keyboard, and it is classified as private for
   * the same reason `text_input` is: the harness cannot see what the page is asking for. The agent
   * is therefore refused and the dialog is left standing for whoever takes over.
   */
  it('hands a prompt dialog carrying text to the owner, with the dialog still waiting', async () => {
    const harness = buildHarness();
    const answered: string[] = [];
    harness.session.pendingDialog = {
      accept: async (text?: string) => {
        answered.push(`accept ${text ?? ''}`);
      },
      dismiss: async () => {
        answered.push('dismiss');
      }
    };
    await expect(
      act(harness, { type: 'dialog', response: 'accept', promptText: 'Ada' }, 'agent', true)
    ).rejects.toThrow(/Secure input takeover is required/);
    expect(answered).toEqual([]);
    expect(harness.session.pendingDialog).not.toBe(undefined);

    await hold(harness, 'user');
    await act(harness, { type: 'dialog', response: 'accept', promptText: 'Ada' }, 'user');
    expect(answered).toEqual(['accept Ada']);
  });

  it('refuses to close the last tab rather than leaving the session with no page', async () => {
    const harness = buildHarness();
    await act(harness, { type: 'close_tab', tabId: 'tab-2' }, 'agent');
    await expect(act(harness, { type: 'close_tab', tabId: 'tab-1' }, 'agent')).rejects.toThrow(
      /final browser tab cannot be closed/
    );
  });

  it('refuses a tab id whose page has gone, rather than acting on whatever shifted into its place', async () => {
    const harness = buildHarness();
    await act(harness, { type: 'close_tab', tabId: 'tab-2' }, 'agent');
    await expect(
      act(harness, { type: 'click', selector: REF, tabId: 'tab-2' }, 'agent')
    ).rejects.toThrow(/Browser tab tab-2 is no longer open/);
  });

  it('refuses a ref that no longer names one control, on the performing path as well as the classifying one', async () => {
    const harness = buildHarness();
    await hold(harness, 'user');
    harness.elements.set(REF, { count: 0 });
    await expect(act(harness, { type: 'hover', selector: REF }, 'user')).rejects.toThrow(
      /no longer on the page/
    );
    harness.elements.set(REF, { count: 2 });
    await expect(act(harness, { type: 'hover', selector: REF }, 'user')).rejects.toThrow(
      /no longer names one control/
    );
  });
});

describe('uploading a workspace file', () => {
  const roots: string[] = [];
  const workspace = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-upload-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'invoice.pdf'), 'invoice bytes');
    return root;
  };
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it('attaches a runner-owned copy to a real file input', async () => {
    const root = await workspace();
    const harness = buildHarness();
    harness.elements.set(REF, { evaluate: true });
    await act(
      harness,
      { type: 'upload', selector: REF, paths: ['workspace/invoice.pdf'] },
      'agent',
      true,
      root
    );
    expect(harness.trace).toEqual([`tab-1 attach ["invoice.pdf"] ${REF}`]);
  });

  it('opens the chooser when the real input is hidden behind a styled button', async () => {
    const root = await workspace();
    const harness = buildHarness();
    await hold(harness, 'user');
    harness.elements.set(REF, { evaluate: false });
    await act(
      harness,
      { type: 'upload', selector: REF, paths: ['workspace/invoice.pdf'] },
      'user',
      false,
      root
    );
    expect(harness.trace).toEqual([
      'tab-1 waitForEvent filechooser',
      `tab-1 click ${REF}`,
      'tab-1 chooser 1'
    ]);
  });

  it('refuses a path outside the user data boundary, so upload is not a host-filesystem read', async () => {
    const root = await workspace();
    const harness = buildHarness();
    await hold(harness, 'user');
    harness.elements.set(REF, { evaluate: true });
    await expect(
      act(
        harness,
        { type: 'upload', selector: REF, paths: ['../../etc/passwd'] },
        'user',
        false,
        root
      )
    ).rejects.toThrow();
    expect(harness.trace).toEqual([]);
  });
});

/**
 * A screenshot the agent can keep: the page as the browser is showing it, written as a PNG to a
 * workspace path. Measured before this existed: 23 of 25 tool calls in one live task went on
 * discovering that no browser tool wrote a picture to disk, two of them full-filesystem finds. The
 * bytes travel through the file API's own boundary and size limit, as a printed PDF's do, so the
 * browser is never handed a name to open for itself.
 */
describe('saving a screenshot to the workspace', () => {
  const roots: string[] = [];
  const workspace = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-screenshot-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    return root;
  };
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it('writes the page as a PNG at the path asked for, creating its folder', async () => {
    const root = await workspace();
    const harness = buildHarness();
    const result = stepResult(
      await act(
        harness,
        { type: 'screenshot', path: 'workspace/proofs/checkout.png' },
        'agent',
        false,
        root
      )
    );
    expect(harness.trace).toEqual(['tab-1 screenshot png']);
    expect(result.path).toBe(path.join('workspace', 'proofs', 'checkout.png'));
    expect(await readFile(path.join(root, 'workspace', 'proofs', 'checkout.png'), 'utf8')).toBe(
      'png-bytes'
    );
  });

  it('reads a bare name from workspace/, and a named tab in place', async () => {
    const root = await workspace();
    const harness = buildHarness();
    const result = stepResult(
      await act(
        harness,
        { type: 'screenshot', path: 'receipt.png', tabId: 'tab-2' },
        'agent',
        false,
        root
      )
    );
    expect(harness.trace).toEqual(['tab-2 screenshot png']);
    expect(result.tabId).toBe('tab-2');
    expect(result.url).toBe(OTHER_URL);
    expect(await readFile(path.join(root, 'workspace', 'receipt.png'), 'utf8')).toBe('png-bytes');
  });

  it('refuses a path outside the user data boundary before the picture is taken', async () => {
    const root = await workspace();
    const harness = buildHarness();
    await expect(
      act(harness, { type: 'screenshot', path: '../../etc/cron.d/job.png' }, 'agent', false, root)
    ).rejects.toThrow('escapes workspace');
    await expect(
      act(harness, { type: 'screenshot', path: '.athanor/browser/state.png' }, 'agent', false, root)
    ).rejects.toThrow('Only workspace files');
    expect(harness.trace).toEqual([]);
  });

  it('refuses the agent a picture of a page that is not on the public internet', async () => {
    const root = await workspace();
    const harness = buildHarness();
    harness.session.page.url = () => LOOPBACK_URL;
    await expect(
      act(harness, { type: 'screenshot', path: 'admin.png' }, 'agent', false, root)
    ).rejects.toThrow('not an address on the public internet');
    expect(harness.trace).toEqual([]);
  });
});

describe('the gates an agent action passes and a takeover does not', () => {
  it('refuses the agent while the owner holds the browser, and lets the owner in during secure input', async () => {
    const harness = buildHarness();
    await hold(harness, 'user');
    await expect(act(harness, { type: 'reload' }, 'agent')).rejects.toThrow(
      /Browser control is held by user/
    );
    await hold(harness, 'secure_input');
    await act(harness, { type: 'reload' }, 'user');
    expect(harness.trace).toEqual(['tab-1 reload']);
  });

  it.each([false, true])(
    'requires private-input takeover even with consequential authority %s',
    async (authorized) => {
      const harness = buildHarness();
      await expect(
        act(harness, { type: 'text_input', text: 'hunter2' }, 'agent', authorized)
      ).rejects.toThrow(/Secure input takeover is required/);
      expect(harness.trace).toEqual([]);
      await hold(harness, 'user');
      await act(harness, { type: 'text_input', text: 'hunter2' }, 'user');
      expect(harness.trace).toEqual(['tab-1 keyboard.insertText "hunter2"']);
    }
  );

  it('stops a consequential click without the approval capability, and runs it with one', async () => {
    const harness = buildHarness();
    harness.elements.set(SUBMIT_REF, { evaluate: SUBMIT_CONTROL });
    await expect(act(harness, { type: 'click', selector: SUBMIT_REF }, 'agent')).rejects.toThrow(
      /consequential-action approval capability is required/
    );
    expect(harness.trace).toEqual([]);
    await act(harness, { type: 'click', selector: SUBMIT_REF }, 'agent', true);
    expect(harness.trace).toEqual([`tab-1 click ${SUBMIT_REF}`]);
  });
  it('reports the upload control document and form destination instead of guessing from the active tab', async () => {
    const harness = buildHarness();
    harness.elements.set(REF, {
      evaluate: {
        ...CONTROL,
        type: 'file',
        pageUrl: 'https://uploads.example.invalid:8443/form?token=private',
        formAction: 'https://receiver.example.invalid/application'
      }
    });
    const result = await harness.manager.preflight(
      'workspace',
      WORKSPACE_ROOT,
      { type: 'upload', selector: REF, paths: ['workspace/cv.pdf'] },
      'agent'
    );
    expect(result.consequential).toBe(true);
    expect(result.destinations).toEqual([
      'https://uploads.example.invalid:8443',
      'https://receiver.example.invalid'
    ]);
    expect(result.preview).toContain('Website: https://uploads.example.invalid:8443');
    expect(result.preview).not.toContain('token=private');
    expect(harness.trace).toEqual([]);
  });

  it('never judges the owner’s own action, so the same submit needs no capability from them', async () => {
    const harness = buildHarness();
    await hold(harness, 'user');
    harness.elements.set(SUBMIT_REF, { evaluate: SUBMIT_CONTROL });
    await act(harness, { type: 'click', selector: SUBMIT_REF }, 'user');
    expect(harness.trace).toEqual([`tab-1 click ${SUBMIT_REF}`]);
  });

  it('refuses to drive the agent at an address that is not on the public internet', async () => {
    const harness = buildHarness();
    await expect(act(harness, { type: 'navigate', url: LOOPBACK_URL }, 'agent')).rejects.toThrow(
      /only driven to addresses on the public internet/
    );
    expect(harness.trace).toEqual([]);
    // The same list covers the second door: a fresh tab pointed at the same address.
    await expect(act(harness, { type: 'new_tab', url: LOOPBACK_URL }, 'agent')).rejects.toThrow(
      /only driven to addresses on the public internet/
    );
    expect(harness.trace).toEqual([]);
  });

  it('refuses a navigation whose redirect chain lands somewhere the agent may not read', async () => {
    const harness = buildHarness();
    harness.world.landsOn = LOOPBACK_URL;
    await expect(act(harness, { type: 'navigate', url: OTHER_URL }, 'agent')).rejects.toThrow(
      /only driven to addresses on the public internet/
    );
    // Refused after the navigation, because that is the only place the landing address is known.
    expect(harness.trace).toEqual([`tab-1 goto ${OTHER_URL}`]);
  });

  it('refuses a navigation the browser answered from a private address', async () => {
    const harness = buildHarness();
    harness.world.serverIp = '169.254.169.254';
    await expect(act(harness, { type: 'navigate', url: OTHER_URL }, 'agent')).rejects.toThrow(
      /which is not an address on the public internet/
    );
  });

  it('lets the owner reach their own router, which is not the threat the address policy is for', async () => {
    const harness = buildHarness();
    await hold(harness, 'user');
    harness.world.serverIp = '192.168.1.1';
    await act(harness, { type: 'navigate', url: LOOPBACK_URL }, 'user');
    expect(harness.trace).toEqual([`tab-1 goto ${LOOPBACK_URL}`]);
  });

  it('raises a challenge as data when one is on the page the agent landed on', async () => {
    const harness = buildHarness();
    harness.world.title = 'Just a moment…';
    await expect(act(harness, { type: 'reload' }, 'agent')).rejects.toThrow(/Just a moment/);
    expect(harness.session.walls.standing('tab-1')).toMatchObject({
      tabId: 'tab-1',
      evidence: 'page'
    });
  });

  it.each([false, true])(
    'requires CAPTCHA takeover even with consequential authority %s',
    async (authorized) => {
      const harness = buildHarness();
      harness.session.walls.raise('tab-1', {
        vendor: 'Cloudflare',
        url: PAGE_URL,
        reason: 'response carried cf-mitigated',
        evidence: 'response'
      });
      await expect(
        act(harness, { type: 'click', selector: REF }, 'agent', authorized)
      ).rejects.toThrow(/Cloudflare/);
      expect(harness.trace).toEqual([]);
      await hold(harness, 'user');
      await act(harness, { type: 'click', selector: REF }, 'user');
      expect(harness.trace).toEqual([`tab-1 click ${REF}`]);
    }
  );

  it('refuses the same site from a fresh tab, which is the retry the challenge is asking for', async () => {
    const harness = buildHarness();
    harness.session.walls.raise('tab-1', {
      vendor: 'DataDome',
      url: OTHER_URL,
      reason: 'response carried x-datadome',
      evidence: 'response'
    });
    await expect(act(harness, { type: 'new_tab', url: OTHER_URL }, 'agent')).rejects.toThrow(
      /DataDome/
    );
    expect(harness.trace).toEqual([]);
  });
});

it('records intent before each page operation and acknowledgement after it', async () => {
  const harness = buildHarness();
  await hold(harness, 'agent');
  const progress = {
    begin: (index: number, type: string) => {
      harness.trace.push(`intent ${index} ${type}`);
    },
    complete: (index: number) => {
      harness.trace.push(`ack ${index}`);
    }
  };
  await harness.manager.act(
    'workspace-1',
    WORKSPACE_ROOT,
    { type: 'batch', actions: [{ type: 'reload' }, { type: 'press', key: 'Tab' }] },
    'agent',
    true,
    'task',
    progress
  );
  expect(harness.trace).toEqual([
    'intent 0 reload',
    'tab-1 reload',
    'ack 0',
    'intent 1 press',
    'tab-1 keyboard.press Tab',
    'ack 1'
  ]);
  harness.trace.length = 0;
  await expect(
    harness.manager.act('workspace-1', WORKSPACE_ROOT, { type: 'reload' }, 'agent', true, 'task', {
      ...progress,
      begin: () => {
        throw new Error('receipt disk unavailable');
      }
    })
  ).rejects.toThrow('receipt disk unavailable');
  expect(harness.trace).toEqual([]);
});

describe('what a batch reports', () => {
  it('runs an authorized form batch but still stops when a later step needs private input', async () => {
    const harness = buildHarness();
    harness.elements.set(SUBMIT_REF, { evaluate: SUBMIT_CONTROL });
    const result = batchResult(
      await act(
        harness,
        {
          type: 'batch',
          actions: [
            { type: 'type', selector: REF, text: 'Ada' },
            { type: 'click', selector: SUBMIT_REF },
            { type: 'text_input', text: 'private' },
            { type: 'press', key: 'Enter' }
          ]
        },
        'agent',
        true
      )
    );
    expect(result.completed).toBe(2);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[2]?.ok).toBe(false);
    expect(result.steps[2]?.error).toContain('Secure input takeover');
    expect(harness.trace).toEqual([`tab-1 fill "Ada" ${REF}`, `tab-1 click ${SUBMIT_REF}`]);
  });

  it('runs its steps in order and reports each one', async () => {
    const harness = buildHarness();
    const result = batchResult(
      await act(
        harness,
        {
          type: 'batch',
          actions: [
            { type: 'type', selector: REF, text: 'Ada' },
            { type: 'select_option', selector: REF, values: ['gb'] },
            { type: 'press', key: 'Tab' }
          ]
        },
        'agent'
      )
    );
    expect(result.completed).toBe(3);
    expect(result.steps.map((step) => [step.index, step.type, step.ok])).toEqual([
      [0, 'type', true],
      [1, 'select_option', true],
      [2, 'press', true]
    ]);
    expect(harness.trace).toEqual([
      `tab-1 fill "Ada" ${REF}`,
      `tab-1 select ["gb"] ${REF}`,
      'tab-1 keyboard.press Tab'
    ]);
  });

  it('stops at the first failure, because the steps after it were written against a page that never happened', async () => {
    const harness = buildHarness();
    harness.elements.set(SUBMIT_REF, { fails: 'element is not visible' });
    const result = batchResult(
      await act(
        harness,
        {
          type: 'batch',
          actions: [
            { type: 'type', selector: REF, text: 'Ada' },
            { type: 'click', selector: SUBMIT_REF },
            { type: 'press', key: 'Tab' }
          ]
        },
        'agent',
        true
      )
    );
    expect(result.completed).toBe(1);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]).toMatchObject({ index: 1, ok: false, error: 'element is not visible' });
    expect(harness.trace).toEqual([`tab-1 fill "Ada" ${REF}`, `tab-1 click ${SUBMIT_REF}`]);
  });

  it('judges every step on its own, so a submit cannot ride through inside a batch', async () => {
    const harness = buildHarness();
    harness.elements.set(SUBMIT_REF, { evaluate: SUBMIT_CONTROL });
    const result = batchResult(
      await act(
        harness,
        {
          type: 'batch',
          actions: [
            { type: 'type', selector: REF, text: 'Ada' },
            { type: 'click', selector: SUBMIT_REF }
          ]
        },
        'agent'
      )
    );
    expect(result.completed).toBe(1);
    expect(result.steps[1]?.error).toMatch(/batch step 2, click/);
    expect(harness.trace).toEqual([`tab-1 fill "Ada" ${REF}`]);
  });

  it('lets the owner run the whole batch without a capability, and without the address checks', async () => {
    const harness = buildHarness();
    await hold(harness, 'user');
    harness.elements.set(SUBMIT_REF, { evaluate: SUBMIT_CONTROL });
    const result = batchResult(
      await act(
        harness,
        {
          type: 'batch',
          actions: [
            { type: 'navigate', url: LOOPBACK_URL },
            { type: 'click', selector: SUBMIT_REF }
          ]
        },
        'user'
      )
    );
    expect(result.completed).toBe(2);
  });
});

describe('downloads a step starts', () => {
  it('reports the file the click saved, by the path the file browser names it by', async () => {
    const harness = buildHarness();
    harness.elements.set(REF, { downloadUrl: 'https://93.184.216.34/invoice.pdf' });
    const result = await act(harness, { type: 'click', selector: REF }, 'agent');
    expect(result.downloads).toEqual([
      {
        path: 'workspace/downloads/2026-01-01/invoice.pdf',
        url: 'https://93.184.216.34/invoice.pdf'
      }
    ]);
  });

  it('reports nothing for a step that saved nothing', async () => {
    const harness = buildHarness();
    const result = await act(harness, { type: 'click', selector: REF }, 'agent');
    expect(result.downloads).toEqual([]);
  });

  it('reports every file a batch saved, at the end, once', async () => {
    const harness = buildHarness();
    harness.elements.set(REF, { downloadUrl: 'https://93.184.216.34/a.pdf' });
    harness.elements.set(SUBMIT_REF, { downloadUrl: 'https://93.184.216.34/b.pdf' });
    const result = await act(
      harness,
      {
        type: 'batch',
        actions: [
          { type: 'click', selector: REF },
          { type: 'click', selector: SUBMIT_REF }
        ]
      },
      'agent'
    );
    expect(result.downloads.map((record) => record.url)).toEqual([
      'https://93.184.216.34/a.pdf',
      'https://93.184.216.34/b.pdf'
    ]);
  });

  it('reports new files when recent download history is full', async () => {
    const harness = buildHarness();
    for (let index = 0; index < 25; index += 1) {
      harness.session.downloads.record({
        path: `workspace/downloads/old-${index}.pdf`,
        url: `https://93.184.216.34/old-${index}.pdf`
      });
    }
    harness.elements.set(REF, { downloadUrl: 'https://93.184.216.34/new.pdf' });
    const result = await act(harness, { type: 'click', selector: REF }, 'agent');
    expect(result.downloads.map((record) => record.url)).toEqual(['https://93.184.216.34/new.pdf']);
    expect(harness.session.downloads.recent).toHaveLength(25);
  });
});

describe('waiting for something to go away', () => {
  it.each(['detached', 'hidden'] as const)(
    'succeeds when a generated ref is already absent for %s',
    async (state) => {
      const harness = buildHarness();
      harness.elements.set(REF, { count: 0 });
      const result = stepResult(
        await act(harness, { type: 'wait_for', selector: REF, state, timeoutMs: 100 }, 'agent')
      );
      expect(result.waited).toBe(`${REF} is ${state}`);
      expect(harness.trace).toEqual([`tab-1 await-${state} ${REF}`]);
    }
  );

  it.each(['attached', 'visible'] as const)(
    'still rejects a missing generated ref for %s',
    async (state) => {
      const harness = buildHarness();
      harness.elements.set(REF, { count: 0 });
      await expect(
        act(harness, { type: 'wait_for', selector: REF, state, timeoutMs: 100 }, 'agent')
      ).rejects.toThrow('no longer on the page');
      expect(harness.trace).toEqual([]);
    }
  );

  it.each(['detached', 'hidden'] as const)(
    'still rejects an ambiguous generated ref for %s',
    async (state) => {
      const harness = buildHarness();
      harness.elements.set(REF, { count: 2 });
      await expect(
        act(harness, { type: 'wait_for', selector: REF, state, timeoutMs: 100 }, 'agent')
      ).rejects.toThrow('matches 2 elements');
      expect(harness.trace).toEqual([]);
    }
  );
});

/**
 * What the Browser pane is told, and what telling it costs.
 *
 * Two defects meet on this path. The stream state was rebuilt per frame with an awaited
 * `page.title()` inside it - a CDP round trip to the page's own main thread - and the frame ack
 * sat behind it in a `finally`; Chromium sends no further screencast frame until the previous one
 * is acked, so the achievable frame rate was one round trip to a page that may be busy, and a page
 * with a blocked main thread froze the pane outright with the socket still healthy. Separately,
 * `session.pendingDialog` - which suppresses Playwright's auto-dismiss and therefore *blocks the
 * page* until something answers it - reached no client at all, so an owner who had taken the
 * browser over clicked something raising `confirm()` and the page simply stopped, with no native
 * dialog (Playwright intercepted it) and nothing on the stream to say why.
 */
describe('what rides on the browser stream', () => {
  const subscribe = async (harness: Harness) => {
    const states: BrowserStreamState[] = [];
    const frames: Buffer[] = [];
    const stop = await harness.manager.subscribeStream('workspace-1', WORKSPACE_ROOT, {
      state: (state) => {
        states.push(state);
      },
      frame: (frame) => {
        frames.push(frame);
      }
    });
    return { states, frames, stop };
  };

  it('acks a screencast frame before publishing it, and never asks the page its title to do so', async () => {
    const harness = buildHarness();
    const { states, frames } = await subscribe(harness);
    expect(states).toHaveLength(1);
    const titleReadsAfterJoin = harness.world.titleReads;

    for (let index = 0; index < 5; index += 1) harness.cdp.deliver();

    expect(frames).toHaveLength(5);
    // Five frames, five acks, and not one extra question put to the page.
    expect(harness.cdp.sent.filter((call) => call === 'Page.screencastFrameAck')).toHaveLength(5);
    expect(harness.world.titleReads).toBe(titleReadsAfterJoin);
    // The ack is sent before anything else happens with the frame, so the next one is already on
    // its way while this one is being written to the socket.
    expect(harness.cdp.sent[0]).toBe('Page.startScreencast');
    expect(harness.cdp.sent[1]).toBe('Page.screencastFrameAck');
  });

  it('carries the dialog blocking the page, and clears it when the owner answers', async () => {
    const harness = buildHarness();
    let answered = '';
    // Exactly what `ensure`'s `page.on('dialog')` listener parks on the session: Playwright's own
    // dialog handle, unanswered, with the page stopped behind it.
    harness.session.pendingDialog = {
      type: () => 'confirm',
      message: () => 'Delete every file in this folder?',
      accept: async () => {
        answered = 'accept';
      },
      dismiss: async () => {
        answered = 'dismiss';
      }
    };
    await hold(harness, 'user');
    const { states } = await subscribe(harness);
    expect(states.at(-1)).toMatchObject({
      pendingDialog: { type: 'confirm', message: 'Delete every file in this folder?' }
    });

    await act(harness, { type: 'dialog', response: 'dismiss' }, 'user');
    expect(answered).toBe('dismiss');
    // The pane has to learn the page is running again, or the banner stays up over a live page.
    expect(states.at(-1)?.pendingDialog).toBeNull();
    expect(harness.session.pendingDialog).toBeUndefined();
  });

  it('refreshes the title the pane shows when the page it is watching navigates', async () => {
    const harness = buildHarness();
    const { states } = await subscribe(harness);
    expect(states.at(-1)).toMatchObject({ title: 'Checkout', url: PAGE_URL });

    harness.world.title = 'Receipt';
    await act(harness, { type: 'navigate', url: OTHER_URL }, 'agent');
    expect(states.at(-1)).toMatchObject({ title: 'Receipt', url: OTHER_URL });
  });
});

/**
 * One screen, one holder, and what a handover has to do to the machine on its way through.
 *
 * The browser and the desktop were two surfaces onto the same X server with two takeovers between
 * them: the browser kept a `holder` field, the desktop kept a `DesktopControl`, and neither knew
 * about the other. Three things follow from putting them on one object, and each is a case here -
 * the handover lifts what this surface was holding down, an action already in flight ends when the
 * screen changes hands, and the screencast's lifecycle stops racing itself.
 */
describe('handing the browser over', () => {
  const subscribe = async (harness: Harness) => {
    const states: BrowserStreamState[] = [];
    return {
      states,
      stop: await harness.manager.subscribeStream('workspace-1', WORKSPACE_ROOT, {
        state: (state) => {
          states.push(state);
        },
        frame: () => undefined
      })
    };
  };

  it('lifts every modifier and mouse button the page was holding down', async () => {
    const harness = buildHarness();
    await harness.manager.setHolder('workspace-1', WORKSPACE_ROOT, 'user');
    // Chromium latches these per page: an agent interrupted mid-chord, or a drag that threw
    // between `mouse.down` and `mouse.up`, hands the owner a screen where every later keystroke is
    // silently a chord and the next click finishes a selection they never started. The desktop
    // lifted its own on every handover (`releaseAllInputCommand`); the browser lifted nothing.
    expect(harness.trace).toEqual([
      'tab-1 keyboard.up Control',
      'tab-1 keyboard.up Shift',
      'tab-1 keyboard.up Alt',
      'tab-1 keyboard.up Meta',
      'tab-1 mouse.up left',
      'tab-1 mouse.up middle',
      'tab-1 mouse.up right'
    ]);
  });

  it('ends a long type the moment the owner takes the browser, instead of typing on', async () => {
    const harness = buildHarness();
    harness.elements.set(REF, { stalls: true });
    const text = 'a-very-long-string-being-entered-one-key-at-a-time';
    const typing = act(harness, { type: 'type', selector: REF, text, mode: 'keys' }, 'agent');
    // Started, and still going: `pressSequentially` has been entered and has not come back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.trace).toEqual([
      `tab-1 fill "" ${REF}`,
      `tab-1 keys ${JSON.stringify(text)} ${REF}`
    ]);

    const takeover = harness.manager.setHolder('workspace-1', WORKSPACE_ROOT, 'user');
    await expect(typing).rejects.toThrow(/taken over/);
    await takeover;
    expect(harness.session.control.holder).toBe('user');
    // And the agent is out: the next call is refused rather than queued behind the owner.
    await expect(act(harness, { type: 'reload' }, 'agent')).rejects.toThrow(
      /Browser control is held by user/
    );
  }, 10_000);

  it('keeps exactly one screencast attached when a subscriber joins during a tab switch', async () => {
    const harness = buildHarness();
    const attached = () => harness.cdpSessions.filter((session) => session.attached);
    const first = await subscribe(harness);
    expect(attached()).toHaveLength(1);

    // The two callers that reach the screencast's lifecycle, overlapped at the one point where it
    // matters. A tab switch stops the old CDP session, detaches it and stands a new one up; while
    // it waits for the replacement `session.stream` is unset, so a subscriber arriving in that gap
    // sees a browser with no stream and attaches one of its own. Whichever assignment landed
    // second won, and the other went on acking screencast frames for the life of the browser with
    // nothing reading them - and Chromium sends no further frame until the previous one is acked,
    // so a stray session is not a leak but a second consumer of the same frame budget.
    let joining: ReturnType<typeof subscribe> | undefined;
    harness.hooks.onAttachCdp = () => {
      joining ??= subscribe(harness);
    };

    await act(harness, { type: 'select_tab', tabId: 'tab-2' }, 'agent');
    const second = await joining!;
    harness.hooks.onAttachCdp = null;

    expect(harness.cdpSessions.length).toBeGreaterThan(1);
    expect(attached()).toHaveLength(1);
    // And the survivor is the live one: it is what the pane is being fed from, and it is what both
    // subscribers hold, so letting go of it is enough to close it.
    harness.cdp.deliver();
    await first.stop();
    await second.stop();
    expect(attached()).toHaveLength(0);
  });
});
