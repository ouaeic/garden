import {
  OUTCOME_ANSWER_CHARS,
  OUTCOME_FILES,
  OUTCOME_HEADLINE_CHARS,
  OUTCOME_ITEM_CHARS,
  OUTCOME_ITEMS,
  OUTCOME_PREVIEWS,
  VERDICT_LABELS,
  type TaskOutcome
} from '@garden/contracts';
import { decryptJson, unwrapDataKey, type EncryptedEnvelope } from '@garden/core';
import type { WorkspacePreviewRecord } from '@garden/data';
import { z } from 'zod';
import { revealedTaskEvent } from './context.js';
import type { RouteContext } from './http/server-context.js';

/** The reply with its closing block taken out, and what that block said. */
export interface Verdict {
  readonly body: string;
  readonly checked: string[];
  readonly yourCall: string[];
}

type VerdictKind = 'checked' | 'yourCall';

const escaped = (label: string): string =>
  label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const LABEL = `(${escaped(VERDICT_LABELS.checked)}|${escaped(VERDICT_LABELS.yourCall)})`;
/*
 * Never two whitespace runs side by side with only optional text between them. These run over
 * model output, and a line of spaces after a label word would otherwise be tried at every split
 * point of the run.
 */
const OPEN = '(?:[*_]{1,3}\\s*)?';
const CLOSE = '(?:\\s*[*_]{1,3})?';
const LEAD = '^\\s*(?:>\\s*)*';
const MARKER = '(?:(?:[-*+•]|\\d{1,3}[.)])\\s+)?';
const HEADING = '(?:#{1,6}\\s+)?';
/** A label opening its line, inline or over a list: plain, bold on either side of the colon, in a heading, a bullet or a quote. */
const LABEL_LINE = new RegExp(
  `${LEAD}${MARKER}${HEADING}${OPEN}${LABEL}${CLOSE}\\s*(?::|[—–-](?=\\s))\\s*${OPEN}(.*)$`,
  'i'
);
/** The bare word with nothing after it, which only reads as a label over a list. */
const LABEL_ALONE = new RegExp(`${LEAD}${HEADING}${OPEN}${LABEL}${CLOSE}\\s*$`, 'i');
/** The other label, further along a line that opened with one. */
const LABEL_WITHIN = new RegExp(
  `(?<![^\\s;·•|])${OPEN}${LABEL}${CLOSE}\\s*:\\s*(?:[*_]{1,3})?`,
  'gi'
);
const BULLET = /^\s*(?:>\s*)*(?:[-*+•]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;
const BLANK = /^\s*$/;
const INDENTED = /^(?:\s{2,}|\t)\S/;
const FENCE = /^\s*(?:```|~~~)/;
/** What a model writes when it should have left the line out. */
const PLACEHOLDER =
  /^(?:none|n\/?a|nothing(?:\s+(?:to\s+(?:decide|confirm|check)|else))?|[—–-])\.?$/i;

const kindOf = (label: string): VerdictKind =>
  label.replace(/\s+/g, ' ').toLowerCase() === VERDICT_LABELS.checked.toLowerCase()
    ? 'checked'
    : 'yourCall';

/** Plain, one-line text: no controls, no runs of whitespace. */
const oneLine = (value: string): string =>
  value
    // eslint-disable-next-line no-control-regex -- Replace ASCII controls before a line is shown.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Cut at a word where one is near, never inside a surrogate pair, and say that it was cut. */
export const bounded = (value: string, max: number): string => {
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.search(/\s\S*$/);
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
};

const unwrapped = (value: string): string =>
  value
    .replace(/^(\*\*|__)(.+)\1$/, '$2')
    .replace(/(?:\*{1,3}|_{2,3})$/, '')
    .trim();

const item = (value: string): string | null => {
  const text = oneLine(unwrapped(oneLine(value))).replace(/[;,]$/, '');
  return text && !PLACEHOLDER.test(text) ? bounded(text, OUTCOME_ITEM_CHARS) : null;
};

/** One label line, read as the section, or the two sections, it opens. */
const labelsOn = (
  line: string
): Array<{ kind: VerdictKind; inline: string; alone: boolean }> | undefined => {
  const alone = LABEL_ALONE.exec(line);
  if (alone) return [{ kind: kindOf(alone[1]!), inline: '', alone: true }];
  const opened = LABEL_LINE.exec(line);
  if (!opened) return undefined;
  const kind = kindOf(opened[1]!);
  const rest = opened[2] ?? '';
  for (const other of rest.matchAll(LABEL_WITHIN)) {
    if (kindOf(other[1]!) === kind) continue;
    const at = other.index;
    return [
      { kind, inline: rest.slice(0, at), alone: false },
      { kind: kindOf(other[1]!), inline: rest.slice(at + other[0].length), alone: false }
    ];
  }
  return [{ kind, inline: rest, alone: false }];
};

const isBlockContent = (line: string): boolean =>
  BLANK.test(line) || (!RULE.test(line) && (BULLET.test(line) || INDENTED.test(line)));

/**
 * Takes the closing verdict off a reply: `Checked:` and `Your call:` lines, in either order.
 *
 * Read only at the end, because that is where the contract asks for them and because the word on
 * its own proves nothing: a reply that says "Checked: the config" and then carries on was not
 * closing. A section is an inline line (`Checked: a; b`, items split on `;` or ` · `), a label over
 * a list, or both; bold, heading, bullet and quote markers around the label are all read as one.
 * Anything that does not parse is left in the body, which costs a reader nothing they had before.
 */
export const splitVerdict = (markdown: string): Verdict => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  while (end > 0 && BLANK.test(lines[end - 1]!)) end -= 1;
  const found: Array<{ kind: VerdictKind; items: string[] }> = [];
  let start = end;
  let cursor = end;
  while (found.length < 2) {
    let at = cursor - 1;
    let labels: ReturnType<typeof labelsOn> = undefined;
    for (; at >= 0; at -= 1) {
      labels = labelsOn(lines[at]!);
      if (labels || !isBlockContent(lines[at]!)) break;
    }
    if (!labels) break;
    // One section of each kind: an earlier line of a kind already read belongs to the answer.
    if (labels.some((label) => found.some((section) => section.kind === label.kind))) break;
    const listed: string[] = [];
    let bullets = 0;
    for (const line of lines.slice(at + 1, cursor)) {
      if (BLANK.test(line)) continue;
      const bullet = BULLET.exec(line);
      if (bullet) {
        listed.push(bullet[1]!);
        bullets += 1;
      } else if (listed.length) listed[listed.length - 1] += ` ${line.trim()}`;
      else listed.push(line.trim());
    }
    const last = labels.at(-1)!;
    if (last.alone && !bullets) break;
    found.unshift(
      ...labels.map((label) => ({
        kind: label.kind,
        items: [
          // Collapsed first, so each separator's spaces are one character and the split is linear.
          ...oneLine(label.inline).split(/ ?; ?| [·•|](?: |$)/),
          ...(label === last ? listed : [])
        ].flatMap((value) => item(value) ?? [])
      }))
    );
    start = at;
    cursor = at;
    while (cursor > 0 && BLANK.test(lines[cursor - 1]!)) cursor -= 1;
  }
  const kept = lines.slice(0, start);
  if (found.length)
    while (kept.length && (BLANK.test(kept.at(-1)!) || RULE.test(kept.at(-1)!))) kept.pop();
  const listOf = (kind: VerdictKind): string[] =>
    (found.find((section) => section.kind === kind)?.items ?? []).slice(0, OUTCOME_ITEMS);
  return {
    body: kept.join('\n').trim(),
    checked: listOf('checked'),
    yourCall: listOf('yourCall')
  };
};

/** Emphasis is only taken off in pairs, so `__init__.py` and `snake_case` keep their underscores. */
const plainText = (value: string): string =>
  oneLine(
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`+/g, '')
      .replace(/(\*\*|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '$1')
      .replace(/(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/g, '$1')
  );

const HEADLINE_SCAN_CHARS = 10 * OUTCOME_HEADLINE_CHARS;

/** The reply's first sentence, as plain text, from its first line that has any. */
export const outcomeHeadline = (markdown: string): string | null => {
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || RULE.test(raw)) continue;
    // Only the start of a line can hold its first sentence, and the pair rules below are not
    // linear over a line of any length.
    const line = plainText(
      raw
        .slice(0, HEADLINE_SCAN_CHARS)
        .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+)?(?:(?:[-*+•]|\d{1,3}[.)])\s+)?(?:\[[ xX]\]\s+)?/, '')
    );
    if (!line) continue;
    const sentence = /^(.+?[.!?…]+["'”’)\]]*)(?=\s|$)/.exec(line)?.[1] ?? line;
    return bounded(sentence, OUTCOME_HEADLINE_CHARS);
  }
  return null;
};

