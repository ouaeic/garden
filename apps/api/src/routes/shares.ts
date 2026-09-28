/**
 * Share links: the owner's side, which mints and revokes, and the public side, which serves
 * ciphertext to whoever holds a link.
 *
 * The public side is the one unauthenticated content route on this box, and it is written so that
 * every one of its answers is either bytes nobody can read without the fragment of the link, or
 * one 404 that is the same 404 for a link that never existed, a link that expired, a link the owner
 * closed, a segment of the wrong shape, and a box with sharing switched off. `notFound` is the
 * single function all of those go through; there is no branch that answers differently.
 *
 * Nothing on this side reads a session. The request hook returns before the session lookup for
 * every route registered here as public (`publicShareRoutes` in `http/auth-hook.ts`), which is why
 * `request.user` is null on them and no `Set-Cookie` can appear on their answers.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateShareRequest,
  SHARE_TOKEN_PATTERN,
  type ShareBlob,
  type ShareRecord,
  type SharePreviewResponse
} from '@garden/contracts';
import { GardenError, sha256 } from '@garden/core';
import type { TaskShareRecord } from '@garden/data';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import {
  buildShareSnapshot,
  sealShareSnapshot,
  sharePreviewDigest,
  shareUrl
} from '../share-snapshot.js';
import {
  SHARE_VIEWER_FILES,
  defaultViewerDir,
  loadViewerAssets,
  shareDataHeaders,
  shareNotFoundHtml,
  shareViewerHeaders,
  shareViewerHtml,
  type ViewerAsset
} from '../share-viewer.js';

/**
 * How many ciphertext reads this process will serve in one minute, across every link it holds.
 *
 * The per-address throttle in the request hook bounds one caller; this bounds all of them, so a
 * link that was posted somewhere busy cannot turn the owner's own box into a file server for the
 * afternoon. Six hundred is ten a second, which is far more reading than any link this product
 * makes is for, and far less than a box can serve.
 */
export const SHARE_READS_PER_MINUTE = 600;

const shareRecord = (share: TaskShareRecord): ShareRecord => ({
  id: share.id,
  taskId: share.taskId,
  createdAt: share.createdAt,
  expiresAt: share.expiresAt,
  viewCount: share.viewCount,
  lastViewedAt: share.lastViewedAt,
  revokedAt: share.revokedAt,
  version: share.version
});

const expiryFrom = (days: 1 | 7 | 30 | null): Date | null =>
  days === null ? null : new Date(Date.now() + days * 86_400_000);

const ArtifactIndex = z.coerce.number().int().min(0).max(999);

