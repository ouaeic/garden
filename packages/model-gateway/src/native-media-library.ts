import type { PrivacyRoute } from '@garden/contracts';
import { isNativeOpenAIEndpoint, OPENAI_VIDEO_RETIREMENT_AT } from './openai-media-catalog.js';
import { mediaRecord } from './media-capabilities.js';
import { readBoundedMediaBody } from './media-output.js';
import { VideoClient } from './video.js';

export class NativeMediaSubmissionUncertainError extends Error {
  constructor(cause: unknown) {
    super(
      'The provider may have accepted this media operation. Reconcile it before submitting again.',
      { cause }
    );
    this.name = 'NativeMediaSubmissionUncertainError';
  }
}
export class NativeMediaProviderRejectionError extends Error {}
export const MAX_NATIVE_VIDEO_BATCH_BYTES = 8 * 1024 * 1024;
export const nativeMediaId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(value))
    throw new Error('Choose a valid provider media ID');
  return value;
};
export interface NativeVideoEntry {
  id: string;
  status: string;
  model: string | null;
  seconds: number | null;
  size: string | null;
  createdAt: number | null;
}
export interface NativeMediaBatch {
  id: string;
  status:
    | 'validating'
    | 'failed'
    | 'in_progress'
    | 'finalizing'
    | 'completed'
    | 'expired'
    | 'cancelling'
    | 'cancelled';
  inputFileId: string;
  outputFileId: string | null;
  errorFileId: string | null;
  counts: { total: number; completed: number; failed: number } | null;
}
const batch = (value: unknown): NativeMediaBatch => {
  if (
    !mediaRecord(value) ||
    ![
      'validating',
      'failed',
      'in_progress',
      'finalizing',
      'completed',
      'expired',
      'cancelling',
      'cancelled'
    ].includes(String(value.status))
  )
    throw new Error('The provider returned an invalid batch state');
  const counts = mediaRecord(value.request_counts) ? value.request_counts : null;
  return {
    id: nativeMediaId(value.id),
    status: value.status as NativeMediaBatch['status'],
    inputFileId: nativeMediaId(value.input_file_id),
    outputFileId: value.output_file_id ? nativeMediaId(value.output_file_id) : null,
    errorFileId: value.error_file_id ? nativeMediaId(value.error_file_id) : null,
    counts:
      counts &&
      ['total', 'completed', 'failed'].every(
        (key) => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0
      )
        ? {
            total: Number(counts.total),
            completed: Number(counts.completed),
            failed: Number(counts.failed)
          }
        : null
  };
};

