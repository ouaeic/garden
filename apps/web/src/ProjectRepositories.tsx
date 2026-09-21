import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectRepositories as Repositories,
  ProjectRepositoryInput,
  ProjectRepositoryHistory,
  ProjectRepositoryOperation,
  ProjectRepository
} from '@athanor/contracts';
import { apiUrl, get, post } from './client';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import { processMemory } from './process-display';

export default function ProjectRepositories({
  projectId,
  revisionId,
  conversations = [],
  active = true
}: {
  projectId: string;
  revisionId: string | null;
  conversations?: Array<{ id: string; title: string }>;
  active?: boolean;
}) {
  const endpoint = `/v1/projects/${projectId}/repositories`;
  const [data, setData] = useState<Repositories | null>(null);
  const [history, setHistory] = useState<ProjectRepositoryHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<{
    repository: ProjectRepository;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [branch, setBranch] = useState('main');
  const [historyPath, setHistoryPath] = useState('');
  const [format, setFormat] = useState<'sha1' | 'sha256'>('sha1');
  const controller = useRef<AbortController | null>(null);
  const request = useRef<ProjectRepositoryInput | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      const value = await get<Repositories>(endpoint, { signal: current.signal });
      if (!current.signal.aborted) {
        setData(value);
        setError(null);
      }
    } catch (cause) {
      if (!current.signal.aborted) setError(cause);
    }
  }, [endpoint]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    return () => {
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh, active]);
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
  const begin = async (input: ProjectRepositoryInput) => {
    await post<ProjectRepositoryOperation>(endpoint, input);
    request.current = null;
    setCreating(false);
    await refresh();
  };
  const readHistory = async (repositoryId: string, before?: string) => {
    const value = await get<ProjectRepositoryHistory>(
      `${endpoint}/${repositoryId}${before ? '?before=' + before : ''}`
    );
    setHistory((previous) =>
      before && previous?.repository.id === repositoryId
        ? { ...value, commits: [...previous.commits, ...value.commits] }
        : value
    );
  };
  return (
    <section className="project-repositories stack" aria-label="Git repositories">
      <p className="muted">
        Track source directories with Git. Each prepared update records its exact commit and the
        files its checks apply to. Publication advances the project branch. Data and artifacts can
        stay outside Git. Full-directory checkouts prepare independent conversation branches. Git
        history is retained separately from project version files.
      </p>
      <ErrorNotice error={error} />
      {!data && !error && <Spinner label="Reading repositories…" />}
      {data?.repositories.map((repository) => (
        <div className="project-repository" key={repository.id}>
          <strong>{repository.name}</strong>
          <small>
            {repository.path || 'Project root'} · {repository.branch}
          </small>
          <code title="Published branch commit">{repository.head}</code>
          {data.workingCopies
            ?.filter((copy) => copy.repositoryId === repository.id)
            .map((copy) => (
              <div className="stack" key={copy.workspaceId}>
                <small>
                  {conversations.find((task) => task.id === copy.taskId)?.title ?? 'Conversation'} ·{' '}
                  {copy.state === 'ready'
                    ? 'Independent Git working copy prepared'
                    : ['preparing', 'installing'].includes(copy.state)
                      ? 'Preparing Git working copy…'
                      : copy.state === 'cancelled'
                        ? 'Working area removed'
                        : copy.state === 'blocked'
                          ? 'Existing repository kept'
                          : 'Git setup needs attention'}
                </small>
                <code>{copy.branch}</code>
                <small>
                  Initial base <code>{copy.base}</code>
                </small>
                {copy.detail && <p className="muted">{copy.detail}</p>}
                {copy.state === 'failed' && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await post(`/v1/projects/${projectId}/updates`, {
                          taskId: copy.taskId,
                          operation: {
                            action: 'checkout',
                            paths: [`workspace/${copy.path}`],
                            revisionId: copy.revisionId,
                            gitOnly: true
                          }
                        });
                        await refresh();
                      })
                    }
                  >
                    Retry Git setup
                  </Button>
                )}
              </div>
            ))}
          <Button disabled={busy} onClick={() => void run(() => readHistory(repository.id))}>
            View history
          </Button>
          <Button
            disabled={
              busy ||
              data.exports.some(
                (item) =>
                  item.repositoryId === repository.id &&
                  item.commit === repository.head &&
                  ['preparing', 'ready'].includes(item.state)
              )
            }
            onClick={() =>
              void run(async () => {
                await post(`${endpoint}/${repository.id}/exports`, {
                  requestId: crypto.randomUUID(),
                  commit: repository.head
                });
                await refresh();
              })
            }
          >
            Prepare branch download
          </Button>
          <Button
            disabled={busy}
            onClick={() => setRemoving({ repository, requestId: crypto.randomUUID() })}
          >
            Remove Git history…
          </Button>
        </div>
      ))}
      {data?.operations
        .filter((operation) => operation.state !== 'ready')
        .map((operation) => (
          <div className="project-repository" key={operation.input.requestId}>
            <strong>{operation.input.name}</strong>
            <p role="status">
              {operation.state === 'preparing'
                ? 'Preparing repository'
                : 'Repository needs attention'}{' '}
              · {operation.files.toLocaleString()} files · {processMemory(operation.bytes)}
            </p>
            {operation.detail && <p>{operation.detail}</p>}
            {operation.state === 'failed' && (
              <Button disabled={busy} onClick={() => void run(() => begin(operation.input))}>
                Retry setup
              </Button>
            )}
          </div>
        ))}
      {data?.exports.map((item) => (
        <div className="project-repository" key={item.requestId}>
          <strong>
            {data.repositories.find((repository) => repository.id === item.repositoryId)?.name ??
              'Repository'}{' '}
            · branch download
          </strong>
          <code>{item.commit}</code>
          <p role="status">
            {item.state === 'preparing'
              ? 'Preparing full branch history…'
              : item.state === 'ready'
                ? processMemory(item.bytes)
                : 'Download preparation needs attention'}
          </p>
          {item.detail && <p>{item.detail}</p>}
          {item.state === 'ready' && (
            <a
              className="button"
              href={apiUrl(
                `/v1/projects/${projectId}/repository-exports/${item.requestId}/download`
              )}
              download
            >
              Download Git bundle
            </a>
          )}
          {item.state === 'failed' && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await post(`${endpoint}/${item.repositoryId}/exports`, {
                    requestId: item.requestId,
                    commit: item.commit
                  });
                  await refresh();
                })
              }
            >
              Retry download preparation
            </Button>
          )}
          {item.state !== 'preparing' && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await post(
                    `/v1/projects/${projectId}/repository-exports/${item.requestId}/remove`,
                    {}
                  );
                  await refresh();
                })
              }
            >
              Remove prepared download
            </Button>
          )}
          <small>
            The bundle contains this branch’s files and complete reachable history. Import it with
            Git on another machine. Removing the download keeps the repository.
          </small>
        </div>
      ))}
      {data?.removals
        .filter((item) => item.state !== 'removed')
        .map((item) => (
          <div className="project-repository" key={item.requestId}>
            <strong>{item.name}</strong>
            <p role="status">
              {item.state === 'removing'
                ? 'Removing managed Git history…'
                : 'Git history removal needs attention'}
            </p>
            {item.detail && <p>{item.detail}</p>}
            {item.state === 'failed' && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await post(`${endpoint}/${item.repositoryId}/remove`, {
                      requestId: item.requestId,
                      head: item.head
                    });
                    await refresh();
                  })
                }
              >
                Resume removal
              </Button>
            )}
          </div>
        ))}
      {removing && (
        <Dialog
          title={`Remove Git history for ${removing.repository.name}`}
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <div className="stack">
            <p>
              This permanently removes this managed repository’s Git objects, branches and proposal
              references.
            </p>
            <p>
              Project versions, conversation files, their Git copies and prepared downloads remain
              available. Unpublished updates must be rebuilt before publishing again.
            </p>
            <code>{removing.repository.head}</code>
            <ErrorNotice error={error} />
            <div className="row">
              <Button disabled={busy} onClick={() => setRemoving(null)}>
                Keep Git history
              </Button>
              <Button
                className="danger"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await post(`${endpoint}/${removing.repository.id}/remove`, {
                      requestId: removing.requestId,
                      head: removing.repository.head
                    });
                    setRemoving(null);
                    setHistory(null);
                    await refresh();
                  })
                }
              >
                Permanently remove Git history
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {!creating && (
        <Button disabled={!revisionId || busy} onClick={() => setCreating(true)}>
          Add source repository
        </Button>
      )}
      {!revisionId && <p className="muted">Publish source files before adding a repository.</p>}
      {creating && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!revisionId) return;
            const fields = {
              revisionId,
              name,
              path: source,
              branch,
              format,
              ...(historyPath ? { historyPath } : {})
            };
            if (
              !request.current ||
              JSON.stringify({ ...request.current, requestId: undefined }) !==
                JSON.stringify(fields)
            )
              request.current = { requestId: crypto.randomUUID(), ...fields };
            const input = request.current;
            void run(() => begin(input));
          }}
        >
          <Field label="Repository name">
            <input
              required
              maxLength={120}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label="Published source directory"
            hint="Relative to the project. Leave blank to include the published project root."
          >
            <input
              value={source}
              disabled={busy}
              onChange={(event) => setSource(event.target.value)}
              placeholder="src"
            />
          </Field>
          <details>
            <summary>History and branch options</summary>
            <div className="stack">
              <Field label="Branch">
                <input
                  required
                  maxLength={240}
                  value={branch}
                  disabled={busy}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </Field>
              <Field
                label="Existing history bundle (optional)"
                hint="Path to a complete .bundle file in this published version. Its history is retained; the selected source files become the branch contents."
              >
                <input
                  value={historyPath}
                  disabled={busy}
                  onChange={(event) => setHistoryPath(event.target.value)}
                  placeholder="history.bundle"
                />
              </Field>
              <Field label="Git object format">
                <select
                  value={format}
                  disabled={busy}
                  onChange={(event) => setFormat(event.target.value as 'sha1' | 'sha256')}
                >
                  <option value="sha1">SHA-1 · widest Git compatibility</option>
                  <option value="sha256">SHA-256</option>
                </select>
              </Field>
              <p className="muted">
                For an existing repository, create a complete bundle with{' '}
                <code>git bundle create history.bundle --all</code> and include it in the published
                version. Match its object format. Setup stays on this server.
              </p>
            </div>
          </details>
          <div className="row">
            <Button type="submit" className="primary" busy={busy}>
              Create repository
            </Button>
            <Button disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {history && (
        <section className="stack" aria-label={`${history.repository.name} history`}>
          <div className="row">
            <strong>
              {history.repository.name} · {history.repository.branch}
            </strong>
            <Button onClick={() => setHistory(null)}>Close history</Button>
          </div>
          <ol className="project-git-history">
            {history.commits.map((commit) => (
              <li key={commit.id}>
                <strong>{commit.subject}</strong>
                <small>{new Date(commit.date).toLocaleString()}</small>
                <code>{commit.id}</code>
                {commit.parents.length > 1 && (
                  <small>Integrated with preserved proposal history</small>
                )}
              </li>
            ))}
          </ol>
          {history.next && (
            <Button
              disabled={busy}
              onClick={() => void run(() => readHistory(history.repository.id, history.next!))}
            >
              Earlier commits
            </Button>
          )}
          <details>
            <summary>Branch and proposal references</summary>
            <ul className="project-git-history">
              {history.branches.map((ref) => (
                <li key={ref.name}>
                  <span>{ref.name}</span>
                  <code>{ref.commit}</code>
                </li>
              ))}
            </ul>
            {history.branchesTruncated && (
              <p>
                More references exist than this display shows. The repository retains all of them.
              </p>
            )}
          </details>
        </section>
      )}
    </section>
  );
}
