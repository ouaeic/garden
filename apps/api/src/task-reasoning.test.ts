import { describe, expect, it } from 'vitest';
import { validateTaskReasoning } from './task-reasoning.js';
import { ContinueTaskRequest, CreateTaskRequest } from '@garden/contracts';

describe('owner effort selection is checked before work is created', () => {
  it('retains a supported selection and accepts Auto with unknown metadata', () => {
    expect(
      validateTaskReasoning('max', {
        reasoning: { mandatory: true, supportedEfforts: ['high', 'max'] }
      })
    ).toBe('max');
    expect(validateTaskReasoning('auto', {})).toBe('auto');
  });
  it('rejects unknown, unsupported and disabled mandatory effort', () => {
    expect(() => validateTaskReasoning('high', {})).toThrow('does not advertise');
    expect(() =>
      validateTaskReasoning('low', { reasoning: { mandatory: true, supportedEfforts: ['high'] } })
    ).toThrow('does not support');
    expect(() =>
      validateTaskReasoning('none', { reasoning: { mandatory: true, supportedEfforts: null } })
    ).toThrow('cannot turn it off');
  });
  it('preserves omission versus explicit Auto at both request boundaries', () => {
    const input = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      prompt: 'Analyse the sample'
    };
    expect(CreateTaskRequest.parse({ ...input, reasoningEffort: 'minimal' }).reasoningEffort).toBe(
      'minimal'
    );
    expect(ContinueTaskRequest.parse({ prompt: 'Continue' }).reasoningEffort).toBeUndefined();
    expect(
      ContinueTaskRequest.parse({ prompt: 'Continue', reasoningEffort: 'auto' }).reasoningEffort
    ).toBe('auto');
    expect(CreateTaskRequest.safeParse({ ...input, reasoningEffort: 'made-up' }).success).toBe(
      false
    );
  });
});
