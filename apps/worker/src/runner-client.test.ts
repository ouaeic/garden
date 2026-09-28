import { afterEach, describe, expect, it, vi } from 'vitest';
import { GardenError } from '@garden/core';
import { verifyCapabilityToken } from '@garden/core';
import { AgentRunnerClient, RUNNER_CONNECT_ATTEMPTS } from './runner-client.js';

const client = new AgentRunnerClient('http://127.0.0.1:4300', 'r'.repeat(48));
const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';

/** What undici actually throws: the reason is one level down, in `cause`. */
const transportFailure = (code: string): TypeError =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

const run = (): Promise<unknown> =>
  client.call(workspaceId, taskId, 'exec', `/v1/workspaces/${workspaceId}/exec`, {
    executable: 'ls'
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('reads partial JSON files as raw text when requested without accepting broken JSON API responses', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response('{', {
        headers: { 'content-type': 'application/json' }
      })
  );
  const path = `/v1/workspaces/${workspaceId}/file?path=workspace/results.json&maxBytes=1`;
  await expect(
    client.call(workspaceId, taskId, 'files.read', path, undefined, { responseType: 'text' })
  ).resolves.toBe('{');
  await expect(client.call(workspaceId, taskId, 'files.read', path)).rejects.toThrow();
});

describe('a workspace runner that is restarting', () => {
  it('rides out the restart window instead of failing the tool', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      if (attempts < 3) throw transportFailure('ECONNREFUSED');
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      });
    });

    const pending = run();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it('explains a runner that never comes back, and says nothing ran', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      throw transportFailure('ECONNREFUSED');
    });

    const pending = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const failure = await pending;

    expect(attempts).toBe(RUNNER_CONNECT_ATTEMPTS);
    expect(failure).toBeInstanceOf(GardenError);
    expect((failure as GardenError).code).toBe('workspace_runner_unreachable');
    expect((failure as GardenError).message).toContain('nothing from this call ran');
    expect((failure as GardenError).message).toContain('garden-runner');
    expect((failure as GardenError).message).not.toContain('fetch failed');
  });

  it('never replays a call the connection dropped after sending, and says it may have run', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      throw transportFailure('UND_ERR_SOCKET');
    });

    const failure = await run().catch((error: unknown) => error);

    expect(attempts).toBe(1);
    expect((failure as GardenError).code).toBe('workspace_runner_interrupted');
    expect((failure as GardenError).message).toContain('may have partly run');
  });

  it('describes a runner that accepted the call and never answered', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    });

    const failure = await run().catch((error: unknown) => error);

    expect((failure as GardenError).code).toBe('workspace_runner_timeout');
    expect((failure as GardenError).message).toContain('It may still be running');
  });

  it('carries an anti-bot challenge across as data, not as a sentence about one', async () => {
    // The wall is the one refusal whose answer is a person: the worker has to raise it with the
    // owner and offer them that exact tab, and none of the vendor, the site or the tab id survives
    // being read back out of `Workspace tool failed (409): {…}`.
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'browser_bot_wall',
              message:
                'Blocked by Cloudflare Turnstile: this page is showing an anti-bot challenge',
              requestId: 'req-1',
              botWall: {
                vendor: 'Cloudflare Turnstile',
                url: 'https://html.duckduckgo.com/html/?q=board+pack',
                reason: 'challenge frame',
                evidence: 'page',
                tabId: 'tab-2'
              }
            }
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        )
    );

    const failure = (await run().catch((error: unknown) => error)) as GardenError;

    expect(failure).toBeInstanceOf(GardenError);
    expect(failure.code).toBe('browser_bot_wall');
    expect(failure.statusCode).toBe(409);
    expect(failure.message).toContain('Cloudflare Turnstile');
    expect(failure.details?.botWall).toMatchObject({
      vendor: 'Cloudflare Turnstile',
      tabId: 'tab-2',
      url: 'https://html.duckduckgo.com/html/?q=board+pack'
    });
  });

  it('gives an ordinary refusal its own code and the runner’s own words', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'runner_request_failed',
              message: 'Browser control is held by user',
              requestId: 'req-2'
            }
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
    );

    const failure = (await run().catch((error: unknown) => error)) as GardenError;

    expect(failure.code).toBe('runner_request_failed');
    expect(failure.message).toBe('Browser control is held by user');
    expect(failure.message).not.toContain('Workspace tool failed');
  });

  it('keeps the plain sentence for a body that is not a runner refusal', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>bad gateway</html>', { status: 502 }));

    const failure = (await run().catch((error: unknown) => error)) as Error;

    expect(failure).not.toBeInstanceOf(GardenError);
    expect(failure.message).toContain('Workspace tool failed (502)');
    expect(failure.message).toContain('bad gateway');
  });

  it('leaves a cancelled call as an abort so the stop path still owns it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });

    const failure = await run().catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(GardenError);
    expect((failure as Error).name).toBe('AbortError');
  });
});

