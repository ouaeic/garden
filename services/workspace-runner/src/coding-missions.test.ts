import { EventEmitter } from 'node:events';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeCodingMissions } from './coding-missions.js';

const parent = randomUUID(),
  parentTask = randomUUID();
describe('native isolated coding work', () => {
  let root = '';
  const execution = {
    quiesceWorkspace: vi.fn(async (id: string) => {
      void id;
    }),
    isWorkspaceBusy: vi.fn((id: string) => {
      void id;
      return false;
    })
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-missions-'));
    await mkdir(path.join(root, parent, 'workspace/project/src'), { recursive: true });
    await writeFile(
      path.join(root, parent, 'workspace/project/src/app.ts'),
      'export const answer = 1;\n'
    );
    execution.quiesceWorkspace.mockClear();
    execution.isWorkspaceBusy.mockReset().mockReturnValue(false);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const start = async (outputPaths = ['src']) => {
    const missions = new NativeCodingMissions(root, true, execution),
      id = randomUUID(),
      childWorkspaceId = randomUUID(),
      childTaskId = randomUUID();
    const receipt = await missions.start(parent, parentTask, id, {
      childWorkspaceId,
      childTaskId,
      sourceRoot: 'project',
      outputPaths,
      generation: 1
    });
    return { missions, id, childWorkspaceId, childTaskId, receipt };
  };
  it('snapshots dirty source into a detached worktree with private repository state and no parent credentials', async () => {
    await writeFile(path.join(root, parent, 'workspace/project/.env'), 'PRIVATE');
    await writeFile(path.join(root, parent, 'workspace/project/.env.example'), 'KEY=example');
    await mkdir(path.join(root, parent, 'workspace/project/.github'));
    await writeFile(path.join(root, parent, 'workspace/project/.github/ci.yml'), 'name: build');
    const f = await start();
    expect(f.receipt.fileCount).toBe(3);
    expect(f.receipt.excluded).toContain('.env');
    const child = path.join(root, f.childWorkspaceId);
    expect(await readFile(path.join(child, 'workspace/src/app.ts'), 'utf8')).toContain('= 1');
    const git = await readFile(path.join(child, 'workspace/.git'), 'utf8');
    expect(git).toContain(path.join(child, '.home/garden.git/worktrees'));
    await expect(readFile(path.join(child, 'workspace/.env'))).rejects.toThrow();
    await writeFile(path.join(child, 'workspace/src/app.ts'), 'export const answer = 2;\n');
    expect(
      await readFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'utf8')
    ).toContain('= 1');
    const review = await f.missions.review(parent, f.id, 1);
    expect(review.canIntegrate).toBe(true);
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]).toMatchObject({
      path: 'src/app.ts',
      permitted: true,
      conflict: false,
      binary: false,
      diffOmitted: false
    });
    expect(review.changes[0]!.diff).toContain('+export const answer = 2;');
  });
  it('detects scope violations and parent conflicts while review digests track exact content', async () => {
    const f = await start();
    await writeFile(path.join(root, f.childWorkspaceId, 'workspace/src/app.ts'), 'changed');
    const before = await f.missions.review(parent, f.id, 1);
    await writeFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'owner change');
    await writeFile(path.join(root, f.childWorkspaceId, 'workspace/outside.txt'), 'outside');
    const after = await f.missions.review(parent, f.id, 1);
    expect(after.canIntegrate).toBe(false);
    expect(after.digest).not.toBe(before.digest);
    expect(after.changes.find((c) => c.path === 'src/app.ts')?.conflict).toBe(true);
    expect(after.changes.find((c) => c.path === 'outside.txt')?.permitted).toBe(false);
  });
  it('integrates the exact reviewed files once and preserves unrelated parent work', async () => {
    const f = await start();
    await writeFile(
      path.join(root, f.childWorkspaceId, 'workspace/src/app.ts'),
      'export const answer = 3;\n'
    );
    await writeFile(path.join(root, f.childWorkspaceId, 'workspace/src/new.ts'), 'new file');
    await writeFile(path.join(root, parent, 'workspace/project/owner.txt'), 'unrelated owner file');
    const review = await f.missions.review(parent, f.id, 1);
    const result = await f.missions.integrate(parent, f.id, 1, review.digest);
    expect(result).toMatchObject({ integrated: true, changedFiles: 2 });
    expect(
      await readFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'utf8')
    ).toContain('= 3');
    expect(await readFile(path.join(root, parent, 'workspace/project/src/new.ts'), 'utf8')).toBe(
      'new file'
    );
    expect(await readFile(path.join(root, parent, 'workspace/project/owner.txt'), 'utf8')).toBe(
      'unrelated owner file'
    );
    const restarted = new NativeCodingMissions(root, true, execution);
    expect(await restarted.integrate(parent, f.id, 1, review.digest)).toEqual(result);
    await expect(restarted.cancel(parent, f.id, 2)).rejects.toThrow(/already integrated/);
    expect(execution.quiesceWorkspace).toHaveBeenCalledWith(f.childWorkspaceId);
  });
  it('rejects changed digests and active parent jobs before any source mutation', async () => {
    const f = await start();
    await writeFile(path.join(root, f.childWorkspaceId, 'workspace/src/app.ts'), 'specialist');
    const review = await f.missions.review(parent, f.id, 1);
    execution.isWorkspaceBusy.mockReturnValue(true);
    await expect(f.missions.integrate(parent, f.id, 1, review.digest)).rejects.toThrow(
      /active work/
    );
    execution.isWorkspaceBusy.mockReturnValue(false);
    await writeFile(path.join(root, f.childWorkspaceId, 'workspace/src/app.ts'), 'changed again');
    await expect(f.missions.integrate(parent, f.id, 1, review.digest)).rejects.toThrow(/Review/);
    expect(
      await readFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'utf8')
    ).toContain('= 1');
  });
  it('recovers a persisted partial integration before releasing the parent workspace', async () => {
    const f = await start();
    await writeFile(path.join(root, f.childWorkspaceId, 'workspace/src/app.ts'), 'specialist');
    const review = await f.missions.review(parent, f.id, 1);
    const manifestFile = path.join(root, parent, '.garden/coding-missions', f.id, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.phase = 'integrating';
    manifest.integration = {
      digest: review.digest,
      changes: review.changes,
      applied: ['src/app.ts']
    };
    await writeFile(manifestFile, JSON.stringify(manifest));
    await writeFile(
      path.join(root, parent, '.garden/coding-integration.json'),
      JSON.stringify({ id: f.id })
    );
    await writeFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'specialist');
    const restarted = new NativeCodingMissions(root, true, execution);
    await restarted.recover(parent);
    expect(
      await readFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'utf8')
    ).toContain('= 1');
    expect((await restarted.review(parent, f.id, 1)).canIntegrate).toBe(true);
    await expect(
      readFile(path.join(root, parent, '.garden/coding-integration.json'))
    ).rejects.toThrow();
  });
  it('fails closed for absent kernel confinement, links and stale cancelled generations', async () => {
    const unconfined = new NativeCodingMissions(root, false, execution);
    await expect(unconfined.start(parent, parentTask, randomUUID(), {})).rejects.toThrow(
      /isolation/
    );
    await symlink('/etc/passwd', path.join(root, parent, 'workspace/project/src/link'));
    await expect(start()).rejects.toThrow(/symbolic link/);
    await rm(path.join(root, parent, 'workspace/project/src/link'));
    const f = await start();
    await f.missions.cancel(parent, f.id, 2);
    expect(execution.quiesceWorkspace).toHaveBeenCalledWith(f.childWorkspaceId);
    await expect(f.missions.review(parent, f.id, 1)).rejects.toThrow(/not reviewable/);
    await expect(f.missions.cancel(parent, f.id, 1)).rejects.toThrow(/Stale/);
    const restarted = new NativeCodingMissions(root, true, execution);
    await expect(restarted.review(parent, f.id, 2)).rejects.toThrow(/not reviewable/);
  });
  it('preserves ignored files and CRLF bytes despite repository attributes', async () => {
    const source = path.join(root, parent, 'workspace/project');
    await writeFile(path.join(source, '.gitignore'), 'src/ignored.txt\n');
    await writeFile(path.join(source, '.gitattributes'), '* text eol=lf\n');
    await writeFile(path.join(source, 'src/ignored.txt'), 'first\r\nsecond\r\n');
    const f = await start();
    await expect(
      readFile(path.join(root, f.childWorkspaceId, 'workspace/src/ignored.txt'), 'utf8')
    ).resolves.toBe('first\r\nsecond\r\n');
    expect((await f.missions.review(parent, f.id, 1)).changes).toEqual([]);
  });
  it('reviews and integrates executable mode changes without pretending the bytes changed', async () => {
    const f = await start();
    await chmod(path.join(root, f.childWorkspaceId, 'workspace/src/app.ts'), 0o770);
    const review = await f.missions.review(parent, f.id, 1);
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]).toMatchObject({
      baseExecutable: false,
      resultExecutable: true,
      conflict: false
    });
    expect(review.changes[0]!.baseHash).toBe(review.changes[0]!.resultHash);
    expect(review.changes[0]!.diff).toContain('new mode 100755');
    await f.missions.integrate(parent, f.id, 1, review.digest);
    expect(
      (await lstat(path.join(root, parent, 'workspace/project/src/app.ts'))).mode & 0o111
    ).not.toBe(0);
  });
  it('recovers a rollback that finished before its journal unlink was persisted', async () => {
    const f = await start();
    await writeFile(
      path.join(root, parent, '.garden/coding-integration.json'),
      JSON.stringify({ id: f.id })
    );
    await new NativeCodingMissions(root, true, execution).recover(parent);
    expect(
      await readFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'utf8')
    ).toContain('= 1');
    await expect(
      readFile(path.join(root, parent, '.garden/coding-integration.json'))
    ).rejects.toThrow();
  });
  const surface = (workspaceId: string, sub: string, role: string, scopes: string[]) => {
    const raw = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    return {
      request: {
        url: `/v1/workspaces/${workspaceId}/files`,
        capability: { workspaceId, sub, role, scopes }
      } as FastifyRequest,
      reply: { raw } as unknown as FastifyReply,
      raw
    };
  };
  it('refuses owner writers and sibling agents, withdraws sealed execution and retains owner reads', async () => {
    const f = await start();
    const writer = surface(f.childWorkspaceId, 'owner', 'user', ['files.write']);
    await expect(f.missions.guard(writer.request, writer.reply)).rejects.toThrow(
      /parent mission controls/
    );
    const sibling = surface(f.childWorkspaceId, randomUUID(), 'agent', ['files.read']);
    await expect(f.missions.guard(sibling.request, sibling.reply)).rejects.toThrow(
      /execution authority/
    );
    const child = surface(f.childWorkspaceId, f.childTaskId, 'agent', ['files.read']);
    await f.missions.guard(child.request, child.reply);
    await f.missions.seal(parent, f.id, 1);
    expect(child.raw.destroy).toHaveBeenCalledOnce();
    expect(execution.quiesceWorkspace).toHaveBeenCalledWith(f.childWorkspaceId);
    const resumed = surface(f.childWorkspaceId, f.childTaskId, 'agent', ['files.read']);
    await expect(f.missions.guard(resumed.request, resumed.reply)).rejects.toThrow(
      /execution authority/
    );
    const owner = surface(f.childWorkspaceId, 'owner', 'user', ['files.read']);
    await expect(f.missions.guard(owner.request, owner.reply)).resolves.toBeUndefined();
  });
  it('refuses integration while a parent write response is active', async () => {
    const f = await start();
    await writeFile(path.join(root, f.childWorkspaceId, 'workspace/src/app.ts'), 'specialist');
    const review = await f.missions.review(parent, f.id, 1);
    const owner = surface(parent, 'owner', 'user', ['files.write']);
    await f.missions.guard(owner.request, owner.reply);
    await expect(f.missions.integrate(parent, f.id, 1, review.digest)).rejects.toThrow(
      /active work/
    );
    owner.raw.emit('close');
    await expect(f.missions.integrate(parent, f.id, 1, review.digest)).resolves.toMatchObject({
      integrated: true
    });
  });
  it('removes only a stopped matching child after quiescence and retries absent preparation safely', async () => {
    const f = await start();
    await expect(f.missions.remove(parent, f.id, 1, f.childWorkspaceId)).rejects.toThrow(
      /Stop this exact/
    );
    await f.missions.cancel(parent, f.id, 2, f.childWorkspaceId);
    await expect(f.missions.remove(parent, f.id, 2, randomUUID())).rejects.toThrow(
      /Stop this exact/
    );
    await f.missions.remove(parent, f.id, 2, f.childWorkspaceId);
    await expect(lstat(path.join(root, f.childWorkspaceId))).rejects.toThrow();
    expect(
      await readFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'utf8')
    ).toContain('= 1');
    await expect(f.missions.remove(parent, f.id, 2, f.childWorkspaceId)).resolves.toEqual({
      removed: true
    });
    await expect(f.missions.cancel(parent, randomUUID(), 2, randomUUID())).resolves.toEqual({
      cancelled: true
    });
    await expect(f.missions.cancel(parent, randomUUID(), 2, parent)).rejects.toThrow();
  });
  it('keeps two specialist working copies independent and integrates their disjoint reviewed changes', async () => {
    await writeFile(path.join(root, parent, 'workspace/project/src/other.ts'), 'other base');
    const first = await start(),
      second = { id: randomUUID(), workspace: randomUUID(), task: randomUUID() };
    await first.missions.start(parent, parentTask, second.id, {
      childWorkspaceId: second.workspace,
      childTaskId: second.task,
      sourceRoot: 'project',
      outputPaths: ['src/other.ts'],
      generation: 1
    });
    await Promise.all([
      writeFile(
        path.join(root, first.childWorkspaceId, 'workspace/src/app.ts'),
        'first specialist'
      ),
      writeFile(path.join(root, second.workspace, 'workspace/src/other.ts'), 'second specialist')
    ]);
    expect(
      await readFile(path.join(root, second.workspace, 'workspace/src/app.ts'), 'utf8')
    ).toContain('= 1');
    expect(
      await readFile(path.join(root, first.childWorkspaceId, 'workspace/src/other.ts'), 'utf8')
    ).toBe('other base');
    expect(await readFile(path.join(root, parent, 'workspace/project/src/other.ts'), 'utf8')).toBe(
      'other base'
    );
    const a = await first.missions.review(parent, first.id, 1),
      b = await first.missions.review(parent, second.id, 1);
    await first.missions.integrate(parent, first.id, 1, a.digest);
    await first.missions.integrate(parent, second.id, 1, b.digest);
    expect(await readFile(path.join(root, parent, 'workspace/project/src/app.ts'), 'utf8')).toBe(
      'first specialist'
    );
    expect(await readFile(path.join(root, parent, 'workspace/project/src/other.ts'), 'utf8')).toBe(
      'second specialist'
    );
  });
});
