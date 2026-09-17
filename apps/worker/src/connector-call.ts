/**
 * Reaching a connected service on the owner's behalf.
 *
 * A connector action is the one tool call that leaves the box carrying the owner's own credential,
 * so what goes out and what comes back are both bounded here: which hosts the kind may reach, how
 * large an outgoing attachment may be, and where a saved attachment is allowed to land.
 *
 * The attachment path rules are in this file rather than in the workspace tools because the
 * decision is about mail, not about files: a filename chosen by whoever sent the message is
 * untrusted input, and the destination it resolves to is the only thing standing between that name
 * and the rest of the workspace.
 *
 * Lifted out of `agent.ts` unchanged by Wave 7.1.
 */
import { AthanorError, isMailConnectorKind, sha256, type AnyConnectorKind } from '@athanor/core';
import { labelledConnectorResult } from './provenance.js';
import { asRecord, textValue } from './values.js';

/**
 * The hosts one connector call is allowed to reach.
 *
 * CONNECTOR_ALLOWED_HOST_SUFFIXES is a deployment restriction and ships empty, and an empty list
 * matches no host at all - so on a default install every GitHub, WebDAV and MCP call was refused at
 * execution by the same check the connector had already passed when it was created, because the API
 * appends the connector's own host there and this did not. Mail and calendar are deliberately left
 * with the deployment list alone: their guard reads an empty list as "the owner's own choice
 * stands", and a mailbox's submission host is routinely a different name from its IMAP host, so
 * pinning the one would refuse the other.
 */
export const connectorHostAllowance = (
  configured: string,
  connector: { kind: AnyConnectorKind; baseUrl: string }
): string[] => {
  const deployment = configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (isMailConnectorKind(connector.kind)) return deployment;
  try {
    return [...deployment, new URL(connector.baseUrl).hostname];
  } catch {
    return deployment;
  }
};

/** The mail actions that can carry files out; each one takes workspace paths, never bytes. */
const MAIL_COMPOSING_ACTIONS = new Set(['mail_draft', 'mail_send', 'mail_reply']);

/**
 * Attachments arrive at this tool as workspace paths and leave it as bytes.
 *
 * The connector layer takes base64, which is the right shape for a protocol and the wrong shape for
 * a tool call: a 2 MB PDF is 2.7 million characters of context the model would have to emit
 * correctly, so in practice nothing could ever be attached. The model names files it can see, and
 * the worker reads them.
 */
export const mailAttachmentPaths = (input: Record<string, unknown>, action: string): string[] =>
  MAIL_COMPOSING_ACTIONS.has(action) && Array.isArray(input.attachments)
    ? input.attachments.flatMap((entry) => (typeof entry === 'string' && entry ? [entry] : []))
    : [];

/** Total decoded size one message may carry out, matching the connector layer's own ceiling. */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 10_000_000;

const MAIL_ATTACHMENT_DIRECTORY = 'workspace/mail';

/**
 * Where an attachment the agent read is written.
 *
 * The filename came out of the message, so it never decides a path on its own: it is reduced to one
 * plain segment under a fixed directory, and anything the sender put in it that looks like a
 * directory, a traversal or a shell name is gone before it is used. The model can name a
 * destination instead, which is the ordinary case - it usually knows where the file belongs.
 */
