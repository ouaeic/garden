import type { ReactNode } from 'react';
import { Activity, Folder, SlidersHorizontal } from './icons';
import { Button, Dialog } from './ui';
import { closeProjectPanel, useProjectView } from './surface-location';

const panels = [
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'tools', label: 'Tools', icon: SlidersHorizontal }
] as const;

export function ProjectPanelLinks({ inside = false }: { inside?: boolean }) {
  const [view, selectView] = useProjectView();
  return (
    <nav className="project-view-nav" aria-label={inside ? 'Panel sections' : 'Project panels'}>
      {panels.map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          aria-current={view === id ? 'true' : undefined}
          {...(!inside ? { 'aria-haspopup': 'dialog' as const } : {})}
          onClick={() => selectView(id)}
        >
          <Icon size={15} />
          {label}
        </Button>
      ))}
    </nav>
  );
}

/** Keep editors and terminal state mounted while the desk remains the navigation anchor. */
export default function ProjectPanel({ scope, children }: { scope: string; children: ReactNode }) {
  const [view] = useProjectView();
  return (
    <Dialog
      title={scope}
      open={view !== 'work'}
      wide
      className={`desk-sheet project-panel project-panel-${view}`}
      dismissOnBackdrop
      onClose={closeProjectPanel}
    >
      <ProjectPanelLinks inside />
      <div className="project-panel-content">{children}</div>
    </Dialog>
  );
}
