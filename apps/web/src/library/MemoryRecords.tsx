import ScrollRegion from '../ScrollRegion.js';
import { useState } from 'react';
import type { MemoryItemBody, Project } from '@garden/contracts';
import { del, get, post } from '../client.js';
import { Button, Dialog } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  useAction,
  useResource
} from '../management.js';
import { date } from '../model.js';

interface RecordItem {
  id: string;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  kind: string;
  status: string;
  excerpt: string;
  observedAt: string;
  validTo: string | null;
  lastVerified: string | null;
}
interface Page {
  items: RecordItem[];
  nextCursor: string | null;
}
const labels: Record<string, string> = {
  episode: 'Work history',
  fact: 'Learned fact',
  procedure: 'Procedure'
};

export function MemoryRecords({
  workspaceId,
  projects,
  onOpenTask,
  onChange
}: {
  workspaceId: string;
  projects: Project[];
  onOpenTask: (id: string) => void;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [kind, setKind] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [opened, setOpened] = useState<MemoryItemBody | null>(null);
  const action = useAction();
  const params = new URLSearchParams({ limit: '40' });
  if (query) params.set('q', query);
  if (scope) params.set('scope', scope);
  if (kind) params.set('kind', kind);
  if (cursors.length) params.set('cursor', cursors.at(-1)!);
  const resource = useResource<Page>(`/v1/workspaces/${workspaceId}/memory-library?${params}`);
  const refresh = () => {
    resource.refresh();
    onChange();
  };
  return (
    <Section
      title="Memory record"
      description="Search what Garden retained across your goals. History records what happened; learned facts and procedures can help later work."
    >
      <form
        className="memory-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
          setCursors([]);
        }}
      >
        <input
          aria-label="Search memory"
          type="search"
          placeholder="Search memories…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit">Search</Button>
        <select
          aria-label="Whose memory"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
            setCursors([]);
          }}
        >
          <option value="">All goals</option>
          <option value={workspaceId}>Shared memory</option>
          {projects.map((project) => (
            <option key={project.id} value={project.workspaceId}>
              {project.title}
            </option>
          ))}
        </select>
        <select
          aria-label="Memory type"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
            setCursors([]);
          }}
        >
          <option value="">All types</option>
          <option value="fact">Learned facts</option>
          <option value="procedure">Procedures</option>
          <option value="episode">Work history</option>
        </select>
      </form>
      <ResourceState resource={resource} />
      <ScrollRegion
        className="memory-record-list"
        label="Memory records"
        resetKey={`${query}:${scope}:${kind}:${cursors.at(-1) ?? ''}`}
      >
        {resource.value?.items.map((item) => {
          const root = `/v1/workspaces/${item.workspaceId}/memory-items/${item.id}`;
          const project = projects.find((project) => project.id === item.projectId);
          const expired = item.validTo && Date.parse(item.validTo) <= Date.now();
          return (
            <article className="management-item" key={item.id}>
              <div>
                <p>{item.excerpt}</p>
                <p className="muted management-metadata">
                  {labels[item.kind] ?? item.kind} ·{' '}
                  {project?.title ??
                    (item.workspaceId === workspaceId ? 'Shared memory' : 'Goal memory')}{' '}
                  · {expired && item.status === 'active' ? 'expired' : item.status} ·{' '}
                  {date(item.observedAt)}
                </p>
                {item.taskId && (
                  <Button onClick={() => onOpenTask(item.taskId!)}>Source conversation</Button>
                )}
              </div>
              <div className="row">
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => setOpened(await get<MemoryItemBody>(root)), '')
                  }
                >
                  Read
                </Button>
                {item.status === 'active' && item.kind !== 'episode' && (
                  <ConfirmButton
                    label="Retract"
                    description="Keep the record, but stop treating it as current knowledge. Conversations refresh their recalled memory when they resume."
                    action={async () => {
                      await post(`${root}/retract`);
                      refresh();
                    }}
                  />
                )}
                <ConfirmButton
                  label="Forget"
                  description="Delete this memory and its retained source chunks. Conversation history itself is kept."
                  action={async () => {
                    await del(root);
                    refresh();
                  }}
                />
              </div>
            </article>
          );
        })}
        {resource.value?.items.length === 0 && (
          <p className="empty">No memories match this view.</p>
        )}
      </ScrollRegion>
      <div className="memory-pagination">
        <Button
          disabled={resource.loading || !cursors.length}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Previous
        </Button>
        <span className="muted">Page {cursors.length + 1}</span>
        <Button
          disabled={resource.loading || !resource.value?.nextCursor}
          onClick={() => setCursors([...cursors, resource.value!.nextCursor!])}
        >
          Next
        </Button>
      </div>
      <ActionFeedback action={action} />
      {opened && (
        <Dialog title={opened.title || 'Memory record'} onClose={() => setOpened(null)} wide>
          {!opened.readable && (
            <p role="alert" className="error">
              This memory could not be decrypted.
            </p>
          )}
          <div className="library-document">{opened.body}</div>
        </Dialog>
      )}
    </Section>
  );
}
