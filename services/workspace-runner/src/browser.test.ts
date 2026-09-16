import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import type { RawSearchRow } from './search.js';
import {
  BOT_WALL_HOST_COOLDOWN_MS,
  BROWSER_SNAPSHOT_TEXT_LIMIT,
  BROWSER_VIEWPORT,
  BotWallLedger,
  BrowserManager,
  HEADLESS_DEVICE_ARGUMENTS,
  agentReachablePage,
  assertAgentReachableUrl,
  botWallMessage,
  reviewBotWall,
  searchWallMessage,
  stepDestinations,
  type BotWall,
  browserLaunchLadder,
  browserLaunchEnvironment,
  launchSandboxedResearchBrowser,
  browserLaunchOptions,
  classifyBrowserAction,
  combineBatchPreflight,
  composeBrowserSnapshot,
  describeScannedElement,
  detectBotWall,
  downloadFileName,
  foldScannedElements,
  needsScriptedRender,
  recordFailedRequest,
  researchResourceAllowed,
  sessionTabs,
  refFrameOrdinal,
  resolveBrowserTarget,
  shouldAdoptNewPage,
  typeStrategy,
  type RawScannedElement
} from './browser.js';

const ordinaryElement = {
  tag: 'a',
  type: '',
  name: 'Read documentation',
  autocomplete: '',
  formAction: '',
  inForm: false
};

describe('browser action policy', () => {
  it('requires broker-side approval for actual form submission targets', () => {
    expect(
      classifyBrowserAction(
        { type: 'click', selector: '[data-athanor-ref="oc-4"]' },
        {
          tag: 'button',
          type: 'submit',
          name: 'Continue',
          autocomplete: '',
          formAction: 'https://jobs.example.invalid/apply',
          inForm: true
        }
      )
    ).toMatchObject({ consequential: true, sensitiveInput: false });
  });

  it('routes passwords and direct keyboard text through secure user takeover', () => {
    expect(
      classifyBrowserAction(
        { type: 'type', selector: '#password', text: 'never-send-this', mode: 'auto' },
        {
          tag: 'input',
          type: 'password',
          name: 'Password',
          autocomplete: 'current-password',
          formAction: '',
          inForm: true
        }
      )
    ).toMatchObject({ consequential: false, sensitiveInput: true });
    expect(classifyBrowserAction({ type: 'text_input', text: 'private' })).toMatchObject({
      sensitiveInput: true
    });
  });

  it('allows ordinary navigation targets without approval', () => {
    expect(
      classifyBrowserAction(
        { type: 'click', selector: '[data-athanor-ref="oc-1"]' },
        ordinaryElement
      )
    ).toMatchObject({ consequential: false, sensitiveInput: false });
  });

  /*
   * The three mode sentences promised "agreeing to something on your behalf" and this classifier
   * held `sign`, `accept offer`, `submit` and `confirm`. Driven at cd7033f, a control reading
   * "Accept the Terms" was `consequential: false` - the promise was kept for a control named
   * "Delete" and broken for the one act the owner is named on afterwards.
   */
  it('gates a control that accepts terms, a licence or an agreement in the owner’s name', () => {
    const banner = (name: string) => ({
      tag: 'button',
      type: 'button',
      name,
      autocomplete: '',
      formAction: '',
      inForm: false
    });
    for (const name of [
      'Accept the Terms',
      'I agree to the Terms of Service',
      'Accept Terms and Conditions',
      'Accept the licence',
      'Accept the End User License Agreement',
      'I accept the EULA'
    ])
      expect(
        classifyBrowserAction({ type: 'click', selector: '#agree' }, banner(name)),
        name
      ).toMatchObject({ consequential: true });
  });

  /*
   * The counterweight, and the honest half of the same finding.
   *
   * Consent is not a category this can recognise: `ElementPolicyInput` carries a tag, a type, a
   * name, an autocomplete token, a form action and whether a form is around it, and a cookie
   * banner's button is structurally identical to every other button on the page. So the only
   * evidence is the words, and "Accept", "Agree", "Allow" and "Got it" are the words on a banner
   * that stands in front of almost every page a research turn opens. Carding those is friction on
   * ordinary reading, not a safeguard - so they are deliberately absent, the mode sentence no
   * longer claims them, and this row is what stops somebody adding them without saying so.
   */
  it('does not card the banner in front of every page on the web', () => {
    const banner = (name: string) => ({
      tag: 'button',
      type: 'button',
      name,
      autocomplete: '',
      formAction: '',
      inForm: false
    });
    for (const name of [
      'Accept all',
      'Accept all cookies',
      'Agree',
      'I agree',
      'Allow all',
      'Got it',
      'Continue',
      'OK'
    ])
      expect(
        classifyBrowserAction({ type: 'click', selector: '#consent' }, banner(name)),
        name
      ).toMatchObject({ consequential: false });
  });

  /*
   * And the other direction of the same vocabulary, which cost more than the banner would have.
   *
   * `terms`, `licence`, `license` and `eula` sat in the alternation as bare nouns for one wave.
   * Every other word in it names an ACT; these four name a DOCUMENT, and the ordinary thing to do
   * with a document is read it - so a link named "License" in a repository sidebar was
   * `consequential: true` and stopped the turn in every mode, on nothing but the word. The
   * alternation pairs an agreeing verb with the object now, which is what the mode sentence
   * promises, and these rows are what stops the nouns coming back bare.
   */
  it('does not card the link that opens a licence to read it', () => {
    const link = (name: string) => ({
      tag: 'a',
      type: '',
      name,
      autocomplete: '',
      formAction: '',
      inForm: false
    });
    for (const name of [
      'License',
      'LICENSE',
      'Licence',
      'Terms',
      'Terms of Service',
      'MIT License',
      'EULA',
      'View licence'
    ])
      expect(
        classifyBrowserAction({ type: 'click', selector: '#read' }, link(name)),
        name
      ).toMatchObject({ consequential: false });
  });

  it('gates a double click on the control it activates, exactly like a click', () => {
    const submit = {
      tag: 'button',
      type: 'submit',
      name: 'Continue',
      autocomplete: '',
      formAction: 'https://jobs.example.invalid/apply',
      inForm: true
    };
    expect(
      classifyBrowserAction({ type: 'double_click', selector: '#continue' }, submit)
    ).toMatchObject({ consequential: true, sensitiveInput: false });
    expect(
      classifyBrowserAction({ type: 'double_click', selector: '#open' }, ordinaryElement)
    ).toMatchObject({ consequential: false, sensitiveInput: false });
  });

  it('always requires approval before a workspace file leaves for an external site', () => {
    const preflight = classifyBrowserAction({
      type: 'upload',
      selector: '#cv',
      paths: ['workspace/cv.pdf']
    });
    expect(preflight).toMatchObject({ consequential: true, sensitiveInput: false });
    expect(preflight.preview).toContain('workspace/cv.pdf');
  });
  it('judges a form control by its action rather than transaction words in the destination URL', () => {
    const element = {
      tag: 'button',
      type: 'button',
      name: 'Previous',
      autocomplete: '',
      formAction: 'https://jobs.example.invalid/apply',
      inForm: true
    };
    expect(
      classifyBrowserAction({ type: 'click', selector: '#previous' }, element).consequential
    ).toBe(false);
    expect(
      classifyBrowserAction({ type: 'click', selector: '#submit' }, { ...element, type: 'submit' })
        .consequential
    ).toBe(true);
    expect(
      classifyBrowserAction(
        { type: 'click', selector: '#send' },
        { ...element, name: 'Send application' }
      ).consequential
    ).toBe(true);
  });

  it('leaves reading, pointing and choosing a listed option unapproved', () => {
    const menu = {
      tag: 'button',
      type: '',
      name: 'Account menu',
      autocomplete: '',
      formAction: '',
      inForm: false
    };
    expect(classifyBrowserAction({ type: 'hover', selector: '#menu' }, menu)).toMatchObject({
      consequential: false,
      sensitiveInput: false
    });
    expect(
      classifyBrowserAction(
        { type: 'select_option', selector: '#country', values: ['DE'] },
        {
          tag: 'select',
          type: 'select-one',
          name: 'Country',
          autocomplete: 'country',
          formAction: 'https://shop.example.invalid/checkout',
          inForm: true
        }
      )
    ).toMatchObject({ consequential: false, sensitiveInput: false });
    expect(classifyBrowserAction({ type: 'scroll', deltaX: 0, deltaY: 600 })).toMatchObject({
      consequential: false,
      sensitiveInput: false
    });
    expect(
      classifyBrowserAction({ type: 'scroll', selector: '#panel', deltaX: 0, deltaY: 600 })
    ).toMatchObject({ consequential: false, sensitiveInput: false });
  });

  it('requires approval and secure takeover before accepting a dialog with private text', () => {
    expect(
      classifyBrowserAction({ type: 'dialog', response: 'accept', promptText: 'private answer' })
    ).toMatchObject({ consequential: true, sensitiveInput: true });
    expect(classifyBrowserAction({ type: 'dialog', response: 'dismiss' })).toMatchObject({
      consequential: false,
      sensitiveInput: false
    });
  });
});

