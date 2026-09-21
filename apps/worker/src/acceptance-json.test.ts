import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@athanor/data';
import { parseAcceptanceChecks, describeAcceptanceCheck } from './acceptance.js';
import { acceptanceChecks, type AcceptanceRunnerDeps } from './acceptance-runner.js';

describe('structured result verification', () => {
  const input = {
    kind: 'artifact',
    label: 'Exact result counts and coverage',
    path: 'workspace/results.json',
    json: {
      equals: { '/summary/ready': 7 },
      lengths: { '/records': 12 },
      uniqueBy: { '/records': 'id' }
    }
  };
  it('retains exact obligations and displays them with the declared check', () => {
    const parsed = parseAcceptanceChecks([input]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.checks[0]).toMatchObject({ json: input.json });
    expect(describeAcceptanceCheck(parsed.checks[0]!)).toContain(JSON.stringify(input.json));
  });
  it.each([{}, { equals: {} }, { lengths: { '/records': '12' } }])(
    'rejects invalid assertions at declaration: %j',
    (json) => {
      expect(parseAcceptanceChecks([{ ...input, json }]).ok).toBe(false);
    }
  );
  it('does not confuse JSON semantics and document layout', () => {
    expect(
      parseAcceptanceChecks([{ ...input, path: 'workspace/results.pdf', render: {} }]).ok
    ).toBe(false);
  });
  it.each([true, false])(
    'uses the runner proof, not file size or a successful command: %s',
    async (passed) => {
      const parsed = parseAcceptanceChecks([input]);
      if (!parsed.ok) throw new Error(parsed.reason);
      const call = vi.fn(
        async (_w: string, _t: string, scope: string, route: string, body: unknown) => {
          expect(scope).toBe('files.read');
          if (route.endsWith('/json-proof')) {
            expect(body).toEqual({ path: input.path, json: input.json });
            return {
              passed,
              detail: passed
                ? '3/3 JSON assertions passed; sha256 fixed'
                : '2/3 JSON assertions passed; wrong count',
              sha256: 'fixed',
              assertions: 3,
              failures: passed ? [] : ['wrong count']
            };
          }
          expect(route).toContain('/files?');
          return { entries: [{ name: 'results.json', type: 'file', sizeBytes: 256 }] };
        }
      );
      const deps = {
        runner: { call },
        store: { appendTaskEvent: vi.fn(async () => ({})) },
        withLeaseRenewal: async (_task: unknown, run: () => unknown) => run()
      } as unknown as AcceptanceRunnerDeps;
      const results = await acceptanceChecks(
        deps,
        { id: 'task', workspaceId: 'workspace' } as TaskRecord,
        new Uint8Array(32),
        { checks: parsed.checks, revisions: 1, declaredAtStep: 0 },
        { purpose: 'finish' }
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.passed).toBe(passed);
      expect(results[0]?.detail).toContain('JSON assertions');
      expect(call).toHaveBeenCalledTimes(2);
    }
  );
});
