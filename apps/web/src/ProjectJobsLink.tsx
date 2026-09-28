import { useEffect, useState } from 'react';
import type { ProcessList } from '@garden/contracts';
import { get } from './client';
import { processActive } from './process-display';
import { Button } from './ui';
import { useProjectView } from './surface-location';

export default function ProjectJobsLink({
  projectId,
  onOpen
}: {
  projectId: string;
  onOpen: () => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [view] = useProjectView();
  useEffect(() => {
    if (view !== 'work') return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const list = await get<ProcessList>(`/v1/projects/${projectId}/processes`, {
          signal: controller.signal
        });
        if (!controller.signal.aborted)
          setCount(
            list.processes.filter(processActive).length +
              (list.computationSessions?.filter(
                (session) => session.state === 'busy' || session.state === 'starting'
              ).length ?? 0)
          );
      } catch {
        if (!controller.signal.aborted) setCount(null);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 120_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [projectId, view]);
  return count ? (
    <Button className="project-jobs-link" onClick={onOpen}>
      {count} {count === 1 ? 'job' : 'jobs'} running
    </Button>
  ) : null;
}
