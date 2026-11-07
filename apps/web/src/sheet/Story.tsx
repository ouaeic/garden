import { lazy, Suspense } from 'react';
import type { Task, TaskEvent, TaskPlan } from '@garden/contracts';
import { setGoalKeys } from '../app/actions';
import { ago, money } from '../app/derive';
import { Back, Check } from '../app/icons';
import { go } from '../app/route';
import { toast } from '../app/toast';
import { NOTE_LABEL, type Note } from '../goal/timeline';

const SubagentLanes = lazy(() => import('../SubagentLanes'));

/** What a goal may do without asking, named the way the owner would say it. */
const GOAL_KEYS = [
  { id: 'publish', name: 'Publish', ask: 'publishing or sharing' },
  { id: 'remove', name: 'Delete', ask: 'deleting for good' },
  { id: 'rules', name: 'Standing rules', ask: 'changing standing rules' }
] as const;

/**
 * How it was made: what done meant, the steps, what it noticed on the way and what it asks
 * before doing. Behind the note rather than beside the work, because it is how, not what.
 */
export default function Story({
  task,
  events,
  plan,
  notes,
  doneWhen,
  onActAsYou,
  onClose
}: {
  task: Task;
  events: readonly TaskEvent[];
  plan: TaskPlan | null;
  notes: Note[];
  doneWhen: string | null;
  onActAsYou: (on: boolean) => void;
  onClose: () => void;
}) {
  const steps = plan?.steps.filter((step) => step.status !== 'skipped') ?? [];
  return (
    <div className="story">
      <button type="button" className="story-back" onClick={onClose}>
        <Back /> The note
      </button>
      <section>
        <h2 className="story-h">Done when</h2>
        <p className="done-line">{doneWhen ?? 'It set its own checks as it worked.'}</p>
      </section>
      {steps.length > 0 && (
        <section>
          <h2 className="story-h">
            Steps
            <span className="count">
              {steps.filter((step) => step.status === 'completed').length} of {steps.length}
            </span>
          </h2>
          <ol className="deliverables">
            {steps.map((step) => (
              <li key={step.id} className={`deliverable is-${step.status}`}>
                <span className="mark" aria-hidden="true">
                  {step.status === 'completed' && <Check />}
                </span>
                <span className="deliverable-title">{step.title}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <Suspense fallback={null}>
        <SubagentLanes events={[...events]} />
      </Suspense>
      <section>
        <h2 className="story-h">
          Along the way
          <button
            type="button"
            className="count link"
            onClick={() => go({ zoom: 'inspect' }, { replace: true })}
          >
            Every step
          </button>
        </h2>
        {notes.length ? (
          <ol className="notes">
            {notes.slice(0, 40).map((note) => (
              <li key={note.id} className={`note is-${note.kind}`}>
                <div className="note-head">
                  <span>{NOTE_LABEL[note.kind]}</span>
                  <time dateTime={note.at}>{ago(note.at)}</time>
                </div>
                <p>{note.title}</p>
                {note.body && <p className="note-body">{note.body}</p>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="faint small">Nothing to mention yet.</p>
        )}
      </section>
      <Permissions task={task} onActAsYou={onActAsYou} />
    </div>
  );
}

/** What this goal may do without asking, said in one line and changed in place. */
function Permissions({ task, onActAsYou }: { task: Task; onActAsYou: (on: boolean) => void }) {
  const lent = task.lentKeys ?? [];
  const actsAsYou = task.securityMode === 'autonomous';
  const asks = [
    ...(actsAsYou ? [] : ['sending or booking as you']),
    ...GOAL_KEYS.filter((key) => !lent.includes(key.id)).map((key) => key.ask)
  ];
  const toggle = (id: (typeof GOAL_KEYS)[number]['id'], name: string) => {
    const on = lent.includes(id);
    void setGoalKeys(task.id, on ? lent.filter((item) => item !== id) : [...lent, id]).then(
      () => toast(on ? `${name}: asks first again.` : `${name}: allowed in this goal.`),
      (cause: unknown) => toast(cause instanceof Error ? cause.message : 'That did not change.')
    );
  };
  return (
    <details className="story-permissions">
      <summary>
        <h2 className="story-h">Asks before</h2>
        <span>{asks.length ? asks.join(', ') : 'Nothing: everything is allowed in this goal'}</span>
      </summary>
      <div className="permission-list">
        <button
          type="button"
          className="permission"
          aria-pressed={actsAsYou}
          onClick={() => onActAsYou(!actsAsYou)}
        >
          <span className="permission-name">Act as you</span>
          <span className="permission-state">{actsAsYou ? 'Allowed' : 'Asks first'}</span>
        </button>
        {GOAL_KEYS.map((key) => (
          <button
            key={key.id}
            type="button"
            className="permission"
            aria-pressed={lent.includes(key.id)}
            onClick={() => toggle(key.id, key.name)}
          >
            <span className="permission-name">{key.name}</span>
            <span className="permission-state">
              {lent.includes(key.id) ? 'Allowed' : 'Asks first'}
            </span>
          </button>
        ))}
        <p className="faint small">
          Spend: {money(task.spentUsd)}
          {task.maxSpendUsd ? ` of a ${money(task.maxSpendUsd)} cap` : ''}. Everything inside your
          computer can be undone; these are the things that reach outside it.
        </p>
      </div>
    </details>
  );
}
