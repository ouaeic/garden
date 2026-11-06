import { useEffect, useMemo, useState } from 'react';
import type { Artifact } from '@garden/contracts';
import { get } from '../client';
import { ago } from '../app/derive';
import { KINDS, kindOf, sizeText, type KindId } from '../app/kinds';
import { go } from '../app/route';
import { primaryWorkspace, useGarden } from '../app/store';
import { openArtifact } from '../app/viewer';
import '../goals/lists.css';
import './library.css';

/**
 * Everything garden has made, on shelves by kind, newest first: the place to find last week's deck
 * without remembering which conversation produced it. Each opens as itself.
 */
export default function LibraryView() {
  const { bootstrap } = useGarden();
  const workspace = primaryWorkspace(bootstrap);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [failed, setFailed] = useState('');
  const [shelf, setShelf] = useState<KindId | 'all'>('all');
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController();
    get<Artifact[]>(`/v1/workspaces/${workspace.id}/artifacts`, { signal: controller.signal }).then(
      (list) => setArtifacts(list),
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setFailed(cause instanceof Error ? cause.message : 'The library did not load.');
      }
    );
    return () => controller.abort();
  }, [workspace]);

  const titles = useMemo(
    () => new Map((bootstrap?.tasks ?? []).map((task) => [task.id, task.title])),
    [bootstrap?.tasks]
  );
  // A file saved again is one deliverable with versions; the newest stands for it.
  const latest = useMemo(() => {
    const byName = new Map<string, Artifact>();
    for (const artifact of artifacts ?? []) {
      const key = `${artifact.taskId ?? ''}:${artifact.name}`;
      const held = byName.get(key);
      if (!held || artifact.version > held.version) byName.set(key, artifact);
    }
    return [...byName.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [artifacts]);
  const tally = useMemo(() => {
    const counts = new Map<KindId, number>();
    for (const artifact of latest) {
      const id = kindOf(artifact.name, artifact.mimeType).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [latest]);
  const needle = query.trim().toLowerCase();
  const shown = latest.filter(
    (artifact) =>
      (shelf === 'all' || kindOf(artifact.name, artifact.mimeType).id === shelf) &&
      (!needle ||
        artifact.name.toLowerCase().includes(needle) ||
        (titles.get(artifact.taskId ?? '') ?? '').toLowerCase().includes(needle))
  );

  return (
    <div className="list-view">
      <header className="list-head">
        <div className="list-title">
          <h1>Library</h1>
          <span className="list-sub">
            {artifacts ? `${latest.length} thing${latest.length === 1 ? '' : 's'} made` : ''}
          </span>
        </div>
        <input
          type="search"
          className="list-filter"
          placeholder="Find a file, or the goal it came from"
          aria-label="Find a file"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="list-chips" role="group" aria-label="Shelf">
          <button
            type="button"
            className="chip"
            aria-pressed={shelf === 'all'}
            onClick={() => setShelf('all')}
          >
            Everything
          </button>
          {(Object.keys(KINDS) as KindId[])
            .filter((id) => tally.get(id))
            .map((id) => (
              <button
                key={id}
                type="button"
                className="chip"
                aria-pressed={shelf === id}
                onClick={() => setShelf(id)}
              >
                {KINDS[id].plural}
                <span className="chip-count">{tally.get(id)}</span>
              </button>
            ))}
        </div>
      </header>
      <div className="list-body scroll">
        {failed ? (
          <p className="error" role="alert">
            {failed}
          </p>
        ) : !artifacts ? (
          <div className="shelf" aria-busy="true">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="made skeleton" />
            ))}
          </div>
        ) : shown.length ? (
          <ul className="shelf">
            {shown.map((artifact) => {
              const kind = kindOf(artifact.name, artifact.mimeType);
              const from = titles.get(artifact.taskId ?? '');
              return (
                <li key={artifact.id}>
                  <button
                    type="button"
                    className={`made is-${kind.id}`}
                    onClick={() => openArtifact(artifact)}
                  >
                    <span className="made-mark" aria-hidden="true">
                      <kind.icon />
                    </span>
                    <span className="made-name">{artifact.name}</span>
                    <span className="made-from">{from ?? kind.label}</span>
                    <span className="made-meta num">
                      {ago(artifact.createdAt)} · {sizeText(artifact.sizeBytes)}
                      {artifact.version > 1 ? ` · v${artifact.version}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="list-empty">
            <p>
              {latest.length
                ? 'Nothing on this shelf matches.'
                : 'Nothing made yet. Documents, decks, sites, data and images garden makes land here.'}
            </p>
            {!latest.length && (
              <button type="button" className="btn" onClick={() => go({ view: 'today' })}>
                Ask for something
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
