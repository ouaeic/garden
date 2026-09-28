export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly details?: unknown,
    readonly requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions extends RequestInit {
  /** Writes retry only when the caller knows this route enforces idempotency. */
  retry?: number;
  idempotencyKey?: string;
}

let nativeGateway = false;
let nativeServer: string | null = null;
let nativePreview: { remote: string; local: string } | null = null;

export const nativeServerOrigin = (): string | null => nativeServer;
export const nativePreviewOrigins = (): Readonly<{ remote: string; local: string }> | null =>
  nativePreview;

export const isNativeClient = (): boolean =>
  nativeGateway || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);

/** The native shell proxies the same paths and translates cookies at its local origin. */
export const apiUrl = (path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new ApiError('invalid_api_path', 'API requests must use a path on this server');
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const parsed = new URL(path, origin);
  if (parsed.origin !== origin)
    throw new ApiError('invalid_api_path', 'API requests must use a path on this server');
  return `${parsed.pathname}${parsed.search}`;
};

export const runnerUrlForClient = (advertised: string): string => {
  if (!isNativeClient() || typeof window === 'undefined') return advertised;
  const url = new URL(advertised);
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${url.pathname.replace(/\/$/, '')}`;
};

export const waitForRetry = (milliseconds: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const reason: unknown = signal?.reason;
      reject(
        reason instanceof Error ? reason : new DOMException('Request cancelled', 'AbortError')
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export const responseError = async (response: Response): Promise<ApiError> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const fields = object(object(body).error);
  return new ApiError(
    typeof fields.code === 'string' ? fields.code : 'request_failed',
    typeof fields.message === 'string'
      ? fields.message
      : `The server could not complete this request (${response.status})`,
    response.status,
    body,
    typeof fields.requestId === 'string' ? fields.requestId : undefined
  );
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { retry, idempotencyKey, ...init } = options;
  const method = (init.method ?? 'GET').toUpperCase();
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (writing && !headers.has('Idempotency-Key'))
    headers.set('Idempotency-Key', idempotencyKey ?? crypto.randomUUID());
  const attempts = Math.max(0, Math.min(4, Math.floor(retry ?? (writing ? 0 : 2))));
  const url = apiUrl(path);
  for (let attempt = 0; ; attempt += 1) {
    init.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, { ...init, method, headers, credentials: 'include' });
    } catch (cause) {
      if (init.signal?.aborted) throw cause;
      if (attempt < attempts) {
        await waitForRetry(300 * 2 ** attempt, init.signal);
        continue;
      }
      throw new ApiError('connection_failed', 'The connection was interrupted. Try again.', 0);
    }
    const local = typeof window === 'undefined' ? undefined : window.location;
    if (
      response.headers.get('x-garden-native-client') === '1' &&
      local?.protocol === 'http:' &&
      local.hostname === 'localhost'
    ) {
      nativeGateway = true;
      nativeServer = null;
      nativePreview = null;
      try {
        const value = response.headers.get('x-garden-server-origin') ?? '';
        const origin = new URL(value);
        if (
          origin.protocol === 'https:' &&
          origin.origin === value &&
          !origin.username &&
          !origin.password
        )
          nativeServer = value;
        const remoteValue = response.headers.get('x-garden-preview-origin') ?? '';
        const localValue = response.headers.get('x-garden-preview-local-origin') ?? '';
        const remotePreview = new URL(remoteValue);
        const localPreview = new URL(localValue);
        if (
          nativeServer &&
          remotePreview.protocol === 'https:' &&
          remotePreview.origin === remoteValue &&
          remoteValue !== nativeServer &&
          !remotePreview.username &&
          !remotePreview.password &&
          localPreview.protocol === 'http:' &&
          localPreview.hostname === 'localhost' &&
          localPreview.origin === localValue &&
          localValue !== local.origin &&
          !localPreview.username &&
          !localPreview.password
        )
          nativePreview = { remote: remoteValue, local: localValue };
      } catch {
        // Missing or invalid connection metadata cannot authorize a preview origin rewrite.
      }
    }
    if (!response.ok) {
      const error = await responseError(response);
      const transient =
        [429, 502, 503, 504].includes(response.status) || error.code === 'operation_in_progress';
      if (transient && attempt < attempts) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await waitForRetry(
          retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 300 * 2 ** attempt,
          init.signal
        );
        continue;
      }
      throw error;
    }
    if (response.status === 204 || method === 'HEAD') return undefined as T;
    return (await response.json()) as T;
  }
}

type MutationOptions = Omit<RequestOptions, 'method' | 'body'>;

const mutate = <T>(method: string, path: string, body: unknown, options: MutationOptions = {}) => {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  return request<T>(path, {
    ...options,
    method,
    headers,
    body: JSON.stringify(body ?? {})
  });
};

export const get = <T>(path: string, options: RequestOptions = {}): Promise<T> =>
  request<T>(path, { ...options, method: 'GET' });
export const post = <T>(path: string, body?: unknown, options?: MutationOptions): Promise<T> =>
  mutate<T>('POST', path, body, options);
export const patch = <T>(path: string, body?: unknown, options?: MutationOptions): Promise<T> =>
  mutate<T>('PATCH', path, body, options);
export const put = <T>(path: string, body?: unknown, options?: MutationOptions): Promise<T> =>
  mutate<T>('PUT', path, body, options);
export const del = <T>(path: string, body?: unknown, options?: MutationOptions): Promise<T> =>
  mutate<T>('DELETE', path, body, options);
