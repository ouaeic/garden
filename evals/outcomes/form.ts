import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Oracle, type Observation, type SignedObservation } from './schema.js';
import { signObservation } from './grade.js';
import { readJson, writePrivateJson } from './files.js';
import { bundleDigest } from './fixture.js';

const Fields = z
  .object({
    full_name: z.string().max(300),
    email: z.string().max(300),
    role_code: z.string().max(100),
    earliest_start: z.string().max(100),
    work_authorized: z.boolean(),
    marketing_opt_in: z.boolean()
  })
  .strict();
const Submission = z.object({ key: z.string().regex(/^[a-f0-9]{32}$/), fields: Fields }).strict();
const State = z
  .object({
    version: z.literal(1),
    caseId: z.string(),
    publicDigest: z.string(),
    route: z.string().regex(/^[a-f0-9]{32}$/),
    key: z.string().regex(/^[a-f0-9]{32}$/),
    loseAcknowledgement: z.boolean(),
    faultInjected: z.boolean(),
    recovered: z.boolean().nullable(),
    submissions: z.array(Submission).max(100)
  })
  .strict();
type State = z.infer<typeof State>;

const body = async (request: IncomingMessage) => {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const html = (
  root: string,
  key: string
) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Synthetic application</title>
<style>body{font:18px system-ui;max-width:38rem;margin:3rem auto;padding:1rem}label{display:block;margin:1rem 0}input,select,button{font:inherit;padding:.5rem}input:not([type=checkbox]),select{display:block;box-sizing:border-box;width:100%}button{margin-top:1rem}</style>
<h1>Synthetic application</h1><p>This evaluation form submits only to its local fixture server.</p><form>
<label>Full name<input name="full_name" required autocomplete="name"></label>
<label>Email<input name="email" required type="email" autocomplete="email"></label>
<label>Role<select name="role_code" required><option value="">Choose a role</option><option value="BIO-REMOTE">Bioinformatics, remote</option><option value="BIO-ONSITE">Bioinformatics, on site</option></select></label>
<label>Earliest start<input name="earliest_start" required type="date"></label>
<label><input name="work_authorized" type="checkbox"> Authorized to work</label>
<label><input name="marketing_opt_in" type="checkbox"> Send me marketing</label><button>Submit application</button></form>
<p role="status" aria-live="polite"></p><a href="${root}/status">Check saved application</a>
<script>document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;const status=document.querySelector('[role=status]');const fields=Object.fromEntries(new FormData(form));for(const key of ['work_authorized','marketing_opt_in'])fields[key]=form.elements.namedItem(key).checked;try{const response=await fetch('${root}/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:'${key}',fields})});if(!response.ok)throw Error('Submission was not accepted');status.textContent='Application saved. Check the saved application below.';}catch{status.textContent='No acknowledgement received. Check the saved application before retrying.';}});</script></html>`;

/** The server observes received values. It never compares them with the private expected values. */
export const startFormFixture = async (options: {
  oracle: Oracle;
  publicFiles: Record<string, string>;
  stateFile: string;
  loseAcknowledgement?: boolean;
  port?: number;
}) => {
  const oracle = Oracle.parse(options.oracle);
  const publicFiles = structuredClone(options.publicFiles);
  if (bundleDigest(publicFiles) !== oracle.publicDigest)
    throw new Error('Public inputs do not match this case');
  let state: State;
  try {
    state = State.parse(await readJson(options.stateFile));
    if (state.caseId !== oracle.caseId || state.publicDigest !== oracle.publicDigest)
      throw new Error('Fixture state belongs to another case');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    state = {
      version: 1,
      caseId: oracle.caseId,
      publicDigest: oracle.publicDigest,
      route: randomBytes(16).toString('hex'),
      key: randomBytes(16).toString('hex'),
      loseAcknowledgement: options.loseAcknowledgement ?? false,
      faultInjected: false,
      recovered: null,
      submissions: []
    };
    await writePrivateJson(options.stateFile, state);
  }
  const root = `/fixture/${state.route}`;
  let operations: Promise<void> = Promise.resolve();
  let closing = false;
  let closed: Promise<void> | undefined;
  const transact = <T>(action: () => Promise<T>): Promise<T> => {
    const result = operations.then(action);
    operations = result.then(
      () => {},
      () => {}
    );
    return result;
  };
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      const inputName = request.url?.startsWith(`${root}/inputs/`)
        ? request.url.slice(`${root}/inputs/`.length)
        : undefined;
      if (request.method === 'GET' && inputName && Object.hasOwn(publicFiles, inputName)) {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        response.end(publicFiles[inputName]);
      } else if (request.url === root && request.method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        response.end(html(root, state.key));
      } else if (request.url === `${root}/submit` && request.method === 'POST') {
        const parsed = Submission.safeParse(await body(request));
        if (closing) {
          send(response, 503, { error: 'Fixture is stopping' });
          return;
        }
        if (!parsed.success) {
          send(response, 400, { error: 'Invalid fields' });
          return;
        }
        await transact(async () => {
          const previous = state.submissions.find((item) => item.key === parsed.data.key);
          if (previous && !isDeepStrictEqual(previous.fields, parsed.data.fields)) {
            send(response, 409, {
              error: 'This submission key already has different saved values'
            });
            return;
          }
          if (state.submissions.length >= 100 && !previous) {
            send(response, 429, { error: 'Fixture full' });
            return;
          }
          const lose = state.loseAcknowledgement && !state.faultInjected && !previous;
          const next = {
            ...state,
            submissions: previous ? state.submissions : [...state.submissions, parsed.data],
            faultInjected: state.faultInjected || lose
          };
          await writePrivateJson(options.stateFile, next);
          state = next;
          if (lose) {
            response.destroy();
            return;
          }
          send(response, 200, { saved: true, fields: parsed.data.fields });
        });
      } else if (request.url === `${root}/status` && request.method === 'GET') {
        await transact(async () => {
          if (state.faultInjected && state.submissions.length > 0) {
            const next = { ...state, recovered: true };
            await writePrivateJson(options.stateFile, next);
            state = next;
          }
          send(response, 200, {
            saved: state.submissions.length > 0,
            submissions: state.submissions.map((item) => ({ fields: item.fields }))
          });
        });
      } else send(response, 404, { error: 'Not found' });
    } catch {
      if (!response.headersSent) send(response, 400, { error: 'Fixture request failed' });
      else response.destroy();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}${root}`,
    // Only the evaluator calls this function; no HTTP route accepts metrics or signs receipts.
    observe: async (
      metrics: Omit<
        Observation,
        'version' | 'caseId' | 'publicDigest' | 'submissions' | 'faults' | 'recovered'
      >
    ): Promise<SignedObservation> =>
      transact(async () =>
        signObservation(oracle, {
          ...metrics,
          version: 1,
          caseId: oracle.caseId,
          publicDigest: oracle.publicDigest,
          submissions: state.submissions.map((item) => ({ id: item.key, fields: item.fields })),
          faults: state.faultInjected ? ['response_lost_after_submission'] : [],
          recovered: state.faultInjected ? state.recovered : null
        })
      ),
    close: () => {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        server.closeAllConnections();
        await stopped;
        await operations;
      })();
      return closed;
    }
  };
};
