/** WebKit can report handled fetch cancellations as page diagnostics without a window error. */
export async function captureBrowserErrors(page, failures) {
  const diagnostics = [];
  const webkit = page.context().browser()?.browserType().name() === 'webkit';
  page.on('pageerror', (error) => {
    const handledFetchDiagnostic =
      webkit &&
      error.stack?.startsWith('Fetch API cannot load ') &&
      error.stack.split('\n')[0].endsWith(' due to access control checks.');
    diagnostics.push({ message: error.message, stack: error.stack, handledFetchDiagnostic });
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
