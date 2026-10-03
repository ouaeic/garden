import { lazy, Suspense, useEffect, useState } from 'react';
import type { ConversationSource, Project, Task, Workspace } from '@garden/contracts';
import { get } from './client';
import type { Bootstrap, Draft } from './model';
import { Dialog, ErrorNotice, Spinner } from './ui';
const Composer = lazy(() => import('./Composer'));

export default function NewConversation({
  project,
  source,
  bootstrap,
  draft,
  onDraft,
  onSent,
  onClose
}: {
  project: Project;
  source?: ConversationSource;
  bootstrap: Bootstrap;
  draft?: Draft;
  onDraft: (draft: Draft) => void;
  onSent: (task: Task) => void;
  onClose: () => void;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [error, setError] = useState<unknown>(null);
  // In the project's own folder unless the owner wants a parallel attempt kept apart from it.
  const [separate, setSeparate] = useState(false);
  const selectedSource =
    source ??
    (draft?.controls?.conversation?.projectId === project.id
      ? draft.controls.conversation.source
      : undefined);
  useEffect(() => {
    const controller = new AbortController();
    void get<Workspace>(`/v1/workspaces/${project.workspaceId}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setWorkspace(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [project.workspaceId]);
  return (
    <Dialog title="New conversation" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          In {project.title}
          {selectedSource ? ' · Selected context will be linked to this conversation.' : ''}
        </p>
        {selectedSource?.result && (
          <p className="project-source-reference">
            <strong>{selectedSource.result.title}</strong>
            {selectedSource.result.version ? ` · version ${selectedSource.result.version}` : ''}
            {selectedSource.result.sha256 && (
              <small> SHA-256 {selectedSource.result.sha256.slice(0, 12)}…</small>
            )}
          </p>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={separate}
            onChange={(event) => setSeparate(event.target.checked)}
          />
          Work on a separate copy
        </label>
        <p className="muted">
          {separate
            ? 'For a parallel attempt: it starts from the project’s files and changes them only when its update passes its checks.'
            : 'Works in the project folder, with the same files as its other conversations.'}
        </p>
        <ErrorNotice error={error} />
        {workspace ? (
          <Suspense fallback={<Spinner />}>
            <Composer
              workspace={workspace}
              bootstrap={bootstrap}
              project={project}
              execution={separate ? 'independent' : 'shared'}
              {...(selectedSource ? { source: selectedSource } : {})}
              {...(draft ? { initialDraft: draft } : {})}
              onDraft={onDraft}
              onSent={onSent}
            />
          </Suspense>
        ) : (
          !error && <Spinner />
        )}
      </div>
    </Dialog>
  );
}
