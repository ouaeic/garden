import {
  DEFAULT_SPEND_WARN_PERCENT,
  type SpendDecision,
  type SpendWindow,
  type SpendWindowName,
  type SpendWindowState
} from '@garden/contracts';
import { GardenError } from './errors.js';

/**
 * Provider invoices carry seven significant decimals at most, and float addition over a few
 * thousand entries drifts well below that. Rounding at the boundary keeps a total that is exactly
 * 0.30 from being reported as 0.30000000000000004 without ever changing a comparison.
 */
const USD_PRECISION = 1e-6;
export const roundUsd = (value: number): number =>
  Math.round(value / USD_PRECISION) * USD_PRECISION;

/**
 * Spending exactly the cap is allowed; spending a rounding error past it is not a real overrun.
 * A tenth of a millionth of a dollar is far below anything a provider can bill.
 */
const CAP_TOLERANCE_USD = 1e-7;

const CANONICAL_ORDER: readonly SpendWindowName[] = ['task', 'daily', 'monthly'];

const WINDOW_LABEL: Record<SpendWindowName, string> = {
  task: 'this task',
  daily: 'today',
  monthly: 'this month'
};

export interface SpendWindowInput {
  name: SpendWindowName;
  spentUsd: number;
  /**
   * Headroom already promised to work that is open but has not billed yet. Kept apart from
   * spentUsd so a report of "spent today" stays a report of money that actually changed hands,
   * while the decision still refuses to promise the same dollar twice.
   */
  pendingUsd?: number;
  /** Null means the owner set no ceiling of this kind, so the window reports and never blocks. */
  capUsd: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export interface SpendCapInput {
  windows: readonly SpendWindowInput[];
  /** What the caller is about to commit to. Zero asks "where do I stand right now?". */
  estimateUsd: number;
  warnAtPercent?: number;
}

export const money = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const isMoney = (value: number): boolean => Number.isFinite(value) && value >= 0;

const rank = (name: SpendWindowName): number => {
  const index = CANONICAL_ORDER.indexOf(name);
  return index < 0 ? CANONICAL_ORDER.length : index;
};

/**
 * The single place that turns "what has been spent" plus "what the owner allowed" into start/warn/
 * stop. Every caller - task creation, a scheduled run, a step inside the agent loop - asks the same
 * question with a different estimate, so the arithmetic and the wording live here rather than in
 * each of them.
 */
export const evaluateSpendCaps = (input: SpendCapInput): SpendDecision => {
  const requestedWarnAt = input.warnAtPercent;
  const warnAtPercent =
    typeof requestedWarnAt === 'number' &&
    Number.isFinite(requestedWarnAt) &&
    requestedWarnAt >= 1 &&
    requestedWarnAt <= 99
      ? Math.trunc(requestedWarnAt)
      : DEFAULT_SPEND_WARN_PERCENT;
  // A caller that cannot say what it is about to spend gets stopped rather than waved through: an
  // unusable estimate is the one case where guessing costs real money.
  const estimateUsable = isMoney(input.estimateUsd);
  const estimateUsd = estimateUsable ? roundUsd(input.estimateUsd) : 0;

  const ordered = [...input.windows].sort((left, right) => rank(left.name) - rank(right.name));
  let blockedBy: SpendWindowName | null = null;
  let blockedReason: string | null = null;
  let warnedReason: string | null = null;
  const warnedBy: SpendWindowName[] = [];

  const windows: SpendWindow[] = ordered.map((window) => {
    const spentUsd = roundUsd(isMoney(window.spentUsd) ? window.spentUsd : 0);
    const pendingUsd = roundUsd(isMoney(window.pendingUsd ?? 0) ? (window.pendingUsd ?? 0) : 0);
    const capUsd =
      window.capUsd === null || !isMoney(window.capUsd) ? null : roundUsd(window.capUsd);
    const projectedUsd = roundUsd(spentUsd + pendingUsd + estimateUsd);
    const warnAtUsd = capUsd === null ? null : roundUsd((capUsd * warnAtPercent) / 100);
    let state: SpendWindowState = 'ok';
    if (capUsd !== null) {
      if (projectedUsd > capUsd + CAP_TOLERANCE_USD) state = 'exceeded';
      else if (warnAtUsd !== null && projectedUsd >= warnAtUsd - CAP_TOLERANCE_USD)
        state = 'warning';
      if (state === 'exceeded' && blockedBy === null) {
        blockedBy = window.name;
        blockedReason =
          projectedUsd > spentUsd
            ? `Spending on ${WINDOW_LABEL[window.name]} would reach ${money(projectedUsd)}, past the ${money(capUsd)} cap.`
            : `Spending on ${WINDOW_LABEL[window.name]} has reached ${money(spentUsd)}, past the ${money(capUsd)} cap.`;
      }
      if (state === 'warning') {
        warnedBy.push(window.name);
        if (warnedReason === null)
          warnedReason = `Spending on ${WINDOW_LABEL[window.name]} is at ${money(projectedUsd)} of the ${money(capUsd)} cap.`;
      }
    }
    return {
      name: window.name,
      spentUsd,
      pendingUsd,
      capUsd,
      warnAtUsd,
      projectedUsd,
      state,
      startsAt: window.startsAt ? window.startsAt.toISOString() : null,
      endsAt: window.endsAt ? window.endsAt.toISOString() : null
    };
  });

  if (!estimateUsable)
    return {
      outcome: 'deny',
      estimateUsd: 0,
      blockedBy: null,
      warnedBy,
      reason: 'The cost of this work could not be estimated, so it was not started.',
      windows
    };

  if (blockedBy !== null)
    return { outcome: 'deny', estimateUsd, blockedBy, warnedBy, reason: blockedReason, windows };

  if (warnedBy.length)
    return {
      outcome: 'warn',
      estimateUsd,
      blockedBy: null,
      warnedBy,
      reason: warnedReason,
      windows
    };

  return { outcome: 'allow', estimateUsd, blockedBy: null, warnedBy: [], reason: null, windows };
};

/** Turns a denial into the error the API and the worker both surface. */
export const assertSpendAllowed = (decision: SpendDecision): SpendDecision => {
  if (decision.outcome !== 'deny') return decision;
  throw new GardenError(
    'spend_cap_reached',
    decision.reason ?? 'This work would exceed the spending cap.',
    402,
    {
      blockedBy: decision.blockedBy,
      estimateUsd: decision.estimateUsd,
      windows: decision.windows
    }
  );
};

export interface SpendPeriod {
  start: Date;
  end: Date;
}

export interface SpendPeriods {
  daily: SpendPeriod;
  /**
   * Monday to Monday. No cap is settable against it - the ceilings are a day and a month - but the
   * usage pane reports it, and it has to roll over on the owner's own Monday rather than on UTC's.
   */
  weekly: SpendPeriod;
  monthly: SpendPeriod;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const zoneFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

/** Offset of `timeZone` from UTC at `instant`, in milliseconds, east of Greenwich positive. */
const zoneOffsetMs = (formatter: Intl.DateTimeFormat, instant: Date): number => {
  const parts = formatter.formatToParts(instant);
  const value = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value);
  const asIfUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second')
  );
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
};

