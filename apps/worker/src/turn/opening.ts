/**
 * The reads a turn opens with, made by the harness instead of by a model round trip.
 *
 * Almost every task starts the same way: list the working directory and read the files the request
 * names. Doing that before the first request means the model starts with the material in front of
 * it, and the turn saves a full request - its uncached input, its output and its latency.
 */
import type { ModelMessage, ModelToolCall } from '@garden/model-gateway';

/** Enough for a request that names a handful of files; a long list is better left to the model. */
const MAX_OPENING_READS = 6;

/** A path as people write it in a request: absolute, home- or dot-relative, or a bare file name. */
const PATH =
  /(?:^|[\s`'"([])((?:~|\.{1,2})?\/?(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s`'")>\].,;:!?])/g;
/** A directory written with a trailing slash, the way requests point at folders. */
const DIRECTORY = /(?:^|[\s`'"([])((?:~|\.{1,2})?\/(?:[\w.-]+\/)+)(?=$|[\s`'")>\].,;:!?])/g;

const requestText = (messages: readonly ModelMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
};

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

/** The opening calls for this turn's request, or none when it names nothing to read. */
export const openingCalls = (messages: readonly ModelMessage[], turn: number): ModelToolCall[] => {
  const text = requestText(messages);
  // A file named by path. A bare dotted word - `np.float64`, `example.com` - is as likely prose,
  // and the listing already shows the files at the top of the folder.
  const files = unique([...text.matchAll(PATH)].map((match) => match[1]!)).filter((path) =>
    path.includes('/')
  );
  const directories = unique([...text.matchAll(DIRECTORY)].map((match) => match[1]!)).filter(
    (directory) => !files.some((file) => file.startsWith(directory))
  );
  const calls: ModelToolCall[] = [{ id: `opening-${turn}-0`, name: 'files_list', arguments: {} }];
  for (const path of [...directories, ...files].slice(0, MAX_OPENING_READS))
    calls.push({
      id: `opening-${turn}-${calls.length}`,
      name: path.endsWith('/') ? 'files_list' : 'file_read',
      arguments: { path }
    });
  return calls;
};