// Mirrors the head-and-tail truncation the worker applies to a serialized tool result.
const truncateMiddle = (value: string, maximum: number): string =>
  value.length <= maximum
    ? value
    : `${value.slice(0, Math.floor(maximum * 0.6))}…${value.slice(-Math.floor(maximum * 0.4))}`;

describe('browser snapshot shape', () => {
  const snapshot = (text: string) =>
    composeBrowserSnapshot({
      url: 'https://shop.example.invalid/cart',
      title: 'Cart',
      holder: 'agent',
      botWall: null,
      elements: Array.from({ length: 50 }, (_, index) => ({
        index,
        selector: `[data-athanor-ref="oc-${index}"]`,
        tag: 'button',
        role: null,
        name: `Control number ${index}`,
        type: 'button',
        href: null
      })),
      tabs: [
        { tabId: 'tab-1', active: true, url: 'https://shop.example.invalid/cart', title: 'Cart' }
      ],
      downloads: [
        {
          path: 'workspace/downloads/2026-01-02T03-04-05/invoice.pdf',
          url: 'https://cdn.invalid/i'
        }
      ],
      elementsOmitted: 0,
      framesOmitted: 0,
      pendingDialog: null,
      consoleMessages: [],
      failedRequests: [],
      images: [],
      screenshotBase64: '',
      text
    });

  it('keeps the clickable elements ahead of the page text', () => {
    const keys = Object.keys(snapshot('body text'));
    expect(keys.indexOf('elements')).toBeLessThan(keys.indexOf('text'));
    expect(keys.at(-1)).toBe('text');
  });

  it('survives the worker truncation budget on a content-heavy page', () => {
    const serialized = JSON.stringify(snapshot('page words '.repeat(20_000)));
    const delivered = truncateMiddle(serialized, 24_000);
    // Every control must still be reachable after truncation: the whole point of putting `text`
    // last is that a wordy page can only cost the agent page text, never the ability to act.
    expect(delivered).toContain('"url":"https://shop.example.invalid/cart"');
    expect(delivered).toContain('[data-athanor-ref=\\"oc-0\\"]');
    expect(delivered).toContain('[data-athanor-ref=\\"oc-49\\"]');
    expect(delivered.length).toBeLessThanOrEqual(24_000);
  });

  it('bounds the page text so it cannot swallow the budget on its own', () => {
    expect(snapshot('x'.repeat(500_000)).text).toHaveLength(BROWSER_SNAPSHOT_TEXT_LIMIT);
  });

  it('carries the truncation counts and the failed requests through to the payload', () => {
    /*
     * `composeBrowserSnapshot` names every key it emits, so a field added to the type and not to
     * this function is computed and never shipped - which is the shape that has cost this
     * programme five times. The counts and the failure list are only worth anything if the model
     * sees them, so this is the assertion that they leave the runner at all.
     */
    const composed = composeBrowserSnapshot({
      ...snapshot('short'),
      elementsOmitted: 55,
      framesOmitted: 14,
      failedRequests: [
        { method: 'POST', status: 403, url: 'https://shop.example.invalid/checkout', at: 'now' }
      ]
    });
    expect(composed.elementsOmitted).toBe(55);
    expect(composed.framesOmitted).toBe(14);
    expect(composed.failedRequests).toEqual([
      { method: 'POST', status: 403, url: 'https://shop.example.invalid/checkout', at: 'now' }
    ]);
    const delivered = truncateMiddle(
      JSON.stringify(composeBrowserSnapshot({ ...composed, text: 'page words '.repeat(20_000) })),
      24_000
    );
    // And that a wordy page cannot push them out: they sit with the actionable fields, ahead of
    // the page text, for the same reason the elements do.
    expect(delivered).toContain('"elementsOmitted":55');
    expect(delivered).toContain('"status":403');
  });

  it('keeps saved downloads where a truncated result still shows them', () => {
    const serialized = JSON.stringify(snapshot('page words '.repeat(20_000)));
    const delivered = truncateMiddle(serialized, 24_000);
    expect(delivered).toContain('workspace/downloads/2026-01-02T03-04-05/invoice.pdf');
  });
});

