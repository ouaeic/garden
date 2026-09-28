/**
 * The three statements the tiered memory layer runs, and the caps written into them.
 *
 * Recall, verbatim search and the window around a hit are one enormous piece of SQL each, on
 * purpose - fusion, quotas and the token budget are all evaluated in the database, so nothing is
 * sorted or trimmed in the application. That makes them the longest and least readable stretch of
 * `store.ts` and simultaneously the part of it least connected to the rest: they are constants.
 *
 * They are also the part where a single altered character would still be valid SQL and would
 * simply answer differently, which nothing in the type system can see. What sees it is
 * `memory-eval.test.ts`: it commits recall, MRR and pack tokens for a fixed corpus against these
 * exact statements through the real `DataStore`, so a transcription error here moves a committed
 * number rather than passing quietly.
 */

/** Retrieval never invents a scope: everything a caller can widen is a bound parameter. */
const MEMORY_ITEM_ADMISSIBLE = `
      i.workspace_id = q.ws
      AND (i.status = 'active'
           OR (q.want_superseded AND i.status IN ('superseded','disputed'))
           OR (q.scope = 'archive' AND i.status = 'archived'))
      AND (q.want_inferred OR i.trust <> 'inferred') -- want_inferred is pinned false
      AND (q.kinds IS NULL OR i.kind::text = ANY(q.kinds))
      -- Rows the caller already holds. An agent-initiated recall passes the ids its frozen pack
      -- printed, so the answer it did not get the first time is not paid for a second time - and it
      -- is excluded here, before a channel spends one of its capped slots on it, rather than after.
      AND NOT (i.id = ANY(q.exclude))
      AND (q.as_of IS NULL
           OR (i.valid_from <= q.as_of AND (i.valid_to IS NULL OR i.valid_to > q.as_of)))`;

// Each channel is capped before anything is sorted: BM25 is only ever evaluated over the rows a
// GIN probe already matched, which is the entire mitigation for "ranking gets slow at scale".
const MEMORY_LEXICAL_CANDIDATES = 120;
const MEMORY_FUZZY_CANDIDATES = 40;
/**
 * How many rows the fuzzy channel may compute an exact Jaccard score for. Array overlap is
 * satisfied by a single shared trigram, so the GIN probe generates candidates but no selectivity;
 * without this cap the per-row `unnest` scored the whole corpus on every recall and grew linearly
 * with it. Fifteen times the number of rows the channel can contribute is ample headroom.
 */
const MEMORY_FUZZY_SCAN_CANDIDATES = 600;
const MEMORY_STRUCTURAL_CANDIDATES = 40;
/** Sources older than this stop competing with the curated overlay for the lexical slot. */
const MEMORY_SOURCE_HORIZON_YEARS = 3;

/**
 * How many of the request's terms become tsquery branches.
 *
 * Every branch is its own GIN posting-list probe, so this is the one place recall cost is linear in
 * question length. The client now hands over the whole request rather than a pseudorandom sample of
 * it (see `planMemoryQuery`), which is what makes choosing here worth doing: the database is the
 * only party that knows document frequency, so it keeps the rarest - most discriminative - terms
 * and drops the ones a hundred rows already share.
 */
const MEMORY_QUERY_TERMS = 32;

/**
 * The `terms` CTE, shared by item recall and verbatim search.
 *
 * `mem.lexeme_df` holds one row per lexeme the workspace has ever indexed, so a term missing from
 * it appears in no document and cannot match anything. Those terms sort last rather than being
 * filtered out: they cost nothing (a tsquery branch that matches no row) and never displace a term
 * that could match. Among terms that do exist, ascending document frequency is exactly the
 * discriminative order.
 */
const MEMORY_TERMS_CTE = `
terms AS (
  SELECT t.lexeme, COALESCE(d.df, 1)::float8 AS df
  FROM q CROSS JOIN unnest($2::text[]) AS t(lexeme)
  LEFT JOIN mem.lexeme_df d ON d.workspace_id = q.ws AND d.lexeme = t.lexeme
  ORDER BY (d.df IS NULL) ASC, COALESCE(d.df, 1) ASC, t.lexeme ASC
  LIMIT ${MEMORY_QUERY_TERMS}
),
qq AS (
  SELECT array_agg(t.lexeme ORDER BY t.lexeme) AS q_lex,
         array_agg(ln(1 + GREATEST(s.n_docs - t.df + 0.5, 0.0) / (t.df + 0.5))
                   ORDER BY t.lexeme) AS q_idf,
         NULLIF(string_agg(t.lexeme, ' | ' ORDER BY t.lexeme), '')::tsquery AS q_ts
  FROM terms t CROSS JOIN stats s
)`;

