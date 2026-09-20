import { useEffect, useRef, useState } from 'react';
import type { ComputationSession } from '@athanor/contracts';
import { post } from './client';
import { Button, ErrorNotice } from './ui';
import { ComputationCard } from './computer/Computation';
import { computationActive } from './process-display';

export default function ProjectComputations({
  sessions,
  onChange
}: {
  sessions: ComputationSession[];
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [history, setHistory] = useState(false);
  const [limit, setLimit] = useState(10);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = sessions.filter((session) => computationActive(session.state));
  const finished = sessions.filter((session) => !computationActive(session.state));
  const control = async (session: ComputationSession, action: 'interrupt' | 'stop') => {
    setBusy(session.sessionId);
    setError(null);
    try {
      await post(
        `/v1/workspaces/${session.workspaceId}/computation/${encodeURIComponent(session.sessionId)}/control`,
        { action }
      );
      if (mounted.current) await onChange();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <section className="project-computations" aria-label="Project computation sessions">
      <h3>Analysis sessions</h3>
      <ErrorNotice error={error} />
      {[...active, ...(history ? finished.slice(0, limit) : [])].map((session) => (
        <ComputationCard
          key={`${session.workspaceId}/${session.sessionId}`}
          session={session}
          busy={busy !== null}
          onControl={(action) => void control(session, action)}
        />
      ))}
      {finished.length > 0 && (
        <Button
          aria-expanded={history}
          onClick={() => {
            setHistory((value) => !value);
            setLimit(10);
          }}
        >
          {history ? 'Hide ended sessions' : `Show ended sessions (${finished.length})`}
        </Button>
      )}
      {history && limit < finished.length && (
        <Button onClick={() => setLimit((value) => value + 10)}>Show earlier sessions</Button>
      )}
    </section>
  );
}