/** The owner account is the only authority for library and reusable asset identifiers. */
export class NativeMediaLibraryClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      privacyRoute: PrivacyRoute;
      fetch?: typeof fetch;
    }
  ) {
    if (!isNativeOpenAIEndpoint(options.baseUrl))
      throw new Error('This operation requires the native OpenAI endpoint');
  }
  async #request(
    path: string,
    init: RequestInit,
    mutating: boolean,
    signal?: AbortSignal
  ): Promise<Response> {
    if (mutating && this.options.privacyRoute !== 'external')
      throw new Error('This media operation requires its own provider-retention approval');
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(
        `${this.options.baseUrl.replace(/\/$/, '')}/${path}`,
        {
          ...init,
          redirect: 'error',
          headers: { authorization: `Bearer ${this.options.apiKey}`, ...init.headers },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000)
        }
      );
    } catch (error) {
      if (mutating) throw new NativeMediaSubmissionUncertainError(error);
      throw error;
    }
    if (!response.ok) {
      const failure = new Error(`Native media operation failed (${response.status})`);
      if (mutating && (response.status >= 500 || response.status === 408))
        throw new NativeMediaSubmissionUncertainError(failure);
      if (mutating) throw new NativeMediaProviderRejectionError(failure.message);
      throw failure;
    }
    return response;
  }
  async #json(response: Response, mutating: boolean): Promise<unknown> {
    try {
      return JSON.parse((await readBoundedMediaBody(response, 4 * 1024 * 1024)).toString('utf8'));
    } catch (error) {
      if (mutating) throw new NativeMediaSubmissionUncertainError(error);
      throw error;
    }
  }
  async listVideos(
    input: { after?: string; limit?: number; signal?: AbortSignal } = {}
  ): Promise<{ videos: NativeVideoEntry[]; hasMore: boolean; nextAfter: string | null }> {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Choose a library page size from one to one hundred');
    const query = new URLSearchParams({ limit: String(limit), order: 'desc' });
    if (input.after) query.set('after', nativeMediaId(input.after));
    const result = await this.#json(
      await this.#request(`videos?${query}`, { method: 'GET' }, false, input.signal),
      false
    );
    if (
      !mediaRecord(result) ||
      !Array.isArray(result.data) ||
      result.data.length > limit ||
      typeof result.has_more !== 'boolean'
    )
      throw new Error('The provider returned an invalid video library');
    const videos = result.data.map((row): NativeVideoEntry => {
      if (!mediaRecord(row))
        throw new Error('The provider returned an invalid video library entry');
      return {
        id: nativeMediaId(row.id),
        status: String(row.status).slice(0, 32),
        model: typeof row.model === 'string' ? row.model.slice(0, 300) : null,
        seconds:
          Number.isFinite(Number(row.seconds)) && Number(row.seconds) > 0
            ? Number(row.seconds)
            : null,
        size: typeof row.size === 'string' && /^\d{2,4}x\d{2,4}$/.test(row.size) ? row.size : null,
        createdAt:
          typeof row.created_at === 'number' && Number.isFinite(row.created_at)
            ? row.created_at
            : null
      };
    });
    return {
      videos,
      hasMore: result.has_more,
      nextAfter: result.has_more ? (videos.at(-1)?.id ?? null) : null
    };
  }
  async deleteVideo(
    id: string,
    signal?: AbortSignal
  ): Promise<{ id: string; deleted: true; cancellationSupported: false }> {
    const checked = nativeMediaId(id);
    if (this.options.privacyRoute !== 'external')
      throw new Error('Library deletion requires explicit approval');
    const observed = await new VideoClient({ ...this.options, apiProtocol: 'openai' }).poll(
      checked,
      signal
    );
    if (observed.status !== 'completed')
      throw new Error(
        'Only a completed provider video can be deleted from the library; deletion does not cancel processing'
      );
    const value = await this.#json(
      await this.#request(`videos/${checked}`, { method: 'DELETE' }, true, signal),
      true
    );
    if (!mediaRecord(value) || value.id !== checked || value.deleted !== true)
      throw new NativeMediaSubmissionUncertainError(
        new Error('The provider did not confirm library deletion')
      );
    return { id: checked, deleted: true, cancellationSupported: false };
  }
  async createCharacter(input: {
    name: string;
    bytes: Buffer;
    signal?: AbortSignal;
  }): Promise<{ id: string; name: string }> {
    if (Date.now() >= Date.parse(OPENAI_VIDEO_RETIREMENT_AT))
      throw new NativeMediaProviderRejectionError('The provider has retired this native video API');
    const name = input.name.trim();
    if (!name || name.length > 200 || [...name].some((character) => character.charCodeAt(0) < 32))
      throw new Error('Choose a short character name');
    if (
      input.bytes.length < 12 ||
      input.bytes.length > 64 * 1024 * 1024 ||
      input.bytes.toString('ascii', 4, 8) !== 'ftyp'
    )
      throw new Error('Choose a bounded MP4 character reference');
    const body = new FormData();
    body.set('name', name);
    body.set(
      'video',
      new Blob([new Uint8Array(input.bytes)], { type: 'video/mp4' }),
      'character.mp4'
    );
    const value = await this.#json(
      await this.#request('videos/characters', { method: 'POST', body }, true, input.signal),
      true
    );
    try {
      if (!mediaRecord(value)) throw new Error('The provider returned no character');
      return { id: nativeMediaId(value.id), name };
    } catch (error) {
      throw new NativeMediaSubmissionUncertainError(error);
    }
  }
  async getCharacter(
    id: string,
    signal?: AbortSignal
  ): Promise<{ id: string; name: string | null }> {
    const expected = nativeMediaId(id);
    const value = await this.#json(
      await this.#request(`videos/characters/${expected}`, { method: 'GET' }, false, signal),
      false
    );
    if (!mediaRecord(value) || value.id !== expected)
      throw new Error('The provider returned a different character asset');
    return { id: expected, name: typeof value.name === 'string' ? value.name.slice(0, 200) : null };
  }
  async uploadBatch(input: { jsonl: string; signal?: AbortSignal }): Promise<{ id: string }> {
    if (!input.jsonl.trim() || Buffer.byteLength(input.jsonl) > MAX_NATIVE_VIDEO_BATCH_BYTES)
      throw new Error('Choose a bounded video batch');
    const lines = input.jsonl.trim().split('\n');
    if (lines.length > 100)
      throw new Error('A garden video batch supports at most one hundred shots');
    const ids = new Set<string>();
    for (const line of lines) {
      const value: unknown = JSON.parse(line);
      if (
        !mediaRecord(value) ||
        value.method !== 'POST' ||
        value.url !== '/v1/videos' ||
        !mediaRecord(value.body) ||
        typeof value.custom_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(value.custom_id) ||
        ids.has(value.custom_id)
      )
        throw new Error('Choose unique shot IDs and native video generation requests');
      ids.add(value.custom_id);
    }
    const body = new FormData();
    body.set('purpose', 'batch');
    body.set('expires_after[anchor]', 'created_at');
    body.set('expires_after[seconds]', '172800');
    body.set(
      'file',
      new Blob([input.jsonl], { type: 'application/jsonl' }),
      'garden-video-batch.jsonl'
    );
    const value = await this.#json(
      await this.#request('files', { method: 'POST', body }, true, input.signal),
      true
    );
    try {
      if (!mediaRecord(value)) throw new Error('The provider returned no batch file');
      return { id: nativeMediaId(value.id) };
    } catch (error) {
      throw new NativeMediaSubmissionUncertainError(error);
    }
  }
  async submitBatch(inputFileId: string, signal?: AbortSignal): Promise<NativeMediaBatch> {
    if (Date.now() >= Date.parse(OPENAI_VIDEO_RETIREMENT_AT))
      throw new NativeMediaProviderRejectionError('The provider has retired this native video API');
    const body = JSON.stringify({
      input_file_id: nativeMediaId(inputFileId),
      endpoint: '/v1/videos',
      completion_window: '24h',
      output_expires_after: { anchor: 'created_at', seconds: 86400 }
    });
    const value = await this.#json(
      await this.#request(
        'batches',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        true,
        signal
      ),
      true
    );
    try {
      return batch(value);
    } catch (error) {
      throw new NativeMediaSubmissionUncertainError(error);
    }
  }
  async readBatch(id: string, signal?: AbortSignal): Promise<NativeMediaBatch> {
    const expected = nativeMediaId(id);
    const result = batch(
      await this.#json(
        await this.#request(`batches/${expected}`, { method: 'GET' }, false, signal),
        false
      )
    );
    if (result.id !== expected) throw new Error('The provider returned a different media batch');
    return result;
  }
  async cancelBatch(id: string, signal?: AbortSignal): Promise<NativeMediaBatch> {
    const expected = nativeMediaId(id);
    const value = await this.#json(
      await this.#request(`batches/${expected}/cancel`, { method: 'POST' }, true, signal),
      true
    );
    try {
      const result = batch(value);
      if (result.id !== expected) throw new Error('The provider returned a different batch');
      return result;
    } catch (error) {
      throw new NativeMediaSubmissionUncertainError(error);
    }
  }
  async readBatchResults(fileId: string, signal?: AbortSignal): Promise<unknown[]> {
    const response = await this.#request(
      `files/${nativeMediaId(fileId)}/content`,
      { method: 'GET' },
      false,
      signal
    );
    const text = (await readBoundedMediaBody(response, 16 * 1024 * 1024)).toString('utf8').trim();
    const lines = text.split('\n');
    if (lines.length > 100) throw new Error('The provider returned too many batch results');
    return lines.map((line): unknown => JSON.parse(line));
  }
}