/**
 * One statement: five capped recall channels, weighted reciprocal-rank fusion, a multiplicative
 * provenance/recency/salience prior, per-kind quotas and the token budget. Nothing is sorted in
 * the application, and the result already respects the budget it was asked for.
 *
 * The final ORDER BY is (kind, id), not score: the pack sits behind a prompt-cache breakpoint, so
 * the same set of rows must always render to the same bytes. `score` is returned for callers that
 * want relevance order for an interactive recall.
 */
export const MEMORY_RECALL_SQL = `
WITH q AS (
  SELECT $1::uuid AS ws, $3::text[] AS q_trg, $4::text[] AS q_ents, $5::text[] AS q_tags,
         $6::timestamptz AS t_now, $7::bool AS temporal_intent, $8::bool AS want_inferred,
         $9::bool AS want_superseded, $12::timestamptz AS as_of, $13::text[] AS kinds,
         $14::text AS scope, $23::uuid[] AS exclude
),
stats AS (
  SELECT GREATEST(COALESCE(c.n_docs, 1), 1)::float8 AS n_docs,
         GREATEST(COALESCE(c.sum_len::float8 / NULLIF(c.n_docs, 0), 1), 1)::float8 AS avg_len
  FROM q LEFT JOIN mem.corpus_stats c ON c.workspace_id = q.ws
),
${MEMORY_TERMS_CTE},
lex_item AS (
  SELECT id, row_number() OVER (ORDER BY s DESC, id) AS r FROM (
    SELECT i.id, mem.bm25(qq.q_lex, qq.q_idf, i.tsv, i.tsv_len, st.avg_len) AS s
    FROM mem.item i CROSS JOIN q CROSS JOIN qq CROSS JOIN stats st
    WHERE ${MEMORY_ITEM_ADMISSIBLE}
      AND i.tsv @@ qq.q_ts
    ORDER BY s DESC, i.id
    LIMIT ${MEMORY_LEXICAL_CANDIDATES}
  ) t
),
lex_src AS (
  SELECT id, row_number() OVER (ORDER BY s DESC, id) AS r FROM (
    SELECT sc.id, mem.bm25(qq.q_lex, qq.q_idf, sc.tsv, sc.tsv_len, st.avg_len) AS s
    FROM mem.source sc CROSS JOIN q CROSS JOIN qq CROSS JOIN stats st
    WHERE sc.workspace_id = q.ws AND sc.indexed AND sc.tsv @@ qq.q_ts
      AND (q.kinds IS NULL OR 'source' = ANY(q.kinds))
      AND NOT (sc.id = ANY(q.exclude))
      AND sc.occurred_at > q.t_now - make_interval(years => ${MEMORY_SOURCE_HORIZON_YEARS})
    ORDER BY s DESC, sc.id
    LIMIT ${MEMORY_LEXICAL_CANDIDATES}
  ) t
),
-- The array GIN index generates the candidates, but overlap is satisfied by one shared trigram,
-- so it supplies no selectivity: the cap has to come from the channel itself.
--
-- Jaccard bounds the two set sizes against each other. shared <= LEAST(n_item, n_query) and the
-- union is at least GREATEST(n_item, n_query), so sim <= LEAST/GREATEST for any pair. That makes
-- the size ratio both an exact admissibility test (anything outside it cannot reach the threshold
-- however many trigrams it shares) and the tightest score bound obtainable without touching the
-- arrays - which is what makes it a sound key to take the top candidates by. Recency breaks ties,
-- because that is what the prior prefers among rows the bound cannot separate.
trg_cand AS (
  SELECT i.id, i.trigram_len AS n_trg
  FROM mem.item i CROSS JOIN q
  WHERE ${MEMORY_ITEM_ADMISSIBLE}
    AND cardinality(q.q_trg) > 0
    AND i.trigrams && q.q_trg
    AND i.trigram_len >= $18::float8 * cardinality(q.q_trg)
    AND i.trigram_len * $18::float8 <= cardinality(q.q_trg)
  ORDER BY LEAST(i.trigram_len, cardinality(q.q_trg))::float8
             / GREATEST(i.trigram_len, cardinality(q.q_trg)) DESC,
           i.observed_at DESC, i.id
  LIMIT ${MEMORY_FUZZY_SCAN_CANDIDATES}
),
-- The threshold is what pg_trgm's % operator applies before a row counts as similar at all.
trg_raw AS (
  SELECT c.id,
         x.shared::float8 / NULLIF(c.n_trg + cardinality(q.q_trg) - x.shared, 0) AS sim
  FROM trg_cand c
  JOIN mem.item i ON i.id = c.id
  CROSS JOIN q
  CROSS JOIN LATERAL (
    SELECT count(*) AS shared FROM unnest(i.trigrams) g WHERE g = ANY($3::text[])
  ) x
),
trg AS (
  SELECT id, row_number() OVER (ORDER BY sim DESC, id) AS r FROM (
    SELECT id, sim FROM trg_raw WHERE sim >= $18::float8
    ORDER BY sim DESC, id
    LIMIT ${MEMORY_FUZZY_CANDIDATES}
  ) t
),
-- What this channel admits is structural - a fact about a subject the request named, a procedure
-- carrying one of its tags, a row the owner pinned - but the order inside it is not, and it used to
-- be pure recency fused at 1.30, the heaviest weight of any channel. For a subject with more facts
-- than this ladder is long that decided the whole result: the spread across the structural ladder
-- is wider than the entire lexical channel's, so recency chose which facts came back and the
-- request's own words chose nothing. "which programming language does the owner work in" ranked the
-- one row titled "working languages" eighth of the owner's nine facts, behind five that match only
-- the word "owner", and the per-subject cap then cut it - a hard zero at every k, on a question the
-- store held a titled, single-document-frequency answer to.
--
-- The candidate set is still taken by recency, which is the right bound when a subject has thousands
-- of facts. The fusion rank is taken by how well the row answers the request, over the forty rows
-- that survived - and when none of them match, every score is zero and this is exactly the old
-- order, which is what keeps the channel doing its original job for a request with no lexical grip.
--
-- The forty rungs are dealt round-robin across the three reasons a row is admissible, and inside a
-- turn a row the request's own words match is dealt before one they do not. Both halves are load
-- bearing and each was measured against the other.
--
-- Dealing by turns is what makes a named subject's facts reachable at all. "ORDER BY pr ... LIMIT
-- 40" put every pinned row ahead of every fact, so a workspace with forty pins filled all forty
-- rungs with them - and pin has exactly one production author, the owner's own standing orders,
-- so what the owner told the box crowded out what the box knew about the owner. The per-subject
-- cap below is the larger half of that repair and it is not the whole of it: with the cap moved
-- and this ladder left flat, three of four owner facts come back at sixty pins and the fourth -
-- the one this channel is the only route to - never does, on any request, including one about
-- exactly its subject.
--
-- Dealing by pure recency inside a turn was the cost, and it is why the match test is here. The
-- pin class's share is ceil(40 / populated classes), eighteen of forty with facts and procedures
-- beside it, and eighteen recency rungs are the eighteen newest rules. A rule older than that had
-- only its lexical match left to argue with and lost the per-subject cap to four newer rules the
-- request never went near: asked what the rule about merging to main was, the pack answered with
-- four rules about forbidden things in a checkout. Measured on PGlite, sixty pins with the answer
-- at depth D from the newest, a request sharing four of its eight lexemes with it, both shipped
-- configurations, and in the same run the four owner facts of the case above:
--
--   depth from newest        |  14 |  20 |  31 |  39  | owner facts at 60 pins
--   flat ladder              |  Y  |  Y  |  Y  |  Y   | 3 of 4
--   by turns, recency inside |  Y  |  .  |  .  |  .   | 4 of 4
--   by turns, match first    |  Y  |  Y  |  Y  |  Y   | 4 of 4
--
-- q_ts is the same tsquery the lexical channel probes with and the same GIN index answers it, so
-- this is a boolean the row already knows. It is a test and not a score: ranking the ladder by
-- BM25 would mean scoring every admissible row before the cap, which is the cost the cap exists to
-- avoid. Among rows that match, and among rows that do not, recency still decides - so a request
-- with no lexical grip at all deals exactly the order it dealt before.
struct AS (
  SELECT id, row_number() OVER (ORDER BY pr, s DESC, observed_at DESC, id) AS r FROM (
    SELECT c.id, c.pr, c.observed_at,
           mem.bm25(qq.q_lex, qq.q_idf, c.tsv, c.tsv_len, st.avg_len) AS s
    FROM (
      SELECT l.id, l.observed_at, l.tsv, l.tsv_len, l.pr
      FROM (
        SELECT i.id, i.observed_at, i.tsv, i.tsv_len,
               CASE WHEN i.pin THEN 0 WHEN i.kind = 'fact' THEN 1 ELSE 2 END AS pr,
               row_number() OVER (
                 PARTITION BY CASE WHEN i.pin THEN 0 WHEN i.kind = 'fact' THEN 1 ELSE 2 END
                 ORDER BY COALESCE(i.tsv @@ qq.q_ts, false) DESC, i.observed_at DESC, i.id) AS turn
        FROM mem.item i CROSS JOIN q CROSS JOIN qq
        WHERE ${MEMORY_ITEM_ADMISSIBLE}
          AND (i.pin
               OR (i.kind = 'fact' AND i.subject_key = ANY(q.q_ents))
               OR (i.kind = 'procedure' AND i.tags_hashed && q.q_tags))
      ) l
      ORDER BY l.turn, l.pr, l.observed_at DESC, l.id
      LIMIT ${MEMORY_STRUCTURAL_CANDIDATES}
    ) c CROSS JOIN qq CROSS JOIN stats st
  ) t
),
fused AS (
  SELECT id, SUM(w / (60.0 + r)) AS rrf FROM (
    SELECT id, r, 1.00::float8 AS w FROM lex_item
    UNION ALL SELECT id, r, 0.70 FROM lex_src
    UNION ALL SELECT id, r, 0.40 FROM trg
    UNION ALL SELECT id, r, 1.30 FROM struct
  ) u GROUP BY id
),
scored AS (
  SELECT i.id, 'item'::text AS layer, i.kind, i.trust, i.status, i.observed_at, i.valid_from,
         i.valid_to, i.subject_key, i.predicate, i.tokens_est, i.dedupe_key,
         i.document_ciphertext,
         f.rrf * mem.prior(i.kind, i.trust, i.valid_to, i.observed_at, i.salience, i.pin,
                           q.t_now, q.temporal_intent) AS score
  FROM fused f
  JOIN mem.item i ON i.id = f.id
  CROSS JOIN q
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE r.outcome = 'ok')::float8 AS ok_recent,
           count(*) FILTER (WHERE r.outcome <> 'unknown')::float8 AS graded_recent
    FROM (
      SELECT u.outcome FROM mem.item_use u
      WHERE u.item_id = i.id ORDER BY u.used_at DESC, u.id LIMIT 5
    ) r
  ) health ON TRUE
  WHERE ${MEMORY_ITEM_ADMISSIBLE}
    -- A wrong remembered command is worse than no command: an unverified or failing procedure
    -- stops being injected here, but the row itself is never deleted.
    AND (i.kind <> 'procedure'
         OR (COALESCE(i.last_verified, i.observed_at) > q.t_now - make_interval(days => $16::int)
             AND (health.graded_recent = 0
                  OR health.ok_recent / health.graded_recent >= $17::float8)))
  UNION ALL
  SELECT sc.id, 'source'::text, 'source'::mem.kind, 'stated'::mem.trust, 'active'::mem.status,
         sc.occurred_at, sc.occurred_at, NULL::timestamptz, NULL::text, NULL::text,
         sc.tokens_est, sc.id::text, sc.body_ciphertext,
         f.rrf * mem.prior('source'::mem.kind, 'stated'::mem.trust, NULL::timestamptz,
                           sc.occurred_at, 0::real, FALSE, q.t_now, q.temporal_intent)
  FROM fused f
  JOIN mem.source sc ON sc.id = f.id
  CROSS JOIN q
  WHERE sc.workspace_id = q.ws
),
quota AS (
  SELECT (v->>'kind')::mem.kind AS kind, (v->>'share')::float8 AS share,
         (v->>'cap')::int AS cap, (v->>'perSubject')::int AS per_subject
  FROM jsonb_array_elements($11::jsonb) v
),
-- LEFT JOIN, not JOIN: an inner join here silently deleted every row whose kind had no quota
-- entry, after ranking it: 'entity' was declared in MemoryKind, exported in MEMORY_KINDS and given
-- the first heading in the rendered pack, and could never reach one. A kind the quota table has
-- not heard of now degrades to a small allowance instead of disappearing.
deduped AS (
  SELECT DISTINCT ON (s.dedupe_key) s.*,
         COALESCE(qt.share, $20::float8) AS share,
         COALESCE(qt.cap, $21::int) AS cap,
         COALESCE(qt.per_subject, $22::int) AS per_subject
  FROM scored s LEFT JOIN quota qt ON qt.kind = s.kind
  ORDER BY s.dedupe_key, s.score DESC, s.id
),
-- The per-subject cap is taken FIRST, and that ordering is the whole point of splitting this into
-- two windows. It used to sit beside the kind cap and the share in one WHERE, which meant all
-- three were computed over the same unfiltered "deduped" - so the rows the per-subject cap was
-- about to throw away had already spent the kind's twenty-five ranks and its share of the budget
-- on their way out. One subject with sixty rows therefore cost the fact slot sixty ranks and
-- sixty rows of tokens to seat four, and every other subject was charged for the difference.
--
-- Measured on PGlite, one workspace, four "owner" facts - three sharing a word with the request,
-- one reachable only because the request names its subject - and N pinned "garden" standing
-- orders, asking "which shell does the owner use" (before -> after). Swept at every N from 0 to
-- 70, not sampled: the erosion begins at 37, where the thirty-seventh pin takes the last rung the
-- four facts were sharing, and it is total by 40.
--
--   pinned |  0  |  1  |  4  | 10  | 25  | 36  |  37 |  39 | 40  | 60
--   orders |  0  |  1  |  4  |  4  |  4  |  4  |  4  |  4  |  4  |  4    (their own cap, always)
--   facts  |  4  |  4  |  4  |  4  |  4  |  4  | 3->4| 1->4| 0->4| 0->4
--
-- Swept at every value from 0 to 70 rather than sampled: the fall begins at 37, where the pins take
-- the last rung the four facts were sharing on the ladder above, and it is total by 40. This CTE is
-- the larger half of the repair and not the whole of it - three of those four come back on this
-- ordering alone, and the fourth needs the ladder above to deal by turns as well.
--
-- Retired values keep their own window. Sharing one with live rows meant "which shell did I use
-- before?" - the only question a retired row can answer - lost that row to four unrelated live
-- facts about the same subject, because the prior deliberately discounts a retired row and the
-- cap then cut from the bottom. Retired rows only enter this query when the caller asked for them.
capped AS (
  SELECT ranked.* FROM (
    SELECT d.*,
           row_number() OVER (PARTITION BY d.kind, COALESCE(d.subject_key, d.id::text),
                                           (d.status <> 'active')
                              ORDER BY d.score DESC, d.id) AS subject_rank
    FROM deduped d
  ) ranked
  WHERE ranked.subject_rank <= ranked.per_subject
),
windowed AS (
  SELECT c.*,
         row_number() OVER (PARTITION BY c.kind ORDER BY c.score DESC, c.id) AS kind_rank,
         SUM(c.tokens_est) OVER (PARTITION BY c.kind ORDER BY c.score DESC, c.id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS kind_tokens
  FROM capped c
),
eligible AS (
  SELECT w.* FROM windowed w
  WHERE w.kind_rank <= w.cap
    AND w.kind_tokens <= GREATEST(floor(w.share * $10::int), 1)
),
-- Both cuts are taken in score order. The item limit used to be a trailing LIMIT after the
-- (kind, id) sort, so whenever more rows fitted the budget than the caller asked for, the ones
-- discarded were the alphabetically last - not the least relevant.
budgeted AS (
  SELECT e.*, SUM(e.tokens_est) OVER (ORDER BY e.score DESC, e.id
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running,
         row_number() OVER (ORDER BY e.score DESC, e.id) AS score_rank
  FROM eligible e
)
SELECT id, layer, kind, trust, status, observed_at, valid_from, valid_to, subject_key,
       predicate, tokens_est, score, document_ciphertext
FROM budgeted
WHERE running <= $10::int AND score_rank <= $15::int
-- Stable order by default: the pack sits behind a cache breakpoint and the same rows must render
-- to the same bytes. An interactive recall asks for relevance instead, where "best first" is the
-- whole point and nothing is being cached.
ORDER BY CASE WHEN $19::bool THEN score END DESC NULLS LAST, kind, id`;