/** A reply cut to what a result card holds, controls other than line breaks and tabs removed. */
const answerText = (body: string): string | null => {
  // eslint-disable-next-line no-control-regex -- Keep line structure; drop every other control.
  const text = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text ? bounded(text, OUTCOME_ANSWER_CHARS) : null;
};

/**
 * A sealed body larger than this is not opened by a list read, the bound the presentation holds
 * one event to. The conversation itself still shows it; a page of outcomes must not cost what
 * reading every transcript on it would.
 */
export const OUTCOME_PAYLOAD_BYTES = 256 * 1024;
/** Publication receipts read per conversation; more than the outcome shows, so revoked ones can drop out. */
const PREVIEW_RECEIPTS = 16;
/** Artifact rows read per workspace; enough to find the newest few sources past repeated versions. */
const ARTIFACT_ROWS = 64;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const envelope = (value: unknown): EncryptedEnvelope =>
  (typeof value === 'string' ? JSON.parse(value) : value) as EncryptedEnvelope;
/**
 * Converted the way the store converts every event's `createdAt`, through the Date's own string,
 * which keeps whole seconds: so `at` is the same string the transcript gives the event it names.
 */
const isoOf = (value: unknown): string | null => {
  const at = value instanceof Date || typeof value === 'string' ? new Date(String(value)) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
};

