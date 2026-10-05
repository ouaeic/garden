import { useEffect, useMemo, useState } from 'react';
import type { RecordEntry } from '@garden/contracts';
import { get } from '../client';
import { Sprout } from '../app/icons';
import { RecordRow } from './RecordRow';

const FILTERS: { name: string; keep: (entry: RecordEntry) => boolean }[] = [
  { name: 'Everything', keep: () => true },
  { name: 'Asked you', keep: (entry) => entry.source === 'card' },
  { name: 'On a lent key', keep: (entry) => entry.source === 'key' },
  {
    name: 'Declined or lapsed',
    keep: (entry) => ['denied', 'expired', 'refused'].includes(entry.verdict)
  },
  { name: 'Connected services', keep: (entry) => entry.source === 'connector' }
];

/**
 * What did garden do? Every action that left the computer or asked to - the cards the owner
 * answered, the sends a lent key allowed, the writes a connected service carried - newest first.
 */
export default function Record() {
  const [entries, setEntries] = useState<RecordEntry[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState(0);
  useEffect(() => {
    void get<RecordEntry[]>('/v1/record?limit=200').then(setEntries, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'The record could not be read.')
    );
  }, []);
  const shown = useMemo(() => (entries ?? []).filter(FILTERS[filter]!.keep), [entries, filter]);
  const count = (keep: (entry: RecordEntry) => boolean) => (entries ?? []).filter(keep).length;
  return (
    <div className="record scroll">
      <header className="record-head rise">
        <h1 className="display">
          What did garden <em>do?</em>
        </h1>
        <dl className="record-stats num">
          <div>
            <dd>{count(() => true)}</dd>
            <dt>actions outward</dt>
          </div>
          <div>
            <dd>{count((entry) => entry.source === 'key')}</dd>
            <dt>on a lent key</dt>
          </div>
          <div>
            <dd>{count((entry) => entry.source === 'card')}</dd>
            <dt>asked you first</dt>
          </div>
          <div>
            <dd>{count((entry) => ['denied', 'refused'].includes(entry.verdict))}</dd>
            <dt>declined</dt>
          </div>
        </dl>
      </header>
      <div className="chips record-filters" role="group" aria-label="Show">
        {FILTERS.map((item, index) => (
          <button
            key={item.name}
            type="button"
            className="chip"
            aria-pressed={filter === index}
            onClick={() => setFilter(index)}
          >
            {item.name}
          </button>
        ))}
      </div>
      {error && <p className="error-line">{error}</p>}
      {entries === null && !error ? (
        <div className="skeleton" style={{ height: 240 }} />
      ) : shown.length ? (
        <ul className="ledger">
          {shown.map((entry) => (
            <RecordRow key={entry.id} entry={entry} showGoal />
          ))}
        </ul>
      ) : (
        <div className="empty">
          <Sprout />
          <span>
            Nothing here yet. Every action that leaves your computer will be listed with what
            allowed it.
          </span>
        </div>
      )}
    </div>
  );
}