const localDate = (formatter: Intl.DateTimeFormat, instant: Date): CalendarDate => {
  const parts = formatter.formatToParts(instant);
  const value = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
};

/**
 * The instant at which a local calendar day begins. Solved twice because the offset that applies
 * at the answer is not always the offset that applies at the first guess - that is exactly what a
 * daylight-saving boundary is. In the rare zone whose clocks jump at midnight the local midnight
 * does not exist at all, and this lands on the first instant that does, which is what an owner
 * watching a daily cap would call the start of their day anyway.
 */
const startOfLocalDay = (formatter: Intl.DateTimeFormat, date: CalendarDate): Date => {
  const naive = Date.UTC(date.year, date.month - 1, date.day);
  const first = naive - zoneOffsetMs(formatter, new Date(naive));
  return new Date(naive - zoneOffsetMs(formatter, new Date(first)));
};

const shiftDays = (date: CalendarDate, days: number): CalendarDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate()
  };
};

const shiftMonths = (date: CalendarDate, months: number): CalendarDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: 1 };
};

/**
 * "Today" and "this month" have to mean the owner's day and month, or a cap set to cover an evening
 * of work resets in the middle of it. An unknown zone falls back to UTC rather than throwing: a
 * bad string in one settings row must not be able to stop every task on the machine from starting.
 */
