import type { GuiLease, GuiNamespaceManager } from './gui-namespace.js';
import type { BrowserActionProgress } from './browser-action-journal.js';
import { BrowserTabJournal, recoverableTabUrl } from './browser-tab-journal.js';
import type { BrowserRecovery } from '@garden/contracts';
import { signatureControl } from './human-input.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type {
  Browser,
  BrowserType,
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  Frame,
  Locator,
  Page,
  Response as PageResponse
} from 'playwright-core';
import type {
  OwnerStroke,
  BrowserAction,
  BrowserPrimitiveAction,
  ParallelWebReadResult,
  ResearchReadSource
} from '@garden/contracts';
import type { BrowserTabCleanup, BrowserTabState } from '@garden/contracts';
import { BrowserTabs, AGENT_TAB_LIMIT, TAB_IDLE_MS, TAB_SWEEP_MS } from './browser-tabs.js';
import { assertPublicHttpUrl, isPublicHttpUrl, isPublicInternetAddress } from '@garden/core';
import {
  assertUserDataPath,
  clearStagedUploads,
  createWorkspaceFile,
  stageUserFileForUpload,
  writeWorkspaceFile
} from './files.js';
import { failureCode, runnerLogger } from './log.js';
import {
  duckDuckGoSearchUrl,
  readSearchRows,
  searchResults,
  searchRoutePlan,
  SEARCH_ENGINE,
  SEARCH_WALL_BACKOFF_MS,
  type SearchRoute,
  type WebSearchResult
} from './search.js';
import { DesktopControl } from './holder.js';
import { chromiumDriver } from './playwright.js';

export interface BrowserStreamState {
  recovery?: BrowserRecovery | undefined;
  url: string;
  title: string;
  holder: 'agent' | 'user' | 'secure_input';
  width: number;
  height: number;
  transport: 'chromium_screencast';
  tabs: BrowserTabState[];
  cleanup: BrowserTabCleanup;
  /**
   * The challenge currently waiting for a person, on whichever tab raised it. It rides the stream
   * because a wall is the one browser state nobody can act on but the owner, and the pane is where
   * they are: without it the agent stops on a page nobody is looking at and nothing says so.
   */
  botWall: BotWallReport | null;
  /**
   * The dialog stopping this page, if one is. It rides here for the same reason `botWall` does,
   * and with more urgency: parking a Playwright `Dialog` handle suppresses the auto-dismiss, so
   * the page is *blocked* until something answers - and nothing outside the agent's own `dialog`
   * action ever could. An owner who had taken the browser over and clicked something raising
   * `confirm()` watched the page stop, with no native dialog (Playwright had intercepted it), no
   * error, and no way out but hibernating the browser.
   */
  pendingDialog: { type: string; message: string } | null;
}

interface BrowserStreamSubscriber {
  state: (state: BrowserStreamState) => void;
  frame: (frame: Buffer, state: BrowserStreamState) => void;
}

interface BrowserStream {
  cdp: CDPSession;
  subscribers: Set<BrowserStreamSubscriber>;
}

export interface BrowserDownloadRecord {
  /** Workspace-relative, so the agent and the file browser name the file the same way. */
  path: string | null;
  url: string;
  error?: string;
}

interface BrowserDownloadReceipts {
  downloads: BrowserDownloadRecord[];
  downloadsOmitted: number;
  downloadErrorsOmitted: number;
  downloadsCancelled: number;
}

/** Recent session history and the bounded receipts accumulated during each running action. */
export class BrowserDownloadHistory {
  readonly recent: BrowserDownloadRecord[] = [];
  readonly #collectors = new Set<BrowserDownloadReceipts>();

  record(download: BrowserDownloadRecord, cancelled = false): void {
    this.recent.push(download);
    if (this.recent.length > DOWNLOAD_HISTORY_LIMIT)
      this.recent.splice(0, this.recent.length - DOWNLOAD_HISTORY_LIMIT);
    for (const receipts of this.#collectors) {
      if (cancelled) receipts.downloadsCancelled += 1;
      if (receipts.downloads.length < DOWNLOAD_RECEIPT_LIMIT) receipts.downloads.push(download);
      else if (download.error) receipts.downloadErrorsOmitted += 1;
      else receipts.downloadsOmitted += 1;
    }
  }

  async collect<T>(
    work: (receipts: BrowserDownloadReceipts) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    const receipts: BrowserDownloadReceipts = {
      downloads: [],
      downloadsOmitted: 0,
      downloadErrorsOmitted: 0,
      downloadsCancelled: 0
    };
    const stop = () => {
      this.#collectors.delete(receipts);
    };
    if (!signal.aborted) this.#collectors.add(receipts);
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await work(receipts);
    } finally {
      stop();
      signal.removeEventListener('abort', stop);
    }
  }
}

interface Session {
  gui?: GuiLease | undefined;
  recovery?: BrowserRecovery;
  recoveryTimer?: NodeJS.Timeout;
  recoverySignature?: string;
  ending?: boolean;
  context: BrowserContext;
  page: Page;
  /** The workspace this session belongs to, so shutting it down can clean up after it. */
  root: string;
  /**
   * Stable tab identity. Playwright only offers positional access to context.pages(), and a
   * position changes whenever any other tab closes - so an agent that opened a reference tab,
   * did some work, and came back would act on whatever had shifted into that slot. Ids are
   * minted once per page and never reused, so a stale id fails loudly instead of hitting the
   * wrong page.
   */
  tabs: Map<string, Page>;
  tabLifecycle?: BrowserTabs;
  tabSweep?: NodeJS.Timeout;
  caller?: { owner: 'agent' | 'user'; taskId: string | null };
  creatingTab?: { owner: 'agent' | 'user'; taskId: string | null };
  /**
   * Who holds the screen this browser is drawn on, which is not a fact this file owns any more.
   *
   * It used to be a `holder` field here, set by `setHolder` and read by every gate below - while
   * the desktop kept a `DesktopControl` of its own for the same screen. Two answers, two takeovers,
   * and no relation between them: an owner who took the Computer pane and an agent that still held
   * the browser could both act on the same X server. When a desktop session exists this is that
   * session's control object, so there is one answer and one queue.
   */
  control: DesktopControl;
  /**
   * Serializes the screencast's lifecycle, the way `bridgeQueue` serializes the desktop's bridge.
   *
   * Attaching and detaching a CDP session is several awaits long and three separate callers reach
   * it - a subscriber joining, the last one leaving, and every retarget a tab switch causes. Run
   * concurrently they interleave: two subscribers arriving together each saw no stream and each
   * attached one, the second overwrote `session.stream`, and the first went on acking screencast
   * frames nobody read for the life of the browser.
   */
  streamQueue: Promise<unknown>;
  /** Takes this browser back off its screen's control when the session closes; see `#controlOf`. */
  detachControl?: () => void;
  /** The challenges standing in this browser: which tab is stopped, and which sites are closed. */
  walls: BotWallLedger;
  pendingDialog?: Dialog;
  /**
   * The last title read off the watched page.
   *
   * Cached because `page.title()` is a CDP round trip into the page's own main thread, and the
   * stream used to make one per frame with the frame's ack waiting behind it. Refreshed on the
   * events that can change it - a navigation, a tab switch - which is every case a person would
   * notice, at a cost of one read each instead of thirty a second.
   */
  streamTitle: string;
  consoleMessages: Array<{ level: string; text: string; url: string; at: string }>;
  /**
   * The requests that came back unusable, bounded to `FAILED_REQUEST_LIMIT`.
   *
   * Kept per session rather than per page, exactly as `consoleMessages` is, because a failure
   * raised by a background tab is still the reason the tab in front is not doing what was asked.
   */
  failedRequests: BrowserFailedRequest[];
  stream?: BrowserStream;
  downloadsDirectory: string;
  downloadPublication: Promise<void>;
  downloads: BrowserDownloadHistory;
  pendingDownloads: Set<Promise<void>>;
}

interface ElementPolicyInput {
  tag: string;
  type: string;
  name: string;
  autocomplete: string;
  formAction: string;
  inForm: boolean;
  pageUrl?: string;
}

export interface BrowserActionPreflight {
  handoffKind?: 'signature';
  tabId?: string;
  consequential: boolean;
  sensitiveInput: boolean;
  preview: string;
  destinations?: string[];
}

export interface BrowserSelectOption {
  value: string;
  label: string;
  selected: boolean;
}

/**
 * Everything needed to tell one form field from another and to read back what is in it.
 * The optional members are omitted rather than emitted empty: a snapshot carries up to 250 of
 * these through a truncated tool result, so a key that says nothing costs a control the agent
 * could otherwise have reached.
 */
export interface BrowserSnapshotElement {
  index: number;
  selector: string;
  tag: string;
  role: string | null;
  /** Accessible name: aria-label, aria-labelledby, `<label>`, placeholder, title, then text. */
  name: string;
  type: string | null;
  href: string | null;
  id?: string;
  /** The submitted `name` attribute, which is what a site's own validation messages refer to. */
  field?: string;
  /** Present on every value-bearing control, empty string included: "still empty" is an answer. */
  value?: string;
  /** Present when the returned value is only a prefix; never mistake it for the saved value. */
  valueTruncated?: true;
  valueLength?: number;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  pattern?: string;
  invalid?: boolean;
  /** aria-describedby and aria-errormessage text: the hint or the error the site is showing. */
  description?: string;
  options?: BrowserSelectOption[];
}

export interface BrowserTabSummary {
  tabId: string;
  active: boolean;
  url: string;
  title: string;
}

/**
 * A request this page made that did not come back with something usable.
 *
 * `status` is the HTTP status; `0` means no response arrived at all, which is what a CORS
 * rejection, a DNS failure and an aborted request all look like from here. `at` is carried for
 * the same reason `consoleMessages` carries it: the list survives navigation, so without a
 * timestamp a 404 from the page before this one reads as a failure of the action just taken.
 */
export interface BrowserFailedRequest {
  method: string;
  status: number;
  url: string;
  at: string;
}

export interface BrowserSnapshotParts {
  recovery?: BrowserRecovery | undefined;
  url: string;
  title: string;
  holder: 'agent' | 'user' | 'secure_input';
  botWall: BotWallReport | null;
  elements: BrowserSnapshotElement[];
  /**
   * Interactive elements this page had that `elements` does not carry, and frames it has that
   * were not scanned at all.
   *
   * The scan stops at `SNAPSHOT_ELEMENT_LIMIT` and at `SNAPSHOT_FRAME_LIMIT`, and the elements it
   * drops are the ones at the END of the document - which is exactly where consent, payment and
   * submit frames live. Without a count the model reads a truncated list as a complete one and
   * concludes the control it wants does not exist, which is a wrong answer rather than a slow one.
   * `desktop_observe` has paid for this since it started selecting nodes (`nodesOmitted` in
   * `desktop.ts`); this is the same number on the browser surface, computed the same way.
   */
  elementsOmitted: number;
  framesOmitted: number;
  tabs: BrowserTabSummary[];
  downloads: BrowserDownloadRecord[];
  pendingDialog: { type: string; message: string } | null;
  consoleMessages: Array<{ level: string; text: string; url: string; at: string }>;
  /**
   * The requests that failed, which the console alone does not report.
   *
   * A submit answered 403, an XHR refused by CORS and a navigation bounced through an auth wall
   * are all invisible in a snapshot that carries only console output, and all three look to the
   * model exactly like "the site rejected my values" - which sends it back to re-type fields that
   * were already correct. Empty on a page where nothing failed, so it costs nothing until it is
   * the answer.
   */
  failedRequests: BrowserFailedRequest[];
  images: Array<{ url: string; alt: string; width: number; height: number }>;
  screenshotBase64: string;
  text: string;
}

// The worker truncates a serialized tool result to a fixed budget, keeping the head and
// the tail, so a long page body placed early destroys everything after it. Page text is
// therefore emitted last and bounded, leaving the actionable fields intact.
export const BROWSER_SNAPSHOT_TEXT_LIMIT = 12_000;
type SnapshotCursor = { offset?: number | undefined; sha256?: string | undefined };
const continuesSnapshotText = (text: string, cursor: SnapshotCursor) =>
  (cursor.offset ?? 0) > 0 && cursor.sha256 === createHash('sha256').update(text).digest('hex');

export const composeBrowserSnapshot = (
  parts: BrowserSnapshotParts,
  cursor: SnapshotCursor = {}
) => {
  const digest = createHash('sha256').update(parts.text).digest('hex');
  const changed = Boolean(cursor.sha256 && cursor.sha256 !== digest);
  const offset = changed
    ? 0
    : Math.min(parts.text.length, Math.max(0, Math.trunc(cursor.offset ?? 0)));
  const end = Math.min(parts.text.length, offset + BROWSER_SNAPSHOT_TEXT_LIMIT);
  const continuation = offset > 0 && cursor.sha256 === digest;
  return {
    url: parts.url,
    title: parts.title,
    holder: parts.holder,
    botWall: parts.botWall,
    elements: parts.elements,
    elementsOmitted: parts.elementsOmitted,
    framesOmitted: parts.framesOmitted,
    tabs: parts.tabs,
    ...(parts.recovery ? { recovery: parts.recovery } : {}),
    downloads: parts.downloads,
    pendingDialog: parts.pendingDialog,
    consoleMessages: parts.consoleMessages,
    failedRequests: parts.failedRequests,
    images: parts.images,
    screenshotBase64: continuation ? '' : parts.screenshotBase64,
    ...(continuation ? { screenshotOmitted: 'text_continuation' as const } : {}),
    textComplete: end >= parts.text.length,
    textOmitted: Math.max(0, parts.text.length - end),
    textRange: { offset, end, total: parts.text.length, sha256: digest },
    ...(end < parts.text.length ? { nextTextOffset: end } : {}),
    ...(changed ? { textChanged: true } : {}),
    text: parts.text.slice(offset, end)
  };
};

/** Popups must not steal the agent's page; adopt one only once the current page is gone. */
export const shouldAdoptNewPage = (current: Pick<Page, 'isClosed'> | undefined): boolean =>
  !current || current.isClosed();

/** How long an action waits for a download it started before reporting without it. */
const DOWNLOAD_SETTLE_MS = 15_000;
const DOWNLOAD_START_GRACE_MS = 250;
const DOWNLOAD_HISTORY_LIMIT = 25;
// A page can start many downloads from one click. Bound retained receipts and concurrent saves
// independently; omitted successful receipts remain recoverable in the workspace download folder.
const DOWNLOAD_RECEIPT_LIMIT = 100;
const DOWNLOAD_SAVE_LIMIT = 64;
const SNAPSHOT_FRAME_LIMIT = 12;
const SNAPSHOT_ELEMENT_LIMIT = 250;
/** Matches the `innerText` bound beside the scans this covers (`browser.ts` `#scanPage`). */
const PAGE_SCRIPT_TIMEOUT_MS = 5_000;
/** Short, because a stale title in the pane is cosmetic and a stalled one used to be a freeze. */
const STREAM_TITLE_TIMEOUT_MS = 250;
/**
 * How many failed requests a session remembers.
 *
 * Fifteen because the list exists to explain the action just taken, not to be a network log: a
 * form submit that fails produces one or two entries, and a page whose whole API is down produces
 * the same two repeated. Repeats are collapsed rather than counted (see `recordFailedRequest`),
 * so fifteen distinct method+status+url pairs is several actions' worth of history. Each entry is
 * about 250 bytes serialized, so the whole list is under 4 KB against a snapshot that already
 * carries a JPEG and 12,000 characters of page text.
 */
const FAILED_REQUEST_LIMIT = 15;
/** URLs on a failed request are for recognising which call failed, not for re-issuing it. */
const FAILED_REQUEST_URL_LIMIT = 200;
/**
 * How long the settle protocol waits for `load`, and how long it then sits still in the page.
 *
 * Both numbers are Playwright MCP's `waitForCompletion`, which `docs/design/browser-automation.md`
 * §4b tells this repository to copy verbatim, and they replace `waitForLoadState('networkidle')` -
 * banned by name in that document - in its ban list and again in its pitfalls - because it is
 * deprecated and never fires on a
 * page holding a websocket or a long poll. Measured on such a page, the old fallback burned its
 * full 15,000 ms and then threw, while a selector wait on the same page resolved in 72 ms.
 *
 * The sleep runs with `page.evaluate` rather than a Node timer on purpose: it doubles as a probe
 * that the page's own JavaScript thread is still running, which a Node timer cannot tell you.
 */
const PAGE_SETTLE_MS = 500;
const PAGE_LOAD_WAIT_MS = 10_000;

/**
 * Remembers one failed request, most recent last, without letting noise crowd the list out.
 *
 * Noise arrives in two shapes and each needs its own defence. The first is one URL repeated: a page
 * whose API is down retries the same call on a timer, and fifteen copies of that line would bury
 * the 403 on the submit that is the actual answer, so a repeat moves to the end with a fresh
 * timestamp instead of taking a second slot - which is also what makes the timestamp mean "last
 * seen" rather than "first seen".
 *
 * The second shape is DISTINCT urls, and collapsing does nothing about it. An analytics beacon, an
 * ad pixel and a CDN hop each carry a cache-buster, so every one is a different URL and every one
 * takes its own slot. Measured against a real Chromium: a page that fired twenty such cross-origin
 * requests after one 403 on a form submit had evicted the 403 by the time the snapshot was taken,
 * which is the one entry this whole list exists to carry. So the bound sheds the SOFT entries
 * first - a 3xx that merely crossed an origin, and a request that got no response at all, are
 * context - and keeps every 4xx and 5xx, which is a site refusing something the agent did. A soft
 * entry arriving into a list already full of hard ones is therefore dropped rather than admitted;
 * that is the same rule seen from the other end, not a second one.
 *
 * Exported for the tests that pin the bound, the collapsing and the shedding; the production
 * callers are the `response` and `requestfailed` listeners `attachPage` registers.
 */
export const recordFailedRequest = (
  session: Pick<Session, 'failedRequests'>,
  method: string,
  status: number,
  url: string
): void => {
  const entry = {
    method,
    status,
    // Trimmed because this exists to say WHICH call failed, not to be re-issued: a signed URL or
    // a data URI would otherwise put kilobytes of query string into every snapshot.
    url: url.slice(0, FAILED_REQUEST_URL_LIMIT),
    at: new Date().toISOString()
  };
  const existing = session.failedRequests.findIndex(
    (seen) => seen.method === entry.method && seen.status === entry.status && seen.url === entry.url
  );
  if (existing >= 0) session.failedRequests.splice(existing, 1);
  session.failedRequests.push(entry);
  while (session.failedRequests.length > FAILED_REQUEST_LIMIT) {
    // The oldest SOFT entry goes first, and only when there is none does the oldest hard one go.
    // See the note above for the measurement: plain age is what let ordinary cross-origin noise
    // push out the failure the agent needed. `status < 400` is the whole test - a 3xx recorded
    // for crossing an origin, or a 0 for a request that got no response.
    const soft = session.failedRequests.findIndex((seen) => seen.status < 400);
    session.failedRequests.splice(soft >= 0 ? soft : 0, 1);
  }
};