describe('what the runner measured, and what it could not', () => {
  const audio = (headers: Record<string, string>): void => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), {
          headers: { 'x-audio-format': 'ogg', 'x-audio-more': 'false', ...headers }
        })
    );
  };

  /*
   * The runner leaves this header out on purpose, for the one recording ffprobe cannot measure - a
   * stream copy declares no duration. Read through `Number`, the absent header became zero, and the
   * model was handed a recording of no length at all beside the ninety minutes just read out of it.
   */
  it('leaves a length the runner could not measure absent rather than calling it zero', async () => {
    audio({ 'x-audio-start-seconds': '0', 'x-audio-prepared-seconds': '5400' });

    const prepared = await client.prepareAudio(workspaceId, taskId, { path: 'workspace/memo.m4a' });

    expect(prepared.durationSeconds).toBeNull();
    expect(prepared.preparedSeconds).toBe(5400);
  });

  it('bounds prepared audio before buffering a provider-sized upload, even without a length header', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(25 * 1024 * 1024));
                controller.enqueue(new Uint8Array([1]));
              },
              cancel
            })
          )
      )
    );
    await expect(
      client.prepareAudio(workspaceId, taskId, { path: 'workspace/meeting.ogg' })
    ).rejects.toThrow(/exceed|limit/i);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('reads the length when the runner did measure one', async () => {
    audio({
      'x-audio-start-seconds': '0',
      'x-audio-prepared-seconds': '5400',
      'x-audio-duration-seconds': '7200'
    });

    const prepared = await client.prepareAudio(workspaceId, taskId, { path: 'workspace/memo.m4a' });

    expect(prepared.durationSeconds).toBe(7200);
  });

  /*
   * A photograph is re-encoded on its way out of the runner, which is what takes the camera's notes
   * off it, so what the turn is looking at is never the file on disk even when both are JPEG.
   */
  it('says which file the picture was made from, including when the format did not change', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          headers: { 'content-type': 'image/jpeg', 'x-image-source-type': 'image/jpeg' }
        })
    );

    const picture = await client.readImage(workspaceId, taskId, 'workspace/IMG_0422.JPG');

    expect(picture.mimeType).toBe('image/jpeg');
    expect(picture.convertedFrom).toBe('image/jpeg');
  });
});

/*
 * The one fact this client adds rather than passes through, and the reason it adds it here.
 *
 * `POST /checkpoints` answers with the paths the scan walked past for being over
 * `CHECKPOINT_MAX_FILE_BYTES`, cut off at sixty-four, and a second field saying whether it had to
 * cut. Three places downstream spend that - `AgentState.checkpoint`, `undoPointFor` and the location
 * test in `destructiveCommand` - and a partial list is worth nothing to any of them: a delete naming
 * the sixty-fifth oversize file would be freed by a list that does not mention it. So the two fields
 * collapse to one answer on arrival: the complete set, or null for "not known", which keeps the card
 * on every delete for that turn.
 */