/** Opens one sealed value, or answers undefined for one this server's keys no longer open. */
const opened = <T>(sealed: unknown, key: Uint8Array | undefined, aad: string): T | undefined => {
  if (!key || sealed === null || sealed === undefined) return undefined;
  try {
    return decryptJson<T>(envelope(sealed), key, aad);
  } catch {
    return undefined;
  }
};

const OutcomeRow = z.object({
  id: z.string(),
  workspace_id: z.string(),
  wrapped_key: z.string(),
  source_workspace_id: z.string().nullable(),
  source_wrapped_key: z.string().nullable(),
  has_artifacts: z.boolean(),
  completed_sequence: z.number().nullable(),
  completed_at: z.unknown(),
  completed_summary: z.string().nullable(),
  completed_current: z.boolean().nullable(),
  completed_ciphertext: z.unknown(),
  message_sequence: z.number().nullable(),
  message_at: z.unknown(),
  message_summary: z.string().nullable(),
  message_current: z.boolean().nullable(),
  message_ciphertext: z.unknown(),
  preview_receipts: z.unknown()
});

/**
 * One statement for every conversation asked about, reading only the newest few events of each.
 *
 * The reply is the newest `completed` event's answer, or the newest `assistant_message` when no
 * tool call or plan came after it - words written beside a call are a note on the way, not the
 * result, and once the newest message is one of those every older one is too. Both are taken only
 * from the current direction: a reply older than the owner's newest message answered something
 * else, and a completion from there over work running now would read as an ending that has not
 * happened. The completion wins when it is the newer of the two, as it does on the goal itself,
 * because it carries the answer the turn finished with even when that answer was never a bubble of
 * its own. The message's body is read only when the completion cannot answer.
 *
 * Every lookup walks back from the newest event or forward from one near it, so a finished goal
 * costs a few index probes however long its history. The `NOT IN` clauses repeat the partial
 * index's own predicate so the planner may use it: without them each walk crosses the stream frames
 * too, and a long reply writes hundreds of those.
 */
