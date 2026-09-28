/**
 * The SQL text about conversations that more than one statement in `store.ts` says.
 *
 * Fragments, not statements: a predicate the leasing query states twice, the join that reads a
 * lease back as it is cleared, the two derived columns every returned task carries, and the search
 * index's four weights. Each of them exists because it was once written out at two call sites and
 * the copies drifted - `TASK_LIVE_COUNTS` is the one with a user-visible incident behind it - so
 * keeping them together, next to the comments that say what the drift cost, is the point.
 *
 * Text only. Nothing here runs a query or takes a connection; `store.ts` interpolates these into
 * the statements it issues, and the parameter positions each one assumes are named in its comment.
 */

import { CONVERSATION_NAME_INDEX_STAMP } from '@garden/core';
import type { ConversationNameIndex } from '@garden/core';

/**
 * Statuses in which a task is about to spend the rest of its ceiling, which is what a start-time
 * cap has to price in.
 *
 * Only the three a worker is in or reaching for. A task that is parked - waiting on the owner, on a
 * resource, or paused - has no worker and will spend nothing until something puts it back in the
 * queue, and the ceiling is priced again at that point. Reserving against it protects nothing and
 * costs everything: a question asked at five o'clock would hold that conversation's whole unspent
 * ceiling overnight, and the owner would sit down to a daily limit reached by work that never ran.
 */
export const COMMITTED_TASK_STATUSES = "('queued','planning','running')";

/**
 * Whether workspace `w` is free for the given task to walk into.
 *
 * Said twice in the one statement that leases a task: once to pick a candidate, and again on the
 * write that records the hold. The first is where the race is settled - it sits under a row lock,
 * so a competitor that committed a hold in the meantime is re-read and this is evaluated again
 * against what it wrote, and the candidate falls out. The second cannot fire once the first has
 * passed; it is there so that a write which somehow reached it with a live hold in place would
 * record nothing and lease nothing, rather than quietly putting a second agent in the room.
 *
 * Free in three ways, and the breadth is the point: nobody holds it, nobody wrote a deadline, or
 * the deadline has passed. Only a complete and live hold by somebody else excludes anything, so
 * every half-written state - including the one the foreign key leaves when a conversation holding a
 * workspace is deleted - reads as free. A workspace nothing can take back is a computer the owner
 * can no longer use, which is worse than anything this predicate is defending against.
 */
export const WORKSPACE_IS_FREE_FOR = (taskId: string): string =>
  `(w.lease_task_id IS NULL OR w.lease_task_id = ${taskId}
      OR w.lease_expires_at IS NULL OR w.lease_expires_at < NOW())`;

/**
 * Joins a task to the lease it was holding just before the write clears it, as `held_until`.
 *
 * `RETURNING` reports what a write left behind, and every write that lets go of a workspace leaves
 * the same NULL in those columns whether it freed the workspace or found it already free. Reading
 * the row alongside itself is how one statement can also report what was there before, which is
 * what decides whether there is a release worth waking the queue for.
 *
 * The row is locked on the way in, so a worker cannot renew the lease between that read and the
 * update and have the release announced against a workspace it is still inside. Both statements
 * take the same row in the same order, so there is nothing here to deadlock against.
 *
 * Every statement that uses this takes the task id as `$1`.
 */
export const HELD_LEASE_JOIN =
  'FROM (SELECT id AS held_id, lease_expires_at AS held_until FROM tasks' +
  ' WHERE id = $1 FOR UPDATE) held';

/**
 * The searchable form of a conversation's name, written by every statement that writes the name.
 *
 * Four weights, because they are four different questions. A is what the conversation is called, B
 * is the prefixes of what it is called, D is what it was asked to do: a search for "berlin
 * flights" should reach the thread called that before the one half-way through typing it, and both
 * before the one that merely mentioned it in a paragraph. `searchTaskNames` probes the three and
 * orders by them in that order.
 *
 * C is the vector's own shape, the same constant on every row, and it is what tells a row written
 * by this indexer from one written by an older one. Interpolated rather than bound because it is
 * one compile-time constant over the sixteen-letter token alphabet, which is also why it cannot
 * carry punctuation into the statement.
 *
 * It takes the parameter positions rather than being a constant because these statements are
 * insert, update and backfill and no two of them number their placeholders alike.
 */
