import { useEffect, useMemo, useState } from 'react';
import type { RecordEntry, Task, TaskEvent } from '@garden/contracts';
import { get } from '../client';
import { loadEventPage } from '../stream';
import { accept } from '../app/actions';
import { GROWTH_COLOR, GROWTH_WORD, ago, goalLine, growth, money } from '../app/derive';
import { Bloom, Check, Close, Sprout } from '../app/icons';
import { go, openGoal } from '../app/route';
import { useGarden } from '../app/store';
import { toast } from '../app/toast';
import { NOTE_LABEL, notesFrom, type Note } from '../goal/timeline';
import './catchup.css';

interface Story {
  task: Task;
  notes: Note[];
  spent: number;
  events: number;
}

const WORTH: Note['kind'][] = [
  'checked',
  'result',
  'problem',
  'asked',
  'deal',
  'approval',
  'note',
  'plan'
];

/**
 * Since you last looked. Written when it is opened, from what the goals themselves recorded -
 * nobody composed summaries while the owner was away - and it says the verdict first: what is
 * done, what needs them, what it cost, and what left the computer.
 */
export default function CatchUp({ since, onClose }: { since: string | null; onClose: () => void }) {
  const { bootstrap, moves } = useGarden();
  const [stories, setStories] = useState<Story[] | null>(null);
  const [outward, setOutward] = useState<RecordEntry[]>([]);
  const from = since ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
  const changed = useMemo(
    () =>
      (bootstrap?.tasks ?? [])
        .filter((task) => Date.parse(task.updatedAt) > Date.parse(from) && !task.parentMissionId)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 8),
    [bootstrap, from]
  );
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      changed.map(async (task): Promise<Story> => {
        const page = await loadEventPage(task.id, { limit: 200, signal: controller.signal }).catch(
          () => null
        );
        const recent = (page?.events ?? []).filter(
          (event: TaskEvent) => Date.parse(event.createdAt) > Date.parse(from)
        );
        const spent = recent
          .filter((event) => event.kind === 'cost')
          .reduce(
            (sum, event) =>
              sum + Number((event.payload as { costUsd?: number } | undefined)?.costUsd ?? 0),
            0
          );
        const notes = notesFrom(recent)
          .filter((note) => WORTH.includes(note.kind))
          .sort((a, b) => WORTH.indexOf(a.kind) - WORTH.indexOf(b.kind))
          .slice(0, 3);
        return { task, notes, spent, events: recent.length };
      })
    ).then((all) => {
      if (!controller.signal.aborted) setStories(all);
    });
    void get<RecordEntry[]>('/v1/record?limit=200').then(
      (entries) => setOutward(entries.filter((entry) => Date.parse(entry.at) > Date.parse(from))),
      () => undefined
    );
    return () => controller.abort();
  }, [changed, from]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [onClose]);

  const ready = changed.filter((task) => growth(task, moves) === 'ready').length;
  const needing = moves.length;
  const spent = stories?.reduce((sum, story) => sum + story.spent, 0) ?? 0;
  const records = stories?.reduce((sum, story) => sum + story.events, 0) ?? 0;
  const silent = outward.filter((entry) => entry.verdict === 'expired').length;
  const onKeys = outward.filter((entry) => entry.source === 'key').length;
  const verdict = [
    ready ? `${ready === 1 ? 'One goal is' : `${ready} goals are`} ready` : '',
    needing
      ? `${needing === 1 ? 'one thing needs' : `${needing} things need`} you`
      : 'nothing needs you',
    spent ? `${money(spent)} spent` : ''
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      className="scrim is-open"
      role="presentation"
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="sheet catchup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="catchup-title"
      >
        <div className="sheet-head">
          <div className="eyebrow">
            Since you last looked · {ago(from)} ·{' '}
            {stories ? `written just now from ${records} records` : 'reading the record…'}
          </div>
          <h2 id="catchup-title" className="display">
            {stories ? (
              <>{verdict.replace(/^./, (c) => c.toUpperCase())}.</>
            ) : (
              <span className="skeleton" style={{ display: 'block', width: '70%', height: 44 }} />
            )}
          </h2>
          <button
            type="button"
            className="icon-btn sheet-close"
            aria-label="Close"
            onClick={onClose}
          >
            <Close />
          </button>
        </div>
        <div className="sheet-body scroll">
          {!stories ? (
            <div className="catchup-grid">
              {changed.slice(0, 3).map((task) => (
                <div key={task.id} className="skeleton" style={{ height: 220, borderRadius: 24 }} />
              ))}
            </div>
          ) : stories.length ? (
            <div className="catchup-grid">
              {stories.map((story, index) => {
                const state = growth(story.task, moves);
                return (
                  <article
                    key={story.task.id}
                    className="catchup-card reveal"
                    style={{ '--i': index, '--glow': GROWTH_COLOR[state] } as React.CSSProperties}
                  >
                    <header>
                      {state === 'ready' ? (
                        <Bloom className="catchup-mark" />
                      ) : (
                        <Sprout className="catchup-mark" />
                      )}
                      <div>
                        <span
                          className="tag"
                          style={{ '--c': GROWTH_COLOR[state] } as React.CSSProperties}
                        >
                          {GROWTH_WORD[state]}
                        </span>
                        <h3>{story.task.title}</h3>
                      </div>
                    </header>
                    {story.notes.length ? (
                      <ul className="catchup-notes">
                        {story.notes.map((note) => (
                          <li key={note.id}>
                            <span className="eyebrow">{NOTE_LABEL[note.kind]}</span>
                            <p>{note.body && note.kind === 'checked' ? note.body : note.title}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">{goalLine(story.task, moves)}</p>
                    )}
                    <footer>
                      {story.task.activity?.ending?.verification === 'verified' && (
                        <span className="proof">
                          <Check /> Checked
                        </span>
                      )}
                      {story.spent > 0 && (
                        <span className="faint mono">{money(story.spent)} since</span>
                      )}
                      <span className="catchup-acts">
                        {state === 'ready' && (
                          <button
                            type="button"
                            className="btn ghost small"
                            onClick={() =>
                              void accept(story.task.id).then(() =>
                                toast(`Accepted “${story.task.title}”.`)
                              )
                            }
                          >
                            Accept
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => {
                            onClose();
                            openGoal(story.task.id);
                          }}
                        >
                          Open
                        </button>
                      </span>
                    </footer>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="muted">Nothing changed. Everything is where you left it.</p>
          )}
          {stories && (
            <div className="catchup-foot">
              <span>
                <b>{outward.length}</b> action{outward.length === 1 ? '' : 's'} left your computer
                {onKeys ? `, ${onKeys} on a lent key` : ''}
              </span>
              {silent > 0 && (
                <span>
                  <b>{silent}</b> question{silent === 1 ? '' : 's'} lapsed unanswered
                </span>
              )}
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  onClose();
                  go({ view: 'record' });
                }}
              >
                See the record
              </button>
            </div>
          )}
        </div>
        <div className="sheet-foot">
          <span className="faint small">
            Composed when you opened it, from the goals’ own record.
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Go to Today
          </button>
        </div>
      </div>
    </div>
  );
}