const OUTCOME_QUERY = `
  SELECT t.id, t.workspace_id, k.wrapped_key,
    sw.id AS source_workspace_id, sk.wrapped_key AS source_wrapped_key,
    EXISTS(SELECT 1 FROM artifacts a WHERE a.task_id=t.id) AS has_artifacts,
    c.sequence AS completed_sequence, c.created_at AS completed_at,
    c.summary AS completed_summary, c.current AS completed_current,
    CASE WHEN c.current AND c.bytes<=$3 THEN c.payload_ciphertext END AS completed_ciphertext,
    m.sequence AS message_sequence, m.created_at AS message_at,
    m.summary AS message_summary, m.current AS message_current,
    CASE WHEN m.current AND (c.sequence IS NULL OR NOT c.current OR m.sequence>c.sequence OR c.bytes>$3)
      AND octet_length(m.payload_ciphertext::text)<=$3 THEN m.payload_ciphertext END AS message_ciphertext,
    p.receipts AS preview_receipts
  FROM tasks t
  JOIN workspace_keys k ON k.workspace_id=t.workspace_id
  LEFT JOIN project_executions x ON x.task_id=t.id AND x.status='ready'
    AND x.source_workspace_id<>t.workspace_id
  LEFT JOIN workspaces sw ON sw.id=x.source_workspace_id AND sw.user_id=t.user_id
  LEFT JOIN workspace_keys sk ON sk.workspace_id=sw.id
  LEFT JOIN LATERAL (
    SELECT e.sequence, e.created_at, left(e.summary,1024) AS summary, e.payload_ciphertext,
      octet_length(COALESCE(e.payload_ciphertext::text,'')) AS bytes,
      NOT EXISTS(SELECT 1 FROM task_events u WHERE u.task_id=t.id AND u.kind='user_message'
        AND u.kind NOT IN ('assistant_delta','assistant_reasoning') AND u.sequence>e.sequence) AS current
    FROM task_events e WHERE e.task_id=t.id AND e.kind='completed'
    ORDER BY e.sequence DESC LIMIT 1
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT e.sequence, e.created_at, left(e.summary,1024) AS summary, e.payload_ciphertext,
      NOT EXISTS(SELECT 1 FROM task_events u WHERE u.task_id=t.id
        AND u.kind IN ('user_message','tool_started','plan')
        AND u.kind NOT IN ('assistant_delta','assistant_reasoning') AND u.sequence>e.sequence) AS current
    FROM task_events e WHERE e.task_id=t.id AND e.kind='assistant_message'
      AND e.kind NOT IN ('assistant_delta','assistant_reasoning')
    ORDER BY e.sequence DESC LIMIT 1
  ) m ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(r.payload_ciphertext ORDER BY r.sequence DESC) AS receipts FROM (
      SELECT e.payload_ciphertext, e.sequence FROM task_events e WHERE e.task_id=t.id AND e.kind='preview'
        AND octet_length(COALESCE(e.payload_ciphertext::text,''))<=$3
      ORDER BY e.sequence DESC LIMIT $4
    ) r
  ) p ON true
  WHERE t.user_id=$1 AND t.id=ANY($2::uuid[])`;

type Reply = {
  markdown: string;
  at: string | null;
  completion?: Record<string, unknown>;
};

const replyOf = (row: z.infer<typeof OutcomeRow>, key: Uint8Array | undefined): Reply | null => {
  const event = `task-event:${row.id}`;
  const completedCurrent = row.completed_sequence !== null && row.completed_current === true;
  const messageCurrent = row.message_sequence !== null && row.message_current === true;
  if (
    completedCurrent &&
    (!messageCurrent || row.completed_sequence! > row.message_sequence!) &&
    row.completed_ciphertext
  ) {
    const sealed = opened<unknown>(row.completed_ciphertext, key, event);
    if (sealed !== undefined) {
      const completion = record(revealedTaskEvent(row.completed_summary ?? '', sealed).payload);
      return {
        markdown: text(completion.answer) || text(completion.summary),
        at: isoOf(row.completed_at),
        completion
      };
    }
  }
  if (!messageCurrent || !row.message_ciphertext) return null;
  const sealed = opened<unknown>(row.message_ciphertext, key, event);
  if (sealed === undefined) return null;
  const revealed = revealedTaskEvent(row.message_summary ?? '', sealed);
  const payload = record(revealed.payload);
  return {
    markdown: text(payload.markdown) || text(payload.text) || revealed.summary,
    at: isoOf(row.message_at)
  };
};

const riskLines = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .flatMap((entry) => {
      const line = typeof entry === 'string' ? oneLine(entry) : '';
      return line ? [bounded(line, OUTCOME_ITEM_CHARS)] : [];
    })
    .slice(0, OUTCOME_ITEMS);

/** The newest version of each source this conversation published, newest first. */
const filesOf = (
  taskId: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  keys: ReadonlyMap<string, Uint8Array>
): TaskOutcome['files'] => {
  const newest = new Map<string, TaskOutcome['files'][number]>();
  for (const row of rows) {
    if (row.taskId !== taskId) continue;
    const workspaceId = String(row.workspaceId);
    const name = text(
      opened<{ name?: unknown }>(
        row.nameCiphertext,
        keys.get(workspaceId),
        `artifact-name:${workspaceId}`
      )?.name
    );
    if (!name) continue;
    const file = {
      id: String(row.id),
      name,
      mimeType: String(row.mimeType),
      sizeBytes: Number(row.sizeBytes),
      version: Number(row.version),
      createdAt: String(row.createdAt)
    };
    // The version counts against the source path, so that is what identifies "the same file" -
    // a display name can be shared by two different files, and can change between versions of one.
    const source = text(row.logicalKey);
    const identity =
      source && source !== 'null' ? `${workspaceId}:${source}` : `name:${workspaceId}:${name}`;
    const held = newest.get(identity);
    if (
      !held ||
      file.version > held.version ||
      (file.version === held.version && file.createdAt > held.createdAt)
    )
      newest.set(identity, file);
  }
  // Stable, and the store already lists newest first, so files stamped in the same second keep
  // the order they were published in.
  return [...newest.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, OUTCOME_FILES);
};

