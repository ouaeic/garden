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
        // A visual viewport well short of the window means an on-screen keyboard is up.
        document.documentElement.dataset.keyboard = String(height < window.innerHeight - 120);
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
      delete document.documentElement.dataset.keyboard;
    };
  }, []);
}
