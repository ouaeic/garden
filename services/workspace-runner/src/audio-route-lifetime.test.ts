import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type * as Files from './files.js';
import type * as Audio from './audio.js';

vi.mock('./files.js', async (original) => {
  const actual = await original<typeof Files>();
  return { ...actual, ensureWorkspace: vi.fn(actual.ensureWorkspace) };
});
vi.mock('./audio.js', async (original) => {
  const actual = await original<typeof Audio>();
  return { ...actual, inspectAudioSource: vi.fn(), prepareAudio: vi.fn() };
});

import { ensureWorkspace } from './files.js';
import { inspectAudioSource, prepareAudio } from './audio.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

it.each([
  { route: 'source', phase: 'workspace setup' },
  { route: 'prepare', phase: 'workspace setup' },
  { route: 'source', phase: 'active reading' },
  { route: 'prepare', phase: 'active reading' }
])('aborts /audio/$route after HTTP disconnect during $phase', async ({ route, phase }) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-audio-route-'));
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  const secret = 'garden-audio-route-test-secret-longer-than-32';
  vi.stubEnv('RUNNER_SHARED_SECRET', secret);
  vi.stubEnv('WORKSPACE_ROOT', workspaceRoot);
  vi.stubEnv('ISOLATE_AGENT_NETWORK', 'false');
  vi.stubEnv('CONFINE_AGENT_FILESYSTEM', 'false');
  vi.stubEnv('AGENT_SANDBOX_HELPER', undefined);
  vi.stubEnv('BROWSER_USE_DESKTOP_DISPLAY', 'false');
  vi.stubEnv('SNAPSHOT_EXECUTABLE', path.resolve('../../scripts/garden-snapshot'));
  const app = await buildServer(loadConfig());
  cleanups.push(() => app.close());
  const incoming = deferred<{ request: FastifyRequest; reply: FastifyReply }>();
  app.addHook('onRequest', async (request, reply) => {
    incoming.resolve({ request, reply });
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const id = randomUUID();
  await ensureWorkspace(path.join(workspaceRoot, id));
  const setupEntered = deferred<void>();
  const releaseSetup = deferred<void>();
  cleanups.push(async () => releaseSetup.resolve());
  if (phase === 'workspace setup') {
    vi.mocked(ensureWorkspace).mockImplementationOnce(async () => {
      setupEntered.resolve();
      await releaseSetup.promise;
    });
  }

  const observed = deferred<{ signal: AbortSignal | undefined; aborted: boolean }>();
  const finished = deferred<void>();
  const observe = async (signal: AbortSignal | undefined) => {
    observed.resolve({ signal, aborted: signal?.aborted ?? false });
    if (phase === 'active reading' && !signal?.aborted) {
      await bounded(
        new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true })
        ),
        'route cancellation signal'
      );
    }
    finished.resolve();
    signal?.throwIfAborted();
  };
  vi.mocked(inspectAudioSource).mockImplementation(async (_root, _path, signal) => {
    await observe(signal);
    return { sourceSha256: 'a'.repeat(64), sourceBytes: 100 };
  });
  vi.mocked(prepareAudio).mockImplementation(async (_root, _path, _options, _tools, signal) => {
    await observe(signal);
    throw new Error('A disconnected preparation must abort before returning audio');
  });
  const url = `/v1/workspaces/${id}/audio/${route}`;
  const token = signCapabilityToken(
    {
      sub: randomUUID(),
      workspaceId: id,
      role: 'user',
      scopes: ['files.read'],
      aud: capabilityAudience('POST', url),
      nonce: randomUUID()
    },
    secret
  );
  const client = httpRequest(new URL(url, address), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  });
  client.on('error', () => {});
  cleanups.push(async () => client.destroy());
  client.end(JSON.stringify({ path: 'workspace/recording.wav' }));
  const { reply } = await bounded(incoming.promise, 'authenticated HTTP route');
  const closed = deferred<void>();
  reply.raw.once('close', () => closed.resolve());
  if (phase === 'workspace setup') await bounded(setupEntered.promise, 'workspace setup');
  else expect((await bounded(observed.promise, 'audio reader')).aborted).toBe(false);

  client.destroy();
  await bounded(closed.promise, 'server response close');
  expect(reply.raw.destroyed).toBe(true);
  releaseSetup.resolve();
  const observation = await bounded(observed.promise, 'reader signal after workspace setup');
  expect(observation.signal).toBeInstanceOf(AbortSignal);
  if (phase === 'workspace setup') expect(observation.aborted).toBe(true);
  await bounded(finished.promise, 'reader cancellation');
  expect(observation.signal?.aborted).toBe(true);
  expect(route === 'source' ? inspectAudioSource : prepareAudio).toHaveBeenCalledOnce();
});
