import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GardenError, isMemoryToken } from '@garden/core';
import type { ConversationNameIndex, EncryptedEnvelope } from '@garden/core';
import { TaskEventKind, TaskStatus, PENDING_MEDIA_DELIVERY } from '@garden/contracts';
import { taskDeliveryCountsSql } from '../task-delivery.js';
import type { Database } from '../database.js';
import type {
  TaskEventRecord,
  TaskMessageQueueRecord,
  TaskPlanRecord,
  TaskRecord
} from '../types.js';
import {
  encryptedText,
  iso,
  json,
  mapTask,
  mapTaskEvent,
  mapTaskMessage,
  mapTaskPlan,
  optionalText
} from './rows.js';
import {
  COMMITTED_TASK_STATUSES,
  HELD_LEASE_JOIN,
  TASK_LIVE_COUNTS,
  TASK_NAME_SEARCH_SQL,
  TASKS_WITH_TURNS_IN_WINDOW_SQL,
  TURN_TOOL_STARTS_SQL,
  taskNameTokens,
  taskNameTsv,
  WORKSPACE_IS_FREE_FOR
} from './sql/tasks.js';

async function releasePromotedMessageReservations(tx: Database, taskId: string): Promise<void> {
  await tx.query(
    `UPDATE usage_entries u SET state='released'
     FROM task_message_queue q JOIN tasks t ON t.id=q.task_id AND t.user_id=q.user_id
     WHERE q.task_id=$1 AND q.status='promoted'
       AND u.idempotency_key=q.reservation_key AND u.task_id=q.task_id AND u.user_id=q.user_id
       AND u.kind='task_compute' AND u.state='reserved'`,
    [taskId]
  );
}

/** Payload is the task id, so a stream only wakes for the conversation it is showing. */
export const TASK_EVENT_CHANNEL = 'garden_task_event';
/** Payload is the task id, but every worker slot wakes: whichever leases it first wins. */
export const TASK_QUEUE_CHANNEL = 'garden_task_queued';
/**
 * Payload is the task id of a conversation that just gained an answer, which is the only moment a
 * placeholder title can be replaced by a real one. Every titler wakes; the write is conditional on
 * the title still being a placeholder, so a second one finds nothing to do.
 */
export const TASK_ANSWERED_CHANNEL = 'garden_task_answered';

/**
 * How many times a task may be leased before the queue stops handing it to anyone.
 *
 * The count is cleared wherever something went right on the far side of the write that puts a task
 * back in the queue - a follow-up message (`continueTask`, `promoteQueuedTaskMessage`) or a resume
 * (`setTaskStatusForUser`) - so this is six starts since the last time anything went right, not six
 * turns. A step that merely runs long renews its lease rather than taking a new one, so it never
 * spends one of these.
 *
 * `requeueTaskForQueuedMessage` is the one door back that leaves the count standing, because
 * nothing went right on its far side: a turn died holding a message the owner had sent it. Carrying
 * the count is the whole of what bounds that retry, so a failure that simply repeats walks up to
 * this number and stops rather than needing a second limit of its own.
 *
 * Six because a task that kills its worker was otherwise immortal: systemd restarts the worker,
 * `ORDER BY created_at` puts the corpse back at the front, and the box spends forever re-running
 * the one turn it cannot survive while the message the owner sent after it is never reached.
 * Nothing was logged, because nothing failed - the process was simply gone.
 */
export const TASK_MAX_ATTEMPTS = 6;

/**
 * A page a phone on cellular can actually receive; the cursor is what reaches the rest.
 *
 * Exported so a route can bound its own read by the same number the store pages at, rather than
 * naming a second one beside it that then drifts.
 */
export const MAX_TASK_EVENT_PAGE = 500;

/** The statuses a conversation has stopped in. Nothing is running behind one of these. */
export const SETTLED_TASK_STATUSES: readonly string[] = [
  'paused',
  'completed',
  'failed',
  'cancelled'
];

/**
 * The rest of them, and derived rather than written out, because this list is what a refusal is
 * made of: "may I put this computer's files back" is answered by asking whether any conversation
 * in it is still live. Written out as its own list it would be one status behind the enum the day
 * a new one was added, and the failure is silent - the refusal simply stops refusing, while an
 * agent is still working.
 *
 * Deriving it means a status nobody has classified counts as live, so the new failure is a restore
 * refused rather than a restore that ran underneath a working agent.
 */
export const LIVE_TASK_STATUSES: readonly string[] = TaskStatus.options.filter(
  (status) => !SETTLED_TASK_STATUSES.includes(status)
);

export interface TaskEventPage {
  /** Always oldest first, whichever direction the page was read in. */
  events: TaskEventRecord[];
  /** More events exist beyond this page in the direction it was read. */
  hasMore: boolean;
  /** Lowest sequence on this page; pass it as `before` to walk further back. */
  oldestSequence: number | null;
  /** Highest sequence seen; the cursor a forward reader or event stream resumes from. */
  nextCursor: number;
}

/**
 * Either a turn beginning or a tool call being dispatched, with the turn it belongs to.
 *
 * The tool's NAME is not here, and cannot be: `tool-recording.ts` puts it inside the encrypted
 * payload and writes `Encrypted tool started event` into the plaintext `summary` column, so a
 * reader that wants the name has to hold the workspace's data key. That is the shape this row is
 * built for - the store hands back what it can read, and the caller that already unwrapped the key
 * does the opening. A plaintext tool column would make this query trivial and would also tell
 * anyone holding the database file which of the owner's conversations touched a mailbox.
 */
export interface TurnToolStartRecord {
  id: string;
  sequence: number;
  /** 1 for the opening request; +1 at each `user_message` row that follows. */
  turn: number;
  kind: 'user_message' | 'tool_started';
  /** Null on every `user_message` row, and on a `tool_started` row written without one. */
  payloadCiphertext: EncryptedEnvelope | null;
  createdAt: string;
}

export interface TurnToolStartPage {
  rows: TurnToolStartRecord[];
  hasMore: boolean;
  /** Highest sequence on this page; pass it back as `after` to continue. */
  nextCursor: number;
}

/** Just enough of a conversation to open its events and place its first turn in time. */
export interface TaskInWindow {
  id: string;
  workspaceId: string;
  /** When the opening request arrived. Turn one opens here and nowhere else. */
  createdAt: string;
}

/**
 * How many conversations one open-rate read will walk, and what chose the number.
 *
 * At the longest window this read accepts - `MAX_WINDOW_DAYS`, 92 days - two thousand conversations
 * is around twenty-two a day, every day, for three months. No box this ships to has produced that,
 * and the ceiling is here so that one cannot make an owner's weekly read run without end rather
 * than because it is expected to bind. Newest first, so what a truncated answer loses is the oldest
 * end of the window, and the caller is told it happened rather than left with a short number.
 */
export const MAX_TASKS_PER_TOOL_OPEN_READ = 2_000;

/** How much of the sidebar a page is allowed to be, whatever the caller asks for. */
export const MAX_TASK_PAGE = 500;

/**
 * How many runs of any one schedule a page of the conversation list may carry.
 *
 * A watcher on a fifteen-minute interval mints ninety-six conversations a day. The list is ordered
 * by activity and every run is a conversation, so without a ceiling one schedule the owner set up
 * once takes the whole first page in about two days, and everything they did by hand is off the end
 * of the list they use to find their own work. The client folds runs of a schedule into a single
 * line, but it can only fold what it was handed, so the crowding has to be answered here.
 *
 * Five, because the line is a control the owner opens rather than a place work is read: it wants
 * enough behind it to be worth opening, not the whole history. The rest of the runs are not lost -
 * `scheduleId` pages them, and the true number of them travels with the page so the folded line can
 * say how many there really are rather than how many it happens to be holding.
 *
 * A run the owner pinned is theirs now, not the schedule's, and is never counted or capped: the
 * client leaves pinned runs out of the fold for the same reason.
 */
const SCHEDULE_RUNS_PER_PAGE = 5;

export type TaskListFilter = 'active' | 'archived' | 'all';

export interface TaskPage {
  tasks: TaskRecord[];
  /** Pass back as `cursor` for the next page. Null when this page is the end of the list. */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * For every schedule with a run on this page, how many runs it has in the list being read - not
   * how many of them the page is carrying, which the ceiling above keeps small on purpose. This is
   * what lets one folded line report four hundred runs while holding five of them.
   */
  scheduleRunCounts: Record<string, number>;
}

/** Just enough of a conversation to rank it, name it and open it. Never its agent state. */
export interface TaskNameHit {
  id: string;
  workspaceId: string;
  titleCiphertext: EncryptedEnvelope | null;
  legacyTitle: string | null;
  promptCiphertext: EncryptedEnvelope;
  updatedAt: string;
  /** The conversation's own name carries every term of the request. */
  wholeName: boolean;
  /** Its name carries at least one of them. */
  inName: boolean;
  /** A word of its name begins with the word the owner had not finished typing. */
  namePrefix: boolean;
}

/**
 * The sidebar's position, as the three values its ordering is built from.
 *
 * Keyset rather than an offset: conversations move as they are answered, and an offset would show
 * the same conversation twice or skip one entirely every time that happened while the owner was
 * reading. The id is the tiebreak, so two conversations touched in the same instant still have one
 * order.
 *
 * The timestamp is carried as the database's own text for it rather than as a JavaScript date,
 * because a position has to be able to express the ordering exactly. PostgreSQL keeps microseconds
 * and `Date` keeps milliseconds, so a cursor built from the mapped record rounded the last row of
 * the page up - and every conversation that shared its millisecond then sorted "after" the cursor
 * and was skipped by the next page. Nothing about that was visible: the page simply came back
 * short, and the conversation was still there, unreachable except through search.
 */
const encodeTaskCursor = (row: Record<string, unknown>): string =>
  Buffer.from(
    `${row.pinned === true ? '1' : '0'}|${String(row.activity_at)}|${String(row.id)}`,
    'utf8'
  ).toString('base64url');

const decodeTaskCursor = (cursor: string): { pinned: boolean; activityAt: string; id: string } => {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const [pinned, activityAt, id] = parts;
  // Parsed only to reject what is not a timestamp at all; what travels on is the original text, at
  // whatever precision the database wrote it.
  const at = new Date(String(activityAt));
  if (parts.length !== 3 || (pinned !== '0' && pinned !== '1') || Number.isNaN(at.getTime()) || !id)
    throw new GardenError('invalid_cursor', 'That conversation list position is not valid');
  return { pinned: pinned === '1', activityAt: String(activityAt), id };
};

/**
 * Delivery for the three task channels, local and cross-process.
 *
 * One object rather than a mixin because there is one of each per process: one emitter, and one
 * LISTEN connection carrying all three channels. `TaskStore` and `ScheduleStore` both write rows
 * worth waking somebody for, and they share this rather than each opening a connection of their
 * own - which is what the bridge's own retry comment is about.
 */
export class TaskSignals {
  constructor(private readonly database: Database) {}

  /**
   * Local delivery of the two signals below. One listener per open activity stream and one per
   * worker slot, so the ceiling is the stream cap rather than Node's default ten.
   */
  readonly #signals = new EventEmitter().setMaxListeners(0);

  #bridging = false;

  /** Channels this process has already subscribed to, so a retry never subscribes to one twice. */
  readonly #bridgedChannels = new Set<string>();

