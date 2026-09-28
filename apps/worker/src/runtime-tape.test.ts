import { describe, expect, it, vi } from 'vitest';
import {
  encryptBytes,
  encryptJson,
  decryptJson,
  userMemoryKey,
  withRuntimeObservations,
  runtimeCall,
  runtimeNow,
  runtimeSetTimeout,
  runtimeClearTimer
} from '@garden/core';
import { RuntimeCodec, REPLAY_WORKSPACE_KEY, REPLAY_MASTER_KEY } from './runtime-codec.js';
import { RuntimeRecorder, RuntimePlayback, type RuntimeEvent } from './runtime-tape.js';

const workspace = '22222222-2222-4222-8222-222222222222';
const owner = '11111111-1111-4111-8111-111111111111';

describe('runtime observation boundary', () => {
  it('replays callback interleaving and a timer without executing live work or reading the clock', async () => {
    const events: RuntimeEvent[] = [];
    const sink = {
      record: async (_kind: unknown, row: unknown) => {
        events.push(row as RuntimeEvent);
      }
    };
    const recorder = new RuntimeRecorder(new RuntimeCodec(workspace), sink);
    const transport = vi.fn(async (callback: unknown) => {
      await (callback as () => Promise<void>)();
      return 'observed result';
    });
    const work = async () => {
      const clock = runtimeNow();
      const calls = [1, 2].map((value) =>
        runtimeCall(
          'external',
          [
            async () => {
              await new Promise<void>((resolve) => {
                const timer = runtimeSetTimeout(() => {
                  runtimeClearTimer(timer);
                  resolve();
                }, value);
              });
            }
          ],
          transport
        )
      );
      return [clock, await Promise.all(calls)];
    };
    const expected = await withRuntimeObservations(recorder, work);
    expect(events.length).toBeGreaterThan(0);
    const count = transport.mock.calls.length;
    transport.mockImplementation(async () => {
      throw new Error('Live transport invoked');
    });
    const playback = new RuntimePlayback(new RuntimeCodec(workspace), events);
    expect(await withRuntimeObservations(playback, work)).toEqual(expected);
    playback.assertComplete();
    expect(transport).toHaveBeenCalledTimes(count);
  });

  it('redacts configured provider and connector secrets while retaining encrypted task observations', () => {
    const key = Buffer.alloc(32, 1),
      master = Buffer.alloc(32, 2);
    const codec = new RuntimeCodec(workspace, key, master, owner);
    const provider = encryptJson(
      { provider: 'openrouter', baseUrl: 'https://provider.test', apiKey: 'provider-canary' },
      master,
      `inference-provider:${owner}`
    );
    const connector = encryptJson(
      {
        accountOAuth: {
          accessToken: 'oauth-canary',
          refreshToken: 'refresh-canary',
          provider: 'google'
        }
      },
      master,
      `connector:${owner}:connection`
    );
    const memory = encryptBytes(
      Buffer.from('Owner direction'),
      userMemoryKey(master, owner),
      `owner-block:${owner}`
    );
    const value = codec.encode({
      provider,
      connector,
      memory,
      task: encryptJson({ prompt: 'Private task' }, key, 'task')
    });
    const serialized = JSON.stringify(value);
    for (const secret of [
      'provider-canary',
      'oauth-canary',
      'refresh-canary',
      key.toString('base64'),
      master.toString('base64')
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain('Private task');
    const replay = new RuntimeCodec(workspace, REPLAY_WORKSPACE_KEY, REPLAY_MASTER_KEY, owner);
    const decoded = replay.decode(value) as { task: ReturnType<typeof encryptJson> };
    expect(decryptJson(decoded.task, REPLAY_WORKSPACE_KEY)).toEqual({ prompt: 'Private task' });
    expect(() =>
      codec.encode(encryptJson({ secret: 'unknown' }, master, 'unknown-master-domain'))
    ).toThrow('excluded');
    expect(() => codec.encode(key)).toThrow('Key material');
    expect(() =>
      codec.encode({
        method() {
          return 1;
        }
      })
    ).toThrow('executable');
  });

  it('stops at the first changed arguments and never uses a live fallback', async () => {
    const codec = new RuntimeCodec(workspace);
    const replay = new RuntimePlayback(codec, [
      { type: 'call', id: 1, name: 'write', args: codec.encode(['approved.txt']) }
    ]);
    const live = vi.fn(async () => true);
    expect(() =>
      withRuntimeObservations(replay, () => runtimeCall('write', ['different.txt'], live))
    ).toThrow('arguments');
    expect(live).not.toHaveBeenCalled();
    expect(replay.result().complete).toBe(false);
  });
});
