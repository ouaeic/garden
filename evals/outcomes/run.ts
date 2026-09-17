import path from 'node:path';
import { prepareCase, readJson, readPublicBundle, writePrivateJson } from './files.js';
import { startFormFixture } from './form.js';
import { gradeOutcomes } from './grade.js';
import { Observation, Oracle } from './schema.js';
import { selfTest, unknownMetrics } from './selftest.js';

const usage = `pnpm eval:outcomes --ci
pnpm eval:outcomes prepare PUBLIC_DIR PRIVATE_DIR
pnpm eval:outcomes serve PRIVATE_DIR PUBLIC_DIR [--lose-ack] [--port=PORT] [--metrics=FILE]
pnpm eval:outcomes grade PRIVATE_DIR PUBLIC_DIR RESULT_JSON RECEIPT_JSON
Only PUBLIC_DIR goes into a task. Keep PRIVATE_DIR on the evaluator's machine.
`;

try {
  const [command, ...args] = process.argv.slice(2).filter((value) => value !== '--');
  if (command === '--ci' && args.length === 0) {
    process.stdout.write(JSON.stringify(await selfTest(), null, 2) + '\n');
  } else if (command === 'prepare' && args.length === 2) {
    process.stdout.write(JSON.stringify(await prepareCase(args[0]!, args[1]!), null, 2) + '\n');
  } else if (
    command === 'serve' &&
    args[0] &&
    args[1] &&
    args
      .slice(2)
      .every(
        (value) =>
          value === '--lose-ack' || /^--port=\d+$/.test(value) || value.startsWith('--metrics=')
      )
  ) {
    const directory = args[0];
    const oracle = Oracle.parse(await readJson(path.join(directory, 'oracle.json')));
    const port = Number(args.find((value) => value.startsWith('--port='))?.slice(7) ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const fixture = await startFormFixture({
      oracle,
      publicFiles: await readPublicBundle(args[1], oracle.publicDigest),
      stateFile: path.join(directory, 'form-state.json'),
      loseAcknowledgement: args.includes('--lose-ack'),
      port
    });
    process.stdout.write(JSON.stringify({ url: fixture.url, caseId: oracle.caseId }) + '\n');
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    await fixture.close();
    {
      const metricsFile = args.find((value) => value.startsWith('--metrics='))?.slice(10);
      const metrics = metricsFile
        ? Observation.omit({
            version: true,
            caseId: true,
            publicDigest: true,
            submissions: true,
            faults: true,
            recovered: true
          })
            .strict()
            .parse(await readJson(metricsFile))
        : unknownMetrics();
      await writePrivateJson(path.join(directory, 'receipt.json'), await fixture.observe(metrics));
    }
  } else if (command === 'grade' && args.length === 4) {
    const oracle = Oracle.parse(await readJson(path.join(args[0]!, 'oracle.json')));
    await readPublicBundle(args[1]!, oracle.publicDigest);
    const result = gradeOutcomes(oracle, await readJson(args[2]!), await readJson(args[3]!));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.verified) process.exitCode = 1;
  } else {
    process.stderr.write(usage);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Outcome evaluation failed'}\n`);
  process.exitCode = 1;
}
