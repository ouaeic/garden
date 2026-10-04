/**
 * What has been spent, and the ceilings the owner has set on spending it.
 *
 * Reading is `usage:read`; raising a ceiling is not something an automation token gets to do at
 * all - that is the owner deciding how much of their own money the agent may spend.
 */

import { UpdateSpendLimitsRequest } from '@garden/contracts';
import { GardenError, decryptJson, storageThreshold, unwrapDataKey } from '@garden/core';
import { ownerPriceCeiling, revealedTaskEvent } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { currentPeriod, serverLimits } from '../plans.js';

/**
 * The smallest number of turns this instrument will divide by, and the arithmetic that chose it.
 *
 * The decision this measurement exists to settle is `docs/design/organs/PREAMBLE.md` §10.5: a tool
 * may be moved out of the resident catalogue and behind an on-demand open only if production
 * touches it in fewer than 9.2% of turns (the serial scheme; 59.8% if the open tool returns several
 * schemas at once, which §10 says it should). So the question every row here is asked is whether a
 * tool's rate is credibly BELOW 9.2%, and the answer is an upper bound rather than a point.
 *
 * A tool that was never called once in `n` turns has a 95% one-sided upper bound of about `3/n` -
 * the rule of three, which is what §3.2 used on its 83 hand-written turns. For that bound to sit
 * under 9.2% needs `3/n < 0.092`, that is `n >= 33`, and below it the best evidence this can hold -
 * a tool nobody touched even once - does not clear the threshold by that arithmetic, so every share
 * printed there would be decoration.
 *
 * THIS IS THE SHORTHAND'S FLOOR AND NOT THE ONE `upperBound95` REPORTS, and the difference is one
 * turn. The bound actually carried for a zero count below is the exact binomial `1 - 0.05^(1/n)`,
 * which is tighter than `3/n`: 8.94% at 32 turns and 9.21% at 31, so by the number this instrument
 * prints, 32 turns already clears 9.2% and 31 does not. The floor is kept at 33 anyway, so that it
 * is the same arithmetic PREAMBLE §3.2 quotes and the two documents can be read against each other.
 * The cost of that choice is refusing one turn longer than the printed bound needs; the gain is
 * that there is one floor rather than two. Anyone lowering it to 32 is choosing the exact bound
 * over the shorthand and should move `docs/design/organs/PREAMBLE.md` with it.
 *
 * What would change it: the threshold. Against the batched scheme's 59.8% the same rule gives
 * `n >= 6`, so this floor is the conservative of the two and is the one the serial scheme needs. A
 * different deferral set would move 9.2% and move this with it.
 *
 * Every figure in the two paragraphs above is asserted, not asserted-about: `3/32 > 9.2% > 3/33`,
 * the 9.21% and 8.94% exact bounds at 31 and 32, and `n >= 6` at 59.8% are all pinned by `is the
 * smallest sample at which a never-called tool can clear the deferral threshold` in
 * `usage-tool-opens.test.ts`. They are pinned because the block this replaced claimed 33 was the
 * smallest sample at which the answer could differ, which is true of the shorthand and false of
 * the bound printed here, and a derivation nothing checks is how that survived being written.
 *
 * THE DOCUMENT CITED ABOVE IS NOT IN THE REPOSITORY. `.gitignore` excludes `docs/design/`, so
 * `git ls-files docs/design/` returns nothing and a clone has no §3.2, §10.5 or §4.1 to check any
 * of this against - while this file, `usage-tool-opens.test.ts`, `store.test.ts`,
 * `store/sql/tasks.ts`, `apps/worker/src/tool-catalogue.test.ts`, `scripts/garden` and
 * `docs/HEADLESS.md` all cite it by path. That is why 9.2%, 59.8% and the shorthand are restated
 * here in full rather than referred to: the restatement is the only copy a reader of the shipped
 * tree gets, and the assertions named above are the only thing that keeps it true.
 *
 * It is a floor on the DENOMINATOR and not a claim that 33 turns is a good sample. Thirty-three
 * turns clears a never-called tool and nothing else; a tool called twice needs far more before its
 * bound comes down. The report says what it is standing on so the reader can judge that themselves.
 */
