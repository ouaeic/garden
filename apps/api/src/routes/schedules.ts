/**
 * Watchers: work the owner asked for on a clock rather than at a keyboard.
 *
 * A schedule carries its own model choice and its own ceiling, and both are checked when it is
 * saved rather than only when it fires - a run that is refused at three in the morning is a run
 * nobody sees refused.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CreateTaskScheduleRequest,
  INBOUND_TRIGGER_PATH_PREFIX,
  TaskScheduleTrigger,
  UpdateTaskScheduleRequest,
  type TaskSchedule
} from '@garden/contracts';
import {
  GardenError,
  assertTimeZone,
  decryptJson,
  encryptJson,
  inferModelTask,
  unwrapDataKey
} from '@garden/core';
import type { TaskScheduleRecord } from '@garden/data';
import { z } from 'zod';
import { ownerPriceCeiling } from '../context.js';
import { requireMainModel } from '../main-model-selection.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { serverLimits } from '../plans.js';
import { advanceScheduleRun } from '../schedule-advance.js';

/**
 * How much of one inbound delivery this box will keep.
 *
 * CHOSEN at 64 KiB, which is comfortably past every ordinary webhook body - a GitHub push event is
 * a few kilobytes, a Stripe event under ten - and small enough that the pending cap below bounds
 * what one schedule can put into the owner's workspace at about a megabyte. The body is stored
 * encrypted and then written into the workspace as a file, so this is a bound on storage the sender
 * chooses, which is the only resource an authenticated-but-hostile sender can spend without
 * spending money.
 */
const MAX_DELIVERY_BYTES = 64 * 1024;

/**
 * How far the sender's clock may be from this one.
 *
 * CHOSEN at five minutes, which is what Stripe and Slack both use for the same job, and for the
 * same reason: it is longer than any plausible clock skew plus network delay and shorter than a
 * useful window for anyone who has captured a request off the wire. It is only half the replay
 * defence - the other half is the unique index on `(schedule_id, signature)`, which refuses the
 * same signed body twice even inside the window - and the two together mean a captured request
 * cannot be replayed at all rather than merely not for long.
 */
const SIGNATURE_WINDOW_SECONDS = 300;

/**
 * How many deliveries may be waiting for a run before this schedule stops accepting them.
 *
 * CHOSEN at 16, matching the number the brief for this work names as the service limit, and it is a
 * back-pressure bound rather than a security one: the run reads every pending delivery, so a
 * schedule this far behind is one whose runs are not keeping up and whose sender should be told so
 * with a 429 rather than have its deliveries silently pile up in the owner's workspace. It also
 * bounds how many files one run writes, which is the second half of the same promise.
 */
export const MAX_PENDING_DELIVERIES = 16;

/**
 * How many deliveries one trigger will accept in an hour, accepted or not.
 *
 * CHOSEN at 60. This is NOT the bound on the owner's money - `minGapMinutes` is, because it bounds
 * MODEL TURNS, and a thousand deliveries inside one gap still produce exactly one run. This bounds
 * the rows and the encrypted bodies a retry storm or a loop can write into the database, which is
 * the resource a correctly-signed sender can still exhaust. One a minute is far past any real
 * publisher's rate and far below anything that would fill a disk.
 *
 * Counted over the delivery rows themselves rather than in memory, so it survives a restart and is
 * the same number on a box running two API processes.
 */
const MAX_DELIVERIES_PER_HOUR = 60;

/**
 * The version prefix on a signature, so this can gain a second scheme without a flag day.
 *
 * The signed string is `v1:<timestamp>:<body>` and not the body alone, for the reason
 * `approvalPreviewHash` gives about the tool name: a signature over a value with nothing around it
 * signs whatever else could be arranged to produce those bytes. Pinning the version and the
 * timestamp into the signed string means a signature valid for one moment cannot be presented as
 * valid for another, and a future scheme cannot be down-negotiated to this one.
 */
const SIGNATURE_VERSION = 'v1';

