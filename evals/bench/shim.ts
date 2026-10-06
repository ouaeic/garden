/**
 * garden's runner protocol in, box commands out.
 *
 * Point `WORKSPACE_RUNNER_URL` at this server and the whole loop - catalogue, approval floor,
 * compaction, tools - runs against whatever `WorkspaceBackend` it was given, with no change to
 * anything in `apps/` or `packages/`. That seam already exists and is already load-bearing: it is
 * the one `evals/harness.ts` intercepts for all 73 fixtures.
 *
 * THE ONE RULE THIS FILE IS BUILT AROUND. A route this shim does not implement is a REFUSED RUN,
 * never a 404 and never a plausible answer. The reason is in `routes.ts`: three production call
 * sites swallow a runner failure by design, so a missing route does not surface as an error - it
 * surfaces as a slightly worse prompt, a task that scores 0, and a row that says the model is bad.
 * That is the failure the research rejected `BaseInstalledAgent` for, and it is just as available
 * inside this design as inside that one. `misses` is therefore not a log. It is a gate:
 * `parity.ts` refuses to emit a row for a run with a non-empty `misses`, and `selftest.ts` proves
 * that refusal by driving an unimplemented route.
 *
 * WHAT THIS SHIM NECESSARILY DROPS, which belongs in the artefact beside the score:
 *   - The capability token. The real runner verifies a signed token per request
 *     (`services/workspace-runner/src/auth.ts:36`). This one binds loopback and verifies nothing.
 *   - The Landlock sandbox and the rlimits. `execute()` applies both; this shim applies neither,
 *     so a command here can reach more of the box than the same command reaches in production.
 *   - Per-call egress gating on the local backend. See `WorkspaceBackend.isolatesNetwork`.
 *   - The browser, the screen, audio, previews and named snapshots. Not implemented, and answered
 *     as absent through `/surfaces` rather than left to fail.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ExecCall, WorkspaceBackend } from './backend.js';
import {
  createCheckpoint,
  listCheckpoints,
  listFiles,
  machineReport,
  probeBinaries,
  readFile,
  removeFile,
  renamePath,
  makeFolder,
  storageBytes,
  writeFile,
  WORKSPACE_PREFIX
} from './files.js';
import { ABSENT_ROUTES, canonicalRoute, isAbsent, isImplemented } from './routes.js';
import { inspectAcceptanceCommand } from '../../services/workspace-runner/src/acceptance-inspection.js';
import { summariseToolchain } from '../../services/workspace-runner/src/toolchain.js';
import { compareJson } from '../../services/workspace-runner/src/json-proof.js';
import { JsonProofRequest } from '../../packages/contracts/src/json-proof.js';

/** What a background process this shim started looks like while it runs. */
interface Session {
  readonly id: string;
  readonly startedAt: string;
  readonly command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  done: boolean;
}

export interface ShimResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface ShimOptions {
  readonly backend: WorkspaceBackend;
  /**
   * What this box tells the loop it has.
   *
   * A DECLARED INPUT, not a discovery, and that is deliberate: `apps/worker/src/turn/claim.ts:225`
   * withdraws seven tool schemas - about 11.7 kB of catalogue on every request of every turn -
   * when both surfaces are absent. So this one field moves the token bill of every row this shim
   * produces, which makes it a column of the artefact rather than a default buried in a file. The
   * research's charge against the whole field is exactly that such knobs are buried.
   *
   * `absent` on both is the honest answer for a Terminal-Bench container and it is the default.
   */
  readonly surfaces?: { browser: 'available' | 'absent'; desktop: 'available' | 'absent' };
  /**
   * What this box can do with documents, folded into the frozen runtime block.
   *
   * Empty by default, which produces the runner's own empty summary and costs the block one line.
   * A benchmark image with LaTeX and pandoc on it can say so here; claiming a capability the box
   * lacks would send the agent to run a converter that is not installed.
   */
  readonly toolchain?: readonly string[];
  /**
   * Called the moment a route outside `IMPLEMENTED_ROUTES` is requested.
   *
   * Exists so a scored run can die at the first miss rather than at the end of it. A benchmark
   * task runs for up to an hour; discovering the environment was wrong after that hour, three
   * hundred times over, is the difference between a wasted afternoon and a wasted week.
   */
  readonly onMiss?: (route: string) => void;
}

