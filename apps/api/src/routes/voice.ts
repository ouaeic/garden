import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import {
  VoiceClientControl,
  VoiceReceiptReconciliation,
  VoiceStartRequest,
  VOICE_MAX_SESSION_SECONDS,
  VOICE_MAX_INPUT_SEGMENT_SECONDS,
  type VoiceConnection,
  type VoiceModelOption,
  type VoiceModels,
  type VoiceSession,
  type VoiceWorkProposal
} from '@athanor/contracts';
import { AthanorError, decryptJson, encryptJson, sha256, userMemoryKey } from '@athanor/core';
import { VoiceStore, type VoiceProposalRecord, type UserRecord } from '@athanor/data';
import {
  discoverRealtimeModels,
  isNativeOpenAIEndpoint,
  REALTIME_PRICE_CHECKED_AT,
  realtimeReservationUsd,
  type RealtimeModelMetadata
} from '@athanor/model-gateway';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { SESSION_LIFETIME_SECONDS, sessionCookieName } from '../session.js';
import {
  continueTaskOperation,
  taskContinuationSnapshot,
  type TaskContinuationSnapshot
} from '../task-continuation.js';
import { VoiceController } from '../voice/controller.js';
import type { FastifyRequest } from 'fastify';

interface VoiceConfiguration {
  apiKey: string;
  routeProof: string;
  model: RealtimeModelMetadata;
  selection: VoiceStartRequest;
  taskSnapshot: TaskContinuationSnapshot;
}
interface ProposalBody {
  prompt: string;
  snapshot: TaskContinuationSnapshot;
}
const keyFor = (context: RouteContext, userId: string) => userMemoryKey(context.masterKey, userId);
const configAad = (id: string) => `voice-configuration:${id}`;
const connectionAad = (id: string) => `voice-connection:${id}`;
const proposalAad = (id: string) => `voice-proposal:${id}`;
const unavailable = () =>
  new AthanorError('voice_session_unavailable', 'This voice session is unavailable', 404);
const active = new Set(['preparing', 'connecting', 'listening', 'responding', 'stopping']);
export interface VoiceRouteOptions {
  providerFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}
