import { randomUUID } from 'node:crypto';
import { GardenError } from '@garden/core';
import type { EncryptedEnvelope } from '@garden/core';
import { MAX_WORKSPACE_PREVIEWS, PREVIEW_IDLE_EXPIRY_DAYS } from '@garden/contracts';
import type { Database } from '../database.js';
import type {
  WorkspaceCheckpointRecord,
  WorkspaceMemoryRecord,
  WorkspacePreviewRecord,
  WorkspaceRecord,
  WorkspaceSkillRecord
} from '../types.js';
import {
  iso,
  json,
  mapWorkspace,
  mapWorkspaceCheckpoint,
  mapWorkspaceMemory,
  mapWorkspacePreview,
  mapWorkspaceSkill,
  optionalText
} from './rows.js';

/** Bound as a parameter and cast, so the window is one number in one place rather than SQL text. */
const PREVIEW_IDLE_INTERVAL = `${PREVIEW_IDLE_EXPIRY_DAYS} days`;

/**
 * A workspace and everything that hangs off one: the computer itself, its snapshots and
 * checkpoints, the notes and skills the agent keeps in it, the artifacts a turn produced, and the
 * previews that publish part of it to the network.
 *
 * They are one file because they are one lifetime. `deleteWorkspace` is a single statement only
 * because every table below cascades from `workspaces(id)`, and `deleteUser` sits here for the same
 * reason: the row it removes is the root of that cascade, so the account and the computers it owns
 * cannot be reasoned about apart.
 */
export class WorkspaceStore {
  constructor(private readonly database: Database) {}