export const MIN_TURNS_TO_ANSWER = 33;

/**
 * How many rows of one conversation this will read before it stops and says it stopped.
 *
 * `MAX_TASK_EVENT_PAGE` (500) times forty pages. At the 6.30 calls per turn measured in PREAMBLE
 * §6.1 that is around 3,000 turns in a SINGLE conversation, which is more than any one conversation
 * on this box has had. The bound exists so that one pathological trajectory cannot make an owner's
 * weekly read run for ever, not because it is expected to fire; when it does fire the response says
 * so per conversation rather than quietly reporting a short answer.
 */
const MAX_ROWS_PER_TASK = 20_000;

/** Read a page at a time so no more than this much of one trajectory is decrypted at once. */
const TOOL_START_PAGE = 500;

/** The longest window that may be asked for in one request, and the default a week of use wants. */
const MAX_WINDOW_DAYS = 92;
const DEFAULT_WINDOW_DAYS = 7;

/**
 * The 95% one-sided upper bound on a share of `hits` out of `turns`.
 *
 * Two bounds, because the two cases are not equally well served by one formula and the decision
 * turns on the first of them:
 *
 *   - Nothing seen. `1 - 0.05^(1/n)`, the exact binomial answer, which is the rule of three to
 *     three figures. This is the case the deferral set is made of - a tool nobody called - so it
 *     gets the exact bound rather than a normal approximation, and it is the same bound PREAMBLE
 *     §3.2 quotes for its own zero counts, so the two documents can be read against each other.
 *   - Something seen. The Wilson score upper bound at z = 1.645. Wilson rather than Wald because
 *     Wald is badly wrong for small shares and every share here is small; it is the standard
 *     interval for exactly this shape and is within a fraction of a point of exact at any n this
 *     will answer at.
 *
 * Both choices are conservative at the point the decision is made: Wilson's known weakness is that
 * it is optimistic at zero (2.706/n against the exact 2.996/n), which is why zero does not use it.
 */
export const upperBound95 = (hits: number, turns: number): number => {
  if (turns <= 0) return 1;
  if (hits <= 0) return 1 - Math.pow(0.05, 1 / turns);
  const z = 1.645;
  const share = hits / turns;
  const denominator = 1 + (z * z) / turns;
  const centre = share + (z * z) / (2 * turns);
  const spread = z * Math.sqrt((share * (1 - share)) / turns + (z * z) / (4 * turns * turns));
  return Math.min(1, (centre + spread) / denominator);
};

export interface ToolOpenRate {
  tool: string;
  /** Turns in which this tool was dispatched at least once. Never a count of calls. */
  turns: number;
  shareOfTurns: number;
  upper95: number;
}

export interface ToolOpenReport {
  turns: number;
  minimumTurns: number;
  /** False when the window holds too few turns for any rate in it to settle anything. */
  decidable: boolean;
  /**
   * The 95% upper bound carried by a tool that appears nowhere below. Every tool in the catalogue
   * that is absent from `tools` was touched in zero turns of this window, and this is the strongest
   * statement that can be made about it - which is the number the deferral set is decided on.
   */
  unseenToolUpper95: number;
  tools: ToolOpenRate[];
}

/**
 * Per-tool turn incidence over a corpus of turns, each given as the set of tools it touched.
 *
 * TURNS AND NOT CALLS, which is the whole point. `PREAMBLE.md` §6.2 prices an open per turn: a tool
 * called five times inside one turn is opened once and costs one round trip, so counting calls
 * would overstate the cost of deferring exactly the tools that get called in bursts - `file_read`
 * and `shell` above all - and would understate nothing.
 *
 * Pure, and separated from the reading for that reason: the arithmetic is what a wrong decision
 * would come from, and it can be driven here over corpora a database would take an afternoon to
 * build.
 */