/**
 * How many scored rows the diversification window may choose from.
 *
 * Wide enough that the per-conversation cap has something to promote from behind a dominant thread,
 * bounded so a two-word query never sorts the whole verbatim layer.
 */
const MEMORY_SOURCE_SEARCH_CANDIDATES = 200;

/**
 * Rows one conversation may contribute to a result list that spans conversations. Three is a
 * question, its answer and the command that proved it - the shape a turn actually has here.
 */
export const MEMORY_SOURCE_SEARCH_PER_TASK = 3;

/**
 * Verbatim search: the same blind index, the same BM25, restricted to `mem.source`.
 *
 * This is the query behind "search my past conversations". The rows are already here - every turn
 * is chunked, sealed and indexed on the write path - so searching them costs one bounded GIN probe
 * instead of decrypting a workspace's entire history in the worker and matching substrings over it.
 * Stemming, document frequency and field length normalisation all come along for free, which is
 * what makes "restarted" find "restart".
 *
 * The per-conversation cap is what makes a result list worth reading. Turns inside one thread all
 * share its vocabulary, so the top of a raw BM25 list over a transcript is nearly always the same
 * conversation several times over: the question "when did we last change this" gets one answer,
 * repeated, and the other four threads that also touched it never appear. The cap is applied after
 * scoring and only ever moves a row down, so a conversation that genuinely holds the best rows
 * still leads - it just stops holding all of them.
 */
