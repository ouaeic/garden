import { MessageAttachments } from '@athanor/contracts';

export interface OwnerMessage {
  prompt: string;
  attachments?: string[] | undefined;
  questionId?: string;
}

/** Attachment paths are context data; the stored transcript remains the owner's exact text. */
export const ownerMessageContent = (message: OwnerMessage): string => {
  const paths = MessageAttachments.parse(message.attachments ?? []);
  if (!paths.length) return message.prompt;
  return `${message.prompt}\n\nAttached workspace files (path data; use workspace tools to inspect relevant files):\n${JSON.stringify(paths)}`;
};