export const summariseToolOpens = (turns: ReadonlyArray<ReadonlySet<string>>): ToolOpenReport => {
  const counts = new Map<string, number>();
  for (const tools of turns)
    for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  const decidable = turns.length >= MIN_TURNS_TO_ANSWER;
  return {
    turns: turns.length,
    minimumTurns: MIN_TURNS_TO_ANSWER,
    decidable,
    unseenToolUpper95: upperBound95(0, turns.length),
    // The refusal is the empty list and not a thrown error: "you have 12 turns and need 33" is a
    // useful answer to the owner's question, and a rate printed off twelve turns is not. An
    // aggregate that reports a share off nine turns is how a wrong decision gets made confidently.
    tools: decidable
      ? [...counts.entries()]
          .map(([tool, hits]) => ({
            tool,
            turns: hits,
            shareOfTurns: hits / turns.length,
            upper95: upperBound95(hits, turns.length)
          }))
          .sort((left, right) => right.turns - left.turns || left.tool.localeCompare(right.tool))
      : []
  };
};

export const registerUsageRoutes = (context: RouteContext): void => {
  const { app, store, masterKey, meterWorkspace, providerSpend, requireRecentStepUp, idempotent } =
    context;
  app.get('/v1/usage', async (request) => {
    const user = requireUser(request.user);
    const period = currentPeriod();
    const workspaces = await store.listWorkspaceMetadata(user.id);
    await Promise.all(workspaces.map(meterWorkspace));
    const totals = await store.usageTotals(user.id, period.start, period.end);
    // Re-read after metering: the records above were fetched before the walk, so summing them
    // reported the figure from the previous visit to this pane rather than the one just measured.
    const storageBytes = (await store.listWorkspaces(user.id)).reduce(
      (sum, item) => sum + item.storageBytes,
      0
    );
    return {
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      totals,
      providerSpend: await providerSpend(user.id),
      storageBytes,
      storageLimitBytes: serverLimits.storageBytes,
      storageThreshold: storageThreshold(storageBytes, serverLimits.storageBytes),
      history: await store.usageHistory(user.id)
    };
  });

  /**
   * How often each tool is actually reached, per turn, over a window of this box's own work.
   *
   * WHAT DECIDES ON THIS. `apps/worker/src/tool-catalogue.test.ts` holds the resident wire under a
   * ceiling, and the largest saving anyone has priced against it - moving the cold, fat two thirds
   * of the catalogue behind a resident index line and an on-demand open, 55,673 bytes down to
   * 20,505 - is not refused, it is gated. It is gated on this number and nothing else. The working
   * is `docs/design/organs/PREAMBLE.md`; its own §3.2 says the frequency half of it rests on 83
   * hand-written eval turns in which the model is a SCRIPT and the tool names are the fixture
   * author's, and §10.4 prices the fix at one aggregate over the `tool_started` events the loop
   * already emits. This is that aggregate. It adds no event, no write path and no column; it reads
   * rows the turn loop has always written.
   *
   * TURNS, NOT CALLS. The break-even is per open and a deferred tool is opened once per turn
   * however many times it is then called, so `shell` five times in one turn is one turn.
   *
   * A TURN BELONGS TO THE WINDOW ITS OWN FIRST EVENT FALLS IN - the conversation's creation for the
   * opening request, the `user_message` row for every follow-up - and its whole tool set is read
   * whether or not the rest of it lands inside. Cutting turns at the window edge instead would
   * count the same turn's tools in one window and its denominator in another, and both edges of
   * every window would tilt the same way.
   *
   * WHAT IT COSTS TO RUN. One statement per conversation touched in the window, and one AEAD open
   * per tool call in it. Nothing else is decrypted: `TURN_TOOL_STARTS_SQL` never carries an
   * `assistant_delta` frame or the words of a `user_message` out of the database. It is a read the
   * owner runs weekly, not something on the turn's path, and it bills no provider.
   *
   * WHAT IT DOES NOT DO. It does not say how many model calls a turn took, which is the other half
   * of §6.1's price model and lives in `readCacheUsage`'s fields rather than here. It does not know
   * the catalogue - the names it reports are the names the loop dispatched, so a tool that exists
   * and was never called appears nowhere, and `unseenToolUpper95` is what can be said about it. And
   * it counts a turn that is still running as a turn, with whatever it has dispatched so far.
   */
  app.get('/v1/usage/tool-opens', async (request) => {
    const user = requireUser(request.user);
    const asked = Number((request.query as { days?: unknown } | undefined)?.days ?? NaN);
    const days = Number.isFinite(asked)
      ? Math.max(1, Math.min(Math.trunc(asked), MAX_WINDOW_DAYS))
      : DEFAULT_WINDOW_DAYS;
    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000);
    // Unwrapped once per workspace rather than once per conversation: a box with three hundred
    // conversations in one workspace would otherwise unwrap the same key three hundred times.
    const keys = new Map<string, Uint8Array>();
    for (const workspace of await store.listWorkspaceMetadata(user.id))
      if (workspace.wrappedKey)
        keys.set(workspace.id, unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id));

    const scan = await store.listTasksWithTurnsInWindow(user.id, since, until);
    const turns: Array<Set<string>> = [];
    const truncatedTasks: string[] = [];
    let unreadableCalls = 0;
    for (const task of scan.tasks) {
      const key = keys.get(task.workspaceId);
      // A workspace whose key was never wrapped cannot be opened, so its calls are unreadable
      // rather than absent, and the turns still divide.
      /** Turn number to the moment it opened and the distinct tools it reached. */
      const buckets = new Map<number, { openedAt: number; tools: Set<string> }>();
      // Turn one opens with the conversation itself: `createTask` writes no `user_message` for the
      // opening request, because that text is the task's own prompt.
      buckets.set(1, { openedAt: Date.parse(task.createdAt), tools: new Set() });
      let cursor = 0;
      let read = 0;
      for (;;) {
        const page = await store.listTurnToolStarts(task.id, {
          after: cursor,
          limit: TOOL_START_PAGE
        });
        for (const row of page.rows) {
          const bucket = buckets.get(row.turn) ?? {
            openedAt: Date.parse(row.createdAt),
            tools: new Set<string>()
          };
          if (row.kind === 'user_message') bucket.openedAt = Date.parse(row.createdAt);
          else {
            /*
             * The name is in the ciphertext and nowhere else.
             *
             * `tool-recording.ts` writes `Encrypted tool started event` into the plaintext summary
             * column on purpose, so this is the only way to read it - and a row this key will not
             * open is counted and skipped rather than thrown, for the reason the export gives
             * beside its own try: one unreadable row must not take the whole answer with it, and an
             * aggregate that dies on a re-keyed conversation is one the owner never gets to read.
             */
            let named = false;
            try {
              const revealed = revealedTaskEvent(
                '',
                key && row.payloadCiphertext
                  ? decryptJson(row.payloadCiphertext, key, `task-event:${task.id}`)
                  : undefined
              );
              const tool = (revealed.payload as { tool?: unknown } | undefined)?.tool;
              if (typeof tool === 'string' && tool) {
                bucket.tools.add(tool);
                named = true;
              }
            } catch {
              named = false;
            }
            if (!named) unreadableCalls += 1;
          }
          buckets.set(row.turn, bucket);
        }
        read += page.rows.length;
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        if (read >= MAX_ROWS_PER_TASK) {
          truncatedTasks.push(task.id);
          break;
        }
      }
      for (const bucket of buckets.values())
        if (bucket.openedAt >= since.getTime() && bucket.openedAt < until.getTime())
          turns.push(bucket.tools);
    }
    return {
      window: { start: since.toISOString(), end: until.toISOString(), days },
      tasksScanned: scan.tasks.length,
      /** True when the window held more conversations than one read walks; the oldest were cut. */
      windowTruncated: scan.hasMore,
      // Named rather than counted: a conversation cut off part-way is a hole in the denominator,
      // and the owner can go and look at which one it was.
      truncatedTasks,
      /** Tool calls whose name could not be read. The turn still counts; its tool set is short. */
      unreadableCalls,
      ...summariseToolOpens(turns)
    };
  });

  /**
   * Compute credits are a scheduling unit whose dollar value moves with the model class, so they
   * can never answer "stop before this costs me more than X". These three routes are that answer:
   * what the caps are, what has been spent against them, and where it went.
   */
  app.get('/v1/spend-limits', async (request) =>
    store.effectiveSpendLimits(requireUser(request.user).id)
  );

  app.put('/v1/spend-limits', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateSpendLimitsRequest.parse(request.body);
      /*
       * A passkey to loosen the brake, nothing to tighten it.
       *
       * Adding a device needs a passkey and reading an export needs a passkey, so removing the one
       * control standing between the owner and an unbounded provider bill needs one too. Asking on
       * every edit would be friction on a routine adjustment, and the direction is what matters:
       * raising a ceiling or clearing it is the escalation, lowering one cannot hurt. A cap that
       * was null is already unlimited, so setting a number there is a tightening even though it
       * "changes" the value.
       *
       * And a ceiling nobody has chosen is not one the owner is loosening.
       *
       * `current` is `effectiveSpendLimits`, and the monthly cap has a default, so `was` on a fresh
       * box is this box's own guess rather than the owner's decision - and the first answer to
       * the ceiling question, which is a decline, is sent as explicit nulls. Without the exemption
       * below that answer is a clearing, and saying "no ceiling, thank you" on a box that has never
       * been asked anything else costs a biometric prompt. The epoch stamp is the test, and it is
       * the same one the question itself uses to decide it is still owed.
       *
       * The exemption cannot cost anything: a box that has never saved a limit has only the
       * default, which nobody chose, so waving the decline through leaves it no worse off than a
       * box with no default at all. One saved answer in either direction moves `updatedAt` off the
       * epoch, and from then on every loosening asks.
       */
      const stored = await store.effectiveSpendLimits(user.id);
      const current = { ...stored, ...ownerPriceCeiling(stored) };
      const everAnswered = Date.parse(stored.updatedAt) > 0;
      const loosens = (was: number | null, next: number | null | undefined): boolean =>
        next !== undefined && (next === null ? was !== null : was !== null && next > was);
      if (
        everAnswered &&
        (loosens(current.dailyCapUsd, input.dailyCapUsd) ||
          loosens(current.monthlyCapUsd, input.monthlyCapUsd) ||
          loosens(current.defaultTaskCapUsd, input.defaultTaskCapUsd) ||
          // The price ceiling is the same brake read the other way round, so it is the same test: a
          // ceiling that was null admits every route already, and raising one admits routes that were
          // refused a moment ago. Both are the escalation, and `loosens` computes exactly that
          // without a new predicate.
          loosens(current.maxInputUsdPerMillionTokens, input.maxInputUsdPerMillionTokens) ||
          loosens(current.maxOutputUsdPerMillionTokens, input.maxOutputUsdPerMillionTokens))
      )
        await requireRecentStepUp(request, user);
      try {
        // An omitted field is left alone and an explicit null clears that cap, so an absent key is
        // forwarded as an absent key rather than as undefined.
        await store.setSpendLimits({
          userId: user.id,
          ...(input.dailyCapUsd !== undefined ? { dailyCapUsd: input.dailyCapUsd } : {}),
          ...(input.monthlyCapUsd !== undefined ? { monthlyCapUsd: input.monthlyCapUsd } : {}),
          ...(input.defaultTaskCapUsd !== undefined
            ? { defaultTaskCapUsd: input.defaultTaskCapUsd }
            : {}),
          ...(input.warnAtPercent !== undefined ? { warnAtPercent: input.warnAtPercent } : {}),
          ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
          // Never `?? null`: for a ceiling, zero is a real setting - "only a route that publishes no
          // charge" - and an explicit null is the owner removing the ceiling. Collapsing the two
          // here is how a PUT stores a value and answers without it.
          ...(input.maxInputUsdPerMillionTokens !== undefined
            ? { maxInputUsdPerMillionTokens: input.maxInputUsdPerMillionTokens }
            : {}),
          ...(input.maxOutputUsdPerMillionTokens !== undefined
            ? { maxOutputUsdPerMillionTokens: input.maxOutputUsdPerMillionTokens }
            : {})
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unknown IANA time zone'))
          throw new GardenError('invalid_time_zone', 'Choose a valid IANA time zone');
        throw error;
      }
      return store.effectiveSpendLimits(user.id);
    });
  });

  app.get('/v1/spend', async (request) => store.spendSummary(requireUser(request.user).id));
};