const sourceSearchSql = (
  tier: 'indexed' | 'archived',
  ownerScoped = false,
  projectScoped = false
): string => `
WITH q AS (
  SELECT ${ownerScoped || projectScoped ? 'scope.id' : '$1::uuid'} AS ws, $3::uuid AS task, $4::timestamptz AS since, $5::timestamptz AS until,
         $7::int AS per_task
),
stats AS (
  SELECT GREATEST(COALESCE(c.n_docs, 1), 1)::float8 AS n_docs,
         GREATEST(COALESCE(c.sum_len::float8 / NULLIF(c.n_docs, 0), 1), 1)::float8 AS avg_len
  FROM q LEFT JOIN mem.corpus_stats c ON c.workspace_id = q.ws
),
${MEMORY_TERMS_CTE},
hits AS (
  SELECT sc.id, sc.task_id, mem.bm25(qq.q_lex, qq.q_idf, sc.tsv, sc.tsv_len, st.avg_len) AS s
  FROM mem.source sc CROSS JOIN q CROSS JOIN qq CROSS JOIN stats st
  WHERE sc.workspace_id = q.ws AND ${tier === 'indexed' ? 'sc.indexed' : 'NOT sc.indexed'}
    AND sc.tsv @@ qq.q_ts
    ${
      ownerScoped
        ? `AND sc.user_id = $8 AND EXISTS (
      SELECT 1 FROM tasks t JOIN workspaces tw ON tw.id = t.workspace_id
      WHERE t.id = sc.task_id AND tw.user_id = $8 AND t.workspace_id = ANY($9::uuid[])
    )`
        : ''
    }
    ${projectScoped ? `AND sc.user_id=$8 AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=sc.task_id AND t.user_id=$8 AND t.project_id=$9)` : ''}
    AND (q.task IS NULL OR sc.task_id = q.task)
    AND (q.since IS NULL OR sc.occurred_at >= q.since)
    AND (q.until IS NULL OR sc.occurred_at <= q.until)
  ORDER BY s DESC, sc.id
  LIMIT ${MEMORY_SOURCE_SEARCH_CANDIDATES}
),
-- A row with no task_id is a standalone capture rather than part of a thread, so each one is its
-- own conversation and none of them crowds out another.
spread AS (
  SELECT h.id, h.s,
         row_number() OVER (PARTITION BY COALESCE(h.task_id::text, h.id::text)
                            ORDER BY h.s DESC, h.id) AS thread_rank
  FROM hits h
)
SELECT sc.*, r.s AS score
FROM (
  SELECT id, s FROM spread CROSS JOIN q
  WHERE thread_rank <= q.per_task
  ORDER BY s DESC, id
  LIMIT $6::int
) r JOIN mem.source sc ON sc.id = r.id
ORDER BY r.s DESC, sc.id`;

