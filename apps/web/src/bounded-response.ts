import { responseError } from './client';

/** Bound streamed bytes independently of a missing or inaccurate Content-Length. */
export async function readBoundedText(
  response: Response,
  limit: number,
  messages: { tooLarge: string; empty: string }
): Promise<string> {
  if (!response.ok) throw await responseError(response);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error(messages.tooLarge);
  }
  if (!response.body) throw new Error(messages.empty);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(messages.tooLarge);
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
