import { useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerMove, TaskDeal } from '@garden/contracts';
import { plantDeal } from '../app/actions';
import { money } from '../app/derive';
import { Check, Close, Lock, Publish, Remove, Rules, Speak, Spend, Sprout } from '../app/icons';
import { closeSheet } from '../app/route';
import { refresh } from '../app/store';
import { toast } from '../app/toast';
import { flySeeds } from './seeds';
import './deal.css';

type DealMove = Extract<OwnerMove, { kind: 'deal' }>;

/** The keys every mode keeps for the owner, said once so a lent key is never mistaken for them. */
const KEPT = [
  { icon: Publish, name: 'Publish', note: 'Public links to your apps always ask first.' },
  { icon: Remove, name: 'Remove', note: 'Deleting anything outside an undo point always asks.' },
  { icon: Rules, name: 'Rules', note: 'Schedules, memory, services and connections always ask.' },
  { icon: Lock, name: 'Accounts', note: 'Passwords, codes and signatures always come to you.' }
];

/**
 * The deal, laid out to be agreed in one sitting: what will grow and how you will know it is done,
 * every question that can be settled now, and what it may do without you. Planting it is the
 * last thing the owner is asked unless something unforeseen comes up.
 */
export default function DealSheet({ move }: { move: DealMove | undefined }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('h2')?.focus();
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && closeSheet();
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, []);
  return (
    <div
      className="scrim is-open"
      role="presentation"
      onKeyDown={(event) => event.key === 'Escape' && closeSheet()}
      onClick={(event) => event.target === event.currentTarget && closeSheet()}
    >
      <div
        ref={dialog}
        className="sheet deal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deal-title"
      >
        {move ? (
          <DealBody move={move} />
        ) : (
          <div className="sheet-head">
            <h2 id="deal-title" className="display" tabIndex={-1}>
              This deal is settled.
            </h2>
            <p className="muted">It was planted or answered from another place.</p>
            <button
              type="button"
              className="icon-btn sheet-close"
              aria-label="Close"
              onClick={closeSheet}
            >
              <Close />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DealBody({ move }: { move: DealMove }) {
  const deal: TaskDeal = move.deal;
  const [answers, setAnswers] = useState<string[]>(() => deal.questions.map(() => ''));
  const [planted, setPlanted] = useState<boolean[]>(() => deal.goals.map(() => true));
  const [caps, setCaps] = useState<number[]>(() => deal.goals.map((goal) => goal.capUsd));
  const [actAsYou, setActAsYou] = useState(deal.actAsYou);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = useRef<(HTMLElement | null)[]>([]);
  const chosen = planted.flatMap((on, index) => (on ? [index] : []));
  const total = chosen.reduce((sum, index) => sum + (caps[index] ?? 0), 0);
  const answered = answers.filter((answer) => answer.trim()).length;
  const estimate = useMemo(
    () =>
      deal.goals
        .filter((_, index) => planted[index])
        .map((goal) => goal.estimate)
        .filter(Boolean),
    [deal.goals, planted]
  );

  const plant = async () => {
    setBusy(true);
    setError('');
    const from = chosen.map((index) => rows.current[index]?.getBoundingClientRect() ?? null);
    try {
      const { taskIds } = await plantDeal(move.taskId, {
        questionId: move.questionId,
        answers,
        goals: chosen,
        actAsYou,
        capsUsd: chosen.map((index) => caps[index]!),
        ...(note.trim() ? { note: note.trim() } : {})
      });
      closeSheet();
      await refresh();
      flySeeds(from, taskIds);
      toast(
        taskIds.length === 1
          ? 'Planted. You can close the laptop.'
          : `Planted ${taskIds.length} goals. You can close the laptop.`
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The deal could not be planted. Try again.'
      );
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sheet-head">
        <div className="eyebrow reveal" style={{ '--i': 0 } as React.CSSProperties}>
          The deal · {move.taskTitle}
        </div>
        <h2
          id="deal-title"
          className="display reveal"
          tabIndex={-1}
          style={{ '--i': 1 } as React.CSSProperties}
        >
          {headline(deal)}
        </h2>
        <p className="muted reveal" style={{ '--i': 2 } as React.CSSProperties}>
          {deal.summary} Settle these now and you will not hear from it unless something is ready or
          breaks. Everything on your server can be undone, so it only asks about the outside world.
        </p>
        <button
          type="button"
          className="icon-btn sheet-close"
          aria-label="Close"
          onClick={closeSheet}
        >
          <Close />
        </button>
      </div>
      <div className="sheet-body scroll">
        <div className="deal">
          <div className="deal-col">
            <h3 className="deal-h reveal" style={{ '--i': 3 } as React.CSSProperties}>
              What it will grow{' '}
              <span>
                {chosen.length} of {deal.goals.length}
              </span>
            </h3>
            <ul className="deal-goals">
              {deal.goals.map((goal, index) => (
                <li
                  key={index}
                  ref={(element) => {
                    rows.current[index] = element;
                  }}
                  className={`deal-goal reveal ${planted[index] ? '' : 'is-off'}`}
                  style={{ '--i': 4 + index } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className="seed-toggle"
                    aria-pressed={planted[index]}
                    aria-label={planted[index] ? `Leave out ${goal.title}` : `Plant ${goal.title}`}
                    disabled={planted[index] && chosen.length === 1}
                    onClick={() =>
                      setPlanted((list) => list.map((on, at) => (at === index ? !on : on)))
                    }
                  >
                    {planted[index] ? <Sprout /> : <Close />}
                  </button>
                  <div className="deal-goal-text">
                    <div className="eyebrow">
                      {goal.rhythm ? `Rhythm · ${goal.rhythm}` : 'Finish line'}
                    </div>
                    <h4>{goal.title}</h4>
                    <p>{goal.outcome}</p>
                    <p className="done-when">
                      <b>Done when</b> {goal.doneWhen}
                    </p>
                  </div>
                  <div className="deal-goal-est">
                    {goal.estimate && <b>{goal.estimate}</b>}
                    <label>
                      <span className="sr-only">Spending cap for {goal.title}, in dollars</span>
                      <span aria-hidden="true">cap $</span>
                      <input
                        type="number"
                        min={0.5}
                        max={1000}
                        step={0.5}
                        value={caps[index]}
                        disabled={!planted[index]}
                        onChange={(event) =>
                          setCaps((list) =>
                            list.map((cap, at) =>
                              at === index ? Math.max(0.5, Number(event.target.value) || 0.5) : cap
                            )
                          )
                        }
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
            <label className="deal-note reveal" style={{ '--i': 9 } as React.CSSProperties}>
              <span className="deal-h">Anything to change</span>
              <textarea
                className="field"
                rows={2}
                value={note}
                maxLength={2000}
                placeholder="Optional. Said in your words, it travels with the deal."
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>
          <div className="deal-col">
            {deal.questions.length > 0 && (
              <>
                <h3 className="deal-h reveal" style={{ '--i': 4 } as React.CSSProperties}>
                  Settle these now{' '}
                  <span>
                    {answered} of {deal.questions.length} answered
                  </span>
                </h3>
                <ol className="deal-questions">
                  {deal.questions.map((question, index) => (
                    <li
                      key={index}
                      className={`deal-question reveal ${answers[index]?.trim() ? 'is-answered' : ''}`}
                      style={{ '--i': 5 + index } as React.CSSProperties}
                    >
                      <p>
                        <span className="tick" aria-hidden="true">
                          <Check />
                        </span>
                        {question.question}
                      </p>
                      <div className="chips">
                        {question.options.map((option) => (
                          <button
                            key={option}
                            type="button"
                            className="chip"
                            aria-pressed={answers[index] === option}
                            onClick={() =>
                              setAnswers((list) =>
                                list.map((answer, at) =>
                                  at === index ? (answer === option ? '' : option) : answer
                                )
                              )
                            }
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="faint deal-fine">An unanswered question takes the safe choice.</p>
              </>
            )}
            <h3 className="deal-h reveal" style={{ '--i': 10 } as React.CSSProperties}>
              Keys for this deal <span>tap to lend</span>
            </h3>
            <div className="keys-grid">
              <div className="key-tile is-lent reveal" style={{ '--i': 11 } as React.CSSProperties}>
                <span className="key-icon">
                  <Spend />
                </span>
                <b>Spend</b>
                <span>
                  Up to {money(total)} across{' '}
                  {chosen.length === 1 ? 'this goal' : `${chosen.length} goals`}
                </span>
              </div>
              <button
                type="button"
                className={`key-tile reveal ${actAsYou ? 'is-lent' : ''}`}
                style={{ '--i': 12 } as React.CSSProperties}
                aria-pressed={actAsYou}
                onClick={() => setActAsYou((on) => !on)}
              >
                <span className="key-icon">
                  <Speak />
                </span>
                <b>Act as you</b>
                <span>
                  {actAsYou
                    ? 'Lent: send, submit and book in your browser, mail and calendar'
                    : 'Kept: it asks before sending, submitting or booking'}
                </span>
              </button>
              {KEPT.map((key, index) => (
                <button
                  key={key.name}
                  type="button"
                  className="key-tile is-kept reveal"
                  style={{ '--i': 13 + index } as React.CSSProperties}
                  onClick={() => toast(`${key.name} stays with you. ${key.note}`)}
                >
                  <span className="key-icon">
                    <key.icon />
                  </span>
                  <b>{key.name}</b>
                  <span>Always asks you</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="sheet-foot">
        <div className="deal-sum mono">
          <span>
            Cap <b>{money(total)}</b>
          </span>
          {estimate.length > 0 && (
            <span>
              About <b>{estimate.join(' · ')}</b>
            </span>
          )}
          <span>
            Acts as you <b>{actAsYou ? 'yes' : 'no'}</b>
          </span>
        </div>
        {error && <p className="error-line">{error}</p>}
        <button type="button" className="btn ghost" onClick={closeSheet}>
          Not yet
        </button>
        <button type="button" className="btn leaf big" disabled={busy} onClick={() => void plant()}>
          <Sprout />
          {busy
            ? 'Planting…'
            : chosen.length === 1
              ? 'Plant this goal'
              : `Plant ${chosen.length} goals`}
        </button>
      </div>
    </>
  );
}

const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
function headline(deal: TaskDeal) {
  const goals = deal.goals.length === 1 ? 'One goal' : `${words[deal.goals.length]} goals`;
  const questions = deal.questions.length
    ? `${words[deal.questions.length]} question${deal.questions.length === 1 ? '' : 's'}`
    : 'No questions';
  return (
    <>
      {goals}. {questions}. <em>Then it goes quiet.</em>
    </>
  );
}