describe('download naming', () => {
  it('reduces a site-chosen filename to one harmless component', () => {
    expect(downloadFileName('invoice.pdf')).toBe('invoice.pdf');
    expect(downloadFileName('../../.ssh/authorized_keys')).toBe('authorized_keys');
    expect(downloadFileName('..\\..\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(downloadFileName('..')).toBe('download');
    expect(downloadFileName('/')).toBe('download');
    expect(downloadFileName('.bashrc')).toBe('bashrc');
    expect(downloadFileName('report\u0000\u001b.pdf')).toBe('report.pdf');
    expect(downloadFileName(`${'a'.repeat(400)}.pdf`)).toHaveLength(120);
  });
});

describe('frame-qualified element refs', () => {
  it('reads the frame a snapshot ref was scanned from', () => {
    expect(refFrameOrdinal('[data-athanor-ref="oc-0-12"]')).toBe(0);
    expect(refFrameOrdinal('[data-athanor-ref="oc-3-1"]')).toBe(3);
    // A hand-written selector carries no frame, and must not be read as frame 0 by accident.
    expect(refFrameOrdinal('#checkout-button')).toBeNull();
    expect(refFrameOrdinal('[data-athanor-ref="oc-7"]')).toBeNull();
  });

  /**
   * A ref used to be an index into whatever the last scan happened to look at. The scan cleared
   * every ref in the whole document and re-stamped from zero inside its scope, so a scoped
   * read_elements - the cheap re-read the form-filling procedure teaches - silently re-pointed
   * every ref the agent was holding: oc-0-3 had been Submit and became Postcode, and the next
   * click landed on a different control with nothing reporting that anything had changed.
   */
  const frameWith = (counts: Record<string, number>) =>
    ({
      locator: (selector: string) => ({
        count: async () => counts[selector] ?? 0,
        __selector: selector
      })
    }) as never;

  it('takes the one element a ref names', async () => {
    const page = {
      frames: () => [frameWith({}), frameWith({ '[data-athanor-ref="oc-1-4"]': 1 })],
      locator: () => ({ first: () => 'main-frame-fallback' })
    } as never;
    const found = await resolveBrowserTarget(page, '[data-athanor-ref="oc-1-4"]');
    expect((found as unknown as { __selector: string }).__selector).toBe(
      '[data-athanor-ref="oc-1-4"]'
    );
  });

  it('refuses a ref that now matches two elements rather than choosing one', async () => {
    // Acting on `.first()` here is a coin toss taken on the owner's behalf.
    const page = {
      frames: () => [frameWith({ '[data-athanor-ref="oc-0-2"]': 2 })],
      locator: () => ({ first: () => 'fallback' })
    } as never;
    await expect(resolveBrowserTarget(page, '[data-athanor-ref="oc-0-2"]')).rejects.toThrow(
      /no longer names one control/
    );
  });

  it('refuses a ref that has gone, instead of waiting out the clock for it', async () => {
    const page = {
      frames: () => [frameWith({})],
      locator: () => ({ first: () => 'fallback' })
    } as never;
    await expect(resolveBrowserTarget(page, '[data-athanor-ref="oc-0-9"]')).rejects.toThrow(
      /no longer on the page/
    );
  });

  it('still auto-waits for a selector the caller wrote themselves', async () => {
    // Only a ref carries the promise of naming one control; a CSS selector is the caller's own and
    // may legitimately be waiting for something to render.
    const page = {
      frames: () => [frameWith({})],
      locator: () => ({ first: () => 'auto-waiting' })
    } as never;
    await expect(resolveBrowserTarget(page, '#checkout-button')).resolves.toBe('auto-waiting');
  });
});

describe('popup handling', () => {
  it('adopts a new page only once the driven page is gone', () => {
    expect(shouldAdoptNewPage({ isClosed: () => false })).toBe(false);
    expect(shouldAdoptNewPage({ isClosed: () => true })).toBe(true);
    expect(shouldAdoptNewPage(undefined)).toBe(true);
  });
});

describe('tab identity', () => {
  const fakePage = (url: string, closed = false) =>
    ({
      url: () => url,
      title: async () => url.replace('https://', ''),
      isClosed: () => closed
    }) as never;

  it('reports every open tab and marks exactly one active', async () => {
    const active = fakePage('https://a.example');
    const session = {
      page: active,
      tabs: new Map([
        ['tab-1', active],
        ['tab-2', fakePage('https://b.example')]
      ])
    } as never;
    const tabs = await sessionTabs(session);
    expect(tabs.map((t) => t.tabId)).toEqual(['tab-1', 'tab-2']);
    expect(tabs.filter((t) => t.active).map((t) => t.tabId)).toEqual(['tab-1']);
    expect(tabs[1]?.url).toBe('https://b.example');
  });

  it('omits a closed tab rather than reporting a dead handle', async () => {
    const active = fakePage('https://a.example');
    const session = {
      page: active,
      tabs: new Map([
        ['tab-1', active],
        ['tab-2', fakePage('https://gone.example', true)]
      ])
    } as never;
    // Ids are never reused, so the survivor keeps tab-1 instead of being renumbered - which is
    // the whole reason positional access was replaced.
    expect((await sessionTabs(session)).map((t) => t.tabId)).toEqual(['tab-1']);
  });
});

describe('parallel research URL policy', () => {
  // What each address means is decided once, in @athanor/core, and tested there. What matters here
  // is that this route asks - and asks before it launches anything, so a local address is refused
  // rather than merely failing to load.
  it('refuses a source that is not on the public web, before opening a browser', async () => {
    const manager = new BrowserManager({ maxFileBytes: 1024 * 1024 });
    for (const url of [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.2/internal',
      'https://metadata.google.internal/computeMetadata/v1',
      'file:///etc/passwd'
    ])
      await expect(manager.readMany([url], 1_000)).rejects.toThrow(
        'Parallel web reading accepts public HTTP(S) URLs only'
      );
  });
});

describe('session browser address policy', () => {
  // The browser the agent drives used to be the one outbound path with no address policy at all,
  // so an instruction inside a page or an email could send it at the cloud metadata endpoint or a
  // service listening on loopback and read the answer back out of a snapshot.
  const offLimits = [
    'http://127.0.0.1:4300/healthz',
    'http://localhost:5432/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.2/internal',
    'http://192.168.1.1/',
    'http://[::1]/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://database.internal/',
    'file:///etc/passwd'
  ];

  it('refuses to drive the agent anywhere but the public web', async () => {
    for (const url of offLimits)
      await expect(assertAgentReachableUrl(url), url).rejects.toThrow(
        'only driven to addresses on the public internet'
      );
  });

  it('reads a page back only when nothing private could have put itself on the screen', () => {
    // A tab that has loaded nothing yet.
    expect(agentReachablePage('about:blank')).toBe(true);
    expect(agentReachablePage('')).toBe(true);
    expect(agentReachablePage('https://example.com/posting')).toBe(true);
    // A site opening the PDF it just generated. The bytes are its own and its origin passed above.
    expect(agentReachablePage('blob:https://example.com/8f2c-4a1e')).toBe(true);
    expect(agentReachablePage('blob:http://127.0.0.1:4300/8f2c-4a1e')).toBe(false);
    for (const url of [
      ...offLimits,
      'chrome://settings',
      'view-source:https://example.com',
      'data:text/html,<p>hi</p>'
    ])
      expect(agentReachablePage(url), url).toBe(false);
  });

  it('finds the address in every step that carries one, and only those', () => {
    expect(stepDestinations({ type: 'navigate', url: 'https://example.com' } as never)).toEqual([
      'https://example.com'
    ]);
    expect(
      stepDestinations({ type: 'new_tab', url: 'https://example.com', activate: true } as never)
    ).toEqual(['https://example.com']);
    expect(stepDestinations({ type: 'new_tab', activate: false } as never)).toEqual([]);
    expect(stepDestinations({ type: 'click', selector: 'button' } as never)).toEqual([]);
    expect(stepDestinations({ type: 'reload' } as never)).toEqual([]);
  });
});

const rawElement = (overrides: Partial<RawScannedElement> = {}): RawScannedElement => ({
  ref: 'oc-0-0',
  tag: 'input',
  role: null,
  ariaLabel: '',
  labelledByText: '',
  labelText: '',
  placeholder: '',
  title: '',
  text: '',
  type: 'text',
  href: null,
  elementId: '',
  fieldName: '',
  valueBearing: true,
  value: '',
  password: false,
  checked: null,
  disabled: false,
  required: false,
  maxLength: -1,
  pattern: '',
  invalid: false,
  description: '',
  options: null,
  labelFor: null,
  closedShadowRoot: false,
  ...overrides
});

describe('failed requests', () => {
  const ring = () => ({
    failedRequests: [] as Array<{ method: string; status: number; url: string; at: string }>
  });
  /** `at` is left out on purpose: what is asserted is which failures survived, and in what order. */
  const entry = (status: number, method: string, url: string) => ({ status, method, url });

  it('keeps what failed, most recent last, and forgets the oldest past the bound', () => {
    const session = ring();
    for (let index = 0; index < 20; index += 1)
      recordFailedRequest(session, 'GET', 404, `https://shop.invalid/a/${index}`);
    expect(session.failedRequests).toHaveLength(15);
    expect(session.failedRequests[0]?.url).toBe('https://shop.invalid/a/5');
    expect(session.failedRequests[14]?.url).toBe('https://shop.invalid/a/19');
  });

  it('collapses a repeat instead of letting it bury the one failure that is the answer', () => {
    // A page whose API is down repeats the same failure on a timer. Fifteen copies of one line
    // would push out the 403 on the submit, which is the entry the agent is actually looking for.
    const session = ring();
    recordFailedRequest(session, 'POST', 403, 'https://shop.invalid/checkout');
    for (let index = 0; index < 30; index += 1)
      recordFailedRequest(session, 'GET', 500, 'https://shop.invalid/api/poll');
    expect(session.failedRequests).toEqual([
      expect.objectContaining(entry(403, 'POST', 'https://shop.invalid/checkout')),
      expect.objectContaining(entry(500, 'GET', 'https://shop.invalid/api/poll'))
    ]);
  });

  it('sheds ordinary cross-origin noise rather than the failure the agent needs', () => {
    /*
     * Collapsing only defends the shape where the noise is one URL repeated. The ordinary shape on
     * a real page is noise at DISTINCT urls: an analytics beacon, an ad pixel and a CDN hop each
     * carry a cache-buster, so each one takes its own slot and none of them collapses. Measured
     * against a real Chromium on a page that fired twenty such cross-origin requests after one 403
     * on a form submit, the plain oldest-first bound had evicted the 403 before the snapshot was
     * taken - the one entry the whole list exists to carry.
     */
    const session = ring();
    recordFailedRequest(session, 'POST', 403, 'https://shop.invalid/checkout');
    for (let index = 0; index < 20; index += 1) {
      recordFailedRequest(session, 'GET', 302, `https://cdn.invalid/px?i=${index}`);
      recordFailedRequest(session, 'GET', 0, `https://ads.invalid/b?i=${index}`);
    }
    expect(session.failedRequests).toHaveLength(15);
    expect(session.failedRequests[0]).toMatchObject(
      entry(403, 'POST', 'https://shop.invalid/checkout')
    );
    // And the soft entries that survived are the most recent ones, so the list still describes the
    // page as it is now rather than as it was forty requests ago.
    expect(session.failedRequests.at(-1)).toMatchObject(
      entry(0, 'GET', 'https://ads.invalid/b?i=19')
    );
  });

  it('does not admit a soft entry into a list already full of real refusals', () => {
    // The same rule from the other end, pinned because it is the surprising half: fifteen 4xx/5xx
    // are fifteen things the site refused, and a 302 that merely crossed an origin is not worth
    // one of them. Nothing is silently dropped that a hard failure would not have displaced too.
    const session = ring();
    for (let index = 0; index < 15; index += 1)
      recordFailedRequest(session, 'POST', 403, `https://shop.invalid/step/${index}`);
    recordFailedRequest(session, 'GET', 302, 'https://accounts.invalid/login');
    expect(session.failedRequests).toHaveLength(15);
    expect(session.failedRequests.every((seen) => seen.status === 403)).toBe(true);
    // A hard failure still displaces the oldest hard one: the bound has not stopped trimming.
    recordFailedRequest(session, 'GET', 500, 'https://shop.invalid/final');
    expect(session.failedRequests).toHaveLength(15);
    expect(session.failedRequests[0]?.url).toBe('https://shop.invalid/step/1');
    expect(session.failedRequests.at(-1)?.url).toBe('https://shop.invalid/final');
  });

  it('trims a URL to what identifies the call, not to what could re-issue it', () => {
    const session = ring();
    recordFailedRequest(session, 'GET', 404, `https://shop.invalid/x?token=${'a'.repeat(4_000)}`);
    expect(session.failedRequests[0]?.url).toHaveLength(200);
  });
});

describe('a control the page will not let anything read', () => {
  it('reports a closed shadow root as a thing that is there and cannot be listed', () => {
    // The scan pierces OPEN roots, so those need no marking. A closed one is genuinely unreadable,
    // and the honest report is that something is there rather than nothing.
    const described = describeScannedElement(
      rawElement({
        ref: 'oc-0-4',
        tag: 'ds-payment',
        valueBearing: true,
        value: 'should not be reported',
        closedShadowRoot: true
      })
    );
    expect(described.name).toBe('ds-payment');
    expect(described.description).toMatch(/closed shadow root/);
    // Nothing was read out of it, so nothing about its contents is claimed - a value in particular.
    expect(described.value).toBeUndefined();
  });
});

describe('form field legibility', () => {
  it('names a field from its label when the control itself carries no text', () => {
    // The exact shape a job application uses: <label for=firstName>First name</label><input>.
    // Before the label was folded in, this element arrived as {tag:'input', name:''}.
    const described = describeScannedElement(
      rawElement({ elementId: 'firstName', fieldName: 'first_name', labelText: 'First name' })
    );
    expect(described.name).toBe('First name');
    expect(described.id).toBe('firstName');
    expect(described.field).toBe('first_name');
  });

  it('prefers the accessible name in the order a browser resolves it', () => {
    const everything = {
      ariaLabel: 'Aria',
      labelledByText: 'LabelledBy',
      labelText: 'Label',
      placeholder: 'Placeholder',
      title: 'Title',
      text: 'Text'
    };
    expect(describeScannedElement(rawElement(everything)).name).toBe('Aria');
    expect(describeScannedElement(rawElement({ ...everything, ariaLabel: '' })).name).toBe(
      'LabelledBy'
    );
    expect(
      describeScannedElement(rawElement({ ...everything, ariaLabel: '', labelledByText: '' })).name
    ).toBe('Label');
    expect(
      describeScannedElement(
        rawElement({ ...everything, ariaLabel: '', labelledByText: '', labelText: '' })
      ).name
    ).toBe('Placeholder');
    expect(describeScannedElement(rawElement({ text: 'Continue' })).name).toBe('Continue');
  });

  it('reports what a field currently holds, including that it is still empty', () => {
    // Reading back what was typed is step five of filling a form, and the only alternative was
    // looking at a screenshot with vision.
    expect(describeScannedElement(rawElement({ value: 'Ada' })).value).toBe('Ada');
    expect(describeScannedElement(rawElement({ value: '' })).value).toBe('');
    expect(describeScannedElement(rawElement({ tag: 'div', valueBearing: false })).value).toBe(
      undefined
    );
  });

  it('never returns a password, only its length', () => {
    const filled = describeScannedElement(
      rawElement({ type: 'password', password: true, value: 'hunter2!' })
    );
    expect(filled.value).toBe('8 characters entered');
    expect(filled.value).not.toContain('hunter');
    expect(
      describeScannedElement(rawElement({ type: 'password', password: true, value: '' })).value
    ).toBe('');
  });

  it('marks shortened values explicitly and lets a form read verify a complete long answer', () => {
    const value = 'A truthful application statement. '.repeat(30);
    const raw = rawElement({ tag: 'textarea', value });
    expect(describeScannedElement(raw)).toMatchObject({
      value: value.slice(0, 200),
      valueTruncated: true,
      valueLength: value.length
    });
    const form = foldScannedElements([raw], 1, 4000);
    expect(form.kept).toHaveLength(1);
    expect(form.kept[0]?.value).toBe(value);
    expect(form.kept[0]?.valueTruncated).toBeUndefined();
    const huge = describeScannedElement(rawElement({ value: 'x'.repeat(5000) }), 4000);
    expect(huge).toMatchObject({ valueTruncated: true, valueLength: 5000 });
    expect(huge.value).toHaveLength(4000);
    expect(describeScannedElement(rawElement({ password: true, value }), 4000)).toMatchObject({
      value: `${value.length} characters entered`
    });
  });

  it('carries the constraints and the option list a form actually validates against', () => {
    const postcode = describeScannedElement(
      rawElement({
        required: true,
        maxLength: 8,
        pattern: '[A-Z0-9 ]+',
        invalid: true,
        description: 'Enter a UK postcode'
      })
    );
    expect(postcode).toMatchObject({
      required: true,
      maxLength: 8,
      pattern: '[A-Z0-9 ]+',
      invalid: true,
      description: 'Enter a UK postcode'
    });
    const country = describeScannedElement(
      rawElement({
        tag: 'select',
        type: null,
        value: 'DE',
        options: [
          { value: 'DE', label: 'Germany', selected: true },
          { value: 'GB', label: 'United Kingdom', selected: false }
        ]
      })
    );
    // Selecting matches on the option's value attribute, not its label, so both are reported.
    expect(country.options).toEqual([
      { value: 'DE', label: 'Germany', selected: true },
      { value: 'GB', label: 'United Kingdom', selected: false }
    ]);
  });

  it('omits every member that would say nothing, so a wide form still fits the budget', () => {
    expect(
      Object.keys(describeScannedElement(rawElement({ tag: 'a', valueBearing: false })))
    ).toEqual(['ref', 'tag', 'role', 'name', 'type', 'href']);
  });

  it('drops a label once its control is listed, and keeps one whose control is hidden', () => {
    const folded = foldScannedElements(
      [
        rawElement({
          ref: 'oc-0-0',
          tag: 'label',
          valueBearing: false,
          text: 'Email',
          labelFor: 'oc-0-1'
        }),
        rawElement({ ref: 'oc-0-1', fieldName: 'email', labelText: 'Email' }),
        // A styled checkbox: the real input has no box, so the label is the only click target.
        rawElement({
          ref: 'oc-0-2',
          tag: 'label',
          valueBearing: false,
          text: 'I agree',
          labelFor: 'oc-0-9'
        })
      ],
      250
    );
    expect(folded.kept.map((element) => element.ref)).toEqual(['oc-0-1', 'oc-0-2']);
    expect(folded.kept[0]?.name).toBe('Email');
    expect(folded.kept[1]?.name).toBe('I agree');
    // One label folded onto its control, which is represented rather than missing: the caller
    // subtracts this from the omitted count so a page of labelled inputs does not report itself
    // as half absent.
    expect(folded.folded).toBe(1);
  });

  it('honours the element budget after folding, not before it', () => {
    const raw = [
      rawElement({ ref: 'oc-0-0', tag: 'label', valueBearing: false, labelFor: 'oc-0-1' }),
      rawElement({ ref: 'oc-0-1' }),
      rawElement({ ref: 'oc-0-2' })
    ];
    expect(foldScannedElements(raw, 2).kept.map((element) => element.ref)).toEqual([
      'oc-0-1',
      'oc-0-2'
    ]);
  });
});

describe('typing strategy', () => {
  const control = {
    tag: 'input',
    role: '',
    ariaAutocomplete: '',
    hasList: false,
    contentEditable: false
  };

  it('sends real keystrokes to anything that listens for them', () => {
    // A typeahead never opens its suggestion list for a value assignment, and every applicant
    // tracking system puts country, university and job title behind one.
    expect(typeStrategy({ ...control, role: 'combobox' })).toBe('keys');
    expect(typeStrategy({ ...control, ariaAutocomplete: 'list' })).toBe('keys');
    expect(typeStrategy({ ...control, hasList: true })).toBe('keys');
    expect(typeStrategy({ ...control, contentEditable: true })).toBe('keys');
  });

  it('fills an ordinary text field in one assignment', () => {
    expect(typeStrategy(control)).toBe('fill');
    expect(typeStrategy({ ...control, tag: 'textarea' })).toBe('fill');
  });
});

describe('batch approval', () => {
  const harmless = { consequential: false, sensitiveInput: false, preview: 'Click “Next”' };

  it('treats a batch as exactly as consequential as its worst step', () => {
    const combined = combineBatchPreflight([
      { index: 0, preflight: harmless },
      {
        index: 1,
        preflight: { consequential: true, sensitiveInput: false, preview: 'Click “Submit”' }
      }
    ]);
    expect(combined.consequential).toBe(true);
    expect(combined.preview).toContain('2. Click “Submit”');
  });

  it('carries a sensitive step up to the wrapper so it cannot ride through inside one', () => {
    expect(
      combineBatchPreflight([
        { index: 0, preflight: harmless },
        {
          index: 1,
          preflight: { consequential: false, sensitiveInput: true, preview: 'Fill “Password”' }
        }
      ])
    ).toMatchObject({ sensitiveInput: true });
  });

  it('leaves a batch of ordinary steps unapproved', () => {
    expect(
      combineBatchPreflight([
        { index: 0, preflight: harmless },
        { index: 1, preflight: harmless }
      ])
    ).toMatchObject({ consequential: false, sensitiveInput: false });
  });
});

describe('anti-bot wall detection', () => {
  it('recognises a challenge widget embedded in the page', () => {
    expect(
      detectBotWall({
        url: 'https://jobs.example.invalid/apply',
        title: 'Apply',
        frameUrls: [
          'https://jobs.example.invalid/apply',
          'https://challenges.cloudflare.com/turnstile/v0/api.js'
        ]
      })
    ).toMatchObject({ vendor: 'Cloudflare Turnstile' });
    expect(
      detectBotWall({
        url: 'https://shop.example.invalid',
        title: 'Shop',
        frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/frame']
      })
    ).toMatchObject({ vendor: 'hCaptcha' });
  });

  it('recognises a bot manager from the response it sent', () => {
    expect(
      detectBotWall({
        url: 'https://careers.example.invalid',
        title: '',
        status: 403,
        headers: { server: 'cloudflare' }
      })
    ).toMatchObject({ vendor: 'Cloudflare' });
    expect(
      detectBotWall({
        url: 'https://careers.example.invalid',
        title: '',
        status: 200,
        headers: { 'X-DataDome': 'protected' }
      })
    ).toMatchObject({ vendor: 'DataDome' });
  });

  it('recognises the interstitial by what it says', () => {
    expect(detectBotWall({ url: 'https://x.invalid', title: 'Just a moment...' })).not.toBeNull();
    expect(
      detectBotWall({
        url: 'https://x.invalid',
        title: 'Sign in',
        text: 'Verify you are human by completing the action below.'
      })
    ).not.toBeNull();
  });

  it('leaves an ordinary page alone', () => {
    expect(
      detectBotWall({
        url: 'https://jobs.example.invalid/apply',
        title: 'Software engineer - apply',
        text: 'Tell us about yourself. We review every application.',
        frameUrls: ['https://jobs.example.invalid/apply', 'https://player.example.invalid/embed'],
        status: 200,
        headers: { server: 'nginx' }
      })
    ).toBeNull();
    // A 403 on its own is an ordinary permission failure, not a bot wall.
    expect(
      detectBotWall({ url: 'https://api.example.invalid', title: '', status: 403, headers: {} })
    ).toBeNull();
  });

  it('recognises the challenge a search engine serves software', () => {
    // The page an unattended research task walks into first, in the engine's own words.
    expect(
      detectBotWall({
        url: 'https://html.duckduckgo.com/html/?q=board+deck',
        title: 'DuckDuckGo',
        text: 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human.',
        status: 202
      })
    ).toMatchObject({ evidence: 'page' });
  });

  it('tells the agent what is still open to it rather than that the browser is gone', () => {
    const message = botWallMessage({
      vendor: 'Cloudflare',
      url: 'https://careers.example.invalid/apply',
      reason: 'HTTP 403 from a Cloudflare bot manager',
      evidence: 'response',
      tabId: 'tab-3'
    });
    expect(message).toContain('Tab tab-3 is stopped');
    expect(message).toContain('careers.example.invalid is closed to you');
    expect(message).toContain('Every other tab and every other site still works');
    expect(message).toContain('Do not retry, reload, open it in another tab');
  });
});

describe('bot wall scope', () => {
  const pageWall: BotWall = {
    vendor: 'Cloudflare Turnstile',
    url: 'https://careers.example.invalid/apply',
    reason: 'challenge widget is embedded in the page',
    evidence: 'page'
  };
  const responseWall: BotWall = {
    vendor: 'DataDome',
    url: 'https://shop.example.invalid/checkout',
    reason: 'response carried x-datadome',
    evidence: 'response'
  };

  it('stops the tab that hit the challenge and leaves the rest of the browser alone', () => {
    const ledger = new BotWallLedger();
    ledger.raise('tab-2', pageWall);
    expect(ledger.standing('tab-2')).toMatchObject({ vendor: 'Cloudflare Turnstile' });
    // The whole point: the tab holding the posting is stopped, the one holding the research is not.
    expect(ledger.standing('tab-1')).toBeUndefined();
    expect(ledger.hostClosed('https://en.wikipedia.org/wiki/Recruitment')).toBeNull();
  });

  it('refuses the same site from a fresh tab, which is the retry the challenge is asking for', () => {
    const ledger = new BotWallLedger();
    ledger.raise('tab-2', pageWall, 1_000);
    expect(ledger.hostClosed('https://careers.example.invalid/other', 2_000)).toMatchObject({
      vendor: 'Cloudflare Turnstile'
    });
    // Closing the walled tab is not a way to start that request again.
    ledger.forgetTab('tab-2');
    expect(ledger.standing('tab-2')).toBeUndefined();
    expect(ledger.hostClosed('https://careers.example.invalid/apply', 2_000)).not.toBeNull();
    // A verdict about a moment is not a verdict about tomorrow.
    expect(
      ledger.hostClosed(
        'https://careers.example.invalid/apply',
        1_000 + BOT_WALL_HOST_COOLDOWN_MS + 1
      )
    ).toBeNull();
  });

  it('clears when the page does, and only the owner clears the rest', () => {
    const ledger = new BotWallLedger();
    ledger.raise('tab-2', pageWall);
    ledger.raise('tab-4', responseWall);
    expect(ledger.latest()).toMatchObject({ tabId: 'tab-4', vendor: 'DataDome' });
    ledger.clear('tab-2', pageWall.url);
    expect(ledger.standing('tab-2')).toBeUndefined();
    expect(ledger.hostClosed(pageWall.url)).toBeNull();
    expect(ledger.standing('tab-4')).toMatchObject({ vendor: 'DataDome' });
    ledger.clearAll();
    expect(ledger.latest()).toBeNull();
    expect(ledger.hostClosed(responseWall.url)).toBeNull();
  });

  it('lets an interstitial that passed by itself go, without a reload', () => {
    // The common case: "Just a moment..." resolves on its own a few seconds later.
    expect(
      reviewBotWall(pageWall, {
        url: pageWall.url,
        title: 'Software engineer - apply',
        text: 'Tell us about yourself.',
        frameUrls: [pageWall.url]
      })
    ).toBeNull();
    // Still there means still stopped.
    expect(
      reviewBotWall(pageWall, {
        url: pageWall.url,
        title: 'Just a moment...',
        text: '',
        frameUrls: [pageWall.url]
      })
    ).not.toBeNull();
    // A tab the owner moved on is not blocked by what used to be there.
    expect(
      reviewBotWall(pageWall, {
        url: 'https://careers.example.invalid/thanks',
        title: 'Application received',
        text: 'Thanks',
        frameUrls: []
      })
    ).toBeNull();
  });

  it('keeps a wall the page cannot disprove until the tab leaves it', () => {
    // The evidence was in the headers; only a fresh request would produce them again, and a fresh
    // request is the retry that must not happen. The DOM has nothing to say about it either way.
    expect(
      reviewBotWall(responseWall, {
        url: responseWall.url,
        title: 'Checkout',
        text: 'Your basket',
        frameUrls: []
      })
    ).toMatchObject({ vendor: 'DataDome' });
    expect(
      reviewBotWall(responseWall, {
        url: 'https://shop.example.invalid/',
        title: 'Shop',
        text: '',
        frameUrls: []
      })
    ).toBeNull();
  });
});

describe('browser launch realism', () => {
  it('falls back to headless mode without lowering renderer isolation', () => {
    expect(browserLaunchLadder({ displayAvailable: true, runningAsRoot: false })).toEqual([
      { headless: false, chromiumSandbox: true },
      { headless: true, chromiumSandbox: true }
    ]);
    expect(browserLaunchLadder({ displayAvailable: false, runningAsRoot: false })).toEqual([
      { headless: true, chromiumSandbox: true }
    ]);
    expect(() => browserLaunchLadder({ displayAvailable: true, runningAsRoot: true })).toThrow(
      'as root'
    );
  });

  it('does not retry a failed research launch with reduced isolation', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('sandbox setup failed'));
    await expect(
      launchSandboxedResearchBrowser(
        { launch },
        {
          runningAsRoot: false,
          environment: { PATH: '/usr/bin', RUNNER_TOKEN: 'private' }
        }
      )
    ).rejects.toThrow('renderer sandbox');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: true, env: { PATH: '/usr/bin' } })
    );
  });

  it('does not hand runner credentials or loader controls to the browser', () => {
    expect(
      browserLaunchEnvironment(
        {
          PATH: '/usr/bin',
          HOME: '/home/athanor',
          DISPLAY: ':1',
          RUNNER_TOKEN: 'private',
          DATA_MASTER_KEY: 'private',
          OPENROUTER_API_KEY: 'private',
          DATABASE_URL: 'private',
          LD_PRELOAD: '/workspace/override.so'
        },
        { DISPLAY: ':9', XDG_RUNTIME_DIR: '/run/garden-display' }
      )
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/athanor',
      DISPLAY: ':9',
      XDG_RUNTIME_DIR: '/run/garden-display'
    });
  });

  it('never lets a page be told the machine has no hover and a coarse pointer', () => {
    // These are Chromium's own headless defaults. Left in, a responsive site serves the agent its
    // phone layout while the user agent says desktop - so the agent clicks controls nobody else
    // has. They are dropped headless, and never added at all on a real display.
    const headless = browserLaunchOptions({ headless: true, chromiumSandbox: true });
    expect(headless.ignoreDefaultArgs).toEqual(HEADLESS_DEVICE_ARGUMENTS);
    expect(HEADLESS_DEVICE_ARGUMENTS).toContain('--hide-scrollbars');
    expect(HEADLESS_DEVICE_ARGUMENTS.join(' ')).toContain('primaryPointerType=4');
    const headed = browserLaunchOptions({ headless: false, chromiumSandbox: true });
    expect(headed.ignoreDefaultArgs).toEqual([]);
    expect(headed.args).toContain('--window-size=1440,900');
  });

  it('masks nothing, and keeps the one coordinate space every position is read in', () => {
    for (const headless of [true, false]) {
      const options = browserLaunchOptions({ headless, chromiumSandbox: true });
      expect(options.args.join(' ')).not.toContain('AutomationControlled');
      expect(options.viewport).toEqual({ width: 1440, height: 900 });
    }
    expect(BROWSER_VIEWPORT).toEqual({ width: 1440, height: 900 });
  });

  it('asks for the renderer sandbox, which is what drops the --no-sandbox switch', () => {
    expect(browserLaunchOptions({ headless: true, chromiumSandbox: true }).chromiumSandbox).toBe(
      true
    );
  });
});

