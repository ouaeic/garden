import { useEffect, useRef, useState } from 'react';
import type {
  Connector,
  GitHubProjectAction,
  ProjectGitRemoteOperation,
  ProjectRepository
} from '@garden/contracts';
import { get, post } from './client';
import { Button, Dialog, ErrorNotice, Field } from './ui';

export function ProjectGitRemote({
  projectId,
  repository,
  revisionId,
  conversations,
  operations,
  refresh
}: {
  projectId: string;
  repository: ProjectRepository;
  revisionId: string | null;
  conversations: Array<{ id: string; title: string }>;
  operations: ProjectGitRemoteOperation[];
  refresh: () => Promise<void>;
}) {
  const latest = operations[0]?.input;
  const [expanded, setExpanded] = useState(false);
  const [accounts, setAccounts] = useState<Connector[] | null>(null);
  const [connectorId, setConnectorId] = useState(latest?.connectorId ?? '');
  const [owner, setOwner] = useState(latest?.owner ?? '');
  const [remote, setRemote] = useState(latest?.repository ?? '');
  const [branch, setBranch] = useState(latest?.branch ?? repository.branch);
  const [taskId, setTaskId] = useState(conversations[0]?.id ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [publication, setPublication] = useState<Extract<
    GitHubProjectAction,
    { action: 'github_git_push' }
  > | null>(null);
  const pending = useRef<{
    connectorId: string;
    taskId?: string;
    operation: GitHubProjectAction;
  } | null>(null);
  const selected = accounts?.find((account) => account.id === connectorId);
  const matching = operations.filter(
    (record) =>
      record.input.connectorId === connectorId &&
      record.input.owner === owner &&
      record.input.repository === remote &&
      record.input.branch === branch
  );
  const inspected = matching.find((record) => record.state === 'succeeded');
  const running = matching.some((record) => record.state === 'running');
  const unresolved =
    running ||
    matching.some(
      (record) =>
        record.state === 'uncertain' && (!inspected || record.updatedAt > inspected.updatedAt)
    );
  const publishedRevision =
    repository.initialPublication?.commit === repository.head
      ? repository.initialPublication.revisionId
      : revisionId;
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    void get<Connector[]>('/v1/connectors', { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const available = value.filter(
          (account) =>
            account.enabled &&
            account.kind === 'github' &&
            account.scopes.includes('github:repository.read')
        );
        setAccounts(available);
        setConnectorId((current) => current || available[0]?.id || '');
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [expanded]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const send = async (operation: GitHubProjectAction) => {
    const body = { connectorId, ...(taskId ? { taskId } : {}), operation };
    // A lost HTTP reply reuses the same intent; editing the destination starts a separate one.
    const identity = (value: typeof body) =>
      JSON.stringify({ ...value, operation: { ...value.operation, requestId: undefined } });
    if (!pending.current || identity(pending.current) !== identity(body)) pending.current = body;
    await post(`/v1/projects/${projectId}/git-remote`, pending.current);
    pending.current = null;
    setPublication(null);
    await refresh();
  };
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        Remote Git
        {operations.some((record) => record.state === 'running') ? ' · transfer in progress' : ''}
      </summary>
      {expanded && (
        <div className="stack project-git-remote">
          <p className="muted">
            Fetch a branch into a conversation for integration and checks, or publish a project
            version to GitHub.
          </p>
          <ErrorNotice error={error} />
          {accounts?.length === 0 && (
            <p>Add a GitHub account with repository access in Settings → Connections.</p>
          )}
          {Boolean(accounts?.length) && (
            <>
              <Field label="Connected account">
                <select
                  value={connectorId}
                  disabled={busy || !!publication}
                  onChange={(event) => setConnectorId(event.target.value)}
                >
                  {accounts!.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="row">
                <Field label="GitHub owner">
                  <input
                    value={owner}
                    maxLength={100}
                    disabled={busy || !!publication}
                    onChange={(event) => setOwner(event.target.value)}
                    placeholder="owner"
                  />
                </Field>
                <Field label="Repository">
                  <input
                    value={remote}
                    maxLength={100}
                    disabled={busy || !!publication}
                    onChange={(event) => setRemote(event.target.value)}
                    placeholder="repository"
                  />
                </Field>
              </div>
              <Field label="Remote branch">
                <input
                  value={branch}
                  maxLength={240}
                  disabled={busy || !!publication}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </Field>
              {conversations.length > 0 && (
                <Field label="Conversation for fetched history">
                  <select
                    value={taskId}
                    disabled={busy || !!publication}
                    onChange={(event) => setTaskId(event.target.value)}
                  >
                    {conversations.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div className="row">
                <Button
                  disabled={busy || !selected || !owner || !remote || !branch || running}
                  onClick={() =>
                    void run(() =>
                      send({
                        action: 'github_git_fetch',
                        repositoryId: repository.id,
                        owner,
                        repository: remote,
                        branch,
                        requestId: crypto.randomUUID()
                      })
                    )
                  }
                >
                  Fetch branch
                </Button>
                <Button
                  disabled={
                    busy ||
                    !selected?.scopes.includes('github:repository.write') ||
                    !inspected ||
                    !publishedRevision ||
                    unresolved
                  }
                  onClick={() =>
                    setPublication({
                      action: 'github_git_push',
                      repositoryId: repository.id,
                      owner,
                      repository: remote,
                      branch,
                      revisionId: publishedRevision!,
                      commit: repository.head,
                      expectedHead: inspected!.commit,
                      requestId: crypto.randomUUID()
                    })
                  }
                >
                  Publish version…
                </Button>
              </div>
              {!inspected && (
                <small>
                  Fetch first to inspect the current branch. A missing branch can then be created.
                </small>
              )}
              {selected && !selected.scopes.includes('github:repository.write') && (
                <small>
                  This connection has read access. Enable repository publishing in its connection
                  settings to publish.
                </small>
              )}
            </>
          )}
          {operations.map((record) => (
            <div className="stack project-git-transfer" key={record.input.requestId}>
              <strong>
                {record.input.owner}/{record.input.repository} · {record.input.branch}
              </strong>
              <span role="status">
                {record.input.action === 'fetch' ? 'Fetch' : 'Publish'} ·{' '}
                {record.state === 'running'
                  ? record.phase
                  : record.state === 'succeeded'
                    ? 'Complete'
                    : record.state === 'uncertain'
                      ? 'Remote inspection needed'
                      : record.state === 'rejected'
                        ? 'Remote history preserved'
                        : 'Interrupted'}
              </span>
              <small>{new Date(record.createdAt).toLocaleString()}</small>
              {record.commit && <code>{record.commit}</code>}
              {record.state === 'succeeded' && !record.commit && (
                <p>The remote branch does not exist yet.</p>
              )}
              {record.bundlePath && (
                <>
                  <small>
                    History saved in{' '}
                    {conversations.find((task) => task.id === record.taskId)?.title ??
                      'the selected conversation'}
                    :
                  </small>
                  <code>{record.bundlePath}</code>
                  <small>
                    Ask the conversation to integrate this branch and prepare a checked project
                    update.
                  </small>
                </>
              )}
              {record.detail && <p>{record.detail}</p>}
              {record.state === 'running' && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await post(
                        `/v1/projects/${projectId}/git-remote/${record.input.requestId}/cancel`,
                        {}
                      );
                      await refresh();
                    })
                  }
                >
                  Stop transfer
                </Button>
              )}
              {['uncertain', 'interrupted'].includes(record.state) && (
                <Button
                  disabled={
                    busy || !accounts?.some((account) => account.id === record.input.connectorId)
                  }
                  onClick={() =>
                    void run(async () => {
                      await post(`/v1/projects/${projectId}/git-remote`, {
                        connectorId: record.input.connectorId,
                        operation: {
                          action: 'github_git_status',
                          requestId: record.input.requestId
                        }
                      });
                      await refresh();
                    })
                  }
                >
                  {record.input.action === 'push' ? 'Inspect remote outcome' : 'Resume fetch'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {publication && (
        <Dialog
          title="Publish project version to GitHub"
          onClose={() => {
            if (!busy) setPublication(null);
          }}
        >
          <div className="stack">
            <p>
              Publish to{' '}
              <strong>
                {publication.owner}/{publication.repository}
              </strong>
              , branch <strong>{publication.branch}</strong>.
            </p>
            <code>{publication.commit}</code>
            <p>
              The selected commit and its reachable history will be sent through {selected?.label}.
              Existing remote history is preserved.
            </p>
            <small>
              {publication.expectedHead
                ? `Expected remote head: ${publication.expectedHead}`
                : 'Create this remote branch.'}
            </small>
            <ErrorNotice error={error} />
            <div className="row">
              <Button disabled={busy} onClick={() => setPublication(null)}>
                Cancel
              </Button>
              <Button
                className="primary"
                busy={busy}
                onClick={() => void run(() => send(publication))}
              >
                Publish this commit
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </details>
  );
}
