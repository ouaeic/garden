/**
 * The join, driven: garden's OWN runner client, over a real socket, against this shim.
 *
 * THIS FILE EXISTS BECAUSE OF ONE DEFECT SHAPE. The last wave in this programme shipped a repair
 * whose every seam was proved in isolation while the one line joining them was never written. A
 * shim whose routes are each exercised by a hand-written request is exactly that: every part
 * green, nothing joined. `selftest.ts`'s route table sends requests THIS RIG composed, to answers
 * THIS RIG parses. If the shim's answers are shaped for this rig rather than for garden, every
 * check in that table still passes.
 *
 * So the checks below construct `AgentRunnerClient` from `apps/worker/src/runner-client.ts` - the
 * production class, the one `apps/worker/src/agent.ts:291` builds and every tool call goes through
 * - point it at the shim's listening port, and call its real methods. The client composes the URL,
 * signs the capability token, sets the timeout, reads the response headers and parses the body. If
 * the shim answers `x-content-sha256` under a different name, or returns the whole file where a
 * window was asked for, or answers JSON where text was expected, these fail and the route table
 * does not.
 *
 * WHAT IT STILL DOES NOT PROVE, and this is the honest edge of it: no `AgentWorker` runs here, and
 * no model is called. It proves the wire between garden's client and this shim. It does not prove
 * a whole turn. That step needs a provider key and is the first paid command in `README.md`.
 */
import { AgentRunnerClient } from '../../apps/worker/src/runner-client.js';

import { localBackend } from './backend.js';
import { createShim } from './shim.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
/** The same 48-character shape `evals/harness.ts` uses; the shim verifies nothing, see its header. */
const SECRET = 'r'.repeat(48);

/** A file with enough lines and enough bytes for a window and a display budget to disagree. */
const SAMPLE = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].join('\n') + '\n';

