import { describe, expect, it } from 'vitest';
import {
  assertConnectorUrl,
  beginMcpOAuth,
  completeMcpOAuth,
  connectorActions,
  connectorCatalog,
  connectorContentOrigin,
  connectorContentOrigins,
  executeConnectorAction,
  isPublicConnectorAddress,
  verifyConnector,
  type ConnectorSecret,
  type ConnectorRequestInput,
  type ConnectorTransport
} from './connectors.js';

const response = (body: unknown, status = 200) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  durationMs: 4
});

describe('connector security boundary', () => {
  it('rejects private destinations and unapproved connector origins', () => {
    expect(isPublicConnectorAddress('8.8.8.8')).toBe(true);
    expect(isPublicConnectorAddress('127.0.0.1')).toBe(false);
    expect(isPublicConnectorAddress('10.10.0.1')).toBe(false);
    expect(isPublicConnectorAddress('169.254.169.254')).toBe(false);
    expect(isPublicConnectorAddress('::1')).toBe(false);
    expect(isPublicConnectorAddress('fd00::1')).toBe(false);
    expect(() =>
      assertConnectorUrl(new URL('https://dav.example.test'), ['example.test'])
    ).not.toThrow();
    expect(() =>
      assertConnectorUrl(new URL('https://example.test.evil.test'), ['example.test'])
    ).toThrow('approved');
    expect(() => assertConnectorUrl(new URL('http://dav.example.test'), ['example.test'])).toThrow(
      'HTTPS'
    );
  });

  it('verifies GitHub without exposing the token and enforces scopes', async () => {
    const calls: ConnectorRequestInput[] = [];
    const transport: ConnectorTransport = async (input) => {
      calls.push(input);
      return response({ login: 'private-user' });
    };
    await expect(
      verifyConnector({
        kind: 'github',
        baseUrl: 'https://api.github.com',
        secret: { token: 'secret-token' },
        allowedHostSuffixes: [],
        transport
      })
    ).resolves.toEqual({ accountLabel: 'private-user', statusCode: 200 });
    expect(calls[0]?.url.toString()).toBe('https://api.github.com/user');
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-token');
    await expect(
      executeConnectorAction({
        kind: 'github',
        baseUrl: 'https://api.github.com',
        scopes: ['github:profile.read'],
        secret: { token: 'secret-token' },
        action: { action: 'github_list_repositories', limit: 5 },
        allowedHostSuffixes: [],
        transport
      })
    ).rejects.toThrow('has not granted');
  });

  it('returns a minimized GitHub repository result through the injected transport', async () => {
    const transport: ConnectorTransport = async () =>
      response([
        {
          name: 'project',
          full_name: 'owner/project',
          private: true,
          html_url: 'https://github.com/owner/project',
          default_branch: 'main',
          secret_provider_field: 'not-forwarded'
        }
      ]);
    const executed = await executeConnectorAction({
      kind: 'github',
      baseUrl: 'https://api.github.com',
      scopes: ['github:repository.read'],
      secret: { token: 'secret-token' },
      action: { action: 'github_list_repositories', limit: 5 },
      allowedHostSuffixes: [],
      transport
    });
    expect(executed).toMatchObject({
      action: 'github_list_repositories',
      result: [
        {
          name: 'project',
          fullName: 'owner/project',
          private: true,
          defaultBranch: 'main'
        }
      ],
      statusCode: 200
    });
    expect(executed.responseBytes).toBeGreaterThan(0);
  });

  it('discovers and calls remote MCP tools through the bounded connector transport', async () => {
    const methods: string[] = [];
    const transport: ConnectorTransport = async (input) => {
      if (input.method === 'DELETE') return response('', 200);
      const message = JSON.parse(Buffer.from(input.body ?? []).toString('utf8')) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.method) methods.push(message.method);
      if (message.method === 'notifications/initialized') return response('', 202);
      if (message.method === 'initialize')
        return {
          ...response({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'safe-tools', version: '1.0.0' }
            }
          }),
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'test-session'
          }
        };
      if (message.method === 'tools/list')
        return response({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'summarize',
                description: 'Summarize text',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text']
                },
                annotations: { readOnlyHint: true }
              }
            ]
          }
        });
      if (message.method === 'tools/call')
        return response({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'short summary' }], isError: false }
        });
      throw new Error(`Unexpected MCP request: ${message.method}`);
    };

    await expect(
      verifyConnector({
        kind: 'mcp_http',
        baseUrl: 'https://mcp.example.test/tools',
        secret: { token: 'secret-token' },
        allowedHostSuffixes: ['example.test'],
        transport
      })
    ).resolves.toEqual({ accountLabel: 'safe-tools', statusCode: 200 });

    const listed = await executeConnectorAction({
      kind: 'mcp_http',
      baseUrl: 'https://mcp.example.test/tools',
      scopes: ['mcp:tools.read'],
      secret: { token: 'secret-token' },
      action: { action: 'mcp_list_tools' },
      allowedHostSuffixes: ['example.test'],
      transport
    });
    expect(listed.result).toMatchObject({
      tools: [{ name: 'summarize', annotations: { readOnlyHint: true } }]
    });

    const called = await executeConnectorAction({
      kind: 'mcp_http',
      baseUrl: 'https://mcp.example.test/tools',
      scopes: ['mcp:tools.execute'],
      secret: { token: 'secret-token' },
      action: {
        action: 'mcp_call_tool',
        tool: 'summarize',
        arguments: { text: 'Long report' }
      },
      allowedHostSuffixes: ['example.test'],
      transport
    });
    expect(called.result).toMatchObject({
      content: [{ type: 'text', text: 'short summary' }],
      isError: false
    });
    expect(methods).toContain('tools/list');
    expect(methods).toContain('tools/call');
  });

  it('uses MCP OAuth discovery, PKCE, dynamic registration, code exchange, and durable refresh', async () => {
    const requests: ConnectorRequestInput[] = [];
    let bearer = '';
    let registrations = 0;
    const oauthTransport: ConnectorTransport = async (input) => {
      requests.push(input);
      const path = input.url.pathname;
      if (path.startsWith('/.well-known/oauth-protected-resource'))
        return response({
          resource: 'https://mcp.example.test/tools',
          authorization_servers: ['https://mcp.example.test'],
          scopes_supported: ['tools.read', 'offline_access']
        });
      if (path === '/.well-known/oauth-authorization-server')
        return response({
          issuer: 'https://mcp.example.test',
          authorization_endpoint: 'https://mcp.example.test/authorize',
          token_endpoint: 'https://mcp.example.test/token',
          registration_endpoint: 'https://mcp.example.test/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          client_id_metadata_document_supported: true
        });
      if (path === '/register') {
        registrations += 1;
        return response({
          client_id: 'athanor-test',
          client_secret: 'registered-secret',
          token_endpoint_auth_method: 'client_secret_basic',
          redirect_uris: ['https://app.example.test/v1/connectors/mcp/oauth/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: 'athanor'
        });
      }
      if (path === '/token') {
        const parameters = new URLSearchParams(Buffer.from(input.body ?? []).toString('utf8'));
        if (parameters.get('grant_type') === 'authorization_code') {
          expect(parameters.get('code')).toBe('one-time-code');
          expect(parameters.get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
          return response({
            access_token: 'old-token',
            token_type: 'bearer',
            refresh_token: 'refresh-one'
          });
        }
        expect(parameters.get('grant_type')).toBe('refresh_token');
        expect(parameters.get('refresh_token')).toBe('refresh-one');
        return response({
          access_token: 'new-token',
          token_type: 'bearer',
          refresh_token: 'refresh-two'
        });
      }
      if (input.method === 'DELETE') return response('', 200);
      const message = JSON.parse(Buffer.from(input.body ?? []).toString('utf8')) as {
        id?: string | number;
        method?: string;
      };
      bearer = input.headers.authorization ?? '';
      if (bearer === 'Bearer old-token')
        return {
          ...response({ error: 'expired' }, 401),
          headers: {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer scope="tools.read"'
          }
        };
      expect(bearer).toBe('Bearer new-token');
      if (message.method === 'initialize')
        return {
          ...response({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'oauth-tools', version: '1.0.0' }
            }
          }),
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'oauth-session'
          }
        };
      if (message.method === 'notifications/initialized') return response('', 202);
      if (message.method === 'tools/list')
        return response({
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [] }
        });
      throw new Error(`Unexpected OAuth MCP request: ${message.method}`);
    };

    const started = await beginMcpOAuth({
      baseUrl: 'https://mcp.example.test/tools',
      redirectUrl: 'https://app.example.test/v1/connectors/mcp/oauth/callback',
      state: 'one-time-state-that-is-long-enough',
      scope: 'tools.read offline_access',
      transport: oauthTransport
    });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(
      'https://mcp.example.test/authorize'
    );
    expect(authorization.searchParams.get('state')).toBe('one-time-state-that-is-long-enough');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorization.searchParams.get('resource')).toBe('https://mcp.example.test/tools');
    expect(started.authorizationUrl).not.toContain(
      started.secret.mcpOAuth?.codeVerifier ?? 'missing-verifier'
    );
    expect(registrations).toBe(1);

    const completed = await completeMcpOAuth({
      baseUrl: 'https://mcp.example.test/tools',
      secret: started.secret,
      authorizationCode: 'one-time-code',
      transport: oauthTransport
    });
    expect(completed.mcpOAuth?.tokens).toMatchObject({
      access_token: 'old-token',
      refresh_token: 'refresh-one'
    });
    expect(completed.mcpOAuth?.state).toBeUndefined();
    expect(completed.mcpOAuth?.codeVerifier).toBeUndefined();

    let persisted: ConnectorSecret | undefined;
    await expect(
      executeConnectorAction({
        kind: 'mcp_http',
        baseUrl: 'https://mcp.example.test/tools',
        scopes: ['mcp:tools.read'],
        secret: completed,
        action: { action: 'mcp_list_tools' },
        allowedHostSuffixes: ['example.test'],
        transport: oauthTransport,
        onSecretUpdated: async (updated) => {
          persisted = structuredClone(updated);
        }
      })
    ).resolves.toMatchObject({
      action: 'mcp_list_tools',
      result: { tools: [] }
    });
    expect(persisted?.mcpOAuth?.tokens).toMatchObject({
      access_token: 'new-token',
      refresh_token: 'refresh-two'
    });
    expect(
      requests.filter(
        (request) =>
          request.url.pathname === '/token' &&
          new URLSearchParams(Buffer.from(request.body ?? []).toString('utf8')).get(
            'grant_type'
          ) === 'refresh_token'
      )
    ).toHaveLength(1);

    const metadataClientUrl = 'https://app.example.test/v1/connectors/mcp/oauth/client-metadata';
    const metadataClient = await beginMcpOAuth({
      baseUrl: 'https://mcp.example.test/tools',
      redirectUrl: 'https://app.example.test/v1/connectors/mcp/oauth/callback',
      clientMetadataUrl: metadataClientUrl,
      state: 'another-one-time-state-that-is-long-enough',
      scope: 'tools.read',
      transport: oauthTransport
    });
    expect(new URL(metadataClient.authorizationUrl).searchParams.get('client_id')).toBe(
      metadataClientUrl
    );
    expect(registrations).toBe(1);
  });

  it('refuses MCP OAuth servers that do not advertise S256 PKCE', async () => {
    const transport: ConnectorTransport = async (input) => {
      if (input.url.pathname.startsWith('/.well-known/oauth-protected-resource'))
        return response({
          resource: 'https://mcp.example.test/tools',
          authorization_servers: ['https://auth.example.test']
        });
      if (input.url.pathname === '/.well-known/oauth-authorization-server')
        return response({
          issuer: 'https://auth.example.test',
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/token',
          response_types_supported: ['code']
        });
      throw new Error(`Unexpected non-PKCE request: ${input.url.toString()}`);
    };
    await expect(
      beginMcpOAuth({
        baseUrl: 'https://mcp.example.test/tools',
        redirectUrl: 'https://app.example.test/v1/connectors/mcp/oauth/callback',
        state: 'one-time-state-that-is-long-enough',
        clientId: 'pre-registered-client',
        transport
      })
    ).rejects.toThrow('S256 PKCE');
  });

  it('rejects malformed OAuth input before discovery', async () => {
    await expect(
      beginMcpOAuth({
        baseUrl: 'not a url',
        redirectUrl: 'https://app.example.test/v1/connectors/mcp/oauth/callback',
        state: 'one-time-state-that-is-long-enough'
      })
    ).rejects.toThrow('not a valid URL');
    await expect(
      beginMcpOAuth({
        baseUrl: 'https://mcp.example.test/tools',
        redirectUrl: 'not a callback',
        state: 'one-time-state-that-is-long-enough'
      })
    ).rejects.toThrow('not a valid URL');
    await expect(
      beginMcpOAuth({
        baseUrl: 'https://mcp.example.test/tools',
        redirectUrl: 'https://app.example.test/v1/connectors/mcp/oauth/callback',
        clientMetadataUrl: 'not metadata',
        state: 'one-time-state-that-is-long-enough'
      })
    ).rejects.toThrow('not a valid URL');
    await expect(
      beginMcpOAuth({
        baseUrl: 'https://mcp.example.test/tools',
        redirectUrl: 'https://app.example.test/v1/connectors/mcp/oauth/callback',
        state: 'short'
      })
    ).rejects.toThrow('32 to 512');
  });
});

