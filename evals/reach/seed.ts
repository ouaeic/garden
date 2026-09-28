/**
 * The store the probes are asked against: PGlite, the real migrations, and the production write
 * path, seeded from the owner's own trajectories.
 *
 * Nothing here models a write. Every row this file causes is written by
 * `apps/worker/src/memory-runtime.ts`'s `recordTurnEpisode` and by `tool-recording.ts`'s `event`,
 * the two functions a finished turn actually reaches - so the chunking, the blind index, the
 * evidence edges, the citation rows and the encryption are the shipped ones, and a change to any of
 * them moves this rig's number without anybody having to remember to update a fake.
 *
 * ── What is seeded ───────────────────────────────────────────────────────────────────────────
 *
 * - **One task per conversation.** A transcript session is a conversation and garden's `tasks` row
 *   is a conversation, so the turns of one session share a task exactly as the turns of one garden
 *   conversation do. It is the harder shape on purpose: with one task per turn the citation edge
 *   would be unambiguous by construction, and this rig would stop measuring the edge that carries
 *   it.
 * - **Every owner turn, all `n` of them**, through `recordTurnEpisode`. Not only the ones that
 *   carry a probe: `mem.lexeme_df` and `mem.corpus_stats` are what the BM25 ranking is computed
 *   against, so seeding only the probe turns would hand every question a corpus in which its own
 *   answer is the only document. The distractors are the point.
 * - **Timeline rows for the probe turns only.** A `tool_result` event for every call the turn made,
 *   which is what `recordToolResult` writes, and then the citation for the one call whose result
 *   holds the gold. Every call and not only the cited one, so the reach has siblings to be wrong
 *   about. The other 500-odd turns' results are left out because nothing can reach an uncited row
 *   by any means - that is the arm's own bound - so writing two gigabytes of them would change no
 *   number and no property.
 *
 * ── The two seams, and why they are switches ─────────────────────────────────────────────────
 *
 * `SeedShape` names the two decisions this file makes that production also makes, so the rig can
 * put each of them back the way it was and watch the number fall. `citations` is
 * `memory-capture.ts`'s: keep the `toolCallId` the completion contract produced, or map the
 * evidence to `item.claim` and drop it, which is what the line did before this wave. `spans` is
 * `memory-runtime.ts:2216`'s: `attachMemoryEvidence` is called with `{sourceId}` and no span, so
 * every span in `mem.evidence` on a running box is NULL - the column the ruling's "exact character
 * range" claim rests on is written by nothing. Both are seeded through the production writer either
 * way; the switch only decides what is handed to it.
 */
import { randomUUID } from 'node:crypto';

import {
  buildConversationNameIndex,
  encryptJson,
  memoryIndexKey
} from '../../packages/core/src/index.js';
import {
  createDatabase,
  migrateDatabase,
  type Database
} from '../../packages/data/src/database.js';
import { DataStore } from '../../packages/data/src/store.js';
import type { TaskRecord } from '../../packages/data/src/index.js';
import { recordTurnEpisode } from '../../apps/worker/src/memory-runtime.js';
import { event } from '../../apps/worker/src/tool-recording.js';
import type { OwnerTurn, Probe } from './corpus.js';

/** How the two seams are set for one run. Every field is a production behaviour, not a knob. */
export interface SeedShape {
  /**
   * `kept` is this wave's `memory-capture.ts`; `dropped` is the line it replaced, which mapped the
   * evidence to `item.claim` and let the id go no further.
   */
  readonly citations: 'kept' | 'dropped';
  /**
   * `absent` is what a running box has: `attachMemoryEvidence` is called with no span at all.
   * `exact` is what a correct writer would store - the whole of each chunk it cites, `[0,len)`.
   * `shifted` is that arithmetic done wrong by one character, which is the half-open range read as
   * though it were closed.
   */
  readonly spans: 'absent' | 'exact' | 'shifted';
  /**
   * Which of a turn's calls the finish cites. `gold` cites the one call whose result answers the
   * probe, which is what a finish citing the call that justified its claim does. `all` cites every
   * call the turn made, which is the heaviest citation load the episode cap allows and divides one
   * reach's character budget between them.
   */
  readonly cite: 'gold' | 'all';
}