export interface Shim {
  handle(method: string, url: string, body: Buffer): Promise<ShimResponse>;
  /** Every route this shim was asked for, first-asked order, canonical. */
  readonly seen: readonly string[];
  /** Every route it was asked for and does not implement. A non-empty list voids the run. */
  readonly misses: readonly string[];
  /**
   * How many times the run asked for a capability this box declares it does not have.
   *
   * Not a miss and not an error: the model was told, in a tool result, that there is no browser.
   * It is a COLUMN of the artefact rather than a footnote, because a score produced after thirty
   * refused searches is a score about the environment.
   */
  readonly absentRequests: number;
  /** Whether any request arrived without an `Authorization` header, which the real runner refuses. */
  readonly unauthenticated: number;
  listen(port?: number): Promise<{ url: string; close: () => Promise<void> }>;
}

const json = (value: unknown, status = 200): ShimResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(value), 'utf8')
});

const asRecord = (body: Buffer): Record<string, unknown> => {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * One field of a JSON body as a string, without inventing one for a value that is not a string.
 *
 * `String(value)` on an object produces `[object Object]`, which would reach the box as a path or
 * an executable and fail in a way that reads as the model having written nonsense. A body field
 * that is not a string is a caller this shim does not understand, and the empty string it gets
 * back is refused by the route that reads it.
 */
const textField = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;

/** The runner's own default for every field the request left out. @see execution.ts:45-90. */
const execCallOf = (body: Record<string, unknown>): ExecCall => ({
  executable: textField(body.executable),
  args: Array.isArray(body.args) ? body.args.map(String) : [],
  cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : WORKSPACE_PREFIX,
  env:
    body.env !== null && typeof body.env === 'object'
      ? Object.fromEntries(
          Object.entries(body.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        )
      : {},
  timeoutSeconds: Number(body.timeoutSeconds) > 0 ? Number(body.timeoutSeconds) : 300,
  stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
  network: body.network === true,
  maxOutputBytes: Number(body.maxOutputBytes) > 0 ? Number(body.maxOutputBytes) : 1024 * 1024
});

/**
 * The prefix of a file that fits a display budget, and whether the last line of it is half a line.
 *
 * The worker's read ledger records exactly what came back here as having been shown to the model,
 * so a shim that returned more than it declared would make the ledger a record of a different
 * window than the one the model saw.
 */
const displayPrefix = (
  content: Buffer,
  budget: { maxBytes: number; maxLines: number }
): { text: string; totalLines: number; displayedLines: number; partialLine: boolean } => {
  const whole = content.toString('utf8');
  const lines = whole.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  let partial = false;
  for (const line of lines.slice(0, budget.maxLines)) {
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + cost > budget.maxBytes) {
      const room = budget.maxBytes - bytes;
      if (room > 0) {
        kept.push(Buffer.from(line, 'utf8').subarray(0, room).toString('utf8'));
        partial = true;
      }
      break;
    }
    bytes += cost;
    kept.push(line);
  }
  return {
    text: kept.join('\n'),
    totalLines: lines.length,
    displayedLines: kept.length,
    partialLine: partial
  };
};

/** A line window, with the byte budget honoured the way the runner honours it. */
const lineWindow = (
  content: Buffer,
  window: { startLine: number; endLine: number; maxBytes: number }
): {
  text: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  totalLines: number;
  fileBytes: number;
} => {
  const lines = content.toString('utf8').split('\n');
  const kept: string[] = [];
  let bytes = 0;
  let truncated = false;
  let lastKept = window.startLine;
  for (let line = window.startLine; line <= Math.min(window.endLine, lines.length); line += 1) {
    const text = lines[line - 1] ?? '';
    const cost = Buffer.byteLength(text, 'utf8') + (line < lines.length ? 1 : 0);
    if (bytes + cost > window.maxBytes) {
      truncated = true;
      break;
    }
    bytes += cost;
    kept.push(text);
    lastKept = line;
  }
  return {
    text: kept.join('\n'),
    startLine: window.startLine,
    endLine: lastKept,
    truncated,
    totalLines: lines.length,
    fileBytes: content.length
  };
};

export const createShim = (options: ShimOptions): Shim => {
  const backend = options.backend;
  const surfaces = options.surfaces ?? { browser: 'absent', desktop: 'absent' };
  const toolchain = options.toolchain ?? [];
  const seen: string[] = [];
  const misses: string[] = [];
  const absentAsked: string[] = [];
  const sessions = new Map<string, Session>();
  let unauthenticated = 0;

  const dispatch = async (
    route: string,
    url: URL,
    body: Buffer
  ): Promise<ShimResponse | undefined> => {
    const parsed = asRecord(body);
    const query = url.searchParams;
    const wanted = decodeURIComponent(query.get('path') ?? '');
    switch (route) {
      case 'PUT /v1/workspaces/:workspaceId':
      case 'GET /v1/workspaces/:workspaceId': {
        await backend.ensure();
        return json({ id: url.pathname.split('/')[3], status: 'ready', runnerRef: backend.name });
      }
      case 'POST /v1/workspaces/:workspaceId/exec':
        return json(await backend.exec(execCallOf(parsed)));
      case 'GET /v1/workspaces/:workspaceId/files':
        return json({
          path: wanted,
          entries: await listFiles(backend, wanted === '' ? WORKSPACE_PREFIX : wanted)
        });
      case 'GET /v1/workspaces/:workspaceId/file': {
        const content = await readFile(backend, wanted);
        if (content === null)
          return json(
            { error: { code: 'file_not_found', message: 'Workspace file not found' } },
            404
          );
        const positive = (name: string): number | undefined => {
          const value = Number(query.get(name));
          return Number.isFinite(value) && value > 0 ? value : undefined;
        };
        const maxBytes = positive('maxBytes');
        // Three callers, told apart exactly as `server.ts:873-955` tells them apart. A shim that
        // answered all three with the whole file would break `file_patch`, whose line numbers are
        // the window's, and would tell the read ledger a longer window was shown than was.
        if (maxBytes !== undefined) {
          const window = lineWindow(content, {
            startLine: positive('startLine') ?? 1,
            endLine: positive('endLine') ?? Number.MAX_SAFE_INTEGER,
            maxBytes
          });
          const reachedEnd = !window.truncated && window.endLine >= window.totalLines;
          return {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'x-start-line': String(window.startLine),
              'x-end-line': String(window.endLine),
              'x-file-bytes': String(window.fileBytes),
              'x-truncated': String(window.truncated),
              'x-partial-line': 'false',
              ...(reachedEnd
                ? { 'x-total-lines': String(window.totalLines) }
                : { 'x-next-start-line': String(window.endLine + 1) })
            },
            body: Buffer.from(window.text, 'utf8')
          };
        }
        const displayBytes = positive('displayBytes');
        const displayLines = positive('displayLines');
        const sha = createHash('sha256').update(content).digest('hex');
        if (displayBytes !== undefined && displayLines !== undefined) {
          const shown = displayPrefix(content, { maxBytes: displayBytes, maxLines: displayLines });
          return {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'x-content-sha256': sha,
              'x-total-lines': String(shown.totalLines),
              'x-display-lines': String(shown.displayedLines),
              'x-partial-line': String(shown.partialLine)
            },
            body: Buffer.from(shown.text, 'utf8')
          };
        }
        // The read a `file_patch` makes: the whole file and its hash, displaying nothing.
        return {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-sha256': sha },
          body: content
        };
      }
      case 'PUT /v1/workspaces/:workspaceId/file':
        await writeFile(backend, wanted, body);
        return json({ ok: true, storageBytes: await storageBytes(backend) });
      case 'DELETE /v1/workspaces/:workspaceId/file':
        await removeFile(backend, wanted);
        return json({ ok: true });
      case 'POST /v1/workspaces/:workspaceId/files/folder':
        await makeFolder(backend, textField(parsed.path));
        return json({ ok: true });
      case 'POST /v1/workspaces/:workspaceId/files/rename':
        await renamePath(backend, textField(parsed.from), textField(parsed.to));
        return json({ ok: true });
      case 'GET /v1/workspaces/:workspaceId/image': {
        /*
         * One picture, and only a picture this box already holds in a form the gateway accepts.
         *
         * The real runner RE-ENCODES here (`server.ts:973`), which is also the one pass that takes
         * a camera's own notes off a photograph. This shim does neither: it needs an image
         * toolchain inside the box to convert, and claiming a conversion it did not do would send
         * a HEIC to a provider that refuses HEIC and report the refusal as a model failure. So a
         * type the gateway accepts is passed through and anything else is refused by name. The
         * missing EXIF strip is a declared drop - on a benchmark task the picture is the task's
         * own fixture, not the owner's holiday photograph, but the difference is real and printed.
         */
        const type = /\.(png|jpe?g|webp|gif)$/i.exec(wanted)?.[1]?.toLowerCase();
        if (type === undefined)
          return json(
            {
              error: {
                code: 'image_not_convertible',
                message: `This computer cannot convert ${wanted} into a picture a model will take.`
              }
            },
            503
          );
        const picture = await readFile(backend, wanted);
        if (picture === null)
          return json(
            { error: { code: 'file_not_found', message: 'Workspace file not found' } },
            404
          );
        const normalised = type === 'jpg' ? 'jpeg' : type;
        return {
          status: 200,
          headers: {
            'content-type': `image/${normalised}`,
            'x-image-source-type': `image/${normalised}`
          },
          body: picture
        };
      }
      case 'GET /v1/workspaces/:workspaceId/usage':
        return json({ storageBytes: await storageBytes(backend) });
      case 'GET /v1/workspaces/:workspaceId/toolchain':
        return json({
          capabilities: toolchain.map((id) => ({
            id,
            ready: true,
            missingBinaries: [],
            missingPythonModules: [],
            missingFonts: []
          })),
          ready: [...toolchain],
          missing: [],
          // The runner's own sentence for a box with none, which is what the contract reads to
          // decide whether to name the managed Python: an empty summary told a bare benchmark box
          // it had an interpreter that is not there, and the model spent a step finding out.
          summary:
            toolchain.length === 0
              ? summariseToolchain([])
              : `Available on this computer: ${toolchain.join(', ')}.`
        });
      case 'POST /v1/workspaces/:workspaceId/toolchain/probe':
        return json(
          await probeBinaries(
            backend,
            Array.isArray(parsed.binaries) ? parsed.binaries.map(String) : []
          )
        );
      case 'POST /v1/workspaces/:workspaceId/json-proof': {
        // The runner's own comparison over the file as the box holds it, so an acceptance check
        // declared as JSON assertions is judged by the same code it is judged by in production.
        const request = JsonProofRequest.parse(parsed);
        const content = await readFile(backend, request.path);
        if (content === null)
          return json(
            { error: { code: 'file_not_found', message: 'Workspace file not found' } },
            404
          );
        const sha256 = createHash('sha256').update(content).digest('hex');
        const result = compareJson(JSON.parse(content.toString('utf8')), request.json);
        return json({
          ...result,
          sha256,
          passed: result.failures.length === 0,
          detail:
            `${result.assertions - result.failures.length}/${result.assertions} JSON assertions passed; sha256 ${sha256}` +
            (result.failures.length ? `; ${result.failures.slice(0, 8).join('; ')}` : '')
        });
      }
      case 'POST /v1/workspaces/:workspaceId/acceptance/inspect':
        return json(await inspectAcceptanceCommand(parsed));
      case 'GET /v1/workspaces/:workspaceId/machine':
        return json(await machineReport(backend));
      case 'GET /v1/workspaces/:workspaceId/surfaces':
        return json(surfaces);
      case 'POST /v1/workspaces/:workspaceId/checkpoints':
        return json(await createCheckpoint(backend, textField(parsed.checkpointId, 'checkpoint')));
      case 'GET /v1/workspaces/:workspaceId/checkpoints':
        return json({ checkpoints: await listCheckpoints(backend) });
      case 'POST /v1/workspaces/:workspaceId/processes/start': {
        const call = execCallOf(parsed);
        const id = `proc_${createHash('sha256').update(`${Date.now()}${sessions.size}`).digest('hex').slice(0, 32)}`;
        const session: Session = {
          id,
          startedAt: new Date().toISOString(),
          command: [call.executable, ...call.args].join(' '),
          exitCode: null,
          stdout: '',
          stderr: '',
          done: false
        };
        sessions.set(id, session);
        // Started and not awaited, which is the whole point of the route. The rejection is caught
        // into the session rather than left to become an unhandled rejection that kills the run:
        // a background command that could not start is a fact the agent should read, not a crash.
        void backend
          .exec(call)
          .then((result) => {
            session.exitCode = result.exitCode;
            session.stdout = result.stdout;
            session.stderr = result.stderr;
          })
          .catch((cause: unknown) => {
            session.stderr = cause instanceof Error ? cause.message : String(cause);
            session.exitCode = null;
          })
          .finally(() => {
            session.done = true;
          });
        return json({ sessionId: id, startedAt: session.startedAt, status: 'running' });
      }
      case 'GET /v1/workspaces/:workspaceId/processes':
        return json({
          processes: [...sessions.values()].map((session) => ({
            sessionId: session.id,
            startedAt: session.startedAt,
            command: session.command,
            status: session.done ? 'exited' : 'running',
            exitCode: session.exitCode
          }))
        });
      case 'POST /v1/workspaces/:workspaceId/processes/:id': {
        const session = sessions.get(url.pathname.split('/').pop() ?? '');
        if (!session)
          return json({ error: { code: 'not_found', message: 'No such session' } }, 404);
        return json({
          sessionId: session.id,
          status: session.done ? 'exited' : 'running',
          exitCode: session.exitCode,
          stdout: session.stdout,
          stderr: session.stderr
        });
      }
      case 'GET /v1/workspaces/:workspaceId/preview-check/:port': {
        const port = Number(url.pathname.split('/').pop());
        if (!Number.isInteger(port) || port < 1 || port > 65_535)
          return json({ error: { code: 'invalid_port', message: 'A port is 1 to 65535' } }, 400);
        /*
         * The runner opens a socket to 127.0.0.1:port on its own host. This box is a container the
         * runner is not inside, so the question is asked of the kernel's own table from within:
         * a LISTEN entry (state 0A) on that port in /proc/net/tcp or tcp6. No binary is assumed
         * beyond a shell and `cat`, which every image this rig has met carries.
         */
        const hex = port.toString(16).toUpperCase().padStart(4, '0');
        const probe = await backend.exec({
          executable: '/bin/sh',
          args: ['-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null'],
          cwd: '.',
          env: {},
          timeoutSeconds: 5,
          network: false,
          maxOutputBytes: 1024 * 1024
        });
        const listening = probe.stdout
          .split('\n')
          .some((line) =>
            new RegExp(`^\\s*\\d+: [0-9A-F]+:${hex} [0-9A-F]+:[0-9A-F]+ 0A `).test(line)
          );
        return json({ port, available: listening });
      }
      case 'POST /v1/workspaces/:workspaceId/processes/stop-owner':
        // Nothing is killed, and it says so. This shim does not hold the child handles after
        // `exec` returns them to the promise above, so it cannot stop one. A benchmark task that
        // depends on stopping a background process would be measuring this gap - which is why the
        // count is honest rather than the number of sessions.
        return json({ stopped: [], services: [], note: 'this shim does not stop background work' });
      default:
        return undefined;
    }
  };

  const handle = async (method: string, rawUrl: string, body: Buffer): Promise<ShimResponse> => {
    const url = new URL(rawUrl, 'http://runner.invalid');
    const route = canonicalRoute(method, rawUrl);
    seen.push(route);
    // A capability this box genuinely does not have, answered as a refusal the MODEL reads rather
    // than as silence it works around. See ABSENT_ROUTES for why exactly these three and not the
    // seven the catalogue gate already withdraws. Counted, because a task that spent a third of
    // its steps trying to browse produced a score about the environment and not about the agent.
    if (isAbsent(route)) {
      absentAsked.push(route);
      return json(
        {
          error: { code: 'capability_absent', message: ABSENT_ROUTES[route] ?? 'Not on this box.' }
        },
        503
      );
    }
    if (!isImplemented(route)) {
      misses.push(route);
      options.onMiss?.(route);
      // 501 and a body that names the route, so a log of a voided run says which route voided it.
      // The status is not the guard - `apps/worker/src/agent.ts` catches three of these into a
      // shrug - `misses` is. This is only the part a human reads.
      return json(
        {
          error: {
            code: 'route_not_implemented',
            message: `This benchmark shim does not implement ${route}. The run it belongs to is void: see evals/bench/README.md.`
          }
        },
        501
      );
    }
    try {
      const answered = await dispatch(route, url, body);
      // A route that is declared implemented and has no arm in the switch. Recorded as a miss for
      // the same reason an undeclared route is: it is the same silence to the loop, and a
      // declaration with no handler behind it is this programme's computed-and-unwired shape.
      if (answered === undefined) {
        misses.push(route);
        options.onMiss?.(route);
        return json(
          {
            error: {
              code: 'route_declared_but_unhandled',
              message: `${route} is in IMPLEMENTED_ROUTES with no handler behind it.`
            }
          },
          501
        );
      }
      return answered;
    } catch (cause) {
      // A backend failure is a 500 and never an empty success. See `files.ts`'s `refuse`.
      return json(
        {
          error: {
            code: 'shim_failed',
            message: cause instanceof Error ? cause.message : String(cause)
          }
        },
        500
      );
    }
  };

  return {
    handle,
    get seen() {
      return [...new Set(seen)];
    },
    get misses() {
      return [...new Set(misses)];
    },
    get absentRequests() {
      return absentAsked.length;
    },
    get unauthenticated() {
      return unauthenticated;
    },
    async listen(port = 0) {
      const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          if (!request.headers.authorization) unauthenticated += 1;
          void handle(request.method ?? 'GET', request.url ?? '/', Buffer.concat(chunks)).then(
            (answer) => {
              response.writeHead(answer.status, answer.headers);
              response.end(answer.body);
            }
          );
        });
      });
      await new Promise<void>((resolve) => {
        // Loopback only, and not configurable. This server verifies no capability token and runs
        // arbitrary commands in the box; the one thing standing between it and anything that can
        // reach the host's network is the interface it binds.
        server.listen(port, '127.0.0.1', resolve);
      });
      const address = server.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${address.port}`,
        close: async () => {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      };
    }
  };
};