describe('what a connector read is, for the label that travels with it', () => {
  it('names every kind the catalogue can offer, explicitly', () => {
    // The table is total over the kind union, so this cannot silently miss one: a connector added
    // without an entry stops the package compiling. This holds the catalogue to the same line.
    // The count is the assertion an empty catalogue has to answer: emptying `connectorCatalog` -
    // every connectable service the product offers - once broke one test in this package out of
    // 249, and this was one of the 248.
    expect(connectorCatalog.length).toBeGreaterThan(0);
    for (const definition of connectorCatalog)
      expect(Object.keys(connectorContentOrigins), definition.kind).toContain(definition.kind);
  });

  it('reads the same for every action of the same kind', () => {
    const kinds = new Set(Object.values(connectorActions).flatMap((action) => action.kinds));
    expect(kinds.size).toBeGreaterThan(0);
    // Every read through a connector is content somebody who is not the owner wrote — an issue
    // body, a mail, a file on a shared drive, an MCP response. The label does not vary by action.
    for (const kind of kinds) expect(connectorContentOrigin(kind)).toBeTruthy();
    expect(connectorContentOrigin('github')).toBe('github');
    expect(connectorContentOrigin('imap')).toBe('mailbox');
    expect(connectorContentOrigin('mcp_http')).toBe('mcp server');
  });

  it('still returns an origin for a kind this build has never heard of', () => {
    // Dropping the label is the one outcome that changes what the agent may do next, so a newer
    // box's connector is named by its own enum rather than left unlabelled.
    expect(connectorContentOrigin('something_new')).toBe('something_new');
  });
});