export const spendWindowBounds = (timeZone: string, now = new Date()): SpendPeriods => {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = zoneFormatter(timeZone);
  } catch {
    formatter = zoneFormatter('UTC');
  }
  const today = localDate(formatter, now);
  const monthStart: CalendarDate = { year: today.year, month: today.month, day: 1 };
  // Weekday of the local calendar date, not of the instant: the two disagree either side of
  // midnight in every zone that is not UTC. Monday is 0, which is where the week starts.
  const sinceMonday =
    (new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() + 6) % 7;
  const weekStart = shiftDays(today, -sinceMonday);
  return {
    daily: {
      start: startOfLocalDay(formatter, today),
      end: startOfLocalDay(formatter, shiftDays(today, 1))
    },
    weekly: {
      start: startOfLocalDay(formatter, weekStart),
      end: startOfLocalDay(formatter, shiftDays(weekStart, 7))
    },
    monthly: {
      start: startOfLocalDay(formatter, monthStart),
      end: startOfLocalDay(formatter, shiftMonths(monthStart, 1))
    }
  };
};

/** The local calendar day an instant falls in, as `YYYY-MM-DD`, for grouping a spend history. */
export const localDayKey = (timeZone: string, instant: Date): string => {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = zoneFormatter(timeZone);
  } catch {
    formatter = zoneFormatter('UTC');
  }
  const date = localDate(formatter, instant);
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
};

/*
 * The sentences an owner reads when a ceiling stops or nearly stops a run.
 *
 * These lived in the worker, beside the brake that pauses the task, which was the only reader while
 * the only account of a money stop was a line in the task's log. It is not the only reader any more:
 * the API answers "why is this stopped, and would it still be stopped now" for the card the owner
 * acts on, and a card that recomputed the wording would be free to quote a different number from
 * the one the run recorded. One function, both readers.
 */
/*
 * Not the `money` above: a halt can fire on a figure below a cent, and the general formatter rounds
 * those to "$0.00" - a sentence saying a run stopped at $0.00 of a $0.00 limit explains nothing.
 * The two are kept apart rather than reconciled because the other reader of `money` is a summary
 * pane where four decimals are noise.
 */
const haltMoney = (value: number): string =>
  value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;

const windowLabel = (name: string): string =>
  ({ task: 'this task', daily: 'today', monthly: 'this month' })[name] ?? name;

/**
 * What money is committed but not yet billed, said only when there is some.
 *
 * `spentUsd` is money that changed hands and the contract insists it stay that way, so the figure
 * that actually crossed the line - `projectedUsd`, which is spent plus pending plus the estimate -
 * cannot simply replace it. But quoting the spent figure alone against the cap produced a sentence
 * whose own arithmetic said the run should not have stopped: an open scheduled task holds its whole
 * ceiling as `pendingUsd` from the moment it is queued, so a month with $40 spent and $65 promised
 * blocks against a $100 cap and told its owner "Paused at $40.00 of the $100.00 limit". Naming the
 * held part is what closes the gap between the number and the stop.
 */
const heldAside = (pendingUsd: number): string =>
  pendingUsd > 0 ? `, with ${haltMoney(pendingUsd)} more promised to work already open` : '';

/**
 * Says what was spent, against what, and in which window. A ceiling the owner cannot see themselves
 * approaching reads as a random interruption, so the number and the limit both belong in the line
 * the interface shows.
 *
 * `capUsd == null` rather than `!capUsd`, twice below, for the reason the caps route states in as
 * many words: for a ceiling, zero is a real setting and only `null` is the absence of one. A box
 * whose owner had capped a window at zero fell through to the sentence with no numbers in it - the
 * one case where the number is the entire explanation.
 *
 * Where to change it is deliberately not in the sentence. The card that renders this already draws
 * a "Spending caps" button beside it, and a line of prose repeating a control the reader can see is
 * narration.
 */
export const spendHalt = (decision: SpendDecision): string => {
  const blocked = decision.windows.find((window) => window.name === decision.blockedBy);
  if (blocked?.capUsd == null)
    return `Paused: this task would go over its spending limit. ${decision.reason ?? ''}`.trim();
  return `Paused at ${haltMoney(blocked.spentUsd)} of the ${haltMoney(blocked.capUsd)} limit for ${windowLabel(blocked.name)}${heldAside(blocked.pendingUsd)}. Raise the limit to carry on, or leave it here.`;
};

export const spendWarning = (decision: SpendDecision): string => {
  const near = decision.windows.find((window) => decision.warnedBy.includes(window.name));
  if (near?.capUsd == null) return 'Approaching a spending limit.';
  return `${haltMoney(near.spentUsd)} of the ${haltMoney(near.capUsd)} limit for ${windowLabel(near.name)} has been spent${heldAside(near.pendingUsd)}.`;
};