describe('parallel research rendering', () => {
  it('retries a source that came back empty or asked for scripts', () => {
    expect(needsScriptedRender('')).toBe(true);
    expect(needsScriptedRender('Please enable JavaScript to view this page.')).toBe(true);
    expect(needsScriptedRender('Checking your browser before accessing the site.')).toBe(true);
    expect(needsScriptedRender('word '.repeat(200))).toBe(false);
  });

  it('lets a retried page run only its own scripts', () => {
    const documentOrigin = 'https://boards.example.invalid';
    expect(
      researchResourceAllowed({
        resourceType: 'document',
        requestUrl: `${documentOrigin}/jobs/1`,
        documentOrigin,
        scripts: false
      })
    ).toBe(true);
    expect(
      researchResourceAllowed({
        resourceType: 'script',
        requestUrl: `${documentOrigin}/bundle.js`,
        documentOrigin,
        scripts: true
      })
    ).toBe(true);
    // Not on the fast path, and never from anywhere else even on the retry.
    expect(
      researchResourceAllowed({
        resourceType: 'script',
        requestUrl: `${documentOrigin}/bundle.js`,
        documentOrigin,
        scripts: false
      })
    ).toBe(false);
    expect(
      researchResourceAllowed({
        resourceType: 'script',
        requestUrl: 'https://tracker.example.invalid/t.js',
        documentOrigin,
        scripts: true
      })
    ).toBe(false);
    expect(
      researchResourceAllowed({
        resourceType: 'image',
        requestUrl: `${documentOrigin}/hero.png`,
        documentOrigin,
        scripts: true
      })
    ).toBe(false);
  });
});