/**
 * A deadline for a promise that has none of its own.
 *
 * `page.evaluate` and `frame.evaluate` take no `timeout` option and inherit none from
 * `setDefaultTimeout` - unlike `locator.evaluate`, which is why the calls beside them look bounded
 * and these were not. On a page whose main thread is blocked the promise never settles, so
 * `browser_snapshot` sat there until the worker's own 65-minute tool ceiling, indistinguishable
 * from a slow page. Nothing here can abort the page's script; what it bounds is how long this
 * process is willing to wait for it, which is the part that was missing.
 */
const withDeadline = async <T>(work: Promise<T>, milliseconds: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), milliseconds);
    })
  ]);
  if (timer) clearTimeout(timer);
  return settled;
};

const captureScreenshot = async (page: Page, type: 'jpeg' | 'png'): Promise<Buffer> => {
  const capture = () => page.screenshot(type === 'jpeg' ? { type, quality: 72 } : { type });
  return capture().catch(async (error: unknown) => {
    if (
      !(error instanceof Error) ||
      !error.message.includes(
        'Protocol error (Page.captureScreenshot): Unable to capture screenshot'
      ) ||
      page.isClosed()
    )
      throw error;
    // A headed renderer can refuse its first capture before its compositor presents a frame.
    // Give that frame a bounded opportunity to render, then make exactly one further attempt.
    await withDeadline(
      page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          })
      ),
      250,
      undefined
    );
    if (page.isClosed()) throw error;
    return capture();
  });
};

/**
 * Waits for the page to stop changing, without asking the network to go quiet.
 *
 * This is the protocol `docs/design/browser-automation.md` §4b prescribes and the replacement for
 * the `networkidle` wait that document bans: wait for `load`, which fires once the document and
 * its subresources are in, then sit still inside the page long enough for the frame the load
 * triggered to render.
 *
 * It does NOT wait for anything a script fetches after load - a single-page application still
 * populating a list is not covered, and the answer there is a `wait_for` naming the selector or
 * the text being waited on, which resolves as soon as the thing arrives instead of guessing.
 *
 * Nothing here throws. A page that never fires `load` reports that it did not, because the caller
 * is usually a step inside a batch, and a thrown step takes every step after it with it - which is
 * how one badly-chosen wait used to cost a form fill as well as fifteen seconds.
 */
const settlePage = async (page: Page, loadTimeout: number): Promise<boolean> => {
  const loaded = await page
    .waitForLoadState('load', { timeout: loadTimeout })
    .then(() => true)
    .catch(() => false);
  // `page.evaluate` takes no timeout of its own, so the deadline is this side's; see `withDeadline`.
  await withDeadline(
    page.evaluate(
      (milliseconds: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }),
      PAGE_SETTLE_MS
    ),
    PAGE_SETTLE_MS * 4,
    undefined
  );
  return loaded;
};

/**
 * Ref numbers are handed out from a counter that never rewinds, so a number names one control until
 * that control leaves the page.
 *
 * The scan used to clear every `data-garden-ref` in the whole document and then re-stamp from zero
 * inside whatever scope it had been given. A scoped re-read - which is the cheap loop the
 * form-filling procedure teaches - therefore silently re-pointed every ref the agent was holding:
 * `oc-0-3` had been Submit and became Postcode, and the next click landed on a different control
 * with nothing anywhere reporting that anything had changed. It is the highest-frequency silent
 * wrong action the product had.
 *
 * A counter costs nothing and removes the whole class: an element that already carries a ref keeps
 * it, a new element gets a number never used before, and a number that has gone is simply gone.
 */
let nextRefNumber = 0;
const reserveRefBlock = (size: number): number => {
  const seed = nextRefNumber;
  nextRefNumber += Math.max(0, size);
  return seed;
};
/**
 * Labels are scanned so their text can be folded onto the control they name, and so a control a
 * site has hidden behind a styled label still has a handle. Most of them are dropped again once
 * folded, so the scan takes this much headroom over the caller's budget to spend on them.
 */
const LABEL_FOLD_OVERSCAN = 64;
/**
 * `[onclick]` is the cheap half of "see what the page treats as clickable".
 *
 * A `<div onclick=...>` is a real control that declares nothing about itself, and it was invisible
 * to a scan built from tag names and ARIA roles - while `resolveBrowserTarget` clicks one happily
 * when handed a selector, so the agent could act on controls it could not see. The attribute form
 * is one more CSS chunk and costs nothing.
 *
 * It does NOT catch a listener registered with `addEventListener`, which is the more common shape.
 * Seeing those needs `DOMDebugger.getEventListeners` over CDP, one round trip per node, which is
 * not affordable at 250 nodes inside `PAGE_SCRIPT_TIMEOUT_MS`; that half is deliberately not built.
 */
const INTERACTIVE_ELEMENT_QUERY =
  'a[href],button,input,textarea,select,label,summary,[onclick],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="combobox"],[contenteditable="true"]';
/**
 * How far the scan descends through open shadow roots.
 *
 * Four, because a component library nests at most a couple of levels before it is rendering leaf
 * markup - the measured fixture (a card whose shadow root contains a component whose shadow root
 * contains the link) needs two - and because the depth is what bounds a pathological page. The
 * walk that uses it is priced in `scanFrameElements`.
 */
const SHADOW_PIERCE_DEPTH = 4;
/**
 * How many closed-shadow-root hosts one frame may report.
 *
 * A closed root cannot be read at all, so the entry says only "something is here that cannot be
 * listed" - useful once, noise fifteen times, and every one of them spends a slot in the
 * 250-element budget that a readable control could have had. Five is enough for the shape this
 * exists for: a payment or consent widget the page has closed off.
 */
const CLOSED_SHADOW_ENTRY_LIMIT = 5;

/**
 * The downloading site chooses this name, so it is hostile input: reduce it to one plain
 * filename component that cannot climb out of the session's download directory.
 */
export const downloadFileName = (suggested: string): string => {
  const segment = path.basename(suggested.replace(/\\/g, '/'));
  const cleaned = segment
    // eslint-disable-next-line no-control-regex -- control characters are exactly what to strip.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'download';
};

const saveDownloadFile = async (
  root: string,
  directory: string,
  name: string,
  content: Buffer,
  maxBytes: number
): Promise<string> => {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length) || 'download';
  for (let attempt = 0; attempt <= 50; attempt += 1) {
    const candidate =
      attempt === 0 ? name : `${stem}-${attempt === 50 ? randomUUID() : attempt}${extension}`;
    const relative = path.join(directory, candidate);
    try {
      await createWorkspaceFile(root, relative, content, maxBytes);
      return relative;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('A new download filename could not be reserved');
};

/** The frame ordinal baked into a snapshot ref, used as the first place to look for it. */
export const refFrameOrdinal = (selector: string): number | null => {
  const ordinal = /data-garden-ref="oc-(\d+)-\d+"/.exec(selector)?.[1];
  return ordinal === undefined ? null : Number(ordinal);
};

/**
 * page.locator() only sees the main frame, so a control inside a payment or consent iframe is
 * otherwise unreachable. Playwright exposes every frame — including cross-origin ones — as a
 * first-class frame, so the ref is looked up frame by frame, preferring the frame it was
 * scanned from. The main-frame locator remains the fallback so a ref for an element that has
 * not rendered yet still gets Playwright's normal auto-waiting.
 */
export const resolveBrowserTarget = async (
  page: Page,
  selector: string,
  allowAbsent = false
): Promise<Locator> => {
  const frames = page.frames();
  const preferredOrdinal = refFrameOrdinal(selector);
  // A hand-written selector is the caller's own, and Playwright's auto-wait is exactly what it
  // wants: the element may not have rendered yet. Only a ref this scan minted is held to the rules
  // below, because only a ref carries the promise that it names one particular control.
  if (preferredOrdinal === null) return page.locator(selector).first();
  const preferred = frames[preferredOrdinal];
  const ordered = preferred
    ? [preferred, ...frames.filter((frame) => frame !== preferred)]
    : frames;
  for (const frame of ordered) {
    const locator = frame.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 1) return locator;
    // Two elements answering to one ref means the page moved a node between frames, or a document
    // was re-rendered while the scan was reading it. Acting on `.first()` is a coin toss on the
    // owner's behalf, and the recoverable answer is to look again.
    if (count > 1)
      throw new Error(
        `${selector} matches ${count} elements, so it no longer names one control - snapshot the page again`
      );
  }
  if (allowAbsent) return (preferred ?? page).locator(selector);
  // A ref that has gone is the ordinary consequence of the page moving on. Said plainly and
  // immediately, rather than spending the turn's clock inside Playwright's auto-wait for an element
  // that is never coming back.
  throw new Error(`${selector} is no longer on the page - snapshot it again to get current refs`);
};

export type ScannedElement = Omit<BrowserSnapshotElement, 'index' | 'selector'> & { ref: string };

/**
 * One element exactly as the page reports it. The page does extraction only — every judgement
 * about what to keep, what to name it and what to redact is made here in the runner, where it
 * can be tested without a browser.
 */
export interface RawScannedElement {
  ref: string;
  tag: string;
  role: string | null;
  ariaLabel: string;
  labelledByText: string;
  labelText: string;
  placeholder: string;
  title: string;
  text: string;
  type: string | null;
  href: string | null;
  elementId: string;
  fieldName: string;
  /** Whether this element holds a value at all, which is not the same as holding a non-empty one. */
  valueBearing: boolean;
  value: string;
  password: boolean;
  checked: boolean | null;
  disabled: boolean;
  required: boolean;
  maxLength: number | null;
  pattern: string;
  invalid: boolean;
  description: string;
  options: BrowserSelectOption[] | null;
  /** For a `<label>`, the ref of the control it names, when that control was scanned too. */
  labelFor: string | null;
  /**
   * This element is a custom element that draws itself out of a shadow root nothing can open.
   *
   * The scan pierces OPEN roots, so those need no marking; a closed one is genuinely unreadable
   * and the honest report is that something is there. It is a heuristic and it can be wrong: the
   * page-side test is a hyphenated tag with a visible box, no child elements, no text and no
   * `shadowRoot`, which a custom element painting itself with a CSS background also satisfies.
   * Being wrong costs one entry that says it cannot be read, which is why it is capped rather
   * than tightened into something that would miss the real ones.
   */
  closedShadowRoot: boolean;
}

/**
 * Page text arrives with the source's own line breaks and indentation in it. Normalising here
 * rather than in the page keeps the page function free of named helpers, which the development
 * transpiler rewrites into calls that do not exist inside a browser.
 */
const flatten = (value: string): string => value.replace(/\s+/g, ' ').trim();

const ELEMENT_NAME_LIMIT = 160;
const ELEMENT_VALUE_LIMIT = 200;
const FORM_VALUE_LIMIT = 4_000;
const ELEMENT_DESCRIPTION_LIMIT = 300;
const ELEMENT_OPTION_LIMIT = 200;

/**
 * A password never leaves the browser in a tool result, but "is this field filled, and with how
 * much" is exactly what a form checker needs, so the length is reported and the text is not.
 */
export const redactPasswordValue = (value: string): string =>
  value.length ? `${value.length} characters entered` : '';

/**
 * What a closed-root host is told to the model. Written here rather than in the page because the
 * page does extraction only, and because this sentence is the whole of the entry's value.
 */
const CLOSED_SHADOW_DESCRIPTION =
  'This element draws itself from a closed shadow root, so its contents cannot be listed. Click the element itself, or act on it by coordinates from the screenshot.';

export const describeScannedElement = (
  raw: RawScannedElement,
  valueLimit = ELEMENT_VALUE_LIMIT
): ScannedElement => {
  const name =
    [raw.ariaLabel, raw.labelledByText, raw.labelText, raw.placeholder, raw.title, raw.text]
      .map(flatten)
      .find((candidate) => candidate.length > 0) ?? '';
  if (raw.closedShadowRoot)
    return {
      ref: raw.ref,
      tag: raw.tag,
      role: raw.role,
      name: name.slice(0, ELEMENT_NAME_LIMIT) || raw.tag,
      type: raw.type,
      href: null,
      ...(raw.elementId ? { id: raw.elementId } : {}),
      description: CLOSED_SHADOW_DESCRIPTION
    };
  return {
    ref: raw.ref,
    tag: raw.tag,
    role: raw.role,
    name: name.slice(0, ELEMENT_NAME_LIMIT),
    type: raw.type,
    href: raw.href,
    ...(raw.elementId ? { id: raw.elementId } : {}),
    ...(raw.fieldName ? { field: flatten(raw.fieldName) } : {}),
    ...(raw.valueBearing
      ? {
          value: raw.password ? redactPasswordValue(raw.value) : raw.value.slice(0, valueLimit),
          ...(!raw.password && raw.value.length > valueLimit
            ? { valueTruncated: true as const, valueLength: raw.value.length }
            : {})
        }
      : {}),
    ...(raw.checked === null ? {} : { checked: raw.checked }),
    ...(raw.disabled ? { disabled: true } : {}),
    ...(raw.required ? { required: true } : {}),
    ...(raw.maxLength !== null && raw.maxLength >= 0 ? { maxLength: raw.maxLength } : {}),
    ...(raw.pattern ? { pattern: raw.pattern } : {}),
    ...(raw.invalid ? { invalid: true } : {}),
    ...(flatten(raw.description)
      ? { description: flatten(raw.description).slice(0, ELEMENT_DESCRIPTION_LIMIT) }
      : {}),
    ...(raw.options
      ? {
          options: raw.options
            .slice(0, ELEMENT_OPTION_LIMIT)
            .map((option) => ({ ...option, label: flatten(option.label) }))
        }
      : {})
  };
};

/**
 * A `<label>` is dropped once its control is in the list, because the label's own text is already
 * on that control and two entries for one field is how an agent ends up filling the wrong one. A
 * label whose control was not scanned is kept: sites routinely style a label over an input of zero
 * size, and then the label is the only thing that can be clicked.
 */
export const foldScannedElements = (
  raw: RawScannedElement[],
  limit: number,
  valueLimit = ELEMENT_VALUE_LIMIT
): { kept: ScannedElement[]; folded: number } => {
  const scanned = new Set(raw.map((entry) => entry.ref));
  const standing = raw.filter(
    (entry) => !(entry.tag === 'label' && entry.labelFor !== null && scanned.has(entry.labelFor))
  );
  return {
    kept: standing.slice(0, limit).map((entry) => describeScannedElement(entry, valueLimit)),
    // What was dropped as a duplicate rather than lost to the budget. The caller subtracts it,
    // because a folded label is still represented - its text is on the control it names - and
    // counting it as omitted would report a page of labelled inputs as half missing.
    folded: raw.length - standing.length
  };
};

/** What one frame's page-side extraction hands back: the window, and how much there was. */
interface RawFrameScan {
  elements: RawScannedElement[];
  /**
   * Visible interactive elements the frame's whole tree holds, open shadow roots included, before
   * the budget cut anything. Counted exactly rather than estimated, which is why the walk runs to
   * the end of the tree even once it has stopped collecting - priced in `scanFrameElements`.
   */
  matched: number;
}

