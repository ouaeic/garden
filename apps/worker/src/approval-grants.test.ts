import { describe, expect, it, vi } from 'vitest';
import { canonicalApprovalScope } from '@garden/contracts';
import { encryptJson, wrapDataKey } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import { approvalRequirement } from './approval-policy.js';
import { approvalForCall, type ApprovalFloorDeps } from './approval-floor.js';
import type { AgentState } from './agent-state.js';
import { MAX_TURN_NOVEL_BYTES } from './egress.js';

const download = {
  executable: 'curl',
  args: ['-o', 'workspace/a.js', 'https://unpkg.com/pkg/a.js'],
  network: true
};
const tainted = { taintSources: ['untrusted page'], knownOrigins: [], ownerText: '' };
const scope = (args: Record<string, unknown>, context = tainted) =>
  approvalRequirement('shell', args, 'balanced', context)?.taskGrant;

describe('reusable approval scope', () => {
  it('keeps installation scope stable when the source becomes familiar', () => {
    const args = {
      executable: 'pip',
      args: ['install', 'https://packages.example/tool.whl'],
      network: true
    };
    const first = approvalRequirement('shell', args, 'balanced', tainted)?.taskGrant;
    const next = approvalRequirement('shell', args, 'balanced')?.taskGrant;
    expect(first).toBeDefined();
    expect(next).toBeDefined();
    expect(canonicalApprovalScope(first!)).toBe(canonicalApprovalScope(next!));
  });
  it('covers the same programs and origins while distinguishing different ones', () => {
    const first = scope(download);
    expect(first).toBeDefined();
    const next = scope({
      ...download,
      args: ['-o', 'workspace/b.js', 'https://unpkg.com/pkg/b.js']
    });
    expect(canonicalApprovalScope(next!)).toBe(canonicalApprovalScope(first!));
    expect(scope({ ...download, args: ['https://other.example/pkg'] })).not.toEqual(first);
    expect(
      scope({ ...download, executable: 'wget', args: ['https://unpkg.com/pkg/a.js'] })
    ).not.toEqual(first);
    expect(first?.origins).toEqual(['https://unpkg.com']);
  });
  it('offers an interpreter scope without calling it a verified download', () => {
    const requirement = approvalRequirement(
      'shell',
      {
        executable: 'python3',
        args: ['-c', "import urllib.request; urllib.request.urlopen('https://unpkg.com/pkg/a.js')"],
        network: true
      },
      'autonomous',
      tainted
    );
    expect(requirement?.taskGrant?.programs).toContain('python3');
    expect(requirement?.taskGrant?.permissions).toEqual(['network']);
    expect(requirement?.sideEffect).toBe('external_reversible');
  });
  it('describes a shell-wrapped Python script as a shell permission without inventing program names from its body', () => {
    const requirement = approvalRequirement(
      'shell',
      {
        executable: 'bash',
        args: [
          '-lc',
          "cd workspace && python3 - <<'PYEOF'\nimport urllib.request\nfrom pathlib import Path\nsource = urllib.request.urlopen('https://unpkg.com/pkg/a.js').read()\nprint(len(source))\nPath('library.js').write_bytes(source)\nPYEOF"
        ],
        network: true
      },
      'autonomous',
      tainted
    );
    expect(requirement?.taskGrant?.programs).toEqual(['bash']);
    expect(requirement?.taskGrant?.origins).toEqual(['https://unpkg.com']);
    expect(requirement?.sideEffect).toBe('external_reversible');
  });
  it('retains individual decisions for uploads, private or unresolved destinations and exceeded allowances', () => {
    const cases = [
      { ...download, args: ['-T', 'workspace/private.txt', 'https://unpkg.com/upload'] },
      { ...download, args: ['http://192.168.1.20/data'] },
      { executable: 'bash', args: ['-lc', 'curl "$URL"'], network: true },
      { executable: 'git', args: ['push', '--force', 'origin', 'main'], network: true },
      { ...download, background: true, service: 'persistent' }
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const args of cases) expect(scope(args)).toBeUndefined();
    expect(
      approvalRequirement('shell', download, 'balanced', {
        ...tainted,
        spentNoveltyBytes: MAX_TURN_NOVEL_BYTES
      })?.taskGrant
    ).toBeUndefined();
    expect(
      approvalRequirement('publish_preview', { reach: 'public', port: 3000 }, 'autonomous')
        ?.taskGrant
    ).toBeUndefined();
  });
  it('offers a push permission for an ordinary push and none for a forced one', () => {
    const push = approvalRequirement(
      'shell',
      { executable: 'git', args: ['push', 'origin', 'main'], network: true },
      'balanced'
    );
    expect(push?.action).toBe('Push Git changes');
    expect(push?.taskGrant?.permissions).toContain('push');
    expect(
      approvalRequirement(
        'shell',
        { executable: 'git', args: ['push', '--force', 'origin', 'main'], network: true },
        'balanced'
      )?.taskGrant
    ).toBeUndefined();
  });
  it('limits file permissions to the same project directory and keeps durable instructions separate', () => {
    const first = approvalRequirement(
      'file_write',
      { path: 'workspace/src/a.ts', content: 'a' },
      'review'
    )?.taskGrant;
    expect(first?.directories).toEqual(['workspace/src']);
    expect(
      approvalRequirement('file_write', { path: 'workspace/src/b.ts', content: 'b' }, 'review')
        ?.taskGrant
    ).toEqual(first);
    expect(
      approvalRequirement(
        'file_write',
        { path: 'workspace/GARDEN.md', content: 'instructions' },
        'review',
        tainted
      )?.taskGrant
    ).toBeUndefined();
    expect(
      approvalRequirement('file_write', { path: '/etc/profile', content: 'x' }, 'review')?.taskGrant
    ).toBeUndefined();
    expect(
      approvalRequirement('shell', { executable: 'python3', args: ['script.py'] }, 'review')
        ?.taskGrant?.permissions
    ).toEqual(['commands']);
    expect(
      approvalRequirement(
        'shell',
        { executable: 'curl', args: ['-fsS', 'https://example.com/data.json'] },
        'review'
      )?.taskGrant?.permissions
    ).not.toEqual(['commands']);
  });
  it("consults the conversation's permissions for each call, holds them across replies and keeps them out of children and stronger effects", async () => {
    const key = Buffer.alloc(32, 7),
      master = Buffer.alloc(32, 9);
    const granted = scope(download)!;
    let active = true;
    // The store answers for any conversation; the seal is what ties a permission to its own.
    const sealed = encryptJson(granted, key, 'task-approval:task:grant');
    const lookup = vi.fn(async (_user: string, _task: string, mode: string) =>
      active && mode === 'balanced' ? [{ id: 'grant', scopeCiphertext: sealed }] : []
    );
    const task = {
      id: 'task',
      userId: 'owner',
      workspaceId: 'workspace',
      securityMode: 'balanced'
    } as TaskRecord;
    const deps = {
      masterKey: master,
      store: {
        getWorkspaceById: async () => ({
          id: 'workspace',
          wrappedKey: wrapDataKey(key, master, 'workspace')
        }),
        listActiveTaskApprovalGrants: lookup
      } as unknown as DataStore,
      destinationContext: () => ({ ...tainted, knownOrigins: [] })
    } as unknown as ApprovalFloorDeps;
    const state = { turn: 2, taint: { sources: tainted.taintSources } } as AgentState;
    const call = (id: string, args: Record<string, unknown>, at = state, on = task) =>
      approvalForCall(deps, on, { id, name: 'shell', arguments: args }, at);
    expect(await call('1', download)).toBeNull();
    // A later reply in the same conversation keeps what the owner allowed.
    expect(await call('2', download, { ...state, turn: 3 })).toBeNull();
    // Reaching the same site is covered whichever program does it; another site is not.
    expect(
      await call('3', { ...download, executable: 'wget', args: ['https://unpkg.com/pkg/c.js'] })
    ).toBeNull();
    expect(await call('4', { ...download, args: ['https://other.example/pkg'] })).not.toBeNull();
    active = false;
    expect(await call('5', download)).not.toBeNull();
    active = true;
    expect(await call('6', download, state, { ...task, parentMissionId: 'child' })).not.toBeNull();
    // A permission sealed for another conversation does not open here.
    expect(await call('7', download, state, { ...task, id: 'other' })).not.toBeNull();
    // A consequential effect is never answered from a permission, so the store is not asked.
    const calls = lookup.mock.calls.length;
    expect(
      await call('8', { executable: 'git', args: ['push', '--force', 'origin', 'main'] })
    ).not.toBeNull();
    expect(lookup.mock.calls.length).toBe(calls);
  });
});