export const DEFAULT_SEED_SHAPE: SeedShape = { citations: 'kept', spans: 'absent', cite: 'gold' };

/**
 * A fixed workspace key, where a running box mints a random one.
 *
 * Not a shortcut: `memoryIndexKey` derives the blind index's keyed lexemes from this, so a random
 * key means a different keyed vocabulary, different document-frequency ties and a different BM25
 * order every run. Measured with `generateDataKey()`, two runs of the fall table over the SAME
 * frozen 146 probes differed by 1.3 points on the headline - which is a rig that cannot hold a
 * baseline to a point, and cannot say whether a change moved anything. The key decides only how
 * lexemes are keyed and how bodies are sealed; nothing measured here depends on its being secret,
 * and `memory-eval.test.ts` fixes it for the same reason.
 */
export const SEED_DATA_KEY = Buffer.alloc(32, 0x7a);

/**
 * The clock every ranking is anchored to: one day after the newest turn in the corpus.
 *
 * Derived from the corpus rather than from `Date.now()`, so a run tomorrow ranks the same rows the
 * same way. One day after, rather than at, the newest turn, because `asOf` is compared against
 * `valid_from` and a turn recorded at the anchor instant is on the boundary of its own validity.
 */
export const clockAnchorFor = (turns: readonly OwnerTurn[]): Date => {
  const newest = turns.reduce(
    (latest, turn) => Math.max(latest, Date.parse(turn.occurredAt) || 0),
    0
  );
  return new Date((newest || Date.now()) + 86_400_000);
};

export interface SeededStore {
  readonly database: Database;
  readonly store: DataStore;
  readonly userId: string;
  readonly workspaceId: string;
  readonly dataKey: Buffer;
  /** The instant every ranking in this run is anchored to. Corpus-derived, so it is reproducible. */
  readonly clockAnchor: Date;
  /** The task each conversation was seeded into, by conversation path. */
  readonly taskOf: ReadonlyMap<string, TaskRecord>;
  /**
   * What the write path minted for each probe's turn, by turn uuid: the episode a reach would have
   * to name, and the verbatim rows a search would have to find. Read off `recordTurnEpisode`'s own
   * return value rather than looked up afterwards, so the gold is whatever production wrote.
   */
  readonly episodeOf: ReadonlyMap<string, { episodeId: string; sourceIds: readonly string[] }>;
  /** How many timeline rows and citation rows the seed wrote, so an empty seed cannot pass. */
  readonly toolResultEvents: number;
  readonly citedCalls: number;
  readonly episodes: number;
}