export const taskNameTsv = (name: number, prefixes: number, opening: number): string =>
  `setweight(to_tsvector('simple', $${name}::text), 'A')` +
  ` || setweight(to_tsvector('simple', $${prefixes}::text), 'B')` +
  ` || setweight(to_tsvector('simple', '${CONVERSATION_NAME_INDEX_STAMP}'), 'C')` +
  ` || setweight(to_tsvector('simple', $${opening}::text), 'D')`;

/** The three token surfaces above, in the order every statement below binds them. */
export const taskNameTokens = (nameIndex: ConversationNameIndex): [string, string, string] => [
  nameIndex.nameTokens,
  nameIndex.prefixTokens ?? '',
  nameIndex.openingTokens
];

/**
 * The two figures a conversation carries that are not columns on `tasks`: how many follow-ups are
 * waiting behind it, and what it has cost in real money.
 *
 * They live here as one fragment because three statements that hand a task straight back to the
 * owner used to answer them with `0 AS queued_message_count` and no spend column at all, which
 * `mapTask` turns into "nothing queued, nothing spent". The client writes the returned record into
 * the sidebar row, so pinning a running conversation cleared its "2 queued" pill and reset its
 * spend to $0.00 until the next full reload - and renaming one, and writing again to a finished
 * one, did the same. Every statement that returns a task now reads from the same definition, so
 * the next one cannot half-fill the record either.
 *
 * The alias is `t` in all of them, which is why it is baked in rather than passed.
 *
 * `share_count` is the third figure, added for the same reason: the "Shared" badge is drawn from
 * the record the sidebar holds, and a rename or a pin that handed back a record without it would
 * take the badge off a conversation that still has a live link. Live means neither revoked nor
 * expired - the same predicate the public lookup answers with, so the badge and the link agree.
 */
export const TASK_LIVE_COUNTS = `
         (SELECT COUNT(*) FROM task_message_queue q
           WHERE q.task_id=t.id AND q.status='queued') AS queued_message_count,
         CASE WHEN t.has_coding_family AND t.parent_mission_id IS NULL THEN (
           SELECT COALESCE(SUM(charges.cost_usd),0) FROM (
             SELECT u.cost_usd FROM usage_entries u JOIN tasks child ON child.id=u.task_id
             WHERE (child.id=t.id OR (child.parent_mission_id IS NOT NULL AND child.parent_task_id=t.id)) AND u.state='settled' AND u.cost_usd>0
             UNION ALL SELECT c.actual_usd FROM coding_family_calls c WHERE c.parent_task_id=t.id AND c.usage_id IS NULL AND c.actual_usd>0
           ) charges
         ) ELSE (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
           WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0) END AS spent_usd,
         (SELECT COUNT(*) FROM task_shares s
           WHERE s.task_id=t.id AND s.revoked_at IS NULL
             AND (s.expires_at IS NULL OR s.expires_at > NOW())) AS share_count`;

