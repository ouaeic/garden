import { afterEach, describe, expect, it, vi } from 'vitest';
import { AthanorError, verifyCapabilityToken } from '@athanor/core';
import { RunnerClient } from './runner-client.js';

const secret = 'runner-secret-with-at-least-32-characters';

afterEach(() => vi.unstubAllGlobals());

describe('runner capability requests', () => {
  it.each([400, 403, 404, 409, 410, 429, 507])(
    'preserves an actionable runtime rejection with status %s',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            {
              error: {
                code: 'runner_request_failed',
                message: 'Project history changed. Review a fresh archive preview.',
                requestId: 'private-runtime-correlation'
              }
            },
            { status }
          )
        )
      );
      await expect(
        new RunnerClient('http://runner.test', secret).request({
          workspaceId: 'workspace',
          userId: 'owner',
          role: 'user',
          scopes: ['project.updates.write'],
          path: '/archive',
          method: 'POST'
        })
      ).rejects.toMatchObject({
        name: 'AthanorError',
        statusCode: status,
        code: 'runner_request_failed',
        message: 'Project history changed. Review a fresh archive preview.'
      });
    }
  );

  it.each([
    '<html>Private proxy exception</html>',
    JSON.stringify({ error: { code: 'authentication_required', message: 'Private error text' } }),
    JSON.stringify({ error: { code: 'runner_request_failed', message: { private: 'object' } } }),
    'null'
  ])('does not expose an unrecognized runtime error body: %s', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 409 }))
    );
    await expect(
      new RunnerClient('http://runner.test', secret).request({
        workspaceId: 'workspace',
        userId: 'owner',
        role: 'user',
        scopes: ['project.updates.write'],
        path: '/archive'
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'workspace_request_rejected',
      message: 'The workspace rejected this request. Refresh its status and try again.'
    });
  });

  it('redacts and bounds a known runtime rejection before exposing it to the owner', async () => {
    const key = 'sk-live-01234567890abcdefgh';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'runner_request_failed',
              message: `OPENAI_KEY=${key} ${'x'.repeat(2000)}`
            }
          },
          { status: 409 }
        )
      )
    );
    const result = await new RunnerClient('http://runner.test', secret)
      .request({
        workspaceId: 'workspace',
        userId: 'owner',
        role: 'user',
        scopes: ['project.updates.write'],
        path: '/archive'
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AthanorError);
    const error = result as AthanorError;
    expect(error.statusCode).toBe(409);
    expect(error.message).not.toContain(key);
    expect(error.message).toContain('[REDACTED]');
    expect(error.message.length).toBeLessThanOrEqual(1000);
  });

  it('propagates browser cancellation without imposing a short lifetime on a large download', async () => {
    let observed: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        observed = init?.signal ?? undefined;
        return new Response('stream');
      })
    );
    const controller = new AbortController();
    const runner = new RunnerClient('http://runner.test', secret);
    await runner.raw({
      workspaceId: 'workspace',
      userId: 'owner',
      role: 'user',
      scopes: ['files.read'],
      path: '/download',
      signal: controller.signal
    });
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(false);
    controller.abort();
    expect(observed?.aborted).toBe(true);
  });
  it('binds the token it sends to the request it sends it with', async () => {
    let authorization = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        authorization = String(new Headers(init?.headers).get('authorization'));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const runner = new RunnerClient('http://runner.test', secret);
    await runner.request({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'control',
      scopes: ['files.read'],
      path: '/v1/workspaces/workspace-1/file?path=notes.md'
    });
    const claims = verifyCapabilityToken(authorization.slice('Bearer '.length), secret, {
      method: 'GET',
      path: '/v1/workspaces/workspace-1/file'
    });
    expect(claims.aud).toBe('GET /v1/workspaces/workspace-1/file');
    expect(() =>
      verifyCapabilityToken(authorization.slice('Bearer '.length), secret, {
        method: 'POST',
        path: '/v1/workspaces/workspace-1/exec'
      })
    ).toThrow('minted for a different request');
  });

  it('scrubs a secret out of an upstream failure before it becomes an error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('command failed: OPENAI_KEY=sk-live-01234567890abcdefgh not accepted', {
            status: 500
          })
      )
    );
    const runner = new RunnerClient('http://runner.test', secret);
    await expect(
      runner.request({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        role: 'agent',
        scopes: ['exec'],
        path: '/v1/workspaces/workspace-1/exec',
        method: 'POST'
      })
    ).rejects.toThrow(/Workspace runtime returned 500.*\[REDACTED\]/);
  });
});
