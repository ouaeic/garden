import { describe, expect, it } from 'vitest';
import { approvalRequirement } from './approval-policy.js';
import { isMutatingToolCall, writtenPaths } from './write-classification.js';
import { PLAN_MODE_PERMITTED } from './turn/dispatch.js';

describe('native code edit authority', () => {
  const args = {
    action: 'apply',
    language: 'typescript',
    options: {
      previewId: '00000000-0000-4000-8000-000000000001',
      paths: ['workspace/a.ts', 'workspace/b.ts']
    }
  };
  it('uses the same file approval mode as direct edits and names every affected path', () => {
    const review = approvalRequirement('code_diagnostics', args, 'review');
    expect(review?.sideEffect).toBe('workspace_write');
    expect(review?.preview).toContain('workspace/a.ts');
    expect(review?.preview).toContain('workspace/b.ts');
    expect(approvalRequirement('code_diagnostics', args, 'autonomous')).toBeNull();
  });
  it('is a mutation and cannot run in a read-only plan', () => {
    expect(isMutatingToolCall('code_diagnostics', args)).toBe(true);
    expect(isMutatingToolCall('code_diagnostics', { action: 'rename' })).toBe(false);
    expect(writtenPaths('code_diagnostics', args)).toEqual(args.options.paths);
    expect(PLAN_MODE_PERMITTED.has('code_diagnostics')).toBe(false);
  });
  it('does not conceal a deferred-execution file behind a preview handle', () => {
    const approval = approvalRequirement(
      'code_diagnostics',
      {
        ...args,
        options: {
          ...args.options,
          paths: ['workspace/.git/config']
        }
      },
      'autonomous'
    );
    expect(approval?.sideEffect).toBe('external_consequential');
  });
});
