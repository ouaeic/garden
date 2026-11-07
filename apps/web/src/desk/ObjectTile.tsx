import { useRef, useState } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { accept } from '../app/actions';
import { ago, GROWTH_COLOR, GROWTH_WORD, growth, money } from '../app/derive';
import { Check } from '../app/icons';
import { openGoal } from '../app/route';
import { toast } from '../app/toast';
import { useAnswerEvents } from '../home/useAnswer';
import { surfaceAnswer } from '../model';
import {
  AnswerFace,
  DataFace,
  DecisionFace,
  FileFace,
  ImageFace,
  PageFace,
  SiteFace,
  WorkingFace
} from './faces';
import { FORM_WORD, formInProgress, formOf, primaryFile, type Form } from './forms';
import { flyToLibrary, rememberOrigin } from './motion';
import { outcomeOf, type Outcome } from './outcomes';

export type DeskItem =
  | { kind: 'decision'; key: string; move: OwnerMove; task: Task | undefined }
  | {
      kind: 'goal';
      key: string;
      task: Task;
      spotlight?: boolean;
      follow?: boolean;
      hint?: Form | null;
    };

/** How much of the desk a thing takes: a site or a fresh answer gets room, a file a corner. */
function sizeOf(form: Form, state: string, spotlight: boolean, outcome: Outcome | undefined) {
  if (spotlight) return 'l';
  if (state === 'working' || state === 'resting') return form === 'site' ? 'w' : 't';
  switch (form) {
    case 'site':
      return 'l';
    case 'document':
    case 'image':
      return 't';
    case 'data':
    case 'slides':
      return 'w';
    case 'answer':
      return (outcome?.headline?.length ?? 0) > 110 || (outcome?.answer?.length ?? 0) > 700
        ? 'w'
        : 's';
    default:
      return 's';
  }
}

export function DecisionTile({ move, task }: { move: OwnerMove; task: Task | undefined }) {
  // Answered here, it leaves at once; the desk's next read agrees with it a moment later.
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <article className="obj size-s is-decision" data-goal-id={task?.id}>
      <DecisionFace move={move} onDone={() => setDone(true)} />
    </article>
  );
}

/**
 * A goal on the desk, drawn as the work it is or is becoming. Opening it grows the work into its
 * own view; keeping it files it in the Library.
 */
export function GoalTile({
  task,
  moves,
  spotlight = false,
  follow = false,
  hint = null
}: {
  task: Task;
  moves: readonly OwnerMove[];
  spotlight?: boolean;
  follow?: boolean;
  hint?: Form | null;
}) {
  const outcome = outcomeOf(task.id);
  const state = growth(task, moves);
  const working = state === 'working' || state === 'resting';
  const form = working ? formInProgress(task, outcome, hint) : formOf(task, outcome);
  const size = sizeOf(form, state, spotlight, outcome);
  const face = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const [leaving, setLeaving] = useState(false);
  const open = () => {
    rememberOrigin(task.id, face.current);
    openGoal(task.id);
  };
  const keep = async () => {
    setLeaving(true);
    await Promise.all([flyToLibrary(card.current), accept(task.id)]).then(
      () =>
        toast(`Kept “${task.title}” in the Library.`, {
          action: { label: 'Undo', run: () => void accept(task.id, false) }
        }),
      (cause: unknown) => {
        setLeaving(false);
        toast(cause instanceof Error ? cause.message : 'That did not go through.');
      }
    );
  };
  return (
    <article
      ref={card}
      className={`obj size-${size} is-${form} is-${state} ${leaving ? 'is-leaving' : ''}`}
      data-goal-id={task.id}
      style={{ '--glow': GROWTH_COLOR[state] } as React.CSSProperties}
    >
      <button
        type="button"
        className="obj-open"
        onClick={open}
        aria-label={`${task.title}. ${GROWTH_WORD[state]}. Open`}
      >
        <div className="obj-face" ref={face}>
          {follow ? (
            <Following task={task} moves={moves} form={form} working={working} outcome={outcome} />
          ) : (
            <Face
              task={task}
              moves={moves}
              form={form}
              working={working}
              outcome={outcome}
              roomy={size === 'w' || size === 'l'}
            />
          )}
        </div>
      </button>
      <footer className="obj-cap">
        <span className="obj-title" title={task.title}>
          {task.title}
        </span>
        <span className="obj-meta">
          <span className="obj-state">
            <i aria-hidden="true" />
            {working
              ? GROWTH_WORD[state]
              : state === 'ready'
                ? FORM_WORD[form]
                : GROWTH_WORD[state]}
          </span>
          <span className="num">{money(task.spentUsd)}</span>
          {task.completedAt && <span>{ago(task.completedAt)}</span>}
          <Verdict outcome={outcome} />
        </span>
        {state === 'ready' && (
          <button
            type="button"
            className="obj-keep"
            aria-label={`Keep “${task.title}”`}
            title="Keep it in the Library"
            disabled={leaving}
            onClick={() => void keep()}
          >
            <Check /> Keep
          </button>
        )}
      </footer>
    </article>
  );
}

