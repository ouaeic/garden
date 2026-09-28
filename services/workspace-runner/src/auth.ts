import type { FastifyRequest } from 'fastify';
import { requireCapability, verifyCapabilityToken, type CapabilityTokenClaims } from '@garden/core';

declare module 'fastify' {
  interface FastifyRequest {
    capability: CapabilityTokenClaims;
  }
}

export const authenticateRunnerRequest = (secret: string) => {
  /*
   * Two ledgers, because they defend against different people.
   *
   * A capability nonce is single-use, so every verified request leaves an entry until it expires.
   * One shared map meant an unauthenticated flood on a published preview link - which mints a
   * `preview:<port>` capability per request, from anyone on the internet who has the link - filled
   * the only ledger there was, and once full every caller was refused: the agent's own file reads,
   * its shell commands, the owner's terminal. A public page could therefore stop the private
   * computer working, without a credential of any kind.
   *
   * Splitting them means preview traffic can only ever exhaust the preview ledger. The floods stop
   * previews, which is the thing the flood is aimed at anyway, and the agent carries on.
   */
  const consumedByPreview = new Map<string, number>();
  const consumedByAgent = new Map<string, number>();
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const protocols =
      request.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? [];
    const protocolToken = protocols[0] === 'garden-capability' ? protocols[1] : undefined;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : protocolToken;
    if (!token) throw new Error('Missing runner capability token');
    // The audience is the method and path the token was minted for. Passing it here is what makes
    // the claim real: without it `aud` was carried, documented and never compared, so a token
    // observed on a file read was still good against exec. `request.url` rather than the route
    // pattern, because the signer stamps the concrete path it is about to request; the query
    // string is the arguments of a call rather than its identity and is dropped on both sides.
    request.capability = verifyCapabilityToken(token, secret, {
      method: request.method,
      path: request.url
    });
    const routeWorkspace = (request.params as { workspaceId?: string }).workspaceId;
    if (routeWorkspace && routeWorkspace !== request.capability.workspaceId) {
      throw new Error('Capability token is bound to a different workspace');
    }
    const now = Math.floor(Date.now() / 1000);
    const servingPreview = request.capability.scopes.every((scope) => scope.startsWith('preview:'));
    const consumed = servingPreview ? consumedByPreview : consumedByAgent;
    if (consumed.has(request.capability.nonce)) {
      throw new Error('Capability token has already been consumed');
    }
    if (consumed.size >= 10_000) {
      for (const [nonce, expiry] of consumed) {
        if (expiry <= now) consumed.delete(nonce);
      }
      if (consumed.size >= 10_000) {
        throw new Error('Capability verifier is temporarily saturated');
      }
    }
    consumed.set(request.capability.nonce, request.capability.exp);
  };
};

export const requireScope = (request: FastifyRequest, scope: string): void =>
  requireCapability(request.capability, scope);
