import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCapabilityToken } from '@garden/core';
import { AgentRunnerClient, currentRunnerAbortSignal, withRunnerAbort } from './runner-client.js';
const secret = 'r'.repeat(48),
  workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222',
  sha = 'a'.repeat(64);
const client = new AgentRunnerClient('http://127.0.0.1:4300', secret);
afterEach(() => vi.unstubAllGlobals());
describe('recording source receipt transport', () => {
  it('inspects through the exact read-scoped source route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const token = new Headers(init?.headers).get('authorization')!.slice(7);
      const capability = verifyCapabilityToken(token, secret, {
        method: 'POST',
        path: `/v1/workspaces/${workspaceId}/audio/source`
      });
      expect(capability.workspaceId).toBe(workspaceId);
      expect(capability.sub).toBe(taskId);
      expect(capability.scopes).toEqual(['files.read']);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ path: 'workspace/memo.wav' }));
      return Response.json({ sourceSha256: sha, sourceBytes: 123 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await client.inspectAudioSource(workspaceId, taskId, 'workspace/memo.wav')).toEqual({
      sourceSha256: sha,
      sourceBytes: 123
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    {},
    { sourceSha256: 'partial', sourceBytes: 4 },
    { sourceSha256: sha, sourceBytes: 0 },
    { sourceSha256: sha, sourceBytes: 1.5 }
  ])('rejects malformed source metadata %j', async (body) => {
    vi.stubGlobal('fetch', async () => Response.json(body));
    await expect(
      client.inspectAudioSource(workspaceId, taskId, 'workspace/memo.wav')
    ).rejects.toMatchObject({ code: 'audio_source_receipt_invalid' });
  });
  it('transmits the approved digest and preserves the verified source metadata', async () => {
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      expect(init?.body).toBe(
        JSON.stringify({ path: 'workspace/memo.wav', endSeconds: 1, expectedSourceSha256: sha })
      );
      return new Response('OggS bytes', {
        headers: {
          'x-audio-source-sha256': sha,
          'x-audio-source-bytes': '123',
          'x-audio-prepared-seconds': '1'
        }
      });
    });
    const prepared = await client.prepareAudio(workspaceId, taskId, {
      path: 'workspace/memo.wav',
      endSeconds: 1,
      expectedSourceSha256: sha
    });
    expect(prepared.sourceSha256).toBe(sha);
    expect(prepared.sourceBytes).toBe(123);
    expect(prepared.bytes.toString()).toBe('OggS bytes');
  });
  it.each([
    {},
    { 'x-audio-source-sha256': 'b'.repeat(64), 'x-audio-source-bytes': '123' },
    { 'x-audio-source-sha256': sha, 'x-audio-source-bytes': '-1' }
  ])('refuses preparation without a matching receipt %j', async (headers) => {
    vi.stubGlobal('fetch', async () => new Response('OggS bytes', { headers }));
    await expect(
      client.prepareAudio(workspaceId, taskId, {
        path: 'workspace/memo.wav',
        expectedSourceSha256: sha
      })
    ).rejects.toMatchObject({ code: 'audio_source_receipt_invalid' });
  });
  it('keeps cancellation signals local to each simultaneous task', async () => {
    const a = new AbortController(),
      b = new AbortController();
    expect(currentRunnerAbortSignal()).toBeUndefined();
    await Promise.all([
      withRunnerAbort(a.signal, async () => {
        await Promise.resolve();
        expect(currentRunnerAbortSignal()).toBe(a.signal);
      }),
      withRunnerAbort(b.signal, async () => {
        await Promise.resolve();
        expect(currentRunnerAbortSignal()).toBe(b.signal);
      })
    ]);
    expect(currentRunnerAbortSignal()).toBeUndefined();
  });
});
