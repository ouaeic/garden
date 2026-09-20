import { randomUUID } from 'node:crypto';
import {
  AthanorError,
  capabilityAudience,
  capabilityAudiences,
  redactText,
  signCapabilityToken
} from '@athanor/core';

type Role = 'control' | 'agent' | 'user';

const explainedRunnerErrors = new Set([
  'runner_request_failed',
  'runner_invalid_request',
  'file_not_found',
  'browser_bot_wall',
  'checkpoint_host_disk_full',
  'checkpoint_workspace_too_large'
]);

function rejectedRequest(status: number, body: string): AthanorError {
  let explained: { code: string; message: string } | undefined;
  try {
    const value = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } } | null;
    const error = value?.error;
    if (
      typeof error?.code === 'string' &&
      explainedRunnerErrors.has(error.code) &&
      typeof error.message === 'string' &&
      error.message.trim()
    )
      explained = { code: error.code, message: redactText(error.message).slice(0, 1000) };
  } catch {
    // Proxy pages and malformed upstream bodies are not owner-facing explanations.
  }
  return new AthanorError(
    explained?.code ?? 'workspace_request_rejected',
    explained?.message ?? 'The workspace rejected this request. Refresh its status and try again.',
    status
  );
}

export class RunnerClient {
  constructor(
    readonly baseUrl: string,
    private readonly secret: string
  ) {}

  /**
   * `audience` binds the token to the request it is for, so a token observed in flight cannot be
   * turned against another runner route. It is mandatory, and the runner refuses a token that names
   * none: it used to be omitted for the stream credentials the client spends on several calls in a
   * row - a browser takeover is a stream, an action and a holder change - on the reasoning that one
   * audience would break the flow, and the effect was that those two credentials were bearer tokens
   * for every route their scopes admitted, `browser/read-many` (which fetches an arbitrary address)
   * and `browser/search` among them. Naming all three routes is the narrowest binding available
   * while the client asks for one credential and uses it three ways.
   */
  token(
    workspaceId: string,
    userId: string,
    role: Role,
    scopes: string[],
    ttlSeconds: number,
    audience: { method: string; path: string } | ReadonlyArray<{ method: string; path: string }>
  ): string {
    return signCapabilityToken(
      {
        sub: userId,
        workspaceId,
        role,
        scopes,
        aud: Array.isArray(audience)
          ? capabilityAudiences(audience)
          : capabilityAudience(
              (audience as { method: string; path: string }).method,
              (audience as { method: string; path: string }).path
            ),
        nonce: randomUUID()
      },
      this.secret,
      ttlSeconds
    );
  }

  async request<T>(input: {
    workspaceId: string;
    userId: string;
    role: Role;
    scopes: string[];
    path: string;
    method?: string;
    body?: BodyInit;
    contentType?: string;
    headers?: Record<string, string>;
    acceptAnyStatus?: boolean;
    redirect?: RequestRedirect;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    const response = await this.raw(input);
    const contentType = response.headers.get('content-type') ?? '';
    return (
      contentType.includes('application/json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer())
    ) as T;
  }

  /**
   * `timeoutMs` is opt-in because most runner routes are legitimately slow - a build under `exec`,
   * a whole-machine export - and undici's 300 s header timeout is the right ceiling for those. It
   * exists for the calls a person is waiting behind, where a runner that has stopped answering
   * should degrade to a stale figure in seconds rather than hold a response open for five minutes.
   */
  async raw(input: {
    workspaceId: string;
    userId: string;
    role: Role;
    scopes: string[];
    path: string;
    method?: string;
    body?: BodyInit;
    contentType?: string;
    headers?: Record<string, string>;
    acceptAnyStatus?: boolean;
    redirect?: RequestRedirect;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<Response> {
    const method = input.method ?? 'GET';
    const signals = [
      input.signal,
      input.timeoutMs === undefined ? undefined : AbortSignal.timeout(input.timeoutMs)
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const response = await fetch(`${this.baseUrl}${input.path}`, {
      method,
      headers: {
        ...input.headers,
        authorization: `Bearer ${this.token(input.workspaceId, input.userId, input.role, input.scopes, 60, { method, path: input.path })}`,
        ...(input.contentType ? { 'content-type': input.contentType } : {})
      },
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.redirect ? { redirect: input.redirect } : {}),
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {})
    });
    if (!response.ok && !input.acceptAnyStatus) {
      // The upstream body is quoted because it is usually the only description of what went wrong,
      // and scrubbed because it is a response the agent's own code may have written.
      const error = await response.text().catch(() => '');
      if ((response.status >= 400 && response.status < 500) || response.status === 507)
        throw rejectedRequest(response.status, error);
      throw new Error(
        `Workspace runtime returned ${response.status}${error ? `: ${redactText(error).slice(0, 250)}` : ''}`
      );
    }
    return response;
  }
}
