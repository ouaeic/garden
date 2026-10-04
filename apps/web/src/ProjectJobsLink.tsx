import { useProcessFeed } from './process-feed';
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
  const [view] = useProjectView();
  const { list } = useProcessFeed(view === 'work' ? `/v1/projects/${projectId}/processes` : null);
  const count = list
    ? list.processes.filter(processActive).length +
      (list.computationSessions?.filter(
        (session) => session.state === 'busy' || session.state === 'starting'
      ).length ?? 0)
    : null;
  return count ? (
    <Button className="project-jobs-link" onClick={onOpen}>
      {count} {count === 1 ? 'job' : 'jobs'} running
    </Button>
  ) : null;
}