export const MEMORY_SOURCE_SEARCH_SQL = sourceSearchSql('indexed');

/**
 * One bounded probe per source root, grouped into a single round trip per index key. Current task
 * membership is checked before candidate limits, so inherited history cannot admit sibling tasks.
 * The final page carries only the title/prompt metadata needed to open its current task namespace.
 */
export const OWNER_MEMORY_SOURCE_SEARCH_SQL = `
WITH owner_scope AS (
  SELECT id FROM workspaces WHERE user_id = $8 AND id = ANY($1::uuid[])
), scoped AS (
  SELECT hit.* FROM owner_scope scope
  CROSS JOIN LATERAL (${sourceSearchSql('indexed', true)}) hit
), ranked AS (
  SELECT scoped.*, row_number() OVER (PARTITION BY task_id ORDER BY score DESC, id) AS task_rank
  FROM scoped
)
SELECT r.*, t.workspace_id AS task_workspace_id, t.title AS task_title,
       t.prompt_ciphertext AS task_prompt_ciphertext, t.updated_at AS task_updated_at
FROM ranked r JOIN tasks t ON t.id = r.task_id
JOIN workspaces tw ON tw.id = t.workspace_id
WHERE r.task_rank <= $7 AND tw.user_id = $8 AND t.workspace_id = ANY($9::uuid[])
ORDER BY r.score DESC, r.id LIMIT $6`;

