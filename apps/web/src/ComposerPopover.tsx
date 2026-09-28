import { useLayoutEffect } from 'react';
import type { ReactNode, RefObject } from 'react';
import { X } from './icons';
import { Button, Dialog } from './ui';

export const supportsPromptPopover =
  typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

export default function ComposerPopover({
  id,
  anchor,
  panel,
  open,
  onOpenChange,
  children
}: {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = anchor.current;
    if (!element || !trigger) return;
    const position = () => {
      if (!element.matches(':popover-open')) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth;
      const height = viewport?.height ?? innerHeight;
      const bounds = trigger.getBoundingClientRect();
      const margin = 12;
      const gap = 8;
      element.style.width = `${Math.min(400, width - margin * 2)}px`;
      const above = bounds.top - top - gap - margin;
      const below = top + height - bounds.bottom - gap - margin;
      const useAbove = below < element.scrollHeight && above > below;
      element.style.maxHeight = `${Math.max(0, Math.min(height - margin * 2, useAbove ? above : below))}px`;
      const size = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + margin, Math.min(bounds.right - size.width, left + width - size.width - margin))}px`;
      element.style.top = `${Math.max(top + margin, Math.min(useAbove ? bounds.top - gap - size.height : bounds.bottom + gap, top + height - size.height - margin))}px`;
      element.dataset.positioned = 'true';
    };
    const toggle = (event: ToggleEvent) => {
      const open = event.newState === 'open';
      if (open) {
        position();
        element.querySelector('select')?.focus({ preventScroll: true });
      } else delete element.dataset.positioned;
      onOpenChange(open);
    };
    element.addEventListener('toggle', toggle);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => {
      element.removeEventListener('toggle', toggle);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      observer.disconnect();
    };
  }, [anchor, panel, onOpenChange]);
  if (!supportsPromptPopover)
    return open ? (
      <Dialog
        title="Prompt settings"
        className="composer-settings-dialog"
        dismissOnBackdrop
        onClose={() => onOpenChange(false)}
      >
        {children}
      </Dialog>
    ) : null;
  return (
    <div
      ref={panel}
      id={id}
      popover="auto"
      role="dialog"
      aria-labelledby={`${id}-title`}
      className="composer-popover"
    >
      <div className="composer-popover-heading">
        <h2 id={`${id}-title`}>Prompt settings</h2>
        <Button aria-label="Close prompt settings" popoverTarget={id} popoverTargetAction="hide">
          <X size={16} />
        </Button>
      </div>
      <div className="composer-popover-body">{children}</div>
    </div>
  );
}