/** How far a result has been checked, and how much is left to the owner, at a glance. */
function Verdict({ outcome }: { outcome: Outcome | undefined }) {
  if (!outcome) return null;
  const checked = outcome.checked.length || (outcome.verification === 'verified' ? 1 : 0);
  const yours = outcome.yourCall.length + outcome.risks.length;
  if (!checked && !yours) return null;
  return (
    <span className="obj-verdict">
      {checked > 0 && (
        <span className="is-checked" title="Checked">
          ✓ {checked}
        </span>
      )}
      {yours > 0 && (
        <span className="is-yours" title="Your call">
          ◐ {yours}
        </span>
      )}
    </span>
  );
}

function Face({
  task,
  moves,
  form,
  working,
  outcome,
  live,
  doing,
  roomy = false
}: {
  task: Task;
  moves: readonly OwnerMove[];
  form: Form;
  working: boolean;
  outcome: Outcome | undefined;
  live?: string | null | undefined;
  doing?: string | undefined;
  /** A card given room for more than its conclusion: a long answer carries on beneath it. */
  roomy?: boolean;
}) {
  if (working)
    return <WorkingFace task={task} moves={moves} form={form} doing={doing} live={live} />;
  const file = primaryFile(outcome);
  const headline = outcome?.headline ?? task.title;
  switch (form) {
    case 'site':
      return <SiteFace file={file} label={task.title} outcome={outcome} />;
    case 'document':
      return <PageFace file={file} title={task.title} answer={outcome?.answer ?? null} />;
    case 'data':
      return <DataFace file={file} />;
    case 'image':
      return file ? <ImageFace file={file} /> : <FileFace files={outcome?.files ?? []} />;
    case 'slides':
    case 'code':
    case 'file':
      return <FileFace files={outcome?.files ?? []} />;
    default:
      return (
        <AnswerFace
          headline={headline}
          answer={outcome?.answer ?? null}
          kicker={task.scheduleId ? 'Latest edition' : 'Answer'}
          rich={roomy}
        />
      );
  }
}

/** A goal the owner is watching come back: its own stream, so its words arrive as written. */
function Following(props: {
  task: Task;
  moves: readonly OwnerMove[];
  form: Form;
  working: boolean;
  outcome: Outcome | undefined;
}) {
  const events = useAnswerEvents(props.task.id);
  const ended = events.some((event) => event.kind === 'completed');
  const answer = surfaceAnswer(events);
  const doing = [...events]
    .reverse()
    .find(
      (event) =>
        ['tool_started', 'plan', 'notice', 'subagent', 'status'].includes(event.kind) &&
        event.summary?.trim()
    )?.summary;
  if (props.working && !ended)
    return <Face {...props} live={answer.markdown || null} doing={doing} />;
  // Once its outcome is read, the answer is the reply with what was checked and what is the
  // owner's call taken out; those are on the card's caption, and in its note, already.
  const text = props.outcome?.answer ?? answer.markdown;
  if (!props.outcome?.files.length && text && props.form === 'answer')
    return (
      <AnswerFace
        headline={props.outcome?.headline ?? text.split('\n')[0] ?? ''}
        answer={text}
        rich
      />
    );
  return <Face {...props} working={false} />;
}
