import { request as httpRequest } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { totalmem } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recoverMissionProcesses } from './mission-processes.js';
import { ProcessManager } from './processes.js';
import type { RunnerConfig } from './config.js';
import { commandLimits, resolveCommandLimiter } from './limits.js';
import { resolveAgentSandbox, sandboxSpecDirectory, probeNativeIsolation } from './sandbox.js';
import { hostStorage } from './host-storage.js';

const managers = new WeakMap<FastifyInstance, ProcessManager>();
export const prepareSupervisorRestart = (app: FastifyInstance): boolean =>
  managers.get(app)?.prepareForRestart() ?? false;

const METHODS = [
  'projectInputProtection',
  'start',
  'resume',
  'resumeWorkspace',
  'backgroundWork',
  'taskWriters',
  'refreshResources',
  'observedAgentListeners',
  'resourcesAvailable',
  'list',
  'listWorkspace',
  'history',
  'readAction',
  'stopOwner',
  'recoveryPlan',
  'resumeJob',
  'action',
  'inputPlan',
  'flush',
  'isWorkspaceBusy',
  'quiesceWorkspace',
  'stopWorkspace'
] as const;
const Request = z
  .object({ version: z.literal(1), method: z.enum(METHODS), args: z.array(z.unknown()).max(8) })
  .strict();
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

type AsyncMethod<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;
export type ProcessService = { [K in keyof ProcessManager]: AsyncMethod<ProcessManager[K]> } & {
  projectInputProtection(): Promise<{ protocol: 1; available: boolean }>;
};

/** Closing a request client never changes the lifetime of the jobs it observed. */
export function connectProcessSupervisor(socket: string, secret: string): ProcessService {
  return new Proxy({} as ProcessService, {
    get: (_target, method: string) => {
      if (method === 'close') return async () => undefined;
      if (!METHODS.includes(method as (typeof METHODS)[number]))
        throw new Error('Unknown process supervisor method');
      return (...args: unknown[]) =>
        new Promise<unknown>((resolve, reject) => {
          const body = JSON.stringify({ version: 1, method, args });
          const request = httpRequest(
            {
              socketPath: socket,
              path: '/rpc',
              method: 'POST',
              headers: {
                authorization: `Bearer ${secret}`,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
              }
            },
            (response) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              response.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                  request.destroy(new Error('Process supervisor response exceeds limit'));
                  return;
                }
                chunks.push(chunk);
              });
              response.on('error', reject);
              response.on('end', () => {
                try {
                  const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                    result?: unknown;
                    error?: string;
                  };
                  if (response.statusCode !== 200)
                    reject(new Error(result.error ?? 'Process supervisor refused the request'));
                  else resolve(result.result);
                } catch (cause) {
                  reject(
                    cause instanceof Error
                      ? cause
                      : new Error('Invalid process supervisor response', { cause })
                  );
                }
              });
            }
          );
          request.setTimeout(120_000, () =>
            request.destroy(new Error('Process supervisor did not respond'))
          );
          request.on('error', reject);
          request.end(body);
        });
    }
  });
}

/** This endpoint is private to the runner. All job creation still enters through its approval floor. */
export async function buildProcessSupervisor(config: RunnerConfig, manager = new ProcessManager()) {
  const app = Fastify({ logger: false, bodyLimit: config.MAX_FILE_BYTES });
  const sandbox = await resolveAgentSandbox(
    config.AGENT_SANDBOX_HELPER,
    sandboxSpecDirectory(config.WORKSPACE_ROOT),
    config.CONFINE_AGENT_FILESYSTEM
  );
  if (sandbox) {
    Object.assign(sandbox, await probeNativeIsolation(sandbox));
    if (!(await recoverMissionProcesses(sandbox))) sandbox.processIsolation = false;
  }
  const guards = {
    sandbox,
    limits: commandLimits(config, totalmem()),
    limiter: await resolveCommandLimiter(config.RESOURCE_LIMIT_EXECUTABLE),
    systemPackageHelper: config.SYSTEM_PACKAGE_HELPER,
    hostStorage
  };
  const expected = createHash('sha256').update(`Bearer ${config.RUNNER_SHARED_SECRET}`).digest();
  app.addHook('onRequest', async (request, reply) => {
    const actual = createHash('sha256')
      .update(request.headers.authorization ?? '')
      .digest();
    if (!timingSafeEqual(expected, actual)) return reply.code(401).send({ error: 'Unauthorized' });
  });
  app.setErrorHandler((cause, _request, reply) => {
    void reply
      .code(400)
      .send({ error: cause instanceof Error ? cause.message : 'Process request failed' });
  });
  app.post('/rpc', async (request) => {
    const { method, args } = Request.parse(request.body);
    if (method === 'projectInputProtection') {
      if (args.length) throw new Error('Input protection inspection takes no arguments');
      return {
        result: {
          protocol: 1,
          available: Boolean(
            sandbox?.confineFilesystem && sandbox.processIsolation && sandbox.projectInputLocks
          )
        }
      };
    }
    // Invocation policy comes from the supervisor's own configuration, never a serialized closure.
    if (method === 'start' || method === 'resumeWorkspace') {
      const workspaceId = z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .parse(args[1]);
      const root = path.resolve(config.WORKSPACE_ROOT, workspaceId);
      if (args[0] !== root) throw new Error('Job root does not match its workspace');
      args[method === 'start' ? 6 : 3] = {
        ...guards,
        ...(method === 'start' &&
        (args[6] as { superviseProcessTree?: boolean } | undefined)?.superviseProcessTree
          ? { superviseProcessTree: true }
          : {})
      };
      if (method === 'start') args[4] = config.MAX_BACKGROUND_SECONDS;
    } else if (method === 'resume') {
      args.splice(0, args.length, config.WORKSPACE_ROOT, config.ISOLATE_AGENT_NETWORK, guards);
    }
    const result: unknown = await Reflect.apply(manager[method], manager, args);
    return { result };
  });
  await manager.resume(config.WORKSPACE_ROOT, config.ISOLATE_AGENT_NETWORK, guards);
  app.addHook('onClose', async () => {
    await manager.close();
  });
  managers.set(app, manager);
  return app;
}

export async function listenProcessSupervisor(config: RunnerConfig) {
  const socket = config.JOB_SUPERVISOR_SOCKET;
  if (!socket) throw new Error('JOB_SUPERVISOR_SOCKET is required for the supervisor');
  await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
  // An active listener is never displaced. A stale socket may remain after a host crash.
  try {
    await connectProcessSupervisor(socket, config.RUNNER_SHARED_SECRET).backgroundWork();
    throw new Error('Process supervisor is already running');
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !('code' in cause) ||
      !['ENOENT', 'ECONNREFUSED'].includes(String(cause.code))
    )
      throw cause;
  }
  await unlink(socket).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'ENOENT') throw cause;
  });
  const app = await buildProcessSupervisor(config);
  await app.listen({ path: socket });
  await chmod(socket, 0o600);
  return app;
}