export async function registerVoiceRoutes(
  context: RouteContext,
  options: VoiceRouteOptions = {}
): Promise<void> {
  const { app, store, database } = context,
    voice = new VoiceStore(database),
    controllers = new Map<string, VoiceController>();
  let closing = false;
  await app.register(websocket, { options: { maxPayload: 8_000, perMessageDeflate: false } });
  const cache = new Map<string, { expires: number; models: RealtimeModelMetadata[] }>();
  const owner = (request: FastifyRequest): { user: UserRecord; authHash: string } => {
    const user = requireUser(request.user),
      cookie = request.cookies?.[sessionCookieName(context.secure)];
    if (request.apiToken || !cookie)
      throw new AthanorError(
        'voice_owner_required',
        'Start live voice from a signed-in browser',
        403
      );
    return { user, authHash: sha256(cookie) };
  };
  const connectionFor = async (userId: string) => {
    const { secret } = await context.inferenceCredential(userId);
    if (
      secret.provider === 'openrouter' ||
      !isNativeOpenAIEndpoint(secret.baseUrl) ||
      !secret.apiKey
    )
      throw new AthanorError(
        'voice_connection_unavailable',
        'Live voice needs a direct OpenAI API credential in Settings',
        409
      );
    const routeProof = createHmac('sha256', keyFor(context, userId))
      .update(JSON.stringify({ userId, secret, priceUpdatedAt: REALTIME_PRICE_CHECKED_AT }))
      .digest('base64url');
    let found = cache.get(routeProof);
    if (!found || found.expires < Date.now()) {
      const models = await discoverRealtimeModels({
        baseUrl: secret.baseUrl,
        apiKey: secret.apiKey
      });
      cache.clear();
      found = { expires: Date.now() + 30_000, models };
      cache.set(routeProof, found);
    }
    return { secret, routeProof, models: found.models };
  };
  const modelOptions = async (userId: string): Promise<VoiceModels> => {
    try {
      const c = await connectionFor(userId);
      return {
        reason: c.models.length
          ? null
          : 'This provider account lists no supported live voice model.',
        options: c.models.map(
          (m): VoiceModelOption => ({
            id: `openai/${m.modelId}`,
            provider: 'openai',
            providerModelId: m.modelId,
            displayName: m.modelId,
            available: true,
            reason: null,
            routeProof: c.routeProof,
            privacyRoutes: c.secret.enforceZeroDataRetention ? ['provider_zdr'] : ['external'],
            requiresExternalConsent: !c.secret.enforceZeroDataRetention,
            supportedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
            defaultEffort: 'low',
            voices: VoiceStartRequest.shape.voice.options,
            defaultVoice: 'marin',
            pricing: Object.entries(m.price).map(([name, rate]) => ({
              billable: (
                {
                  inputText: 'input_text',
                  cachedText: 'cached_text',
                  outputText: 'output_text',
                  inputAudio: 'input_audio',
                  cachedAudio: 'cached_audio',
                  outputAudio: 'output_audio'
                } as Record<string, string>
              )[name]!,
              unit: 'token',
              costUsd: rate / 1_000_000
            })),
            priceUpdatedAt: REALTIME_PRICE_CHECKED_AT,
            minimumReservationUsd: realtimeReservationUsd(m),
            maxDurationSeconds: VOICE_MAX_SESSION_SECONDS,
            maxInputSegmentSeconds: VOICE_MAX_INPUT_SEGMENT_SECONDS
          })
        )
      };
    } catch (error) {
      return {
        options: [],
        reason:
          error instanceof AthanorError
            ? error.message
            : 'Live voice model discovery could not be verified. Try again after checking the provider connection.'
      };
    }
  };
  const read = async (userId: string, id: string) => {
    const row = await voice.get(userId, id);
    if (!row) throw unavailable();
    return row;
  };
  const publicProposal = (row: VoiceProposalRecord): VoiceWorkProposal => {
    const body = decryptJson<ProposalBody>(
      row.ciphertext,
      keyFor(context, row.userId),
      proposalAad(row.id)
    );
    return {
      id: row.id,
      digest: row.digest,
      sessionId: row.sessionId,
      taskId: body.snapshot.id,
      prompt: body.prompt,
      modelId: body.snapshot.modelId,
      privacyRoute: body.snapshot.privacyRoute as VoiceWorkProposal['privacyRoute'],
      maxSpendUsd: body.snapshot.maxSpendUsd,
      status:
        row.status === 'pending' && Date.parse(row.expiresAt) <= Date.now()
          ? 'expired'
          : row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      messageId: row.messageId
    };
  };
  app.get('/v1/voice-sessions', async (request) => voice.listOwner(owner(request).user.id));
  app.get('/v1/voice/models', async (request) => modelOptions(owner(request).user.id));
  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/voice-sessions', async (request) => {
    const { user, authHash } = owner(request),
      selection = VoiceStartRequest.parse(request.body);
    if (closing) throw new AthanorError('voice_server_stopping', 'The server is restarting', 503);
    const requestKey = z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{8,200}$/)
      .parse(request.headers['idempotency-key']);
    const requestHash = sha256(JSON.stringify({ taskId: request.params.taskId, selection }));
    const existing = await voice.existing(user.id, requestKey, requestHash, authHash);
    if (existing) {
      const configuration = decryptJson<VoiceConfiguration>(
        existing.configuration,
        keyFor(context, user.id),
        configAad(existing.session.id)
      );
      const admitted = await voice.replayAdmission(
        user.id,
        existing.session.id,
        realtimeReservationUsd(configuration.model)
      );
      const replay = decryptJson<VoiceConnection>(
        admitted.connection,
        keyFor(context, user.id),
        connectionAad(admitted.session.id)
      );
      return { ...replay, session: admitted.session };
    }
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw unavailable();
    const c = await connectionFor(user.id),
      model = c.models.find((m) => `openai/${m.modelId}` === selection.modelId);
    if (c.routeProof !== selection.expectedRouteProof || !model)
      throw new AthanorError(
        'voice_selection_changed',
        'Review the current live voice model and provider connection before starting',
        409
      );
    if (
      selection.privacyRoute !== (c.secret.enforceZeroDataRetention ? 'provider_zdr' : 'external')
    )
      throw new AthanorError(
        'voice_privacy_changed',
        'Confirm the advertised provider retention route before starting live voice',
        409
      );
    if (selection.maxSpendUsd < realtimeReservationUsd(model))
      throw new AthanorError(
        'voice_reservation_required',
        'The selected voice allowance cannot reserve a bounded response',
        402
      );
    const id = randomUUID(),
      ticket = randomBytes(32).toString('base64url'),
      now = Date.now(),
      ticketExpiresAt = new Date(now + 60_000).toISOString();
    const session: VoiceSession = {
      id,
      taskId: task.id,
      workspaceId: task.workspaceId,
      provider: 'openai',
      providerModelId: model.modelId,
      privacyRoute: selection.privacyRoute,
      retention:
        selection.privacyRoute === 'provider_zdr'
          ? 'Owner-configured provider zero data retention'
          : 'Provider default retention; audio is sent to the selected OpenAI account',
      voice: selection.voice,
      reasoningEffort: selection.reasoningEffort,
      status: 'preparing',
      createdAt: new Date(now).toISOString(),
      connectedAt: null,
      deadlineAt: new Date(now + selection.lifetimeSeconds * 1000).toISOString(),
      endedAt: null,
      maxSpendUsd: selection.maxSpendUsd,
      settledUsd: 0,
      pendingUsd: 0,
      inputSeconds: 0,
      outputSeconds: 0,
      currentResponseId: null,
      cleanupPending: false,
      errorCode: null,
      note: null
    };
    const connection: VoiceConnection = {
      session,
      ticket,
      recoveryKey: randomBytes(32).toString('base64url'),
      socketPath: `/v1/voice-sessions/${id}/socket`,
      ticketExpiresAt
    };
    const configuration: VoiceConfiguration = {
      apiKey: c.secret.apiKey!,
      routeProof: c.routeProof,
      model,
      selection,
      taskSnapshot: taskContinuationSnapshot(task)
    };
    const record = await voice.create({
      userId: user.id,
      requestKey,
      requestHash,
      authHash,
      ticketHash: sha256(ticket),
      ticketExpiresAt,
      session,
      minimumReservationUsd: realtimeReservationUsd(model),
      configuration: encryptJson(configuration, keyFor(context, user.id), configAad(id)),
      connection: encryptJson(connection, keyFor(context, user.id), connectionAad(id))
    });
    const replay = decryptJson<VoiceConnection>(
      record.connection,
      keyFor(context, user.id),
      connectionAad(record.session.id)
    );
    return { ...replay, session: record.session };
  });
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/voice-sessions', async (request) =>
    voice.list(owner(request).user.id, request.params.taskId)
  );
  app.post<{ Params: { taskId: string; sessionId: string } }>(
    '/v1/tasks/:taskId/voice-sessions/:sessionId/stop',
    async (request) => {
      const { user } = owner(request),
        record = await read(user.id, request.params.sessionId);
      if (record.session.taskId !== request.params.taskId) throw unavailable();
      const controller = controllers.get(record.session.id);
      if (controller) {
        await controller.stop();
        controllers.delete(record.session.id);
      } else if (record.session.status === 'preparing')
        await voice.finish(user.id, record.session.id, null, 'ended');
      else if (active.has(record.session.status)) await voice.stopping(user.id, record.session.id);
      return (await read(user.id, record.session.id)).session;
    }
  );
  app.get<{ Params: { sessionId: string } }>(
    '/v1/voice-sessions/:sessionId/proposals',
    async (request) => {
      const { user } = owner(request);
      await read(user.id, request.params.sessionId);
      return (await voice.proposals(user.id, request.params.sessionId)).map(publicProposal);
    }
  );
  for (const action of ['confirm', 'reject'] as const)
    app.post<{ Params: { sessionId: string; proposalId: string } }>(
      `/v1/voice-sessions/:sessionId/proposals/:proposalId/${action}`,
      async (request) => {
        const { user } = owner(request),
          { digest } = z
            .object({ digest: z.string().min(1).max(128) })
            .strict()
            .parse(request.body);
        return database.transaction(async (tx) => {
          await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
          const row = await voice.proposal(
            user.id,
            request.params.sessionId,
            request.params.proposalId,
            true
          );
          if (!row || row.digest !== digest) throw unavailable();
          if (row.status === (action === 'confirm' ? 'confirmed' : 'rejected'))
            return publicProposal(row);
          if (row.status !== 'pending' || Date.parse(row.expiresAt) <= Date.now())
            throw new AthanorError(
              'voice_proposal_expired',
              'This voice proposal is no longer awaiting review',
              409
            );
          const body = decryptJson<ProposalBody>(
              row.ciphertext,
              keyFor(context, user.id),
              proposalAad(row.id)
            ),
            messageId = action === 'confirm' ? randomUUID() : null;
          if (action === 'confirm')
            await continueTaskOperation(
              context,
              user,
              body.snapshot.id,
              { prompt: body.prompt },
              { retainBudget: { expected: body.snapshot, messageId: messageId! } }
            );
          await voice.decideProposal(
            user.id,
            row.id,
            digest,
            action === 'confirm' ? 'confirmed' : 'rejected',
            messageId
          );
          return publicProposal((await voice.proposal(user.id, row.sessionId, row.id))!);
        });
      }
    );
  app.get<{ Params: { sessionId: string } }>(
    '/v1/voice-sessions/:sessionId/receipts',
    async (request) => {
      const { user } = owner(request);
      await read(user.id, request.params.sessionId);
      return voice.pending(user.id, request.params.sessionId);
    }
  );
  app.post<{ Params: { sessionId: string } }>(
    '/v1/voice-sessions/:sessionId/reconcile',
    async (request) => {
      const { user } = owner(request),
        record = await read(user.id, request.params.sessionId),
        input = VoiceReceiptReconciliation.parse(request.body);
      if (active.has(record.session.status) || record.session.cleanupPending)
        throw new AthanorError(
          'voice_still_active',
          'End the voice session before reconciling a provider invoice',
          409
        );
      const receipt = (await voice.pending(user.id, record.session.id)).find(
        (r) => r.id === input.receiptId
      );
      if (!receipt) throw unavailable();
      await voice.settle(user.id, record.session.id, receipt.id, {
        costUsd: input.costUsd,
        quantity: 0,
        providerResponseId: receipt.providerResponseId,
        receipt: encryptJson(
          { providerReceiptRef: input.providerReceiptRef },
          keyFor(context, user.id),
          `voice-receipt:${receipt.id}`
        )
      });
      return (await read(user.id, record.session.id)).session;
    }
  );
  app.post<{ Params: { taskId: string; sessionId: string } }>(
    '/v1/tasks/:taskId/voice-sessions/:sessionId/reconnect',
    async (request): Promise<VoiceConnection> => {
      const { user, authHash } = owner(request);
      const saved = await read(user.id, request.params.sessionId);
      const { recoveryKey } = z
        .object({ recoveryKey: z.string().min(20).max(128) })
        .strict()
        .parse(request.body);
      const original = decryptJson<VoiceConnection>(
        saved.connection,
        keyFor(context, user.id),
        connectionAad(saved.session.id)
      );
      if (!original.recoveryKey || sha256(recoveryKey) !== sha256(original.recoveryKey))
        throw unavailable();
      const controller = controllers.get(saved.session.id);
      if (
        closing ||
        saved.session.taskId !== request.params.taskId ||
        saved.authHash !== authHash ||
        !saved.controllerId ||
        !controller?.reconnectable
      )
        throw unavailable();
      const ticket = randomBytes(32).toString('base64url');
      const ticketExpiresAt = new Date(
        Math.min(Date.now() + 30_000, Date.parse(saved.session.deadlineAt))
      ).toISOString();
      const record = await voice.reconnectTicket({
        userId: user.id,
        id: saved.session.id,
        authHash,
        controllerId: saved.controllerId,
        ticketHash: sha256(ticket),
        expiresAt: ticketExpiresAt
      });
      return {
        session: record.session,
        ticket,
        recoveryKey,
        ticketExpiresAt,
        socketPath: `/v1/voice-sessions/${saved.session.id}/socket`
      };
    }
  );
  app.get<{ Params: { sessionId: string } }>(
    '/v1/voice-sessions/:sessionId/socket',
    { websocket: true },
    (socket, request) => {
      let handshake = false;
      let claimed: { userId: string; id: string; controllerId: string } | null = null;
      const timeout = setTimeout(() => socket.close(1008, 'Voice ticket required'), 5_000);
      socket.once('message', (data: RawData, binary: boolean) => {
        socket.pause();
        void (async () => {
          const { user, authHash } = owner(request);
          if (
            closing ||
            binary ||
            request.headers.origin !== new URL(context.config.PUBLIC_APP_URL).origin
          )
            throw unavailable();
          const bytes = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          const control = VoiceClientControl.parse(JSON.parse(bytes.toString('utf8')));
          if (control.type !== 'ticket') throw unavailable();
          const saved = await read(user.id, request.params.sessionId);
          const configuration = decryptJson<VoiceConfiguration>(
            saved.configuration,
            keyFor(context, user.id),
            configAad(saved.session.id)
          );
          const authorize = async () => {
            if ((await store.getSession(authHash, SESSION_LIFETIME_SECONDS))?.user.id !== user.id)
              return false;
            const task = await store.getTask(user.id, saved.session.taskId);
            if (!task) return false;
            const current = await context.inferenceCredential(user.id);
            return (
              current.secret.apiKey === configuration.apiKey &&
              isNativeOpenAIEndpoint(current.secret.baseUrl) &&
              current.secret.enforceZeroDataRetention ===
                (saved.session.privacyRoute === 'provider_zdr')
            );
          };
          const authorized = await authorize();
          if (saved.session.status !== 'preparing') {
            const controller = controllers.get(saved.session.id);
            if (!authorized || !saved.controllerId || !controller?.reconnectable)
              throw unavailable();
            await voice.reconnect({
              userId: user.id,
              id: saved.session.id,
              authHash,
              controllerId: saved.controllerId,
              ticketHash: sha256(control.ticket)
            });
            if (closing) throw unavailable();
            await controller.reconnect(socket);
            handshake = true;
            clearTimeout(timeout);
            socket.resume();
            return;
          }
          const controllerId = randomUUID();
          const record = await voice.claim(
            user.id,
            request.params.sessionId,
            authHash,
            sha256(control.ticket),
            controllerId,
            realtimeReservationUsd(configuration.model)
          );
          claimed = { userId: user.id, id: record.session.id, controllerId };
          handshake = true;
          clearTimeout(timeout);
          if (socket.readyState !== WebSocket.OPEN) {
            await voice.finish(user.id, record.session.id, controllerId, 'ended');
            return;
          }
          if (!authorized) {
            await voice.finish(
              user.id,
              record.session.id,
              controllerId,
              'lost',
              'voice_authority_ended'
            );
            throw unavailable();
          }
          if (closing || socket.readyState !== WebSocket.OPEN) {
            await voice.finish(user.id, record.session.id, controllerId, 'ended');
            return;
          }
          const controller = new VoiceController(socket, {
            userId: user.id,
            session: record.session,
            controllerId,
            apiKey: configuration.apiKey,
            model: configuration.model,
            store: voice,
            authorize,
            taskStatus: async () => {
              const task = await store.getTask(user.id, record.session.taskId);
              return task
                ? {
                    status: task.status,
                    modelId: task.modelId,
                    privacyRoute: task.privacyRoute,
                    maxSpendUsd: task.maxSpendUsd,
                    spentUsd: task.spentUsd
                  }
                : { status: 'unavailable' };
            },
            propose: async (prompt, callId) => {
              const task = await store.getTask(user.id, record.session.taskId);
              if (!task) throw unavailable();
              const snapshot = taskContinuationSnapshot(task),
                body: ProposalBody = { prompt, snapshot },
                id = randomUUID();
              const digest = createHmac('sha256', keyFor(context, user.id))
                .update(JSON.stringify({ id, sessionId: record.session.id, body }))
                .digest('base64url');
              return publicProposal(
                await voice.addProposal({
                  id,
                  sessionId: record.session.id,
                  userId: user.id,
                  callId,
                  digest,
                  ciphertext: encryptJson(body, keyFor(context, user.id), proposalAad(id)),
                  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
                })
              );
            },
            ...options
          });
          controllers.set(record.session.id, controller);
          controller.start();
          socket.resume();
        })().catch(async (error: unknown) => {
          clearTimeout(timeout);
          if (claimed && controllers.has(claimed.id))
            await controllers.get(claimed.id)!.stop('lost', 'voice_connection_failed');
          if (claimed && !controllers.has(claimed.id))
            await voice
              .finish(
                claimed.userId,
                claimed.id,
                claimed.controllerId,
                'lost',
                'voice_connection_failed'
              )
              .catch(() => {});
          socket.resume();
          if (
            error instanceof AthanorError &&
            ['voice_budget_unavailable', 'voice_reservation_required'].includes(error.code) &&
            socket.readyState === WebSocket.OPEN
          ) {
            try {
              socket.send(
                JSON.stringify({ type: 'error', code: error.code, message: error.message })
              );
            } catch {
              // A lost browser transport must still close the rejected connection.
            }
          }
          socket.close(1008, 'Voice connection could not be authorized');
        });
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        if (!handshake) socket.resume();
      });
      socket.on('error', () => {
        clearTimeout(timeout);
      });
    }
  );
  let sweeping = false;
  const sweep = async () => {
    if (sweeping || closing) return;
    sweeping = true;
    try {
      await voice.recover();
      for (const [id, c] of controllers) if (c.closed) controllers.delete(id);
    } finally {
      sweeping = false;
    }
  };
  await sweep();
  const timer = setInterval(() => {
    void sweep().catch(() => {});
  }, 5_000);
  timer.unref();
  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(timer);
    await Promise.allSettled([...controllers.values()].map((c) => c.stop()));
    controllers.clear();
    cache.clear();
  });
}