export const attachmentDestination = (saveTo: string, filename: string, uid: unknown): string => {
  const chosen = saveTo.trim();
  if (chosen) return chosen;
  const safe = (filename.split(/[\\/]/).pop() ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  const message = Number(uid);
  const identity =
    Number.isSafeInteger(message) && message > 0
      ? message
      : typeof uid === 'string' && /^[a-f0-9]{16}$/.test(uid)
        ? uid
        : 'message';
  return `${MAIL_ATTACHMENT_DIRECTORY}/${identity}-${safe || 'attachment'}`;
};

/**
 * The attachment result the model sees: where the file is, never what is in it.
 *
 * The bytes are already in the workspace by the time this runs, and putting them in the transcript
 * as well would cost the window a megabyte to say nothing the path does not. The envelope the
 * connector layer wrapped the result in is kept exactly as it arrived - it is what says the content
 * came from outside.
 */
export const attachmentSavedResult = (result: unknown, path: string): unknown => {
  const envelope = asRecord(result);
  const content = asRecord(envelope?.content);
  if (!envelope || !content) return result;
  const rest = Object.fromEntries(
    Object.entries(content).filter(([field]) => field !== 'contentBase64')
  );
  return {
    ...envelope,
    content: {
      ...rest,
      path,
      note: 'The attachment is now a workspace file. Open it with document_read or image_read rather than asking for it again.'
    }
  };
};

/**
 * The connector call itself: workspace files in, a result the model can use out.
 *
 * Kept apart from the store bookkeeping around it - the secret, the audit row, the policy - so that
 * the half with judgement in it can be exercised without a mailbox on the other end: which files
 * leave the computer, which bytes land on it, and what is labelled as somebody else's words.
 */
export const performConnectorAction = async (input: {
  connectorId: string;
  kind: AnyConnectorKind;
  action: string;
  requested: Record<string, unknown>;
  readFile: (path: string) => Promise<{ mimeType: string; bytes: Buffer }>;
  writeFile: (path: string, bytes: Buffer) => Promise<unknown>;
  execute: (actionInput: Record<string, unknown>) => Promise<unknown>;
}): Promise<unknown> => {
  const paths = mailAttachmentPaths(input.requested, input.action);
  const named = Array.isArray(input.requested.attachments) ? input.requested.attachments.length : 0;
  // Dropping the ones it could not read would send the message without them, which is the worst
  // available outcome: the recipient gets a covering letter promising a CV that is not there.
  if (MAIL_COMPOSING_ACTIONS.has(input.action) && named !== paths.length)
    throw new AthanorError(
      'mail_attachment_path_required',
      'Attachments are workspace file paths, as strings - write the file first and name its path.'
    );
  if (paths.length > 10)
    throw new AthanorError(
      'mail_attachments_too_many',
      'A message may carry at most 10 attachments. Send the rest as a private preview link.'
    );
  const attachments = [];
  let total = 0;
  for (const path of paths) {
    const file = await input.readFile(path);
    total += file.bytes.byteLength;
    // Checked here as well as in the connector layer so an oversized set is refused before the
    // mailbox is opened and a credential is used, and so the refusal names the files the model
    // chose rather than arriving as a protocol-level size error.
    if (total > MAX_OUTGOING_ATTACHMENT_BYTES)
      throw new AthanorError(
        'mail_attachments_too_large',
        `Attachments on one message may total at most 10 MB, and ${paths.join(', ')} exceed it. Send the large ones as a private preview link instead.`
      );
    attachments.push({
      filename: (path.split('/').filter(Boolean).pop() ?? 'attachment').slice(0, 200),
      contentType: file.mimeType,
      contentBase64: file.bytes.toString('base64')
    });
  }
  const result = await input.execute({
    ...input.requested,
    ...(attachments.length ? { attachments } : {}),
    action: input.action
  });
  const labelled = labelledConnectorResult(input.kind, input.action, result);
  if (!['mail_read_attachment', 'account_mail_attachment'].includes(input.action)) return labelled;
  const content = asRecord(asRecord(labelled)?.content);
  const encoded = content?.contentBase64;
  if (typeof encoded !== 'string')
    throw new AthanorError(
      'mail_content_invalid',
      'The mailbox omitted the requested attachment bytes.'
    );
  const bytes = Buffer.from(encoded, 'base64');
  const destination = attachmentDestination(
    textValue(input.requested.saveTo),
    textValue(content?.filename),
    sha256(
      JSON.stringify([
        input.connectorId,
        input.requested.mailbox,
        input.requested.uid,
        input.requested.messageId,
        input.requested.partId,
        sha256(bytes)
      ])
    ).slice(0, 16)
  );
  await input.writeFile(destination, bytes);
  return attachmentSavedResult(labelled, destination);
};