/**
 * Four tiers and a clock, and nothing per row that grows.
 *
 * Ranking by how many of the request's terms each candidate carries reads better on paper and cost
 * seven times as much to run: counting means `unnest` and an aggregate per row, and on the query
 * that matches the whole history - a word the owner puts in every conversation - the whole history
 * is what it runs over. Three extra `@@` probes against a vector already in hand answer the
 * question that actually decides the order: is this the conversation called that, is it one whose
 * name mentions it, is it one whose name starts with what is still being typed, or is it one that
 * merely opened by asking about it. Measured over ten thousand conversations every one of which
 * matched, that is 15ms where counting was 101ms, and there is no candidate cap anywhere in it -
 * nothing is dropped to make the number, so nothing has to be confessed to the owner either.
 *
 * The prefix probe is a separate array rather than more lexemes because it must not be allowed to
 * satisfy the other two: a conversation whose name merely starts with what was typed is not a
 * conversation called that, and folding the two together would put every `grim*` in the box above
 * the thread actually named Grimbold. It is restricted to B for the same reason it is written
 * there - the prefix of a name is a weaker claim than the name.
 *
 * The lexemes are keyed HMAC tokens over a sixteen-letter alphabet with no digits and no
 * punctuation (`isMemoryToken` is asserted before they get here), which is what lets them be
 * assembled into a tsquery by string concatenation without a lexeme ever being read as an
 * operator.
 *
 * A request that is not half-typed leaves the prefix probe out of the statement rather than
 * passing an empty array to it. `array_to_string` over nothing is the empty string, and an empty
 * tsquery is a syntax error rather than a query that matches nothing - and a guard around it in
 * SQL is not enough, because the planner is free to fold a cast over constant parameters before it
 * ever reaches the branch that would have skipped it.
 *
 * The columns are named rather than `t.*`: a task row carries its agent state, which is the whole
 * conversation, and pulling fifty of those back to read fifty titles would rebuild here the cost
 * the index was added to remove.
 */
const taskNameSearchSql = (prefixed: boolean, grouped = false): string => `
SELECT t.id, t.workspace_id, t.title, t.prompt_ciphertext, t.updated_at,
       (t.name_tsv @@ (array_to_string($2::text[], ':A & ') || ':A')::tsquery) AS whole_name,
       (t.name_tsv @@ (array_to_string($2::text[], ':A | ') || ':A')::tsquery) AS in_name,
       ${prefixed ? `(t.name_tsv @@ (array_to_string($5::text[], ':B | ') || ':B')::tsquery)` : 'false'} AS name_prefix
FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
WHERE w.user_id = $1
  AND ${grouped ? 't.workspace_id = ANY($3::uuid[])' : '($3::uuid IS NULL OR t.workspace_id = $3)'}
  AND t.name_tsv @@ (array_to_string($2::text[], ' | ')${
    prefixed ? ` || ' | ' || array_to_string($5::text[], ':B | ') || ':B'` : ''
  })::tsquery
ORDER BY whole_name DESC, in_name DESC, name_prefix DESC,
         GREATEST(t.updated_at, t.created_at) DESC, t.id DESC
LIMIT $4`;

/** Both shapes are built once: the statement is chosen per query, never assembled per query. */
export const TASK_NAME_SEARCH_SQL = {
  plain: taskNameSearchSql(false),
  prefixed: taskNameSearchSql(true)
};

/** Workspaces sharing an index key can share one owner-scoped name lookup. */
export const OWNER_TASK_NAME_SEARCH_SQL = {
  plain: taskNameSearchSql(false, true),
  prefixed: taskNameSearchSql(true, true)
};

