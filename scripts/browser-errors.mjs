/**
 * WebKit can report handled fetch cancellations as page diagnostics without a window error. A
 * worker script cut off by a navigation reads the same way; against the page's own origin no
 * access control check can refuse a load, so there the wording only ever means the load was
 * cancelled.
 */
export async function captureBrowserErrors(page, failures) {
  const diagnostics = [];
  const webkit = page.context().browser()?.browserType().name() === 'webkit';
  const ownOrigin = (text) => {
    try {
      return text.includes(`/${new URL(page.url()).host}/`);
    } catch {
      return false;
    }
  };
  page.on('pageerror', (error) => {
    const first = error.stack?.split('\n')[0] ?? '';
    const handledFetchDiagnostic =
      webkit &&
      [first, error.message].some((line) => line.endsWith(' due to access control checks.')) &&
      (first.startsWith('Fetch API cannot load ') || ownOrigin(error.message));
    diagnostics.push({ message: error.message, stack: error.stack, handledFetchDiagnostic });
    if (handledFetchDiagnostic) console.log(`WebKit fetch diagnostic: ${error.message}`);
    if (!handledFetchDiagnostic) failures.push(error.message);
  });
  page.on('console', (message) => {
    if (message.text().startsWith('garden-uncaught:')) failures.push(message.text());
  });
  await page.addInitScript(() => {
    addEventListener('error', (event) => {
      if (event.message) console.debug(`garden-uncaught:error:${event.message}`);
    });
    addEventListener('unhandledrejection', (event) =>
      console.debug(`garden-uncaught:rejection:${event.reason}`)
    );
  });
  return diagnostics;
}
