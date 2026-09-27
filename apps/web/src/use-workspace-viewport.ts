import { useEffect } from 'react';

/** The visual viewport shrinks for a keyboard even when the layout viewport does not. */
export function useWorkspaceViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--garden-viewport-height', `${height}px`);
        document.documentElement.dataset.workspaceShort = String(height < 540);
      });
    };
    update();
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--garden-viewport-height');
      delete document.documentElement.dataset.workspaceShort;
    };
  }, []);
}
