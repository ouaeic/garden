/**
 * The listing a turn opens with, made by the harness instead of by a model round trip.
 *
 * Almost every task starts by looking at the working directory, and at any folder the request
 * points at. Doing that before the first request saves a full request - its uncached input, its
 * output and its latency.
 *
 * Listings, not file contents. Handed the files a request names before it had run anything, the
 * model tried to solve the whole task in its first reply: on an algorithmic task that first reply
 * ran to 21K-86K tokens of thinking, where opening on the listing alone it was under a hundred and
 * the thinking came after it had looked. On routine tasks reading the files up front saved nothing
 * (DeepSeek V4.1 Flash on Ollama at high effort, five routine tasks and two hard ones).
 */
import type { ModelMessage, ModelToolCall } from '@garden/model-gateway';

/** Enough for a request that names a handful of folders; a long list is better left to the model. */
const MAX_OPENING_LISTINGS = 6;

/** A directory written with a trailing slash, the way requests point at folders. */
const DIRECTORY = /(?:^|[\s`'"([])((?:~|\.{1,2})?\/(?:[\w.-]+\/)+)(?=$|[\s`'")>\].,;:!?])/g;

const requestText = (messages: readonly ModelMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
};

/** The opening calls for this turn's request: the working directory, then any folder it names. */
export const openingCalls = (messages: readonly ModelMessage[], turn: number): ModelToolCall[] => {
  const directories = [
    ...new Set([...requestText(messages).matchAll(DIRECTORY)].map((match) => match[1]!))
  ];
  const calls: ModelToolCall[] = [{ id: `opening-${turn}-0`, name: 'files_list', arguments: {} }];
  for (const path of directories.slice(0, MAX_OPENING_LISTINGS))
    calls.push({ id: `opening-${turn}-${calls.length}`, name: 'files_list', arguments: { path } });
  return calls;
};
