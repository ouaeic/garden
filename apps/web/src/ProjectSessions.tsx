import ScrollRegion from './ScrollRegion';
import { useEffect, useState } from 'react';
import type { ProjectSessions as Sessions } from '@athanor/contracts';
import { get } from './client';
import { Button, ErrorNotice, Spinner } from './ui';

export default function ProjectSessions({
  projectId,
  onOpen
}: {
  projectId: string;
  onOpen: (taskId: string, surface: 'browser' | 'desktop', tabId?: string) => void;
}) {
  const [value, setValue] = useState<Sessions | null>(null),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const abort = new AbortController();
    setValue(null);
    setError(null);
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const result = await get<Sessions>(`/v1/projects/${projectId}/sessions`, {
          signal: abort.signal
        });
        if (!abort.signal.aborted) {
          setValue(result);
          setError(null);
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [projectId]);
  const active = value?.sessions.filter((session) => session.browser || session.desktop) ?? [];
  return (
    <section className="project-sessions" aria-label="Project browser and desktop">
      <h2>Browser & desktop</h2>
      <p className="muted">
        Each conversation has its own browser profile and desktop. Taking control pauses computer
        actions in that conversation.
      </p>
      {!value && !error && <Spinner />}
      <ErrorNotice error={error} />
      {value && !active.length && (
        <p className="muted">No open computer sessions in this project.</p>
      )}
      <ScrollRegion label="Open project sessions" resetKey={projectId}>
        {active.map((session) => (
          <article className="project-session" key={session.workspaceId}>
            <h3>{session.title}</h3>
            {session.browser && (
              <div className="stack">
                <span className="muted">
                  Browser ·{' '}
                  {session.browser.holder === 'agent'
                    ? 'Agent has control'
                    : session.browser.holder === 'secure_input'
                      ? 'Private input — tabs hidden'
                      : 'You have control'}
                </span>
                {session.browser.tabs.map((tab) => (
                  <Button
                    key={tab.tabId}
                    onClick={() => onOpen(session.taskId, 'browser', tab.tabId)}
                    title={tab.url}
                  >
                    <span>
                      {tab.title || 'Untitled tab'}
                      <small>{tab.url}</small>
                    </span>
                    <span>{tab.active ? 'Active · ' : ''}Open tab</span>
                  </Button>
                ))}
                <Button onClick={() => onOpen(session.taskId, 'browser')}>View browser</Button>
              </div>
            )}
            {session.desktop && (
              <div className="stack">
                <Button onClick={() => onOpen(session.taskId, 'desktop')}>Open desktop</Button>
                {session.desktop.windows.map((window) => (
                  <span key={window.id}>{window.name || window.role}</span>
                ))}
              </div>
            )}
          </article>
        ))}
      </ScrollRegion>
      {Boolean(value?.unavailableWorkspaces) && (
        <p role="status">
          Some sessions are unavailable or use a shared legacy workspace. Only isolated project
          sessions are shown.
        </p>
      )}
    </section>
  );
}
