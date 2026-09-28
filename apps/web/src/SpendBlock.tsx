import { useEffect, useState } from 'react';
import { CircleDollarSign } from 'lucide-react';
import type { SpendWindow, Task, TaskSpendBlock } from '@garden/contracts';
import { get, post, put, ApiError } from './client';
import { stepUp } from './auth';
import { Button, ErrorNotice, Field, Spinner } from './ui';
import { money } from './model';
import { MAX_SPEND_CAP_USD, MAX_TASK_SPEND_USD } from './usage-model';

const WINDOW_LABEL: Record<string, string> = {
  task: 'this conversation',
  daily: 'today',
  monthly: 'this month'
};

/** A modest editable suggestion must cover the recorded request, including open commitments. */
export const suggestedCeiling = (window: SpendWindow): number => {
  const cap = window.capUsd ?? 0;
  const limit = window.name === 'task' ? MAX_TASK_SPEND_USD : MAX_SPEND_CAP_USD;
  return Math.min(
    limit,
    Math.ceil(Math.max(cap + Math.max(0.1, cap * 0.1), window.projectedUsd + 0.01) * 100) / 100
  );
};

export function spendBlockCopy(block: TaskSpendBlock): { title: string; description: string } {
  if (block.blocked)
    return { title: 'A spending limit paused this work', description: block.summary };
  if (block.estimateSource === 'paused_step')
    return {
      title: 'There is room for the paused request',
      description:
        'Current limits cover its last recorded estimate. You can resume; each request is checked again before it runs.'
    };
  return {
    title: 'Review spending before resuming',
    description:
      'Current spending is below the limits, but the next request has no saved estimate. Resume will check its cost before it runs and may pause again.'
  };
}

export default function SpendBlock({ task, onResumed }: { task: Task; onResumed: () => void }) {
  const [block, setBlock] = useState<TaskSpendBlock | null>(null);
  const [ceiling, setCeiling] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setBlock(null);
    setError(null);
    setCeiling(null);
    get<TaskSpendBlock>(`/v1/tasks/${task.id}/spend-block`)
      .then((next) => live && setBlock(next))
      .catch((cause) => live && setError(cause));
    return () => {
      live = false;
    };
  }, [task.id, task.spendPausedAt, task.maxSpendUsd]);
  if (error && !block) return <ErrorNotice error={error} />;
  if (!block) return <Spinner label="Checking spending…" />;
  const blocked = block.decision.windows.find((window) => window.name === block.decision.blockedBy);
  const clear = !block.blocked;
  const raiseTo = ceiling ?? (blocked ? String(suggestedCeiling(blocked)) : '');
  const copy = spendBlockCopy(block);
  const maximum = blocked?.name === 'task' ? MAX_TASK_SPEND_USD : MAX_SPEND_CAP_USD;
  const validCeiling =
    Number.isFinite(Number(raiseTo)) &&
    Number(raiseTo) > (blocked?.capUsd ?? 0) &&
    Number(raiseTo) >= (blocked?.projectedUsd ?? 0) &&
    Number(raiseTo) <= maximum;

  async function act() {
    setBusy(true);
    setError(null);
    try {
      if (!clear && blocked) {
        if (!validCeiling)
          throw new Error('Enter a higher limit that covers the estimated request.');
        const body =
          blocked.name === 'daily'
            ? { dailyCapUsd: Number(raiseTo) }
            : blocked.name === 'monthly'
              ? { monthlyCapUsd: Number(raiseTo) }
              : null;
        if (body) {
          try {
            await put('/v1/spend-limits', body);
          } catch (cause) {
            if (
              !(cause instanceof ApiError) ||
              !['step_up_required', 'recent_authentication_required'].includes(cause.code)
            )
              throw cause;
            await stepUp();
            await put('/v1/spend-limits', body);
          }
        } else await post(`/v1/tasks/${task.id}/spend-ceiling`, { maxSpendUsd: Number(raiseTo) });
        const next = await get<TaskSpendBlock>(`/v1/tasks/${task.id}/spend-block`);
        setBlock(next);
        setCeiling(null);
        if (next.blocked) return;
      }
      await post(`/v1/tasks/${task.id}/resume`);
      onResumed();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="decision-card">
      <div className="eyebrow">
        <CircleDollarSign size={14} aria-hidden="true" />
        Spending
      </div>
      <h3>{copy.title}</h3>
      <p>{copy.description}</p>
      {block.unchosen && !clear && (
        <p className="muted">This is the default ceiling until you choose one.</p>
      )}
      {blocked && (
        <dl className="facts">
          <div>
            <dt>Limit for</dt>
            <dd>{WINDOW_LABEL[blocked.name] ?? blocked.name}</dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd>{money(blocked.spentUsd)}</dd>
          </div>
          {blocked.pendingUsd > 0 && (
            <div>
              <dt>Reserved for open work</dt>
              <dd>{money(blocked.pendingUsd)}</dd>
            </div>
          )}
          {block.estimateSource === 'paused_step' && (
            <div>
              <dt>Paused request estimate</dt>
              <dd>{money(block.decision.estimateUsd)}</dd>
            </div>
          )}
          <div>
            <dt>Limit</dt>
            <dd>{blocked.capUsd === null ? 'None' : money(blocked.capUsd)}</dd>
          </div>
        </dl>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act();
        }}
      >
        {!clear && blocked && (
          <Field
            label="New limit · USD"
            hint={
              blocked.name === 'task'
                ? 'Applies only to this conversation.'
                : 'Applies across all projects on your account.'
            }
          >
            <input
              type="number"
              inputMode="decimal"
              required
              step="any"
              min={Math.max((blocked.capUsd ?? 0) + 0.000001, blocked.projectedUsd)}
              max={maximum}
              value={raiseTo}
              disabled={busy}
              onChange={(event) => setCeiling(event.target.value)}
            />
          </Field>
        )}
        <ErrorNotice error={error} />
        <div className="row decision-actions">
          <Button
            type="submit"
            className="primary"
            busy={busy}
            disabled={!clear && (!blocked || !validCeiling)}
          >
            {clear
              ? 'Resume'
              : validCeiling
                ? `Set limit to ${money(Number(raiseTo))} and resume`
                : 'Set limit and resume'}
          </Button>
          <Button disabled={busy} onClick={onResumed}>
            Keep paused
          </Button>
        </div>
      </form>
      <small>
        {clear
          ? 'Resuming keeps your spending limits unchanged.'
          : 'This authorizes a spending ceiling, not a charge. Actual usage is billed as work runs.'}
      </small>
    </article>
  );
}