/**
 * The same search, one step further away: over the rows the nightly pass took out of the index.
 *
 * Past its archive horizon a turn leaves the GIN index - which is partial, `WHERE indexed`, so the
 * flag is what frees it - and keeps everything else it was written with: the sealed body, the keyed
 * tokens, and since migration 76 the vector those tokens make. So this statement differs from the
 * one above by exactly one character of predicate, and the whole of the difference between the two
 * tiers is that this one has no index to probe and reads the same `@@` off a scan.
 *
 * A SEPARATE STATEMENT rather than a flag on the one above, and that is a planning decision rather
 * than a stylistic one. The fast path's `sc.indexed AND sc.tsv @@ qq.q_ts` is exactly the predicate
 * the partial GIN index is built for; folding an archive branch into it behind a boolean parameter
 * would put a parameter where the planner needs a constant and risk the ordinary search - every
 * search on this box - losing the index it was written around. Two statements, and the default one
 * is byte-identical to what shipped.
 *
 * WHY THE VECTOR IS KEPT RATHER THAN REBUILT, in numbers, because the other design is the obvious
 * one and it is 12.6x worse. Rebuilding it here with `to_tsvector` over `body_tokens` per row costs
 * 695 ms median on the owner's real corpus against 50 ms for the indexed tier; reading the stored
 * vector on the same rows with the GIN index dropped costs 55 ms. Five milliseconds of that gap was
 * the index and 640 was re-tokenising text that had already been tokenised once, on every miss, for
 * ever. @see docs/design/prime/CLOSE.md.
 *
 * There is no index over archived rows, and that is the tier working rather than a gap in it: the
 * far tier is reached only when the near one answered nothing, one scan is 5 ms dearer than one
 * probe at this corpus's size, and an index that is never the bound is bytes on every write for
 * nothing.
 */
