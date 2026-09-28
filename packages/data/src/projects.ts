import { randomUUID } from 'node:crypto';
import { GardenError, decryptJson, encryptJson, unwrapDataKey } from '@garden/core';
import type {
  Project,
  UpdateProjectRequest,
  ProjectNote,
  CreateProjectNoteRequest
} from '@garden/contracts';
import type { Database } from './database.js';
import { encryptedText, iso, json, mapTask, mapTaskEvent } from './store/rows.js';
import type { EncryptedEnvelope } from '@garden/core';
import { TASK_LIVE_COUNTS } from './store/sql/tasks.js';
import { PENDING_MEDIA_DELIVERY } from '@garden/contracts';
import { taskDeliveryCountsSql } from './task-delivery.js';

const counts = `
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.parent_mission_id IS NULL) AS conversation_count,
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.parent_mission_id IS NULL AND (t.status IN ('queued','planning','running') OR EXISTS(SELECT 1 FROM delivery d WHERE d.task_id=t.id AND d.pending>0))) AS active_count,
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.parent_mission_id IS NULL AND (t.status IN ('awaiting_user','awaiting_resource','failed') OR (t.pending_question_id IS NOT NULL AND t.status NOT IN ('completed','cancelled','failed')) OR EXISTS(SELECT 1 FROM delivery d WHERE d.task_id=t.id AND d.failed>0))) AS attention_count,
  (SELECT t.id FROM tasks t WHERE t.project_id=p.id AND t.parent_mission_id IS NULL
    ORDER BY (t.archived_at IS NULL) DESC,t.updated_at DESC,t.id DESC LIMIT 1) AS latest_task_id,
  COALESCE((SELECT SUM(u.cost_usd) FROM usage_entries u WHERE u.project_id=p.id AND u.state='settled' AND u.cost_usd>0),0) +
  COALESCE((SELECT SUM(c.actual_usd) FROM coding_family_calls c WHERE c.project_id=p.id AND c.actual_usd>0
    AND NOT EXISTS(SELECT 1 FROM usage_entries u WHERE u.id=c.usage_id AND u.project_id=p.id AND u.state='settled')),0) AS spent_usd`;

export interface ProjectRecord {
  id: string;
  userId: string;
  workspaceId: string;
  parentWorkspaceId: string;
  wrappedKey: string;
  title: string;
  briefCiphertext: EncryptedEnvelope;
  securityMode: Project['securityMode'];
  revision: number;
  pinned: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
  activeCount: number;
  attentionCount: number;
  spentUsd: number;
  latestTaskId: string | null;
}

const map = (r: Record<string, unknown>): ProjectRecord => ({
  id: String(r.id),
  userId: String(r.user_id),
  workspaceId: String(r.workspace_id),
  parentWorkspaceId: String(r.parent_workspace_id ?? r.workspace_id),
  wrappedKey: String(r.wrapped_key),
  title: String(r.title),
  securityMode: r.security_mode as Project['securityMode'],
  briefCiphertext: json(r.brief_ciphertext),
  revision: Number(r.revision),
  pinned: Boolean(r.pinned),
  archivedAt: r.archived_at ? iso(r.archived_at) : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  conversationCount: Number(r.conversation_count ?? 0),
  activeCount: Number(r.active_count ?? 0),
  attentionCount: Number(r.attention_count ?? 0),
  spentUsd: Number(r.spent_usd ?? 0),
  latestTaskId: typeof r.latest_task_id === 'string' ? r.latest_task_id : null
});

export function projectResponse(
  record: ProjectRecord,
  masterKey: Uint8Array,
  includeBrief = true
): Project {
  const key = unwrapDataKey(record.wrappedKey, masterKey, record.workspaceId);
  const title = encryptedText(record.title);
  const brief = includeBrief
    ? decryptJson<{ brief?: string; prompt?: string }>(record.briefCiphertext, key)
    : {};
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    parentWorkspaceId: record.parentWorkspaceId,
    title: title.ciphertext
      ? decryptJson<{ title: string }>(title.ciphertext, key).title
      : (title.legacy ?? 'Project'),
    securityMode: record.securityMode,
    brief: brief.brief ?? brief.prompt ?? '',
    revision: record.revision,
    pinned: record.pinned,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    conversationCount: record.conversationCount,
    activeCount: record.activeCount,
    attentionCount: record.attentionCount,
    spentUsd: record.spentUsd,
    latestTaskId: record.latestTaskId
  };
}