export const seedStore = async (
  turns: readonly OwnerTurn[],
  probes: readonly Probe[],
  shape: SeedShape = DEFAULT_SEED_SHAPE
): Promise<SeededStore> => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(database);
  const store = new DataStore(database);
  const dataKey = SEED_DATA_KEY;
  const clockAnchor = clockAnchorFor(turns);
  const indexKey = memoryIndexKey(dataKey);
  const user = await store.createUser({ username: 'reach-owner', displayName: 'Owner' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'computer',
    storageLimitBytes: 10 * 1024 ** 3,
    imageRevision: 'dev',
    region: 'auto',
    wrappedKey: 'wrapped'
  });

  const probeOfTurn = new Map(probes.map((probe) => [probe.turnUuid, probe]));
  const taskOf = new Map<string, TaskRecord>();
  const episodeOf = new Map<string, { episodeId: string; sourceIds: readonly string[] }>();
  let toolResultEvents = 0;
  let citedCalls = 0;
  let episodes = 0;

  for (const turn of turns) {
    let task = taskOf.get(turn.conversation);
    if (!task) {
      task = await store.createTask({
        userId: user.id,
        workspaceId: workspace.id,
        titleCiphertext: encryptJson(
          { title: 'conversation' },
          dataKey,
          `task-title:${randomUUID()}`
        ),
        nameIndex: buildConversationNameIndex('conversation', turn.request, indexKey),
        modelId: 'reach-eval',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        promptCiphertext: encryptJson({ prompt: turn.request }, dataKey, 'task-prompt:reach')
      });
      taskOf.set(turn.conversation, task);
    }

    const probe = probeOfTurn.get(turn.uuid);
    const cited: { toolCallId: string; eventId: string }[] = [];
    if (probe)
      for (const call of turn.calls) {
        if (!call.resultText) continue;
        // The write `recordToolResult` performs, in the shape it performs it: the raw result under
        // the call's own id, on the conversation's timeline, sealed with the task's own context.
        const row = await event(store, task, dataKey, 'tool_result', `${call.name} completed`, {
          toolCallId: call.id,
          result: call.resultText
        });
        toolResultEvents += 1;
        const isCited = shape.cite === 'all' || call.id === probe.citedCallId;
        if (isCited && shape.citations === 'kept')
          cited.push({ toolCallId: call.id, eventId: row.id });
      }

    const occurredAt = new Date(turn.occurredAt || Date.now());
    const written = await recordTurnEpisode({
      store,
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      dataKey,
      request: turn.request,
      summary: turn.summary,
      outcome: 'ok',
      // What a finish's evidence renders into the episode body. The claim is the summary's own
      // first line, which is what `completionVerification` defaults a bare id's claim to.
      verifiedClaims: probe ? [turn.summary.split('\n')[0]?.slice(0, 200) ?? ''] : [],
      artifacts: [],
      ...(cited.length ? { citedCalls: cited } : {}),
      /*
       * Untainted, deliberately and uniformly.
       *
       * A tainted episode's reach comes back inside an `untrusted` envelope carrying an origin, and
       * the material is in it either way - so taint decides how the bytes are fenced, never whether
       * they arrive. Seeding every turn the same way keeps one variable out of a number that is
       * about reach, and the fencing has its own bound in `memory-runtime.test.ts`.
       */
      tainted: false,
      occurredAt
    });
    if (!written) continue;
    episodes += 1;
    citedCalls += cited.length;
    if (probe)
      episodeOf.set(turn.uuid, {
        episodeId: written.episodeId,
        sourceIds: [...written.sourceIds]
      });

    if (shape.spans !== 'absent' && written.sourceIds.length > 0) {
      /*
       * The span `attachMemoryEvidence` accepts and nothing passes.
       *
       * `recordTurnEpisode` calls it with `{sourceId}` alone, so on a running box every row of
       * `mem.evidence` has a NULL span and `spanOfBody` returns the whole chunk on every reach.
       * Written here so the arithmetic that reads it has something to be right or wrong about.
       */
      const parts = [
        { role: 'owner', body: turn.request.trim() },
        { role: 'agent', body: turn.summary.trim() }
      ];
      const bodies = parts.flatMap((part) => (part.body ? [part.body] : []));
      const spans = written.sourceIds.map((sourceId, index) => {
        const body = bodies[Math.min(index, bodies.length - 1)] ?? '';
        const length = Math.max(1, Math.min(body.length, 6_000));
        // `int4range` is half-open, so `[0,length)` is the whole row. `shifted` is that same range
        // read as though it were closed - one past the start, one past the end.
        const start = shape.spans === 'shifted' ? 1 : 0;
        return { sourceId, span: [start, length + start] as [number, number] };
      });
      await store.attachMemoryEvidence(written.episodeId, spans);
    }
  }

  return {
    database,
    store,
    userId: user.id,
    workspaceId: workspace.id,
    dataKey,
    clockAnchor,
    taskOf,
    episodeOf,
    toolResultEvents,
    citedCalls,
    episodes
  };
};