describe('page text normalisation', () => {
  it('tidies the whitespace a source file leaves in a label', () => {
    // The page hands text back exactly as it is written; every judgement, including this one,
    // is made here so it can be tested without a browser.
    expect(
      describeScannedElement(rawElement({ labelText: '\n      First\n      name\n    ' })).name
    ).toBe('First name');
    expect(
      describeScannedElement(rawElement({ description: '  Use the format\n  SW1A 1AA ' }))
        .description
    ).toBe('Use the format SW1A 1AA');
    expect(
      describeScannedElement(
        rawElement({
          tag: 'select',
          options: [{ value: 'GB', label: ' United\n Kingdom ', selected: true }]
        })
      ).options
    ).toEqual([{ value: 'GB', label: 'United Kingdom', selected: true }]);
  });
});

/**
 * A search answered without a Chromium on the machine running the tests.
 *
 * Only the surface the search route actually touches is stood up, and every method answers from
 * data the test supplied, so nothing here waits on a timer or a network. What is being tested is
 * where the search goes and what a challenge costs - both of which are decided on this side.
 */
const isolatedSearchBrowser = (page: {
  url: string;
  title?: string;
  text?: string;
  status?: number;
  headers?: Record<string, string>;
  rows?: RawSearchRow[];
}) => {
  const opened: string[] = [];
  let closed = 0;
  const fake = {
    newContext: async () => ({
      newPage: async () => ({
        goto: async (destination: string) => {
          opened.push(destination);
          return { status: () => page.status ?? 200, headers: () => page.headers ?? {} };
        },
        url: () => page.url,
        title: async () => page.title ?? '',
        locator: () => ({ innerText: async () => page.text ?? '' }),
        frames: () => [{ url: () => page.url }],
        evaluate: async () => page.rows ?? []
      })
    }),
    close: async () => {
      closed += 1;
    }
  };
  return {
    opened,
    closedCount: () => closed,
    launch: async () => fake as unknown as Browser
  };
};