  readonly #bridged: ReadonlyArray<readonly [string, (payload: string) => void]> = [
    [TASK_EVENT_CHANNEL, (taskId) => this.#signals.emit(`${TASK_EVENT_CHANNEL}:${taskId}`)],
    [TASK_QUEUE_CHANNEL, () => this.#signals.emit(TASK_QUEUE_CHANNEL)],
    [TASK_ANSWERED_CHANNEL, () => this.#signals.emit(TASK_ANSWERED_CHANNEL)]
  ];

  /**
   * Cross-process delivery for the same signals.
   *
   * Started on the first subscription rather than in the constructor, so a process that only
   * writes - the notifier, a migration, a test - never opens the extra connection. Until the
   * bridge is up, local emission still works and the caller's timer covers the gap, which is why
   * nothing awaits it.
   */
  #bridge(): void {
    if (this.#bridging) return;
    this.#bridging = true;
    void (async () => {
      // Each channel is retried on its own. Subscribing to all three under one flag meant that a
      // failure on the third left the flag clear, and the next subscriber re-subscribed to the
      // first two - so every task event was then delivered twice, three times, once per retry.
      for (const [channel, deliver] of this.#bridged) {
        if (this.#bridgedChannels.has(channel)) continue;
        await this.database.listen(channel, deliver);
        this.#bridgedChannels.add(channel);
      }
    })().catch(() => {
      // Retried by the next subscriber. Until then local delivery still works and the reader's
      // own timer covers the gap, which is exactly what it is there for.
      this.#bridging = false;
    });
  }

  signal(channel: string, payload: string): void {
    this.#signals.emit(channel === TASK_EVENT_CHANNEL ? `${channel}:${payload}` : channel);
    // A failed wake-up is not a failed write: the reader polls anyway, one second later.
    void this.database.notify(channel, payload).catch(() => undefined);
  }

  /**
   * Calls back when this task gains an event, wherever in the install it was written.
   *
   * This is what turns the activity stream from "re-read the table every second" into "write, then
   * deliver", which is the difference between a reply that steps and a reply that streams.
   */
  onTaskEvent(taskId: string, listener: () => void): () => void {
    this.#bridge();
    const name = `${TASK_EVENT_CHANNEL}:${taskId}`;
    this.#signals.on(name, listener);
    return () => {
      this.#signals.off(name, listener);
    };
  }

  /** Resolves as soon as any task is queued, or after `timeoutMs` - whichever comes first. */
  async waitForQueuedTask(timeoutMs: number): Promise<void> {
    this.#bridge();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#signals.off(TASK_QUEUE_CHANNEL, done);
        resolve();
      };
      // Unreferenced so an idle worker never keeps the process alive on its own.
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      this.#signals.on(TASK_QUEUE_CHANNEL, done);
    });
  }

  /** Resolves as soon as any conversation gains an answer, or after `timeoutMs`. */
  async waitForAnsweredTask(timeoutMs: number): Promise<void> {
    this.#bridge();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#signals.off(TASK_ANSWERED_CHANNEL, done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      this.#signals.on(TASK_ANSWERED_CHANNEL, done);
    });
  }
}

/**
 * A conversation: creating one, queueing messages into it, leasing it to a worker, and its
 * timeline.
 *
 * The lease is the load-bearing part. One computer is one writer, so a task holds its workspace
 * while it runs and every other task in that workspace is passed over rather than leased; the
 * statements that take, renew, release and expire that hold are all here, next to each other, on
 * purpose. Every write that ends a hold signals it, so whatever was queued behind it starts within
 * a signal rather than within a poll.
 */
export class TaskStore {
  readonly #taskSignals: TaskSignals;

  /**
   * Assigned in the constructor body rather than in a field initialiser, for the reason
   * `DataStore` records: `database` is a parameter property, and with `useDefineForClassFields` on
   * under ES2022 a field initialiser runs before the constructor body assigns it.
   */
  constructor(
    private readonly database: Database,
    taskSignals: TaskSignals
  ) {
    this.#taskSignals = taskSignals;
  }

