import { lazy, Suspense, useState } from 'react';
import type { Artifact, Task } from '@garden/contracts';
import { del } from '../client';
import { Dialog } from '../ui';
import { ConfirmButton, Section } from '../management';
import { go } from '../app/route';
import { putTask, refreshSoon } from '../app/store';
import { toast } from '../app/toast';
import TaskOptions from '../TaskOptions';

const Sharing = lazy(() => import('../Sharing'));
const PrivateDiagnostics = lazy(() => import('../PrivateDiagnostics'));

/**
 * Everything about a goal that is not the work: its name and route, the links that share a frozen
 * copy of it, a private diagnostic capture for support, and putting it away for good.
 */
export default function GoalMore({
  task,
  artifacts,
  onClose
}: {
  task: Task;
  artifacts: Artifact[];
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <Dialog title={task.title} onClose={onClose} wide dismissOnBackdrop>
      <div className="stack goal-more">
        <Section title="Name and details">
          <TaskOptions task={task} onTask={putTask} onRefresh={refreshSoon} />
        </Section>
        <Suspense fallback={<div className="skeleton" style={{ height: 120 }} />}>
          <Section
            title="Share a copy"
            description="A frozen, encrypted copy anyone with the link can read. It never changes and never acts."
          >
            <Sharing task={task} artifacts={artifacts} onChange={refreshSoon} />
          </Section>
          <Section
            title="Private diagnostics"
            description="A sealed record of this goal's run, for when something needs explaining."
          >
            <PrivateDiagnostics taskId={task.id} />
          </Section>
        </Suspense>
        <Section
          title="Delete this goal"
          description="Its conversation and record go; files it wrote stay on your computer."
        >
          <ConfirmButton
            label={deleting ? 'Deleting…' : 'Delete goal'}
            description={`Delete “${task.title}” and its record? This cannot be undone.`}
            action={async () => {
              setDeleting(true);
              try {
                await del(`/v1/tasks/${task.id}`);
                onClose();
                go({ view: 'today' });
                refreshSoon(0);
                toast('Deleted.');
              } finally {
                setDeleting(false);
              }
            }}
          />
        </Section>
      </div>
    </Dialog>
  );
}
