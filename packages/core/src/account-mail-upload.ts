import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type AccountApi, accountResourceId, accountResponseObject } from './account-api.js';
import type { AccountMailComposition, MailCheckpoint } from './account-mail-compose.js';
import { GardenError } from './errors.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = z.record(z.string(), z.unknown());
const chunkBytes = 3 * 1024 * 1024;

/** Reconcile an ambiguous attachment by identity and bytes, never by filename alone. */
async function attached(api: AccountApi, path: string, contentId: string, bytes: Buffer) {
  const page = await api.json(
    api.url('graph', path, { $select: 'id,contentId,name,size', $top: '100' })
  );
  if (page['@odata.nextLink']) return false;
  const matches = z
    .array(object)
    .parse(page.value)
    .filter((row) => row.contentId === contentId);
  if (matches.length !== 1) return false;
  const id = accountResourceId.parse(matches[0]!.id);
  const actual = await api.request(api.url('graph', `${path}/${encodeURIComponent(id)}/$value`), {
    maxBytes: 10_000_000
  });
  return actual.body.length === bytes.length && hash(actual.body) === hash(bytes);
}

export async function attachAccountMailFiles(
  api: AccountApi,
  files: AccountMailComposition['attachments'],
  initial: MailCheckpoint,
  checkpoint: (value: MailCheckpoint) => Promise<void>
): Promise<boolean> {
  let state = initial;
  const save = async (next: MailCheckpoint) => {
    await checkpoint(next);
    state = next;
  };
  const rejected = async (error: unknown) => {
    if (
      error instanceof GardenError &&
      [400, 401, 403, 404, 413, 422, 429].includes(Number(error.details?.statusCode))
    ) {
      await save({ ...state, phase: 'attachments' });
      throw error;
    }
    return false;
  };
  const path = `messages/${encodeURIComponent(accountResourceId.parse(state.draftId))}/attachments`;
  for (let index = state.attachment; index < files.length; index++) {
    const file = files[index]!;
    const bytes = Buffer.from(file.contentBase64, 'base64');
    const contentId = `${state.operationId}.${index}@garden`;
    if (state.phase === 'attaching') {
      if (await attached(api, path, contentId, bytes)) {
        await save({ ...state, phase: 'attachments', attachment: index + 1, upload: undefined });
        continue;
      }
      // A POST without a receipt must not create a second attachment.
      if (!state.upload) return false;
    }
    await save({ ...state, phase: 'attaching', attachment: index });
    if (bytes.length < 3_000_000) {
      try {
        const result = await api.json(api.url('graph', path), {
          method: 'POST',
          body: {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: file.filename,
            contentType: file.contentType,
            contentId,
            isInline: false,
            contentBytes: file.contentBase64
          }
        });
        accountResourceId.parse(result.id);
      } catch (error) {
        return rejected(error);
      }
    } else {
      if (!state.upload) {
        let session;
        try {
          session = await api.json(api.url('graph', `${path}/createUploadSession`), {
            method: 'POST',
            body: {
              AttachmentItem: {
                attachmentType: 'file',
                name: file.filename,
                contentType: file.contentType,
                contentId,
                isInline: false,
                size: bytes.length
              }
            }
          });
        } catch (error) {
          return rejected(error);
        }
        await save({
          ...state,
          upload: {
            url: z.string().max(16384).parse(session.uploadUrl),
            expiresAt: z.iso.datetime({ offset: true }).parse(session.expirationDateTime),
            offset: 0,
            pending: false
          }
        });
      }
      if (Date.parse(state.upload!.expiresAt) <= Date.now()) return false;
      while (state.upload!.offset < bytes.length) {
        const { offset } = state.upload!;
        const end = Math.min(offset + chunkBytes, bytes.length);
        await save({ ...state, upload: { ...state.upload!, pending: true } });
        try {
          const result = await api.uploadMailRange(
            state.upload!.url,
            bytes.subarray(offset, end),
            offset,
            bytes.length
          );
          if (result.status === 201) {
            if (end !== bytes.length) return false;
            break;
          }
          const next = z
            .array(z.string())
            .length(1)
            .parse(accountResponseObject(result).nextExpectedRanges)[0]!;
          if (
            !/^\d+(?:-)?$/.test(next) ||
            Number.parseInt(next, 10) !== end ||
            end === bytes.length
          )
            return false;
          await save({ ...state, upload: { ...state.upload!, offset: end, pending: false } });
        } catch {
          return false;
        }
      }
    }
    await save({ ...state, phase: 'attachments', attachment: index + 1, upload: undefined });
  }
  return true;
}