const scanFrameElements = async (
  frame: Frame,
  ordinal: number,
  limit: number,
  rootSelector?: string,
  valueLimit = ELEMENT_VALUE_LIMIT
): Promise<{ elements: ScannedElement[]; omitted: number }> => {
  const raw = await withDeadline(
    frame
      .evaluate<
        RawFrameScan,
        {
          query: string;
          prefix: string;
          limit: number;
          root: string | null;
          seed: number;
          depth: number;
          closedLimit: number;
        }
      >(
        // Extraction only, and deliberately written without a single named inner function: the
        // development transpiler rewrites those into calls to a helper that does not exist inside
        // a page, and the whole scan then fails silently. Text arrives unnormalised; the runner
        // tidies and judges it, where that can be tested without a browser.
        ({ query, prefix, limit: budget, root, seed, depth: maxDepth, closedLimit }) => {
          const scope: ParentNode | null = root ? document.querySelector(root) : document;
          if (!scope) return { elements: [], matched: 0 };
          const visible: HTMLElement[] = [];
          // The hosts whose contents nothing can read, so the runner can say so on the entry.
          const opaque = new Set<HTMLElement>();
          let matched = 0;
          let opaqueSeen = 0;
          /*
           * A walk rather than one `querySelectorAll`, because `querySelectorAll` stops at a shadow
           * boundary and returns nothing inside an open root - while Playwright's CSS engine
           * pierces open roots, so the agent could already click controls this scan could not see.
           * Web components are ordinary in payment widgets, design systems and government portals.
           *
           * Document order is preserved across the boundary: a host's shadow tree is walked at the
           * point the host itself is reached, so the budget cuts the end of the page and not the
           * components in the middle of it.
           *
           * The per-element test is a Set lookup, not `element.matches(query)`. One native
           * `querySelectorAll` per root does the selector work in C++ and the walk only asks
           * whether it produced this node, which is what keeps the whole thing cheap.
           */
          const stack = [
            {
              direct: new Set<Element>(scope.querySelectorAll(query)),
              nodes: scope.querySelectorAll('*'),
              at: 0,
              depth: 0
            }
          ];
          while (stack.length) {
            const level = stack[stack.length - 1];
            if (!level) break;
            if (level.at >= level.nodes.length) {
              stack.pop();
              continue;
            }
            const element = level.nodes[level.at] as HTMLElement | undefined;
            level.at += 1;
            if (!element) continue;
            const shadow = element.shadowRoot;
            if (level.direct.has(element)) {
              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                matched += 1;
                if (visible.length < budget) visible.push(element);
              }
            } else if (
              // A custom element with no open root, no children of its own and no text, that
              // nevertheless occupies space, is drawing itself out of a closed root. The test is a
              // heuristic - see `RawScannedElement.closedShadowRoot` for what it can be wrong
              // about - and the cap is why being wrong stays cheap.
              !shadow &&
              opaqueSeen < closedLimit &&
              element.tagName.includes('-') &&
              !element.firstElementChild &&
              !(element.textContent ?? '').trim()
            ) {
              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                opaqueSeen += 1;
                matched += 1;
                if (visible.length < budget) {
                  opaque.add(element);
                  visible.push(element);
                }
              }
            }
            if (shadow && level.depth < maxDepth)
              stack.push({
                direct: new Set<Element>(shadow.querySelectorAll(query)),
                nodes: shadow.querySelectorAll('*'),
                at: 0,
                depth: level.depth + 1
              });
          }
          // Every ref is assigned before anything is read, so a label can report the ref of the
          // control it names even when that control comes later in document order. An element that
          // already carries one keeps it: that is what makes a ref survive a scoped re-read, which
          // used to renumber the whole page from zero. Only a number belonging to another frame is
          // replaced, which can happen when a document is moved between frames.
          let offset = 0;
          const taken = new Set<string>();
          for (const element of visible) {
            const existing = element.getAttribute('data-garden-ref') ?? '';
            if (existing.startsWith(`${prefix}-`) && !taken.has(existing)) {
              taken.add(existing);
              continue;
            }
            const assigned = `${prefix}-${seed + offset}`;
            offset += 1;
            taken.add(assigned);
            element.setAttribute('data-garden-ref', assigned);
          }
          const elements = visible.map((element) => {
            const field = element as HTMLInputElement;
            const select = element instanceof HTMLSelectElement ? element : null;
            const labels = field.labels ? Array.from(field.labels) : [];
            const wrapping = element.closest('label');
            const named = labels[0] ?? (wrapping === element ? null : wrapping);
            const control = element instanceof HTMLLabelElement ? element.control : null;
            const valueBearing =
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement ||
              element.isContentEditable;
            return {
              // Read back rather than recomputed: the element may be carrying a ref from an earlier
              // scan, which is the whole point of not clearing them.
              ref: element.getAttribute('data-garden-ref') ?? '',
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute('role'),
              ariaLabel: element.getAttribute('aria-label') ?? '',
              labelledByText: (element.getAttribute('aria-labelledby') ?? '')
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => document.getElementById(id)?.innerText ?? '')
                .filter(Boolean)
                .join(' '),
              labelText: named?.innerText ?? '',
              placeholder: element.getAttribute('placeholder') ?? '',
              title: element.getAttribute('title') ?? '',
              text: (element.innerText ?? '').slice(0, 400),
              type: element.getAttribute('type'),
              href: element instanceof HTMLAnchorElement ? element.href : null,
              elementId: element.id,
              fieldName: element.getAttribute('name') ?? '',
              valueBearing,
              value: valueBearing
                ? element.isContentEditable && !select
                  ? (element.innerText ?? '')
                  : (field.value ?? '')
                : '',
              password: element instanceof HTMLInputElement && element.type === 'password',
              checked:
                element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
                  ? element.checked
                  : element.getAttribute('aria-checked') === null
                    ? null
                    : element.getAttribute('aria-checked') === 'true',
              disabled: field.disabled === true || element.getAttribute('aria-disabled') === 'true',
              required: field.required === true || element.getAttribute('aria-required') === 'true',
              maxLength:
                element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                  ? element.maxLength
                  : null,
              pattern: element instanceof HTMLInputElement ? element.pattern : '',
              invalid: element.getAttribute('aria-invalid') === 'true',
              description: [
                ...(element.getAttribute('aria-describedby') ?? '').split(/\s+/),
                ...(element.getAttribute('aria-errormessage') ?? '').split(/\s+/)
              ]
                .filter(Boolean)
                .map((id) => document.getElementById(id)?.innerText ?? '')
                .filter(Boolean)
                .join(' '),
              options: select
                ? Array.from(select.options).map((option) => ({
                    value: option.value,
                    label: option.label || option.text,
                    selected: option.selected
                  }))
                : null,
              labelFor: control?.getAttribute('data-garden-ref') ?? null,
              closedShadowRoot: opaque.has(element)
            };
          });
          return { elements, matched };
        },
        {
          query: INTERACTIVE_ELEMENT_QUERY,
          prefix: `oc-${ordinal}`,
          limit: limit + LABEL_FOLD_OVERSCAN,
          root: rootSelector ?? null,
          // Reserved before the page is touched, so two scans can never hand out the same number even
          // if one of them fails part-way through.
          seed: reserveRefBlock(limit + LABEL_FOLD_OVERSCAN),
          depth: SHADOW_PIERCE_DEPTH,
          closedLimit: CLOSED_SHADOW_ENTRY_LIMIT
        }
      )
      // A frame can navigate or detach mid-scan; losing one frame must not lose the snapshot. Said
      // out loud because the failure is otherwise indistinguishable from a page with no controls,
      // which is exactly how a broken scan stayed invisible while the agent kept working blind.
      // The `.catch` handles a rejection; it does not handle a frame whose main thread never comes
      // back to run this at all, which is what the deadline around it is for.
      .catch((cause: unknown) => {
        runnerLogger.warn('browser.frame_scan_failed', { code: failureCode(cause) });
        return { elements: [], matched: 0 } satisfies RawFrameScan;
      }),
    PAGE_SCRIPT_TIMEOUT_MS,
    { elements: [], matched: 0 }
  );
  const folded = foldScannedElements(raw.elements, limit, valueLimit);
  /*
   * What the page had and this list does not carry.
   *
   * `matched` counts every visible interactive element in the frame; `folded` is the labels
   * dropped onto the controls they name, which are represented rather than missing; `kept` is what
   * survived the budget. A frame whose whole tree fits reports zero, which is the common case.
   *
   * When the page-side window itself was cut - `matched` above `limit + LABEL_FOLD_OVERSCAN` -
   * labels past that window are counted as omitted controls, because nothing outside the window
   * was read closely enough to know they were labels. That errs towards saying more is missing
   * than is, which is the safe direction for a number whose whole job is to stop the model
   * concluding a control does not exist.
   */
  return {
    elements: folded.kept,
    omitted: Math.max(0, raw.matched - folded.folded - folded.kept.length)
  };
};

/*
 * Whether a source the agent was told to read is out on the internet.
 *
 * This used to be a second implementation living here, and the two had already drifted apart in
 * both directions: this copy refused unassigned IPv6 that core allowed, and allowed part of
 * 192.0.0.0/16 that core refused. One of them was always going to be the one missing a range, so
 * there is one, in @garden/core, shared with the connector and mail paths.
 */

/** The wire shape lives in @garden/contracts, where the worker reads it from too. */
export type ResearchReadResult = ResearchReadSource;

/** Below this a page has said nothing, whatever the parse thought of it. */
const THIN_SOURCE_CHARACTERS = 500;
const SCRIPT_REQUIRED_TEXT =
  /\b(?:enable javascript|javascript is (?:required|disabled)|requires javascript|turn on javascript|checking your browser)\b/i;

export const needsScriptedRender = (text: string): boolean =>
  text.trim().length < THIN_SOURCE_CHARACTERS || SCRIPT_REQUIRED_TEXT.test(text);

/**
 * What a research read is allowed to fetch. Documents always; scripts only on the retry and only
 * from the document's own origin, which keeps a page's own bundle in reach without turning the
 * research fan-out into a general fetcher for whatever a third party wants to serve.
 */
export const researchResourceAllowed = (input: {
  resourceType: string;
  requestUrl: string;
  documentOrigin: string;
  scripts: boolean;
}): boolean => {
  if (input.resourceType === 'document') return true;
  if (!input.scripts || !['script', 'xhr', 'fetch'].includes(input.resourceType)) return false;
  try {
    return new URL(input.requestUrl).origin === input.documentOrigin;
  } catch {
    return false;
  }
};

export interface BotWall {
  vendor: string;
  url: string;
  /** What was recognised, so the owner is told why their browser stopped rather than just that. */
  reason: string;
  /**
   * Where the evidence was. Page evidence can be looked at again, so a challenge that passes on
   * its own clears itself. Response evidence arrived in headers only a fresh request would produce
   * again - and a fresh request is exactly the retry that must not happen - so it stands until the
   * tab leaves the page or the owner deals with it.
   */
  evidence: 'page' | 'response';
}

/** A wall as everything outside the runner sees it: the pane, the worker, and the owner's phone. */
export interface BotWallReport extends BotWall {
  /** Which tab is stopped, so the owner can be offered exactly that one to open. */
  tabId: string | null;
}

/**
 * Carries the wall through the HTTP boundary as data rather than as a sentence in an error string,
 * so the worker can raise it with the owner instead of parsing prose.
 */
export class BotWallError extends Error {
  constructor(readonly wall: BotWallReport) {
    super(botWallMessage(wall));
    this.name = 'BotWallError';
  }
}

/**
 * A challenge the search route walked into, which is deliberately not the same failure.
 *
 * A wall in the session browser is a page standing open on the owner's screen that only they can
 * clear, so it crosses the wire as data and reaches their phone. A wall in the search route is a
 * results page in a browser that has already been closed: there is nothing to take over and nobody
 * needs to be interrupted. Raising the first for the second would page an owner about a page that
 * no longer exists.
 */
export class SearchWallError extends Error {
  constructor(readonly wall: BotWall) {
    super(searchWallMessage(wall));
    this.name = 'SearchWallError';
  }
}

/**
 * Recognising an anti-bot challenge, so the agent stops instead of reloading into a harder block.
 * This is detection only: nothing here works around a challenge, and nothing may be added that
 * does. The cost of getting it wrong is the owner's own address and account reputation, which is
 * why the agent is taken off the page entirely rather than told to try something else.
 */
const BOT_WALL_FRAMES: Array<{ vendor: string; pattern: RegExp }> = [
  { vendor: 'Cloudflare Turnstile', pattern: /challenges\.cloudflare\.com/i },
  { vendor: 'hCaptcha', pattern: /\bhcaptcha\.com/i },
  { vendor: 'reCAPTCHA', pattern: /google\.com\/recaptcha|recaptcha\.net/i },
  { vendor: 'DataDome', pattern: /captcha-delivery\.com|datadome\.co/i },
  { vendor: 'Arkose Labs', pattern: /arkoselabs\.com|funcaptcha\.com/i },
  { vendor: 'PerimeterX', pattern: /perimeterx\.net|px-cdn\.net|px-cloud\.net/i }
];

const BOT_WALL_TITLES =
  /^(?:just a moment|attention required!|access denied|pardon our interruption|are you a robot|security check|verify you are human|checking your browser)/i;