it('requires explicit repository read and write grants before delegating native Git', async () => {
  let calls = 0;
  const action = {
    action: 'github_git_push',
    requestId: '00000000-0000-4000-8000-000000000001',
    repositoryId: '00000000-0000-4000-8000-000000000002',
    revisionId: '00000000-0000-4000-8000-000000000003',
    owner: 'owner',
    repository: 'repository',
    branch: 'main',
    commit: 'a'.repeat(40),
    expectedHead: null
  };
  const common = {
    kind: 'github' as const,
    baseUrl: 'https://api.github.com',
    secret: { token: 'private-token' },
    action,
    allowedHostSuffixes: [],
    projectGit: async () => {
      calls++;
      return {
        action: 'github_git_push' as const,
        result: { state: 'running' },
        statusCode: 202,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: 0
      };
    }
  };
  await expect(
    executeConnectorAction({ ...common, scopes: ['github:repository.read'] })
  ).rejects.toThrow('has not granted');
  await expect(
    executeConnectorAction({ ...common, scopes: ['github:repository.write'] })
  ).rejects.toThrow('read access');
  expect(calls).toBe(0);
  await expect(
    executeConnectorAction({
      ...common,
      scopes: ['github:repository.read', 'github:repository.write']
    })
  ).resolves.toMatchObject({ result: { state: 'running' } });
  expect(calls).toBe(1);
  await expect(
    executeConnectorAction({
      kind: common.kind,
      baseUrl: common.baseUrl,
      secret: common.secret,
      action,
      allowedHostSuffixes: [],
      scopes: ['github:repository.read', 'github:repository.write']
    })
  ).rejects.toThrow('project conversation');
  expect(calls).toBe(1);
});
