import { spawnSync } from 'node:child_process';
import type * as FsPromises from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAudio } from './audio.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(open).mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-audio-lifetime-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(bin), mkdir(path.join(root, 'workspace'))]);
  return { root, bin };
};
const executable = (name: 'ffmpeg' | 'ffprobe') => {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  expect(found.status).toBe(0);
  expect(found.stdout.trim()).not.toBe('');
  return found.stdout.trim();
};
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const script = async (file: string, text: string) => {
  await writeFile(file, text);
  await chmod(file, 0o700);
};

describe('ephemeral recording decoder lifetime', () => {
  it('aborts the actual paced encoder, reaps it and closes both source descriptors', async () => {
    const { root, bin } = await fixture();
    const real = executable('ffmpeg');
    const source = path.join(root, 'workspace', 'memo.wav');
    expect(
      spawnSync(real, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=10',
        source
      ]).status
    ).toBe(0);
    await symlink(executable('ffprobe'), path.join(bin, 'ffprobe'));
    const pidFile = path.join(root, 'encoder.pid');
    await script(
      path.join(bin, 'ffmpeg'),
      `#!/bin/sh\nprintf '%s' "$$" > ${shellQuote(pidFile)}\nexec ${shellQuote(real)} -re "$@"\n`
    );
    const controller = new AbortController();
    const reading = prepareAudio(root, 'workspace/memo.wav', {}, bin, controller.signal);
    const outcome = reading.then(
      () => ({ status: 'completed' }),
      (error: unknown) => ({
        status: 'rejected',
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error)
      })
    );
    let pid: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        vi.waitFor(
          async () => {
            pid = Number(await readFile(pidFile, 'utf8'));
            expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
          },
          { timeout: 10_000, interval: 10 }
        ),
        outcome.then((result) => {
          throw new Error(
            `Recording preparation ended before encoder startup: ${JSON.stringify(result)}`
          );
        })
      ]);
      controller.abort();
      expect(
        await Promise.race([
          outcome,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ status: 'still-running' }), 1_000);
          })
        ])
      ).toMatchObject({ status: 'rejected', name: 'AbortError' });
      expect(() => process.kill(pid!, 0)).toThrow();
      const opened = await Promise.all(
        vi.mocked(open).mock.results.map((result) => {
          if (result.type !== 'return') throw new Error('Unexpected open failure');
          return result.value;
        })
      );
      expect(opened).toHaveLength(2);
      for (const handle of opened)
        await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* The normal abort already reaped it. */
        }
      }
      await outcome;
    }
  }, 20_000);

  it('does not forward service environment or working directory to either decoder', async () => {
    const { root, bin } = await fixture();
    vi.stubEnv('GARDEN_AUDIO_PRIVATE_TEST', 'test-only-value');
    await writeFile(path.join(root, 'workspace', 'memo.wav'), 'fixture');
    const guard = `if (process.env.GARDEN_AUDIO_PRIVATE_TEST !== undefined || process.cwd() !== '/') { process.stderr.write('Decoder received service context'); process.exit(42); }`;
    await script(
      path.join(bin, 'ffprobe'),
      `#!${process.execPath}\n${guard}\nprocess.stdout.write(JSON.stringify({format:{duration:'1'},streams:[{codec_type:'audio'}]}));\n`
    );
    await script(
      path.join(bin, 'ffmpeg'),
      `#!${process.execPath}\n${guard}\nprocess.stdout.write('OggS fixture');\n`
    );
    await expect(prepareAudio(root, 'workspace/memo.wav', {}, bin)).resolves.toMatchObject({
      preparedSeconds: 1,
      format: 'ogg'
    });
  });
});
