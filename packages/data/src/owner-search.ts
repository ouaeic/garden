import { isMemoryToken, type EncryptedEnvelope, type MemoryQueryPlan } from '@garden/core';
import type { Database } from './database.js';
import { encryptedText, iso, json } from './store/rows.js';
import type { TaskNameHit } from './store/tasks.js';
import { OWNER_MEMORY_SOURCE_SEARCH_SQL } from './store/sql/memory.js';
import { OWNER_TASK_NAME_SEARCH_SQL } from './store/sql/tasks.js';

export type OwnerHistoryHit = {
  workspaceId: string;
  bodyCiphertext: EncryptedEnvelope;
  score: number;
  task: Pick<
    TaskNameHit,
    'id' | 'workspaceId' | 'titleCiphertext' | 'legacyTitle' | 'promptCiphertext' | 'updatedAt'
  >;
};

/** Source roots and current task roots are distinct when a project retains its earlier history. */
export const searchOwnerHistory = async (
  database: Database,
  input: {
    userId: string;
    workspaceIds: readonly string[];
    sourceWorkspaceIds: readonly string[];
    plan: MemoryQueryPlan;
    prefixes: readonly string[];
    limit: number;
  }
): Promise<{ names: TaskNameHit[]; passages: OwnerHistoryHit[] }> => {
  const lexemes = [...new Set(input.plan.lexemes.filter(isMemoryToken))];
  if (lexemes.length === 0 || input.workspaceIds.length === 0) return { names: [], passages: [] };
  const prefixes = [...new Set(input.prefixes.filter(isMemoryToken))];
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit)));
  const [names, passages] = await Promise.all([
    database.query(
      prefixes.length ? OWNER_TASK_NAME_SEARCH_SQL.prefixed : OWNER_TASK_NAME_SEARCH_SQL.plain,
      [input.userId, lexemes, input.workspaceIds, limit, ...(prefixes.length ? [prefixes] : [])]
    ),
    database.query(OWNER_MEMORY_SOURCE_SEARCH_SQL, [
      input.sourceWorkspaceIds,
      lexemes,
      null,
      null,
      null,
      limit,
      1,
      input.userId,
      input.workspaceIds
    ])
  ]);
  return {
    names: names.rows.map((row) => {
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
    }),
    passages: passages.rows.map((row) => {
      const title = encryptedText(row.task_title);
      return {
        workspaceId: String(row.workspace_id),
        bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext),
        score: Number(row.score),
        task: {
          id: String(row.task_id),
          workspaceId: String(row.task_workspace_id),
          titleCiphertext: title.ciphertext,
          legacyTitle: title.legacy,
          promptCiphertext: json<EncryptedEnvelope>(row.task_prompt_ciphertext),
          updatedAt: iso(row.task_updated_at)
        }
      };
    })
  };
};