const resultRow = (destination: string): RawSearchRow => ({
  href: `//duckduckgo.com/l/?uddg=${encodeURIComponent(destination)}`,
  title: 'A source',
  snippet: 'What it says.',
  advert: false
});

describe('search route', () => {
  it('answers from a browser of its own, and closes it again', async () => {
    const isolated = isolatedSearchBrowser({
      url: 'https://html.duckduckgo.com/html/?q=uk+corporation+tax',
      title: 'uk corporation tax at DuckDuckGo',
      rows: [resultRow('https://example.invalid/rates')]
    });
    const manager = new BrowserManager({
      maxFileBytes: 1024 * 1024,
      launchIsolatedBrowser: isolated.launch
    });
    const answer = await manager.search(
      'workspace-1',
      { query: 'uk corporation tax', limit: 10 },
      'agent'
    );
    expect(answer.route).toBe('isolated');
    expect(answer.results.map((result) => result.url)).toEqual(['https://example.invalid/rates']);
    expect(isolated.opened).toEqual(['https://html.duckduckgo.com/html/?q=uk%20corporation%20tax']);
    expect(isolated.closedCount()).toBe(1);
  });

  /**
   * The defect this route was rebuilt for. A search used to run in the session browser, which meant
   * it required the agent to be holding it: while the owner used their own Chromium - which athanor
   * tells them they may do at any time - every search failed with "browser control is held by user"
   * and every research task stopped. Nothing here goes near that browser.
   */
  it('searches while the owner is holding their own browser, and never opens the session one', async () => {
    const isolated = isolatedSearchBrowser({
      url: 'https://html.duckduckgo.com/html/?q=board+deck',
      rows: [resultRow('https://example.invalid/deck')]
    });
    const manager = new BrowserManager({
      maxFileBytes: 1024 * 1024,
      launchIsolatedBrowser: isolated.launch,
      // A session browser could only be reached by launching one, and this would refuse to.
      executablePath: '/nonexistent/chromium'
    });
    const answer = await manager.search('workspace-2', { query: 'board deck', limit: 10 }, 'agent');
    expect(answer.results).toHaveLength(1);
  });

  /**
   * The other half of it. A challenge used to close the engine for the whole session, so the first
   * one took every later search off the task - and the tool's own advice, carry on elsewhere, had
   * no elsewhere to point at. It now costs one search, and it says so: the browser wording would
   * claim a stopped tab and a closed site, neither of which is true here, and the agent acts on
   * that sentence.
   */
  it('reports a search challenge as costing the search rather than the web', async () => {
    const challenged = isolatedSearchBrowser({
      url: 'https://html.duckduckgo.com/html/?q=anything',
      title: 'DuckDuckGo',
      text: 'Please complete the following challenge to confirm this search was made by a human.'
    });
    const manager = new BrowserManager({
      maxFileBytes: 1024 * 1024,
      launchIsolatedBrowser: challenged.launch
    });
    const refusal = await manager
      .search('workspace-3', { query: 'anything', limit: 10 }, 'agent')
      .then(() => new Error('the search was answered when it should have been refused'))
      .catch((cause: unknown) => cause as Error);
    // Not a BotWallError: that one reaches the owner's phone as a takeover, and there is no page
    // left to take over - the browser it happened in was closed before this was thrown.
    expect(refusal.name).toBe('SearchWallError');
    expect(refusal.message).toContain('every other tool still work');
    expect(refusal.message).not.toContain('closed to you');
    // Backing off, and saying so from memory rather than launching a second browser to be refused.
    await expect(
      manager.search('workspace-3', { query: 'something else', limit: 10 }, 'agent')
    ).rejects.toThrow('anti-bot challenge instead of results');
    expect(challenged.opened).toHaveLength(1);
    expect(challenged.closedCount()).toBe(1);
  });

  /**
   * The sentence used to end with a prognosis it had no way to make: searching would be available
   * again in about a minute, so search again shortly. That was the backoff timer read out as if it
   * were a forecast. On the deployment athanor is built for it was worse than vague - a server's
   * address is what most engines are refusing, so the next attempt meets the same challenge and the
   * one after that, and every retry the sentence invited cost the owner a turn and a bill to be
   * refused again. The agent acts on this sentence, so it now says only what is known.
   */
  it('does not promise the agent that the same search will work again in a minute', () => {
    const message = searchWallMessage({
      vendor: 'Unnamed bot wall',
      url: 'https://html.duckduckgo.com/html/?q=anything',
      reason: 'page is asking the visitor to prove they are human',
      evidence: 'page'
    });
    for (const promise of ['about a minute', 'shortly', 'again later', 'try again in'])
      expect(message).not.toContain(promise);
    // What it does say: retrying is the one thing that cannot help, and here is what still can.
    expect(message).toContain('refusing this computer, not this query');
    expect(message).toContain('Read a source you already have the address of');
    // And the failure the whole route exists to prevent - an agent that decides the web is gone,
    // stops researching, and starts inventing addresses instead.
    expect(message).toContain('every other tool still work');
    expect(message).toContain('rather than guessing at addresses');
  });

  it('clears the search backoff when the browser session is closed', async () => {
    const challenged = isolatedSearchBrowser({
      url: 'https://html.duckduckgo.com/html/?q=anything',
      title: 'Just a moment...'
    });
    const manager = new BrowserManager({
      maxFileBytes: 1024 * 1024,
      launchIsolatedBrowser: challenged.launch
    });
    await expect(
      manager.search('workspace-4', { query: 'anything', limit: 10 }, 'agent')
    ).rejects.toThrow();
    expect(challenged.closedCount()).toBe(1);
    await manager.close('workspace-4');
    await expect(
      manager.search('workspace-4', { query: 'anything', limit: 10 }, 'agent')
    ).rejects.toThrow();
    // A second launch is the proof: the remembered wall would have answered without one.
    expect(challenged.closedCount()).toBe(2);
  });

  it('refuses an empty query before it launches anything', async () => {
    const isolated = isolatedSearchBrowser({ url: 'https://html.duckduckgo.com/html/' });
    const manager = new BrowserManager({
      maxFileBytes: 1024 * 1024,
      launchIsolatedBrowser: isolated.launch
    });
    await expect(
      manager.search('workspace-5', { query: '   ', limit: 10 }, 'agent')
    ).rejects.toThrow('needs a query');
    expect(isolated.closedCount()).toBe(0);
  });
});