/**
 * One conversation's turn boundaries and its dispatched tool calls, and nothing else.
 *
 * Written for one reader: the per-tool turn-incidence aggregate behind `GET /v1/usage/tool-opens`,
 * which is the instrument `docs/design/organs/PREAMBLE.md` §10.4 gates the tool catalogue's
 * deferral tier on. That decision is per TURN and not per call - a tool called five times in one
 * turn would be opened once - so the turn a call belongs to has to travel with it, and so do the
 * turns that called nothing at all. Both kinds are returned for that reason: drop the boundaries
 * and every rate is computed against a denominator of turns that happened to use a tool, which is
 * the one arithmetic error that would make every number here too large.
 *
 * WHY THE TURN IS COUNTED IN SQL. It is the one part of this question that is legible without a
 * key: `kind` is plaintext, and every message sent into a conversation after the first writes a
 * `user_message` row - `continueTask`, `enqueueTaskMessage` and `promoteQueuedMessage` all do. So a
 * running count of those rows numbers the turns without decrypting anything. It starts at 1 rather
 * than 0 because `createTask` writes NO `user_message` event for the opening request - that text is
 * the task's own `prompt_ciphertext` - so a conversation nobody followed up is one turn, not zero.
 *
 * The window function is in a subquery on purpose. Postgres applies a query level's WHERE before
 * its window functions, so a cursor predicate written beside the `SUM(...) OVER` would renumber
 * from the top of each page, and page two of a conversation would report its turns as though the
 * conversation began there. Numbering over the whole task and filtering outside it is what makes a
 * paged read give the same answer as an unpaged one.
 *
 * `kind` is narrowed to these two, and that narrowing is the whole reason this statement exists
 * rather than the caller filtering `listTaskEventPage`: `assistant_delta` frames are most of a
 * trajectory's rows and nearly all of its bytes, and a walk of the timeline would carry every one
 * of them out of the database to read forty tool names.
 *
 * A `user_message` row comes back with its payload NULLED rather than carried. The caller wants the
 * boundary and the time, never the words, and a ciphertext that is not sent cannot be opened by
 * mistake by a reader that already holds the key.
 *
 * Parameters: $1 task id, $2 exclusive sequence cursor, $3 row limit.
 */
export const TURN_TOOL_STARTS_SQL = `
SELECT id, sequence, turn, kind, created_at,
       CASE WHEN kind='tool_started' THEN payload_ciphertext END AS payload_ciphertext
  FROM (
  SELECT id, sequence, kind, payload_ciphertext, created_at,
         1 + SUM(CASE WHEN kind='user_message' THEN 1 ELSE 0 END)
               OVER (ORDER BY sequence ROWS UNBOUNDED PRECEDING) AS turn
    FROM task_events
   WHERE task_id=$1 AND kind IN ('user_message','tool_started')
) numbered
WHERE sequence > $2
ORDER BY sequence
LIMIT $3`;

/**
 * The conversations that hold at least one turn opening inside a window, newest first.
 *
 * The other half of the open-rate instrument: which conversations `TURN_TOOL_STARTS_SQL` should be
 * run over. Reading every conversation the box has ever held and skipping the quiet ones is what
 * this replaces.
 *
 * TWO WAYS IN, and the first one is the one that is easy to leave out. A turn opens either with the
 * conversation itself - `createTask` writes no `user_message` for the opening request - or with a
 * `user_message` row. So a conversation created inside the window qualifies on its own timestamp
 * even when it wrote no events at all, which is exactly what a turn the model answered without
 * reaching for a tool looks like from here. Selecting only on events would drop those turns from
 * the DENOMINATOR while keeping every turn that used something, and every share computed from it
 * would be too large - the one error in this arithmetic that biases toward deferring.
 *
 * `tasks.updated_at` is deliberately not the test, though it would have been cheaper. `appendTaskEvent`
 * does not touch it: it takes the task's row lock and writes only to `task_events`. A conversation
 * is stamped when its status moves or its lease is renewed, which is frequent enough that the wrong
 * answer would almost always agree with this one - and "almost always" in a measurement that exists
 * to settle a byte budget is how a number nobody can reproduce gets published.
 *
 * Parameters: $1 user id, $2 window start, $3 window end (exclusive), $4 conversation limit.
 */
export const TASKS_WITH_TURNS_IN_WINDOW_SQL = `
SELECT t.id, t.workspace_id, t.created_at
  FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
 WHERE w.user_id = $1
   AND ((t.created_at >= $2 AND t.created_at < $3)
        OR EXISTS (SELECT 1 FROM task_events e
                    WHERE e.task_id = t.id
                      AND e.kind IN ('user_message','tool_started')
                      AND e.created_at >= $2 AND e.created_at < $3))
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT $4`;