export const MEMORY_SOURCE_ARCHIVE_SEARCH_SQL = sourceSearchSql('archived');

/**
 * The rows either side of a hit.
 *
 * A search result on its own is a fragment: the answer is very often in the reply to the message
 * that matched. A chunked document's siblings all carry `chunk_of` pointing at chunk zero, so
 * `COALESCE(chunk_of, id)` names the document; a turn inside a task is surrounded by the rest of
 * that task's transcript. Both are the same ordered stream, so one window serves both.
 */
export const MEMORY_SOURCE_WINDOW_SQL = `
WITH anchor AS (
  SELECT * FROM mem.source WHERE workspace_id = $1::uuid AND id = $2::uuid
),
neighbours AS (
  SELECT s.*, row_number() OVER (ORDER BY s.occurred_at, s.chunk_ix, s.id) AS rn
  FROM mem.source s CROSS JOIN anchor a
  WHERE s.workspace_id = a.workspace_id
    AND (COALESCE(s.chunk_of, s.id) = COALESCE(a.chunk_of, a.id)
         OR (a.task_id IS NOT NULL AND s.task_id = a.task_id))
),
pivot AS (
  SELECT n.rn FROM neighbours n CROSS JOIN anchor a WHERE n.id = a.id
)
SELECT n.* FROM neighbours n CROSS JOIN pivot p
WHERE n.rn BETWEEN p.rn - $3::int AND p.rn + $4::int
ORDER BY n.rn`;

