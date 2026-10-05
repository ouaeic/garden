import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@garden/contracts';
import { get } from '../client';
import { askWith } from '../ask/ask-bus';
import { Close, Search as SearchIcon, Sprout } from '../app/icons';
import { closeSheet, go, openGoal, type View } from '../app/route';
import './search.css';

interface Hit {
  taskId: string;
  title: string;
  excerpt: string;
}
type Row =
  | { kind: 'goal'; id: string; title: string; detail: string }
  | { kind: 'view'; view: View; title: string; detail: string }
  | { kind: 'plant'; text: string };

const VIEWS: { view: View; title: string; detail: string }[] = [
  { view: 'today', title: 'Today', detail: 'What is growing, ready and waiting on you' },
  { view: 'keys', title: 'Keys', detail: 'What garden may do without asking' },
  { view: 'record', title: 'Record', detail: 'Everything that left your computer' },
  { view: 'computer', title: 'Your computer', detail: 'Screen, terminal, files and processes' },
  { view: 'settings', title: 'Settings', detail: 'Models, connections, notifications, account' }
];

/**
 * One box for going anywhere: a goal by its name or by what was said in it, a view, or - when
 * nothing matches - the words themselves, planted as a new goal.
 */
export default function Search({
  workspaceId,
  tasks
}: {
  workspaceId: string;
  tasks: readonly Task[];
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      get<Hit[]>(`/v1/search?q=${encodeURIComponent(text)}&workspaceId=${workspaceId}&limit=8`, {
        signal: controller.signal
      }).then(setHits, () => undefined);
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, workspaceId]);

  const rows = useMemo<Row[]>(() => {
    const text = query.trim().toLowerCase();
    const named = tasks
      .filter((task) => !text || task.title.toLowerCase().includes(text))
      .slice(0, text ? 6 : 5)
      .map((task) => ({
        kind: 'goal' as const,
        id: task.id,
        title: task.title,
        detail: task.activity?.latest ?? ''
      }));
    const said = hits
      .filter((hit) => !named.some((row) => row.id === hit.taskId))
      .map((hit) => ({
        kind: 'goal' as const,
        id: hit.taskId,
        title: hit.title,
        detail: hit.excerpt
      }));
    const views = VIEWS.filter((view) => !text || view.title.toLowerCase().includes(text)).map(
      (view) => ({
        kind: 'view' as const,
        ...view
      })
    );
    return [
      ...named,
      ...said,
      ...views,
      ...(text ? [{ kind: 'plant' as const, text: query.trim() }] : [])
    ];
  }, [query, tasks, hits]);
  useEffect(() => setActive(0), [query]);

  const choose = (row: Row) => {
    if (row.kind === 'goal') openGoal(row.id);
    else if (row.kind === 'view') go({ view: row.view, sheet: null });
    else {
      closeSheet();
      askWith(row.text);
    }
  };
  return (
    <div
      className="scrim is-open search-scrim"
      role="presentation"
      onKeyDown={(event) => event.key === 'Escape' && closeSheet()}
      onClick={(event) => event.target === event.currentTarget && closeSheet()}
    >
      <div className="search" role="dialog" aria-modal="true" aria-label="Search">
        <div className="search-field">
          <SearchIcon />
          <input
            ref={input}
            value={query}
            placeholder="A goal, something said in one, or a place"
            aria-label="Search"
            aria-controls="search-results"
            aria-activedescendant={rows[active] ? `search-row-${active}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSheet();
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((at) => Math.min(rows.length - 1, at + 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((at) => Math.max(0, at - 1));
              }
              if (event.key === 'Enter' && rows[active]) choose(rows[active]);
            }}
          />
          <button type="button" className="icon-btn" aria-label="Close search" onClick={closeSheet}>
            <Close />
          </button>
        </div>
        <ul id="search-results" className="search-rows scroll" role="listbox">
          {rows.map((row, index) => (
            <li
              key={index}
              id={`search-row-${index}`}
              role="option"
              aria-selected={index === active}
            >
              <button
                type="button"
                className={index === active ? 'is-active' : ''}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                {row.kind === 'plant' ? (
                  <>
                    <span className="search-kind">
                      <Sprout />
                    </span>
                    <span className="search-text">
                      <b>Plant “{row.text}”</b>
                      <span>As a new goal</span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="search-kind mono">{row.kind === 'goal' ? 'Goal' : 'Go'}</span>
                    <span className="search-text">
                      <b>{row.title}</b>
                      {row.detail && <span>{row.detail}</span>}
                    </span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
