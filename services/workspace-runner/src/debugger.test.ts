import { mkdtemp, realpath, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Execution from './execution.js';
import type * as MissionProcesses from './mission-processes.js';
import type { ChildProcess } from 'node:child_process';
import { DebugSessionSchema } from '@garden/contracts';
import { ensureWorkspace } from './files.js';
vi.mock('./execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Execution>()),
  prepareInvocation: vi.fn(
    async (root: string, request: { executable: string; args: string[]; cwd: string }) => ({
      executable: request.executable,
      args: request.args,
      cwd: path.join(root, request.cwd),
      env: process.env
    })
  )
}));
vi.mock('./mission-processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MissionProcesses>();
  return {
    ...actual,
    trackMissionInvocation: (
      root: string,
      prepared: { processTreeLease?: string },
      child: ChildProcess
    ) =>
      actual.trackMissionInvocation(
        root,
        prepared.processTreeLease === 'fixture-debug-lease' ? {} : prepared,
        child
      ),
    stopSupervisedInvocation: vi.fn(async () => undefined)
  };
});
import { prepareInvocation } from './execution.js';
import { stopSupervisedInvocation } from './mission-processes.js';
import { DebuggerManager } from './debugger.js';
import { NativeCodingMissions } from './coding-missions.js';
const policy = {
  isolateNetwork: false,
  sandbox: {
    elevate: '/fixture/sudo',
    helper: '/fixture/helper',
    specDirectory: '/fixture/spec',
    confineFilesystem: true,
    processIsolation: true,
    networkIsolation: true
  },
  systemPackages: { mode: 'refused' as const, helper: undefined }
};
const fixtures: Array<{ directory: string; manager: DebuggerManager }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.manager.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await realpath(await mkdtemp('/tmp/gd-'));
  const workspaceId = randomUUID(),
    taskId = randomUUID();
  const root = path.join(directory, workspaceId);
  await ensureWorkspace(root);
  const manager = new DebuggerManager(directory, policy, {
    python: process.env.GARDEN_DAP_PYTHON ?? '/uninstalled/python',
    javascript: process.env.GARDEN_DAP_JAVASCRIPT ?? '/uninstalled/javascript'
  });
  fixtures.push({ directory, manager });
  return {
    manager,
    root,
    workspaceId,
    taskId,
    call: (body: unknown) => manager.act(workspaceId, taskId, body)
  };
}
it('refuses unavailable adapters, unsafe authority, and unconfined launches before spawning', async () => {
  const { call, root, manager, workspaceId, taskId } = await fixture();
  await writeFile(path.join(root, 'workspace/main.py'), 'print(1)');
  await expect(
    call({ action: 'launch', language: 'python', program: '../outside.py' })
  ).rejects.toThrow();
  await expect(
    call({ action: 'launch', language: 'python', program: 'main.py', adapter: 'evil' })
  ).rejects.toThrow();
  await expect(
    manager.act(workspaceId, null, { action: 'launch', language: 'python', program: 'main.py' })
  ).rejects.toThrow('owning task');
  const unsafe = new DebuggerManager(path.dirname(root), {
    isolateNetwork: false,
    systemPackages: { mode: 'refused', helper: undefined }
  });
  await expect(
    unsafe.act(workspaceId, taskId, { action: 'launch', language: 'python', program: 'main.py' })
  ).rejects.toThrow('sandbox');
  await unsafe.close();
});
describe.skipIf(!process.env.GARDEN_DAP_PYTHON || !process.env.GARDEN_DAP_JAVASCRIPT)(
  'curated native debug adapters',
  () => {
    it('keeps cleanup pending until the native lease confirms teardown', async () => {
      const { manager, call, root, workspaceId, taskId } = await fixture();
      await writeFile(
        path.join(root, 'workspace/hold.py'),
        'import time\nwhile True: time.sleep(0.1)\n'
      );
      const prepare = vi.mocked(prepareInvocation),
        original = prepare.getMockImplementation()!;
      prepare.mockImplementationOnce(async (...args) => ({
        ...(await original(...args)),
        processTreeLease: 'fixture-debug-lease'
      }));
      let release!: () => void;
      const proof = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(stopSupervisedInvocation).mockReturnValueOnce(proof);
      try {
        const session = DebugSessionSchema.parse(
          await call({ action: 'launch', language: 'python', program: 'hold.py' })
        );
        let ended = false;
        const stopping = manager.stopOwner(workspaceId, taskId).then(() => {
          ended = true;
        });
        await vi.waitFor(
          () =>
            expect(stopSupervisedInvocation).toHaveBeenCalledWith({
              processTreeLease: 'fixture-debug-lease'
            }),
          { timeout: 5000 }
        );
        expect(ended).toBe(false);
        expect(manager.isWorkspaceBusy(root)).toBe(true);
        expect(
          manager.list(workspaceId, null).find((row) => row.sessionId === session.sessionId)
        ).toMatchObject({ state: 'stopping', cleanupPending: true });
        release();
        await stopping;
        expect(manager.isWorkspaceBusy(root)).toBe(false);
      } finally {
        release();
      }
    }, 15_000);

    it('holds mission integration while a debugger-managed program can write and quiesces before release', async () => {
      const { manager, root, workspaceId, taskId, call } = await fixture();
      const directory = path.dirname(root);
      await mkdir(path.join(root, 'workspace/project/src'), { recursive: true });
      const parentSource = path.join(root, 'workspace/project/src/app.py');
      await writeFile(parentSource, 'answer = 1\n');
      const missions = new NativeCodingMissions(directory, true, {
        quiesceWorkspace: (id) => manager.quiesceWorkspace(path.join(directory, id)),
        isWorkspaceBusy: (id) => manager.isWorkspaceBusy(path.join(directory, id))
      });
      const id = randomUUID(),
        childWorkspaceId = randomUUID();
      await missions.start(workspaceId, taskId, id, {
        childWorkspaceId,
        childTaskId: randomUUID(),
        sourceRoot: 'project',
        outputPaths: ['src'],
        generation: 1
      });
      await writeFile(
        path.join(directory, childWorkspaceId, 'workspace/src/app.py'),
        'answer = 2\n'
      );
      const review = await missions.review(workspaceId, id, 1);
      await writeFile(
        path.join(root, 'workspace/writer.py'),
        'import time\nfrom pathlib import Path\ni = 0\nwhile True:\n    i += 1\n    Path("heartbeat").write_text(str(i))\n    time.sleep(0.03)\n'
      );
      await call({
        action: 'launch',
        language: 'python',
        program: 'writer.py',
        lifetimeSeconds: 30
      });
      await vi.waitFor(
        async () =>
          expect(
            Number(await readFile(path.join(root, 'workspace/heartbeat'), 'utf8'))
          ).toBeGreaterThan(0),
        { timeout: 5000 }
      );
      expect(manager.backgroundWork().commands).toBe(1);
      await expect(missions.integrate(workspaceId, id, 1, review.digest)).rejects.toThrow(
        /running|active|busy/i
      );
      expect(await readFile(parentSource, 'utf8')).toBe('answer = 1\n');
      await manager.stopOwner(workspaceId, taskId);
      expect(manager.isWorkspaceBusy(root)).toBe(false);
      expect(manager.backgroundWork()).toEqual({ commands: 0, longestRemainingMs: null });
      const stopped = await readFile(path.join(root, 'workspace/heartbeat'), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readFile(path.join(root, 'workspace/heartbeat'), 'utf8')).toBe(stopped);
      expect(await missions.integrate(workspaceId, id, 1, review.digest)).toMatchObject({
        integrated: true
      });
      expect(await readFile(parentSource, 'utf8')).toBe('answer = 2\n');
    }, 30_000);

    it.each(['python', 'javascript'] as const)(
      'stops, inspects, steps and resumes real %s code without stale handles',
      async (language) => {
        const { manager, call, root, workspaceId } = await fixture();
        const program = language === 'python' ? 'main.py' : 'main.js';
        await writeFile(
          path.join(root, 'workspace', program),
          language === 'python'
            ? 'answer = 40\nanswer += 2\nprint(answer)\n'
            : 'let answer = 40;\nanswer += 2;\nconsole.log(answer);\n'
        );
        const launched = DebugSessionSchema.parse(
          await call({ action: 'launch', language, program, breakpoints: [{ line: 2 }] })
        );
        expect(prepareInvocation).toHaveBeenLastCalledWith(
          root,
          expect.objectContaining({
            network: false,
            requireNetworkIsolation: true,
            superviseProcessTree: true
          }) as unknown,
          expect.any(Object) as unknown
        );
        let session = launched;
        await vi.waitFor(
          () => {
            session = manager.list(workspaceId, null)[0]!;
            expect(session.state, session.output + session.note).toBe('stopped');
          },
          { timeout: 15_000, interval: 25 }
        );
        const sessionId = session.sessionId,
          epoch = session.stopEpoch;
        await expect(
          manager.act(workspaceId, 'other-task', { action: 'status', sessionId })
        ).rejects.toThrow('not found');
        const stack = await call({ action: 'stack', sessionId, epoch });
        expect(stack).toMatchObject({
          epoch,
          frames: [expect.objectContaining({ path: `workspace/${program}`, line: 2 })]
        });
        session = manager.list(workspaceId, null)[0]!;
        expect(session.frames.length).toBeGreaterThan(0);
        const frameId = session.frames[0]!.id;
        const scopes = (await call({ action: 'scopes', sessionId, epoch, frameId })) as {
          scopes: Array<{ variablesReference: number }>;
        };
        expect(scopes.scopes.length).toBeGreaterThan(0);
        const values = await call({
          action: 'variables',
          sessionId,
          epoch,
          variablesReference: scopes.scopes[0]!.variablesReference
        });
        expect(values).toMatchObject({
          variables: expect.arrayContaining([
            expect.objectContaining({ name: 'answer', value: '40' })
          ]) as unknown
        });
        await expect(
          call({ action: 'evaluate', sessionId, epoch, frameId: 999999, expression: 'answer' })
        ).rejects.toThrow('current workspace stack');
        expect(
          await call({ action: 'evaluate', sessionId, epoch, frameId, expression: 'answer + 2' })
        ).toMatchObject({ result: '42' });
        await call({ action: 'next', sessionId, epoch });
        await expect(
          call({
            action: 'variables',
            sessionId,
            epoch,
            variablesReference: scopes.scopes[0]!.variablesReference
          })
        ).rejects.toThrow('Stale');
        await vi.waitFor(
          () => {
            session = manager.list(workspaceId, null)[0]!;
            expect(session.state).toBe('stopped');
          },
          { timeout: 10_000 }
        );
        await call({ action: 'continue', sessionId, epoch: session.stopEpoch });
        await vi.waitFor(
          () => {
            session = manager.list(workspaceId, null)[0]!;
            expect(session.state).toBe('terminated');
          },
          { timeout: 10_000 }
        );
        expect(session.output).toContain('42');
      },
      45_000
    );
  }
);
