import { useState } from 'react';
import type { OwnerMove } from '@garden/contracts';
import { answer, approve, deny, raiseCapAndResume } from '../app/actions';
import { money, until } from '../app/derive';
import { Key, Question, Speak, Spend, Sprout } from '../app/icons';
import { go, openDeal, openGoal } from '../app/route';
import { toast } from '../app/toast';
import {
  APPROVAL_NOTE_MAX_CHARS,
  approvalIntroduction,
  approvalToolPhrases
} from '../approval-copy';

/**
 * Everything waiting on the owner, one card at a time, each answerable where it sits.
 *
 * A stack rather than a feed: the top card is the one to answer, the edges behind it say how many
 * follow, and answering one lifts the next into place.
 */
export default function Moves({ moves }: { moves: readonly OwnerMove[] }) {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (move: OwnerMove) =>
    move.kind === 'approval'
      ? move.approvalId
      : move.kind === 'spend'
        ? `spend:${move.taskId}`
        : move.questionId;
  const live = moves.filter((move) => !gone.has(keyOf(move)));
  const done = (move: OwnerMove) => setGone((set) => new Set(set).add(keyOf(move)));
  return (
    <section className="pane moves" aria-labelledby="moves-title">
      <div className="pane-head">
        <h2 id="moves-title">Your move</h2>
        <span className="count">{live.length ? `${live.length} waiting` : ''}</span>
      </div>
      {live.length ? (
        <div className="deck">
          {live.slice(0, 3).map((move, i) => (
            <MoveCard key={keyOf(move)} move={move} top={i === 0} onDone={() => done(move)} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <Sprout />
          <span>Nothing needs you. Anything that does will wait here, never in a feed.</span>
        </div>
      )}
    </section>
  );
}

function MoveCard({ move, top, onDone }: { move: OwnerMove; top: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [declining, setDeclining] = useState(false);
  const run = async (work: () => Promise<unknown>, said?: string) => {
    setBusy(true);
    setError('');
    try {
      await work();
      if (said) toast(said);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const goal = (
    <button type="button" className="move-goal" onClick={() => openGoal(move.taskId)}>
      {move.taskTitle}
    </button>
  );
  let body: React.ReactNode;
  switch (move.kind) {
    case 'deal':
      body = (
        <>
          <span className="move-kind">
            <Sprout /> A deal to agree
          </span>
          <h3>{move.deal.summary}</h3>
          <p>
            {move.deal.goals.length === 1 ? 'One goal' : `${move.deal.goals.length} goals`}
            {move.deal.questions.length
              ? `, ${move.deal.questions.length} question${move.deal.questions.length === 1 ? '' : 's'} to settle now`
              : ''}
            . Nothing starts until you plant it.
          </p>
          <div className="move-acts">
            <button type="button" className="btn leaf small" onClick={() => openDeal(move.taskId)}>
              Review the deal
            </button>
          </div>
        </>
      );
      break;
    case 'question':
      body = (
        <>
          <span className="move-kind">
            <Question /> A question · {goal}
          </span>
          <h3>{move.question}</h3>
          {move.why && <p>{move.why}</p>}
          <div className="move-acts">
            {move.options.map((option) => (
              <button
                key={option}
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() =>
                  void run(() => answer(move.taskId, move.questionId, option), 'Answered.')
                }
              >
                {option}
              </button>
            ))}
          </div>
          <form
            className="move-reply"
            onSubmit={(event) => {
              event.preventDefault();
              if (reply.trim())
                void run(() => answer(move.taskId, move.questionId, reply.trim()), 'Answered.');
            }}
          >
            <input
              className="field"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder={move.options.length ? 'Or say it in your words' : 'Your answer'}
              aria-label={`Answer: ${move.question}`}
            />
          </form>
        </>
      );
      break;
    case 'handoff':
      body = (
        <>
          <span className="move-kind">
            <Speak /> Your hands · {goal}
          </span>
          <h3>{move.question}</h3>
          <p>The browser needs a person for this step. The work carries on once you are done.</p>
          <div className="move-acts">
            <button
              type="button"
              className="btn leaf small"
              onClick={() => go({ view: 'computer', tab: 'browser' })}
            >
              Open the browser
            </button>
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() =>
                void run(() => answer(move.taskId, move.questionId, 'Done.'), 'Carrying on.')
              }
            >
              I have done it
            </button>
          </div>
        </>
      );
      break;
    case 'approval':
      body = (
        <>
          <span className="move-kind">
            <Key /> {approvalToolPhrases[move.tool] ?? 'Asking first'} · {goal}
          </span>
          <h3>{move.action}</h3>
          {move.detail && (
            <p className="move-detail">
              {approvalIntroduction(move.tool, move.action, move.detail)}
            </p>
          )}
          <div className="move-acts">
            <button
              type="button"
              className="btn leaf small"
              disabled={busy}
              onClick={() => void run(() => approve(move.approvalId), 'Approved.')}
            >
              Approve
            </button>
            {move.runGrant && (
              <button
                type="button"
                className="btn small"
                disabled={busy}
                title={move.runGrant}
                onClick={() =>
                  void run(() => approve(move.approvalId, 'run'), 'Approved for this run.')
                }
              >
                For this run
              </button>
            )}
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              aria-expanded={declining}
              onClick={() => setDeclining((on) => !on)}
            >
              Decline
            </button>
          </div>
          {declining && (
            <form
              className="move-reply"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () => deny(move.approvalId, reply.trim() || undefined),
                  'Declined. It will find another way.'
                );
              }}
            >
              <input
                className="field"
                value={reply}
                maxLength={APPROVAL_NOTE_MAX_CHARS}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Why, or what to do instead (optional)"
                aria-label="Reason for declining"
              />
              <button type="submit" className="btn small" disabled={busy}>
                Decline
              </button>
            </form>
          )}
          <p className="move-when faint">Expires {until(move.expiresAt)}</p>
        </>
      );
      break;
    case 'spend': {
      const raised = Math.max(move.spentUsd * 1.5, (move.maxSpendUsd ?? 0) + 5);
      body = (
        <>
          <span className="move-kind">
            <Spend /> Its spending cap · {goal}
          </span>
          <h3>
            Paused at {money(move.spentUsd)}
            {move.maxSpendUsd ? ` of ${money(move.maxSpendUsd)}` : ''}.
          </h3>
          <p>Raising this goal’s own cap lets it carry on; your account caps still hold.</p>
          <div className="move-acts">
            <button
              type="button"
              className="btn leaf small"
              disabled={busy}
              onClick={() => void run(() => raiseCapAndResume(move.taskId, raised), 'Carrying on.')}
            >
              Raise to {money(raised)} and resume
            </button>
          </div>
        </>
      );
      break;
    }
  }
  return (
    <article className="move" aria-hidden={!top} inert={!top || undefined}>
      {body}
      {error && <p className="error-line">{error}</p>}
    </article>
  );
}
