import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply } from 'fastify';
import { GardenError } from '@garden/core';

/** Closing a browser download cancels both the HTTP body and the runner's file stream. */
export const downloadSignal = (reply: FastifyReply): AbortSignal => {
  const controller = new AbortController();
  const close = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  reply.raw.once('close', close);
  reply.raw.once('finish', () => reply.raw.removeListener('close', close));
  return controller.signal;
};

export const sendDownload = (reply: FastifyReply, response: Response) => {
  for (const header of [
    'content-type',
    'content-disposition',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified'
  ]) {
    const value = response.headers.get(header);
    if (value !== null) reply.header(header, value);
  }
  reply
    .code(response.status)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff');
  if (!response.body) {
    if (response.status === 416 || response.headers.get('content-length') === '0')
      return reply.send();
    throw new GardenError('download_unavailable', 'The download stream is unavailable');
  }
  return reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
};