/**
 * What a page of finished goals made and said, for the owner to judge at a glance.
 *
 * Unknown ids and other owners' ids come back as nothing at all, because the statement is scoped
 * to the owner and an absent row has no outcome. Anything sealed under a key this server no longer
 * opens is read as absent rather than failing the page.
 */
export async function readTaskOutcomes(
  context: Pick<RouteContext, 'database' | 'store' | 'masterKey'>,
  userId: string,
  taskIds: readonly string[]
): Promise<TaskOutcome[]> {
  if (!taskIds.length) return [];
  const result = await context.database.query(OUTCOME_QUERY, [
    userId,
    taskIds,
    OUTCOME_PAYLOAD_BYTES,
    PREVIEW_RECEIPTS
  ]);
  const rows = result.rows.map((raw) => OutcomeRow.parse(raw));
  const keyFor = (wrapped: string | null, workspaceId: string | null): Uint8Array | undefined => {
    if (!wrapped || !workspaceId) return undefined;
    try {
      return unwrapDataKey(wrapped, context.masterKey, workspaceId);
    } catch {
      return undefined;
    }
  };
  const keys = new Map<string, Uint8Array>();
  for (const row of rows) {
    const key = keyFor(row.wrapped_key, row.workspace_id);
    if (key) keys.set(row.workspace_id, key);
    const source = keyFor(row.source_wrapped_key, row.source_workspace_id);
    if (source && row.source_workspace_id) keys.set(row.source_workspace_id, source);
  }
  const workspacesOf = (row: (typeof rows)[number]): string[] =>
    row.source_workspace_id ? [row.workspace_id, row.source_workspace_id] : [row.workspace_id];

  const receipts = new Map<string, string[]>();
  for (const row of rows) {
    const ids = (Array.isArray(row.preview_receipts) ? row.preview_receipts : []).flatMap(
      (sealed: unknown) => {
        const payload = opened<unknown>(sealed, keys.get(row.workspace_id), `task-event:${row.id}`);
        const id = text(record(revealedTaskEvent('', payload).payload).previewId);
        return id ? [id] : [];
      }
    );
    if (ids.length) receipts.set(row.id, [...new Set(ids)]);
  }
  const previewWorkspaces = [
    ...new Set(rows.filter((row) => receipts.has(row.id)).flatMap(workspacesOf))
  ];
  const [artifactRows, previewRows] = await Promise.all([
    Promise.all(
      rows.map(async (row) =>
        row.has_artifacts
          ? (
              await Promise.all(
                workspacesOf(row).map((workspaceId) =>
                  context.store.listArtifacts(userId, workspaceId, row.id, ARTIFACT_ROWS)
                )
              )
            ).flat()
          : []
      )
    ),
    Promise.all(
      previewWorkspaces.map((workspaceId) =>
        context.store.listWorkspacePreviews(userId, workspaceId)
      )
    )
  ]);
  const previews = new Map<string, WorkspacePreviewRecord>(
    previewRows.flat().map((preview) => [preview.id, preview])
  );

  const outcomes = new Map<string, TaskOutcome>();
  rows.forEach((row, index) => {
    const reply = replyOf(row, keys.get(row.workspace_id));
    const verdict = splitVerdict(reply?.markdown ?? '');
    const verification = record(reply?.completion?.verification);
    const status = text(verification.status);
    const allowed = new Set(workspacesOf(row));
    outcomes.set(row.id, {
      taskId: row.id,
      answer: answerText(verdict.body),
      headline: outcomeHeadline(verdict.body),
      checked: verdict.checked,
      yourCall: verdict.yourCall,
      verification: reply?.completion && /^[a-z][a-z_]{0,39}$/.test(status) ? status : null,
      risks: reply?.completion ? riskLines(verification.remainingRisks) : [],
      files: filesOf(row.id, artifactRows[index] ?? [], keys),
      previews: (receipts.get(row.id) ?? [])
        .flatMap((id) => {
          const preview = previews.get(id);
          // Only a publication receipt in this conversation ties a preview to it, and a revoked
          // one no longer opens for anybody.
          return preview && preview.status !== 'revoked' && allowed.has(preview.workspaceId)
            ? [
                {
                  id: preview.id,
                  label: preview.label,
                  port: preview.port,
                  createdAt: preview.createdAt
                }
              ]
            : [];
        })
        .slice(0, OUTCOME_PREVIEWS),
      at: reply?.at ?? null
    });
  });
  return taskIds.flatMap((id) => outcomes.get(id) ?? []);
}
