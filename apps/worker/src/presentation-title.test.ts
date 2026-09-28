import { expect, it, vi } from 'vitest';
import { decryptJson, encryptJson } from '@garden/core';
import type { ToolContext } from './tool-dispatch.js';
import { applyPresentationTitle } from './presentation-title.js';

it('stores the complete model headline through the conditional generated-title writer without a model call', async () => {
  const key = Buffer.alloc(32, 7),
    title =
      'Japan rail itinerary with accessible hotels, regional food and a realistic daily travel budget';
  const write = vi.fn(async () => true);
  const context = {
    key,
    task: {
      id: 'task',
      workspaceId: 'workspace',
      promptCiphertext: encryptJson({ prompt: 'Plan Japan' }, key, 'task-prompt:workspace')
    },
    store: { setGeneratedTaskTitle: write }
  } as unknown as ToolContext;
  expect(await applyPresentationTitle(context, title)).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  const call = write.mock.calls[0] as unknown as [
    string,
    Parameters<typeof decryptJson>[0],
    unknown
  ];
  expect(decryptJson(call[1], key, 'task-title:workspace')).toEqual({ title });
  write.mockResolvedValueOnce(false);
  expect(await applyPresentationTitle(context, 'Late title')).toBe(false);
});
