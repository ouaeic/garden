import { TASK_TITLE_MAX_LENGTH } from '@garden/contracts';
import { buildConversationNameIndex, decryptJson, encryptJson, memoryIndexKey } from '@garden/core';
import type { ToolContext } from './tool-dispatch.js';

/** Reuses a headline already written by the agent, preserving an owner's explicit name in SQL. */
export async function applyPresentationTitle(
  context: Pick<ToolContext, 'task' | 'key' | 'store'>,
  title: string
): Promise<boolean> {
  const name = title.replace(/\s+/g, ' ').trim();
  if (!name || name.length > TASK_TITLE_MAX_LENGTH) return false;
  const { task, key } = context;
  const prompt = decryptJson<{ prompt: string }>(
    task.promptCiphertext,
    key,
    `task-prompt:${task.workspaceId}`
  ).prompt;
  return context.store.setGeneratedTaskTitle(
    task.id,
    encryptJson({ title: name }, key, `task-title:${task.workspaceId}`),
    buildConversationNameIndex(name, prompt, memoryIndexKey(key))
  );
}