/**
 * The owner block's bound, in bytes of the owner's own UTF-8 text.
 *
 * Derived the way the tier beside it derived its row count - from what the evidence supports and
 * then doubled past it. A reading of 673 owner-typed turns produced five sentences and 727 bytes;
 * 2,000 is 2.75x the widest defensible draft, and it is still one screen. A block nobody reads to
 * the end is a block nobody spots a wrong line in, which is the failure this number is chosen
 * against rather than storage.
 *
 * It is stated here rather than in `@garden/core` because the statement below and the CHECK in
 * migration 73 are the two places it is enforced, and a bound that lives a package away from both
 * of them is a bound that can drift from the thing enforcing it. `owner-block.test.ts` holds the
 * three copies - this constant, the migration, and the route's message - to one number.
 */
export const OWNER_BLOCK_MAX_BYTES = 2_000;

/**
 * The block, and its byte length taken from the ciphertext rather than from a column.
 *
 * `octet_length(decode(...))` is exact: AES-256-GCM's ciphertext is the same length as its
 * plaintext, so this is the size of the owner's text to the byte without anything here holding a
 * key. That is what lets a caller report "1,240 of 2,000" - and what lets the bound be a CHECK
 * rather than a counter somebody has to keep honest.
 */
export const OWNER_BLOCK_READ_SQL = `
SELECT user_id,
       ciphertext,
       version,
       octet_length(decode(ciphertext->>'ciphertext','base64')) AS content_bytes,
       created_at,
       updated_at
FROM owner_blocks
WHERE user_id = $1::uuid`;

/**
 * One statement for the first write and every rewrite, refusing on a stale version.
 *
 * The `WHERE` on the conflict arm is the owner's own concurrency: a second settings tab that loaded
 * the block before the first one saved holds the older version, its update matches nothing, and
 * `RETURNING` yields no row - so the caller is told the block moved instead of silently discarding
 * what the other tab wrote. A first write states version 0, finds no row to conflict with, and
 * inserts.
 *
 * There is no eviction arm and no truncation arm, because there is nothing here to evict: the
 * bound is a property of the one value being written, enforced by the CHECK this statement writes
 * through. A refused write leaves the stored bytes exactly as they were.
 */
export const OWNER_BLOCK_WRITE_SQL = `
INSERT INTO owner_blocks(user_id, ciphertext, version)
SELECT $1::uuid, $2::jsonb, 1
WHERE $3::int = 0
   OR EXISTS (SELECT 1 FROM owner_blocks WHERE user_id=$1::uuid AND version=$3::int)
ON CONFLICT (user_id) DO UPDATE
  SET ciphertext = EXCLUDED.ciphertext,
      version = owner_blocks.version + 1,
      updated_at = NOW()
  WHERE owner_blocks.version = $3::int
RETURNING user_id,
          ciphertext,
          version,
          octet_length(decode(ciphertext->>'ciphertext','base64')) AS content_bytes,
          created_at,
          updated_at`;

/** Project membership is applied before ranking; no second document index is needed. */
export const projectMemorySourceSearchSql = (tier: 'indexed' | 'archived') => `
WITH project_scope AS (
  SELECT DISTINCT s.workspace_id AS id FROM tasks t JOIN mem.source s ON s.task_id=t.id
  WHERE t.project_id=$9 AND t.user_id=$8 AND s.user_id=$8 AND $1::uuid IS NOT NULL
), hits AS (
  SELECT hit.* FROM project_scope scope CROSS JOIN LATERAL (${sourceSearchSql(tier, false, true)}) hit
) SELECT * FROM hits ORDER BY score DESC,id LIMIT $6`;