export class ProjectStore {
  constructor(private readonly database: Database) {}

  async projectInputWorkspaceIds(userId: string, taskId: string): Promise<string[]> {
    const result = await this.database.query(
      `SELECT DISTINCT w.id FROM tasks scope JOIN project_workspaces r ON r.project_id=scope.project_id AND r.user_id=scope.user_id
       JOIN workspaces w ON w.id=r.workspace_id AND w.user_id=r.user_id
       WHERE scope.id=$2 AND scope.user_id=$1 AND w.parent_workspace_id IS NOT NULL AND w.internal_parent_task_id IS NULL`,
      [userId, taskId]
    );
    return result.rows.map((row) => String(row.id));
  }

  async getProject(userId: string, projectId: string): Promise<ProjectRecord | null> {
    const result = await this.database.query(
      `WITH page AS (SELECT * FROM projects WHERE user_id=$1 AND id=$2),
       delivery AS (${taskDeliveryCountsSql('SELECT t.id FROM tasks t JOIN page p ON t.project_id=p.id', '$3')})
       SELECT p.*,w.parent_workspace_id,k.wrapped_key,${counts} FROM page p
       JOIN workspaces w ON w.id=p.workspace_id AND w.user_id=p.user_id
       JOIN workspace_keys k ON k.workspace_id=w.id`,
      [userId, projectId, [...PENDING_MEDIA_DELIVERY]]
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async listProjects(
    userId: string,
    options: { before?: string; archived?: boolean; limit?: number } = {}
  ) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 40));
    const result = await this.database.query(
      `WITH page AS (SELECT * FROM projects WHERE user_id=$1 AND (archived_at IS NOT NULL)=$2
        AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM projects WHERE id=$3 AND user_id=$1))
        ORDER BY created_at DESC,id DESC LIMIT $4),
       delivery AS (${taskDeliveryCountsSql('SELECT t.id FROM tasks t JOIN page p ON t.project_id=p.id', '$5')})
       SELECT p.*,w.parent_workspace_id,k.wrapped_key,${counts} FROM page p
       JOIN workspaces w ON w.id=p.workspace_id AND w.user_id=p.user_id
       JOIN workspace_keys k ON k.workspace_id=w.id ORDER BY p.created_at DESC,p.id DESC`,
      [
        userId,
        options.archived ?? false,
        options.before ?? null,
        limit + 1,
        [...PENDING_MEDIA_DELIVERY]
      ]
    );
    const records = result.rows.slice(0, limit).map(map);
    return {
      projects: records,
      nextCursor: result.rows.length > limit ? records.at(-1)!.id : null
    };
  }

  async updateProject(
    userId: string,
    projectId: string,
    input: UpdateProjectRequest,
    masterKey: Uint8Array
  ) {
    const project = await this.getProject(userId, projectId);
    if (!project) throw new GardenError('project_not_found', 'Project not found', 404);
    const key = unwrapDataKey(project.wrappedKey, masterKey, project.workspaceId);
    const result = await this.database.query(
      `UPDATE projects SET title=COALESCE($4,title),brief_ciphertext=COALESCE($5::jsonb,brief_ciphertext),
       title_source=CASE WHEN $4::text IS NULL THEN title_source ELSE 'owner' END,
       security_mode=COALESCE($8,security_mode),pinned=COALESCE($6,pinned),archived_at=CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN NOW() ELSE NULL END,
       revision=revision+1,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND revision=$3 RETURNING id`,
      [
        projectId,
        userId,
        input.expectedRevision,
        input.title === undefined
          ? null
          : JSON.stringify(encryptJson({ title: input.title }, key, `project-title:${projectId}`)),
        input.brief === undefined
          ? null
          : JSON.stringify(encryptJson({ brief: input.brief }, key, `project-brief:${projectId}`)),
        input.pinned ?? null,
        input.archived ?? null,
        input.securityMode ?? null
      ]
    );
    if (!result.rows.length)
      throw new GardenError(
        'project_changed',
        'This project changed elsewhere. Reload before saving.',
        409
      );
    return (await this.getProject(userId, projectId))!;
  }

  async #projectKey(userId: string, projectId: string, masterKey: Uint8Array) {
    const result = await this.database.query(
      `SELECT p.workspace_id,k.wrapped_key FROM projects p JOIN workspace_keys k ON k.workspace_id=p.workspace_id WHERE p.id=$1 AND p.user_id=$2`,
      [projectId, userId]
    );
    if (!result.rows.length) throw new GardenError('project_not_found', 'Project not found', 404);
    return unwrapDataKey(
      String(result.rows[0]!.wrapped_key),
      masterKey,
      String(result.rows[0]!.workspace_id)
    );
  }

  async listProjectNotes(
    userId: string,
    projectId: string,
    masterKey: Uint8Array,
    options: { before?: string; limit?: number; history?: boolean } = {}
  ) {
    const key = await this.#projectKey(userId, projectId, masterKey),
      limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const result = await this.database.query(
      `SELECT n.*,next.id AS superseded_by FROM project_notes n
      LEFT JOIN project_notes next ON next.replaces_id=n.id AND next.removed_at IS NULL
      WHERE n.project_id=$1 AND n.user_id=$2 AND n.removed_at IS NULL AND ($3::boolean OR next.id IS NULL)
      AND ($4::uuid IS NULL OR (n.created_at,n.id)<(SELECT created_at,id FROM project_notes WHERE id=$4 AND project_id=$1))
      ORDER BY n.created_at DESC,n.id DESC LIMIT $5`,
      [projectId, userId, options.history ?? false, options.before ?? null, limit + 1]
    );
    const notes: ProjectNote[] = result.rows.slice(0, limit).map((row) => ({
      id: String(row.id),
      projectId,
      kind: row.kind as ProjectNote['kind'],
      body: decryptJson<{ body: string }>(
        json(row.body_ciphertext),
        key,
        `project-note:${String(row.id)}`
      ).body,
      source: row.source_ciphertext
        ? decryptJson(json(row.source_ciphertext), key, `project-note-source:${String(row.id)}`)
        : null,
      replacesId: typeof row.replaces_id === 'string' ? row.replaces_id : null,
      supersededBy: typeof row.superseded_by === 'string' ? row.superseded_by : null,
      createdAt: iso(row.created_at)
    }));
    return { notes, nextCursor: result.rows.length > limit ? notes.at(-1)!.id : null };
  }

  async addProjectNote(
    userId: string,
    projectId: string,
    input: CreateProjectNoteRequest,
    masterKey: Uint8Array
  ) {
    const key = await this.#projectKey(userId, projectId, masterKey),
      id = randomUUID();
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        projectId,
        userId
      ]);
      if (input.source) {
        const source = await tx.query(
          `SELECT id FROM tasks WHERE id=$1 AND project_id=$2 AND user_id=$3`,
          [input.source.taskId, projectId, userId]
        );
        if (!source.rows.length)
          throw new GardenError(
            'project_source_unavailable',
            'Choose a source in this project',
            404
          );
        if (
          input.source.eventId &&
          !(
            await tx.query('SELECT id FROM task_events WHERE task_id=$1 AND id=$2', [
              input.source.taskId,
              input.source.eventId
            ])
          ).rows.length
        )
          throw new GardenError(
            'project_source_unavailable',
            'The selected message is unavailable',
            404
          );
      }
      if (input.replacesId) {
        const prior = await tx.query(
          `SELECT id FROM project_notes WHERE id=$1 AND project_id=$2 AND user_id=$3 AND removed_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM project_notes next WHERE next.replaces_id=$1)`,
          [input.replacesId, projectId, userId]
        );
        if (!prior.rows.length)
          throw new GardenError(
            'project_note_changed',
            'This note was already corrected. Reload before adding a correction.',
            409
          );
      }
      await tx.query(
        `INSERT INTO project_notes(id,project_id,user_id,kind,body_ciphertext,source_ciphertext,replaces_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [
          id,
          projectId,
          userId,
          input.kind,
          JSON.stringify(encryptJson({ body: input.body }, key, `project-note:${id}`)),
          input.source
            ? JSON.stringify(encryptJson(input.source, key, `project-note-source:${id}`))
            : null,
          input.replacesId ?? null
        ]
      );
      await tx.query('UPDATE projects SET updated_at=NOW() WHERE id=$1', [projectId]);
    });
    return { id };
  }

  async removeProjectNote(userId: string, projectId: string, noteId: string) {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [
        projectId,
        userId
      ]);
      const result = await tx.query(
        `UPDATE project_notes SET removed_at=NOW() WHERE id=$1 AND project_id=$2 AND user_id=$3 AND removed_at IS NULL RETURNING id`,
        [noteId, projectId, userId]
      );
      // Removing a correction must not silently restore the claim it corrected.
      if (result.rows.length)
        await tx.query(
          `WITH RECURSIVE prior AS (SELECT replaces_id AS id FROM project_notes WHERE id=$1
        UNION ALL SELECT n.replaces_id FROM project_notes n JOIN prior p ON n.id=p.id WHERE n.replaces_id IS NOT NULL)
        UPDATE project_notes SET removed_at=NOW() WHERE id IN (SELECT id FROM prior) AND project_id=$2`,
          [noteId, projectId]
        );
      await tx.query('UPDATE projects SET updated_at=NOW() WHERE id=$1 AND user_id=$2', [
        projectId,
        userId
      ]);
      return { removed: result.rows.length > 0 };
    });
  }

  async projectSourceEvent(userId: string, projectId: string, taskId: string, eventId?: string) {
    const result = await this.database.query(
      `SELECT e.* FROM task_events e JOIN tasks t ON t.id=e.task_id
      WHERE t.id=$1 AND t.user_id=$2 AND t.project_id=$3 AND
      (($4::uuid IS NOT NULL AND e.id=$4) OR ($4::uuid IS NULL AND e.kind IN ('assistant_message','result')))
      ORDER BY e.sequence DESC LIMIT 1`,
      [taskId, userId, projectId, eventId ?? null]
    );
    return result.rows[0] ? mapTaskEvent(result.rows[0]) : null;
  }

  async listProjectConversations(
    userId: string,
    projectId: string,
    options: { before?: string; archived?: boolean; limit?: number } = {}
  ) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 40));
    const result = await this.database.query(
      `WITH page AS (SELECT t.*,${TASK_LIVE_COUNTS} FROM tasks t WHERE t.user_id=$1 AND t.project_id=$2 AND t.parent_mission_id IS NULL
       AND ($3::boolean IS NULL OR (t.archived_at IS NOT NULL)=$3)
       AND ($4::uuid IS NULL OR (t.created_at,t.id)<(SELECT created_at,id FROM tasks WHERE id=$4 AND user_id=$1 AND project_id=$2))
       ORDER BY t.created_at DESC,t.id DESC LIMIT $5),
       delivery AS (${taskDeliveryCountsSql('SELECT id FROM page', '$6')})
       SELECT page.*,CASE WHEN delivery.task_id IS NULL THEN NULL WHEN delivery.failed>0 THEN 'incomplete'
         WHEN delivery.pending>0 THEN 'pending' ELSE 'ready' END AS delivery_status,
         COALESCE(delivery.pending,0)::int AS pending_delivery_count
       FROM page LEFT JOIN delivery ON delivery.task_id=page.id ORDER BY page.created_at DESC,page.id DESC`,
      [
        userId,
        projectId,
        options.archived ?? null,
        options.before ?? null,
        limit + 1,
        [...PENDING_MEDIA_DELIVERY]
      ]
    );
    const tasks = result.rows.slice(0, limit).map(mapTask);
    return { tasks, nextCursor: result.rows.length > limit ? tasks.at(-1)!.id : null };
  }
}
