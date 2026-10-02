import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, Folder, SlidersHorizontal } from './icons';
import { Button, Dialog } from './ui';
import { closeProjectPanel, useProjectView } from './surface-location';
import { usePhoneLayout } from './use-phone-layout';

const panels = [
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'tools', label: 'Tools', icon: SlidersHorizontal }
] as const;

export function ProjectPanelLinks({ inside = false }: { inside?: boolean }) {
  const [view, selectView] = useProjectView();
  const phone = usePhoneLayout();
  return (
    <nav className="project-view-nav" aria-label={inside ? 'Panel sections' : 'Project panels'}>
      {panels.map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          aria-current={view === id ? 'true' : undefined}
          {...(!inside && !phone ? { 'aria-haspopup': 'dialog' as const } : {})}
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
const DOCK_QUERY = '(min-width: 1100px) and (min-height: 600px)';
/** Wide screens dock the panel beside the work; narrow ones give it the whole screen. */
export function useDockedPanels() {
  const [docked, setDocked] = useState(() => matchMedia(DOCK_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(DOCK_QUERY);
    const update = () => setDocked(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return docked;
}

export default function ProjectPanel({ scope, children }: { scope: string; children: ReactNode }) {
  const [view] = useProjectView();
  const phone = usePhoneLayout();
  const dockable = useDockedPanels();
  const content = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(dockable);
  const open = view !== 'work';
  // Follow the screen, except while another dialog is showing: switching the panel between
  // docked and modal would re-stack it above that dialog.
  useEffect(() => {
    const own = content.current?.closest('dialog');
    const others = () =>
      [...document.querySelectorAll('dialog[open]')].some((dialog) => dialog !== own);
    if (!others()) setDocked(dockable);
    const settle = () => {
      if (!others()) setDocked(matchMedia(DOCK_QUERY).matches);
    };
    document.addEventListener('close', settle, true);
    return () => document.removeEventListener('close', settle, true);
  }, [dockable, open]);
  // A docked panel is not modal, so focus is usually outside it; Escape still closes it.
  useEffect(() => {
    if (!open || !docked) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A modal, a popover or a pending comment takes Escape first.
      if (document.querySelector('dialog[open]:modal, :popover-open, .note-popover')) return;
      closeProjectPanel();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open, docked]);
  return (
    <Dialog
      title={scope}
      page={phone}
      open={open}
      wide
      modal={!docked}
      className={`desk-sheet project-panel project-panel-${view}${docked ? ' is-docked' : ''}`}
      dismissOnBackdrop={!docked}
      onClose={closeProjectPanel}
    >
      {/* Docked, the panel sits beside the bar that already carries these. */}
      {!docked && <ProjectPanelLinks inside />}
      <div className="project-panel-content" ref={content}>
        {children}
      </div>
    </Dialog>
  );
}
