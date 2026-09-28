import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@garden/contracts';
import { createQuestionAnswerSender } from './task-actions.js';

describe('answer delivery', () => {
  it('joins simultaneous clicks and reuses the same identity after an uncertain delivery', async () => {
    const write = vi
      .fn<(task: string, prompt: string, key: string) => Promise<Task>>()
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValue({ id: 'task' } as Task);
    const send = createQuestionAnswerSender(write);
    const first = send('task', 'question', 'A note');
    expect(send('task', 'question', 'A note')).toBe(first);
    await expect(first).rejects.toThrow('Connection lost');
    await send('task', 'question', 'A note');
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]![2]).toBe(write.mock.calls[1]![2]);
    await send('task', 'question', 'A note');
    expect(write).toHaveBeenCalledTimes(2);
    await send('task', 'next-question', 'A note');
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[2]![2]).not.toBe(write.mock.calls[1]![2]);
  });
});
