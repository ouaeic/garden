import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedProcess, ProjectProcessHistory } from '@athanor/contracts';
import type { RouteContext } from '../http/server-context.js';
import { registerProcessHistoryRoutes } from './process-history.js';
const key = (id: number, owner: string) =>
  `${String(id).padStart(16, '0')}-${createHash('sha256').update(owner).digest('hex')}-${createHash('sha256').update(String(id)).digest('hex')}.json`;
async function fixture() {
  const app = Fastify();
  const members = [
    { taskId: 'root', workspaceId: 'one' },
    { taskId: 'branch', workspaceId: 'two' }
  ];
  const entries = Array.from({ length: 67 }, (_, id) => {
    const member = members[id % 2]!;
    return {
      cursor: key(id + 1, member.taskId),
      value: {
        sessionId: `job-${id}`,
        workspaceId: member.workspaceId,
        ownerTaskId: member.taskId,
        status: 'completed',
        startedAt: '2026-09-20T00:00:00Z',
        command: ['analysis'],
        ranForMs: 12,
        outputBytes: 0,
        archived: true
      } satisfies ManagedProcess
    };
  });
  const store = {
    getWorkspace: vi.fn(async (user: string) => (user === 'owner' ? {} : null)),
    getProject: vi.fn(async (user: string) => (user === 'owner' ? {} : null)),
    projectExecutionMembers: vi.fn(async (user: string) => (user === 'owner' ? members : []))
  };
  const runner = {
    request: vi.fn(async (input: { workspaceId: string; path: string }) => {
      const url = new URL(input.path, 'http://runner');
      const before = url.searchParams.get('cursor'),
        limit = Number(url.searchParams.get('limit'));
      const owners = url.searchParams.has('owners')
        ? (JSON.parse(url.searchParams.get('owners')!) as string[])
        : null;
      const selected = entries
        .filter(
          (entry) =>
            entry.value.workspaceId === input.workspaceId &&
            (!before || entry.cursor < before) &&
            (!owners || owners.includes(entry.value.ownerTaskId))
        )
        .sort((a, b) => b.cursor.localeCompare(a.cursor));
      return {
        entries: selected.slice(0, limit),
        nextCursor: selected.length > limit ? selected[limit - 1]!.cursor : null
      };
    })
  };
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = request.headers['x-owner']
      ? ({ id: request.headers['x-owner'] } as never)
      : null;
  });
  registerProcessHistoryRoutes({ app, store, runner } as unknown as RouteContext);
  return { app, members, entries, runner };
}
describe('project saved history', () => {
  it('merges bounded pages across execution roots without omissions as new runs finish', async () => {
    const { app, entries, runner } = await fixture();
    try {
      const read = async (cursor?: string) => {
        const response = await app.inject({
          url: `/v1/projects/project/processes/history?kind=processes${cursor ? `&cursor=${cursor}` : ''}`,
          headers: { 'x-owner': 'owner' }
        });
        expect(response.statusCode).toBe(200);
        return response.json<ProjectProcessHistory>();
      };
      const first = await read();
      expect(first.processes).toHaveLength(20);
      entries.push({
        ...entries[0]!,
        cursor: key(100, 'root'),
        value: { ...entries[0]!.value, sessionId: 'newest' }
      });
      const ids = first.processes.map((entry) => entry.sessionId);
      let cursor = first.nextCursor;
      while (cursor) {
        const result = await read(cursor);
        ids.push(...result.processes.map((entry) => entry.sessionId));
        cursor = result.nextCursor;
      }
      expect(ids).toEqual(Array.from({ length: 67 }, (_, index) => `job-${66 - index}`));
      expect(runner.request).toHaveBeenCalledTimes(8);
      expect((await read()).processes[0]?.sessionId).toBe('newest');
    } finally {
      await app.close();
    }
  });
  it('binds cursors to the owner, project membership and category', async () => {
    const { app, members, runner } = await fixture();
    try {
      const response = await app.inject({
        url: '/v1/tasks/root/processes/history?kind=processes',
        headers: { 'x-owner': 'owner' }
      });
      expect(response.statusCode).toBe(200);
      const cursor = response.json<ProjectProcessHistory>().nextCursor;
      expect(cursor).toBeTruthy();
      runner.request.mockClear();
      for (const url of [
        `/v1/tasks/root/processes/history?kind=computation&cursor=${cursor}`,
        `/v1/projects/another/processes/history?kind=processes&cursor=${cursor}`
      ]) {
        expect((await app.inject({ url, headers: { 'x-owner': 'owner' } })).statusCode).toBe(409);
      }
      members.push({ taskId: 'new-member', workspaceId: 'one' });
      expect(
        (
          await app.inject({
            url: `/v1/tasks/root/processes/history?kind=processes&cursor=${cursor}`,
            headers: { 'x-owner': 'owner' }
          })
        ).statusCode
      ).toBe(409);
      expect(
        (
          await app.inject({
            url: '/v1/tasks/root/processes/history?kind=processes',
            headers: { 'x-owner': 'other' }
          })
        ).statusCode
      ).toBe(404);
      expect(runner.request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('fails visibly on unavailable or incorrectly scoped history instead of claiming completion', async () => {
    const { app, runner, entries } = await fixture();
    try {
      runner.request.mockRejectedValueOnce(Error('unavailable'));
      const url = '/v1/projects/project/processes/history?kind=processes';
      expect((await app.inject({ url, headers: { 'x-owner': 'owner' } })).statusCode).toBe(500);
      runner.request.mockResolvedValue({
        entries: [{ ...entries[0]!, value: { ...entries[0]!.value, ownerTaskId: 'foreign' } }],
        nextCursor: null
      });
      const leaked = await app.inject({ url, headers: { 'x-owner': 'owner' } });
      expect(leaked.statusCode).toBe(503);
      expect(leaked.json()).not.toHaveProperty('processes');
    } finally {
      await app.close();
    }
  });
});