export const wiringChecks = async (): Promise<string[]> => {
  const problems: string[] = [];
  const backend = await localBackend();
  let stop: (() => Promise<void>) | null = null;
  try {
    await backend.ensure();
    const shim = createShim({ backend });
    const server = await shim.listen();
    stop = server.close;
    const client = new AgentRunnerClient(server.url, SECRET);

    // A write and a read back, through the two methods a turn actually uses. `writeFile` PUTs the
    // string; `readFile` is the read a `file_patch` makes and takes `response.text()`, so a shim
    // answering a JSON envelope here would return the envelope AS the file - a defect this
    // repository has already shipped once, in its own fixture stub.
    await client.writeFile(WORKSPACE, TASK, 'workspace/wire.txt', SAMPLE);
    const read = await client.readFile(WORKSPACE, TASK, 'workspace/wire.txt');
    if (read !== SAMPLE)
      problems.push(
        `garden's own client read back ${JSON.stringify(read.slice(0, 60))} for a file it had just written`
      );

    // The hash the line-addressed editor stales its evidence against. `readFileWithHash` reads
    // `x-content-sha256` off the response, so a shim that omits the header answers `null` and no
    // edit can ever land - silently, because null is a value.
    const hashed = await client.readFileWithHash(WORKSPACE, TASK, 'workspace/wire.txt');
    if (hashed.sha256 === null || hashed.sha256.length !== 64)
      problems.push(
        `garden's own client got sha256 ${String(hashed.sha256)} back, so no line-addressed edit could land against this shim`
      );

    /*
     * The display read, which is what the read ledger records as having been shown to the model.
     * Two lines asked for, two shown; a shim that answered the whole file would make the ledger a
     * record of a window the model never saw.
     *
     * SIX, not five, and the number is the point. `services/workspace-runner/src/files.ts:376`
     * counts `1 + newlines`, so a five-line file that ends in a newline is six lines to the
     * runner - the last one empty. This check was written expecting five and went red on the first
     * run, which is what a join proves that a route table cannot: the shim and the client agree on
     * a convention neither of them states, and it is the runner's convention rather than the one
     * this rig would have picked. `file_read` prints these numbers to the model and `file_patch`
     * addresses lines by them, so an off-by-one here is an edit landing on the wrong line.
     */
    const shown = await client.readFileForDisplay(WORKSPACE, TASK, 'workspace/wire.txt', {
      maxBytes: 4_000,
      maxLines: 2
    });
    if (shown.displayedLines !== 2 || shown.totalLines !== 6)
      problems.push(
        `a display budget of 2 lines showed ${shown.displayedLines} of ${shown.totalLines} through garden's own client`
      );
    if (shown.content !== 'alpha\nbravo')
      problems.push(
        `a display read returned ${JSON.stringify(shown.content)} rather than two lines`
      );

    // The line window a `file_patch` addresses. `endLine` and `nextStartLine` come off headers the
    // client parses by name, and a wrong name reads as a one-line file.
    const window = await client.readFileLines(WORKSPACE, TASK, 'workspace/wire.txt', {
      startLine: 2,
      endLine: 3,
      maxBytes: 4_000
    });
    if (window.startLine !== 2 || window.endLine !== 3 || window.content !== 'bravo\ncharlie')
      problems.push(
        `a line window 2-3 came back as ${window.startLine}-${window.endLine} ${JSON.stringify(window.content)}`
      );

    // The route the whole benchmark is scored through, driven by the client's own generic `call`,
    // which is how `tools/workspace.ts:633` reaches it.
    const ran = await client.call<{ exitCode: number; stdout: string }>(
      WORKSPACE,
      TASK,
      'exec',
      `/v1/workspaces/${WORKSPACE}/exec`,
      { executable: '/bin/cat', args: ['wire.txt'] }
    );
    if (ran.exitCode !== 0 || ran.stdout !== SAMPLE)
      problems.push(
        `a command run through garden's own client saw exit ${String(ran.exitCode)} and ${JSON.stringify(ran.stdout.slice(0, 40))}`
      );

    // The three probes whose failure is silent in production. `#workspaceSurfaces` parses this
    // body with the shared `WorkspaceSurfaces` zod schema and falls back to the FULL catalogue on
    // any shape it does not recognise, so a body of the wrong shape here would cost 11.7 kB per
    // request and change which arm was measured - with nothing anywhere saying so.
    const surfaces = await client.call<{ browser: string; desktop: string }>(
      WORKSPACE,
      TASK,
      'exec',
      `/v1/workspaces/${WORKSPACE}/surfaces`
    );
    if (surfaces.browser !== 'absent' || surfaces.desktop !== 'absent')
      problems.push(
        `the shim told garden's own client browser=${surfaces.browser} desktop=${surfaces.desktop}, so the catalogue gate would not withdraw`
      );
    const machine = await client.call<{ summary: unknown }>(
      WORKSPACE,
      TASK,
      'exec',
      `/v1/workspaces/${WORKSPACE}/machine`
    );
    if (typeof machine.summary !== 'string')
      problems.push(
        'the machine route answered no `summary` string, which the runtime block reads'
      );

    // And a route the shim does not implement, reached through the production client. The client
    // throws an GardenError on a non-ok status, which the three call sites in `agent.ts` catch
    // into a shrug - so the throw is NOT the guard and this check is about `shim.misses` being
    // set by traffic that came over the wire rather than from this rig's own `handle` call.
    await client
      .call(WORKSPACE, TASK, 'exec', `/v1/workspaces/${WORKSPACE}/browser/print-pdf`, {})
      .catch(() => null);
    if (!shim.misses.includes('POST /v1/workspaces/:workspaceId/browser/print-pdf'))
      problems.push(
        'a route reached over the socket by garden own client was not recorded as a miss, so a live run would not be voided'
      );
    // Every request the production client makes carries a signed capability token. Counted rather
    // than verified: this shim verifies nothing (see its header), and a count of zero would mean
    // the client was not the thing talking to it.
    if (shim.unauthenticated !== 0)
      problems.push(
        `${shim.unauthenticated} request(s) reached the shim with no Authorization header, so something other than garden's client is driving it`
      );
  } catch (cause) {
    problems.push(
      `the wiring check threw: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  } finally {
    if (stop) await stop();
    await backend.dispose();
  }
  return problems;
};
