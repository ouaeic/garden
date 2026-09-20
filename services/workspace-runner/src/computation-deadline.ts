const TIMER_CHUNK_MS = 2_147_483_647;

export function computationDeadline(start: number, seconds: number): number {
  const deadline = start + seconds * 1000;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    !Number.isSafeInteger(deadline) ||
    !Number.isFinite(new Date(deadline).getTime())
  )
    throw Error('Computation duration exceeds the supported calendar range');
  return deadline;
}

/** Long deadlines must not overflow Node's signed 32-bit timer delay and fire immediately. */
export function scheduleComputationDeadline(
  deadline: number,
  expire: () => void,
  now: () => number = Date.now
): () => void {
  if (!Number.isFinite(deadline)) throw Error('Computation deadline must be finite');
  let timer: NodeJS.Timeout;
  let cancelled = false;
  const arm = () => {
    timer = setTimeout(
      () => {
        if (cancelled) return;
        if (now() < deadline) arm();
        else {
          cancelled = true;
          expire();
        }
      },
      Math.max(1, Math.min(TIMER_CHUNK_MS, deadline - now()))
    );
    timer.unref();
  };
  arm();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
