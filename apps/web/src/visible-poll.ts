type Visibility = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

/** A visible view owns one request and schedules its next read after that request settles. */
export function observeVisiblePoll(
  read: (signal: AbortSignal) => Promise<unknown>,
  /** Read again after each settled request, so a response can set the pace of the next. */
  intervalMs: number | (() => number),
  onError: (cause: unknown) => void,
  visibility: Visibility = document
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | undefined;
  const run = async () => {
    if (stopped || visibility.visibilityState !== 'visible' || current) return;
    const controller = new AbortController();
    current = controller;
    try {
      await read(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause);
    } finally {
      if (current === controller) {
        current = undefined;
        if (!stopped && visibility.visibilityState === 'visible')
          timer = setTimeout(
            () => void run(),
            typeof intervalMs === 'function' ? intervalMs() : intervalMs
          );
      }
    }
  };
  const sync = () => {
    clearTimeout(timer);
    timer = undefined;
    if (visibility.visibilityState !== 'visible') {
      current?.abort();
      current = undefined;
    } else void run();
  };
  visibility.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    stopped = true;
    clearTimeout(timer);
    current?.abort();
    current = undefined;
    visibility.removeEventListener('visibilitychange', sync);
  };
}