describe('what the checkpoint response says about what it could not hold', () => {
  const checkpoint = (
    body: Record<string, unknown>
  ): Promise<{ uncovered: readonly string[] | null }> => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ id: 'cp-1', mechanism: 'content', pruned: [], ...body }), {
          headers: { 'content-type': 'application/json' }
        })
    );
    return client.checkpoint(workspaceId, taskId, { checkpointId: 'cp-1', turn: 0 });
  };

  it('carries a complete list through as it stands', async () => {
    await expect(
      checkpoint({ uncoveredPaths: ['workspace/model.gguf'], uncoveredPathsTruncated: false })
    ).resolves.toMatchObject({ uncovered: ['workspace/model.gguf'] });
    // The ordinary workspace. Empty is an answer - the walk held everything - and it is the one
    // that frees a delete, so it must never collapse to null.
    await expect(
      checkpoint({ uncoveredPaths: [], uncoveredPathsTruncated: false })
    ).resolves.toMatchObject({ uncovered: [] });
  });

  it('reads a list it cannot trust as no list at all', async () => {
    // Cut off by the runner: what arrived names some of the uncovered files and not all of them.
    await expect(
      checkpoint({ uncoveredPaths: ['workspace/a.bin'], uncoveredPathsTruncated: true })
    ).resolves.toMatchObject({ uncovered: null });
    // A runner one release behind this worker, which sends no list at all. Read as an empty set
    // this would tell the floor that a workspace holds no oversize files on precisely the boxes
    // whose runner has not been updated.
    await expect(checkpoint({})).resolves.toMatchObject({ uncovered: null });
    await expect(checkpoint({ uncoveredPaths: null })).resolves.toMatchObject({ uncovered: null });
  });
});

describe('who a request is signed for', () => {
  /** The subject on the bearer token a call put on the wire, read as the runner reads it. */
  const subjectOf = async (through: AgentRunnerClient): Promise<string> => {
    let bearer = '';
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      bearer = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
      return new Response('', { headers: { 'content-type': 'text/plain' } });
    });
    await through.readFile(workspaceId, taskId, 'workspace/notes.md');
    return verifyCapabilityToken(bearer, 'r'.repeat(48), {
      method: 'GET',
      path: `/v1/workspaces/${workspaceId}/file`
    }).sub;
  };

  it('is the task, unless the client was made for one window inside it', async () => {
    expect(await subjectOf(client)).toBe(taskId);
    // Composed onto the task id, so what the runner scopes by task still sees whose window it is.
    expect(await subjectOf(client.forWindow('specialist-0123456789abcdef'))).toBe(
      `${taskId}:specialist-0123456789abcdef`
    );
    // And the client that was asked is not changed by asking.
    expect(await subjectOf(client)).toBe(taskId);
  });
});

describe('bounded workspace file uploads', () => {
  it('bounds streamed bytes even when the length header is absent', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(6));
              controller.enqueue(new Uint8Array(6));
            },
            cancel
          })
        )
    );
    await expect(
      client.readBytes(workspaceId, taskId, 'workspace/reference.mp4', 10)
    ).rejects.toMatchObject({ code: 'file_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('reads a bounded upload and refuses invalid limits before contacting the runner', async () => {
    const fetch = vi.fn(
      async () => new Response(Buffer.from('clip'), { headers: { 'content-type': 'video/mp4' } })
    );
    vi.stubGlobal('fetch', fetch);
    await expect(client.readBytes(workspaceId, taskId, 'reference.mp4', 4)).resolves.toEqual({
      mimeType: 'video/mp4',
      bytes: Buffer.from('clip')
    });
    await expect(client.readBytes(workspaceId, taskId, 'reference.mp4', -1)).rejects.toMatchObject({
      code: 'file_size_limit_invalid'
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
