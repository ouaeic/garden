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

/** Files a text read cannot show, which a request usually names as something to produce. */
const BINARY =
  /\.(png|jpe?g|gif|webp|pdf|zip|gz|7z|tar|docx?|xlsx?|pptx?|mp[34]|wav|bin|so|o|db|sqlite3?|parquet|pkl|npy|npz|class|jar|exe|wasm)$/i;

/**
 * What a bare name has to end in to be taken for a file: `np.float64` and `os.path` read like file
 * names, and a request names files by path or by one of these.
 */
const TEXT_FILE =
  /\.(py|ipynb|js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|txt|csv|tsv|ya?ml|toml|ini|cfg|conf|sh|bash|c|h|cc|cpp|hpp|rs|go|java|kt|rb|php|pl|r|sql|html?|css|xml|log|tex|cbl|cob|dat|env|lock)$/i;

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
  const files = unique([...text.matchAll(PATH)].map((match) => match[1]!)).filter(
    // A domain or a version number looks like a file name; a file has a slash or a short name.
    (path) => !BINARY.test(path) && (path.includes('/') || TEXT_FILE.test(path))
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
