import type { TaskEvent, TaskResult } from '@garden/contracts';
import { data, text } from './model';

/** A preview image must be a raster observed at this registered result, not an arbitrary model URL. */
export function resultSnapshot(
  result: TaskResult,
  events: readonly TaskEvent[],
  taskId: string
): { src: string; eventId: string; createdAt: string } | null {
  if (!result.url || result.kind !== 'preview') return null;
  let expected: URL;
  try {
    expected = new URL(result.url);
  } catch {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event || event.taskId !== taskId || event.kind !== 'tool_result') continue;
    const observed = data(data(event.payload).result);
    if (observed.holder === 'secure_input' || observed.error) continue;
    let url: URL;
    try {
      url = new URL(text(observed.url));
    } catch {
      continue;
    }
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) continue;
    const raster = text(observed.screenshotBase64);
    if (raster.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raster)) continue;
    const mime = raster.startsWith('/9j/')
      ? 'image/jpeg'
      : raster.startsWith('iVBORw0KGgo')
        ? 'image/png'
        : null;
    if (mime)
      return {
        src: `data:${mime};base64,${raster}`,
        eventId: event.id,
        createdAt: event.createdAt
      };
  }
  return null;
}
