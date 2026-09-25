import { useEffect, useRef, useState } from 'react';
import type { ComputationSession } from '@athanor/contracts';
import { post } from './client';
import { ErrorNotice } from './ui';
import { ComputationCard } from './computer/Computation';

export default function ProjectComputations({
  sessions,
  onChange
}: {
  sessions: ComputationSession[];
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
      <ErrorNotice error={error} />
      {sessions.map((session) => (
        <ComputationCard
          key={`${session.workspaceId}/${session.sessionId}`}
          session={session}
          busy={busy !== null}
          onControl={(action) => void control(session, action)}
        />
      ))}
    </section>
  );
}