export const registerShareRoutes = (context: RouteContext): void => {
  const { app, store, config, log, requireRecentStepUp, idempotent } = context;
  const sharingEnabled = (): boolean => config.SHARING_ENABLED ?? true;

  /** Loaded once, on the first request that needs them, from wherever the build put them. */
  let assets: Promise<Map<string, ViewerAsset>> | undefined;
  const viewerAssets = (): Promise<Map<string, ViewerAsset>> =>
    (assets ??= loadViewerAssets(config.SHARE_VIEWER_DIR ?? defaultViewerDir()));

  // --- the public side ------------------------------------------------------------------------

  const dataHeaders = (reply: FastifyReply): FastifyReply => {
    for (const [name, value] of shareDataHeaders) reply.header(name, value);
    return reply;
  };

  /**
   * The one answer for everything the public side will not serve. Called for the page and for
   * data alike; the only thing that varies is which of the two a caller was asking for, and a
   * caller asking for the page gets the same page whichever reason applies.
   */
  const notFound = (reply: FastifyReply, kind: 'page' | 'data'): FastifyReply => {
    dataHeaders(reply).status(404);
    if (kind === 'page') return reply.type('text/html; charset=utf-8').send(shareNotFoundHtml());
    return reply
      .type('application/json; charset=utf-8')
      .send({ error: { code: 'not_found', message: 'Not found' } });
  };

  /**
   * The lookup. The segment is checked against its one shape before anything is hashed, the hash
   * is looked up, and the stored hash is compared against the computed one in constant time - the
   * database already answered by equality, so the comparison is belt and braces, and it is the
   * same belt the preview gateway wears.
   */
  const liveShare = async (token: unknown): Promise<TaskShareRecord | null> => {
    if (!sharingEnabled()) return null;
    if (typeof token !== 'string' || !SHARE_TOKEN_PATTERN.test(token)) return null;
    const hash = sha256(token);
    const share = await store.findLiveShareByHash(hash);
    if (!share) return null;
    const expected = Buffer.from(share.lookupHash, 'utf8');
    const actual = Buffer.from(hash, 'utf8');
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
      ? share
      : null;
  };

  let readWindowStartedAt = 0;
  let readsInWindow = 0;
  /** True when this read is inside the box-wide budget; otherwise the caller answers 429. */
  const withinReadBudget = ():
    | { allowed: true }
    | { allowed: false; retryAfterSeconds: number } => {
    const now = Date.now();
    if (now - readWindowStartedAt >= 60_000) {
      readWindowStartedAt = now;
      readsInWindow = 0;
    }
    readsInWindow += 1;
    if (readsInWindow <= SHARE_READS_PER_MINUTE) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((readWindowStartedAt + 60_000 - now) / 1000))
    };
  };

  const overBudget = (reply: FastifyReply, retryAfterSeconds: number): FastifyReply =>
    dataHeaders(reply).status(429).header('retry-after', String(retryAfterSeconds)).send();

  app.get<{ Params: { token: string } }>('/v1/shares/:token', async (request, reply) => {
    const share = await liveShare(request.params.token);
    if (!share) return notFound(reply, 'page');
    for (const [name, value] of shareViewerHeaders) reply.header(name, value);
    return reply.type('text/html; charset=utf-8').send(shareViewerHtml(await viewerAssets()));
  });

  app.get<{ Params: { token: string } }>('/v1/shares/:token/blob', async (request, reply) => {
    const share = await liveShare(request.params.token);
    if (!share) return notFound(reply, 'data');
    const budget = withinReadBudget();
    if (!budget.allowed) return overBudget(reply, budget.retryAfterSeconds);
    // The read is the view. The page is fetched by things that are not readers - preview bots,
    // mail clients, a proxy checking a link - and none of them can open the ciphertext, so a
    // count taken here is closer to "somebody read this" than one taken on the page.
    await store.recordView(share.id);
    const artifacts = await store.listShareArtifactEnvelopes(share.id);
    const body: ShareBlob = {
      version: share.version,
      envelope: share.envelope,
      manifest: artifacts.map((artifact) => ({
        n: artifact.n,
        sizeBytes: artifact.sizeBytes,
        envelope: artifact.envelopeMeta
      }))
    };
    return dataHeaders(reply).type('application/json; charset=utf-8').send(body);
  });

  app.get<{ Params: { token: string; n: string } }>(
    '/v1/shares/:token/artifacts/:n',
    async (request, reply) => {
      const share = await liveShare(request.params.token);
      const index = ArtifactIndex.safeParse(request.params.n);
      if (!share || !index.success) return notFound(reply, 'data');
      const artifact = await store.getShareArtifact(share.id, index.data);
      if (!artifact) return notFound(reply, 'data');
      const budget = withinReadBudget();
      if (!budget.allowed) return overBudget(reply, budget.retryAfterSeconds);
      /*
       * Ciphertext, but headed as if it were the file: an attachment of an unnamed binary type,
       * `nosniff`, and a sandbox policy. They do nothing to bytes nobody can read, and everything
       * to a bug that ever ships plaintext through here - the same belt the owner's own artifact
       * route wears, for the same attack it records.
       */
      return dataHeaders(reply)
        .type('application/octet-stream')
        .header('content-disposition', `attachment; filename*=UTF-8''${index.data}.bin`)
        .header('content-security-policy', "sandbox; default-src 'none'")
        .send(artifact.ciphertext);
    }
  );

  app.get<{ Params: { file: string } }>('/v1/shares/assets/:file', async (request, reply) => {
    const name = request.params.file;
    if (!sharingEnabled() || !(name in SHARE_VIEWER_FILES)) return notFound(reply, 'data');
    const asset = (await viewerAssets()).get(name);
    if (!asset) return notFound(reply, 'data');
    // Immutable on a fixed name is honest only because the page names the file with its digest in
    // the query, so a rebuilt viewer is a new URL and a cached old one is never served for it.
    return reply
      .type(asset.type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .send(asset.bytes);
  });

  // --- the owner's side -----------------------------------------------------------------------

  const requireSharing = (): void => {
    if (!sharingEnabled())
      throw new GardenError('sharing_disabled', 'Sharing is turned off on this server', 403);
  };

  /** Mints a link for a built snapshot: seals it, stores the ciphertext, returns the key once. */
  const mint = async (
    request: FastifyRequest,
    userId: string,
    taskId: string,
    body: z.infer<typeof CreateShareRequest>,
    version: number
  ): Promise<{ share: ShareRecord; url: string }> => {
    const user = requireUser(request.user);
    const built = await buildShareSnapshot(context, user, taskId, {
      includeReasoning: body.includeReasoning,
      includeToolResults: body.includeToolResults,
      artifactIds: body.artifactIds,
      publicTitle: body.publicTitle
    });
    if (
      body.expectedPreviewDigest &&
      body.expectedPreviewDigest !== sharePreviewDigest(built.snapshot)
    )
      throw new GardenError(
        'preview_changed',
        'This work changed after you reviewed it. Review the snapshot again before creating a link.',
        409
      );
    const sealed = sealShareSnapshot(built);
    const share = await store.createShare({
      userId,
      taskId: built.task.id,
      workspaceId: built.workspace.id,
      lookupHash: sealed.lookupHash,
      envelope: sealed.envelope,
      manifest: sealed.manifest,
      snapshotBytes: sealed.snapshotBytes,
      expiresAt: expiryFrom(body.expiresInDays),
      version,
      artifacts: sealed.artifacts
    });
    log.info('share.created', {
      shareId: share.id,
      taskId: built.task.id,
      artifacts: sealed.artifacts.length,
      snapshotBytes: sealed.snapshotBytes,
      expiresAt: share.expiresAt
    });
    // The key leaves this process exactly once, inside the URL; `sealed` is dropped on return.
    return { share: shareRecord(share), url: shareUrl(sealed.id, sealed.key) };
  };

  /**
   * The exact document a link would carry, in the clear, for the owner to read before it exists.
   * Artifact bytes are verified and their hashes bind the review to the files a link would carry.
   */
  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/shares/preview',
    async (request): Promise<SharePreviewResponse> => {
      const user = requireUser(request.user);
      requireSharing();
      const body = CreateShareRequest.parse(request.body ?? {});
      const built = await buildShareSnapshot(context, user, request.params.taskId, {
        includeReasoning: body.includeReasoning,
        includeToolResults: body.includeToolResults,
        artifactIds: body.artifactIds,
        publicTitle: body.publicTitle
      });
      return { ...built.snapshot, previewDigest: sharePreviewDigest(built.snapshot) };
    }
  );

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/shares', async (request, reply) => {
    const user = requireUser(request.user);
    requireSharing();
    // A link is a capability over the owner's own transcript that anyone can spend, and the
    // step-up is the proof it was the owner at the keyboard who made one.
    await requireRecentStepUp(request, user);
    const body = CreateShareRequest.parse(request.body ?? {});
    return idempotent(request, reply, user, async () => {
      const created = await mint(request, user.id, request.params.taskId, body, 1);
      reply.header('cache-control', 'no-store');
      return created;
    });
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/shares', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new GardenError('task_not_found', 'Task not found', 404);
    return (await store.listSharesForTask(user.id, task.id)).map(shareRecord);
  });

  app.get('/v1/shares', async (request) => {
    const user = requireUser(request.user);
    return (await store.listShares(user.id)).map(shareRecord);
  });

  app.delete<{ Params: { shareId: string } }>('/v1/shares/:shareId', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const share = await store.getShareForOwner(user.id, request.params.shareId);
      if (!share) throw new GardenError('not_found', 'Share not found', 404);
      const revoked = await store.revokeShare(user.id, share.id);
      if (revoked) log.info('share.revoked', { shareId: share.id, taskId: share.taskId });
      return { revoked };
    });
  });

  app.delete<{ Params: { taskId: string } }>('/v1/tasks/:taskId/shares', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new GardenError('task_not_found', 'Task not found', 404);
      const revoked = await store.revokeAllShares(user.id, task.id);
      if (revoked) log.info('share.revoked_all', { taskId: task.id, revoked });
      return { revoked };
    });
  });

  /**
   * A new snapshot in place of an old link: the old row is closed and a new id and key are minted,
   * so the key never has to come back to this box and a reader of the old link sees nothing from
   * here on. The owner sends the switches again; the row does not remember them, because the
   * choice of what to show belongs to the moment of showing it.
   */
  app.post<{ Params: { shareId: string } }>(
    '/v1/shares/:shareId/refresh',
    async (request, reply) => {
      const user = requireUser(request.user);
      requireSharing();
      await requireRecentStepUp(request, user);
      const body = CreateShareRequest.parse(request.body ?? {});
      return idempotent(request, reply, user, async () => {
        const previous = await store.getShareForOwner(user.id, request.params.shareId);
        if (!previous) throw new GardenError('not_found', 'Share not found', 404);
        const created = await mint(request, user.id, previous.taskId, body, previous.version + 1);
        await store.revokeShare(user.id, previous.id);
        reply.header('cache-control', 'no-store');
        return created;
      });
    }
  );
};
