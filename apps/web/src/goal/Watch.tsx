import { lazy, Suspense, useState } from 'react';

const Screen = lazy(() => import('../computer/Screen'));
const Terminal = lazy(() => import('../computer/Terminal'));

type Surface = 'browser' | 'desktop' | 'terminal';

/** The computer, live, in a window that floats over the goal while the owner reads it. */
export default function Watch({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const [surface, setSurface] = useState<Surface>('browser');
  return (
    <div className="watch-body">
      <div className="seg" role="group" aria-label="What to watch">
        {(['browser', 'desktop', 'terminal'] as const).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={surface === name}
            onClick={() => setSurface(name)}
          >
            {name[0]!.toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      <div className="watch-stage">
        <Suspense fallback={<div className="watch-loading">Connecting…</div>}>
          {surface === 'terminal' ? (
            <Terminal workspaceId={workspaceId} visible />
          ) : (
            <Screen key={surface} workspaceId={workspaceId} surface={surface} taskId={taskId} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
