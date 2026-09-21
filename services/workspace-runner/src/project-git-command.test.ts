import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { projectGitCommand } from './project-git-command.js';

it('cancels Git and its transport descendants without waiting for their command deadline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-cancel-'));
  const pidFile = randomUUID() + '.pid';
  const controller = new AbortController();
  const run = projectGitCommand(
    root,
    ['-c', `alias.fixture=!sleep 30 & echo $! > ${pidFile}; wait`, 'fixture'],
    undefined,
    { signal: controller.signal }
  );
  const result = run.catch((error) => error as unknown);
  try {
    const deadline = Date.now() + 5_000;
    let pid = 0;
    while (!pid && Date.now() < deadline) {
      pid = Number(await readFile(path.join(root, pidFile), 'utf8').catch(() => ''));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    await expect(
      projectGitCommand(root, ['--version'], undefined, { signal: controller.signal })
    ).rejects.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await result;
    await rm(root, { recursive: true, force: true });
  }
});