// "complete the following challenge" and "made by a human" are how a search engine words it when
// it decides a query came from software - the exact page a research task walks into first.
const BOT_WALL_TEXT =
  /\b(?:verify (?:you are|you're) (?:a )?human|checking if the site connection is secure|enable javascript and cookies to continue|complete the (?:security check|following challenge)|unusual traffic from your computer network|made by a human)\b/i;

const BOT_WALL_HEADERS = [
  { vendor: 'Cloudflare', header: 'cf-mitigated' },
  { vendor: 'DataDome', header: 'x-datadome' },
  { vendor: 'DataDome', header: 'x-datadome-cid' },
  { vendor: 'PerimeterX', header: 'x-px-block' }
];

export const detectBotWall = (input: {
  url: string;
  title: string;
  text?: string;
  frameUrls?: string[];
  status?: number | null;
  headers?: Record<string, string>;
}): BotWall | null => {
  const wall = (vendor: string, reason: string, evidence: 'page' | 'response'): BotWall => ({
    vendor,
    url: input.url,
    reason,
    evidence
  });
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  for (const { vendor, header } of BOT_WALL_HEADERS)
    if (headers[header] !== undefined)
      return wall(vendor, `response carried ${header}`, 'response');
  const blockedStatus = input.status === 403 || input.status === 429;
  if (blockedStatus && /cloudflare/i.test(headers.server ?? ''))
    return wall('Cloudflare', `HTTP ${input.status} from a Cloudflare bot manager`, 'response');
  for (const { vendor, pattern } of BOT_WALL_FRAMES)
    if ((input.frameUrls ?? []).some((frameUrl) => pattern.test(frameUrl)))
      return wall(vendor, 'challenge widget is embedded in the page', 'page');
  const title = input.title.trim();
  if (BOT_WALL_TITLES.test(title))
    return wall('Unnamed bot wall', `page title is “${title}”`, 'page');
  if (BOT_WALL_TEXT.test(input.text ?? ''))
    return wall('Unnamed bot wall', 'page is asking the visitor to prove they are human', 'page');
  return null;
};

/**
 * How long a site stays closed after a challenge. Long enough that no single task can loop back
 * onto it, short enough that tomorrow's work starts from a clean sheet rather than inheriting a
 * verdict a bot manager made about a moment yesterday.
 */
export const BOT_WALL_HOST_COOLDOWN_MS = 30 * 60_000;

/** The host a wall belongs to, which is the unit the stop is remembered by. */
export const botWallHost = (url: string): string | null => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};

/**
 * Whether a challenge still stands, judged against what the tab shows now rather than against the
 * memory of what it showed then. A tab that has moved on is not blocked by what used to be there,
 * and an interstitial that passed by itself - which most of them do, a few seconds later - leaves
 * nothing to stop. Response evidence is the exception: it came from headers that only a fresh
 * request would produce again, and a fresh request is the retry that must not happen.
 */
export const reviewBotWall = (
  standing: BotWall,
  observed: { url: string; title: string; text: string; frameUrls: string[] }
): BotWall | null => {
  if (observed.url !== standing.url) return null;
  if (standing.evidence === 'response') return standing;
  return detectBotWall(observed);
};

/**
 * The stops in force in one browser session. A challenge is recorded against the tab that hit it,
 * so the rest of the browser keeps working, and against the site it was on, so the stop cannot be
 * crossed by opening the same page in a fresh tab - which is the retry the challenge is asking
 * for, made against the owner's own address. The site is held for a cooldown rather than forever,
 * because a bot manager's verdict is about a moment: an hour later this is an ordinary visit.
 */
export class BotWallLedger {
  readonly #tabs = new Map<string, BotWallReport>();
  readonly #hosts = new Map<string, { wall: BotWall; at: number }>();

  raise(tabId: string | null, wall: BotWall, now = Date.now()): BotWallReport {
    const report: BotWallReport = { ...wall, tabId };
    if (tabId !== null) this.#tabs.set(tabId, report);
    const host = botWallHost(wall.url);
    if (host) this.#hosts.set(host, { wall, at: now });
    return report;
  }

  standing(tabId: string | null): BotWallReport | undefined {
    return tabId === null ? undefined : this.#tabs.get(tabId);
  }

  /** The page got through, so neither the tab nor the site is refusing this computer any more. */
  clear(tabId: string, url: string): void {
    this.#tabs.delete(tabId);
    const host = botWallHost(url);
    if (host) this.#hosts.delete(host);
  }

  /** A closed tab takes its own stop with it; the site stays closed for the rest of the cooldown. */
  forgetTab(tabId: string): void {
    this.#tabs.delete(tabId);
  }

  /** The challenge standing between this computer and that site, if one still is. */
  hostClosed(requestedUrl: string, now = Date.now()): BotWall | null {
    const host = botWallHost(requestedUrl);
    const remembered = host === null ? undefined : this.#hosts.get(host);
    if (!remembered || host === null) return null;
    if (now - remembered.at > BOT_WALL_HOST_COOLDOWN_MS) {
      this.#hosts.delete(host);
      return null;
    }
    return remembered.wall;
  }

  /**
   * The newest stop, from whichever tab raised it. This is what the pane shows: a challenge the
   * agent walked into on a background tab is exactly the one nobody would otherwise see.
   */
  latest(): BotWallReport | null {
    return [...this.#tabs.values()].at(-1) ?? null;
  }

  clearAll(): void {
    this.#tabs.clear();
    this.#hosts.clear();
  }
}

/**
 * A challenge is a fact about one page and one site at one moment, and the message says so: the
 * agent is told what is still open to it, because a stop that reads as "the browser is gone" is
 * what turned one interstitial into a failed task.
 */
export const botWallMessage = (wall: BotWallReport | BotWall): string => {
  const tabId = 'tabId' in wall ? wall.tabId : null;
  const host = botWallHost(wall.url) ?? 'this site';
  return `Blocked by ${wall.vendor}: this page is showing an anti-bot challenge (${wall.reason}). ${
    tabId ? `Tab ${tabId} is stopped and ` : ''
  }${host} is closed to you until the owner opens it. Do not retry, reload, open it in another tab, or touch the challenge. Every other tab and every other site still works, so carry on with the rest of the task there and tell the owner this one page needs them.`;
};

/**
 * The same fact, worded for what it actually cost.
 *
 * The browser's wording would be wrong here in every particular: no tab is stopped, the site is not
 * closed to the browser, and nobody has to open anything. Saying so precisely matters because the
 * agent acts on this sentence - told the web was gone, it would stop researching, which is the
 * failure the whole route was rebuilt to end.
 *
 * It used to say searching would be available again in about a minute, and to search again shortly.
 * That was the backoff timer described as if it were a prognosis, and on the deployment this
 * product is built for it was simply false: a server's address is what most engines are refusing,
 * so the next attempt meets the same challenge, and the one after that. Every retry the sentence
 * invited was a turn and a bill spent to be refused again. What it says now is the part that is
 * actually known - this engine did not answer, from here - and it names the routes that do not go
 * through it, without promising that waiting fixes anything.
 */
export const searchWallMessage = (wall: BotWall): string =>
  `Blocked by ${wall.vendor}: the search engine answered with an anti-bot challenge instead of results (${wall.reason}). Nothing else is affected - the browser, every site and every other tool still work. Do not touch the challenge, and do not simply repeat the same search: this engine is refusing this computer, not this query, so an immediate retry meets the same challenge. Read a source you already have the address of, or open a different search engine in the browser. If you needed search to make progress and have no other way in, say so and stop rather than guessing at addresses.`;

/** Actions whose approval depends on which control they land on, so preflight must resolve it. */
const ELEMENT_POLICY_ACTIONS: BrowserAction['type'][] = [
  'click',
  'double_click',
  'type',
  'select_option',
  'upload'
];

/** Actions that can start a download, and so wait to report where the file landed. */
const DOWNLOAD_TRIGGERING_ACTIONS: BrowserAction['type'][] = [
  'click',
  'double_click',
  'click_at',
  'navigate',
  'press'
];

/**
 * The words that make activating a control consequential - the destructive half of the safety floor
 * three documents promise. GARDEN_BLUEPRINT.md:104, docs/AGENT_RUNTIME.md:416 and
 * docs/CAPABILITIES.md:97 all say destructive operations still require confirmation in every mode.
 *
 * The list used to be only the transactional verbs, so it kept that promise for a control named
 * "Delete" and broke it for every other way an application spells the same thing. That was
 * invisible while a separate defect carded every browser and desktop action regardless of the
 * verdict here (ATH-001): once a benign verdict was allowed to mean "no card", a click on a control
 * named Erase, Format, Reset, Overwrite, Empty Trash, Revoke or Deactivate went through untouched
 * in Balanced and Autonomous. Repairing the first defect is what made the second one reachable,
 * which is why the vocabulary is widened in the same wave.
 *
 * Confirmation words - OK, Yes, Continue - are deliberately absent. What they do depends on the
 * dialog around them, which no classifier here can see, and carding all of them is precisely the
 * ceremony ATH-001 was fixed to remove. The floor promises destructive operations and ambiguous
 * coordinates; a bare coordinate is separately and unconditionally consequential.
 *
 * AGREEING, AND THE HALF OF IT THAT CAN BE RECOGNISED. The three mode sentences promised "agreeing
 * to something on your behalf" and this list held `sign`, `accept offer`, `submit` and `confirm` -
 * so a control reading "Accept the Terms", "I agree to the Terms of Service" or "Accept the licence
 * agreement" raised nothing at all in balanced or autonomous. Driven on this tree at cd7033f: eight
 * such labels, no card in either mode.
 *
 * Consent is not a category anything here can recognise. The evidence a click carries is
 * `ElementPolicyInput` - a tag, a type, an accessible name, an autocomplete token, a form action
 * and whether there is a form around it - and a consent control is a plain `<button>` outside any
 * form, structurally identical to every other button on the page. `isSubmitControl` is the one
 * structural rule here and it cannot see one. So the only evidence is the words, and words are a
 * list that rots.
 *
 * What is added is therefore the OBJECT of the agreement rather than the verb on the button:
 * `terms`, `licence`, `license`, `eula`. A legal document has a small, stable name; a button has
 * whatever copy a designer chose this year. "Accept", "Agree" and "Consent" are NOT added, and the
 * reason is the one that keeps OK and Continue out: they are the words on a cookie banner, a cookie
 * banner stands in front of almost every page a research turn opens, and a card there is friction on
 * ordinary reading rather than a safeguard. Both costs are stated rather than hidden - a control
 * named "License" in a footer now cards when it is only a link, and a banner whose button says "Got
 * it" is not reached by this and cannot be - and the mode sentence claims only what this keeps. See
 * docs/design/gaps/NETWORK.md.
 *
 * `desktop.ts` holds the same list for the same promise and scripts/check-repository.mjs compares
 * them, because a word added to one and not the other is how one surface silently stops keeping a
 * floor the other still keeps.
 */
const consequentialText =
  /\b(submit|apply|purchase|buy|pay|send|publish|delete|remove|confirm|place order|sign|accept offer|post|save changes|install|uninstall|erase|wipe|destroy|discard|overwrite|revoke|deactivate|terminate|format|reset|empty trash|empty bin|move to trash|move to bin|accept\w*\s+[a-z ]{0,16}terms|agree\w*\s+[a-z ]{0,16}terms|accept\w*\s+[a-z ]{0,16}licen[cs]e|agree\w*\s+[a-z ]{0,16}licen[cs]e|accept\w*\s+[a-z ]{0,16}eula|agree\w*\s+[a-z ]{0,16}eula)\b/i;
const sensitiveFieldText =
  /\b(password|passcode|one.?time|otp|verification code|credit.?card|card number|cvv|cvc|social security|ssn|passport number|bank account)\b/i;

export const classifyBrowserAction = (
  action: BrowserAction,
  element?: ElementPolicyInput
): BrowserActionPreflight => {
  if (
    typeof element?.name === 'string' &&
    signatureControl(element.name) &&
    ['click', 'double_click', 'click_at', 'type', 'press'].includes(action.type)
  )
    return {
      consequential: true,
      sensitiveInput: false,
      handoffKind: 'signature',
      preview: 'Review and sign this document yourself in the browser.'
    };
  if (action.type === 'click_at') {
    return {
      consequential: true,
      sensitiveInput: false,
      preview: `Coordinate click at ${Math.round(action.x)}, ${Math.round(action.y)}`
    };
  }
  if (action.type === 'press' && action.key.toLowerCase() === 'enter') {
    return {
      consequential: true,
      sensitiveInput: false,
      preview: 'Press Enter in the currently focused page control'
    };
  }
  if (action.type === 'dialog' && action.response === 'accept') {
    return {
      consequential: true,
      sensitiveInput: Boolean(action.promptText),
      preview: action.promptText
        ? 'Accept the page dialog with private text'
        : 'Accept the page confirmation dialog'
    };
  }
  if (action.type === 'text_input') {
    return {
      consequential: false,
      sensitiveInput: true,
      preview: 'Enter private text in the currently focused field'
    };
  }
  if (action.type === 'upload') {
    // Attaching a file sends workspace content to an external site, and many pages upload it
    // the moment it is chosen, so this is approved before it happens rather than at submit.
    return {
      consequential: true,
      sensitiveInput: false,
      preview: `Attach workspace ${action.paths.length === 1 ? 'file' : 'files'} ${action.paths.join(', ').slice(0, 300)} to this page`
    };
  }
  if (!element) {
    return { consequential: false, sensitiveInput: false, preview: action.type };
  }
  const label = element.name.trim().slice(0, 160) || `${element.tag} ${element.type}`.trim();
  const autocomplete = element.autocomplete.toLowerCase();
  const sensitiveInput =
    action.type === 'type' &&
    (element.type === 'password' ||
      ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].some((token) =>
        autocomplete.split(/\s+/).includes(token)
      ) ||
      sensitiveFieldText.test(`${label} ${element.formAction}`));
  // A double click activates the same control a click does, so it inherits the same gate.
  const activates = action.type === 'click' || action.type === 'double_click';
  const isSubmitControl =
    activates &&
    element.inForm &&
    ((element.tag === 'button' && element.type === 'submit') ||
      (element.tag === 'input' && ['submit', 'image'].includes(element.type)));
  // A form URL such as /apply does not make its Previous or Help control a submission.
  const consequential = activates && (isSubmitControl || consequentialText.test(label));
  const verb =
    action.type === 'type'
      ? 'Fill'
      : action.type === 'select_option'
        ? 'Choose an option in'
        : action.type === 'double_click'
          ? 'Double-click'
          : action.type === 'hover'
            ? 'Hover'
            : 'Click';
  return {
    consequential,
    sensitiveInput,
    preview: `${verb} “${label || 'page control'}”${element.formAction ? ` · form destination ${element.formAction}` : ''}`
  };
};

/**
 * A batch is exactly as consequential as the most consequential thing in it. Classifying the
 * wrapper on its own would let a submit click ride through the approval gate inside one, so the
 * steps are classified individually and the strongest verdict wins.
 */
export const combineBatchPreflight = (
  steps: Array<{ index: number; preflight: BrowserActionPreflight }>
): BrowserActionPreflight => ({
  ...(() => {
    const handoff = steps.find(
      (step) => step.preflight.handoffKind || step.preflight.sensitiveInput
    )?.preflight;
    return handoff
      ? {
          ...(handoff.handoffKind ? { handoffKind: handoff.handoffKind } : {}),
          ...(handoff.tabId ? { tabId: handoff.tabId } : {})
        }
      : {};
  })(),
  consequential: steps.some((step) => step.preflight.consequential),
  sensitiveInput: steps.some((step) => step.preflight.sensitiveInput),
  destinations: [...new Set(steps.flatMap((step) => step.preflight.destinations ?? []))],
  preview: steps
    .map((step) => `${step.index + 1}. ${step.preflight.preview}`)
    .join('\n')
    .slice(0, 1_200)
});

/**
 * How to put text into a control. `fill` sets the value in one assignment, which is fast and
 * exactly wrong for a typeahead: no keydown, no input event per character, so the suggestion list
 * that an application form requires the applicant to pick from never opens.
 */
export const typeStrategy = (descriptor: {
  tag: string;
  role: string;
  ariaAutocomplete: string;
  hasList: boolean;
  contentEditable: boolean;
}): 'fill' | 'keys' =>
  descriptor.role === 'combobox' ||
  descriptor.ariaAutocomplete !== '' ||
  descriptor.hasList ||
  descriptor.contentEditable
    ? 'keys'
    : 'fill';

/** Resolves a tab id to its live page, or the active page when no tab is named. */
const resolveTab = (session: Session, tabId: string | undefined): Page => {
  if (!tabId) return session.page;
  const page = session.tabs.get(tabId);
  // A closed tab is removed from the registry, so an unknown id means the page is gone rather
  // than that the caller miscounted. Saying so is more useful than silently acting elsewhere.
  if (!page || page.isClosed()) throw new Error(`Browser tab ${tabId} is no longer open`);
  return page;
};

/** The id this page was minted with, or null once it has been closed and forgotten. */
export const tabIdFor = (session: Session, page: Page): string | null => {
  for (const [tabId, candidate] of session.tabs) if (candidate === page) return tabId;
  return null;
};

/** The tab list every snapshot carries, so the agent and a watching human see the same thing. */
export const sessionTabs = async (session: Session): Promise<BrowserTabSummary[]> => {
  const entries: BrowserTabSummary[] = [];
  for (const [tabId, page] of session.tabs) {
    if (page.isClosed()) continue;
    entries.push({
      tabId,
      active: page === session.page,
      url: page.url(),
      title: session.tabLifecycle?.has(tabId)
        ? session.tabLifecycle.title(tabId)
        : await withDeadline(
            page.title().catch(() => ''),
            STREAM_TITLE_TIMEOUT_MS,
            ''
          )
    });
  }
  return entries;
};

/**
 * The one coordinate space the browser works in: the contract bounds a coordinate click to it,
 * the screencast is published at it, and the agent reads every position off a screenshot of it.
 */
export const BROWSER_VIEWPORT = { width: 1440, height: 900 } as const;

export interface BrowserLaunchAttempt {
  headless: boolean;
  chromiumSandbox: true;
}

/**
 * Chromium adds these only when it is headless, and each one lies about the machine.
 * `--hide-scrollbars` produces the `innerWidth === clientWidth` mismatch no real window has, and
 * the blink settings make `(hover: none)` and `(pointer: coarse)` match — so a responsive site
 * serves its phone layout to a browser whose user agent says desktop Linux, and the agent is then
 * clicking a hamburger menu that nobody watching the same page would see.
 */
export const HEADLESS_DEVICE_ARGUMENTS = [
  '--hide-scrollbars',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'
];

/** A missing display can use headless mode; the renderer sandbox is mandatory. */
export const browserLaunchLadder = (input: {
  displayAvailable: boolean;
  runningAsRoot: boolean;
}): BrowserLaunchAttempt[] => {
  if (input.runningAsRoot)
    throw new Error(
      'Garden cannot start Chromium as root. Run the workspace runner under its dedicated account.'
    );
  return (input.displayAvailable ? [false, true] : [true]).map((headless) => ({
    headless,
    chromiumSandbox: true
  }));
};

/** Browser children receive desktop and locale settings, never runner credentials. */
export const browserLaunchEnvironment = (
  source: NodeJS.ProcessEnv,
  desktop: NodeJS.ProcessEnv = {}
): Record<string, string> => {
  const allowed = [
    'PATH',
    'HOME',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE',
    'PULSE_SERVER',
    'PULSE_COOKIE',
    'TMPDIR'
  ];
  const combined = { ...source, ...desktop };
  return {
    ...Object.fromEntries(
      allowed.flatMap((name) => {
        const value = combined[name];
        return typeof value === 'string' ? [[name, value]] : [];
      })
    ),
    // A minimal D-Bus session has no desktop preference daemon to enable native accessibility.
    ...(desktop.DISPLAY ? { ACCESSIBILITY_ENABLED: '1' } : {})
  };
};

export const launchSandboxedResearchBrowser = async (
  driver: Pick<BrowserType, 'launch'>,
  input: {
    executablePath?: string | undefined;
    runningAsRoot: boolean;
    environment: NodeJS.ProcessEnv;
    guiEnvironment?: NodeJS.ProcessEnv | undefined;
  }
): Promise<Browser> => {
  browserLaunchLadder({ displayAvailable: false, runningAsRoot: input.runningAsRoot });
  try {
    return await driver.launch({
      ...(input.executablePath ? { executablePath: input.executablePath } : {}),
      headless: true,
      chromiumSandbox: true,
      env: { ...browserLaunchEnvironment(input.environment), ...input.guiEnvironment },
      ignoreDefaultArgs: HEADLESS_DEVICE_ARGUMENTS,
      args: ['--no-first-run', '--disable-background-networking', '--disable-component-update']
    });
  } catch (cause) {
    throw new Error(
      'The research browser could not start with its renderer sandbox. Run garden doctor to inspect this host.',
      { cause }
    );
  }
};

export const browserLaunchOptions = (attempt: BrowserLaunchAttempt) => ({
  headless: attempt.headless,
  chromiumSandbox: attempt.chromiumSandbox,
  ignoreDefaultArgs: attempt.headless ? HEADLESS_DEVICE_ARGUMENTS : [],
  args: [
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    ...(attempt.headless
      ? []
      : [
          '--force-renderer-accessibility=complete',
          `--window-size=${BROWSER_VIEWPORT.width},${BROWSER_VIEWPORT.height}`
        ])
  ],
  viewport: { ...BROWSER_VIEWPORT }
});

/**
 * Where the agent may drive the session browser, decided by the same module every other outbound
 * fetch asks - `parallel_web_read`, the connectors, the calendar - rather than by a second opinion
 * kept here. The session browser is the one path that used to have no opinion at all, which made
 * `navigate` a way to read the cloud metadata endpoint and every service listening on loopback out
 * of a page or an email the agent had been told to read.
 *
 * Two questions, deliberately answered differently: where the agent may send the browser, and what
 * page it may read back. The second is the wider set, because a page can move itself after the
 * navigation that opened it returned. It admits a tab that has loaded nothing - `about:blank` is
 * where every session and every new tab begins - and a blob, which is a page's own bytes under its
 * own origin and is what a site does when it opens a PDF it has just generated. Neither fetches
 * anything, and a blob's origin has already had to pass this same check to be on the screen.
 */
export const agentReachablePage = (url: string): boolean => {
  if (url === '' || url === 'about:blank') return true;
  if (url.startsWith('blob:')) return isPublicHttpUrl(url.slice('blob:'.length));
  return isPublicHttpUrl(url);
};

export const agentDestinationRefused = (url: string): Error =>
  new Error(
    `The browser is only driven to addresses on the public internet, and ${url.slice(0, 200)} is not one - it is a loopback, private, link-local or otherwise reserved address, or not an HTTP(S) address at all`
  );

/**
 * The syntactic check and the resolution one, kept apart so each says what it actually found. A
 * name that does not resolve at all fails the second, and reporting that as an address-policy
 * refusal would tell the agent something untrue about a site that is merely down.
 */
export const assertAgentReachableUrl = async (url: string): Promise<void> => {
  if (!isPublicHttpUrl(url)) throw agentDestinationRefused(url);
  try {
    await assertPublicHttpUrl(url);
  } catch (cause) {
    throw new Error(
      `The browser could not open ${url.slice(0, 200)}: ${cause instanceof Error ? cause.message : 'its address could not be checked'}`
    );
  }
};

/**
 * Every address a single step would open. One list, so the challenge check and the address check
 * cannot end up covering different actions - which is how `new_tab` came to be guarded against a
 * site standing a challenge and not against the address it was pointed at.
 */
export const stepDestinations = (action: BrowserPrimitiveAction): string[] => {
  if (action.type === 'navigate') return [action.url];
  if (action.type === 'new_tab' && action.url) return [action.url];
  return [];
};

/**
 * Every modifier and mouse button Playwright can be holding down on a page.
 *
 * Chromium tracks these per input dispatcher, not per action: a `keyboard.down('Control')` or a
 * drag that threw between `mouse.down` and `mouse.up` leaves them latched for the life of the
 * page. The desktop already lifted its own (`releaseAllInputCommand`) on every handover and the
 * browser lifted nothing, so an agent interrupted mid-chord handed the owner a screen where every
 * later keystroke was silently a chord and the next click finished a selection they never started.
 */
const BROWSER_HELD_MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta'] as const;
const BROWSER_HELD_BUTTONS = ['left', 'middle', 'right'] as const;

export const releaseBrowserInput = async (page: Page): Promise<void> => {
  // Tolerant per key: a page that navigated or closed while the takeover was in flight must not be
  // the reason the remaining modifiers stay down.
  for (const key of BROWSER_HELD_MODIFIERS) await page.keyboard.up(key).catch(() => undefined);
  for (const button of BROWSER_HELD_BUTTONS) await page.mouse.up({ button }).catch(() => undefined);
};

export class BrowserManager {
  readonly #tabJournal: BrowserTabJournal | undefined;
  readonly #sessions = new Map<string, Session>();
  readonly #humanReceipts = new WeakMap<
    Page,
    { url: string; digest: string; frames: string[]; expires: number }
  >();
  readonly #starting = new Map<string, Promise<Session>>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #failedStarts = new Map<string, () => Promise<void>>();
  /**
   * The last challenge the search route walked into, per workspace, and when. Kept apart from the
   * session's own ledger on purpose: a wall the search route hit must not close that host for the
   * browser the agent drives, and a wall the browser hit must not take searching away.
   */
  readonly #searchWalls = new Map<string, { wall: BotWall; at: number }>();
  /** Sessions already registered with their screen's control; see `#controlOf`. */
  readonly #attached = new WeakSet<Session>();
  readonly #lastUsed = new WeakMap<Session, number>();

  constructor(
    private readonly options: {
      recoverySecret?: string;
      gui?: GuiNamespaceManager | undefined;
      executablePath?: string | undefined;
      /**
       * How far down the scheduler this workspace's browser sits, and what applies it.
       *
       * Absent or zero leaves the browser at the runner's own priority, which is what every
       * installation had before there was a reason to move it. The applier is injected so the walk
       * over `/proc` can be exercised on a host that has none.
       */
      browserCpuNice?: number | undefined;
      dampenBrowserCpu?: ((profileDir: string, niceness: number) => Promise<number>) | undefined;
      /**
       * How the throwaway browser behind the research fan-out and the search route is started.
       * Present so those two paths can be exercised without a Chromium on the machine running the
       * tests; unset everywhere else, which is the real launch below.
       */
      launchIsolatedBrowser?: (() => Promise<Browser>) | undefined;
      /**
       * Resolves the X11 environment of the workspace's own desktop, so the browser runs on the
       * screen the Computer pane already streams. Absent on a host with no desktop runtime, and
       * allowed to fail: the browser falls back to headless rather than not starting.
       */
      desktopDisplay?:
        | ((workspaceId: string, root: string) => Promise<NodeJS.ProcessEnv | undefined>)
        | undefined;
      /**
       * The control object for that same screen. Wired wherever `desktopDisplay` is, because the
       * two are the same fact: a browser drawn on the workspace's X server is one more surface
       * onto a machine the owner may take, not a second machine with a takeover of its own.
       * Absent on a host with no desktop runtime, where the browser arbitrates itself.
       */
      desktopControl?:
        | ((workspaceId: string, root: string) => Promise<DesktopControl | undefined>)
        | undefined;
      /**
       * The same ceiling the file routes apply, because an upload and a printed page are the file
       * API arriving by another door and must not be a way around its limits.
       */
      maxFileBytes: number;
      now?: () => number;
    }
  ) {
    this.#tabJournal = options.recoverySecret
      ? new BrowserTabJournal(options.recoverySecret)
      : undefined;
  }

  #recovery(session: Session): BrowserRecovery | undefined {
    if (!session.recovery || session.control.holder === 'secure_input') return undefined;
    const live = new Set(
      [...session.tabs.values()].filter((page) => !page.isClosed()).map((page) => page.url())
    );
    session.recovery.tabs = session.recovery.tabs.filter((tab) => !live.has(tab.url));
    return session.recovery;
  }

  async #rememberTabs(session: Session): Promise<void> {
    if (!this.#tabJournal || session.ending || session.control.holder === 'secure_input') return;
    // The last tab cannot be closed through the action API; an empty set is browser teardown.
    if (![...session.tabs.values()].some((page) => !page.isClosed())) return;
    const previous = this.#recovery(session);
    const tabs = this.#tabStates(session)
      .filter((tab) => recoverableTabUrl(tab.url))
      .map((tab) => ({
        tabId: tab.tabId,
        url: tab.url,
        title: tab.title,
        lastSeenAt: new Date(this.#now()).toISOString()
      }));
    const saved = [...tabs, ...(previous?.tabs ?? [])];
    const signature = JSON.stringify({
      tabs: saved.map(({ tabId, url, title }) => ({ tabId, url, title })),
      omitted: previous?.omitted ?? 0
    });
    if (signature === session.recoverySignature) return;
    try {
      await this.#tabJournal.save(session.root, saved, previous?.omitted ?? 0);
      session.recoverySignature = signature;
    } catch {
      if (session.recovery) session.recovery.unavailable = true;
    }
  }

  #scheduleTabMemory(session: Session): void {
    if (!this.#tabJournal || session.ending || session.recoveryTimer) return;
    session.recoveryTimer = setTimeout(() => {
      delete session.recoveryTimer;
      void this.#rememberTabs(session);
    }, 250);
    session.recoveryTimer.unref();
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #tabLifecycle(session: Session): BrowserTabs {
    session.tabLifecycle ??= new BrowserTabs();
    for (const [id, page] of session.tabs) {
      if (!page.isClosed() && !session.tabLifecycle.has(id))
        session.tabLifecycle.add(id, 'user', null, this.#now());
    }
    return session.tabLifecycle;
  }

  #tabStates(session: Session): BrowserTabState[] {
    const lifecycle = this.#tabLifecycle(session);
    return [...session.tabs]
      .filter(([, page]) => !page.isClosed())
      .map(([id, page]) =>
        lifecycle.state(id, page.url(), page === session.page, session.control.holder)
      );
  }

  async #sweepTabs(session: Session, makeRoom = false): Promise<string[]> {
    const lifecycle = this.#tabLifecycle(session);
    const closed: string[] = [];
    for (const id of lifecycle.candidates(this.#tabStates(session), this.#now(), makeRoom)) {
      const current = this.#tabStates(session).find((tab) => tab.tabId === id);
      if (!current || current.protectedReason !== null) continue;
      const page = session.tabs.get(id);
      if (!page) continue;
      await page.close();
      lifecycle.closed(this.#now());
      closed.push(id);
    }
    if (closed.length) this.#notifyStreamState(session);
    return closed;
  }

  sessions(workspaceId: string) {
    const session = this.#sessions.get(workspaceId);
    return session
      ? {
          holder: session.control.holder,
          tabs: session.control.holder === 'secure_input' ? [] : this.#tabStates(session)
        }
      : null;
  }

  async ownerStroke(workspaceId: string, root: string, stroke: OwnerStroke): Promise<void> {
    const session = await this.ensure(workspaceId, root);
    await this.#controlOf(session).submit('user', async (signal) => {
      if (session.control.holder === 'secure_input')
        throw new Error('End private input before drawing');
      const page = resolveTab(session, stroke.tabId);
      if (page !== session.page)
        throw new Error('The active tab changed. Draw again on the current page.');
      try {
        const first = stroke.points[0]!;
        await page.mouse.move(first.x, first.y);
        await page.mouse.down();
        for (const point of stroke.points.slice(1)) {
          signal.throwIfAborted();
          await page.mouse.move(point.x, point.y);
        }
      } finally {
        await page.mouse.up({ button: 'left' }).catch(() => undefined);
      }
    });
  }

  async #challengeDigest(page: Page): Promise<string | null> {
    const value: unknown = await page
      .evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            '[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]'
          )
        )
          .map((field) => field.value)
          .filter(Boolean)
          .join('\n')
      )
      .catch(() => null);
    return typeof value === 'string' && value.length > 0 && value.length <= 65536
      ? createHash('sha256').update(value).digest('hex')
      : null;
  }

  async #unacknowledgedFrames(page: Page): Promise<string[]> {
    const frames = page.frames().map((frame) => frame.url());
    const receipt = this.#humanReceipts.get(page);
    if (!receipt) return frames;
    if (
      receipt.url !== page.url() ||
      receipt.expires < Date.now() ||
      receipt.digest !== (await this.#challengeDigest(page))
    ) {
      this.#humanReceipts.delete(page);
      return frames;
    }
    return frames.filter((frame) => !receipt.frames.includes(frame));
  }

  async completeHandoff(
    workspaceId: string,
    root: string,
    tabId?: string,
    expectedUrl?: string
  ): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session) throw new Error('Open the browser and complete verification before continuing');
    if (session.control.holder === 'secure_input')
      throw new Error('End private input before continuing');
    tabId ??= session.walls.latest()?.tabId ?? undefined;
    if (!tabId) throw new Error('Select the verification tab before continuing');
    if (tabId) {
      const page = resolveTab(session, tabId);
      if (
        !/^https?:\/\//.test(page.url()) ||
        (expectedUrl && new URL(page.url()).origin !== new URL(expectedUrl).origin)
      )
        throw new Error('Reopen the verification site and complete it before continuing');
      // Only an explicit owner completion can issue this receipt. Page content alone cannot.
      const digest = session.control.holder === 'user' ? await this.#challengeDigest(page) : null;
      const frames = page.frames().map((frame) => frame.url());
      const completedFrames = digest
        ? frames.filter((frame) => BOT_WALL_FRAMES.some((rule) => rule.pattern.test(frame)))
        : [];
      const wall = detectBotWall({
        url: page.url(),
        title: await page.title(),
        text: await page.locator('body').innerText({ timeout: 5000 }),
        frameUrls: (await this.#unacknowledgedFrames(page)).filter(
          (frame) => !completedFrames.includes(frame)
        )
      });
      if (wall) throw new BotWallError(this.#raiseWall(session, page, wall));
      if (digest && completedFrames.length)
        this.#humanReceipts.set(page, {
          url: page.url(),
          digest,
          frames: completedFrames,
          expires: Date.now() + 120000
        });
      const previous = session.walls.standing(tabId);
      if (previous) session.walls.clear(tabId, previous.url);
    }
    await this.setHolder(workspaceId, root, 'agent');
  }

  async sweepTabs(workspaceId: string): Promise<string[]> {
    const session = this.#sessions.get(workspaceId);
    if (!session || session.control.holder !== 'agent') return [];
    return this.#controlOf(session).submit('agent', () => this.#sweepTabs(session));
  }

  async retainTab(
    workspaceId: string,
    root: string,
    tabId: string,
    pinned: boolean
  ): Promise<BrowserTabState[]> {
    const session = await this.ensure(workspaceId, root);
    resolveTab(session, tabId);
    this.#tabLifecycle(session).pin(tabId, pinned);
    this.#notifyStreamState(session);
    return this.#tabStates(session);
  }

  /**
   * The desktop's control for this workspace, if this runner has a desktop at all.
   *
   * Allowed to fail for the same reason `#displayEnvironment` is: a desktop that is configured and
   * will not come up must not be the reason the browser refuses to work. A browser with no shared
   * control falls back to arbitrating its own session, which is what a headless host has anyway.
   */
  async #sharedControl(workspaceId: string, root: string): Promise<DesktopControl | undefined> {
    return this.options.desktopControl?.(workspaceId, root).catch(() => undefined);
  }

  /**
   * Registers this browser with the control that arbitrates its screen, once per session.
   *
   * Attached rather than passed in at construction because the control may be the desktop's, and
   * a shared control has to release both surfaces: xdotool's latched keysyms *and* the modifiers
   * Playwright is holding on the page. Doing it here rather than in `ensure` is deliberate - the
   * suites that stand a session in for a launched Chromium never reach `ensure`, and the gate the
   * owner's takeover rests on must be the shipped one on both paths.
   */
  /**
   * Re-points a session at the control that arbitrates its screen *now*.
   *
   * A desktop session that died and was restarted mints a new control, and a browser still holding
   * the old one is back to two answers for one screen - the defect this lane exists to close,
   * arriving by the back door. So the shared control is resolved on every entry rather than once
   * at launch, and a browser whose screen changed hands to a new object moves with it.
   */
  #adopt(session: Session, shared: DesktopControl | undefined): DesktopControl {
    if (shared && shared !== session.control) {
      session.detachControl?.();
      delete session.detachControl;
      this.#attached.delete(session);
      session.control = shared;
    }
    return this.#controlOf(session);
  }

  #controlOf(session: Session): DesktopControl {
    if (!this.#attached.has(session)) {
      this.#attached.add(session);
      session.detachControl = session.control.attach({
        release: () => releaseBrowserInput(session.page),
        onChange: () => this.#notifyStreamState(session)
      });
    }
    return session.control;
  }

  async ensure(workspaceId: string, root: string): Promise<Session> {
    while (this.#closing.has(workspaceId)) await this.#closing.get(workspaceId);
    if (this.#failedStarts.has(workspaceId)) {
      await this.close(workspaceId);
      return this.ensure(workspaceId, root);
    }
    const pending = this.#starting.get(workspaceId);
    if (pending) return pending;
    const existing = this.#sessions.get(workspaceId);
    if (existing) {
      this.#lastUsed.set(existing, this.#now());
      return existing;
    }
    const starting = this.#start(workspaceId, root);
    this.#starting.set(workspaceId, starting);
    try {
      const session = await starting;
      this.#lastUsed.set(session, this.#now());
      return session;
    } finally {
      if (this.#starting.get(workspaceId) === starting) this.#starting.delete(workspaceId);
    }
  }

  hasSession(workspaceId: string): boolean {
    return this.#sessions.has(workspaceId) || this.#starting.has(workspaceId);
  }

  /**
   * Lowers the priority of one workspace's Chromium tree, best-effort and silent.
   *
   * Never a reason to fail a launch or a sweep: a browser that could not be niced runs exactly as
   * it did before this existed. Off entirely when no applier is wired, which is every test in this
   * package and any host without a `/proc` to walk.
   */
  async #dampen(profileDir: string): Promise<void> {
    const niceness = this.options.browserCpuNice ?? 0;
    const apply = this.options.dampenBrowserCpu;
    if (!apply || niceness <= 0) return;
    // No log line: this is routine housekeeping that runs every minute, and a message per pass
    // would bury the ones worth reading. The effect is the point, and `nice` is visible in `ps`.
    await apply(profileDir, niceness).catch(() => 0);
  }

  async retireIdle(isViewed: (workspaceId: string) => boolean = () => false): Promise<string[]> {
    /*
     * Re-applied on the sweep the retirement already runs, because the tree changes under it: a tab
     * opened since the last pass has a renderer nobody has niced, and a GPU process that crashed
     * and came back is new. A process already at the target is skipped without a syscall, so a
     * steady session costs one `/proc` walk a minute and nothing else.
     */
    // The profile is where `#start` puts it, derived from the root the session already carries
    // rather than stored twice - two copies of one path is how they come to disagree.
    for (const [, session] of this.#sessions)
      await this.#dampen(path.join(session.root, '.garden', 'browser'));
    const retired: string[] = [];
    for (const [workspaceId, session] of this.#sessions) {
      if (
        this.#closing.has(workspaceId) ||
        isViewed(workspaceId) ||
        this.#now() - (this.#lastUsed.get(session) ?? this.#now()) < TAB_IDLE_MS ||
        session.control.holder !== 'agent' ||
        session.control.busy ||
        session.stream?.subscribers.size ||
        session.pendingDownloads.size ||
        session.pendingDialog
      )
        continue;
      const tabs = this.#tabStates(session);
      if (
        tabs.some(
          (tab) =>
            tab.owner !== 'agent' ||
            tab.pinned ||
            ![null, 'active'].includes(tab.protectedReason) ||
            this.#now() - Date.parse(tab.lastUsedAt) < TAB_IDLE_MS
        )
      )
        continue;
      await this.close(workspaceId);
      retired.push(workspaceId);
    }
    return retired;
  }

  async #start(workspaceId: string, root: string): Promise<Session> {
    const recovery: BrowserRecovery = {
      tabs: [],
      omitted: 0,
      note: 'These pages were open before the browser restarted. Reopen a URL in a new tab, then inspect the page. Unsaved form state is not restored. Never repeat a submission merely because its tab closed; consult its action receipt and verify the outcome.'
    };
    if (this.#tabJournal) {
      try {
        Object.assign(recovery, await this.#tabJournal.read(root));
      } catch {
        recovery.unavailable = true;
      }
    }
    const profile = path.join(root, '.garden', 'browser');
    // systemd kills the runner's full process group on restart. Chromium can
    // nevertheless leave these exact profile locks behind after a crash.
    await Promise.all(
      ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((name) =>
        rm(path.join(profile, name), { force: true })
      )
    );
    // A staged upload only matters while the form that may submit it is open, which is the life
    // of a session. Anything left here belongs to a session that is already gone.
    await clearStagedUploads(root);
    const displayEnvironment = await this.#displayEnvironment(workspaceId, root);
    const ladder = browserLaunchLadder({
      displayAvailable: Boolean(displayEnvironment),
      runningAsRoot: typeof process.getuid === 'function' && process.getuid() === 0
    });
    const chromium = await chromiumDriver();
    const gui = await this.options.gui?.acquire(root);
    let context: BrowserContext | undefined;
    let refused: unknown;
    let settled: BrowserLaunchAttempt | undefined;
    for (const attempt of ladder) {
      settled = attempt;
      try {
        context = await chromium.launchPersistentContext(profile, {
          ...(gui
            ? { executablePath: gui.executable }
            : this.options.executablePath
              ? { executablePath: this.options.executablePath }
              : {}),
          ...browserLaunchOptions(attempt),
          env: {
            ...browserLaunchEnvironment(
              process.env,
              attempt.headless ? {} : (displayEnvironment ?? {})
            ),
            ...gui?.environment,
            ...(gui
              ? { GARDEN_GUI_BROWSER: this.options.executablePath ?? chromium.executablePath() }
              : {}),
            ...(attempt.headless ? {} : displayEnvironment)
          },
          acceptDownloads: true,
          // Without this Playwright stages downloads in a temp directory it deletes on close,
          // which both loses late arrivals and puts the bytes outside storage accounting.
          downloadsPath: path.join(root, '.garden', 'downloads')
        });
        break;
      } catch (cause) {
        refused = cause;
      }
    }
    if (!context) {
      await gui?.release();
      throw new Error(
        'The browser could not start with its renderer sandbox. Run garden doctor to inspect this host.',
        { cause: refused }
      );
    }
    /*
     * Applied as soon as there is something to apply it to, and again on the sweep below.
     *
     * Chromium forks for the life of a session - a renderer per tab, a fresh GPU process after a
     * crash - and a child forked before this ran keeps the priority it inherited. One pass here
     * catches the startup tree, including the GPU process that is the one that actually pins this
     * machine; the minute sweep catches everything after.
     */
    await this.#dampen(profile);
    let closed = false;
    let active: Session | undefined;
    // Page creation and desktop control can both await while Chromium exits.
    context.once('close', () => {
      closed = true;
      void gui?.release().catch(() => {
        runnerLogger.warn('browser.cleanup_failed', { workspaceId });
      });
      if (!active) return;
      active.ending = true;
      if (active.recoveryTimer) clearTimeout(active.recoveryTimer);
      if (active.tabSweep) clearInterval(active.tabSweep);
      active.detachControl?.();
      delete active.detachControl;
      this.#attached.delete(active);
      if (this.#sessions.get(workspaceId) === active) this.#sessions.delete(workspaceId);
    });
    // A display failure changes presentation, so report when only headless mode could start.
    if (settled !== ladder[0])
      runnerLogger.warn('browser.reduced_launch', {
        workspaceId,
        headless: settled?.headless,
        sandbox: settled?.chromiumSandbox,
        code: failureCode(refused)
      });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const session: Session = {
        ...(this.#tabJournal ? { recovery } : {}),
        context,
        page,
        root,
        gui,
        // The desktop was started a few lines above, by `#displayEnvironment`, precisely so this
        // browser could run on its screen - so if this workspace has a desktop at all its control
        // exists by now and this browser joins it rather than minting a rival.
        control:
          (await this.#sharedControl(workspaceId, root)) ??
          new DesktopControl({ subject: 'Browser control' }),
        streamQueue: Promise.resolve(),
        streamTitle: '',
        consoleMessages: [],
        failedRequests: [],
        // One directory per browser session keeps a re-download of the same file from silently
        // overwriting the copy an earlier session handed the user.
        downloadsDirectory: path.join(
          'workspace',
          'downloads',
          new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        ),
        downloads: new BrowserDownloadHistory(),
        downloadPublication: Promise.resolve(),
        pendingDownloads: new Set(),
        tabs: new Map(),
        tabLifecycle: new BrowserTabs(),
        walls: new BotWallLedger()
      };
      const attachPage = (
        candidate: Page,
        owner: 'agent' | 'user' = 'user',
        taskId: string | null = null
      ) => {
        const tabId = `tab-${randomUUID()}`;
        session.tabs.set(tabId, candidate);
        this.#tabLifecycle(session).add(tabId, owner, taskId, this.#now());
        candidate.on('close', () => {
          session.tabs.delete(tabId);
          session.tabLifecycle?.remove(tabId);
          session.walls.forgetTab(tabId);
          this.#notifyStreamState(session);
        });
        candidate.on('console', (message) => {
          session.consoleMessages.push({
            level: message.type(),
            text: message.text().slice(0, 2_000),
            url: message.location().url.slice(0, 2_000),
            at: new Date().toISOString()
          });
          if (session.consoleMessages.length > 200) session.consoleMessages.splice(0, 50);
        });
        candidate.on('pageerror', (error) => {
          session.consoleMessages.push({
            level: 'pageerror',
            text: error.message.slice(0, 2_000),
            url: candidate.url().slice(0, 2_000),
            at: new Date().toISOString()
          });
          if (session.consoleMessages.length > 200) session.consoleMessages.splice(0, 50);
        });
        /*
         * Observation only. `page.on('response')` and `page.on('requestfailed')` are events Chromium
         * is already emitting; `page.route()` would be the other way to see this and it turns on
         * `Network.setCacheDisabled` and `Fetch.enable('*')` for the whole session, making every
         * navigation a cold fetch - which `docs/design/browser-automation.md` lists as a pitfall by
         * name. Nothing here modifies, blocks or re-issues a request.
         */
        candidate.on('response', (response) => {
          const status = response.status();
          if (status >= 400) {
            recordFailedRequest(session, response.request().method(), status, response.url());
            return;
          }
          // A redirect that crosses an origin is how a submit ends up at an auth wall while every
          // status on the way is a success. The landing page then looks like the site rejecting the
          // values, which sends the agent back to re-type fields that were already right.
          //
          // The URL recorded is where it was SENT, not what was asked for: `302 GET
          // accounts.example.com/login` says what happened, where the requested address would read
          // as an ordinary page. The status is what marks it as a redirect rather than a failure.
          if (status < 300 || status >= 400) return;
          const location = response.headers()['location'];
          if (!location) return;
          try {
            if (new URL(location, response.url()).origin === new URL(response.url()).origin) return;
          } catch {
            return;
          }
          recordFailedRequest(session, response.request().method(), status, location);
        });
        candidate.on('requestfailed', (request) => {
          // No response arrived at all: a CORS rejection, a DNS failure, a connection reset or an
          // abort. Reported as status 0 because that is what the model needs to tell "the server
          // said no" from "the request never landed".
          recordFailedRequest(session, request.method(), 0, request.url());
        });
        candidate.on('dialog', (dialog) => {
          session.pendingDialog = dialog;
          session.tabLifecycle?.dialog(tabId, true);
          // Parking the handle suppresses Playwright's auto-dismiss, so the page is stopped from
          // here until something answers. Telling the pane is the whole of the owner's way out.
          this.#notifyStreamState(session);
        });
        /*
         * The two events that can change what the pane is showing without anything here asking.
         *
         * The title used to be re-read per frame, which paid for freshness thirty times a second
         * and gated the frame ack on it. Reading it when the page says it has one costs two bounded
         * reads per navigation instead - and only for the tab actually being watched, because
         * background tabs are not on the stream.
         */
        const republish = () => {
          void this.#refreshTabTitle(session, tabId, candidate);
        };
        candidate.on('domcontentloaded', republish);
        candidate.on('load', republish);
        candidate.on('framenavigated', (frame) => {
          if (!frame.parentFrame()) this.#notifyStreamState(session);
        });
        candidate.on('download', (download) => {
          if (session.pendingDownloads.size >= DOWNLOAD_SAVE_LIMIT) {
            const url = download.url().slice(0, 2_000);
            void download.cancel().then(
              () =>
                session.downloads.record(
                  {
                    path: null,
                    url,
                    error:
                      'Download cancelled because too many files are still saving; retry after they complete'
                  },
                  true
                ),
              () =>
                session.downloads.record({
                  path: null,
                  url,
                  error:
                    'Download refused because too many files are still saving; cancellation failed'
                })
            );
            return;
          }
          const saving = this.#saveDownload(session, root, download);
          session.tabLifecycle?.download(tabId, 1);
          session.pendingDownloads.add(saving);
          void saving.finally(() => {
            session.pendingDownloads.delete(saving);
            session.tabLifecycle?.download(tabId, -1);
            this.#notifyStreamState(session);
          });
        });
        void this.#refreshTabTitle(session, tabId, candidate);
        return tabId;
      };
      for (const candidate of context.pages()) attachPage(candidate);
      context.on('page', (candidate) => {
        const creator = session.creatingTab;
        const tabId = attachPage(candidate, creator?.owner, creator?.taskId);
        if (!creator && typeof candidate.opener === 'function')
          void candidate
            .opener()
            .then((opener) => {
              const sourceId = opener ? tabIdFor(session, opener) : null;
              const source = sourceId ? session.tabLifecycle?.ownership(sourceId) : undefined;
              if (source) session.tabLifecycle?.adopt(tabId, source);
              this.#notifyStreamState(session);
              void this.sweepTabs(workspaceId).catch(() => undefined);
            })
            .catch(() => undefined);
        this.#notifyStreamState(session);
        // An ad or oauth popup opens a page too; it stays a background tab the agent can
        // select deliberately instead of hijacking the one being driven.
        if (!shouldAdoptNewPage(session.page)) return;
        session.page = candidate;
        void this.#retargetStream(session).catch(() => undefined);
      });
      // Nothing here masks automation. The switch that used to suppress `navigator.webdriver`
      // (`--disable-blink-features=AutomationControlled`) has been removed, because masking it is
      // bot-defence evasion, which SECURITY.md places out of scope and which the owner would be
      // the one exposed for. Sites that refuse automation are recognised and handed to the owner.
      if (closed) throw new Error('Browser context closed during startup');
      active = session;
      this.#sessions.set(workspaceId, session);
      session.tabSweep = setInterval(() => {
        void this.sweepTabs(workspaceId).catch(() => undefined);
      }, TAB_SWEEP_MS);
      session.tabSweep.unref();
      // Registered the moment the session exists rather than at its first action, so a handover that
      // arrives while this browser has only ever been watched still lifts what it is holding down.
      this.#controlOf(session);
      return session;
    } catch (cause) {
      try {
        await context.close();
        await gui?.release();
      } catch (cleanupFailure) {
        const unfinished = context;
        this.#failedStarts.set(workspaceId, async () => {
          await unfinished.close();
          await gui?.release();
        });
        throw new AggregateError([cause, cleanupFailure], 'Browser startup cleanup failed');
      }
      throw cause;
    }
  }

  async #displayEnvironment(
    workspaceId: string,
    root: string
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if (!this.options.desktopDisplay) return undefined;
    const environment = await this.options.desktopDisplay(workspaceId, root).catch(() => undefined);
    return environment?.DISPLAY ? environment : undefined;
  }

  async #saveDownload(session: Session, root: string, download: Download): Promise<void> {
    const url = download.url().slice(0, 2_000);
    try {
      const stream = await download.createReadStream();
      let readFailure: Error | undefined;
      const onError = (cause: Error) => {
        readFailure = cause;
      };
      stream.on('error', onError);
      try {
        // Completed transfers can arrive together; publication must not multiply the file buffer
        // allowance by the number of concurrent downloads.
        const publication = session.downloadPublication.then(async () => {
          if (readFailure) throw readFailure;
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const part of stream) {
            const value: unknown = part;
            if (typeof value !== 'string' && !(value instanceof Uint8Array))
              throw new Error('Download stream returned an unsupported chunk');
            const chunk: Buffer = Buffer.from(value);
            size += chunk.length;
            if (size > this.options.maxFileBytes)
              throw new Error(`Download exceeds ${this.options.maxFileBytes} byte file limit`);
            chunks.push(chunk);
          }
          const saved = await saveDownloadFile(
            root,
            session.downloadsDirectory,
            downloadFileName(download.suggestedFilename()),
            Buffer.concat(chunks, size),
            this.options.maxFileBytes
          );
          session.downloads.record({ path: saved, url });
        });
        session.downloadPublication = publication.catch(() => undefined);
        await publication;
      } finally {
        stream.destroy();
        stream.off('error', onError);
      }
    } catch (cause) {
      session.downloads.record({
        path: null,
        url,
        error: cause instanceof Error ? cause.message.slice(0, 300) : 'Download could not be saved'
      });
    } finally {
      await download
        .delete()
        .catch((cause: unknown) =>
          runnerLogger.warn('browser.download_cleanup_failed', { code: failureCode(cause) })
        );
    }
  }

  async #settleDownloads(session: Session): Promise<void> {
    // Chromium reports the download just after the click that caused it resolves, so an action
    // that could start one waits a beat before concluding that nothing arrived.
    if (!session.pendingDownloads.size)
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_START_GRACE_MS));
    if (!session.pendingDownloads.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...session.pendingDownloads]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, DOWNLOAD_SETTLE_MS);
      })
    ]);
    if (timer) clearTimeout(timer);
  }

  async snapshot(
    workspaceId: string,
    root: string,
    actor: 'agent' | 'user',
    cursor: SnapshotCursor = {}
  ) {
    const session = await this.ensure(workspaceId, root);
    if (session.control.holder === 'secure_input' && actor === 'agent') {
      throw new Error('Browser is in secure input mode');
    }
    if (session.control.holder === 'secure_input') {
      return composeBrowserSnapshot({
        url: session.page.url(),
        title: await session.page.title(),
        holder: session.control.holder,
        botWall: null,
        elements: [],
        // Nothing was scanned, so nothing was cut: zero here is "no list to be missing from",
        // not "the list is complete".
        elementsOmitted: 0,
        framesOmitted: 0,
        tabs: [],
        downloads: [],
        pendingDialog: null,
        consoleMessages: [],
        failedRequests: [],
        images: [],
        screenshotBase64: '',
        text: ''
      });
    }
    if (session.control.holder === 'user' && actor === 'agent')
      throw new Error('Browser is held by the user');
    const page = session.page;
    this.#assertReadablePage(page, actor);
    // The standing wall is re-read against the live page first, so a challenge that has since
    // passed on its own leaves an ordinary snapshot rather than a permanent refusal.
    let wall = await this.#reviewWall(session, page);
    const text = await page
      .locator('body')
      .innerText({ timeout: 5_000 })
      .catch(() => '');
    const title = await page.title().catch(() => '');
    if (!wall) {
      const detected = detectBotWall({
        url: page.url(),
        title,
        text,
        frameUrls: await this.#unacknowledgedFrames(page)
      });
      if (detected) wall = this.#raiseWall(session, page, detected);
    }
    if (wall) {
      // Deliberately no screenshot, no elements and no page text: what a challenge page contains
      // is a puzzle, and putting it in front of the model is an invitation to have a go at it.
      return composeBrowserSnapshot({
        url: page.url(),
        title,
        holder: session.control.holder,
        botWall: wall,
        elements: [],
        elementsOmitted: 0,
        framesOmitted: 0,
        tabs: await sessionTabs(session),
        recovery: this.#recovery(session),
        downloads: [],
        pendingDialog: null,
        consoleMessages: [],
        // Withheld with everything else on a challenge page: what the challenge's own requests
        // did is a description of the puzzle.
        failedRequests: [],
        images: [],
        screenshotBase64: '',
        text: botWallMessage(wall)
      });
    }
    const screenshot = continuesSnapshotText(text, cursor)
      ? null
      : await captureScreenshot(page, 'jpeg');
    const images = await withDeadline(
      page.evaluate(() =>
        Array.from(document.images)
          .filter((image) => image.currentSrc || image.src)
          .slice(0, 100)
          .map((image) => ({
            url: image.currentSrc || image.src,
            alt: image.alt.slice(0, 500),
            width: image.naturalWidth,
            height: image.naturalHeight
          }))
      ),
      PAGE_SCRIPT_TIMEOUT_MS,
      []
    );
    const scan = await this.#scanPage(page);
    return composeBrowserSnapshot(
      {
        url: page.url(),
        title,
        holder: session.control.holder,
        botWall: null,
        elements: scan.elements,
        elementsOmitted: scan.elementsOmitted,
        framesOmitted: scan.framesOmitted,
        tabs: await sessionTabs(session),
        recovery: this.#recovery(session),
        // A download that outlived the action that started it is only discoverable here.
        downloads: session.downloads.recent.slice(-10),
        pendingDialog: session.pendingDialog
          ? { type: session.pendingDialog.type(), message: session.pendingDialog.message() }
          : null,
        consoleMessages: session.consoleMessages.slice(-40),
        // Already bounded to `FAILED_REQUEST_LIMIT` as it was recorded; copied so a later failure
        // cannot mutate a payload that has been handed out.
        failedRequests: [...session.failedRequests],
        images,
        screenshotBase64: screenshot?.toString('base64') ?? '',
        text
      },
      cursor
    );
  }

  /**
   * Payment forms, embedded editors and consent dialogs live in iframes, so the scan walks every
   * frame the page exposes rather than the top document alone. The ref carries the frame ordinal,
   * which is how an action finds the frame the control belongs to again.
   */
  async #scanPage(
    page: Page,
    rootSelector?: string,
    valueLimit = ELEMENT_VALUE_LIMIT
  ): Promise<{
    elements: BrowserSnapshotElement[];
    elementsOmitted: number;
    framesOmitted: number;
  }> {
    const elements: BrowserSnapshotElement[] = [];
    const frames = page.frames();
    let elementsOmitted = 0;
    let scannedFrames = 0;
    for (const [ordinal, frame] of frames.slice(0, SNAPSHOT_FRAME_LIMIT).entries()) {
      const budget = SNAPSHOT_ELEMENT_LIMIT - elements.length;
      // A frame reached with no budget left is a frame nobody looked at, so it is counted as
      // omitted rather than skipped silently - and it is the LAST frames that go, which is where
      // consent, payment and submit frames live.
      if (budget <= 0) break;
      scannedFrames += 1;
      const scan = await scanFrameElements(frame, ordinal, budget, rootSelector, valueLimit);
      elementsOmitted += scan.omitted;
      for (const scanned of scan.elements) {
        const { ref, ...rest } = scanned;
        elements.push({
          index: elements.length,
          selector: `[data-garden-ref="${ref}"]`,
          ...rest
        });
      }
    }
    // Both ways a frame goes unread at once: past `SNAPSHOT_FRAME_LIMIT`, or reached after the
    // element budget had already run out.
    return { elements, elementsOmitted, framesOmitted: frames.length - scannedFrames };
  }

  /**
   * Reads the controls of one form without a screenshot, so checking that thirty fields hold what
   * was typed costs thirty cheap reads instead of thirty full snapshots.
   */
  async readElements(
    workspaceId: string,
    root: string,
    input: { selector?: string | undefined; tabId?: string | undefined },
    actor: 'agent' | 'user'
  ) {
    const session = await this.ensure(workspaceId, root);
    if (session.control.holder === 'secure_input')
      throw new Error('Browser is in secure input mode');
    session.control.authorize(actor);
    const page = resolveTab(session, input.tabId);
    if (actor === 'agent') await this.#assertNoWall(session, page);
    this.#assertReadablePage(page, actor);
    const scan = await this.#scanPage(page, input.selector, FORM_VALUE_LIMIT);
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      tabId: tabIdFor(session, page),
      elements: scan.elements,
      // The same two counts the snapshot carries, for the same reason. A scoped read of one form
      // rarely reaches 250 controls, but an unscoped one is the same page the snapshot walks, and
      // a truncated list that does not say so is the defect either way.
      elementsOmitted: scan.elementsOmitted,
      framesOmitted: scan.framesOmitted
    };
  }

  /**
   * Records the stop. The holder is deliberately left where it was: taking the browser off the
   * agent used to be what made this a stop, but it stopped everything - unrelated tabs, unrelated
   * sites, the whole task - and it could only be undone by a person. The stop is now the wall
   * itself, which no agent call can cross and no agent call can clear.
   */
  #raiseWall(session: Session, page: Page, wall: BotWall): BotWallReport {
    const report = session.walls.raise(tabIdFor(session, page), wall);
    this.#notifyStreamState(session);
    return report;
  }

  /**
   * Re-reads the live page behind a standing wall, so a challenge that has passed stops being one.
   * Every agent entry goes through here rather than trusting the flag, and nothing here reloads or
   * re-requests: the page is only looked at again.
   */
  async #reviewWall(session: Session, page: Page): Promise<BotWallReport | null> {
    const tabId = tabIdFor(session, page);
    const standing = session.walls.standing(tabId);
    if (!standing || tabId === null) return null;
    const current = reviewBotWall(standing, {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: await page
        .locator('body')
        .innerText({ timeout: 2_000 })
        .catch(() => ''),
      frameUrls: await this.#unacknowledgedFrames(page)
    });
    if (current) return session.walls.raise(tabId, current);
    session.walls.clear(tabId, standing.url);
    this.#notifyStreamState(session);
    return null;
  }

  async #assertNoWall(session: Session, page: Page): Promise<void> {
    const wall = await this.#reviewWall(session, page);
    if (wall) throw new BotWallError(wall);
  }

  /**
   * The other half of the address policy: what the agent is allowed to read back. A page can move
   * itself long after the navigation that opened it returned, so guarding only the navigation would
   * leave a script on an injected page free to send the tab at a loopback service and let the next
   * snapshot do the reading.
   */
  #assertReadablePage(page: Page, actor: 'agent' | 'user'): void {
    if (actor !== 'agent') return;
    if (!agentReachablePage(page.url()))
      throw new Error(
        `This tab is on ${page.url().slice(0, 200)}, which is not an address on the public internet, so its contents are not read back`
      );
  }

  /** Refuses a site a challenge is standing on, whichever tab the request would go out from. */
  #assertHostOpen(session: Session, requestedUrl: string): void {
    const closed = session.walls.hostClosed(requestedUrl);
    if (closed) throw new BotWallError({ ...closed, tabId: null });
  }

  /**
   * Reads a set of public pages in throwaway contexts of their own. It deliberately touches
   * neither the session browser nor its walls: these are one-shot document reads in a browser with
   * no profile, no cookies and no shared state, so a challenge on one site the agent was driving
   * has nothing to say about a paper on another - and the owner holding the browser to deal with
   * one is no reason for the research half of the task to stop.
   */
  async readMany(
    root: string,
    urls: string[],
    maxCharactersPerPage: number
  ): Promise<ParallelWebReadResult> {
    const unique = [...new Set(urls)].slice(0, 12);
    if (unique.some((url) => !isPublicHttpUrl(url)))
      throw new Error('Parallel web reading accepts public HTTP(S) URLs only');
    const results: ResearchReadResult[] = unique.map((requestedUrl) => ({
      requestedUrl,
      error: 'Source was not read'
    }));
    let cursor = 0;
    const research = await this.#launchIsolatedBrowser(root);
    const researchBrowser = research.browser;
    const readNext = async () => {
      for (;;) {
        const index = cursor++;
        const requestedUrl = unique[index];
        if (requestedUrl === undefined) return;
        const withoutScripts = await this.#readResearchSource(researchBrowser, requestedUrl, {
          scripts: false,
          maxCharactersPerPage
        });
        // Scripts are off by default because most primary sources do not need them and a source
        // that cannot run code cannot do anything else either. The cost is that an app-shaped
        // page returns its empty shell, which reads as a source that said nothing rather than as
        // one that was never rendered - so a thin answer is worth exactly one honest retry.
        results[index] =
          withoutScripts.error === undefined && !needsScriptedRender(withoutScripts.text ?? '')
            ? withoutScripts
            : await this.#readResearchSource(researchBrowser, requestedUrl, {
                scripts: true,
                maxCharactersPerPage
              }).then((rendered) => (rendered.error === undefined ? rendered : withoutScripts));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, unique.length) }, () => readNext()));
      return { sources: results, requested: urls.length, read: unique.length };
    } finally {
      await research.close();
    }
  }

  /**
   * One search, answered as data. The alternative it replaces was driving the browser to an engine
   * and reading the results out of a snapshot, which spent a screenshot and a 250-element scan on
   * ten links and put the model on the page of every site most likely to challenge it.
   *
   * It is answered from an isolated browser first and from the session browser only as a second
   * attempt - see the note at the top of search.ts for why a search stopped sharing the browsing
   * session. What follows from that here: this never launches the session browser, so a research
   * task needs no desktop Chromium at all; it never consults the session's walls except to decide
   * whether the second attempt is worth making; and a challenge on the isolated route is remembered
   * for a minute against searching alone, leaving every other tab, every other site and every other
   * tool untouched.
   */
  async search(
    workspaceId: string,
    root: string,
    input: { query: string; limit: number },
    actor: 'agent' | 'user'
  ): Promise<{
    engine: string;
    query: string;
    route: SearchRoute;
    results: WebSearchResult[];
  }> {
    const searchUrl = duckDuckGoSearchUrl(input.query);
    const session = this.#sessions.get(workspaceId);
    const remembered = this.#searchWalls.get(workspaceId);
    const backingOff =
      remembered !== undefined && Date.now() - remembered.at <= SEARCH_WALL_BACKOFF_MS;
    if (remembered !== undefined && !backingOff) this.#searchWalls.delete(workspaceId);
    const plan = searchRoutePlan({
      actor,
      sessionHolder: session?.control.holder ?? null,
      sessionHostClosed: session ? session.walls.hostClosed(searchUrl) !== null : false,
      isolatedBackoffActive: backingOff
    });
    // Reachable only while the isolated route is backing off with no usable session behind it, so
    // the wall being reported is always the one that put it there - answered from memory rather
    // than by launching a second browser to be refused again.
    if (plan.length === 0 && remembered) throw new SearchWallError(remembered.wall);
    let stopped: BotWallError | SearchWallError | null = null;
    for (const route of plan) {
      try {
        if (route === 'session') {
          if (!session) continue;
          return { ...(await this.#searchInSession(session, searchUrl, input)), route };
        }
        return { ...(await this.#searchIsolated(workspaceId, root, searchUrl, input)), route };
      } catch (cause) {
        if (!(cause instanceof BotWallError) && !(cause instanceof SearchWallError)) throw cause;
        stopped = cause;
      }
    }
    // The session wall wins when both raised one, because it is the one with a page behind it that
    // the owner can actually clear.
    if (stopped) throw stopped;
    // Unreachable: an empty plan is answered above, and every route either returns or raises a
    // wall. Stated rather than asserted, because a sentence is a better failure than a cast.
    throw new Error('No browser was available to answer this search');
  }

  /**
   * The search as a one-shot read: a browser of its own, launched for this query and closed after
   * it, which is what makes a challenge here cost one search rather than the session.
   */
  async #searchIsolated(
    workspaceId: string,
    root: string,
    searchUrl: string,
    input: { query: string; limit: number }
  ): Promise<{ engine: string; query: string; results: WebSearchResult[] }> {
    const research = await this.#launchIsolatedBrowser(root);
    const browser = research.browser;
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        viewport: { width: 1280, height: 900 }
      });
      const page = await context.newPage();
      const response = await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      });
      const wall = detectBotWall({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: await page
          .locator('body')
          .innerText({ timeout: 5_000 })
          .catch(() => ''),
        frameUrls: await this.#unacknowledgedFrames(page),
        status: response?.status() ?? null,
        headers: response?.headers() ?? {}
      });
      if (wall) {
        // Remembered against searching, not against the site: `browser_action` may still be driven
        // to the engine, and every other host is untouched. This is the whole cost of the wall.
        this.#searchWalls.set(workspaceId, { wall, at: Date.now() });
        throw new SearchWallError(wall);
      }
      this.#searchWalls.delete(workspaceId);
      return {
        engine: SEARCH_ENGINE,
        query: input.query.trim(),
        results: searchResults(await page.evaluate(readSearchRows), input.limit)
      };
    } finally {
      await research.close();
    }
  }

  /**
   * The second attempt, through the profile the owner can see and take over. The results tab is
   * opened in the background so the page being worked on keeps the screen, and closed as soon as it
   * has been read - unless it is a challenge, which is left open precisely because it is the page
   * the owner has to be handed.
   */
  async #searchInSession(
    session: Session,
    searchUrl: string,
    input: { query: string; limit: number }
  ): Promise<{ engine: string; query: string; results: WebSearchResult[] }> {
    const page = await session.context.newPage();
    let challenged = false;
    try {
      const response = await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      });
      const wall = detectBotWall({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: await page
          .locator('body')
          .innerText({ timeout: 5_000 })
          .catch(() => ''),
        frameUrls: await this.#unacknowledgedFrames(page),
        status: response?.status() ?? null,
        headers: response?.headers() ?? {}
      });
      if (wall) {
        challenged = true;
        throw new BotWallError(this.#raiseWall(session, page, wall));
      }
      return {
        engine: SEARCH_ENGINE,
        query: input.query.trim(),
        results: searchResults(await page.evaluate(readSearchRows), input.limit)
      };
    } finally {
      if (!challenged) await page.close().catch(() => undefined);
    }
  }

  /**
   * A browser with no profile, no cookies and no shared state, for work that is a fetch rather than
   * a session: the research fan-out and the search route. Headless because nobody is watching it,
   * and one per call because the isolation is the point.
   */
  async #launchIsolatedBrowser(
    root: string
  ): Promise<{ browser: Browser; close(): Promise<void> }> {
    const gui = await this.options.gui?.acquireTemporary(root);
    try {
      const launch = async () => {
        if (this.options.launchIsolatedBrowser) return this.options.launchIsolatedBrowser();
        const driver = await chromiumDriver();
        return launchSandboxedResearchBrowser(driver, {
          executablePath: gui?.executable ?? this.options.executablePath,
          runningAsRoot: typeof process.getuid === 'function' && process.getuid() === 0,
          environment: process.env,
          guiEnvironment: gui
            ? {
                ...gui.environment,
                GARDEN_GUI_BROWSER: this.options.executablePath ?? driver.executablePath()
              }
            : undefined
        });
      };
      const browser = await launch();
      return {
        browser,
        close: async () => {
          try {
            await browser.close();
          } finally {
            await gui?.release();
          }
        }
      };
    } catch (cause) {
      await gui?.release();
      throw cause;
    }
  }

  async #readResearchSource(
    researchBrowser: Browser,
    requestedUrl: string,
    options: { scripts: boolean; maxCharactersPerPage: number }
  ): Promise<ResearchReadResult> {
    const context = await researchBrowser.newContext({
      javaScriptEnabled: options.scripts,
      acceptDownloads: false,
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    try {
      await assertPublicHttpUrl(requestedUrl);
      let blockedReason = '';
      let documentOrigin = new URL(requestedUrl).origin;
      await page.route('**/*', async (route) => {
        const request = route.request();
        const requestUrl = request.url();
        const isDocument = request.resourceType() === 'document';
        if (
          !researchResourceAllowed({
            resourceType: request.resourceType(),
            requestUrl,
            documentOrigin,
            scripts: options.scripts
          })
        ) {
          await route.abort('blockedbyclient');
          return;
        }
        try {
          await assertPublicHttpUrl(requestUrl);
          if (isDocument) documentOrigin = new URL(requestUrl).origin;
          await route.continue();
        } catch (cause) {
          blockedReason =
            cause instanceof Error ? cause.message : 'Source resolved outside the public web';
          await route.abort('blockedbyclient');
        }
      });
      const response = await page.goto(requestedUrl, {
        waitUntil: options.scripts ? 'load' : 'domcontentloaded',
        timeout: 30_000
      });
      if (blockedReason) throw new Error(blockedReason);
      if (!isPublicHttpUrl(page.url()))
        throw new Error('Source redirected to a private or local address');
      const server = await response?.serverAddr();
      if (!server || !isPublicInternetAddress(server.ipAddress))
        throw new Error('Source connected to a private, reserved, or local address');
      const [title, text] = await Promise.all([
        page.title().catch(() => ''),
        page
          .locator('body')
          .innerText({ timeout: 8_000 })
          .catch(() => '')
      ]);
      return {
        requestedUrl,
        url: page.url(),
        title,
        text: text.slice(0, options.maxCharactersPerPage),
        ...(options.scripts ? { renderedWithScripts: true } : {})
      };
    } catch (cause) {
      return {
        requestedUrl,
        error: cause instanceof Error ? cause.message.slice(0, 500) : 'Source read failed'
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /**
   * Everything the pane needs, read without touching the page.
   *
   * Deliberately synchronous. This used to await `page.title()`, and it was called once per
   * screencast frame from inside the handler that acks them - so the frame rate was bounded by a
   * round trip to the page's main thread, and a page that blocked its main thread (a long
   * synchronous parse, an un-yielded WASM loop, a stray `debugger`) never resolved it, never
   * acked, and froze the pane permanently with the socket still open and no error anywhere. The
   * one field that genuinely needs the page is cached on the session and refreshed on the events
   * that change it.
   */
  #streamState(session: Session): BrowserStreamState {
    return {
      url: session.page.url(),
      title: session.streamTitle,
      holder: session.control.holder,
      width: BROWSER_VIEWPORT.width,
      height: BROWSER_VIEWPORT.height,
      transport: 'chromium_screencast',
      tabs: session.control.holder === 'secure_input' ? [] : this.#tabStates(session),
      recovery: this.#recovery(session),
      cleanup: { ...this.#tabLifecycle(session).cleanup },
      botWall: session.walls.latest(),
      pendingDialog: session.pendingDialog
        ? { type: session.pendingDialog.type(), message: session.pendingDialog.message() }
        : null
    };
  }

  /** Takes a title an action has already read, rather than asking the page for it again. */
  #adoptStreamTitle(session: Session, tabId: string | null, title: string): void {
    if (tabId) this.#tabLifecycle(session).setTitle(tabId, title);
    if (!session.stream || tabId !== tabIdFor(session, session.page)) return;
    session.streamTitle = title;
    this.#notifyStreamState(session);
  }

  #notifyStreamState(session: Session): void {
    this.#scheduleTabMemory(session);
    if (!session.stream) return;
    const state = this.#streamState(session);
    for (const subscriber of session.stream.subscribers) subscriber.state(state);
  }

  /**
   * Re-reads the one thing only the page can answer, then publishes.
   *
   * Bounded, because `page.title()` has no timeout of its own and does not acquire one from
   * `setDefaultTimeout`: on a blocked main thread it simply never settles. A stale title in the
   * pane is a cosmetic loss; a promise that never resolves on the stream path was the freeze.
   */
  async #refreshStreamState(session: Session): Promise<void> {
    if (!session.stream) return;
    session.streamTitle = await withDeadline(
      session.page.title(),
      STREAM_TITLE_TIMEOUT_MS,
      session.streamTitle
    );
    this.#notifyStreamState(session);
  }

  async #refreshTabTitle(session: Session, tabId: string, page: Page): Promise<void> {
    const lifecycle = this.#tabLifecycle(session);
    const title = await withDeadline(
      page.title().catch(() => ''),
      STREAM_TITLE_TIMEOUT_MS,
      lifecycle.title(tabId)
    );
    if (!session.tabs.has(tabId)) return;
    lifecycle.setTitle(tabId, title);
    if (page === session.page) session.streamTitle = title;
    this.#notifyStreamState(session);
  }

  async #startStream(
    session: Session,
    subscribers: Set<BrowserStreamSubscriber> = new Set()
  ): Promise<void> {
    const cdp = await session.context.newCDPSession(session.page);
    const stream: BrowserStream = { cdp, subscribers };
    session.stream = stream;
    cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
      // Acked first, and without waiting for it: Chromium sends no further frame until the
      // previous one is acknowledged, so anything between arrival and ack is a cap on the frame
      // rate. It used to be an awaited `page.title()`.
      void cdp
        .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
        .catch(() => undefined);
      if (session.control.holder === 'secure_input') return;
      const state = this.#streamState(session);
      const image = Buffer.from(frame.data, 'base64');
      for (const current of stream.subscribers) current.frame(image, state);
    });
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 72,
        maxWidth: BROWSER_VIEWPORT.width,
        maxHeight: BROWSER_VIEWPORT.height,
        everyNthFrame: 1
      });
    } catch (error) {
      delete session.stream;
      await cdp.detach().catch(() => undefined);
      throw error;
    }
  }

  /**
   * One screencast lifecycle operation at a time, the way `session.bridgeQueue` serializes the
   * desktop's AT-SPI bridge.
   *
   * Attaching a CDP session, starting the screencast, stopping it and detaching are four awaits
   * with `session.stream` read at the top and written at the bottom, and three callers reach them:
   * a subscriber joining, the last subscriber leaving, and the retarget every tab switch causes.
   * Interleaved they lose sessions - two joiners each saw no stream and each attached one, the
   * second's assignment won, and the first went on acking frames for the life of the browser with
   * nothing reading them. Chromium sends no further frame until the previous one is acked, so a
   * stray session is not merely a leak: it is a second consumer of the same frame budget.
   */
  #onStreamQueue<T>(session: Session, work: () => Promise<T>): Promise<T> {
    const run = session.streamQueue.then(work);
    session.streamQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #retargetStream(session: Session): Promise<void> {
    await this.#onStreamQueue(session, async () => {
      const previous = session.stream;
      if (!previous) return;
      delete session.stream;
      await previous.cdp.send('Page.stopScreencast').catch(() => undefined);
      await previous.cdp.detach().catch(() => undefined);
      await this.#startStream(session, previous.subscribers);
    });
    await this.#refreshStreamState(session);
  }

  async subscribeStream(
    workspaceId: string,
    root: string,
    subscriber: BrowserStreamSubscriber
  ): Promise<() => Promise<void>> {
    const session = await this.ensure(workspaceId, root);
    await this.#onStreamQueue(session, async () => {
      if (!session.stream) await this.#startStream(session);
      const started = session.stream;
      if (!started) throw new Error('Browser stream did not start');
      started.subscribers.add(subscriber);
    });
    // The one place a title read is unavoidable: nothing has happened yet to have refreshed it,
    // and this may be the first subscriber the session has ever had.
    session.streamTitle = await withDeadline(
      session.page.title(),
      STREAM_TITLE_TIMEOUT_MS,
      session.streamTitle
    );
    subscriber.state(this.#streamState(session));
    return () =>
      this.#onStreamQueue(session, async () => {
        const current = session.stream;
        if (!current) return;
        current.subscribers.delete(subscriber);
        if (current.subscribers.size > 0) return;
        delete session.stream;
        await current.cdp.send('Page.stopScreencast').catch(() => undefined);
        await current.cdp.detach().catch(() => undefined);
      });
  }

  async preflight(
    workspaceId: string,
    root: string,
    action: BrowserAction,
    actor: 'agent' | 'user'
  ): Promise<BrowserActionPreflight> {
    const session = await this.ensure(workspaceId, root);
    session.control.authorize(actor);
    if (action.type !== 'batch') return this.#classify(session, action);
    // A step later in the batch may target a control an earlier step reveals, so it cannot be
    // resolved yet. Those are classified again at the moment they run; what can be judged now is
    // judged now, so the owner is asked once, up front, for the whole batch.
    const steps = await Promise.all(
      action.actions.map(async (primitive, index) => ({
        index,
        preflight: await this.#classify(session, primitive, { timeout: 2_000, tolerant: true })
      }))
    );
    return combineBatchPreflight(steps);
  }

  async #classify(
    session: Session,
    action: BrowserAction | BrowserPrimitiveAction,
    options: { timeout: number; tolerant: boolean } = { timeout: 20_000, tolerant: false }
  ): Promise<BrowserActionPreflight> {
    if (
      !ELEMENT_POLICY_ACTIONS.includes(action.type) &&
      action.type !== 'click_at' &&
      action.type !== 'press'
    )
      return classifyBrowserAction(action);
    const targeted = action as Extract<
      BrowserAction,
      { type: 'click' | 'double_click' | 'type' | 'select_option' | 'upload' }
    >;
    const page = resolveTab(session, targeted.tabId);
    const target =
      action.type === 'click_at' || action.type === 'press'
        ? page.locator('html')
        : await resolveBrowserTarget(page, targeted.selector);
    const read = target.evaluate(
      (root, input) => {
        const target =
          input.type === 'click_at'
            ? (root.ownerDocument
                .elementFromPoint(input.x, input.y)
                ?.closest('button,input,textarea,[role="button"],canvas') ?? root)
            : input.type === 'press'
              ? (root.ownerDocument.activeElement ?? root)
              : root;
        const control = target as HTMLInputElement | HTMLButtonElement;
        const form = target.closest('form');
        return {
          tag: target.tagName.toLowerCase(),
          type: String(control.type ?? target.getAttribute('type') ?? '').toLowerCase(),
          name:
            target.getAttribute('aria-label') ||
            Array.from((control as HTMLInputElement).labels ?? [])
              .map((label) => label.textContent ?? '')
              .join(' ')
              .trim() ||
            target.getAttribute('placeholder') ||
            (target as HTMLElement).innerText?.trim().slice(0, 160) ||
            '',
          autocomplete: target.getAttribute('autocomplete') ?? '',
          formAction: form?.action ?? '',
          inForm: Boolean(form),
          pageUrl: target.ownerDocument.URL
        };
      },
      action.type === 'click_at'
        ? { type: action.type, x: action.x, y: action.y }
        : { type: action.type, x: 0, y: 0 },
      { timeout: options.timeout }
    );
    // A control that has not appeared yet is an answer only inside a batch, where the step is
    // classified again when it runs. On its own it is a failure the caller has to hear about,
    // because classifying an unresolvable target as harmless is how an unapproved submit lands.
    const element = options.tolerant ? await read.catch(() => undefined) : await read;
    const policy = classifyBrowserAction(action, element);
    const destinations = [
      ...new Set(
        [element?.pageUrl ?? page.url(), element?.formAction ?? ''].flatMap((value) => {
          try {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) ? [url.origin] : [];
          } catch {
            return [];
          }
        })
      )
    ];
    return {
      ...policy,
      ...(tabIdFor(session, page) ? { tabId: tabIdFor(session, page)! } : {}),
      destinations,
      preview:
        action.type === 'upload' && destinations.length
          ? `${policy.preview}\nWebsite: ${destinations.join(', ')}`
          : policy.preview
    };
  }

  /** The gate every agent action passes, whether it arrived on its own or inside a batch. */
  #enforce(policy: BrowserActionPreflight, consequentialApproved: boolean, where: string): void {
    if (policy.handoffKind)
      throw new Error('A personal signature requires the owner to take control');
    if (policy.sensitiveInput)
      throw new Error(`Secure input takeover is required for this browser field${where}`);
    if (policy.consequential && !consequentialApproved)
      throw new Error(`A browser consequential-action approval capability is required${where}`);
  }

  /**
   * Every browser action, through the one queue that arbitrates the screen.
   *
   * Three things sit on this path that did not before. The holder is checked once before the
   * session is ensured, so an owner who has taken the desktop refuses the agent's next browser
   * call without a Chromium being launched to be refused by. The work then runs inside a
   * `submit` slot, which re-checks the holder inside the slot: a call admitted a moment before a
   * takeover used to go on driving the page the owner had just taken. And the slot's abort signal
   * ends the action when the takeover arrives mid-flight - a `pressSequentially` of a long string
   * paces itself at 30 ms a character and had a full minute to keep typing into a page whose
   * owner was already using it.
   */
  async act(
    workspaceId: string,
    root: string,
    action: BrowserAction,
    actor: 'agent' | 'user',
    consequentialApproved = false,
    taskId: string | null = null,
    progress?: BrowserActionProgress
  ) {
    const shared = await this.#sharedControl(workspaceId, root);
    shared?.authorize(actor);
    const session = await this.ensure(workspaceId, root);
    return this.#adopt(session, shared).submit(actor, async (signal) => {
      try {
        return await this.#raceTakeover(
          signal,
          this.#act(session, root, action, actor, consequentialApproved, signal, taskId, progress)
        );
      } finally {
        await this.#rememberTabs(session);
      }
    });
  }

  /**
   * Playwright has no per-call cancellation, so the abort ends the *action*: the caller stops
   * waiting and no result is reported for work the owner did not authorise. What the takeover can
   * do to the page itself it has already done - `release` lifts every modifier and mouse button
   * this session was holding before the new holder's first event.
   */
  async #raceTakeover<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
    const takenOver = () => new Error('The browser was taken over while this action was running');
    if (signal.aborted) throw takenOver();
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(takenOver()), { once: true });
      })
    ]);
  }

  async #act(
    session: Session,
    root: string,
    action: BrowserAction,
    actor: 'agent' | 'user',
    consequentialApproved: boolean,
    signal: AbortSignal,
    taskId: string | null,
    progress?: BrowserActionProgress
  ) {
    session.caller = { owner: actor, taskId: actor === 'agent' ? taskId : null };
    return session.downloads.collect(async (receipts) => {
      if (action.type === 'batch') {
        const steps: Array<{
          index: number;
          type: BrowserPrimitiveAction['type'];
          ok: boolean;
          url?: string;
          error?: string;
        }> = [];
        for (const [index, primitive] of action.actions.entries()) {
          try {
            if (actor === 'agent') {
              await this.#guardStep(session, primitive);
              this.#enforce(
                await this.#classify(session, primitive),
                consequentialApproved,
                ` (batch step ${index + 1}, ${primitive.type})`
              );
            }
            progress?.begin(index, primitive.type);
            const result = await this.#perform(session, root, primitive);
            progress?.complete(index);
            steps.push({ index, type: primitive.type, ok: true, url: result.url });
          } catch (cause) {
            steps.push({
              index,
              type: primitive.type,
              ok: false,
              error: cause instanceof Error ? cause.message.slice(0, 400) : 'Browser step failed'
            });
            // Stopping here rather than pressing on: the steps after a failed one were written
            // against a page state that never happened.
            break;
          }
        }
        if (session.pendingDownloads.size) await this.#settleDownloads(session);
        return {
          url: session.page.url(),
          title: await session.page.title().catch(() => ''),
          tabId: tabIdFor(session, session.page),
          steps,
          completed: steps.filter((step) => step.ok).length,
          ...receipts,
          downloadsDirectory: session.downloadsDirectory
        };
      }
      if (actor === 'agent') {
        await this.#guardStep(session, action);
        this.#enforce(await this.#classify(session, action), consequentialApproved, '');
      }
      progress?.begin(0, action.type);
      const performed = await this.#perform(session, root, action);
      progress?.complete(0);
      // `#perform` has already paid for the title of the tab it acted on, so the pane gets it for
      // nothing. The page's own `load` events cover a navigation nobody here asked for; this covers
      // the far more common case of one that something here did.
      this.#adoptStreamTitle(session, performed.tabId, performed.title);
      if (DOWNLOAD_TRIGGERING_ACTIONS.includes(action.type) || session.pendingDownloads.size)
        await this.#settleDownloads(session);
      return { ...performed, ...receipts, downloadsDirectory: session.downloadsDirectory };
    }, signal);
  }

  /**
   * The wall check every agent step passes: the tab it lands on, and the site it is about to open.
   * Both halves are needed - one stops the agent working through a challenge page, the other stops
   * it opening the same site in a fresh tab, which is the retry the challenge is asking for.
   */
  async #guardStep(session: Session, action: BrowserPrimitiveAction): Promise<void> {
    for (const destination of stepDestinations(action)) {
      this.#assertHostOpen(session, destination);
      await assertAgentReachableUrl(destination);
    }
    // A fresh tab has no page of its own to review yet.
    if (action.type === 'new_tab') return;
    await this.#assertNoWall(
      session,
      resolveTab(session, 'tabId' in action ? action.tabId : undefined)
    );
  }

  async #perform(
    session: Session,
    root: string,
    action: BrowserPrimitiveAction
  ): Promise<{
    url: string;
    title: string;
    tabId: string | null;
    elements?: BrowserSnapshotElement[];
    /** Only where `elements` is: what the budget cut, so a read of a tab says so the way a
     * snapshot of it does. */
    elementsOmitted?: number;
    framesOmitted?: number;
    text?: string;
    waited?: string;
    /** Only for a screenshot: the workspace path the picture was written to. */
    path?: string;
  }> {
    const targetId =
      'tabId' in action && action.tabId ? action.tabId : tabIdFor(session, session.page);
    if (targetId) {
      if (
        resolveTab(session, 'tabId' in action ? action.tabId : undefined).url() === 'about:blank' &&
        action.type === 'navigate'
      )
        this.#tabLifecycle(session).adopt(
          targetId,
          session.caller ?? { owner: 'agent', taskId: null }
        );
      this.#tabLifecycle(session).touch(targetId, session.caller?.owner ?? 'agent', this.#now());
    }
    const page = resolveTab(session, 'tabId' in action ? action.tabId : undefined);
    let acted = page;
    switch (action.type) {
      case 'navigate': {
        const response = await page.goto(action.url, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000
        });
        await this.#assertNavigationClean(session, page, response);
        break;
      }
      case 'click':
        await (await resolveBrowserTarget(page, action.selector)).click({ timeout: 20_000 });
        break;
      case 'double_click':
        await (await resolveBrowserTarget(page, action.selector)).dblclick({ timeout: 20_000 });
        break;
      case 'hover':
        await (await resolveBrowserTarget(page, action.selector)).hover({ timeout: 20_000 });
        break;
      case 'click_at':
        await page.mouse.click(action.x, action.y);
        break;
      case 'type': {
        const target = await resolveBrowserTarget(page, action.selector);
        const descriptor = await target.evaluate(
          (element) => ({
            tag: element.tagName.toLowerCase(),
            role: (element.getAttribute('role') ?? '').toLowerCase(),
            ariaAutocomplete: element.getAttribute('aria-autocomplete') ?? '',
            hasList: element.hasAttribute('list'),
            contentEditable: (element as HTMLElement).isContentEditable
          }),
          undefined,
          { timeout: 20_000 }
        );
        // fill() throws on a <select>; the option text or value is what the agent means.
        if (descriptor.tag === 'select') {
          await target.selectOption(action.text, { timeout: 20_000 });
          break;
        }
        const strategy = action.mode === 'auto' ? typeStrategy(descriptor) : action.mode;
        if (strategy === 'fill') {
          await target.fill(action.text, { timeout: 20_000 });
          break;
        }
        // Clear first: pressSequentially appends, and a typeahead that already holds a stale
        // value matches nothing once the new text is concatenated onto it.
        await target.fill('', { timeout: 20_000 }).catch(() => undefined);
        await target.pressSequentially(action.text, { delay: 30, timeout: 60_000 });
        break;
      }
      case 'wait_for': {
        const waited = await this.#waitFor(page, action);
        return {
          url: page.url(),
          title: await page.title().catch(() => ''),
          tabId: tabIdFor(session, page),
          waited
        };
      }
      case 'select_option':
        await (
          await resolveBrowserTarget(page, action.selector)
        ).selectOption(action.values, {
          timeout: 20_000
        });
        break;
      case 'upload': {
        // Every path goes through the file API's own boundary check, so an upload can only
        // ever attach a file the user could already read through the file browser - and what the
        // browser is handed is a runner-owned copy, because the browser opens the name it was
        // given when the form is submitted rather than now.
        const files = await Promise.all(
          action.paths.map((requested) =>
            stageUserFileForUpload(root, requested, this.options.maxFileBytes)
          )
        );
        const target = await resolveBrowserTarget(page, action.selector);
        const isFileInput = await target
          .evaluate(
            (element) => element instanceof HTMLInputElement && element.type === 'file',
            undefined,
            { timeout: 20_000 }
          )
          .catch(() => false);
        if (isFileInput) {
          await target.setInputFiles(files, { timeout: 20_000 });
          break;
        }
        // Most sites hide the real input behind a styled button or drop zone, and the chooser
        // that button opens is then the only way in.
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 20_000 }),
          target.click({ timeout: 20_000 })
        ]);
        await chooser.setFiles(files);
        break;
      }
      case 'text_input':
        await page.keyboard.insertText(action.text);
        break;
      case 'press':
        await page.keyboard.press(action.key);
        break;
      case 'scroll': {
        // A wheel event lands under the pointer, which starts at the top-left corner, so the
        // pointer is parked over the requested container — or the middle of the page — first.
        if (action.selector)
          await (await resolveBrowserTarget(page, action.selector)).hover({ timeout: 20_000 });
        else {
          const viewport = page.viewportSize();
          await page.mouse.move(
            (viewport?.width ?? BROWSER_VIEWPORT.width) / 2,
            (viewport?.height ?? BROWSER_VIEWPORT.height) / 2
          );
        }
        await page.mouse.wheel(action.deltaX, action.deltaY);
        break;
      }
      case 'new_tab': {
        if (session.caller?.owner === 'agent') {
          await this.#sweepTabs(session, true);
          if (
            this.#tabStates(session).filter((tab) => tab.owner === 'agent').length >=
            AGENT_TAB_LIMIT
          )
            throw new Error(
              'All temporary browser tabs are protected. Close an unneeded tab before opening another.'
            );
        }
        session.creatingTab = session.caller ?? { owner: 'agent', taskId: null };
        let next: Page;
        try {
          next = await session.context.newPage();
        } finally {
          delete session.creatingTab;
        }
        acted = next;
        // A background tab is how the posting stays open while the form is filled in another,
        // so `activate: false` genuinely leaves the driven tab where it was.
        if (action.activate) {
          session.page = next;
          await this.#retargetStream(session).catch(() => undefined);
        }
        if (action.url) {
          const response = await next.goto(action.url, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000
          });
          await this.#assertNavigationClean(session, next, response);
        }
        break;
      }
      case 'select_tab': {
        const selected = resolveTab(session, action.tabId);
        session.page = selected;
        acted = selected;
        await selected.bringToFront();
        await this.#retargetStream(session);
        break;
      }
      case 'inspect_tab': {
        // Reads a tab without making it active, so the agent can check a background page
        // without stealing focus from the one a human may be watching.
        const inspected = resolveTab(session, action.tabId);
        this.#assertReadablePage(inspected, session.control.holder === 'agent' ? 'agent' : 'user');
        const scan = await this.#scanPage(inspected);
        return {
          url: inspected.url(),
          title: await inspected.title().catch(() => ''),
          tabId: action.tabId,
          elements: scan.elements,
          elementsOmitted: scan.elementsOmitted,
          framesOmitted: scan.framesOmitted,
          text: (
            await inspected
              .locator('body')
              .innerText({ timeout: 5_000 })
              .catch(() => '')
          ).slice(0, BROWSER_SNAPSHOT_TEXT_LIMIT)
        };
      }
      case 'screenshot': {
        // The picture the agent can keep, held to what a printed page is held to: the path goes
        // through the file API's own boundary before anything is captured, and the bytes are
        // written through it afterwards rather than a name being handed to the browser to open on
        // its own, which would resolve it a second time after the check.
        this.#assertReadablePage(page, session.control.holder === 'agent' ? 'agent' : 'user');
        const relativePath = assertUserDataPath(root, action.path);
        const image = await captureScreenshot(page, 'png');
        await writeWorkspaceFile(root, relativePath, image, this.options.maxFileBytes);
        return {
          url: page.url(),
          title: await page.title().catch(() => ''),
          tabId: tabIdFor(session, page),
          path: relativePath
        };
      }
      case 'close_tab': {
        const closing = resolveTab(session, action.tabId);
        const open = [...session.tabs.values()].filter((page) => !page.isClosed());
        if (open.length === 1) throw new Error('The final browser tab cannot be closed');
        const wasActive = closing === session.page;
        await closing.close();
        if (wasActive) {
          const remaining = [...session.tabs.values()].find((page) => !page.isClosed());
          if (remaining) {
            session.page = remaining;
            await remaining.bringToFront();
          }
        }
        await this.#retargetStream(session);
        // The closed page cannot describe itself, so the result describes where control landed.
        acted = session.page;
        break;
      }
      case 'dialog': {
        const dialog = session.pendingDialog;
        if (!dialog) throw new Error('No page dialog is waiting for a response');
        delete session.pendingDialog;
        const dialogPage = typeof dialog.page === 'function' ? dialog.page() : session.page;
        const dialogTab = dialogPage ? tabIdFor(session, dialogPage) : null;
        if (dialogTab) session.tabLifecycle?.dialog(dialogTab, false);
        // Published before the answer is delivered: the page resumes the moment it is, and a
        // banner left standing over a running page is the same lie in the other direction.
        this.#notifyStreamState(session);
        if (action.response === 'accept') await dialog.accept(action.promptText);
        else await dialog.dismiss();
        break;
      }
      case 'back': {
        const response = await page.goBack({ waitUntil: 'domcontentloaded' });
        await this.#assertNavigationClean(session, page, response);
        break;
      }
      case 'reload': {
        const response = await page.reload({ waitUntil: 'domcontentloaded' });
        await this.#assertNavigationClean(session, page, response);
        break;
      }
    }
    return {
      url: acted.url(),
      title: await acted.title().catch(() => ''),
      tabId: tabIdFor(session, acted)
    };
  }

  /**
   * Condition-based waiting. A fixed sleep is either a flake or dead time, and without any wait
   * at all a snapshot taken straight after `navigate` on a single-page application returns the
   * empty shell — which is what the agent then tries to fill in.
   *
   * A selector, some text, or a URL fragment names the condition and resolves the instant it
   * holds; that is the form to reach for. With none of them this waits on the page as a whole,
   * which is a weaker thing and says so in what it returns.
   */
  async #waitFor(
    page: Page,
    action: Extract<BrowserPrimitiveAction, { type: 'wait_for' }>
  ): Promise<string> {
    const timeout = action.timeoutMs;
    if (action.selector) {
      await (
        await resolveBrowserTarget(
          page,
          action.selector,
          action.state === 'detached' || action.state === 'hidden'
        )
      ).waitFor({
        state: action.state,
        timeout
      });
      return `${action.selector} is ${action.state}`;
    }
    if (action.text) {
      await page.getByText(action.text).first().waitFor({ state: 'visible', timeout });
      return `text “${action.text}” is visible`;
    }
    if (action.urlIncludes) {
      const fragment = action.urlIncludes;
      await page.waitForURL((url) => url.href.includes(fragment), { timeout });
      return `url contains “${fragment}”`;
    }
    /*
     * No selector, no text and no URL fragment: the page itself is what is being waited on.
     *
     * This was `waitForLoadState('networkidle')`, which `docs/design/browser-automation.md` bans
     * by name at :336 and :560 - it is deprecated, and on a page holding a websocket or a long
     * poll the network never goes quiet, so it burned its whole timeout and then threw. Measured
     * on such a page: 15,000 ms and an exception, where a `wait_for` naming the selector resolved
     * in 72 ms. Inside a `batch` that exception took every remaining step with it, so one wait
     * cost the rest of a form fill as well as the fifteen seconds.
     *
     * `timeout` is the caller's own ceiling, so the load wait takes the smaller of it and the
     * protocol's 10,000 ms and the settle runs regardless.
     */
    const loaded = await settlePage(page, Math.min(timeout, PAGE_LOAD_WAIT_MS));
    return loaded
      ? 'page finished loading and settled'
      : 'page had not finished loading, and settled anyway - wait on a selector or on text to wait for something in particular';
  }

  /**
   * Where the browser actually ended up, and whether there is a challenge on it. Checking the
   * landed address rather than only the requested one is what closes the two ways a public URL
   * reaches a private host anyway: a redirect chain, and a name that resolves to something else on
   * the second lookup - the browser's - than it did on the first.
   *
   * Only while the agent is driving. The owner reaching their own router or a service on this box
   * from their own takeover session is not the threat this exists for, and refusing it would make
   * the browser useless for the one person entitled to use it that way.
   */
  async #assertNavigationClean(
    session: Session,
    page: Page,
    response: PageResponse | null
  ): Promise<void> {
    if (session.control.holder === 'agent') {
      if (!agentReachablePage(page.url())) throw agentDestinationRefused(page.url());
      // Absent for a page answered from the browser's own cache, where nothing left the machine.
      const server = response ? await response.serverAddr().catch(() => null) : null;
      if (server && !isPublicInternetAddress(server.ipAddress))
        throw new Error(
          `The browser connected to ${server.ipAddress}, which is not an address on the public internet`
        );
    }
    const wall = detectBotWall({
      url: page.url(),
      title: await page.title().catch(() => ''),
      frameUrls: await this.#unacknowledgedFrames(page),
      status: response?.status() ?? null,
      headers: response?.headers() ?? {}
    });
    if (!wall) return;
    throw new BotWallError(this.#raiseWall(session, page, wall));
  }

  /**
   * Prints the page the agent is looking at, once it has loaded and settled, which is the only
   * route from an authored HTML document to a PDF with real page breaks, headers and margins.
   */
  async printPdf(
    workspaceId: string,
    root: string,
    input: {
      path: string;
      format: string;
      landscape: boolean;
      printBackground: boolean;
      tabId?: string | undefined;
    },
    actor: 'agent' | 'user'
  ) {
    const session = await this.ensure(workspaceId, root);
    // Deliberately stricter than `authorize`: printing is a copy of the page onto disk, where the
    // agent can read it, so it stays refused during secure input even for the owner - who is at
    // that moment typing the one thing on the page that must not be written down.
    if (session.control.holder !== actor)
      throw new Error(`Browser control is held by ${session.control.holder}`);
    const page = resolveTab(session, input.tabId);
    if (actor === 'agent') await this.#assertNoWall(session, page);
    this.#assertReadablePage(page, actor);
    const relativePath = assertUserDataPath(root, input.path);
    // Judged on its own and changed for the same reason as the wait above, not for consistency
    // with it: this one could not throw, but on a page holding a long poll it spent its whole
    // 15,000 ms every time and then printed exactly what `load` had already guaranteed - the
    // document and its images, stylesheets and fonts. What it bought over `load` was content a
    // script fetched afterwards, and `networkidle` never fires on the pages where that is true.
    await settlePage(page, PAGE_LOAD_WAIT_MS);
    // The bytes come back here and are written through the file API rather than by handing the
    // browser a path to open on its own. The browser would resolve that name a second time, after
    // these checks, which is a window the agent's account can put a symbolic link into.
    const pdf = await page.pdf({
      format: input.format,
      landscape: input.landscape,
      printBackground: input.printBackground
    });
    await writeWorkspaceFile(root, relativePath, pdf, this.options.maxFileBytes);
    return { path: relativePath, url: page.url(), title: await page.title().catch(() => '') };
  }

  /**
   * Hands the browser over, through the same transfer the Computer pane's Take over button uses.
   *
   * It used to be an assignment to a field, which is every ordering defect a takeover can have at
   * once: work already in flight kept running against the page, work already queued ran after the
   * handover, and nothing lifted the modifiers the outgoing side was holding. `transfer` discards
   * the queue, aborts the over-running action, releases every surface and only then admits the new
   * holder - and when this browser is drawn on the workspace's desktop it is the *same* transfer
   * the Computer pane performs, so the two surfaces cannot disagree about who is driving.
   */
  async setHolder(workspaceId: string, root: string, holder: 'agent' | 'user' | 'secure_input') {
    const session = await this.ensure(workspaceId, root);
    const shared = await this.#sharedControl(workspaceId, root);
    const state = await this.#adopt(session, shared).transfer(holder);
    // Handing the browser back is the owner saying the challenge is dealt with, and they are the
    // only one who can say it: nothing the model does clears a wall that has not passed by itself.
    if (holder === 'agent') session.walls.clearAll();
    this.#notifyStreamState(session);
    return { holder: state.holder };
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [
        ...new Set([
          ...this.#sessions.keys(),
          ...this.#starting.keys(),
          ...this.#failedStarts.keys()
        ])
      ].map((id) => this.close(id))
    );
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
    // The search backoff belongs to the workspace rather than to the session, so closing the
    // browser is the one moment it is unambiguously stale: whatever the engine decided, it decided
    // it about work that is now over.
    this.#searchWalls.delete(workspaceId);
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    // Off the control first: a shared control outlives this browser, and releasing a page that has
    // gone on every later desktop handover is a failure raised at the owner taking their own
    // machine back.
    session.detachControl?.();
    delete session.detachControl;
    this.#attached.delete(session);
    await this.#rememberTabs(session);
    session.ending = true;
    if (session.recoveryTimer) clearTimeout(session.recoveryTimer);
    await session.context.close();
    await session.gui?.release();
    await clearStagedUploads(session.root);
  }
}
