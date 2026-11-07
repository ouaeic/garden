/**
 * The views a result opens into, fetched while the owner is still looking at the desk. Opening one
 * then waits on nothing the desk did not already have; on a slow link the first open was otherwise
 * a blank stage for as long as its code took to arrive.
 */
export function prefetchViews() {
  const idle = (run: () => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1500);
  };
  idle(() => {
    void import('../goal/Goal').catch(() => undefined);
    void import('../goal/Inspect').catch(() => undefined);
    void import('../computer/PdfPreview').catch(() => undefined);
    void import('../MarkdownBody').catch(() => undefined);
    void import('../library/LibraryView').catch(() => undefined);
  });
}
