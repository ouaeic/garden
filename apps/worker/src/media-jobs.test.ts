import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson, sha256, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { MAX_AGENT_NOTIFICATIONS_PER_TASK } from '@garden/contracts';
import { VideoSubmissionUncertainError } from '@garden/model-gateway';
import { MediaJobWorker } from './media-jobs.js';
import { mediaJobAad, type StoredVideoRequest } from './media-job-domain.js';
import type { AgentRunnerClient } from './runner-client.js';

const MP4 = Buffer.from([
  0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 0, 0, 0
]);
describe('durable video accounting, recovery and delivery', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database);
  const masterKey = Buffer.alloc(32, 18),
    key = Buffer.alloc(32, 9);
  let userId = '',
    workspaceId = '';
  const request: StoredVideoRequest = {
    provider: {
      baseUrl: 'https://provider.test/v1',
      apiKey: 'sealed-only-secret',
      apiProtocol: 'openrouter'
    },
    input: { model: 'vendor/video', prompt: 'Private garden footage', duration: 5 },
    quoteUsd: 0.5
  };
  beforeAll(async () => {
    await migrateDatabase(database);
    userId = (await store.createUser({ username: 'video-owner', displayName: 'Owner' })).id;
    workspaceId = randomUUID();
    await store.createWorkspace({
      id: workspaceId,
      userId,
      name: 'Video',
      storageLimitBytes: 10_000_000_000,
      imageRevision: 'test',
      region: 'local',
      securityMode: 'balanced',
      wrappedKey: wrapDataKey(key, masterKey, workspaceId)
    });
  });
  afterAll(async () => {
    await database.close();
  });
  const createTask = async (maxSpendUsd?: number) =>
    store.createTask({
      userId,
      workspaceId,
      titleCiphertext: encryptJson({ title: 'Video' }, key, `task-title:${workspaceId}`),
      promptCiphertext: encryptJson({ prompt: 'Make a clip' }, key, `task-prompt:${workspaceId}`),
      modelId: 'test/model',
      nameIndex: { nameTokens: 'video', openingTokens: 'make a clip' },
      ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }),
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      securityMode: 'balanced'
    });
  const intent = async (reservationUsd = 0.5) => {
    const task = await createTask(),
      id = randomUUID();
    return {
      id,
      userId,
      workspaceId,
      taskId: task.id,
      requestKey: `video:${task.id}:call`,
      requestHash: sha256('same request'),
      requestCiphertext: encryptJson(request, key, mediaJobAad(id)),
      modelId: 'openrouter:vendor/video',
      reservationUsd,
      privacyRoute: 'external' as const,
      retentionApproved: true,
      outputPath: `workspace/generated/${id}.mp4`
    };
  };
  const due = async (id: string) =>
    database.query('UPDATE provider_media_jobs SET next_poll_at=NOW() WHERE id=$1', [id]);
  const stopOthers = async () =>
    database.query("UPDATE provider_media_jobs SET watching=FALSE WHERE status<>'completed'");

  it('requires per-job retention approval and atomically reserves against concurrent spend', async () => {
    const input = await intent(0.6);
    await expect(store.createMediaJob({ ...input, retentionApproved: false })).rejects.toThrow(
      'Approve provider retention'
    );
    await expect(
      store.createMediaJob({ ...input, privacyRoute: 'provider_zdr' as 'external' })
    ).rejects.toThrow('Approve provider retention');
    await store.setSpendLimits({ userId, monthlyCapUsd: 1 });
    const second = await intent(0.6);
    const results = await Promise.allSettled([
      store.createMediaJob(input),
      store.createMediaJob(second)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const created = results.find((result) => result.status === 'fulfilled');
    expect(created?.status).toBe('fulfilled');
    if (created?.status !== 'fulfilled') throw new Error('No reservation was created');
    const row = created.value;
    const matching = row.id === input.id ? input : second;
    expect((await store.createMediaJob(matching)).id).toBe(row.id);
    await expect(
      store.createMediaJob({ ...matching, requestHash: sha256('different') })
    ).rejects.toThrow('different request');
    expect(await store.getMediaJob(randomUUID(), row.id)).toBeNull();
    const decision = await store.spendGuard({ userId, estimateUsd: 0.5 });
    expect(decision.outcome).toBe('deny');
    await store.setSpendLimits({ userId, monthlyCapUsd: 100 });
    await stopOthers();
  });

  it('never resubmits an interrupted POST and retains its spend reservation', async () => {
    const input = await intent(),
      job = await store.createMediaJob(input);
    const submit = vi.fn(async () => {
      throw new VideoSubmissionUncertainError(new Error('connection ended'));
    });
    const worker = new MediaJobWorker({
      store,
      masterKey,
      workerId: 'uncertain',
      runner: {} as AgentRunnerClient,
      client: () => ({ submit, poll: vi.fn(), download: vi.fn() })
    });
    expect(await worker.tick()).toBe(true);
    expect((await store.getMediaJob(userId, job.id))?.status).toBe('submission_uncertain');
    expect(await worker.tick()).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      (await store.usageHistory(userId)).find((entry) => entry.taskId === job.taskId)
    ).toMatchObject({ state: 'reserved', costUsd: 0.5 });
    expect(await store.reconcileMediaJob(randomUUID(), job.id, 'provider-id')).toBeNull();
    await stopOthers();
  });

  it('marks an expired submit lease uncertain while stale owners cannot settle it', async () => {
    const input = await intent(),
      job = await store.createMediaJob(input);
    const leased = await store.leaseMediaJob('dead-process');
    expect(leased?.id).toBe(job.id);
    await database.query(
      "UPDATE provider_media_jobs SET lease_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",
      [job.id]
    );
    expect(await store.leaseMediaJob('restart')).toBeNull();
    expect((await store.getMediaJob(userId, job.id))?.status).toBe('submission_uncertain');
    expect(
      await store.updateMediaJob({
        id: job.id,
        leaseOwner: 'dead-process',
        status: 'completed',
        costUsd: 0
      })
    ).toBe(false);
    await stopOthers();
  });

  it('resumes polling on a new worker and records cost before recoverable delivery failure', async () => {
    const input = await intent(),
      job = await store.createMediaJob(input);
    const submit = vi.fn(async () => ({ id: 'provider-resume', status: 'pending' as const }));
    const poll = vi.fn(async () => ({
      id: 'provider-resume',
      status: 'completed' as const,
      costUsd: 0.42
    }));
    const download = vi.fn(async () => ({
      filename: 'clip.mp4',
      bytes: MP4,
      mimeType: 'video/mp4' as const
    }));
    let refuseWrite = true;
    const writeBytes = vi.fn(async () => {
      if (refuseWrite) throw new Error('runner restarting');
    });
    const worker = () =>
      new MediaJobWorker({
        store,
        masterKey,
        workerId: 'resumable',
        runner: { writeBytes } as unknown as AgentRunnerClient,
        client: () => ({ submit, poll, download })
      });
    expect(await worker().tick()).toBe(true);
    expect((await store.getMediaJob(userId, job.id))?.providerJobId).toBe('provider-resume');
    await due(job.id);
    expect(await worker().tick()).toBe(true);
    expect(
      (await store.usageHistory(userId)).find((entry) => entry.taskId === job.taskId)
    ).toMatchObject({ state: 'settled', costUsd: 0.42 });
    await due(job.id);
    await worker().tick();
    expect((await store.getMediaJob(userId, job.id))?.status).toBe('delivering');
    refuseWrite = false;
    await due(job.id);
    await worker().tick();
    const completed = await store.getMediaJob(userId, job.id);
    expect(completed).toMatchObject({
      status: 'completed',
      costUsd: 0.42,
      costSource: 'provider',
      progress: 100
    });
    expect(completed?.artifactId).toEqual(expect.any(String));
    const artifacts = await store.listArtifacts(userId, workspaceId);
    expect(artifacts.filter((artifact) => artifact.taskId === job.taskId)).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(2);
    expect(await worker().tick()).toBe(false);
  });
  it('retries ready notifications atomically after a database fault without repeating provider work', async () => {
    await stopOthers();
    const input = await intent(),
      job = await store.createMediaJob(input);
    await store.leaseMediaJob('stage-notification');
    await store.updateMediaJob({
      id: job.id,
      leaseOwner: 'stage-notification',
      status: 'delivering',
      providerJobId: 'completed-provider-video',
      costUsd: 0.42,
      costSource: 'provider'
    });
    await due(job.id);
    const submit = vi.fn(),
      poll = vi.fn(),
      download = vi.fn(async () => ({
        filename: 'video.mp4',
        bytes: MP4,
        mimeType: 'video/mp4' as const
      })),
      writeBytes = vi.fn(async () => undefined);
    const worker = () =>
      new MediaJobWorker({
        store,
        masterKey,
        workerId: 'notification-worker',
        runner: { writeBytes } as unknown as AgentRunnerClient,
        client: () => ({ submit, poll, download })
      });
    await database.exec(`CREATE FUNCTION refuse_media_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'notification unavailable'; END $$;
      CREATE TRIGGER media_notice_fault BEFORE INSERT ON agent_notifications FOR EACH ROW EXECUTE FUNCTION refuse_media_notice()`);
    try {
      expect(await worker().tick()).toBe(true);
      expect((await store.getMediaJob(userId, job.id))?.status).toBe('completed');
      expect(
        (await store.listArtifacts(userId, workspaceId)).filter(
          (artifact) => artifact.taskId === job.taskId
        )
      ).toHaveLength(1);
      expect(
        (await database.query('SELECT id FROM task_events WHERE task_id=$1', [job.taskId])).rows
      ).toHaveLength(0);
      expect(
        (await database.query('SELECT id FROM agent_notifications WHERE task_id=$1', [job.taskId]))
          .rows
      ).toHaveLength(0);
      expect(
        (
          await database.query(
            'SELECT delivered_at,lease_owner FROM provider_media_delivery_outbox WHERE job_id=$1',
            [job.id]
          )
        ).rows
      ).toEqual([{ delivered_at: null, lease_owner: null }]);
    } finally {
      await database.exec(
        'DROP TRIGGER media_notice_fault ON agent_notifications; DROP FUNCTION refuse_media_notice()'
      );
    }
    await database.query(
      'UPDATE provider_media_delivery_outbox SET next_attempt_at=NOW() WHERE job_id=$1',
      [job.id]
    );
    const retried = await Promise.all([worker().tick(), worker().tick(), worker().tick()]);
    expect(retried.filter(Boolean)).toHaveLength(1);
    const events = (
      await database.query('SELECT payload_ciphertext FROM task_events WHERE task_id=$1', [
        job.taskId
      ])
    ).rows;
    expect(events).toHaveLength(1);
    expect(
      decryptJson(events[0]!.payload_ciphertext as never, key, `task-event:${job.taskId}`)
    ).toMatchObject({
      summary: 'Video ready',
      payload: { mediaJobId: job.id, path: job.outputPath }
    });
    expect(
      (await database.query('SELECT id FROM agent_notifications WHERE task_id=$1', [job.taskId]))
        .rows
    ).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(writeBytes).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
    expect(await worker().tick()).toBe(false);
  });

  it('keeps artifact publication retryable when its durable notification intent cannot be recorded', async () => {
    await stopOthers();
    const job = await store.createMediaJob(await intent());
    await store.leaseMediaJob('stage-outbox');
    await store.updateMediaJob({
      id: job.id,
      leaseOwner: 'stage-outbox',
      status: 'delivering',
      providerJobId: 'ready-video'
    });
    await due(job.id);
    const worker = new MediaJobWorker({
      store,
      masterKey,
      workerId: 'outbox-worker',
      runner: { writeBytes: async () => undefined } as unknown as AgentRunnerClient,
      client: () => ({
        submit: vi.fn(),
        poll: vi.fn(),
        download: async () => ({
          filename: 'video.mp4',
          bytes: MP4,
          mimeType: 'video/mp4' as const
        })
      })
    });
    await database.exec(`CREATE FUNCTION refuse_media_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$;
      CREATE TRIGGER media_outbox_fault BEFORE INSERT ON provider_media_delivery_outbox FOR EACH ROW EXECUTE FUNCTION refuse_media_outbox()`);
    try {
      await worker.tick();
      expect((await store.getMediaJob(userId, job.id))?.status).toBe('delivering');
      expect(
        (await store.listArtifacts(userId, workspaceId)).filter(
          (artifact) => artifact.taskId === job.taskId
        )
      ).toHaveLength(0);
    } finally {
      await database.exec(
        'DROP TRIGGER media_outbox_fault ON provider_media_delivery_outbox; DROP FUNCTION refuse_media_outbox()'
      );
    }
    await due(job.id);
    await worker.tick();
    expect((await store.getMediaJob(userId, job.id))?.status).toBe('completed');
    expect(
      (
        await database.query(
          'SELECT notification_state FROM provider_media_delivery_outbox WHERE job_id=$1',
          [job.id]
        )
      ).rows
    ).toEqual([{ notification_state: 'sent' }]);
  });

  it('delivers an artifact exactly once when the task has exhausted its notification allowance', async () => {
    await stopOthers();
    const job = await store.createMediaJob(await intent());
    const leaseOwner = 'quota-delivery';
    await store.leaseMediaJob(leaseOwner);
    await store.updateMediaJob({
      id: job.id,
      leaseOwner,
      status: 'delivering',
      providerJobId: 'ready'
    });
    await due(job.id);
    expect(await store.leaseMediaJob(leaseOwner)).toMatchObject({
      id: job.id,
      status: 'delivering'
    });
    const notice = encryptJson(
      { message: 'Earlier finding' },
      key,
      `agent-notification:${job.taskId}`
    );
    expect(MAX_AGENT_NOTIFICATIONS_PER_TASK).toBeGreaterThan(0);
    for (let count = 0; count < MAX_AGENT_NOTIFICATIONS_PER_TASK; count++)
      await store.createAgentNotification({
        userId,
        taskId: job.taskId,
        kind: 'agent_message',
        messageCiphertext: notice
      });
    await store.completeMediaJob({
      id: job.id,
      leaseOwner,
      nameCiphertext: encryptJson({ name: 'video.mp4' }, key, `artifact-name:${workspaceId}`),
      sizeBytes: MP4.length,
      sha256: sha256(MP4),
      storageKey: `.garden/artifacts/media-${job.id}`
    });
    const writeBytes = vi.fn(),
      provider = vi.fn();
    const worker = new MediaJobWorker({
      store,
      masterKey,
      workerId: 'quota-worker',
      runner: { writeBytes } as unknown as AgentRunnerClient,
      client: provider
    });
    expect(await worker.tick()).toBe(true);
    expect(
      (
        await database.query(
          'SELECT notification_state, delivered_at IS NOT NULL AS delivered FROM provider_media_delivery_outbox WHERE job_id=$1',
          [job.id]
        )
      ).rows
    ).toEqual([{ notification_state: 'suppressed_limit', delivered: true }]);
    expect(
      (await store.listAgentNotifications(userId, 200)).filter((item) => item.taskId === job.taskId)
    ).toHaveLength(MAX_AGENT_NOTIFICATIONS_PER_TASK);
    expect(
      (await store.listTaskEvents(job.taskId, 0)).filter((item) => item.kind === 'artifact')
    ).toHaveLength(1);
    expect(await worker.tick()).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('reclaims an expired publication lease and refuses stale or duplicate publishers', async () => {
    await stopOthers();
    const job = await store.createMediaJob(await intent());
    await store.leaseMediaJob('stage-expired');
    await store.updateMediaJob({
      id: job.id,
      leaseOwner: 'stage-expired',
      status: 'delivering',
      providerJobId: 'already-complete'
    });
    await due(job.id);
    await store.leaseMediaJob('publish-artifact');
    const completed = await store.completeMediaJob({
      id: job.id,
      leaseOwner: 'publish-artifact',
      nameCiphertext: encryptJson({ name: 'video.mp4' }, key, `artifact-name:${workspaceId}`),
      sizeBytes: MP4.length,
      sha256: sha256(MP4),
      storageKey: `.garden/artifacts/media-${job.id}`
    });
    expect(completed?.artifactId).toEqual(expect.any(String));
    expect(await store.leaseMediaDelivery('dead-publisher')).toEqual({ jobId: job.id, userId });
    expect(await store.leaseMediaDelivery('concurrent-publisher')).toBeNull();
    await database.query(
      "UPDATE provider_media_delivery_outbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE job_id=$1",
      [job.id]
    );
    const publication = {
      jobId: job.id,
      leaseOwner: 'dead-publisher',
      payloadCiphertext: encryptJson(
        { payload: { mediaJobId: job.id } },
        key,
        `task-event:${job.taskId}`
      ),
      messageCiphertext: encryptJson({ message: 'Ready' }, key, `agent-notification:${job.taskId}`)
    };
    expect(await store.publishMediaDelivery(publication)).toBe(false);
    expect(await store.leaseMediaDelivery('replacement')).toEqual({ jobId: job.id, userId });
    expect(await store.publishMediaDelivery(publication)).toBe(false);
    expect(await store.publishMediaDelivery({ ...publication, leaseOwner: 'replacement' })).toBe(
      true
    );
    expect(await store.publishMediaDelivery({ ...publication, leaseOwner: 'replacement' })).toBe(
      false
    );
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [job.taskId])).rows
    ).toHaveLength(1);
    await database.query('DELETE FROM tasks WHERE id=$1', [job.taskId]);
    expect(
      (
        await database.query('SELECT job_id FROM provider_media_delivery_outbox WHERE job_id=$1', [
          job.id
        ])
      ).rows
    ).toHaveLength(0);
  });

  it('continues polling unrelated media when a ready notification cannot be published', async () => {
    await stopOthers();
    const ready = await store.createMediaJob(await intent());
    await store.leaseMediaJob('prepare-ready');
    await store.updateMediaJob({
      id: ready.id,
      leaseOwner: 'prepare-ready',
      status: 'delivering',
      providerJobId: 'ready-to-notify'
    });
    await due(ready.id);
    await store.leaseMediaJob('complete-ready');
    await store.completeMediaJob({
      id: ready.id,
      leaseOwner: 'complete-ready',
      nameCiphertext: encryptJson({ name: 'video.mp4' }, key, `artifact-name:${workspaceId}`),
      sizeBytes: MP4.length,
      sha256: sha256(MP4),
      storageKey: `.garden/artifacts/media-${ready.id}`
    });
    const pending = await store.createMediaJob(await intent());
    await store.leaseMediaJob('prepare-pending');
    await store.updateMediaJob({
      id: pending.id,
      leaseOwner: 'prepare-pending',
      status: 'pending',
      providerJobId: 'still-processing'
    });
    await due(pending.id);
    const poll = vi.fn(async () => ({
      id: 'still-processing',
      status: 'in_progress' as const,
      progress: 25
    }));
    const onError = vi.fn<(error: unknown) => void>();
    const worker = new MediaJobWorker({
      store,
      masterKey,
      workerId: 'isolated-delivery-worker',
      onError,
      runner: { writeBytes: vi.fn() } as unknown as AgentRunnerClient,
      client: () => ({ submit: vi.fn(), poll, download: vi.fn() })
    });
    await database.exec(`CREATE FUNCTION refuse_one_media_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'notice temporarily unavailable'; END $$;
      CREATE TRIGGER one_media_notice_fault BEFORE INSERT ON agent_notifications FOR EACH ROW WHEN (NEW.task_id='${ready.taskId}') EXECUTE FUNCTION refuse_one_media_notice()`);
    try {
      const result = await worker.tick().catch((error: unknown) => error);
      expect(poll).toHaveBeenCalledExactlyOnceWith('still-processing', undefined);
      expect(result).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      const failure = onError.mock.calls[0]?.[0];
      expect(failure instanceof Error ? failure.message : '').toContain(
        'notice temporarily unavailable'
      );
      expect((await store.getMediaJob(userId, pending.id))?.progress).toBe(25);
      expect(
        (
          await database.query(
            'SELECT delivered_at,lease_owner FROM provider_media_delivery_outbox WHERE job_id=$1',
            [ready.id]
          )
        ).rows
      ).toEqual([{ delivered_at: null, lease_owner: null }]);
    } finally {
      await database.exec(
        'DROP TRIGGER one_media_notice_fault ON agent_notifications; DROP FUNCTION refuse_one_media_notice()'
      );
    }
  });

  it('reserves synchronous media atomically and settles only the matching owner reservation', async () => {
    const task = await createTask(1);
    const usage = {
      userId,
      workspaceId,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'media:image',
      quantity: 1,
      unit: 'generation',
      credits: 0,
      costUsd: 0.6,
      state: 'reserved' as const,
      reserveAgainstCaps: true
    };
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(
      keys.map((idempotencyKey) => store.recordUsage({ ...usage, idempotencyKey }))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const idempotencyKey = keys[results.findIndex((r) => r.status === 'fulfilled')]!;
    await expect(store.recordUsage({ ...usage, idempotencyKey })).rejects.toThrow(
      'already has a reservation'
    );
    const settlement = {
      ...usage,
      reserveAgainstCaps: false,
      settleReservation: true,
      idempotencyKey,
      state: 'settled' as const,
      costUsd: 0.25
    };
    await expect(store.recordUsage({ ...settlement, userId: randomUUID() })).rejects.toThrow(
      'could not be settled'
    );
    await store.recordUsage(settlement);
    expect((await store.usageHistory(userId)).filter((entry) => entry.taskId === task.id)).toEqual([
      expect.objectContaining({ state: 'settled', costUsd: 0.25 })
    ]);
    await expect(store.recordUsage(settlement)).rejects.toThrow('could not be settled');
    expect((await store.spendGuard({ userId, taskId: task.id, estimateUsd: 0.5 })).outcome).toBe(
      'allow'
    );
  });
});