  async createWorkspace(input: {
    id?: string;
    userId: string;
    name: string;
    storageLimitBytes: number;
    imageRevision: string;
    region: string;
    wrappedKey: string;
    keyProtection?: WorkspaceRecord['keyProtection'];
    securityMode?: WorkspaceRecord['securityMode'];
  }): Promise<WorkspaceRecord> {
    const id = input.id ?? randomUUID();
    // Both rows or neither. Every read path inner-joins workspace_keys, so a workspaces row whose
    // key never landed is invisible to the owner, to `deleteWorkspace` - which is only ever called
    // with an id the owner can see - and to the create route, which mints another one beside it.
    // With one workspace per box that is the product gone with no way back through any route, and
    // the way to get there is a connection dropping between two statements while the installer
    // restarts services back to back.
    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO workspaces(
          id, user_id, name, status, storage_limit_bytes, image_revision, region,
          security_mode
        ) VALUES ($1,$2,$3,'provisioning',$4,$5,$6,$7) RETURNING *`,
        [
          id,
          input.userId,
          input.name,
          input.storageLimitBytes,
          input.imageRevision,
          input.region,
          input.securityMode ?? 'balanced'
        ]
      );
      await tx.query(
        'INSERT INTO workspace_keys(workspace_id, wrapped_key, wrapping_mode) VALUES ($1, $2, $3)',
        [id, input.wrappedKey, input.keyProtection ?? 'hosted']
      );
      return { ...mapWorkspace(result.rows[0]!), wrappedKey: input.wrappedKey };
    });
  }

  async listWorkspaces(userId: string): Promise<WorkspaceRecord[]> {
    const result = await this.database.query(
      `SELECT w.*, k.wrapped_key, k.wrapping_mode, w.storage_bytes+COALESCE((SELECT SUM(child.storage_bytes) FROM workspaces child WHERE child.parent_workspace_id=w.id),0) AS storage_bytes FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id = w.id
       WHERE w.user_id = $1 AND w.internal_parent_task_id IS NULL AND w.parent_workspace_id IS NULL ORDER BY w.created_at DESC`,
      [userId]
    );
    return result.rows.map(mapWorkspace);
  }

  /** Owner-scoped metadata for response serialization, including hidden project execution roots. */
  async listWorkspaceMetadata(userId: string, ids?: string[]): Promise<WorkspaceRecord[]> {
    if (ids?.length === 0) return [];
    const result = await this.database.query(
      `SELECT w.*, k.wrapped_key, k.wrapping_mode FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id=w.id WHERE w.user_id=$1 AND ($2::uuid[] IS NULL OR w.id=ANY($2::uuid[]))`,
      [userId, ids ? [...new Set(ids)] : null]
    );
    return result.rows.map(mapWorkspace);
  }

  async getWorkspace(userId: string, id: string): Promise<WorkspaceRecord | null> {
    const result = await this.database.query(
      `SELECT w.*,k.wrapped_key,k.wrapping_mode, w.storage_bytes+COALESCE((SELECT SUM(child.storage_bytes) FROM workspaces child WHERE child.parent_workspace_id=w.id),0) AS storage_bytes FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id = w.id
       WHERE w.id=$1 AND w.user_id=$2`,
      [id, userId]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }

  async getWorkspaceById(id: string): Promise<WorkspaceRecord | null> {
    const result = await this.database.query(
      `SELECT w.*, k.wrapped_key, k.wrapping_mode, w.storage_bytes+COALESCE((SELECT SUM(child.storage_bytes) FROM workspaces child WHERE child.parent_workspace_id=w.id),0) AS storage_bytes FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id = w.id WHERE w.id = $1`,
      [id]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }

  /** Whether this workspace is the caller's at all. The only access question left on one box. */
  async workspaceBelongsToUser(userId: string, workspaceId: string): Promise<boolean> {
    const result = await this.database.query(
      'SELECT 1 FROM workspaces WHERE id=$1 AND user_id=$2',
      [workspaceId, userId]
    );
    return result.rows.length === 1;
  }

  async updateWorkspaceStatus(
    id: string,
    status: string,
    runnerRef?: string | null
  ): Promise<void> {
    await this.database.query(
      `UPDATE workspaces
       SET status = $2,
           runner_ref = COALESCE($3, runner_ref),
           compute_metered_at = CASE
             WHEN $2='running' AND status<>'running' THEN NOW()
             WHEN $2<>'running' THEN NULL
             ELSE compute_metered_at
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [id, status, runnerRef ?? null]
    );
  }

  async listRunningWorkspaces(): Promise<WorkspaceRecord[]> {
    const result = await this.database.query(
      `SELECT w.*,k.wrapped_key,k.wrapping_mode, w.storage_bytes+COALESCE((SELECT SUM(child.storage_bytes) FROM workspaces child WHERE child.parent_workspace_id=w.id),0) AS storage_bytes FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id=w.id
       WHERE w.status='running'
       ORDER BY w.compute_metered_at ASC NULLS FIRST, w.id LIMIT 500`
    );
    return result.rows.map(mapWorkspace);
  }

  async touchWorkspace(userId: string, id: string): Promise<void> {
    await this.database.query('UPDATE workspaces SET updated_at=NOW() WHERE id=$1 AND user_id=$2', [
      id,
      userId
    ]);
  }

  async setWorkspaceStorage(userId: string, id: string, storageBytes: number): Promise<void> {
    await this.database.query(
      'UPDATE workspaces SET storage_bytes=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2',
      [id, userId, storageBytes]
    );
  }

  async updateWorkspaceResources(
    userId: string,
    id: string,
    storageLimitBytes?: number
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE workspaces SET storage_limit_bytes=COALESCE($3,storage_limit_bytes),updated_at=NOW()
       WHERE id=$1 AND user_id=$2`,
      [id, userId, storageLimitBytes ?? null]
    );
    return result.rowCount === 1;
  }

  async deleteWorkspace(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM workspaces WHERE id=$1 AND user_id=$2', [
      id,
      userId
    ]);
    return result.rowCount === 1;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM users WHERE id=$1', [id]);
    return result.rowCount === 1;
  }

  async createWorkspaceSnapshot(input: {
    userId: string;
    workspaceId: string;
    name: string;
    sizeBytes: number;
  }): Promise<Record<string, unknown>> {
    const result = await this.database.query(
      `INSERT INTO workspace_snapshots(id,user_id,workspace_id,name,status,size_bytes)
       SELECT $1,$2,w.id,$4,'creating',$5 FROM workspaces w
       WHERE w.id=$3 AND w.user_id=$2
       RETURNING *`,
      [randomUUID(), input.userId, input.workspaceId, input.name, input.sizeBytes]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Workspace not found');
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      status: String(row.status),
      sizeBytes: Number(row.size_bytes),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async listWorkspaceSnapshots(
    userId: string,
    workspaceId: string
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT s.id,s.workspace_id,s.name,s.status,s.size_bytes,s.created_at,s.updated_at
       FROM workspace_snapshots s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.workspace_id IN (SELECT id FROM workspaces WHERE id=$2 OR id=(SELECT parent_workspace_id FROM workspaces WHERE id=$2 AND user_id=$1)) AND w.user_id=$1
       ORDER BY s.created_at DESC`,
      [userId, workspaceId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      status: String(row.status),
      sizeBytes: Number(row.size_bytes),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  async getWorkspaceSnapshot(
    userId: string,
    workspaceId: string,
    id: string
  ): Promise<Record<string, unknown> | null> {
    const result = await this.database.query(
      `SELECT s.id,s.workspace_id,s.name,s.status,s.size_bytes,s.created_at,s.updated_at
       FROM workspace_snapshots s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.id=$1 AND s.workspace_id=$3 AND w.user_id=$2`,
      [id, userId, workspaceId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          workspaceId: String(row.workspace_id),
          name: String(row.name),
          status: String(row.status),
          sizeBytes: Number(row.size_bytes),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        }
      : null;
  }

  async setWorkspaceSnapshotStatus(
    id: string,
    status: 'creating' | 'ready' | 'failed' | 'deleting'
  ): Promise<void> {
    await this.database.query(
      'UPDATE workspace_snapshots SET status=$2,updated_at=NOW() WHERE id=$1',
      [id, status]
    );
  }

  async completeWorkspaceSnapshot(id: string, sizeBytes: number): Promise<void> {
    await this.database.query(
      `UPDATE workspace_snapshots
       SET status='ready',size_bytes=$2,updated_at=NOW()
       WHERE id=$1`,
      [id, Math.max(0, Math.floor(sizeBytes))]
    );
  }

  async deleteWorkspaceSnapshot(userId: string, workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM workspace_snapshots WHERE id=$1 AND workspace_id=$3 AND EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id=workspace_snapshots.workspace_id AND w.user_id=$2
      )`,
      [id, userId, workspaceId]
    );
    return result.rowCount === 1;
  }

  /**
   * Records a turn checkpoint the runner has already taken.
   *
   * `event_sequence` is captured here rather than passed in, because the point of the column is to
   * anchor the checkpoint to the transcript as it stood at that instant, and the caller taking the
   * checkpoint is mid-turn and does not know that number.
   */
  async recordWorkspaceCheckpoint(input: {
    id: string;
    workspaceId: string;
    taskId: string | null;
    turn: number;
    mechanism: WorkspaceCheckpointRecord['mechanism'];
    fileCount: number | null;
    totalBytes: number | null;
    storedBytes: number;
    durationMs: number;
  }): Promise<WorkspaceCheckpointRecord> {
    const result = await this.database.query(
      // The owner is taken from the workspace rather than from the caller: the worker records a
      // fact about a machine, and every read below is what decides who may see it.
      `INSERT INTO workspace_checkpoints(
         id,user_id,workspace_id,task_id,turn,event_sequence,mechanism,
         file_count,total_bytes,stored_bytes,duration_ms)
       SELECT $1,w.user_id,w.id,$3,$4,
         -- The position this checkpoint's content belongs to, not the position it was written at.
         -- It holds the computer as it was before this turn changed anything, so it anchors to the
         -- message that started the turn. Recording where it happened to be taken - after that
         -- message and after the status lines - put it beyond the only anchor the client offers,
         -- and an owner asking to undo their own message was told there was nothing to undo. A run
         -- with no message of its own, which is what a schedule is, keeps the position it was
         -- taken at.
         COALESCE(
           (SELECT MAX(e.sequence) FROM task_events e
             WHERE e.task_id=$3 AND e.kind='user_message'),
           (SELECT MAX(e.sequence) FROM task_events e WHERE e.task_id=$3)),
         $5,$6,$7,$8,$9
       FROM workspaces w WHERE w.id=$2
       RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.taskId,
        Math.max(0, Math.floor(input.turn)),
        input.mechanism,
        input.fileCount === null ? null : Math.max(0, Math.floor(input.fileCount)),
        input.totalBytes === null ? null : Math.max(0, Math.floor(input.totalBytes)),
        Math.max(0, Math.floor(input.storedBytes)),
        Math.max(0, Math.floor(input.durationMs))
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Workspace not found');
    return mapWorkspaceCheckpoint(row);
  }

  async getWorkspaceCheckpoint(
    userId: string,
    id: string
  ): Promise<WorkspaceCheckpointRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM workspace_checkpoints WHERE id=$1 AND user_id=$2',
      [id, userId]
    );
    const row = result.rows[0];
    return row ? mapWorkspaceCheckpoint(row) : null;
  }

  /**
   * The checkpoint that holds the computer as it was at a point in the transcript.
   *
   * The newest one at or before that event, because a checkpoint is taken in front of the work a
   * turn is about to do: anything later already contains changes the owner is asking to undo. A
   * null answer is a real answer - the turn changed nothing, or its checkpoint has been pruned -
   * and the caller must say so rather than silently rewind somewhere else.
   *
   * `event_sequence` is the transcript position at the moment the checkpoint was taken, so two
   * checkpoints taken before the turn wrote anything carry the same number. The oldest of those is
   * the only one that is in front of all the work at that position, and it is chosen explicitly:
   * without the tiebreaker the database was free to hand back either, and restoring the wrong one
   * silently keeps changes the owner asked to undo.
   */
  async checkpointForTaskEvent(
    userId: string,
    taskId: string,
    eventId: string
  ): Promise<WorkspaceCheckpointRecord | null> {
    const result = await this.database.query(
      `SELECT c.* FROM workspace_checkpoints c
       WHERE c.task_id=$2 AND c.user_id=$1 AND c.event_sequence IS NOT NULL
         AND c.event_sequence <= COALESCE(
           (SELECT e.sequence FROM task_events e WHERE e.id=$3 AND e.task_id=$2), -1)
       ORDER BY c.event_sequence DESC, c.taken_seq ASC LIMIT 1`,
      [userId, taskId, eventId]
    );
    const row = result.rows[0];
    return row ? mapWorkspaceCheckpoint(row) : null;
  }

  /** Forgets checkpoints the runner has already pruned from disk. */
  async deleteWorkspaceCheckpoints(workspaceId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.database.query(
      'DELETE FROM workspace_checkpoints WHERE workspace_id=$1 AND id = ANY($2::uuid[])',
      [workspaceId, ids]
    );
    return result.rowCount ?? 0;
  }

  /**
   * Everything this workspace can see: its own rows, plus the owner tier, which belongs to the
   * person and is visible from every workspace they own.
   *
   * The authorisation moved from the workspace to the user, and it had to. The old statement
   * joined `workspaces w ON w.id=m.workspace_id` and read `w.user_id`, which cannot decide an
   * owner-tier row because that row has no workspace to join to. `m.user_id=$1` is the check
   * instead, and the workspace half is now a membership test rather than the whole authorisation:
   * the caller still has to name a workspace they own, so a request for a workspace that is not
   * theirs returns nothing rather than their own owner tier.
   *
   * Owner rows sort first. They are the standing facts every workspace shares; a reader running
   * out of budget should lose the project note before it loses the person.
   */
  async listWorkspaceMemories(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceMemoryRecord[]> {
    const result = await this.database.query(
      `SELECT m.* FROM workspace_memories m
       WHERE m.user_id=$1
         AND (
           m.key_scope='user'
           OR (m.workspace_id IN (SELECT id FROM workspaces WHERE id=$2 OR id=(SELECT parent_workspace_id FROM workspaces WHERE id=$2 AND user_id=$1)) AND EXISTS (
             SELECT 1 FROM workspaces w WHERE w.id=$2 AND w.user_id=$1
           ))
         )
       ORDER BY (m.key_scope='user') DESC,m.target,m.created_at,m.id`,
      [userId, workspaceId]
    );
    return result.rows.map(mapWorkspaceMemory);
  }

  /**
   * A note about this computer. It cannot write the owner tier, and the type is the first half of
   * why.
   *
   * `target` was `WorkspaceMemoryRecord['target']`, so the one production caller that reaches this
   * method from inside a running turn - `apps/worker/src/tools/knowledge.ts`, the `memory` tool -
   * could pass `'user'` and did. Narrowing it to `'workspace'` turns that into a compile error at
   * that call site rather than a rule written down somewhere the call site never reads. The
   * runtime throw below is the second half, because a JavaScript caller, a test double or a future
   * `as` cast can still get past the type, and this is the production call site the gate has to
   * hold at.
   *
   * @see createOwnerMemory for the other tier and for what it takes to enter it.
   */
  async createWorkspaceMemory(input: {
    userId: string;
    workspaceId: string;
    target: 'workspace';
    contentCiphertext: EncryptedEnvelope;
    validUntil?: string | null;
  }): Promise<WorkspaceMemoryRecord> {
    if ((input.target as string) !== 'workspace')
      throw new GardenError(
        'memory_scope_refused',
        'The owner tier is written by the owner in Settings, not through this path.'
      );
    const result = await this.database.query(
      `INSERT INTO workspace_memories(
        id,user_id,workspace_id,target,key_scope,content_ciphertext,valid_until
       ) VALUES ($1,$2,$3,'workspace','workspace',$4::jsonb,$5) RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.workspaceId,
        JSON.stringify(input.contentCiphertext),
        input.validUntil ?? null
      ]
    );
    return mapWorkspaceMemory(result.rows[0]!);
  }

  /**
   * A fact about the OWNER, which every workspace they own will read and which deleting a computer
   * does not remove.
   *
   * There is no `workspaceId` parameter and that is the gate, not an omission. A turn is the thing
   * that has read a web page, opened a repository, or been handed somebody else's CONTRIBUTING.md,
   * and a turn always knows which workspace it is in; a method that cannot be told a workspace
   * cannot be called usefully from inside one. The only caller is the API route behind an
   * authenticated owner session, where there is no task in the loop and nothing untrusted has been
   * read. That is strictly stronger than the workspace tier's gate, which downgrades an agent
   * write to an approval card and still writes it - a card is a decision the owner makes while the
   * injected text is still in front of them, and a wrong row here follows them into every project
   * they ever start.
   *
   * The row bound is enforced by the statement rather than by a count taken beforehand. A
   * `SELECT count(*)` followed by an `INSERT` is two statements with a gap in the middle, and the
   * bound on the one tier that outlives everything should not depend on nobody racing it. At the
   * bound the `WHERE` fails, `RETURNING` yields nothing, and the caller is refused - nothing is
   * evicted. Silently dropping the oldest fact the owner recorded about themselves to make room
   * for a newer one is the failure this tier cannot afford, because the owner would never see it
   * happen.
   */
  async createOwnerMemory(input: {
    userId: string;
    maxRows: number;
    contentCiphertext: EncryptedEnvelope;
    validUntil?: string | null;
  }): Promise<WorkspaceMemoryRecord | null> {
    const result = await this.database.query(
      `INSERT INTO workspace_memories(
        id,user_id,workspace_id,target,key_scope,content_ciphertext,valid_until
       )
       SELECT $1,$2,NULL,'user','user',$3::jsonb,$4
       WHERE (
         SELECT count(*) FROM workspace_memories WHERE user_id=$2 AND key_scope='user'
       ) < $5
       RETURNING *`,
      [
        randomUUID(),
        input.userId,
        JSON.stringify(input.contentCiphertext),
        input.validUntil ?? null,
        input.maxRows
      ]
    );
    return result.rows[0] ? mapWorkspaceMemory(result.rows[0]) : null;
  }

  /** How many rows the owner tier is holding, for a caller that has to report the bound. */
  async countOwnerMemories(userId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT count(*)::int AS n FROM workspace_memories WHERE user_id=$1 AND key_scope='user'`,
      [userId]
    );
    return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
  }

  /**
   * Rewrites one row, in either tier.
   *
   * `keyScope` is an argument rather than something this reads off the row, because the caller is
   * the only party that knows which key it just sealed under and a mismatch between the two is
   * unreadable ciphertext that nothing would notice until a later read. Passing it also makes the
   * one useful promotion possible: a `target:'user'` row written before migration 70 is still
   * sealed under a workspace key, and re-encrypting it under the owner key on an ordinary edit
   * moves it out of the workspace at the one moment the owner is present and looking at it.
   *
   * `workspace_id` is set from `keyScope` in the same statement, so the row can never be sealed
   * under one scope and filed under the other - the constraint added in migration 70 would reject
   * it if it tried.
   *
   * `maxRows` is here because promotion is the tier's SECOND entrance and it was unbounded. The
   * row bound was written into `createOwnerMemory`'s INSERT and nowhere else, and this statement
   * moves a row into the same tier without inserting anything: driven against a real migrated
   * database, forty legacy `target:'user'` rows promoted one at a time left the tier holding 56
   * rows against a bound of 16, after which every honest INSERT was refused for the rest of the
   * account's life. The clause fires only on a promotion - a row already at `key_scope='user'`,
   * and every write to the workspace tier, is untouched by it - and it is inside the statement for
   * the same reason the INSERT's is: a count taken beforehand and a write issued afterwards are
   * two statements with a gap in the middle.
   */
  async updateWorkspaceMemory(input: {
    id: string;
    userId: string;
    workspaceId: string;
    keyScope: WorkspaceMemoryRecord['keyScope'];
    maxOwnerRows: number;
    contentCiphertext: EncryptedEnvelope;
    validUntil?: string | null;
  }): Promise<WorkspaceMemoryRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_memories SET
         content_ciphertext=$5::jsonb,
         valid_until=$6,
         key_scope=$4,
         workspace_id=CASE WHEN $4='user' THEN NULL ELSE $3::uuid END,
         updated_at=NOW()
       WHERE id=$1 AND user_id=$2
         AND (key_scope='user' OR workspace_id=$3)
         AND ($4='workspace' OR target='user')
         AND (
           $4='workspace' OR key_scope='user' OR (
             SELECT count(*) FROM workspace_memories o
             WHERE o.user_id=$2 AND o.key_scope='user'
           ) < $7
         )
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.workspaceId,
        input.keyScope,
        JSON.stringify(input.contentCiphertext),
        input.validUntil ?? null,
        input.maxOwnerRows
      ]
    );
    return result.rows[0] ? mapWorkspaceMemory(result.rows[0]) : null;
  }

  /**
   * Removes one row from either tier.
   *
   * Authorised on `user_id`, so the owner tier is reachable from whichever workspace the owner
   * happens to have open. That is the half of "they can see the whole tier and delete any row"
   * that a workspace-scoped `DELETE` could not do: a row with no workspace id was not deletable
   * through this at all before, only through the cascade that took the whole computer with it.
   */
  async deleteWorkspaceMemory(userId: string, workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM workspace_memories
       WHERE id=$3 AND user_id=$1 AND (key_scope='user' OR workspace_id=$2)`,
      [userId, workspaceId, id]
    );
    return result.rowCount === 1;
  }

  async listWorkspaceSkills(userId: string, workspaceId: string): Promise<WorkspaceSkillRecord[]> {
    const result = await this.database.query(
      `SELECT s.* FROM workspace_skills s
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.workspace_id IN (SELECT id FROM workspaces WHERE id=$2 OR id=(SELECT parent_workspace_id FROM workspaces WHERE id=$2 AND user_id=$1)) AND w.user_id=$1
       ORDER BY s.updated_at DESC,s.id`,
      [userId, workspaceId]
    );
    return result.rows.map(mapWorkspaceSkill);
  }

  async getWorkspaceSkill(
    userId: string,
    workspaceId: string,
    id: string
  ): Promise<WorkspaceSkillRecord | null> {
    const result = await this.database.query(
      `SELECT s.* FROM workspace_skills s
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.id=$3 AND s.workspace_id IN (SELECT id FROM workspaces WHERE id=$2 OR id=(SELECT parent_workspace_id FROM workspaces WHERE id=$2 AND user_id=$1)) AND w.user_id=$1`,
      [userId, workspaceId, id]
    );
    return result.rows[0] ? mapWorkspaceSkill(result.rows[0]) : null;
  }

  async upsertWorkspaceSkill(input: {
    userId: string;
    workspaceId: string;
    nameHash: string;
    documentCiphertext: EncryptedEnvelope;
  }): Promise<WorkspaceSkillRecord> {
    const result = await this.database.query(
      `INSERT INTO workspace_skills(
        id,user_id,workspace_id,name_hash,document_ciphertext
       ) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(workspace_id,name_hash) DO UPDATE SET
         document_ciphertext=EXCLUDED.document_ciphertext,
         version=workspace_skills.version+1,
         enabled=TRUE,
         status='active',
         updated_at=NOW()
       RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.workspaceId,
        input.nameHash,
        JSON.stringify(input.documentCiphertext)
      ]
    );
    return mapWorkspaceSkill(result.rows[0]!);
  }

  async markWorkspaceSkillUsed(userId: string, workspaceId: string, id: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_skills SET
         use_count=use_count+1,last_used_at=NOW(),status='active',updated_at=NOW()
       WHERE id=$3 AND workspace_id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_skills.workspace_id AND w.user_id=$1
       )`,
      [userId, workspaceId, id]
    );
  }

  /**
   * Ages a workspace skill out of the index once its trigger has stopped coming up.
   *
   * The clock is `last_used_at` and nothing else. It used to be `COALESCE(last_used_at,updated_at)`
   * while the same statement wrote `updated_at`, so for a skill that had never been used the anchor
   * was the column the transition overwrote: on day 31 it went stale and reset its own clock, on
   * day 61 it went stale again, and it could never reach 'archived' - it simply blinked out of the
   * index and back every thirty days for the life of the workspace.
   *
   * A skill that has never been used is now left alone rather than given a different anchor. Every
   * workspace skill was shown to this owner in full and approved by them, and demoting one because
   * its occasion has not arisen yet is the wrong answer for a single-owner computer - they already
   * have pinning, enabling and deletion as direct controls. The guard also makes this statement a
   * true no-op in the steady state, so the per-turn call stops rewriting the whole table.
   */
  async curateWorkspaceSkills(workspaceId: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_skills SET
         status=CASE
           WHEN last_used_at < NOW()-INTERVAL '90 days' THEN 'archived'
           WHEN last_used_at < NOW()-INTERVAL '30 days' THEN 'stale'
           ELSE 'active'
         END,
         updated_at=NOW()
       WHERE workspace_id=$1 AND pinned=FALSE AND last_used_at IS NOT NULL
         AND status IS DISTINCT FROM CASE
           WHEN last_used_at < NOW()-INTERVAL '90 days' THEN 'archived'
           WHEN last_used_at < NOW()-INTERVAL '30 days' THEN 'stale'
           ELSE 'active'
         END`,
      [workspaceId]
    );
  }

  async setWorkspaceSkillState(input: {
    userId: string;
    workspaceId: string;
    id: string;
    status?: WorkspaceSkillRecord['status'];
    pinned?: boolean;
    /**
     * The owner turning a learned procedure off without deleting it.
     *
     * `enabled` has always been a real column with a real reader - a disabled skill is dropped from
     * the index the model sees - and no writer, while the approval card for a skill upsert told the
     * owner "You had turned this off. Approving this switches it back on." about a state the
     * product could not enter. The card was describing a control that did not exist.
     */
    enabled?: boolean;
  }): Promise<WorkspaceSkillRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_skills SET
         status=COALESCE($4,status),
         pinned=COALESCE($5,pinned),
         enabled=COALESCE($6,enabled),
         updated_at=NOW()
       WHERE id=$1 AND workspace_id=$3 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_skills.workspace_id AND w.user_id=$2
       ) RETURNING *`,
      [
        input.id,
        input.userId,
        input.workspaceId,
        input.status ?? null,
        input.pinned ?? null,
        input.enabled ?? null
      ]
    );
    return result.rows[0] ? mapWorkspaceSkill(result.rows[0]) : null;
  }

  async deleteWorkspaceSkill(userId: string, workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM workspace_skills WHERE id=$3 AND workspace_id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_skills.workspace_id AND w.user_id=$1
       )`,
      [userId, workspaceId, id]
    );
    return result.rowCount === 1;
  }

  /** Replaces the keys this computer lends to every goal it starts from now on. */
  async updateWorkspaceLentKeys(
    userId: string,
    id: string,
    lentKeys: WorkspaceRecord['lentKeys']
  ): Promise<WorkspaceRecord | null> {
    const result = await this.database.query(
      `UPDATE workspaces SET lent_keys=$3::TEXT[],updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, [...new Set(lentKeys)]]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }

  async updateWorkspaceSecurityMode(
    userId: string,
    id: string,
    securityMode: WorkspaceRecord['securityMode']
  ): Promise<WorkspaceRecord | null> {
    const result = await this.database.query(
      `UPDATE workspaces SET security_mode=$3,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, securityMode]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }

  async createArtifact(input: {
    userId: string;
    workspaceId: string;
    taskId?: string;
    logicalKey: string;
    nameCiphertext: EncryptedEnvelope;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  }): Promise<Record<string, unknown>> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId]);
      const version = await tx.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version),0)+1 AS next_version FROM artifacts
         WHERE workspace_id=$1 AND logical_key=$2`,
        [input.workspaceId, input.logicalKey]
      );
      const id = randomUUID();
      const result = await tx.query(
        `INSERT INTO artifacts(id,user_id,workspace_id,task_id,name_ciphertext,mime_type,size_bytes,version,sha256,storage_key,logical_key)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id,
          input.userId,
          input.workspaceId,
          input.taskId ?? null,
          JSON.stringify(input.nameCiphertext),
          input.mimeType,
          input.sizeBytes,
          Number(version.rows[0]?.next_version ?? 1),
          input.sha256,
          input.storageKey,
          input.logicalKey
        ]
      );
      return result.rows[0]!;
    });
  }

  async listArtifacts(
    userId: string,
    workspaceId: string,
    taskId?: string,
    limit?: number
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT a.* FROM artifacts a JOIN workspaces w ON w.id=a.workspace_id
       WHERE (a.workspace_id=$2 OR ($3::uuid IS NULL AND w.parent_workspace_id=$2)) AND w.user_id=$1 AND ($3::uuid IS NULL OR a.task_id=$3)
       ORDER BY a.created_at DESC LIMIT $4`,
      [userId, workspaceId, taskId ?? null, limit ?? null]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: optionalText(row.task_id),
      nameCiphertext: json<EncryptedEnvelope>(row.name_ciphertext),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      version: Number(row.version),
      sha256: String(row.sha256),
      storageKey: String(row.storage_key),
      logicalKey: String(row.logical_key),
      createdAt: iso(row.created_at)
    }));
  }

  async getArtifact(userId: string, id: string): Promise<Record<string, unknown> | null> {
    const result = await this.database.query(
      `SELECT a.* FROM artifacts a JOIN workspaces w ON w.id=a.workspace_id
       WHERE a.id=$1 AND w.user_id=$2`,
      [id, userId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          workspaceId: String(row.workspace_id),
          taskId: optionalText(row.task_id),
          nameCiphertext: json<EncryptedEnvelope>(row.name_ciphertext),
          mimeType: String(row.mime_type),
          sizeBytes: Number(row.size_bytes),
          version: Number(row.version),
          sha256: String(row.sha256),
          storageKey: String(row.storage_key),
          logicalKey: String(row.logical_key),
          createdAt: iso(row.created_at)
        }
      : null;
  }

  async deleteArtifact(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM artifacts WHERE id=$1 AND EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id=artifacts.workspace_id AND w.user_id=$2
      )`,
      [id, userId]
    );
    return result.rowCount === 1;
  }

  /**
   * A private preview, live until the owner ends it or stops opening it.
   *
   * There is no lifetime to pass: the deadline this writes is an idle window that every visit
   * through the preview gateway pushes back out, so the owner's own app stays reachable from their
   * own devices for as long as they keep using it, and a link nobody has opened in a month closes
   * itself rather than leaving a bearer token live in a chat history.
   */
  async createWorkspacePreview(input: {
    userId: string;
    workspaceId: string;
    label: string;
    port: number;
    slug: string;
    accessTokenHash: string;
    entryPath?: string | null;
    maxPreviews?: number;
    /**
     * How long this one may sit idle before it expires, as a Postgres interval.
     *
     * A `brief` conversation publishes something to be looked at and closed, and giving it the same
     * month of idle life as everything else is how a box ends up serving a list of pages nobody
     * remembers asking for. Absent means the ordinary idle window, which is what every conversation
     * had before a run could say how long it was meant to live.
     */
    idleInterval?: string;
  }): Promise<WorkspacePreviewRecord> {
    const maxPreviews = input.maxPreviews ?? MAX_WORKSPACE_PREVIEWS;
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const count = await tx.query(
        `SELECT COUNT(*) AS count FROM workspace_previews
         WHERE user_id=$1 AND status='active'
           AND (expires_at IS NULL OR expires_at>NOW())`,
        [input.userId]
      );
      if (Number(count.rows[0]?.count ?? 0) >= maxPreviews) throw new Error('preview_limit');
      const result = await tx.query(
        `INSERT INTO workspace_previews(
           id,user_id,workspace_id,label,port,slug,access_token_hash,entry_path,expires_at,
           idle_interval
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()+$9::interval,$10::interval) RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.workspaceId,
          input.label,
          input.port,
          input.slug,
          input.accessTokenHash,
          input.entryPath ?? null,
          input.idleInterval ?? PREVIEW_IDLE_INTERVAL,
          // NULL when this preview takes the ordinary window, so the renewal reads the constant
          // and one place stays authoritative for it. A window of its own is written down, because
          // the renewal has to know it: a deadline that is not recorded is a deadline the next
          // visit cannot honour.
          input.idleInterval ?? null
        ]
      );
      return mapWorkspacePreview(result.rows[0]!);
    });
  }

  async listWorkspacePreviews(
    userId: string,
    workspaceId?: string
  ): Promise<WorkspacePreviewRecord[]> {
    const result = workspaceId
      ? await this.database.query(
          `SELECT p.* FROM workspace_previews p JOIN workspaces w ON w.id=p.workspace_id
           WHERE p.workspace_id=$2 AND w.user_id=$1
           ORDER BY p.created_at DESC, p.id DESC LIMIT 100`,
          [userId, workspaceId]
        )
      : await this.database.query(
          `SELECT * FROM workspace_previews WHERE user_id=$1
           ORDER BY created_at DESC, id DESC LIMIT 100`,
          [userId]
        );
    return result.rows.map(mapWorkspacePreview);
  }

  async getWorkspacePreview(userId: string, id: string): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM workspace_previews WHERE id=$1 AND user_id=$2',
      [id, userId]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async getWorkspacePreviewBySlug(slug: string): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query('SELECT * FROM workspace_previews WHERE slug=$1', [
      slug
    ]);
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async rotateWorkspacePreviewAccess(
    userId: string,
    id: string,
    accessTokenHash: string
  ): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET access_token_hash=$3,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='active'
         AND (expires_at IS NULL OR expires_at>NOW()) RETURNING *`,
      [id, userId, accessTokenHash]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  /**
   * Moves a preview between private and public, rotating the access token either way.
   *
   * Neither destination is timed. A published site stays up until it is unpublished or revoked,
   * because a link the owner has handed to other people should not expire underneath them; going
   * back to private restores the idle window, so an app the owner keeps using keeps working and
   * one they forget closes on its own.
   */
  async publishWorkspacePreview(
    userId: string,
    id: string,
    visibility: 'private' | 'public',
    accessTokenHash: string
  ): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET visibility=$3,access_token_hash=$4,
       expires_at=CASE WHEN $3='public' THEN NULL
         ELSE NOW()+COALESCE(idle_interval,$5::interval) END,
       status='active',published_at=CASE WHEN $3='public' THEN NOW() ELSE published_at END,
       updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, visibility, accessTokenHash, PREVIEW_IDLE_INTERVAL]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async revokeWorkspacePreview(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET status='revoked',updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='active'`,
      [id, userId]
    );
    return result.rowCount === 1;
  }

  /**
   * Records a visit, and pushes the idle deadline back out by this preview's own window.
   *
   * This is what makes a private preview persistent: use is the renewal, so nothing has to be
   * re-published and no ceiling has to be chosen. A published site has no deadline to move, so the
   * CASE leaves its NULL alone rather than accidentally giving it one.
   *
   * `idle_interval` and not the constant, because renewing by the constant is how a short-lived
   * page became a long-lived one. A `brief` conversation's preview is created with a twenty-four
   * hour deadline and the first visit used to push it to thirty days - so the lifetime the owner
   * chose survived exactly until somebody opened the page it produced. A row with no window of its
   * own falls back to the ordinary one, which is every preview that existed before this column.
   */
  async touchWorkspacePreview(id: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_previews SET last_accessed_at=NOW(),
       expires_at=CASE WHEN expires_at IS NULL THEN NULL
         ELSE NOW()+COALESCE(idle_interval,$2::interval) END
       WHERE id=$1 AND status='active'`,
      [id, PREVIEW_IDLE_INTERVAL]
    );
  }
}
