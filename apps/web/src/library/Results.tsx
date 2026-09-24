import { useEffect, useRef, useState } from 'react';
import type { Artifact, Project, ShareRecord, Task, TaskPage, Workspace } from '@athanor/contracts';
import { del, get, patch } from '../client.js';
import { Button, Dialog, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  download,
  fieldValue,
  useAction,
  useResource
} from '../management.js';
import { bytes, date, statusLabel } from '../model.js';
import { ResultPreview } from '../computer/ResultPreview.js';

interface SearchHit {
  taskId: string;
  workspaceId: string;
  title: string;
  excerpt: string;
  updatedAt: string;
}
export function ResultsLibrary({
  workspace,
  projects,
  knownTasks,
  onOpenTask,
  onChange,
  onTaskDeleted
}: {
  workspace: Workspace | null;
  projects: Project[];
  knownTasks: Task[];
  onOpenTask: (id: string) => void;
  onChange: () => void;
  onTaskDeleted: (id: string) => void;
}) {
  const artifacts = useResource<Artifact[]>(
    workspace ? `/v1/workspaces/${workspace.id}/artifacts` : null
  );
  const [include, setInclude] = useState('active');
  const taskPath = `/v1/tasks?limit=50&include=${include}${workspace ? `&workspaceId=${workspace.id}` : ''}`;
  const tasks = useResource<TaskPage>(taskPath);
  const [more, setMore] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const search = useResource<SearchHit[]>(
    searched
      ? `/v1/search?q=${encodeURIComponent(searched)}${workspace ? `&workspaceId=${workspace.id}` : ''}`
      : null
  );
  const shares = useResource<ShareRecord[]>('/v1/shares');
  const [editing, setEditing] = useState<Task | null>(null);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const action = useAction();
  useEffect(() => {
    setMore([]);
    setCursor(tasks.value?.nextCursor ?? null);
  }, [tasks.value]);
  const refresh = () => {
    tasks.refresh();
    artifacts.refresh();
    shares.refresh();
    onChange();
  };
  const [resultQuery, setResultQuery] = useState('');
  const [origins, setOrigins] = useState<Task[]>([]);
  const originsRef = useRef(origins);
  originsRef.current = origins;
  const [resultLimit, setResultLimit] = useState(40);
  useEffect(() => {
    const controller = new AbortController();
    const known = new Set(
      [...originsRef.current, ...knownTasks, ...(tasks.value?.tasks ?? []), ...more].map(
        (task) => task.id
      )
    );
    const missing = [
      ...new Set(
        (artifacts.value ?? [])
          .map((artifact) => artifact.taskId)
          .filter((id): id is string => Boolean(id) && !known.has(id!))
      )
    ];
    // A small queue bounds concurrent lookups when a library spans many older conversations.
    let index = 0;
    async function consume() {
      while (index < missing.length && !controller.signal.aborted) {
        const id = missing[index++]!;
        try {
          const task = await get<Task>(`/v1/tasks/${id}`, { signal: controller.signal });
          if (!controller.signal.aborted)
            setOrigins((current) => [...current.filter((item) => item.id !== id), task]);
        } catch {
          /* Deleted conversations leave their saved results accessible. */
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, missing.length) }, consume));
    return () => controller.abort();
  }, [artifacts.value, knownTasks, tasks.value, more]);
  const taskRecords = new Map(
    [...origins, ...knownTasks, ...(tasks.value?.tasks ?? []), ...more].map((task) => [
      task.id,
      task
    ])
  );
  const groups = new Map<string, { title: string; results: Map<string, Artifact[]> }>();
  for (const artifact of artifacts.value ?? []) {
    const source = artifact.taskId ? taskRecords.get(artifact.taskId) : undefined;
    const project = projects.find((project) => project.id === source?.projectId);
    const title =
      project?.title ?? source?.title ?? (artifact.taskId ? 'Conversation results' : 'Saved files');
    if (
      ![artifact.name, title, source?.title ?? ''].some((value) =>
        value.toLocaleLowerCase().includes(resultQuery.toLocaleLowerCase())
      )
    )
      continue;
    const groupId = source?.projectId ?? artifact.taskId ?? artifact.workspaceId;
    const group = groups.get(groupId) ?? { title, results: new Map<string, Artifact[]>() };
    const identity = `${artifact.taskId ?? artifact.workspaceId}:${artifact.name}`;
    group.results.set(
      identity,
      [...(group.results.get(identity) ?? []), artifact].sort(
        (a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt)
      )
    );
    groups.set(groupId, group);
  }
  return (
    <>
      <Section
        title="Saved results"
        description={
          workspace
            ? `Files published from ${workspace.name}, with their own preserved versions.`
            : 'Select a workspace to see its saved files.'
        }
      >
        <ResourceState resource={artifacts} />
        {artifacts.value?.length === 0 && (
          <p className="empty">Finished documents, images and other useful files will live here.</p>
        )}
        <Field label="Find a saved result">
          <input
            type="search"
            value={resultQuery}
            onChange={(event) => setResultQuery(event.target.value)}
            placeholder="File, project or conversation…"
          />
        </Field>
        {Array.from(groups)
          .slice(0, resultLimit)
          .map(([id, group]) => (
            <section key={id} className="library-project-results">
              <h3>{group.title}</h3>
              <div className="library-results">
                {Array.from(group.results, ([identity, versions]) => {
                  const artifact = versions[0]!;
                  const source = artifact.taskId ? taskRecords.get(artifact.taskId) : undefined;
                  return (
                    <article className="library-result" key={identity}>
                      {/^image\/(png|jpeg|gif|webp|avif)$/.test(artifact.mimeType) ? (
                        <img
                          className="library-art"
                          loading="lazy"
                          src={`/v1/artifacts/${artifact.id}/content`}
                          alt=""
                        />
                      ) : (
                        <div className="library-file-icon" aria-hidden="true">
                          {artifact.name.split('.').at(-1)?.slice(0, 5).toUpperCase() || 'FILE'}
                        </div>
                      )}
                      <div className="library-result-body">
                        <h4>{artifact.name}</h4>
                        <p className="muted management-metadata">
                          {source?.title ? `${source.title} · ` : ''}Version {artifact.version} ·{' '}
                          {bytes(artifact.sizeBytes)} · {date(artifact.createdAt)}
                        </p>
                        <div className="management-actions">
                          <Button onClick={() => setPreview(artifact)}>Open</Button>
                          <Button
                            disabled={action.busy}
                            onClick={() =>
                              void action.run(
                                () =>
                                  download(`/v1/artifacts/${artifact.id}/content`, artifact.name),
                                'Download started'
                              )
                            }
                          >
                            Download
                          </Button>
                          <details className="result-management">
                            <summary>
                              {versions.length > 1
                                ? `${versions.length} versions & actions`
                                : 'More'}
                            </summary>
                            {artifact.taskId && (
                              <Button onClick={() => onOpenTask(artifact.taskId!)}>
                                Open conversation
                              </Button>
                            )}
                            {versions.map((version) => (
                              <div className="row" key={version.id}>
                                <Button onClick={() => setPreview(version)}>
                                  Version {version.version} · {date(version.createdAt)}
                                </Button>
                                <ConfirmButton
                                  label="Delete version"
                                  description={`Delete saved result “${version.name}”, version ${version.version}. Other versions and working files remain available.`}
                                  action={async () => {
                                    await del(`/v1/artifacts/${version.id}`);
                                    artifacts.refresh();
                                  }}
                                />
                              </div>
                            ))}
                          </details>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        {groups.size > resultLimit && (
          <Button onClick={() => setResultLimit((value) => value + 40)}>
            More project results
          </Button>
        )}
        {resultQuery && !groups.size && (
          <p className="muted">No saved results match this search.</p>
        )}
        <ActionFeedback action={action} />
      </Section>
      {preview && (
        <Dialog title={preview.name} wide onClose={() => setPreview(null)}>
          <ResultPreview artifact={preview} />
          <Button
            busy={action.busy}
            onClick={() =>
              void action.run(
                () => download(`/v1/artifacts/${preview.id}/content`, preview.name),
                'Download started'
              )
            }
          >
            Download
          </Button>
          <ActionFeedback action={action} />
        </Dialog>
      )}
      <details className="settings-disclosure">
        <summary>Find and manage conversations</summary>
        <Section title="Find your work">
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              setSearched(query.trim());
            }}
          >
            <Field label="Search titles and remembered conversation content">
              <input
                type="search"
                minLength={2}
                maxLength={500}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="An idea, a phrase, a project…"
              />
            </Field>
            <Button type="submit" disabled={query.trim().length < 2}>
              Search
            </Button>
            {searched && (
              <Button
                onClick={() => {
                  setSearched('');
                  setQuery('');
                }}
              >
                Clear
              </Button>
            )}
          </form>
          {searched ? (
            <>
              <ResourceState resource={search} />
              {search.value?.map((hit) => (
                <article className="management-item" key={hit.taskId}>
                  <div>
                    <button
                      type="button"
                      className="library-task-title"
                      onClick={() => onOpenTask(hit.taskId)}
                    >
                      {hit.title}
                    </button>
                    <p className="muted">{hit.excerpt}</p>
                    <p className="management-metadata muted">{date(hit.updatedAt)}</p>
                  </div>
                </article>
              ))}
              {search.value?.length === 0 && (
                <p className="empty">No matching work. Try words you remember using.</p>
              )}
            </>
          ) : (
            <>
              <div className="library-view-toggle management-filter">
                {['active', 'archived', 'all'].map((value) => (
                  <Button
                    key={value}
                    aria-pressed={include === value}
                    onClick={() => setInclude(value)}
                  >
                    {value === 'active'
                      ? 'Current'
                      : value === 'archived'
                        ? 'Archived'
                        : 'All work'}
                  </Button>
                ))}
              </div>
              <ResourceState resource={tasks} />
              {[...(tasks.value?.tasks ?? []), ...more].map((task) => (
                <article className="management-item" key={task.id}>
                  <div>
                    <button
                      type="button"
                      className="library-task-title"
                      onClick={() => onOpenTask(task.id)}
                    >
                      {task.title}
                    </button>
                    <p className="muted management-metadata">
                      {statusLabel[task.status]} · {date(task.updatedAt)}
                      {task.scheduleId ? ' · scheduled run' : ''}
                      {task.pinned ? ' · pinned' : ''}
                    </p>
                  </div>
                  <div className="row">
                    <Button onClick={() => setEditing(task)}>Rename</Button>
                    <Button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(
                          async () => {
                            await patch(`/v1/tasks/${task.id}`, { pinned: !task.pinned });
                            refresh();
                          },
                          task.pinned ? 'Unpinned' : 'Pinned'
                        )
                      }
                    >
                      {task.pinned ? 'Unpin' : 'Pin'}
                    </Button>
                    <Button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(
                          async () => {
                            await patch(`/v1/tasks/${task.id}`, { archived: !task.archivedAt });
                            refresh();
                          },
                          task.archivedAt ? 'Restored' : 'Archived'
                        )
                      }
                    >
                      {task.archivedAt ? 'Restore' : 'Archive'}
                    </Button>
                    <ConfirmButton
                      label="Delete"
                      description={`Delete “${task.title}” and its conversation records. Archive it instead if you may want it later.`}
                      action={async () => {
                        await del(`/v1/tasks/${task.id}`);
                        onTaskDeleted(task.id);
                        refresh();
                      }}
                    />
                  </div>
                </article>
              ))}
              {tasks.value?.tasks.length === 0 && <p className="empty">No work in this view.</p>}
              {cursor && (
                <Button
                  busy={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const page = await get<TaskPage>(
                        `${taskPath}&cursor=${encodeURIComponent(cursor)}`
                      );
                      setMore((value) => [
                        ...value,
                        ...page.tasks.filter((task) => !value.some((held) => held.id === task.id))
                      ]);
                      setCursor(page.nextCursor);
                    }, 'Older work loaded')
                  }
                >
                  Load older work
                </Button>
              )}
            </>
          )}
          <ActionFeedback action={action} />
        </Section>
      </details>
      <Section
        title="Shared snapshots"
        description="Each link preserves a chosen version of the work."
      >
        <ResourceState resource={shares} />
        {shares.value?.map((share) => (
          <div className="management-item" key={share.id}>
            <div>
              <button
                type="button"
                className="library-task-title"
                onClick={() => onOpenTask(share.taskId)}
              >
                Open shared work
              </button>
              <p className="muted">
                Version {share.version} · {share.viewCount} views ·{' '}
                {share.revokedAt
                  ? 'Revoked'
                  : share.expiresAt
                    ? `expires ${date(share.expiresAt)}`
                    : 'No expiry'}
              </p>
              <p className="management-metadata muted">Created {date(share.createdAt)}</p>
            </div>
            {!share.revokedAt && (
              <ConfirmButton
                label="Revoke link"
                description="Readers will no longer be able to open this snapshot through its link. Previously downloaded copies are unaffected."
                action={async () => {
                  await del(`/v1/shares/${share.id}`);
                  shares.refresh();
                  onChange();
                }}
              />
            )}
          </div>
        ))}
        {shares.value?.length === 0 && (
          <p className="empty">Share a result from its work surface to create a snapshot.</p>
        )}
      </Section>
      {editing && (
        <Dialog title="Rename work" onClose={() => setEditing(null)}>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(async () => {
                await patch(`/v1/tasks/${editing.id}`, { title: fieldValue(form, 'title') });
                setEditing(null);
                refresh();
              }, 'Renamed');
            }}
          >
            <Field label="Title">
              <input required name="title" maxLength={160} defaultValue={editing.title} />
            </Field>
            <Button type="submit" className="primary" busy={action.busy}>
              Save title
            </Button>
            <ActionFeedback action={action} />
          </form>
        </Dialog>
      )}
    </>
  );
}
