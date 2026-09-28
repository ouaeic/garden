import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WorkspacePreviewRecord } from '@garden/data';

const GRANT_SECONDS = 7 * 24 * 60 * 60;
type PreviewScope = Pick<WorkspacePreviewRecord, 'id' | 'workspaceId' | 'accessTokenHash'>;

const signature = (body: string, preview: PreviewScope, key: Uint8Array): Buffer =>
  createHmac('sha256', key)
    .update(
      `garden-preview-access\n${preview.id}\n${preview.workspaceId}\n${preview.accessTokenHash}\n${body}`
    )
    .digest();

/** Independent grants share the preview's revocation epoch, not each other's lifetime. */
export const issuePreviewAccess = (
  preview: PreviewScope,
  key: Uint8Array,
  now = Date.now()
): string => {
  if (key.byteLength !== 32) throw new Error('Preview access requires the instance signing key');
  const expiry = Math.floor(now / 1000) + GRANT_SECONDS;
  const body = `g1.${expiry.toString(36)}.${randomBytes(16).toString('base64url')}`;
  return `${body}.${signature(body, preview, key).toString('base64url')}`;
};

export const previewAccessExpiry = (token: string): number | null => {
  const parts = /^g1\.([0-9a-z]+)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!parts) return null;
  const seconds = Number.parseInt(parts[1]!, 36);
  return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
};

export const verifyPreviewAccess = (
  token: string,
  preview: PreviewScope,
  key: Uint8Array,
  now = Date.now()
): boolean => {
  if (key.byteLength !== 32 || token.length > 160) return false;
  const expiry = previewAccessExpiry(token);
  if (expiry === null || expiry <= now || expiry > now + GRANT_SECONDS * 1000) return false;
  const separator = token.lastIndexOf('.');
  const expected = signature(token.slice(0, separator), preview, key);
  const actual = Buffer.from(token.slice(separator + 1), 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
