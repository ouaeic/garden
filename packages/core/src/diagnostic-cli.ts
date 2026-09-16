import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DiagnosticReplay } from './diagnostics.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0]?.startsWith('-'))
    throw new Error('Usage: pnpm diagnostic:replay path/to/garden-diagnostic.ndjson');
  const replay = new DiagnosticReplay();
  const source = createReadStream(args[0]!, { encoding: 'utf8' });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  // Forward source failures: readline's iterator does not own the file stream's errors.
  let sourceError: Error | undefined;
  source.on('error', (error) => {
    sourceError = error;
    lines.close();
  });
  try {
    for await (const line of lines) {
      if (line.trim()) replay.accept(JSON.parse(line));
    }
    if (sourceError) throw sourceError;
    const result = replay.result();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.complete || !result.readable) process.exitCode = 2;
  } finally {
    lines.close();
    source.destroy();
  }
}
void main().catch(() => {
  // A malformed line can contain private content; never echo it through a parser exception.
  process.stderr.write(
    'Diagnostic could not be read or validated. Use pnpm diagnostic:replay <file>.\n'
  );
  process.exitCode = 1;
});