  /**
   * Says that this task has changed, to whoever is watching it and wherever they are.
   *
   * Delivery is `TaskSignals`' business and this is the task domain's word for it, which is the
   * split Wave 7.3 made: the emitter, the LISTEN connection and its retry are one machine, and the
   * fifteen writes below that have something to announce are another. `schedules.ts` holds the same
   * one-line forwarder for the same reason - a materialised run is a task arriving.
   */
  #signal(channel: string, payload: string): void {
    this.#taskSignals.signal(channel, payload);
  }

  /**
   * Says that this task has just let go of its workspace, so whatever was queued behind it can run.
   *
   * One computer is one writer: while a conversation holds an unexpired lease, every other
   * conversation in that workspace is passed over rather than leased. Arrivals into the queue have
   * always been announced; letting go was not, so the conversation that had been waiting became
   * leasable on that write and then sat out the whole worker poll before anyone looked - at exactly
   * the moment the owner is watching one thing finish and the next begin.
   *
   * Two conditions on every caller, and both matter. It signals after its transaction has
   * committed, so nothing wakes to find the row it was told about unchanged. And it signals only
   * where the row it wrote was holding the workspace a moment earlier: a lease that had already
   * run out was excluding nobody, and waking every worker slot on every task update would trade
   * this delay for a stampede.
   */
  #signalWorkspaceRelease(taskId: string): void {
    this.#signal(TASK_QUEUE_CHANNEL, taskId);
  }

  async createTask(input: {
    projectId?: string;
    modelOverride?: boolean;
    modelChoicesCiphertext?: EncryptedEnvelope;
    conversationSourceCiphertext?: EncryptedEnvelope;
    userId: string;
    workspaceId: string;
    titleCiphertext: EncryptedEnvelope;
    /** Built by `buildConversationNameIndex`; the only way this conversation's name is findable. */
    nameIndex: ConversationNameIndex;
    modelId: string;
    reasoningEffort?: TaskRecord['reasoningEffort'];
    privacyRoute: string;
    maxComputeCredits: number;
    maxSpendUsd?: number | null;
    promptCiphertext: EncryptedEnvelope;
    securityMode?: TaskRecord['securityMode'];
  }): Promise<TaskRecord> {
    const id = randomUUID();
    const result = await this.database.query(
      `INSERT INTO tasks(
        id,user_id,workspace_id,title,status,model_id,privacy_route,max_compute_credits,
        prompt_ciphertext,security_mode,max_spend_usd,name_tsv,reasoning_effort,project_id,model_override,conversation_source_ciphertext,model_choices_ciphertext
       ) VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8::jsonb,$9,$10,${taskNameTsv(11, 12, 13)},$14,
         $15,$16,$17::jsonb,$18::jsonb)
       RETURNING *`,
      [
        id,
        input.userId,
        input.workspaceId,
        JSON.stringify(input.titleCiphertext),
        input.modelId,
        input.privacyRoute,
        input.maxComputeCredits,
        JSON.stringify(input.promptCiphertext),
        input.securityMode ?? 'balanced',
        input.maxSpendUsd ?? null,
        ...taskNameTokens(input.nameIndex),
        input.reasoningEffort ?? 'auto',
        input.projectId ?? null,
        input.modelOverride ?? false,
        input.conversationSourceCiphertext
          ? JSON.stringify(input.conversationSourceCiphertext)
          : null,
        input.modelChoicesCiphertext ? JSON.stringify(input.modelChoicesCiphertext) : null
      ]
    );
    const task = mapTask(result.rows[0]!);
    this.#signal(TASK_QUEUE_CHANNEL, task.id);
    return task;
  }

  async createTaskBranch(input: {
    id?: string;
    userId: string;
    workspaceId: string;
    parentTaskId: string;
    branchedFromEventId?: string;
    forkKind?: NonNullable<TaskRecord['forkKind']>;
    titleCiphertext: EncryptedEnvelope;
    nameIndex: ConversationNameIndex;
    modelId: string;
    reasoningEffort?: TaskRecord['reasoningEffort'];
    privacyRoute: string;
    promptCiphertext: EncryptedEnvelope;
    agentStateCiphertext: EncryptedEnvelope | null;
    status?: 'completed' | 'queued';
    maxComputeCredits?: number;
    maxSpendUsd?: number | null;
    securityMode?: TaskRecord['securityMode'];
    /** Which of the two this fork rewound. Defaults to the conversation, as it always did. */
    rewindScope?: NonNullable<TaskRecord['rewindScope']>;
    /** The checkpoint the computer was put back to, when this fork rewound it. */
    restoredCheckpointId?: string | null;
  }): Promise<TaskRecord> {
    const id = input.id ?? randomUUID();
    const result = await this.database.query(
      `INSERT INTO tasks(
        id,user_id,workspace_id,parent_task_id,branched_from_event_id,title,status,model_id,
        privacy_route,max_compute_credits,prompt_ciphertext,agent_state_ciphertext,completed_at,
        fork_kind,security_mode,max_spend_usd,rewind_scope,restored_checkpoint_id,name_tsv,reasoning_effort,
        model_override,model_choices_ciphertext,model_preferences_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,
        CASE WHEN $7='completed' THEN NOW() ELSE NULL END,$13,$14,$15,$16,$17,
        ${taskNameTsv(18, 19, 20)},COALESCE($21,(SELECT reasoning_effort FROM tasks WHERE id=$4 AND user_id=$2),'auto'),
        (SELECT model_override OR model_id<>$8 FROM tasks WHERE id=$4 AND user_id=$2),
        (SELECT model_choices_ciphertext FROM tasks WHERE id=$4 AND user_id=$2),
        (SELECT model_preferences_revision FROM tasks WHERE id=$4 AND user_id=$2))
       RETURNING *`,
      [
        id,
        input.userId,
        input.workspaceId,
        input.parentTaskId,
        input.branchedFromEventId ?? null,
        JSON.stringify(input.titleCiphertext),
        input.status ?? 'completed',
        input.modelId,
        input.privacyRoute,
        input.maxComputeCredits ?? 0,
        JSON.stringify(input.promptCiphertext),
        input.agentStateCiphertext ? JSON.stringify(input.agentStateCiphertext) : null,
        input.forkKind ?? 'branch',
        input.securityMode ?? 'balanced',
        input.maxSpendUsd ?? null,
        input.rewindScope ?? 'conversation',
        input.restoredCheckpointId ?? null,
        ...taskNameTokens(input.nameIndex),
        input.reasoningEffort ?? null
      ]
    );
    const fork = mapTask(result.rows[0]!);
    if (fork.status === 'queued') this.#signal(TASK_QUEUE_CHANNEL, fork.id);
    return fork;
  }

  async continueTask(input: {
    id: string;
    userId: string;
    modelId: string;
    modelOverride?: boolean;
    reasoningEffort?: TaskRecord['reasoningEffort'];
    securityMode?: TaskRecord['securityMode'];
    privacyRoute: string;
    additionalComputeCredits: number;
    /** Extra real currency this follow-up may spend, on top of what the task already spent. */
    additionalSpendUsd?: number | null;
    agentStateCiphertext: EncryptedEnvelope;
    reservationKey: string;
    resourceClass: string;
    userMessageCiphertext: EncryptedEnvelope;
    userMessageId?: string;
  }): Promise<TaskRecord | null> {
    const resumed = await this.database.transaction(async (tx) => {
      const updated = await tx.query(
        // A follow-up on a task that had no dollar ceiling is allowed to introduce one, so the new
        // ceiling is anchored to what the task has already spent rather than to zero - otherwise
        // asking for "$2 more" on a task that spent $5 would read as an instantly-breached cap.
        `UPDATE tasks t SET
           status='queued', pending_question_id=NULL, model_override=model_override OR $10 OR model_id<>$3, model_id=$3, privacy_route=$4, reasoning_effort=COALESCE($8,reasoning_effort), security_mode=COALESCE($9,security_mode),
           max_compute_credits=max_compute_credits+$5,
           max_spend_usd=CASE WHEN $7::double precision IS NULL THEN max_spend_usd ELSE
             COALESCE(max_spend_usd, (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=t.id AND u.state='settled')) + $7::double precision END,
           agent_state_ciphertext=$6::jsonb,
           -- The one way back into the queue for a task the attempt ceiling stopped, so it has to
           -- clear the count: the owner writing again is a new start, and leaving the old count
           -- standing would mean their message was accepted and then silently never leased.
           attempt=0,
           lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL, updated_at=NOW()
         WHERE t.id=$1 AND t.user_id=$2 AND t.parent_mission_id IS NULL
           AND t.status IN ('completed','failed','awaiting_resource','cancelled')
           AND t.lease_owner IS NULL
         RETURNING t.*,${TASK_LIVE_COUNTS}`,
        [
          input.id,
          input.userId,
          input.modelId,
          input.privacyRoute,
          input.additionalComputeCredits,
          JSON.stringify(input.agentStateCiphertext),
          input.additionalSpendUsd ?? null,
          input.reasoningEffort ?? null,
          input.securityMode ?? null,
          input.modelOverride ?? false
        ]
      );
      if (!updated.rows[0]) return null;
      await tx.query(
        `INSERT INTO usage_entries(
           id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
           idempotency_key
         ) SELECT $1,$2,workspace_id,id,'task_compute',$3,$4,'credits',$4,'reserved',$5
           FROM tasks WHERE id=$6
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          input.userId,
          input.resourceClass,
          input.additionalComputeCredits,
          input.reservationKey,
          input.id
        ]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'user_message','User message',$3::jsonb
         FROM task_events WHERE task_id=$2`,
        [input.userMessageId ?? randomUUID(), input.id, JSON.stringify(input.userMessageCiphertext)]
      );
      return mapTask(updated.rows[0]);
    });
    if (resumed) {
      this.#signal(TASK_QUEUE_CHANNEL, resumed.id);
      this.#signal(TASK_EVENT_CHANNEL, resumed.id);
    }
    return resumed;
  }

  async enqueueTaskMessage(input: {
    id: string;
    taskId: string;
    userId: string;
    modelId: string;
    modelOverride?: boolean;
    reasoningEffort?: TaskRecord['reasoningEffort'];
    securityMode?: TaskRecord['securityMode'];
    privacyRoute: string;
    maxComputeCredits: number;
    maxSpendUsd?: number | null;
    resourceClass: string;
    reservationKey: string;
    promptCiphertext: EncryptedEnvelope;
    queuedEventCiphertext: EncryptedEnvelope;
    queuedEventId?: string;
    questionId?: string;
    /** Apply this to the turn already running rather than waiting for it to finish. */
    interrupt?: boolean;
  }): Promise<TaskRecord | null> {
    const queued = await this.database.transaction(async (tx) => {
      const taskResult = await tx.query(
        `SELECT t.*,${TASK_LIVE_COUNTS}
         FROM tasks t WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE`,
        [input.taskId, input.userId]
      );
      const row = taskResult.rows[0];
      if (
        !row ||
        row.parent_mission_id ||
        (!['queued', 'planning', 'running', 'awaiting_user', 'paused'].includes(
          String(row.status)
        ) &&
          !(
            row.status === 'awaiting_resource' &&
            input.questionId &&
            input.maxComputeCredits === 0
          ))
      )
        return null;
      await tx.query(
        `INSERT INTO task_message_queue(
           id,task_id,user_id,prompt_ciphertext,model_id,privacy_route,max_compute_credits,
           resource_class,reservation_key,max_spend_usd,interrupt,reasoning_effort,security_mode,model_override
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          input.id,
          input.taskId,
          input.userId,
          JSON.stringify(input.promptCiphertext),
          input.modelId,
          input.privacyRoute,
          input.maxComputeCredits,
          input.resourceClass,
          input.reservationKey,
          input.maxSpendUsd ?? null,
          input.interrupt ?? false,
          input.reasoningEffort ?? optionalText(row.reasoning_effort) ?? 'auto',
          input.securityMode ?? null,
          input.modelOverride ?? false
        ]
      );
      await tx.query(
        `INSERT INTO usage_entries(
           id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
           idempotency_key
         ) SELECT $1,$2,workspace_id,id,'task_compute',$3,$4,'credits',$4,'reserved',$5
           FROM tasks WHERE id=$6
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          input.userId,
          input.resourceClass,
          input.maxComputeCredits,
          input.reservationKey,
          input.taskId
        ]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'queued_message','Follow-up queued',$3::jsonb
         FROM task_events WHERE task_id=$2`,
        [
          input.queuedEventId ?? randomUUID(),
          input.taskId,
          JSON.stringify(input.queuedEventCiphertext)
        ]
      );
      const answered = input.questionId && input.questionId === row.pending_question_id;
      if (answered)
        await tx.query('UPDATE tasks SET pending_question_id=NULL,updated_at=NOW() WHERE id=$1', [
          input.taskId
        ]);
      return mapTask({
        ...row,
        ...(answered ? { pending_question_id: null } : {}),
        queued_message_count: Number(row.queued_message_count ?? 0) + 1
      });
    });
    if (queued) this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    return queued;
  }

  async getNextQueuedTaskMessage(
    taskId: string,
    options: { interruptOnly?: boolean } = {}
  ): Promise<TaskMessageQueueRecord | null> {
    const result = await this.database.query(
      `SELECT q.*,
         CASE WHEN q.approval_id IS NULL THEN q.model_id ELSE t.model_id END AS model_id,
         CASE WHEN q.approval_id IS NULL THEN q.privacy_route ELSE t.privacy_route END AS privacy_route,
         CASE WHEN q.approval_id IS NULL THEN q.reasoning_effort ELSE t.reasoning_effort END AS reasoning_effort
       FROM task_message_queue q JOIN tasks t ON t.id=q.task_id
       WHERE q.task_id=$1 AND q.status='queued' AND ($2::boolean = FALSE OR q.interrupt = TRUE)
       ORDER BY (q.approval_id IS NOT NULL) DESC,q.created_at,q.id LIMIT 1`,
      [taskId, options.interruptOnly === true]
    );
    return result.rows[0] ? mapTaskMessage(result.rows[0]) : null;
  }

  /**
   * Puts a task back in the queue because a turn died with the owner's message still waiting.
   *
   * The message they sent is nearly always a correction, and a correction is the most likely thing
   * in the conversation to get past whatever just failed - so the turn that could not deliver it is
   * not the end of it. The saved trajectory is untouched, so the retry resumes from where the turn
   * stopped rather than starting the work again, and the loop takes the message at its first step
   * boundary the way it would have done if nothing had gone wrong.
   *
   * `attempt` is deliberately left standing, which is the whole of the bound. Every other door back
   * into the queue clears it, because on the far side of each of them something went right - a turn
   * finished, or the owner wrote again. Nothing went right here, so the count carries: this can
   * happen at most until the ceiling, each retry sits behind everything else in the queue, and then
   * the task stops being leasable by anything. There is no second limit to keep in step.
   *
   * Refuses on every other reading of the row, and the refusals are the point:
   *
   * - a status the queue no longer owns. Cancelled above all - the owner said stop, and a message
   *   they sent before they said it must never be the thing that starts the conversation again.
   *   Cancelling already marks the queue rows too, so this is the second of two locks on that door.
   * - a lease belonging to somebody else, meaning this worker is no longer the one running the
   *   task and has no business writing its status.
   * - nothing actually queued, so a plain failure stays a plain failure.
   * - the attempt ceiling, which is the caller's cue to tell the owner their message is not coming.
   */
  async requeueTaskForQueuedMessage(input: { id: string; workerId: string }): Promise<{
    attempt: number;
    queuedMessageCount: number;
  } | null> {
    const requeued = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT attempt FROM tasks
         WHERE id=$1 AND status IN ${COMMITTED_TASK_STATUSES}
           AND (lease_owner IS NULL OR lease_owner=$2)
         FOR UPDATE`,
        [input.id, input.workerId]
      );
      const attempt = Number(locked.rows[0]?.attempt);
      if (!locked.rows[0] || attempt >= TASK_MAX_ATTEMPTS) return null;
      const waiting = await tx.query(
        `SELECT COUNT(*) AS count FROM task_message_queue
         WHERE task_id=$1 AND status='queued'`,
        [input.id]
      );
      const queuedMessageCount = Number(waiting.rows[0]?.count ?? 0);
      if (queuedMessageCount === 0) return null;
      const updated = await tx.query(
        `UPDATE tasks SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
           completed_at=NULL,updated_at=NOW()
         WHERE id=$1`,
        [input.id]
      );
      if (updated.rowCount !== 1) return null;
      return { attempt, queuedMessageCount };
    });
    // News for the queue in both directions at once: the workspace this task was holding is free,
    // and the task itself is leasable again the instant a worker looks.
    if (requeued) this.#signal(TASK_QUEUE_CHANNEL, input.id);
    return requeued;
  }

  /**
   * Takes the owner's words out of a queue that will never be read again, and hands them back.
   *
   * Only for a conversation that has actually stopped for good. Until this existed the rows simply
   * stayed 'queued' on a dead task, which is what put a pill reading "1 queued" in the header of a
   * conversation whose message could never run - the interface asserting something the machine had
   * no reason to believe. The count the header reads is a count of 'queued' rows, so moving them is
   * what makes it true again.
   *
   * The rows are returned rather than merely marked, because the caller is the only party that can
   * open them: the message is encrypted under the workspace key, and what the owner is owed is not
   * a number going down but their own sentence, said back to them, with the reason it did not land.
   *
   * Their reservations go back at the same time. A message that will never run must not go on
   * holding a slice of the owner's daily ceiling against work nothing is going to do.
   */
  async strandQueuedTaskMessages(taskId: string): Promise<TaskMessageQueueRecord[]> {
    return this.database.transaction(async (tx) => {
      const stopped = await tx.query(
        `SELECT id FROM tasks WHERE id=$1 AND status IN ('failed','cancelled') FOR UPDATE`,
        [taskId]
      );
      if (!stopped.rows[0]) return [];
      const stranded = await tx.query(
        `UPDATE task_message_queue SET status='undelivered'
         WHERE task_id=$1 AND status='queued'
           AND EXISTS (
             SELECT 1 FROM tasks t WHERE t.id=$1 AND t.status IN ('failed','cancelled')
           )
         RETURNING *`,
        [taskId]
      );
      if (stranded.rowCount)
        await tx.query(
          `UPDATE usage_entries SET state='released'
           WHERE state='reserved' AND kind='task_compute' AND idempotency_key = ANY($1::text[])`,
          [stranded.rows.map((row) => String(row.reservation_key))]
        );
      await releasePromotedMessageReservations(tx, taskId);
      return stranded.rows.map(mapTaskMessage);
    });
  }

  /**
   * Takes a queued message into the turn that is already running, rather than handing it the next
   * one. The row is marked promoted, the credit ceiling is raised by what the message reserved -
   * without that the loop trips its own budget on the very next iteration - and a `user_message`
   * event is written so the transcript and the timeline show the correction where it landed.
   *
   * Deliberately not a variant of `promoteQueuedTaskMessage`: that one ends a turn and releases the
   * lease so the worker can pick the task up fresh. This one keeps both, because keeping the turn
   * is the entire point - everything the agent has already done stays in the window.
   */
  async consumeQueuedTaskMessageInTurn(input: {
    taskId: string;
    messageId: string;
    workerId: string;
    additionalComputeCredits: number;
    additionalSpendUsd?: number | null;
    userMessageCiphertext: EncryptedEnvelope;
    /** Required for a denial: consuming its queue row and saving its words are one commit. */
    agentStateCiphertext?: EncryptedEnvelope;
    actualComputeCredits?: number;
  }): Promise<boolean> {
    const consumed = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id,status,lease_expires_at > NOW() AS lease_live FROM tasks
         WHERE id=$1 AND lease_owner=$2 FOR UPDATE`,
        [input.taskId, input.workerId]
      );
      if (!locked.rows[0]) return false;
      const queued = await tx.query(
        `SELECT id,reasoning_effort,security_mode,approval_id,model_override FROM task_message_queue
         WHERE id=$1 AND task_id=$2 AND status='queued' FOR UPDATE`,
        [input.messageId, input.taskId]
      );
      if (!queued.rows[0]) return false;
      const denial = Boolean(queued.rows[0].approval_id);
      if (
        !['planning', 'running'].includes(String(locked.rows[0].status)) ||
        locked.rows[0].lease_live !== true
      )
        return false;
      if (denial && input.agentStateCiphertext?.aad !== `task-state:${input.taskId}`)
        throw new GardenError(
          'approval_correction_checkpoint',
          'A denial correction requires its sealed continuation'
        );
      await tx.query(
        `UPDATE task_message_queue SET status='promoted',promoted_at=NOW() WHERE id=$1`,
        [input.messageId]
      );
      await tx.query(
        `UPDATE tasks SET
           max_compute_credits=max_compute_credits+$3,
           model_override=model_override OR (NOT $6 AND $10),
           reasoning_effort=CASE WHEN $6 THEN reasoning_effort ELSE $5 END,
           security_mode=CASE WHEN $6 THEN security_mode ELSE COALESCE($9,security_mode) END,
           agent_state_ciphertext=COALESCE($7::jsonb,agent_state_ciphertext),
           actual_compute_credits=CASE WHEN $8::double precision IS NULL THEN actual_compute_credits
             WHEN has_coding_family THEN GREATEST(actual_compute_credits,$8) ELSE $8 END,
           max_spend_usd=CASE WHEN $4::double precision IS NULL THEN max_spend_usd ELSE
             COALESCE(max_spend_usd, (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=tasks.id AND u.state='settled')) + $4::double precision END,
           updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2`,
        [
          input.taskId,
          input.workerId,
          denial ? 0 : input.additionalComputeCredits,
          denial ? null : (input.additionalSpendUsd ?? null),
          queued.rows[0].reasoning_effort ?? 'auto',
          denial,
          input.agentStateCiphertext ? JSON.stringify(input.agentStateCiphertext) : null,
          input.actualComputeCredits ?? null,
          queued.rows[0].security_mode ?? null,
          queued.rows[0].model_override ?? false
        ]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'user_message','User message',$3::jsonb
         FROM task_events WHERE task_id=$2`,
        [randomUUID(), input.taskId, JSON.stringify(input.userMessageCiphertext)]
      );
      return true;
    });
    if (consumed) this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    return consumed;
  }

  async promoteQueuedTaskMessage(input: {
    taskId: string;
    messageId: string;
    workerId: string;
    modelId: string;
    privacyRoute: string;
    additionalComputeCredits: number;
    additionalSpendUsd?: number | null;
    agentStateCiphertext: EncryptedEnvelope;
    userMessageCiphertext: EncryptedEnvelope;
    statusEventCiphertext: EncryptedEnvelope;
  }): Promise<TaskRecord | null> {
    const promoted = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id,status,lease_expires_at > NOW() AS lease_live FROM tasks
         WHERE id=$1 AND lease_owner=$2 FOR UPDATE`,
        [input.taskId, input.workerId]
      );
      if (!locked.rows[0]) return null;
      const queued = await tx.query(
        `SELECT id,reasoning_effort,security_mode,approval_id,model_override FROM task_message_queue
         WHERE id=$1 AND task_id=$2 AND status='queued' FOR UPDATE`,
        [input.messageId, input.taskId]
      );
      if (!queued.rows[0]) return null;
      const denial = Boolean(queued.rows[0].approval_id);
      if (
        denial &&
        (!['planning', 'running'].includes(String(locked.rows[0].status)) ||
          locked.rows[0].lease_live !== true)
      )
        return null;
      // The next message still owns its reservation; only the finished turn's messages release.
      await releasePromotedMessageReservations(tx, input.taskId);
      await tx.query(
        `UPDATE task_message_queue SET status='promoted',promoted_at=NOW() WHERE id=$1`,
        [input.messageId]
      );
      const updated = await tx.query(
        `UPDATE tasks SET
           status='queued',pending_question_id=NULL,model_override=model_override OR (NOT $9 AND ($11 OR model_id<>$3)),model_id=CASE WHEN $9 THEN model_id ELSE $3 END,
           privacy_route=CASE WHEN $9 THEN privacy_route ELSE $4 END,
           reasoning_effort=CASE WHEN $9 THEN reasoning_effort ELSE $8 END,
           security_mode=CASE WHEN $9 THEN security_mode ELSE COALESCE($10,security_mode) END,
           max_compute_credits=max_compute_credits+$5,
           max_spend_usd=CASE WHEN $7::double precision IS NULL THEN max_spend_usd ELSE
             COALESCE(max_spend_usd, (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=tasks.id AND u.state='settled')) + $7::double precision END,
           agent_state_ciphertext=$6::jsonb,lease_owner=NULL,lease_expires_at=NULL,
           -- Back in the queue, so the attempt count starts again: the turn before this one
           -- finished, which is the evidence TASK_MAX_ATTEMPTS is asking for.
           attempt=0,
           completed_at=NULL,updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2
         RETURNING *`,
        [
          input.taskId,
          input.workerId,
          input.modelId,
          input.privacyRoute,
          denial ? 0 : input.additionalComputeCredits,
          JSON.stringify(input.agentStateCiphertext),
          denial ? null : (input.additionalSpendUsd ?? null),
          queued.rows[0].reasoning_effort ?? 'auto',
          denial,
          queued.rows[0].security_mode ?? null,
          queued.rows[0].model_override ?? false
        ]
      );
      if (!updated.rows[0]) throw new Error('queued_message_promotion_conflict');
      const existingEvents = await tx.query(
        'SELECT COALESCE(MAX(sequence),0) AS sequence FROM task_events WHERE task_id=$1',
        [input.taskId]
      );
      const sequence = Number(existingEvents.rows[0]?.sequence ?? 0);
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         VALUES ($1,$2,$3,'status','Queued follow-up started',$4::jsonb),
                ($5,$2,$6,'user_message','User message',$7::jsonb)`,
        [
          randomUUID(),
          input.taskId,
          sequence + 1,
          JSON.stringify(input.statusEventCiphertext),
          randomUUID(),
          sequence + 2,
          JSON.stringify(input.userMessageCiphertext)
        ]
      );
      const remaining = await tx.query(
        `SELECT COUNT(*) AS count FROM task_message_queue
         WHERE task_id=$1 AND status='queued'`,
        [input.taskId]
      );
      return mapTask({
        ...updated.rows[0],
        queued_message_count: Number(remaining.rows[0]?.count ?? 0)
      });
    });
    if (promoted) {
      // Both halves of this write are news for the queue: the turn that was holding the workspace
      // has ended, and the follow-up it was holding it against is now itself queued behind nothing.
      this.#signal(TASK_QUEUE_CHANNEL, input.taskId);
      this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    }
    return promoted;
  }

  async completeTaskIfNoQueued(input: {
    id: string;
    workerId: string;
    actualComputeCredits: number;
    agentStateCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    const completed = await this.database.transaction(async (tx) => {
      // The row is held for the rest of this transaction from here, so what its lease says now is
      // what the update below is about to clear.
      const locked = await tx.query(
        `SELECT lease_expires_at > NOW() AS was_held FROM tasks
         WHERE id=$1 AND lease_owner=$2 FOR UPDATE`,
        [input.id, input.workerId]
      );
      if (!locked.rows[0]) return null;
      const queued = await tx.query(
        `SELECT id FROM task_message_queue
         WHERE task_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1`,
        [input.id]
      );
      if (queued.rows[0]) return null;
      const result = await tx.query(
        `UPDATE tasks SET status='completed',actual_compute_credits=CASE WHEN has_coding_family THEN GREATEST(actual_compute_credits,$3) ELSE $3 END,
           agent_state_ciphertext=$4::jsonb,lease_owner=NULL,lease_expires_at=NULL,
           completed_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2`,
        [
          input.id,
          input.workerId,
          input.actualComputeCredits,
          JSON.stringify(input.agentStateCiphertext)
        ]
      );
      if (result.rowCount !== 1) return null;
      await releasePromotedMessageReservations(tx, input.id);
      return { wasHeld: locked.rows[0].was_held === true };
    });
    if (completed?.wasHeld) this.#signalWorkspaceRelease(input.id);
    return completed !== null;
  }

  /**
   * Every conversation in one workspace, archived ones included. Search, export and the "is
   * anything still running here" check all need the whole set, so this one is deliberately not
   * paged: truncating it would quietly narrow a search rather than slow it down.
   */
  async listTasks(userId: string, workspaceId: string): Promise<TaskRecord[]> {
    const result = await this.database.query(
      `SELECT t.*,${TASK_LIVE_COUNTS}
       FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
       WHERE t.workspace_id=$2 AND w.user_id=$1
       ORDER BY t.created_at DESC`,
      [userId, workspaceId]
    );
    return result.rows.map(mapTask);
  }

  /** Owned execution roots and task lineage, including branches. */
  async projectExecutionMembers(
    userId: string,
    scopeId: string,
    kind: 'task' | 'project' = 'task'
  ): Promise<Array<{ taskId: string; workspaceId: string }>> {
    const result = await this.database.query(
      `WITH selected AS (
      SELECT p.id FROM projects p WHERE p.user_id=$1 AND
      (($3='project' AND p.id=$2) OR ($3='task' AND p.id=(SELECT project_id FROM tasks WHERE id=$2 AND user_id=$1)))
    ) SELECT t.id,t.workspace_id FROM tasks t JOIN selected s ON s.id=t.project_id
      JOIN workspaces w ON w.id=t.workspace_id AND w.user_id=t.user_id WHERE t.user_id=$1
      UNION SELECT r.origin_task_id AS id,r.workspace_id FROM project_workspaces r JOIN selected s ON s.id=r.project_id
      JOIN workspaces w ON w.id=r.workspace_id AND w.user_id=r.user_id WHERE r.user_id=$1`,
      [userId, scopeId, kind]
    );
    return result.rows.map((row) => ({
      taskId: String(row.id),
      workspaceId: String(row.workspace_id)
    }));
  }

  /**
   * Whether this computer still has a conversation in any of these states.
   *
   * The question behind every refusal to put a workspace's files back while the agent is still
   * working, and it was answered by reading the workspace's whole conversation list - every row
   * carrying the two correlated subqueries that count its live messages and its spend - and testing
   * the statuses in JavaScript. One row proves it, and the search stops at the first one found.
   *
   * The owner is checked on the workspace, exactly as `listTasks` checks it, so this stays an
   * answer to the same question and not to a slightly different one.
   */
  async workspaceHasTasksInStatus(
    userId: string,
    workspaceId: string,
    statuses: readonly string[]
  ): Promise<boolean> {
    // Nothing to look for is not a reason to go looking, and `= ANY('{}')` is a table scan that
    // can only ever answer no.
    if (!statuses.length) return false;
    const result = await this.database.query(
      `SELECT 1 FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
       WHERE t.workspace_id=$2 AND w.user_id=$1 AND t.status = ANY($3::text[])
       LIMIT 1`,
      [userId, workspaceId, [...statuses]]
    );
    return result.rows.length > 0;
  }

  /**
   * One page of the sidebar.
   *
   * Ordered by last activity rather than by creation, because a conversation the owner returned to
   * this morning belongs at the top however old it is; pinned conversations sit above all of it.
   * The row comparison is exactly the ORDER BY read backwards, which is what makes the cursor a
   * position in this list rather than a count of rows already seen.
   *
   * No schedule may take more than `SCHEDULE_RUNS_PER_PAGE` of it. A conversation the owner started
   * is one they went looking for; a run is one the box made on its own, and a schedule makes them
   * faster than a person can. Left uncapped, the list the owner uses to find their own work fills
   * with work they are not doing, and the only thing that ever falls off the end of it is theirs.
   *
   * The ceiling is a fact about each row - is this among the newest few runs of its schedule - and
   * not about the page, which is what keeps it compatible with the cursor: a position still means
   * the same thing on the next page, and no run is shown twice or skipped by paging past it.
   *
   * Runs beyond it stay reachable rather than hidden: `scheduleId` asks for one schedule and lifts
   * the ceiling for it, so the whole run history of a watcher is the same paged list, read from a
   * different door.
   */
  async listTaskPage(
    userId: string,
    options: {
      workspaceId?: string;
      limit?: number;
      cursor?: string | null;
      include?: TaskListFilter;
      /** One schedule's runs, all of them. The sidebar's ceiling on runs does not apply. */
      scheduleId?: string;
    } = {}
  ): Promise<TaskPage> {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 200), MAX_TASK_PAGE));
    const position = options.cursor ? decodeTaskCursor(options.cursor) : null;
    const include = options.include ?? 'active';
    const scheduleId = options.scheduleId ?? null;
    const result = await this.database.query(
      // The ordering key is selected as the database's own text as well as being ordered on, so the
      // cursor for the last row of this page is the exact value the next page compares against.
      //
      // Each schedule is answered once, before any row of the page is looked at. Asking each row
      // where its schedule's boundary falls gives the same answer, and asked that way it was asked
      // once per conversation on the box: a year of one fifteen-minute watcher is thirty-five
      // thousand runs, so opening the app spent a third of a second re-deriving one timestamp
      // thirty-five thousand times. A schedule has one boundary and one total however many times it
      // has fired, and both are read here from the index the runs are already stored in.
      `WITH schedule_runs AS MATERIALIZED (
         -- A run the owner pinned is theirs now rather than the schedule's, which is why it is
         -- neither counted nor allowed to set the boundary; the client leaves pinned runs out of
         -- the fold for the same reason.
         SELECT r.schedule_id, COUNT(*)::int AS runs
         FROM tasks r
         WHERE r.user_id=$1 AND r.schedule_id IS NOT NULL AND NOT r.pinned
           AND ($3::text = 'all'
                OR ($3::text = 'active' AND r.archived_at IS NULL)
                OR ($3::text = 'archived' AND r.archived_at IS NOT NULL))
         GROUP BY r.schedule_id
       ),
       schedule_ceiling AS MATERIALIZED (
         -- Where the newest few runs of each schedule stop. Null for a schedule that has not fired
         -- that many times yet, which is what admits every run it has.
         --
         -- It ranks over exactly the rows this page is drawn from, which it has to: ranked over all
         -- of them, five runs the owner had archived or pinned would set the boundary and then not
         -- be on the page to occupy it, and a schedule whose newest five had been filed away
         -- vanished from the list entirely while the count beside it still said three hundred.
         SELECT s.schedule_id, s.runs, oldest.created_at AS oldest_shown
         FROM schedule_runs s
         LEFT JOIN LATERAL (
           SELECT r.created_at FROM tasks r
           WHERE r.schedule_id = s.schedule_id AND NOT r.pinned
             AND ($3::text = 'all'
                  OR ($3::text = 'active' AND r.archived_at IS NULL)
                  OR ($3::text = 'archived' AND r.archived_at IS NOT NULL))
           ORDER BY r.created_at DESC
           OFFSET COALESCE($9::int, 1) - 1 LIMIT 1
         ) oldest ON TRUE
       ), task_page AS MATERIALIZED (
       SELECT t.*,
         GREATEST(t.updated_at, t.created_at)::text AS activity_at,
         c.runs AS schedule_run_count,${TASK_LIVE_COUNTS}
       FROM tasks t
       LEFT JOIN schedule_ceiling c ON c.schedule_id = t.schedule_id
       -- Asked of the conversation and not of the workspace it sits in, which is what makes
       -- tasks_activity_idx usable: the index leads on tasks.user_id, and binding the owner on the
       -- joined workspaces row left that leading column free, so page one could only be answered
       -- by reading and sorting every conversation the owner has ever had. The migration that
       -- added the index said the first page never sorts the whole table; it always did. The CTE
       -- above has always asked it this way, and tasks.user_id is NOT NULL.
       WHERE t.user_id=$1 AND t.parent_mission_id IS NULL
         AND ($2::uuid IS NULL OR t.workspace_id=$2)
         AND ($3::text = 'all'
              OR ($3::text = 'active' AND t.archived_at IS NULL)
              OR ($3::text = 'archived' AND t.archived_at IS NOT NULL))
         AND ($8::uuid IS NULL OR t.schedule_id=$8)
         -- The ceiling, asked of the row rather than of the page: is this run one of the newest few
         -- its schedule has made.
         AND ($9::int IS NULL OR t.schedule_id IS NULL OR t.pinned
              OR c.oldest_shown IS NULL OR t.created_at >= c.oldest_shown)
         AND ($4::boolean IS NULL OR
              (t.pinned, GREATEST(t.updated_at, t.created_at), t.id)
                < ($4::boolean, $5::timestamptz, $6::uuid))
       ORDER BY t.pinned DESC, GREATEST(t.updated_at, t.created_at) DESC, t.id DESC
       LIMIT $7
       ), delivery AS (${taskDeliveryCountsSql('SELECT id FROM task_page', '$10')})
       SELECT task_page.*,
         CASE WHEN delivery.task_id IS NULL THEN NULL WHEN delivery.failed>0 THEN 'incomplete'
           WHEN delivery.pending>0 THEN 'pending' ELSE 'ready' END AS delivery_status,
         COALESCE(delivery.pending,0)::int AS pending_delivery_count
       FROM task_page LEFT JOIN delivery ON delivery.task_id=task_page.id
       ORDER BY task_page.pinned DESC,GREATEST(task_page.updated_at,task_page.created_at) DESC,task_page.id DESC`,
      [
        userId,
        options.workspaceId ?? null,
        include,
        position?.pinned ?? null,
        position?.activityAt ?? null,
        position?.id ?? null,
        limit + 1,
        scheduleId,
        // Asking for one schedule is asking for its runs, so the thing that keeps runs out of the
        // owner's list is exactly what that caller wants lifted.
        scheduleId ? null : SCHEDULE_RUNS_PER_PAGE,
        [...PENDING_MEDIA_DELIVERY]
      ]
    );
    // One row past the page is what proves there is more without a second count query.
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = rows.at(-1);
    // Only the schedules the page is actually carrying, because that is what the client can fold
    // and the count exists to make that fold honest. It travels on the rows rather than in a query
    // of its own, so a schedule is counted in the same pass that decides which of its runs fit.
    const scheduleRunCounts: Record<string, number> = {};
    for (const row of rows) {
      const schedule = optionalText(row.schedule_id);
      if (schedule !== null && row.schedule_run_count !== null)
        scheduleRunCounts[schedule] = Number(row.schedule_run_count);
    }
    return {
      tasks: rows.map(mapTask),
      hasMore,
      nextCursor: hasMore && last ? encodeTaskCursor(last) : null,
      scheduleRunCounts
    };
  }

  /**
   * Pins a conversation above the recency buckets, files it away, or both.
   *
   * Neither touches `updated_at`: filing a conversation is not activity in it, and moving it to
   * the top of the list as a side effect of archiving it would be the opposite of what was asked.
   */
  async updateTaskFiling(
    userId: string,
    id: string,
    input: { pinned?: boolean; archived?: boolean }
  ): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `UPDATE tasks t SET
         pinned = COALESCE($3::boolean, pinned),
         archived_at = CASE
           WHEN $4::boolean IS NULL THEN archived_at
           WHEN $4::boolean THEN COALESCE(archived_at, NOW())
           ELSE NULL END
       FROM workspaces w
       WHERE t.id=$1 AND w.id=t.workspace_id AND w.user_id=$2
       RETURNING t.*,${TASK_LIVE_COUNTS}`,
      [id, userId, input.pinned ?? null, input.archived ?? null]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async getTask(userId: string, id: string): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `SELECT t.*,${TASK_LIVE_COUNTS}
       FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
       WHERE t.id=$1 AND w.user_id=$2`,
      [id, userId]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  /**
   * Renames a conversation. The title is encrypted like every other task field, so the caller
   * supplies the envelope rather than plaintext - and the search vector for the same reason, since
   * this layer cannot read either one.
   *
   * The name becomes the owner's, which is what stops the titler from ever touching it again.
   */
  async renameTask(
    userId: string,
    id: string,
    titleCiphertext: EncryptedEnvelope,
    nameIndex: ConversationNameIndex
  ): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `UPDATE tasks t SET title=$3::jsonb, title_source='owner', updated_at=NOW(),
         name_tsv = ${taskNameTsv(4, 5, 6)}
       FROM workspaces w
       WHERE t.id=$1 AND w.id=t.workspace_id AND w.user_id=$2
       RETURNING t.*,${TASK_LIVE_COUNTS}`,
      [id, userId, JSON.stringify(titleCiphertext), ...taskNameTokens(nameIndex)]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  /**
   * Conversations still wearing the first words of their prompt as a name, whose first exchange is
   * complete enough to be read. Ordered oldest first so a backlog left by a restart is worked
   * through in the order the owner created it.
   */
  async listTasksNeedingTitle(limit = 5, afterId?: string): Promise<TaskRecord[]> {
    const result = await this.database.query(
      `SELECT t.*, 0 AS queued_message_count
       FROM tasks t
       WHERE t.title_source='prompt'
         AND ($2::uuid IS NULL
           OR NOT EXISTS (SELECT 1 FROM tasks cursor WHERE cursor.id=$2)
           OR (t.created_at,t.id) > (SELECT cursor.created_at,cursor.id FROM tasks cursor WHERE cursor.id=$2))
         AND EXISTS (
           SELECT 1 FROM task_events e
           WHERE e.task_id=t.id AND e.kind='assistant_message')
       ORDER BY t.created_at, t.id
       LIMIT $1`,
      [Math.max(1, Math.min(Math.trunc(limit), 50)), afterId ?? null]
    );
    return result.rows.map(mapTask);
  }

  /**
   * Writes a title the box worked out for itself.
   *
   * Conditional on the placeholder still being in place: an owner who renamed the conversation
   * while the model was thinking keeps their name, and the answer that arrives late is dropped
   * rather than allowed to overwrite it. `updated_at` is left alone so naming a conversation does
   * not reorder the sidebar.
   */
  async setGeneratedTaskTitle(
    id: string,
    titleCiphertext: EncryptedEnvelope,
    nameIndex: ConversationNameIndex
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks SET title=$2::jsonb, title_source='generated',
         name_tsv = ${taskNameTsv(3, 4, 5)}
       WHERE id=$1 AND title_source='prompt'`,
      [id, JSON.stringify(titleCiphertext), ...taskNameTokens(nameIndex)]
    );
    return result.rowCount === 1;
  }

  /**
   * Deletes a conversation and everything hanging off it. Child forks are detached rather than
   * deleted, so removing an experiment never silently takes the branches taken from it.
   */
  async deleteTask(userId: string, id: string): Promise<boolean> {
    const deleted = await this.database.transaction(async (tx) => {
      const owned = await tx.query(
        `SELECT t.lease_expires_at > NOW() AS was_held FROM tasks t
         JOIN workspaces w ON w.id=t.workspace_id
         WHERE t.id=$1 AND w.user_id=$2 FOR UPDATE OF t`,
        [id, userId]
      );
      if (!owned.rows[0]) return null;
      await tx.query('UPDATE tasks SET parent_task_id=NULL WHERE parent_task_id=$1', [id]);
      await tx.query('DELETE FROM task_events WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM task_message_queue WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM task_plans WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM approvals WHERE task_id=$1', [id]);
      // A share is a frozen copy of this conversation, and a copy must not outlive what it copied.
      // The foreign key cascades too; this is the invariant stated where the rest of them are.
      await tx.query('DELETE FROM task_shares WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM tasks WHERE id=$1', [id]);
      return { wasHeld: owned.rows[0].was_held === true };
    });
    if (!deleted) return false;
    // Deleting the conversation a worker is inside is still a release: the row that was excluding
    // everything else in that workspace is simply gone rather than parked.
    if (deleted.wasHeld) this.#signalWorkspaceRelease(id);
    return true;
  }

  async createTaskPlan(input: {
    taskId: string;
    expectedVersion: number;
    parentVersion?: number;
    branchName: string;
    stepsCiphertext: EncryptedEnvelope;
    createdBy: TaskPlanRecord['createdBy'];
  }): Promise<TaskPlanRecord> {
    return this.database.transaction(async (tx) => {
      const task = await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [input.taskId]);
      if (!task.rows[0]) throw new Error('task_not_found');
      const latest = await tx.query(
        'SELECT COALESCE(MAX(version),0) AS version FROM task_plans WHERE task_id=$1',
        [input.taskId]
      );
      const currentVersion = Number(latest.rows[0]?.version ?? 0);
      if (currentVersion !== input.expectedVersion) throw new Error('plan_version_conflict');
      const parentVersion = input.parentVersion ?? (currentVersion || null);
      if (parentVersion !== null) {
        const parent = await tx.query('SELECT 1 FROM task_plans WHERE task_id=$1 AND version=$2', [
          input.taskId,
          parentVersion
        ]);
        if (!parent.rows[0]) throw new Error('plan_parent_not_found');
      }
      const result = await tx.query(
        `INSERT INTO task_plans(
          id,task_id,version,parent_version,branch_name,steps_ciphertext,created_by
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
        [
          randomUUID(),
          input.taskId,
          currentVersion + 1,
          parentVersion,
          'encrypted',
          JSON.stringify(input.stepsCiphertext),
          input.createdBy
        ]
      );
      return mapTaskPlan(result.rows[0]!);
    });
  }

  async getLatestTaskPlan(taskId: string): Promise<TaskPlanRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM task_plans WHERE task_id=$1 ORDER BY version DESC LIMIT 1',
      [taskId]
    );
    return result.rows[0] ? mapTaskPlan(result.rows[0]) : null;
  }

  async listTaskPlans(taskId: string): Promise<TaskPlanRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM task_plans WHERE task_id=$1 ORDER BY version DESC LIMIT 100',
      [taskId]
    );
    return result.rows.map(mapTaskPlan);
  }

  /**
   * Conversations whose name or opening request carries the request's words.
   *
   * The work here is set by what was asked for and by nothing else. The GIN index answers which
   * conversations match, the ordering happens in the database over the keyed tokens, and only the
   * page that is going to be shown comes back to be decrypted - so a box with fifty thousand
   * conversations pays what a box with fifty pays, and a conversation renamed years ago is as
   * reachable as one renamed this morning.
   *
   * The order is what the conversation is called first and when it was last touched second: the
   * one named exactly what was asked for, then the one whose name says part of it, then the one
   * whose name begins with the word still being typed, then the one that only opened by asking
   * about it.
   */
  async searchTaskNames(
    userId: string,
    input: {
      lexemes: readonly string[];
      /** From `conversationNamePrefixTokens`: the word the owner had not finished typing. */
      prefixes?: readonly string[];
      workspaceId?: string | null;
      limit?: number;
    }
  ): Promise<TaskNameHit[]> {
    const lexemes = [...new Set(input.lexemes.filter(isMemoryToken))];
    if (lexemes.length === 0) return [];
    const prefixes = [...new Set((input.prefixes ?? []).filter(isMemoryToken))];
    const result = await this.database.query(
      prefixes.length > 0 ? TASK_NAME_SEARCH_SQL.prefixed : TASK_NAME_SEARCH_SQL.plain,
      [
        userId,
        lexemes,
        input.workspaceId ?? null,
        Math.max(1, Math.min(Math.trunc(input.limit ?? 20), MAX_TASK_PAGE)),
        ...(prefixes.length > 0 ? [prefixes] : [])
      ]
    );
    return result.rows.map((row) => {
      const title = encryptedText(row.title);
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        titleCiphertext: title.ciphertext,
        legacyTitle: title.legacy,
        promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext),
        updatedAt: iso(row.updated_at),
        wholeName: Boolean(row.whole_name),
        inName: Boolean(row.in_name),
        namePrefix: Boolean(row.name_prefix)
      };
    });
  }

  /**
   * Moves a single run's own money ceiling up, and only up.
   *
   * This exists because the ceiling that stops a run is not always an account one: a task carrying
   * its own `max_spend_usd` is stopped by that, and the caps route cannot move it - it only knows
   * about the daily, monthly and default-task limits. Without this the card that offers to lift a
   * ceiling could lift two of the three, and the third sent the owner nowhere.
   *
   * `GREATEST` rather than an assignment, for the same reason the follow-up path anchors to what
   * has already been spent: this is reached from a control whose whole purpose is to let stopped
   * work continue, and a value that arrived smaller than the current ceiling - a stale card, a
   * double submit, a retry against a limit somebody already raised - must not quietly tighten the
   * run instead. Lowering a ceiling is a different intention and has its own route.
   */
  async raiseTaskSpendCeiling(userId: string, id: string, maxSpendUsd: number): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks t SET max_spend_usd = GREATEST(COALESCE(t.max_spend_usd, 0), $3::double precision),
         updated_at = NOW()
       WHERE t.id = $1 AND EXISTS (
         SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id AND w.user_id = $2
       ) RETURNING t.id`,
      [id, userId, maxSpendUsd]
    );
    return result.rows.length > 0;
  }

  /**
   * Re-queues a task on a different model after the one it was on stopped answering.
   *
   * One statement, because the three facts have to move together: the new route, the state that
   * knows which providers have already walled, and the credits spent getting here. Split across
   * calls, a crash between them leaves a task pointed at a new model with a state that has never
   * heard of it, and the next turn re-routes again on the next wall from a list that lost an entry.
   *
   * Guarded on the lease, like every other write this worker makes about a task it is holding: a
   * task another worker has taken is not this one's to move, and the `RETURNING` says which
   * happened so the caller can fall back to parking rather than assume it worked.
   */
  async rerouteTaskModel(input: {
    id: string;
    workerId: string;
    modelId: string;
    actualComputeCredits: number;
    agentStateCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks SET status='queued', model_id=$3, actual_compute_credits=$4,
         agent_state_ciphertext=$5::jsonb, lease_owner=NULL, lease_expires_at=NULL,
         attempt=0, completed_at=NULL, updated_at=NOW()
       WHERE id=$1 AND (lease_owner=$2 OR lease_owner IS NULL)
       RETURNING id`,
      [
        input.id,
        input.workerId,
        input.modelId,
        input.actualComputeCredits,
        JSON.stringify(input.agentStateCiphertext)
      ]
    );
    if (result.rows.length === 0) return false;
    this.#signal(TASK_QUEUE_CHANNEL, input.id);
    return true;
  }

  async setTaskStatusForUser(userId: string, id: string, status: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks SET status = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW(),
       -- Resuming answers the spend pause, so the task stops being one the owner has not heard about.
       spend_paused_at = CASE WHEN $3 = 'queued' THEN NULL ELSE tasks.spend_paused_at END,
       -- And resuming is a new start, so it does not inherit the count of leases that died before
       -- the owner intervened. Only the 'queued' branch: a task parked in any other status has not
       -- re-entered the queue, and the scheduled-run recovery sweep in the API reads a zero here
       -- as a run that was never dispatched at all.
       attempt = CASE WHEN $3 = 'queued' THEN 0 ELSE tasks.attempt END,
       completed_at = CASE WHEN $3 IN ('completed','failed','cancelled') THEN NOW() ELSE tasks.completed_at END
       ${HELD_LEASE_JOIN}
       WHERE tasks.id=held.held_id AND ($3<>'queued' OR tasks.parent_mission_id IS NULL OR EXISTS(
         SELECT 1 FROM coding_missions m JOIN tasks p ON p.id=m.parent_task_id
         WHERE m.child_task_id=tasks.id AND m.phase='active' AND NOT m.runner_sealed AND p.status NOT IN ('failed','cancelled')
       )) AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=tasks.workspace_id AND w.user_id=$2
       )
       RETURNING held.held_until > NOW() AS was_held`,
      [id, userId, status]
    );
    const row = result.rows[0];
    if (!row) return false;
    // Queued is an arrival and is announced as one; anything else the owner sets from the screen -
    // pausing a turn that is running, stopping it - is only ever a release.
    if (status === 'queued') this.#signal(TASK_QUEUE_CHANNEL, id);
    else if (row.was_held === true) this.#signalWorkspaceRelease(id);
    return true;
  }

  /** Recovery may resume only the exact resource wait it inspected. */
  async resumeTaskFromResourceWait(input: {
    userId: string;
    taskId: string;
    expectedUpdatedAt: string;
    expectedStateCiphertext: EncryptedEnvelope | null;
    eventSummary: string;
    eventCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    const resumed = await this.database.transaction(async (tx) => {
      const held = await tx.query(
        `SELECT t.id FROM tasks t
         WHERE t.id=$1 AND t.user_id=$2 AND t.status='awaiting_resource'
           AND t.lease_owner IS NULL AND t.lease_expires_at IS NULL AND t.attempt>0
           AND t.updated_at=$3::timestamptz
           AND t.agent_state_ciphertext IS NOT DISTINCT FROM $4::jsonb
           AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=t.workspace_id AND w.user_id=$2)
           AND NOT EXISTS (SELECT 1 FROM coding_families f
             WHERE f.parent_task_id=t.id AND f.wait_requested=TRUE)
           AND (t.parent_mission_id IS NULL OR EXISTS (
             SELECT 1 FROM coding_missions m JOIN tasks p ON p.id=m.parent_task_id
             WHERE m.child_task_id=t.id AND m.phase='active' AND NOT m.runner_sealed
               AND p.status NOT IN ('failed','cancelled')
           ))
         FOR UPDATE OF t`,
        [
          input.taskId,
          input.userId,
          input.expectedUpdatedAt,
          input.expectedStateCiphertext ? JSON.stringify(input.expectedStateCiphertext) : null
        ]
      );
      if (!held.rows.length) return false;
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'status',$3,$4::jsonb
         FROM task_events WHERE task_id=$2`,
        [randomUUID(), input.taskId, input.eventSummary, JSON.stringify(input.eventCiphertext)]
      );
      await tx.query(
        `UPDATE tasks SET status='queued',attempt=0,spend_paused_at=NULL,
           lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW() WHERE id=$1`,
        [input.taskId]
      );
      return true;
    });
    if (resumed) {
      this.#signal(TASK_EVENT_CHANNEL, input.taskId);
      this.#signal(TASK_QUEUE_CHANNEL, input.taskId);
    }
    return resumed;
  }

  async cancelTaskAndReleaseReservations(userId: string, id: string): Promise<boolean> {
    const cancelled = await this.database.transaction(async (tx) => {
      const changed = await tx.query(
        `UPDATE tasks SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,
           completed_at=NOW(),updated_at=NOW()
         ${HELD_LEASE_JOIN}
         WHERE tasks.id=held.held_id AND tasks.status NOT IN ('completed','failed','cancelled')
           AND EXISTS (
             SELECT 1 FROM workspaces w
             WHERE w.id=tasks.workspace_id AND w.user_id=$2
           )
         RETURNING held.held_until > NOW() AS was_held`,
        [id, userId]
      );
      if (changed.rowCount !== 1) return null;
      await tx.query(
        `UPDATE task_message_queue SET status='cancelled'
         WHERE task_id=$1 AND status='queued'`,
        [id]
      );
      await tx.query(
        `UPDATE approvals SET status='denied',resolved_at=NOW()
         WHERE task_id=$1 AND status='pending'`,
        [id]
      );
      await tx.query(
        `UPDATE usage_entries SET state='released'
         WHERE task_id=$1 AND state='reserved' AND kind='task_compute'`,
        [id]
      );
      const children = await tx.query(
        `UPDATE tasks child SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,completed_at=NOW(),updated_at=NOW()
        WHERE child.parent_task_id=$1 AND child.parent_mission_id IS NOT NULL AND child.status NOT IN ('completed','failed','cancelled') RETURNING child.id`,
        [id]
      );
      const childIds = children.rows.map((row) => String(row.id));
      await tx.query(
        `UPDATE coding_missions SET phase='cancelled',generation=generation+1,updated_at=NOW()
        WHERE parent_task_id=$1 AND phase NOT IN ('integrated','integrating','cancelled')`,
        [id]
      );
      await tx.query(
        `UPDATE coding_missions SET phase='cancelled',generation=generation+1,updated_at=NOW()
        WHERE child_task_id=$1 AND phase NOT IN ('integrated','integrating','cancelled')`,
        [id]
      );
      if (childIds.length) {
        await tx.query(
          "UPDATE approvals SET status='denied',resolved_at=NOW() WHERE task_id=ANY($1::uuid[]) AND status='pending'",
          [childIds]
        );
        await tx.query(
          "UPDATE task_message_queue SET status='cancelled' WHERE task_id=ANY($1::uuid[]) AND status='queued'",
          [childIds]
        );
        await tx.query(
          "UPDATE usage_entries SET state='released' WHERE task_id=ANY($1::uuid[]) AND kind='task_compute' AND state='reserved'",
          [childIds]
        );
      }
      return { wasHeld: changed.rows[0]?.was_held === true };
    });
    if (!cancelled) return false;
    // Stopping a turn is the fastest a workspace ever comes free, and the owner is by definition
    // watching: they pressed the button.
    if (cancelled.wasHeld) this.#signalWorkspaceRelease(id);
    return true;
  }

  async updateTaskSecurityMode(
    userId: string,
    id: string,
    securityMode: TaskRecord['securityMode']
  ): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `UPDATE tasks t SET security_mode=$3,updated_at=NOW()
       WHERE t.id=$1 AND t.user_id=$2 RETURNING t.*,${TASK_LIVE_COUNTS}`,
      [id, userId, securityMode]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  /**
   * Hands out one task, and never a second one for a workspace another worker is already inside.
   *
   * A workspace is one filesystem, one browser with one active page, one desktop. Two agents in
   * there at once do not fail, they interfere: one runs a build while the other rewrites the file
   * being built, and a navigation from one moves the page the other is reading. The owner sees
   * damaged work with nothing to attribute it to. So the second conversation waits its turn rather
   * than running beside the first - the concurrency the worker is configured for still applies, it
   * just spreads across workspaces instead of stacking up inside one.
   *
   * The hold is written on the workspace row, not inferred from the tasks in it. That is what makes
   * this decidable in one statement: the fact being read and the row being locked are the same row,
   * so a poll whose snapshot predates a competitor's commit does not get to act on it - PostgreSQL
   * re-checks the predicate against the version the competitor left, and the loser matches nothing
   * and leases nothing. Asking the tasks table instead only ever narrowed that window, because the
   * lock that made the second poll wait was released at exactly the moment its snapshot went stale.
   *
   * Held, not parked or dead: the hold carries the same deadline as the task lease written beside
   * it, so a worker that died lets go of the workspace at the same instant its own task becomes
   * leasable again and nothing can be wedged by a process that is gone. Every other way out of a
   * turn hands the workspace back sooner, and none of them has to remember to: the release is
   * welded to the lease in the schema. A task never excludes itself, so a retry of the one that
   * died is still the next thing to run.
   *
   * A task that is passed over is left exactly as it was. It is filtered out of the candidates
   * rather than leased and rejected, so waiting for the workspace costs it no attempt and the queue
   * cannot spend a conversation's whole allowance on it before its turn ever comes.
   *
   * `SKIP LOCKED` means the choice waits on nothing, so it can neither block nor take part in a
   * deadlock - and the hold is written to the row this same statement has already locked, so that
   * write cannot wait either. If the hold cannot be recorded, nothing is leased: a worker sent away
   * empty-handed polls again in a second, and there is no version of this worth being wrong about.
   */
  async leaseNextTask(workerId: string, leaseSeconds = 60): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `WITH candidate AS (
         SELECT t.id, t.workspace_id FROM tasks t
         JOIN workspaces w ON w.id = t.workspace_id
         WHERE t.status IN ${COMMITTED_TASK_STATUSES}
           AND w.status<>'deleting'
           AND NOT EXISTS (SELECT 1 FROM project_executions p WHERE p.task_id=t.id AND p.status IN ('preparing','failed'))
           AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
           AND t.attempt < $3
           AND ${WORKSPACE_IS_FREE_FOR('t.id')}
         -- Attempt first, then age. A task that has already died once is behind everything that
         -- has not, so a turn that kills its worker can no longer starve the message the owner
         -- sent while it was crashing; it drops a place each time and stops being handed out at
         -- all once it is at the ceiling. The tie-break on age is the original queue order.
         ORDER BY t.attempt, t.created_at, t.id
         FOR UPDATE OF t, w SKIP LOCKED
         LIMIT 1
       ), hold AS (
         UPDATE workspaces w SET
           lease_task_id = candidate.id,
           lease_expires_at = NOW() + ($2 * INTERVAL '1 second')
         FROM candidate
         WHERE w.id = candidate.workspace_id AND ${WORKSPACE_IS_FREE_FOR('candidate.id')}
         RETURNING candidate.id AS task_id
       )
       UPDATE tasks SET
         lease_owner = $1,
         lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
         status = CASE WHEN status = 'queued' THEN 'planning' ELSE status END,
         attempt = attempt + 1,
         updated_at = NOW()
       WHERE id = (SELECT task_id FROM hold)
       RETURNING *`,
      [workerId, leaseSeconds, TASK_MAX_ATTEMPTS]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  /**
   * Closes out the tasks the lease will no longer hand to anyone, and gives back the credits they
   * were holding.
   *
   * Without this the ceiling would trade a crash loop for a silence: the task simply stops being
   * leased, keeps a live-looking status and its reservation, and the owner is left watching a
   * conversation that is neither running nor finished. The expired-lease condition is what makes it
   * safe to run while workers are working - a task a worker still holds is renewing its lease, so
   * only one nobody is holding can be reached from here.
   *
   * Exactly once by construction: the same statement that selects the rows moves them out of the
   * statuses it selects on, so a second sweep, or a second API process, matches nothing.
   *
   * The one release path that deliberately does not wake the queue, for the same reason it is safe
   * to run beside working workers: it can only reach a task whose lease has already run out, and a
   * lease that has run out was excluding nothing. Whatever was waiting behind these tasks became
   * leasable when the lease expired, not now, and the poll interval has always been the floor for
   * that. Waking here would be announcing a release that happened minutes ago.
   */
  async failTasksAtAttemptLimit(limit = 20): Promise<
    Array<{
      id: string;
      userId: string;
      workspaceId: string;
      attempt: number;
      /** Messages the owner sent that this sweep has just established will never be started. */
      undeliveredMessages: number;
    }>
  > {
    return this.database.transaction(async (tx) => {
      const failed = await tx.query(
        `UPDATE tasks SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
           completed_at=NOW(),updated_at=NOW()
         WHERE id IN (
           SELECT id FROM tasks
           WHERE status IN ('queued','planning','running')
             AND attempt >= $1
             AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
           ORDER BY updated_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, user_id, workspace_id, attempt`,
        [TASK_MAX_ATTEMPTS, limit]
      );
      const undelivered = new Map<string, number>();
      for (const row of failed.rows) {
        await tx.query(
          `UPDATE usage_entries SET state='released' WHERE task_id=$1 AND state='reserved' AND kind='task_compute'`,
          [String(row.id)]
        );
        // The worker that was carrying these tasks died without writing a word, so nothing else has
        // moved the messages queued behind them. Left alone they would sit at 'queued' for ever on
        // a task the queue has just stopped handing out, which is the header pill telling the owner
        // a correction is on its way to a conversation that has stopped for good.
        const stranded = await tx.query(
          `UPDATE task_message_queue SET status='undelivered'
           WHERE task_id=$1 AND status='queued'`,
          [String(row.id)]
        );
        undelivered.set(String(row.id), stranded.rowCount ?? 0);
      }
      return failed.rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        workspaceId: String(row.workspace_id),
        attempt: Number(row.attempt),
        undeliveredMessages: undelivered.get(String(row.id)) ?? 0
      }));
    });
  }

  /**
   * Whether the owner has stopped this task, and whose it is to run - the two facts a step already
   * in flight needs in order to decide whether to keep going.
   *
   * Narrow on purpose. `getTask` selects the whole row, and the whole row includes the encrypted
   * trajectory, which on a long turn is the largest thing in this database; a fifteen-minute model
   * request polled every three seconds would read it three hundred times to look at two columns.
   */
  async taskClaim(id: string): Promise<{ status: string; leaseOwner: string | null } | null> {
    const result = await this.database.query(
      'SELECT status, lease_owner FROM tasks WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const leaseOwner: unknown = row.lease_owner;
    return {
      status: String(row.status),
      leaseOwner: typeof leaseOwner === 'string' ? leaseOwner : null
    };
  }

  /**
   * The worker saying it is still there, which it does on every step and throughout any wait long
   * enough to outlive a lease.
   *
   * It renews the workspace with the task, and it has to: the hold is a deadline like the lease is,
   * and the lease is the only reason that deadline is safe to trust. Renewing one without the other
   * would mean every turn that lasts longer than a lease quietly stopped excluding anything, and
   * those are the only turns during which the owner has time to ask a second question.
   *
   * Both rows get the identical timestamp - the one the task was just given, read back rather than
   * computed twice - so a worker that dies a second later lets go of both at the same instant, and
   * nothing has to exist to sweep up after it.
   *
   * The hold is taken back rather than merely extended, under the same predicate the lease uses, so
   * a workspace that somehow came free under a running turn is quietly reclaimed by it. A live hold
   * belonging to somebody else is the one thing that stops this, which is the whole rule.
   *
   * `tasks` then `workspaces`, the order every statement here that can wait takes them in.
   */
  async renewTaskLease(taskId: string, workerId: string, leaseSeconds = 60): Promise<boolean> {
    const result = await this.database.query(
      `WITH renewed AS (
         UPDATE tasks SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second')
         WHERE id = $1 AND lease_owner = $2
         RETURNING id, workspace_id, lease_expires_at
       ), hold AS (
         UPDATE workspaces w SET
           lease_task_id = renewed.id,
           lease_expires_at = renewed.lease_expires_at
         FROM renewed
         WHERE w.id = renewed.workspace_id AND ${WORKSPACE_IS_FREE_FOR('renewed.id')}
         RETURNING w.id
       )
       SELECT id FROM renewed`,
      [taskId, workerId, leaseSeconds]
    );
    return result.rows.length === 1;
  }

  async yieldTaskLease(input: {
    taskId: string;
    workerId: string;
    agentStateCiphertext: EncryptedEnvelope;
    actualComputeCredits: number;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
         attempt=0,updated_at=NOW(),agent_state_ciphertext=$3::jsonb,
         actual_compute_credits=GREATEST(actual_compute_credits,$4)
       WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_expires_at>NOW()
       RETURNING id`,
      [
        input.taskId,
        input.workerId,
        JSON.stringify(input.agentStateCiphertext),
        input.actualComputeCredits
      ]
    );
    if (!result.rows.length) return false;
    this.#signalWorkspaceRelease(input.taskId);
    this.#taskSignals.signal(TASK_QUEUE_CHANNEL, input.taskId);
    return true;
  }

  async updateTask(input: {
    id: string;
    workerId?: string;
    status: string;
    agentStateCiphertext?: EncryptedEnvelope | null;
    actualComputeCredits?: number;
    /**
     * Let go of the workspace on this write. Only meaningful for a status that could keep it:
     * anything the queue will not lease releases it whether this is set or not.
     */
    clearLease?: boolean;
    /**
     * When the box stopped this task at a spending ceiling, or null to clear it. Undefined leaves
     * it alone. This is the only thing that distinguishes a spend pause from a Pause the owner
     * asked for, and it is what decides whether their phone hears about it.
     */
    spendPausedAt?: Date | null;
  }): Promise<void> {
    const params: unknown[] = [
      input.id,
      input.status,
      input.agentStateCiphertext ? JSON.stringify(input.agentStateCiphertext) : null,
      input.actualComputeCredits ?? null,
      input.clearLease ?? false,
      input.workerId ?? null,
      input.spendPausedAt === undefined ? null : input.spendPausedAt,
      input.spendPausedAt !== undefined
    ];
    // A parked or finished task holding a live lease is the one shape the one-writer rule cannot
    // survive: the queue will never hand that task to a worker again, and its lease goes on
    // excluding everything else in the workspace until it times out. It used to be eight callers
    // each remembering to say so. Now the status decides - only a status the queue would lease can
    // keep a lease - and `clearLease` ($5) is left to the callers that let go while staying
    // leasable.
    const letGo = `($5 OR $2 NOT IN ${COMMITTED_TASK_STATUSES})`;
    const result = await this.database.query(
      `UPDATE tasks SET
         status = $2,
         agent_state_ciphertext = COALESCE($3::jsonb, tasks.agent_state_ciphertext),
         actual_compute_credits = CASE WHEN tasks.has_coding_family THEN GREATEST(COALESCE($4::double precision,0),tasks.actual_compute_credits) ELSE COALESCE($4::double precision, tasks.actual_compute_credits) END,
         lease_owner = CASE WHEN ${letGo} THEN NULL ELSE tasks.lease_owner END,
         lease_expires_at = CASE WHEN ${letGo} THEN NULL ELSE tasks.lease_expires_at END,
         spend_paused_at = CASE WHEN $8 THEN $7::timestamptz ELSE tasks.spend_paused_at END,
         completed_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN NOW() ELSE tasks.completed_at END,
         updated_at = NOW()
       ${HELD_LEASE_JOIN}
       WHERE tasks.id = held.held_id AND ($6::text IS NULL OR tasks.lease_owner = $6)
       RETURNING held.held_until > NOW() AND tasks.lease_expires_at IS NULL AS released`,
      params
    );
    // The end of a turn is the ordinary way a workspace comes free, and it is the one the owner is
    // most often watching: they have just read the last line of one answer and the next question is
    // already queued behind it. Read off the row rather than off the flag, so a caller that let go
    // without meaning to still wakes whoever was waiting on it.
    if (result.rows[0]?.released === true) this.#signalWorkspaceRelease(input.id);
  }

  /** Publish a question and its resumable state together, guarded by the active lease. */
  async saveTaskQuestion(input: {
    taskId: string;
    workerId: string;
    agentStateCiphertext: EncryptedEnvelope;
    actualComputeCredits: number;
    park: boolean;
    event?: { id: string; payloadCiphertext: EncryptedEnvelope };
  }): Promise<boolean> {
    const saved = await this.database.transaction(async (tx) => {
      const held = await tx.query(
        `SELECT id FROM tasks WHERE id=$1 AND lease_owner=$2
           AND lease_expires_at>NOW() AND status IN ('running','planning') FOR UPDATE`,
        [input.taskId, input.workerId]
      );
      if (!held.rows.length) return null;
      const updated = await tx.query(
        `UPDATE tasks SET agent_state_ciphertext=$2::jsonb,pending_question_id=COALESCE($5::uuid,pending_question_id),
           actual_compute_credits=GREATEST(actual_compute_credits,$3),updated_at=NOW(),
           status=CASE WHEN NOT $4 THEN status
             WHEN EXISTS (SELECT 1 FROM task_message_queue q WHERE q.task_id=tasks.id
               AND q.status='queued' AND q.interrupt) THEN 'queued' ELSE 'awaiting_user' END,
           lease_owner=CASE WHEN $4 THEN NULL ELSE lease_owner END,
           lease_expires_at=CASE WHEN $4 THEN NULL ELSE lease_expires_at END
         WHERE id=$1 RETURNING status`,
        [
          input.taskId,
          JSON.stringify(input.agentStateCiphertext),
          input.actualComputeCredits,
          input.park,
          input.event?.id ?? null
        ]
      );
      if (input.event)
        await tx.query(
          `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
           SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'question_asked','Encrypted question asked event',$3::jsonb
           FROM task_events WHERE task_id=$2`,
          [input.event.id, input.taskId, JSON.stringify(input.event.payloadCiphertext)]
        );
      return String(updated.rows[0]!.status);
    });
    if (!saved) return false;
    this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    if (input.park) this.#signalWorkspaceRelease(input.taskId);
    if (saved === 'queued') this.#signal(TASK_QUEUE_CHANNEL, input.taskId);
    return true;
  }

  /**
   * Writes one event onto a conversation's timeline.
   *
   * `kind` is parsed rather than trusted: the enum is the surface the API serves and the client
   * branches on, and the callers that reach this method hold it as a plain string. A kind nobody
   * declared is a programming error, and it is worth far more as a failed write here than as a row
   * the read side has to either lie about or refuse a whole page over.
   */
  async appendTaskEvent(input: {
    id?: string;
    taskId: string;
    kind: string;
    summary: string;
    payloadCiphertext?: EncryptedEnvelope;
    /**
     * This event carries the whole of the same-kind run it closes, so those rows can go.
     *
     * The writer states it because the store cannot read it: the payload is encrypted here, so the
     * `replace` flag the client branches on is not visible in SQL. It exists for the streamed
     * thinking, where the row that consolidates the frames is the same kind as the frames it
     * supersedes - which the assistant_message rule below, a fixed pair of kinds, cannot express.
     */
    replacesEarlierFrames?: boolean;
  }): Promise<TaskEventRecord> {
    const kind = TaskEventKind.parse(input.kind);
    const result = await this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [input.taskId]);
      const inserted = await tx.query(
        `INSERT INTO task_events(id, task_id, sequence, kind, summary, payload_ciphertext)
         SELECT $1, $2, COALESCE(MAX(sequence), 0) + 1, $3, $4, $5::jsonb
         FROM task_events WHERE task_id = $2
         RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.taskId,
          kind,
          input.summary,
          input.payloadCiphertext ? JSON.stringify(input.payloadCiphertext) : null
        ]
      );
      // A reply is streamed a frame at a time, and the assistant_message that closes it carries the
      // final text - so the moment that message exists, every delta before it is a redundant slice
      // of it. Dropping them here rather than waiting for the retention sweep is what stops opening
      // a finished conversation from replaying every fragment it was ever assembled from; the live
      // stream has already delivered them to whoever was watching.
      if (kind === 'assistant_message')
        await tx.query(
          `DELETE FROM task_events
           WHERE task_id = $1 AND kind = 'assistant_delta' AND sequence < $2`,
          [input.taskId, Number(inserted.rows[0]!.sequence)]
        );
      // The same trade for a stream whose closing row is its own kind, which is the streamed
      // thinking: it has no assistant_message of its own, so nothing superseded its frames and they
      // were kept and decrypted forever. Only back to the last row of any other kind, though: the
      // step before this one closed with a row of this same kind too, and reaching past the tool
      // result or the answer that separates them would leave a thirty-step task holding nothing but
      // the thinking of its final step.
      if (input.replacesEarlierFrames)
        await tx.query(
          `DELETE FROM task_events
           WHERE task_id = $1 AND kind = $2 AND sequence < $3
             AND sequence > COALESCE(
               (SELECT MAX(sequence) FROM task_events
                WHERE task_id = $1 AND kind <> $2 AND sequence < $3), 0)`,
          [input.taskId, kind, Number(inserted.rows[0]!.sequence)]
        );
      return inserted;
    });
    // After the transaction, never inside it: a stream woken by an uncommitted insert would read
    // the table, find nothing, and go back to sleep having spent the wake-up.
    this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    // A settled answer is the first moment there is enough of a conversation to name it.
    if (kind === 'assistant_message') this.#signal(TASK_ANSWERED_CHANNEL, input.taskId);
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      sequence: Number(row.sequence),
      kind,
      summary: String(row.summary),
      payloadCiphertext: row.payload_ciphertext
        ? json<EncryptedEnvelope>(row.payload_ciphertext)
        : null,
      createdAt: iso(row.created_at)
    };
  }

  /** Named receipts keep presentation references task-scoped without loading the trajectory. */
  async listTaskEvidenceByIds(taskId: string, ids: readonly string[]): Promise<TaskEventRecord[]> {
    if (!ids.length) return [];
    if (ids.length > 64) throw new Error('Too many presentation evidence references');
    const result = await this.database.query(
      `SELECT * FROM task_events WHERE task_id=$1 AND id=ANY($2::uuid[]) AND kind IN ('tool_result','preview','artifact') AND octet_length(COALESCE(payload_ciphertext::text,'')) <= 262144 ORDER BY sequence`,
      [taskId, [...new Set(ids)]]
    );
    return result.rows.map(mapTaskEvent);
  }

  /**
   * Whole trajectory, oldest first. For export, search and branching, which need every row.
   *
   * There is deliberately no `LIMIT` here, and adding one is not the repair it looks like. Four
   * callers depend on getting all of it and would be wrong rather than slow if this truncated:
   * `/v1/privacy/export` would hand the owner a transcript that stops in the middle and says
   * nothing about it, and rewind-preview, branch and `createTaskTrajectory` all take the *last*
   * conversational event as the point to act on - so a page-sized read of a task whose newest rows
   * are a streamed turn's deltas would silently offer to rewind to some message from hours ago.
   *
   * The read that must be bounded is the timeline's, and it has its own door: `listTaskEventPage`
   * pages at `MAX_TASK_EVENT_PAGE` and hands back the cursor to continue from. The bound belongs at
   * the route that chooses between them, not here, because only the route knows which of the two
   * questions it is asking.
   */
  async listTaskEvents(
    taskId: string,
    after = 0,
    selection?: { kind: TaskEventRecord['kind']; limit: number }
  ): Promise<TaskEventRecord[]> {
    const result = await this.database.query(
      selection
        ? `SELECT * FROM (SELECT * FROM task_events WHERE task_id=$1 AND sequence>$2::bigint AND kind=$3 ORDER BY sequence DESC LIMIT $4) recent ORDER BY sequence ASC`
        : `SELECT * FROM task_events WHERE task_id = $1 AND sequence > $2::bigint ORDER BY sequence`,
      selection
        ? [taskId, after, selection.kind, Math.max(1, Math.min(1_000, Math.trunc(selection.limit)))]
        : [taskId, after]
    );
    return result.rows.map(mapTaskEvent);
  }

  /** A provider hold must remain discoverable after later output fills the timeline page. */
  async taskResourceFailure(taskId: string): Promise<TaskEventRecord | null> {
    const result = await this.database.query(
      `SELECT e.* FROM task_events e JOIN tasks t ON t.id=e.task_id
       WHERE e.task_id=$1 AND t.status='awaiting_resource' AND e.kind IN ('warning','error')
         AND NOT EXISTS (SELECT 1 FROM coding_families f
           WHERE f.parent_task_id=t.id AND f.wait_requested=TRUE)
       ORDER BY e.sequence DESC LIMIT 1`,
      [taskId]
    );
    return result.rows[0] ? mapTaskEvent(result.rows[0]) : null;
  }

  /**
   * Bounded window over one task's trajectory, for the timeline and its stream. `after` reads
   * forward from a cursor, which is what a live stream resumes with; `before` walks backwards
   * through older material a page at a time, which is how a reader reaches history that
   * `listRecentTaskEvents` deliberately did not send.
   *
   * Rows always come back oldest first whichever direction was asked for, so a caller can append
   * them to a cursor-ordered timeline without re-sorting.
   */
  async listTaskEventPage(
    taskId: string,
    options: { after?: number; before?: number; limit?: number } = {}
  ): Promise<TaskEventPage> {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 200), MAX_TASK_EVENT_PAGE));
    const forward = options.before === undefined;
    const result = await this.database.query(
      forward
        ? `SELECT * FROM task_events WHERE task_id = $1 AND sequence > $2::bigint
           ORDER BY sequence LIMIT $3`
        : `SELECT * FROM task_events WHERE task_id = $1 AND sequence < $2::bigint
           ORDER BY sequence DESC LIMIT $3`,
      [taskId, forward ? Math.max(0, Math.trunc(options.after ?? 0)) : options.before, limit + 1]
    );
    // One row past the page is what proves there is more without a second count query.
    const overflowed = result.rows.length > limit;
    const rows = overflowed ? result.rows.slice(0, limit) : result.rows;
    const events = (forward ? rows : [...rows].reverse()).map(mapTaskEvent);
    const oldest = events[0]?.sequence ?? null;
    const newest = events.at(-1)?.sequence ?? null;
    if (forward)
      return {
        events,
        hasMore: overflowed,
        oldestSequence: oldest,
        nextCursor: newest ?? Math.max(0, Math.trunc(options.after ?? 0))
      };
    return { events, hasMore: overflowed, oldestSequence: oldest, nextCursor: newest ?? 0 };
  }

  /**
   * The conversations holding at least one turn that opened inside a window, newest first.
   *
   * Which conversations the open-rate instrument should read, so that it does not read the rest.
   * Bounded at `MAX_TASKS_PER_TOOL_OPEN_READ` and one row past it, so the caller can say the window
   * was truncated instead of reporting a denominator that is quietly short.
   */
  async listTasksWithTurnsInWindow(
    userId: string,
    since: Date,
    until: Date,
    limit = MAX_TASKS_PER_TOOL_OPEN_READ
  ): Promise<{ tasks: TaskInWindow[]; hasMore: boolean }> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_TASKS_PER_TOOL_OPEN_READ));
    const result = await this.database.query(TASKS_WITH_TURNS_IN_WINDOW_SQL, [
      userId,
      since.toISOString(),
      until.toISOString(),
      bounded + 1
    ]);
    const overflowed = result.rows.length > bounded;
    return {
      tasks: (overflowed ? result.rows.slice(0, bounded) : result.rows).map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        createdAt: iso(row.created_at)
      })),
      hasMore: overflowed
    };
  }

  /**
   * One conversation's turn boundaries and dispatched tool calls, oldest first.
   *
   * The read behind the open-rate instrument (`GET /v1/usage/tool-opens`), and the reason it is a
   * statement of its own rather than a filter over `listTaskEventPage`: the aggregate needs every
   * `tool_started` row of a conversation and none of the `assistant_delta` frames that are most of
   * its rows and nearly all of its bytes. Walking the timeline and discarding would carry a whole
   * trajectory out of the database to read forty tool names.
   *
   * Paged for the same reason the export is: a `tool_started` payload carries the call's ARGUMENTS,
   * so one `file_write` row can be megabytes and a conversation's worth of them held at once is the
   * API's heap. Bounded by `MAX_TASK_EVENT_PAGE` rather than by a second number beside it, because
   * it is the same question that number already answers - how much of one conversation may be in
   * memory at a time.
   *
   * It does NOT bound how many conversations a caller walks. That bound belongs to the caller,
   * which is the only thing that knows how many it is about to open.
   */
  async listTurnToolStarts(
    taskId: string,
    options: { after?: number; limit?: number } = {}
  ): Promise<TurnToolStartPage> {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 200), MAX_TASK_EVENT_PAGE));
    const after = Math.max(0, Math.trunc(options.after ?? 0));
    // One row past the page proves there is more without a second count query, exactly as
    // `listTaskEventPage` does it.
    const result = await this.database.query(TURN_TOOL_STARTS_SQL, [taskId, after, limit + 1]);
    const overflowed = result.rows.length > limit;
    const rows: TurnToolStartRecord[] = (
      overflowed ? result.rows.slice(0, limit) : result.rows
    ).map((row) => ({
      id: String(row.id),
      sequence: Number(row.sequence),
      turn: Number(row.turn),
      kind: row.kind === 'user_message' ? 'user_message' : 'tool_started',
      payloadCiphertext: row.payload_ciphertext
        ? json<EncryptedEnvelope>(row.payload_ciphertext)
        : null,
      createdAt: iso(row.created_at)
    }));
    return { rows, hasMore: overflowed, nextCursor: rows.at(-1)?.sequence ?? after };
  }

  /**
   * The newest page plus whether anything precedes it: the shape an initial timeline load wants,
   * because it also yields the cursor the event stream should be opened at.
   */
  async listRecentTaskEvents(taskId: string, limit = 200): Promise<TaskEventPage> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_TASK_EVENT_PAGE));
    const result = await this.database.query<{ next: string | null }>(
      'SELECT MAX(sequence)::text AS next FROM task_events WHERE task_id = $1',
      [taskId]
    );
    const latest = Number(result.rows[0]?.next ?? 0);
    if (!latest) return { events: [], hasMore: false, oldestSequence: null, nextCursor: 0 };
    return this.listTaskEventPage(taskId, { before: latest + 1, limit: bounded });
  }
}