export const registerScheduleRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    masterKey,
    scheduleTitle,
    schedulePrompt,
    privateScheduleResponse,
    computeAllowanceFor,
    resolveSpendCeiling,
    assertSpendCeilingAllowed,
    pickModelUnderPriceCeiling,
    modelsForUser,
    config,
    idempotent,
    log
  } = context;

  /**
   * The two harmless halves of a trigger, hung on a schedule response.
   *
   * They are not on `TaskScheduleRecord` and are not produced by `scheduleResponseFields` in
   * `context.ts`, deliberately: that record is read by the whole tree and widening it to carry a
   * sealed signing secret would put trigger material in front of every caller that only wanted a
   * title. So the columns are read separately and joined here, in the one file that serves them.
   *
   * `triggerUrlPath` is a path and not a URL because this server does not reliably know its own
   * public origin - `PUBLIC_APP_URL` is the app, which is not necessarily where the API answers -
   * and a URL that is confidently wrong is worse than a path the client composes against the origin
   * it is already talking to. The path segment IS a bearer secret, so it is served only here,
   * behind the owner's own session.
   */
  const withTrigger = (
    response: TaskSchedule,
    trigger: { trigger: unknown; triggerPath: string } | undefined
  ): TaskSchedule => ({
    ...response,
    trigger: trigger ? TaskScheduleTrigger.parse(trigger.trigger) : null,
    triggerUrlPath: trigger ? `${INBOUND_TRIGGER_PATH_PREFIX}/${trigger.triggerPath}` : null
  });

  /**
   * The trigger on ONE schedule, read through the same statement the list uses.
   *
   * Every reply on this route that carries a schedule goes through `withTrigger`, and the reason is
   * a shape rather than a preference: `TaskSchedule` declares both fields `.optional()`, so a reply
   * that simply omitted them typechecked and left the client unable to tell "this schedule has no
   * trigger" from "this reply did not say". A client that refreshes its row from a PATCH or a pause
   * then loses the URL it could see a moment earlier from GET. Absent and null are different
   * answers and only one of them is true.
   *
   * `listTaskScheduleTriggers` rather than a single-row store method, which is what the list route
   * already calls: the index behind it is partial and almost every schedule has no trigger, so it
   * returns a handful of rows for an owner with a thousand schedules. One query on a route that is
   * already writing is not worth a second store method to save.
   */
  const triggerOf = async (
    userId: string,
    scheduleId: string
  ): Promise<{ trigger: unknown; triggerPath: string } | undefined> =>
    (await store.listTaskScheduleTriggers(userId)).get(scheduleId);

  app.get('/v1/schedules', async (request) => {
    const user = requireUser(request.user);
    // Read once, for the same reason `GET /v1/tasks` above reads it once: `listTaskSchedules` is
    // unbounded up to `serverLimits.maxSchedules`, which is a thousand. The trigger read is a third
    // query rather than a join because its index is partial - almost every schedule has no trigger
    // - so it returns a handful of rows however many schedules the owner has.
    const [schedules, workspaces, triggers] = await Promise.all([
      store.listTaskSchedules(user.id),
      store.listWorkspaceMetadata(user.id),
      store.listTaskScheduleTriggers(user.id)
    ]);
    return Promise.all(
      schedules.map(async (schedule) =>
        withTrigger(
          await privateScheduleResponse(
            schedule,
            workspaces.find((workspace) => workspace.id === schedule.workspaceId)
          ),
          triggers.get(schedule.id)
        )
      )
    );
  });

  app.post('/v1/schedules', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateTaskScheduleRequest.parse(request.body);
      if (input.spec.kind === 'daily' || input.spec.kind === 'weekly') {
        try {
          assertTimeZone(input.spec.timeZone);
        } catch {
          throw new GardenError('invalid_time_zone', 'Choose a valid IANA time zone');
        }
      }
      // No occurrence has been served yet, so there is no repeat to guard against - but a first
      // run that falls inside a spring-forward gap is recovered here exactly as a later one is.
      /*
       * A trigger needs a schedule that survives its own first run.
       *
       * `once` is the one spec whose `advanceScheduleRun` answers null after it fires, which
       * `materializeTaskSchedule` writes as `enabled=FALSE` - so a webhook attached to a one-time
       * schedule would answer exactly one delivery and then be a dead URL that accepted requests
       * and did nothing. Refused at creation rather than discovered in production, and refused
       * rather than silently rewritten, because which timing a schedule has is the owner's.
       */
      if (input.trigger && input.spec.kind === 'once')
        throw new GardenError(
          'trigger_needs_repeating_schedule',
          'A one-time schedule stops after its single run, so it cannot carry an inbound trigger; give it a repeating timing instead'
        );
      const nextRunAt = advanceScheduleRun(input.spec, null);
      if (!nextRunAt)
        throw new GardenError('schedule_in_past', 'The one-time schedule must be in the future');
      const workspace = await store.getWorkspace(user.id, input.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found');
      if (['failed', 'deleting'].includes(workspace.status))
        throw new GardenError('workspace_unavailable', 'Workspace is unavailable');
      const spendCeilingUsd = await resolveSpendCeiling(user.id, input.maxSpendUsd);
      await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd: spendCeilingUsd });
      if ((await store.countTaskSchedules(user.id)) >= serverLimits.maxSchedules) {
        throw new GardenError(
          'schedule_limit',
          `This server supports up to ${serverLimits.maxSchedules} scheduled tasks`
        );
      }
      const catalog = await modelsForUser(user);
      const selected = input.modelId
        ? requireMainModel({
            modelId: input.modelId,
            catalog,
            privacyRoute: input.privacyRoute,
            ceiling: ownerPriceCeiling(await store.effectiveSpendLimits(user.id))
          })
        : (
            await pickModelUnderPriceCeiling(user.id, catalog, {
              privacyRoute: input.privacyRoute,
              taskKind: inferModelTask(input.prompt)
            })
          ).model;
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== input.privacyRoute
      ) {
        throw new GardenError(
          'model_unavailable',
          'The selected cloud model is unavailable for this privacy route'
        );
      }
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const title =
        input.title ?? input.prompt.trim().split(/\s+/).slice(0, 10).join(' ').slice(0, 160);
      /*
       * The two random values an inbound trigger is made of, minted here and never again.
       *
       * 32 bytes each. The PATH is a bearer secret in its own right - nothing can post to a URL it
       * has not been told - and 256 bits is past any amount of guessing an unauthenticated endpoint
       * could be subjected to, which is why this route is not behind the passkey throttle that the
       * auth ceremonies use: that throttle is twenty attempts per fifteen minutes and would break
       * every real publisher, and the thing it protects against does not exist here.
       *
       * The SECRET is what actually authorises a request, and it is returned exactly once, in the
       * reply to this call. What this box keeps is a copy sealed under the workspace key, so the
       * plaintext is in the database at no point and someone who can read `task_schedules` but not
       * unwrap the workspace key cannot forge a signature. There is no route that shows it again:
       * an owner who loses it deletes the schedule and makes another, which is also how a leaked
       * secret is revoked.
       */
      const triggerPath = input.trigger ? randomBytes(32).toString('base64url') : null;
      const triggerSecret = input.trigger ? randomBytes(32).toString('base64url') : null;
      let schedule: TaskScheduleRecord;
      try {
        schedule = await store.createTaskSchedule({
          userId: user.id,
          workspaceId: workspace.id,
          titleCiphertext: encryptJson({ title }, key, `task-title:${workspace.id}`),
          promptCiphertext: encryptJson(
            { prompt: input.prompt },
            key,
            `task-prompt:${workspace.id}`
          ),
          modelId: selected.id,
          privacyRoute: input.privacyRoute,
          maxComputeCredits: Math.max(
            input.maxComputeCredits,
            computeAllowanceFor(selected, config.TASK_MAX_STEPS)
          ),
          maxSpendUsd: spendCeilingUsd,
          spec: input.spec,
          nextRunAt,
          maxSchedules: serverLimits.maxSchedules,
          ...(input.trigger && triggerPath && triggerSecret
            ? {
                trigger: {
                  spec: TaskScheduleTrigger.parse(input.trigger),
                  path: triggerPath,
                  secretCiphertext: encryptJson(
                    { secret: triggerSecret },
                    key,
                    `schedule-trigger:${workspace.id}`
                  )
                }
              }
            : {})
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'schedule_limit') {
          throw new GardenError(
            'schedule_limit',
            `This server supports up to ${serverLimits.maxSchedules} scheduled tasks`
          );
        }
        throw error;
      }
      reply.status(201);
      const response = withTrigger(
        await privateScheduleResponse(schedule, workspace),
        triggerPath && input.trigger
          ? { trigger: TaskScheduleTrigger.parse(input.trigger), triggerPath }
          : undefined
      );
      /*
       * The one time the signing secret is ever served. It is spread onto the response rather than
       * declared on `TaskSchedule`, because it is a property of this REPLY and not of the schedule:
       * a field on the record would invite a client to expect it from `GET /v1/schedules`, and this
       * server cannot serve it there - it does not keep the plaintext.
       */
      return triggerSecret ? { ...response, triggerSecret } : response;
    });
  });

  /**
   * Editing a watcher that already exists, which the README has promised for longer than this file
   * has been able to do it.
   *
   * There has been no route: an owner moving a daily run from nine to seven had to delete the
   * schedule and retype the whole instruction, which is how a standing instruction quietly gets
   * shorter. The agent has been able to do this from inside a conversation the entire time
   * (`agent.ts`'s `schedule` tool, `action: 'update'`), so this is the same capability reaching the
   * person the schedule belongs to.
   *
   * Two things it does that the agent's path does not:
   *
   * `maxSpendUsd` is carried forward explicitly. `updateTaskSchedule` writes `max_spend_usd` on
   * every call from `input.maxSpendUsd ?? null`, so a caller that leaves it out does not leave it
   * alone - it clears it. An edit to the timing that silently removes the money ceiling from an
   * unattended run is the exact shape of defect this pass is here to stop, and the agent's own
   * `update` arm still has it (handed off).
   *
   * `nextRunAt` is recomputed only when the timing changed, because `advanceScheduleRun(spec, null)`
   * from a schedule that has already run would move the next occurrence for an edit to the title.
   */
  app.patch<{ Params: { scheduleId: string } }>(
    '/v1/schedules/:scheduleId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = UpdateTaskScheduleRequest.parse(request.body ?? {});
        const schedule = await store.getTaskSchedule(user.id, request.params.scheduleId);
        if (!schedule) throw new GardenError('schedule_not_found', 'Schedule not found');
        const workspace = await store.getWorkspace(user.id, schedule.workspaceId);
        if (!workspace?.wrappedKey)
          throw new GardenError('workspace_not_found', 'Workspace not found');
        /*
         * Declared and refused rather than accepted and dropped. `updateTaskSchedule` does not write
         * `model_id` or `privacy_route`, and zod strips a key it does not declare - so a client
         * asking to move a watcher onto a different model would have been answered 200, with the
         * schedule unchanged and nothing anywhere saying so. Naming the same value it already has is
         * not a change and is allowed through, so a client that echoes the whole record back still
         * works.
         */
        if (
          (input.modelId !== undefined && input.modelId !== schedule.modelId) ||
          (input.privacyRoute !== undefined && input.privacyRoute !== schedule.privacyRoute)
        )
          throw new GardenError(
            'schedule_model_immutable',
            'A schedule keeps the model and privacy route it was created with; create a new schedule to change them',
            409
          );
        if (
          input.title === undefined &&
          input.prompt === undefined &&
          input.spec === undefined &&
          input.maxComputeCredits === undefined &&
          input.maxSpendUsd === undefined
        )
          throw new GardenError(
            'schedule_update_empty',
            'Provide a new title, instruction, timing, compute limit or spending ceiling'
          );
        if (input.spec && (input.spec.kind === 'daily' || input.spec.kind === 'weekly')) {
          try {
            assertTimeZone(input.spec.timeZone);
          } catch {
            throw new GardenError('invalid_time_zone', 'Choose a valid IANA time zone');
          }
        }
        const trigger = await triggerOf(user.id, schedule.id);
        /*
         * The same refusal the create route gives, on the other way in.
         *
         * Creation refuses `trigger` beside a `once` spec because a one-time schedule disables
         * itself after its single run and the URL becomes a door that accepts deliveries and does
         * nothing with them. Editing had no counterpart, so the owner could reach the identical
         * dead URL in two calls instead of one - which is the shape where a guard exists, is
         * correct, and only covers one of the ways in.
         */
        if (input.spec?.kind === 'once' && trigger)
          throw new GardenError(
            'trigger_needs_repeating_schedule',
            'A one-time schedule stops after its single run, so it cannot carry an inbound trigger; delete the trigger by deleting the schedule, or keep a repeating timing'
          );
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        const spec = input.spec ?? schedule.spec;
        /*
         * A paused schedule keeps its `next_run_at` of null - resuming is what computes one, and it
         * already does. An enabled one-time schedule whose new time is in the past is refused rather
         * than silently disabled, the same refusal and the same code the agent's `update` gives.
         */
        const nextRunAt =
          input.spec === undefined
            ? schedule.nextRunAt === null
              ? null
              : new Date(schedule.nextRunAt)
            : schedule.enabled
              ? advanceScheduleRun(spec, null)
              : null;
        if (input.spec !== undefined && schedule.enabled && !nextRunAt)
          throw new GardenError(
            'schedule_in_past',
            'An enabled one-time schedule must be in the future'
          );
        const title = input.title ?? (await scheduleTitle(schedule, workspace));
        const prompt = input.prompt ?? schedulePrompt(schedule, workspace);
        if (!prompt)
          throw new GardenError(
            'encrypted_prompt_context',
            'This server cannot read the instruction on this schedule; send a new one with this edit'
          );
        const updated = await store.updateTaskSchedule(user.id, schedule.id, {
          titleCiphertext: encryptJson({ title }, key, `task-title:${workspace.id}`),
          promptCiphertext: encryptJson({ prompt }, key, `task-prompt:${workspace.id}`),
          spec,
          maxComputeCredits: input.maxComputeCredits ?? schedule.maxComputeCredits,
          maxSpendUsd: input.maxSpendUsd === undefined ? schedule.maxSpendUsd : input.maxSpendUsd,
          nextRunAt
        });
        if (!updated) throw new GardenError('schedule_not_found', 'Schedule not found');
        return withTrigger(await privateScheduleResponse(updated, workspace), trigger);
      });
    }
  );

  app.post<{ Params: { scheduleId: string; action: string } }>(
    '/v1/schedules/:scheduleId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const action = z.enum(['pause', 'resume', 'run']).parse(request.params.action);
        const schedule = await store.getTaskSchedule(user.id, request.params.scheduleId);
        if (!schedule) throw new GardenError('schedule_not_found', 'Schedule not found');
        const nextRunAt =
          action === 'run'
            ? new Date()
            : action === 'resume'
              ? advanceScheduleRun(schedule.spec, null)
              : null;
        if (action === 'resume' && !nextRunAt) {
          throw new GardenError(
            'schedule_finished',
            'This one-time schedule has already passed; create a new schedule instead',
            409
          );
        }
        /*
         * Run now, on a schedule whose previous run has not finished, is REFUSED HERE - and this is
         * a decision rather than a guard that happened to be reachable.
         *
         * The overlap policy in `maintenance/schedule-dispatch.ts` is right for a clock: an
         * occurrence that arrives while the last one is still going is skipped, because starting a
         * second copy is a second compute reservation and a second model turn on the same
         * instruction, and unlike cron on a laptop every duplicate here costs the owner money. But
         * `run` moved `next_run_at` to now and returned 200, and the very next poll deferred it
         * with `previous_run_active` - so the owner pressed a button, nothing started, and five
         * minutes later the row said the last run had failed. An owner who asks for a run now is
         * not a clock, and they are entitled to either a run or a sentence.
         *
         * The sentence, and not an exemption. An exemption would be the same multiplication the
         * policy exists to prevent, on the argument that the owner asked for it - and the owner
         * cannot see from this button that a previous run is open, so what they would be asking for
         * knowingly is not what they would get. Refusing names the conversation instead, and leaves
         * the two ways out that do not spend twice: open it and let it finish, or cancel it. A
         * second run is still reachable deliberately - cancel, then press again - but only by
         * ending the first, so at most one run of a schedule is ever spending.
         *
         * `pause` and `resume` are not checked. Pausing a schedule whose run is open is exactly
         * what an owner does about it, and resume computes the NEXT occurrence, which the
         * dispatcher's own overlap check meets in the ordinary way if the run is still open then.
         */
        if (action === 'run') {
          const inFlight = await store.taskScheduleRunInFlight(schedule.id);
          if (inFlight)
            throw new GardenError(
              'previous_run_active',
              'This schedule already has a run that has not finished; open that conversation and let it finish or cancel it, then run this again',
              409
            );
        }
        const updated = await store.setTaskScheduleEnabled(
          user.id,
          schedule.id,
          action !== 'pause',
          nextRunAt
        );
        if (!updated) throw new GardenError('schedule_not_found', 'Schedule not found');
        return withTrigger(
          await privateScheduleResponse(updated),
          await triggerOf(user.id, schedule.id)
        );
      });
    }
  );

  /**
   * The inbound trigger: the one door on this box that something other than the owner or a clock
   * can start work through.
   *
   * IT IS REGISTERED IN ITS OWN ENCAPSULATED SCOPE, and that is load-bearing rather than tidiness.
   * An HMAC is over BYTES, so verifying one needs the body exactly as it arrived - and Fastify's
   * default JSON parser hands back a parsed object, from which the original bytes cannot be
   * recovered (key order, whitespace and number formatting are all gone). `rawBody` is declared on
   * `FastifyRequest` in `auth-hook.ts` and nothing has ever populated it. Replacing the parser on
   * the root instance would change how every route in this server reads its body; inside
   * `app.register` the parser table is cloned, so `removeAllContentTypeParsers` here removes them
   * for this one route and for nothing else. The root's hooks still apply, because they were added
   * before this plugin was registered - which is the ordering `auth-hook.ts` says is load-bearing,
   * read from the other side.
   *
   * WHAT AUTHORISES A REQUEST is the signature and not the URL. `/v1/hooks/:token` is on
   * `publicPaths`, so no session and no bearer token is required - a build server has neither - and
   * everything below runs before anything is written. The path is 256 bits of randomness, which
   * makes it a bearer secret too, but it is the weaker of the two: a URL leaks into logs, proxies
   * and browser history, and a signature does not.
   *
   * WHAT IT DOES NOT DO: it does not create a task. It moves `next_run_at` on a schedule row and
   * returns. The dispatcher materialises the run through `materializeTaskSchedule` exactly as a
   * clock occurrence does, so the spend guard, the workspace's security mode, the compute
   * reservation, the approval floor, the three-strike pause and the overlap policy all apply
   * because they are the same code, not because this route remembered to call them. That is the
   * whole reason this is a trigger on a schedule rather than a second way to start a task.
   *
   * THE PAYLOAD IS NEVER PUT INTO A PROMPT. It is sealed under the workspace key here and written
   * by the dispatcher into `workspace/downloads/inbound/`, which is under the prefix
   * `DOWNLOAD_QUARANTINE_PREFIXES` already lists - so reading it back taints the turn exactly as a
   * downloaded page does, through the rule that already exists.
   */
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    scope.post<{ Params: { token: string } }>(
      `${INBOUND_TRIGGER_PATH_PREFIX}/:token`,
      async (request, reply) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        /*
         * Refused before the lookup, because a body this box will not keep is a body it should not
         * spend a database round trip reading a secret for. Fastify's own `bodyLimit` would answer
         * at a megabyte; this is the bound that is actually argued.
         */
        if (body.byteLength > MAX_DELIVERY_BYTES)
          throw new GardenError(
            'hook_payload_too_large',
            `An inbound delivery is at most ${MAX_DELIVERY_BYTES} bytes`,
            413
          );
        /*
         * The shape of what this box mints, checked before the query. A path that cannot be one of
         * ours names nothing, and answering that from a regular expression rather than from an
         * index keeps a scan of arbitrary strings off the database entirely.
         */
        const token = request.params.token;
        if (!/^[A-Za-z0-9_-]{43}$/.test(token))
          throw new GardenError('hook_not_found', 'No trigger matches this address', 404);
        const found = await store.taskScheduleByTriggerPath(token);
        if (!found) throw new GardenError('hook_not_found', 'No trigger matches this address', 404);
        const workspace = await store.getWorkspaceById(found.workspaceId);
        if (!workspace?.wrappedKey)
          throw new GardenError('hook_not_found', 'No trigger matches this address', 404);

        const timestamp = Number(request.headers['x-garden-timestamp']);
        const presented = String(request.headers['x-garden-signature'] ?? '');
        const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
        if (!Number.isFinite(timestamp) || skew > SIGNATURE_WINDOW_SECONDS)
          throw new GardenError(
            'hook_timestamp_outside_window',
            `Sign each delivery with a current timestamp; this one is outside the ${SIGNATURE_WINDOW_SECONDS} second window`,
            401
          );
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        const { secret } = decryptJson<{ secret: string }>(found.secretCiphertext, key);
        const expected = createHmac('sha256', secret)
          .update(`${SIGNATURE_VERSION}:${timestamp}:`)
          .update(body)
          .digest();
        /*
         * Constant time, and length-checked first because `timingSafeEqual` throws on a mismatch
         * rather than answering false - which would turn "wrong length" into a 500 and, worse, into
         * a distinguishable answer. The same reasoning `packages/core/src/crypto.ts` states for
         * every other comparison in this codebase that is keyed on a secret.
         */
        const offered = Buffer.from(
          presented.startsWith(`${SIGNATURE_VERSION}=`)
            ? presented.slice(SIGNATURE_VERSION.length + 1)
            : '',
          'hex'
        );
        if (offered.length !== expected.length || !timingSafeEqual(offered, expected))
          throw new GardenError(
            'hook_signature_invalid',
            'The signature does not match this delivery',
            401
          );

        const trigger = TaskScheduleTrigger.parse(found.trigger);
        const recorded = await store.recordTriggerDelivery({
          scheduleId: found.id,
          // The signature is the dedupe key, and it is the right one: it covers the version, the
          // timestamp and every byte of the body, so two requests share it only when they are the
          // same signed request presented twice.
          signature: expected.toString('hex'),
          bodyCiphertext: encryptJson(
            {
              // Base64 rather than text, because a delivery is bytes and this box does not get to
              // decide it was UTF-8. The dispatcher writes these bytes back out unchanged.
              bodyBase64: body.toString('base64'),
              contentType: String(request.headers['content-type'] ?? 'application/octet-stream'),
              receivedAt: new Date().toISOString()
            },
            key,
            `schedule-delivery:${found.id}`
          ),
          byteSize: body.byteLength,
          minGapMinutes: trigger.minGapMinutes,
          maxPending: MAX_PENDING_DELIVERIES,
          maxPerHour: MAX_DELIVERIES_PER_HOUR
        });
        log.info('schedule.trigger_delivery', {
          scheduleId: found.id,
          code: recorded.outcome
        });
        if (recorded.outcome === 'rate_limited' || recorded.outcome === 'too_many_pending')
          throw new GardenError(
            recorded.outcome === 'rate_limited'
              ? 'hook_rate_limited'
              : 'hook_deliveries_not_kept_up',
            recorded.outcome === 'rate_limited'
              ? `This trigger accepts ${MAX_DELIVERIES_PER_HOUR} deliveries an hour`
              : /*
                 * The byte total is the only reader `task_schedule_deliveries.byte_size` has, and
                 * it is here because the count alone does not say what the backlog IS: sixteen
                 * unread deliveries is sixteen bytes or a megabyte about to be written into the
                 * owner's workspace, and the sender is the one party who can tell which of those it
                 * sent. A refusal sentence costs nothing on the wire - it is not a tool description
                 * or a schema - and it is where a publisher is already looking.
                 */
                `This trigger has ${MAX_PENDING_DELIVERIES} deliveries its runs have not read yet, ${recorded.pendingBytes} bytes in all`,
            429
          );
        /*
         * A replay and a publisher's own retry are the same request, so both get the same answer:
         * 200 and the fact that this was already taken. Answering an error would make a well-behaved
         * publisher retry harder at exactly the moment nothing more is wanted.
         */
        reply.status(recorded.outcome === 'duplicate' ? 200 : 202);
        return {
          accepted: recorded.outcome !== 'duplicate',
          duplicate: recorded.outcome === 'duplicate',
          // Said plainly rather than implied by a 202: a paused schedule keeps its URL and keeps
          // its deliveries, and a sender that is told nothing would go on believing work started.
          armed: recorded.outcome === 'accepted',
          runsAt: recorded.nextRunAt
        };
      }
    );
  });

  app.delete<{ Params: { scheduleId: string } }>(
    '/v1/schedules/:scheduleId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => ({
        deleted: await store.deleteTaskSchedule(user.id, request.params.scheduleId)
      }));
    }
  );
};
