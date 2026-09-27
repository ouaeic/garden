import { ReplayDivergence } from './runtime-tape.js';
import { CapturedRuntimeReplay } from './runtime-replay.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { DIAGNOSTIC_CAPTURE_BYTES, DIAGNOSTIC_RECORD_BYTES } from '@athanor/contracts';
import { PrivateDecisionReplay } from './diagnostic-replay.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0]!.startsWith('-')) throw new Error('Invalid arguments');
  const info = await stat(args[0]!);
  if (!info.isFile() || info.size > DIAGNOSTIC_CAPTURE_BYTES * 2)
    throw new Error('Invalid capture size');
  const source = createReadStream(args[0]!, { encoding: 'utf8' });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  let sourceError: Error | undefined;
  source.on('error', (error) => {
    sourceError = error;
    lines.close();
  });
  const replay = new PrivateDecisionReplay();
  const runtime = new CapturedRuntimeReplay();
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > DIAGNOSTIC_RECORD_BYTES) throw new Error('Record too large');
      if (line.trim()) {
        const row: unknown = JSON.parse(line);
        replay.accept(row);
        runtime.accept(row);
      }
    }
    if (sourceError) throw sourceError;
    const result = { ...replay.result(), runtime: await runtime.replay() };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (
      !result.complete ||
      result.semantic.divergences.length ||
      (result.semantic.approvalDecisions + result.semantic.requestDerivations === 0 &&
        !result.runtime.complete)
    )
      process.exitCode = 2;
  } finally {
    lines.close();
    source.destroy();
  }
}
void main().catch((error: unknown) => {
  if (error instanceof ReplayDivergence) {
    process.stdout.write(
      `${JSON.stringify({ complete: false, runtime: { divergence: { sequence: error.sequence, boundary: error.boundary } } }, null, 2)}\n`
    );
    process.exitCode = 2;
    return;
  }
  process.stderr.write(
    'Private capture could not be validated. Use pnpm diagnostic:replay-private <file>. No recorded action was executed.\n'
  );
  process.exitCode = 1;
});
