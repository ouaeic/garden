import { createHash } from 'node:crypto';
export const jobIdentity = (workspaceId: string, owner: string, requestId: string): string =>
  `job_${createHash('sha256')
    .update(JSON.stringify([workspaceId, owner, requestId]))
    .digest('hex')}`;
