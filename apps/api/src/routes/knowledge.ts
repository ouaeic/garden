/**
 * What the agent is allowed to remember and what it has been taught.
 *
 * Memories, the agent's own written-down items, the review queue, and skills. Everything written
 * through here passes `KnowledgeText` first: normalised, stripped of hidden control and
 * bidirectional characters, and refused outright if it looks like a credential - a memory is read
 * back to a model as instructions, so it is the one input where a hidden direction would be
 * obeyed rather than displayed.
 */

import { createHmac } from 'node:crypto';
import {
  GardenError,
  assertMemoryValidity,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  memoryExcerpt,
  memoryIndexKey,
  planMemoryQuery,
  memoryTemporalStatus,
  ownerBlockAad,
  userMemoryAad,
  OWNER_MEMORY_MAX_CHARS,
  OWNER_MEMORY_MAX_ROWS,
  WORKSPACE_MEMORY_MAX_CHARS
} from '@garden/core';
import type { MemoryDocument } from '@garden/core';
import { OWNER_BLOCK_MAX_BYTES } from '@garden/data';
import type { MemoryItemBody } from '@garden/contracts';
import type {
  MemoryFactCandidateRecord,
  MemoryItemRecord,
  OwnerBlockRecord,
  WorkspaceMemoryRecord
} from '@garden/data';
import { z } from 'zod';
import { UNREADABLE_MEMORY_ITEM } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

/**
 * A credential in the text, refused rather than stored.
 *
 * This gate is the whole of the content check on the one tier that follows the owner out of the
 * workspace, and it was reading the LABEL rather than the secret. `api[_ -]?key\s*[:=]` wants the
 * word and the punctuation adjacent, so `Here is the API key: sk-…` was refused and `Here is my
 * openrouter key: sk-…` was not - same secret, same sentence, one word apart. Measured over the
 * owner's own 924 typed turns on this machine (`type: user`, not `isSidechain`, not a tool result,
 * not `isMeta` with a `sourceToolUseID`, no slash-command or compaction-continuation block,
 * deduplicated by turn uuid; 3,097 transcript files, 2,093,092 characters, 10 projects): 8 of them
 * carry a live 73-character `sk-or-v1-…` token, and the old rule refused 2. The capture path into
 * the workspace tier already neutralises all 8, because `redactText` matches the token; the tier
 * that outlives the workspace was the one letting them through.
 *
 * The count is stated because an earlier pass of this work stated 505 turns and 197,466 characters
 * and neither reproduces - the character figure by a factor of ten. Two independent recounts on the
 * stated filter agree on the order and on every exclusion count that matters (24,124 tool results),
 * so the basis here is the recounted one and the ratio arguments built on the old one are withdrawn
 * rather than repeated.
 *
 * So the vendor rule below reads the token: a recognised issuer prefix, ITS OWN delimiter, and
 * somewhere after it a run of sixteen characters with no delimiter in it. Both halves are load
 * bearing and each was measured against the other.
 *
 * The delimiter is what `redactText` does not require, and reusing that net here was the one-line
 * fix. It takes the prefix plus ten more characters of anything, which is right for a log line and
 * wrong for a refusal: it alters `skateboarding` and `pkgconfig`, and a tier the owner cannot write
 * the word "skateboarding" into is not a tier they will use.
 *
 * The run is what a length threshold cannot say. A threshold has to be picked, and the number
 * decides which names are refused while saying nothing about what a secret is - at twelve more
 * characters it already refuses `sk-learn-classifier-v2`, and every larger number is a guess about
 * how long a name gets. The run states the property itself, that a random token has a long
 * undelimited stretch and a hyphenated name does not, and it is indifferent to the total length:
 * `glpat-` with a twenty-character body and `sk-or-v1-` with seventy are the same clause.
 *
 * Against the same 924 turns, the four shapes together refuse all 8 secret-bearing turns and 0 of
 * the other 916.
 *
 * The labelled rule is kept beneath them, because a secret with no recognisable prefix has nothing
 * else to be caught by, and `password = …` is exactly that shape. Its PEM clause names the key
 * types `[A-Z ]*` rather than three of them, which is what `redaction.ts:48` on the capture path
 * has always matched: the narrower list admitted `-----BEGIN ENCRYPTED PRIVATE KEY-----` and
 * `-----BEGIN DSA PRIVATE KEY-----` into the one tier that leaves the workspace while the capture
 * path into the workspace redacted both, which is the property this gate exists to restore
 * inverted. Measured on the 924 turns: the widened clause fires on the same 0 of them.
 *
 * STILL OPEN, named rather than papered over. `Authorization: Basic …` is redacted on the capture
 * path (`Bearer|Basic|Token` there) and admitted here, and the naive port of that rule refuses
 * `Always send the Bearer token that the vault issues` - the owner's own shape - so it needs a
 * measurement this gate did not have room to make. A standing order carrying an exfiltration
 * address is not a credential and is not this rule's business; it is the one thing this tier reads
 * into every task in every workspace, and it has no content control at all. @see
 * docs/design/finish/GATE.md.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk_live|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs]|glpat|dop_v1|sq0csp)[-_][-_.A-Za-z0-9]*[A-Za-z0-9]{16,}/i,
  // Issuers whose tokens are a fixed shape rather than a prefix and a body: AWS key identifiers,
  // Google API keys, and any JSON web token whoever signed it.
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // A password written into a URL, which is a complete credential arriving as an ordinary address.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|password|passphrase|secret|token)\s*[:=]\s*\S{12,}/i
];

/**
 * The two content rules, named rather than inlined, because a second surface now needs both.
 *
 * The owner block below is the one text in this system that reaches every request of every task, so
 * it is the last place a hidden direction or a pasted key may be admitted. Copying the two
 * refinements into a second schema would have been two rules that agree today; naming them is one
 * rule with two callers. @see CREDENTIAL_SHAPES for what the second one measures and what it still
 * misses.
 *
 * The Unicode Tags block is the last range here and the one this scan was missing, which made the
 * trusted surface the unguarded one. `sanitise.ts` strips `U+E0000-U+E007F` from every untrusted
 * tool result precisely because it is the invisible-instruction channel - so a model could only
 * emit a tag character by copying one it had read, and what it read had already been cleaned, while
 * a paste from the owner's clipboard crossed no such boundary at all. `British spelling.` carrying
 * `Ignore the safety floor.` in that block is 113 bytes, 17 visible code points, and NFKC leaves it
 * exactly as it arrived. The scan above cannot see it even in principle: `charCodeAt(0)` on an
 * astral character is the high surrogate, 0xDB40 for every character in this range. The one review
 * this block's design rests on is a person reading their own words, and that is the review a
 * character with no glyph defeats by construction.
 */
const carriesHiddenDirection = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  }) || /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u.test(value);

const carriesCredential = (value: string): boolean =>
  CREDENTIAL_SHAPES.some((shape) => shape.test(value));

const KnowledgeText = z
  .string()
  .trim()
  .min(1)
  .max(24_000)
  .transform((value) => value.normalize('NFKC'))
  .refine(
    (value) => !carriesHiddenDirection(value),
    'Hidden control and bidirectional text are not allowed'
  )
  .refine((value) => !carriesCredential(value), 'Keep credentials out of memory and skills');

/**
 * The owner block's text, which differs from `KnowledgeText` in exactly two ways.
 *
 * Empty is allowed, because emptying the block is a thing the owner is entitled to do and a
 * schema that refused it would make "clear this" reachable only by deleting a row from a screen
 * that has no row on it.
 *
 * The character cap is deliberately well ABOVE the byte bound rather than equal to it, and getting
 * that wrong is what this comment is for. Set to the bound's own number it fires first on every
 * ordinary overlong draft, and zod's refusal is "one or more request fields are invalid" - so the
 * owner is refused by a schema instead of being told which surface is full and by how much. Its
 * job is only to stop a megabyte of text being normalised and regex-scanned before anything counts
 * it; the bound itself is counted in bytes after NFKC, because normalisation can lengthen a string
 * and a limit checked before it is a limit the database would refuse a second time.
 */
const OwnerBlockText = z
  .string()
  .trim()
  .max(OWNER_BLOCK_MAX_BYTES * 4)
  .transform((value) => value.normalize('NFKC'))
  .refine(
    (value) => !carriesHiddenDirection(value),
    'Hidden control and bidirectional text are not allowed'
  )
  .refine((value) => !carriesCredential(value), 'Keep credentials out of your block');

/**
 * The two constants behind a proposal's handle, written where they can be read.
 *
 * `SEPARATOR` is the NUL escape rather than a literal one, for the reason `memory-runtime.ts`
 * records beside its own: a literal NUL makes the whole source file arrive as `data`, so grep
 * skips it and `git diff` refuses to show it - a file no tool will read is a file nobody reviews.
 * It is a byte none of the three parts can contain, which is what a joining character has to be.
 */
const SEPARATOR = '\u0000';
const PROPOSAL_HANDLE_CONTEXT = 'garden-memory-proposal';

/** Which side of this computer put a row into memory. Three answers, because there are three. */
export type MemoryItemOrigin = 'stated' | 'proposed' | 'watched';

/**
 * The provenance of a stored row, derived at the door because `mem.item` does not carry a column
 * for it.
 *
 * `trust` on its own cannot answer the question the owner is actually asking. It has two values in
 * use and three things write rows, so `derived` means both "a model wrote this sentence" and "the
 * harness ran a command and watched what happened" - the two provenances furthest apart in the
 * whole subsystem and the two an owner most needs told apart. Until this function existed the one
 * list the owner can browse carried neither field, so all three read identically.
 *
 * The mapping is not a guess. Every production writer of `mem.item` on this computer is one of four
 * call sites, and each one fixes both columns outright:
 *
 * - `recordTurnEpisode` writes the finished turn, `kind: 'episode'`, always `derived`.
 * - its verified-command loop writes `kind: 'procedure'`, `derived`.
 * - `recordDeadEnds` in `memory-capture.ts` writes a command it watched fail, also `procedure`,
 *   `derived`.
 * - `recordTurnEpisode`'s promotion mints a corroborated candidate at `kind: 'fact'`, `stated` when
 *   the candidate's own `origin` was `observed` - the shipped patterns over the owner's own
 *   sentence - and `derived` when it was `proposed`, because then the wording is a model's account
 *   of what the owner said rather than the owner's.
 *
 * Named rather than cited by line: this list is the whole of the argument, and a line number in it
 * would be wrong by the next commit.
 *
 * So `stated` is the owner, a `derived` fact is a model's wording, and everything else `derived` is
 * the harness. `inferred` - the third value in the SQL enum, the tier recall excludes - has no
 * writer on this computer and is not in `MemoryTrust` at all, which is why nothing here branches on
 * it.
 *
 * `watched` and not `observed`, which reads more naturally and is already taken:
 * `mem.fact_candidate.origin` spells the OPPOSITE side of this distinction `observed` - a sentence
 * the patterns lifted out of the owner's own words - and one word for two things in one subsystem
 * is how a field stops being read.
 */
export const memoryItemOrigin = (
  record: Pick<MemoryItemRecord, 'kind' | 'trust'>
): MemoryItemOrigin =>
  record.trust === 'stated' ? 'stated' : record.kind === 'fact' ? 'proposed' : 'watched';

const SkillDocumentInput = z
  .object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: KnowledgeText.pipe(z.string().max(240)),
    content: KnowledgeText
  })
  .superRefine((value, context) => {
    for (const heading of ['When to use', 'Procedure', 'Pitfalls', 'Verification']) {
      if (!new RegExp(`^#{1,3}\\s+${heading}\\s*$`, 'im').test(value.content))
        context.addIssue({
          code: 'custom',
          path: ['content'],
          message: `Skill is missing ${heading}`
        });
    }
  });

export const registerKnowledgeRoutes = (context: RouteContext): void => {
  const { app, store, workspaceKnowledgeKey, ownerKnowledgeKey, idempotent } = context;

  /**
   * Two keys, and the rule for which row opens under which.
   *
   * A memory list spans two scopes. The workspace tier is sealed under the workspace data
   * key with `workspace-memory:${workspaceId}`; the owner tier is sealed under a key derived from
   * the master key and the user, with its own AAD domain. `keyScope` is in the clear precisely so
   * this choice can be made before anything is decrypted rather than by trying one key and
   * catching the failure - a decrypt that fails and a decrypt that opened the wrong row look
   * identical from the outside only when nobody wrote down which key was meant.
   *
   * A `target: 'user'` row written before migration 70 is still `keyScope: 'workspace'` and still
   * opens the old way, so no existing entry changes meaning under its owner. `PATCH` is what
   * promotes one, and it does so with the owner watching.
   */
  const memoryKeyring = async (userId: string, workspaceId: string) => {
    const { key: workspaceKey } = await workspaceKnowledgeKey(userId, workspaceId);
    const ownerKey = ownerKnowledgeKey(userId);
    const open = (record: WorkspaceMemoryRecord): MemoryDocument =>
      record.keyScope === 'user'
        ? decryptJson<MemoryDocument>(record.contentCiphertext, ownerKey, userMemoryAad(userId))
        : decryptJson<MemoryDocument>(
            record.contentCiphertext,
            workspaceKey,
            `workspace-memory:${record.workspaceId ?? workspaceId}`
          );
    return { workspaceKey, ownerKey, open };
  };

  /**
   * What one row looks like on the wire.
   *
   * `scope` is served beside `target` and is not the same fact. `target` is what the owner chose;
   * `scope` is where the row actually lives now. They differ on exactly the rows that were written
   * under the old promise, and a client that shows "About you, everywhere" needs to be able to
   * tell those apart rather than repeating a claim the row cannot keep.
   */
  const memoryResponse = (record: WorkspaceMemoryRecord, document: MemoryDocument) => ({
    id: record.id,
    target: record.target,
    workspaceId: record.workspaceId,
    scope: record.keyScope,
    content: document.content,
    status: memoryTemporalStatus(document),
    validFrom: document.validFrom ?? null,
    validUntil: document.validUntil ?? null,
    source: document.source ?? 'owner',
    sourceTaskId: document.sourceTaskId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });

  /** Characters already spent in one tier, counting only rows that are still in force. */
  const spentCharacters = (
    records: readonly WorkspaceMemoryRecord[],
    open: (record: WorkspaceMemoryRecord) => MemoryDocument,
    target: WorkspaceMemoryRecord['target'],
    exceptId?: string
  ): number =>
    records
      .filter((record) => record.target === target && record.id !== exceptId)
      .reduce((total, record) => {
        const document = open(record);
        return memoryTemporalStatus(document) === 'expired'
          ? total
          : total + document.content.length;
      }, 0);

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/memories',
    async (request) => {
      const user = requireUser(request.user);
      const { open } = await memoryKeyring(user.id, request.params.workspaceId);
      return (await store.listWorkspaceMemories(user.id, request.params.workspaceId)).map(
        (record) => memoryResponse(record, open(record))
      );
    }
  );

  /**
   * Writes a memory, and the only path by which the owner tier can be entered.
   *
   * The gate is what is missing from this handler rather than what is in it: there is no task, no
   * tool call and no agent on this path. It is an authenticated owner session posting a form.
   * `createOwnerMemory` takes no workspace id for the same reason, so a caller that has one - which
   * is every caller inside a running turn - cannot use it. The worker's `memory` tool is refused at
   * the type and again at the store; @see createWorkspaceMemory.
   *
   * Two bounds, and they are not redundant. Characters are checked here because only a holder of
   * both keys can add up what is already stored, and rows are checked inside the insert because a
   * count taken here and an insert issued afterwards are two statements with a gap between them.
   * Both refuse. Neither evicts.
   */
  app.post<{
    Params: { workspaceId: string };
    Body: { target: 'workspace' | 'user'; content: string; validUntil?: string };
  }>('/v1/workspaces/:workspaceId/memories', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        target: z.enum(['workspace', 'user']),
        content: KnowledgeText.pipe(z.string().max(4_000)),
        validUntil: z.string().datetime({ offset: true }).optional()
      })
      .parse(request.body);
    const { workspaceKey, ownerKey, open } = await memoryKeyring(
      user.id,
      request.params.workspaceId
    );
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const limit = input.target === 'user' ? OWNER_MEMORY_MAX_CHARS : WORKSPACE_MEMORY_MAX_CHARS;
    const spent = spentCharacters(records, open, input.target);
    if (spent + input.content.length > limit)
      throw new GardenError(
        'memory_full',
        `${input.target} memory is ${spent}/${limit} characters. Consolidate or remove an entry first.`
      );
    const document: MemoryDocument = {
      content: input.content,
      source: 'owner',
      validFrom: new Date().toISOString(),
      ...(input.validUntil ? { validUntil: input.validUntil } : {})
    };
    assertMemoryValidity(document);
    if (input.target === 'user') {
      const created = await store.createOwnerMemory({
        userId: user.id,
        maxRows: OWNER_MEMORY_MAX_ROWS,
        contentCiphertext: encryptJson(document, ownerKey, userMemoryAad(user.id))
      });
      if (!created)
        throw new GardenError(
          'memory_full',
          `Memory about you holds ${OWNER_MEMORY_MAX_ROWS} entries and all ${OWNER_MEMORY_MAX_ROWS} are in use. Remove one you no longer stand behind before adding another.`
        );
      return memoryResponse(created, document);
    }
    const created = await store.createWorkspaceMemory({
      userId: user.id,
      workspaceId: request.params.workspaceId,
      target: 'workspace',
      contentCiphertext: encryptJson(
        document,
        workspaceKey,
        `workspace-memory:${request.params.workspaceId}`
      )
    });
    return memoryResponse(created, document);
  });

  /**
   * Rewrites one entry, and promotes a legacy owner-tier row on the way through.
   *
   * A `target: 'user'` row written before migration 70 is sealed under a workspace key and dies
   * with that workspace. It cannot be re-sealed by a migration, because migrations hold no key.
   * This is the moment it can be: the owner has both keys in hand, is looking at the row, and is
   * already rewriting its bytes. So an edit to any `target: 'user'` row seals the result under the
   * owner key and clears its workspace id, which is the difference between a promise in a label
   * and a row that keeps it.
   */
  app.patch<{
    Params: { workspaceId: string; memoryId: string };
    Body: { content: string; validUntil?: string | null };
  }>('/v1/workspaces/:workspaceId/memories/:memoryId', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        content: KnowledgeText.pipe(z.string().max(4_000)),
        validUntil: z.string().datetime({ offset: true }).nullable().optional()
      })
      .parse(request.body);
    const { workspaceKey, ownerKey, open } = await memoryKeyring(
      user.id,
      request.params.workspaceId
    );
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const existing = records.find((record) => record.id === request.params.memoryId);
    if (!existing) throw new GardenError('memory_not_found', 'Memory entry not found', 404);
    const existingDocument = open(existing);
    const limit = existing.target === 'user' ? OWNER_MEMORY_MAX_CHARS : WORKSPACE_MEMORY_MAX_CHARS;
    const spent = spentCharacters(records, open, existing.target, existing.id);
    if (spent + input.content.length > limit)
      throw new GardenError('memory_full', 'Replacement would exceed the memory limit');
    const updatedDocument: MemoryDocument = {
      content: input.content,
      source: 'owner',
      validFrom: new Date().toISOString(),
      previousUpdatedAt: existing.updatedAt,
      ...(input.validUntil === null
        ? {}
        : input.validUntil
          ? { validUntil: input.validUntil }
          : existingDocument.validUntil
            ? { validUntil: existingDocument.validUntil }
            : {})
    };
    assertMemoryValidity(updatedDocument);
    const keyScope = existing.target === 'user' ? 'user' : 'workspace';
    /*
     * A promotion is an entry to the owner tier and pays the tier's row bound, exactly as an
     * insert does. Only a row that is not already there can pay it, so an ordinary edit to a row
     * the owner has already promoted is not charged twice.
     *
     * Checked here for the message and inside the statement for the guarantee, which is the same
     * division the POST above makes and for the same reason: this count and the write that follows
     * it are two statements with a gap in the middle, and the bound on the one tier that outlives
     * a workspace should not depend on nobody racing it.
     */
    if (keyScope === 'user' && existing.keyScope !== 'user') {
      const held = await store.countOwnerMemories(user.id);
      if (held >= OWNER_MEMORY_MAX_ROWS)
        throw new GardenError(
          'memory_full',
          `Memory about you already holds ${OWNER_MEMORY_MAX_ROWS} entries. Remove one you no longer stand behind before moving this one across.`
        );
    }
    const updated = await store.updateWorkspaceMemory({
      id: existing.id,
      userId: user.id,
      workspaceId: request.params.workspaceId,
      keyScope,
      maxOwnerRows: OWNER_MEMORY_MAX_ROWS,
      contentCiphertext:
        keyScope === 'user'
          ? encryptJson(updatedDocument, ownerKey, userMemoryAad(user.id))
          : encryptJson(
              updatedDocument,
              workspaceKey,
              `workspace-memory:${request.params.workspaceId}`
            )
    });
    if (!updated) throw new GardenError('memory_not_found', 'Memory entry not found', 404);
    return memoryResponse(updated, updatedDocument);
  });

  app.delete<{ Params: { workspaceId: string; memoryId: string } }>(
    '/v1/workspaces/:workspaceId/memories/:memoryId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.deleteWorkspaceMemory(
          user.id,
          request.params.workspaceId,
          request.params.memoryId
        )
      };
    }
  );

  /**
   * The owner's block: one text about the person, and the two routes that reach it.
   *
   * It is not under `/v1/workspaces/:workspaceId` and that is the address doing part of the work.
   * Everything above is about a computer and dies with one; this is about the person and outlives
   * every computer they ever create, so a URL that named a workspace would be a promise the row
   * does not keep - which is exactly the defect migration 70 was written to repair in the tier next
   * door.
   *
   * The gate is what is absent from these two handlers rather than what is in them: no task, no
   * tool call, no agent. `MemoryStore.writeOwnerBlock` cannot be told a workspace or a task at all -
   * both are typed `never` - so the one production caller that runs inside a turn cannot form a
   * call to it, and the worker's window holds a reader and no writer. The agent's route to this
   * text is the review queue and the owner's own hands, which is the only gate strictly stronger
   * than the taint rule: a turn that read somebody else's words nominates nothing here, and neither
   * does a turn that read nobody's.
   */
  const ownerBlockText = (block: OwnerBlockRecord, ownerKey: Buffer): string => {
    try {
      return decryptBytes(block.ciphertext, ownerKey, ownerBlockAad(block.userId)).toString('utf8');
    } catch {
      return '';
    }
  };

  const ownerBlockResponse = (block: OwnerBlockRecord | null, ownerKey: Buffer) => ({
    /*
     * A block this key will not open answers as empty rather than as a failure, and the version
     * beside it is the real one.
     *
     * Only a changed master key can produce that state, and a box in it has bigger problems - but
     * the consequence worth avoiding is specific: a route that threw here would leave the owner
     * looking at an error on the one screen that exists so they can correct what this computer
     * holds about them, with no way to overwrite it. Answering with the true version means their
     * next save replaces it.
     */
    text: block ? ownerBlockText(block, ownerKey) : '',
    bytes: block?.contentBytes ?? 0,
    limit: OWNER_BLOCK_MAX_BYTES,
    // Zero means "there is no block", which is the version a first write states. It is served
    // rather than left for the client to infer, because a client that guessed it would be guessing
    // the one value that decides whether a save overwrites somebody's newer text.
    version: block?.version ?? 0,
    updatedAt: block?.updatedAt ?? null
  });

  app.get('/v1/account/memory-block', async (request) => {
    const user = requireUser(request.user);
    return ownerBlockResponse(await store.readOwnerBlock(user.id), ownerKnowledgeKey(user.id));
  });

  /**
   * Rewrites the whole block, refuses past the bound, and refuses a stale write.
   *
   * REFUSED, never trimmed and never evicted. The workspace tier can afford to drop a row because
   * its rows die with the computer; a sentence the owner typed about themselves that quietly
   * disappeared to make room is something they would never find out had gone. So the message names
   * the number and the surface and leaves the stored bytes exactly as they were - which the store
   * guarantees, because the refusal happens before the statement and the database's own CHECK
   * refuses a caller that got past it.
   *
   * `expectedVersion` is the version the client read. Two settings tabs on one block is not an
   * exotic case - it is what happens when the owner opens settings on their phone and their
   * laptop - and the alternative to a conflict is the older tab silently deleting the newer text.
   */
  app.put<{ Body: { text: string; expectedVersion: number } }>(
    '/v1/account/memory-block',
    async (request) => {
      const user = requireUser(request.user);
      const input = z
        .object({ text: OwnerBlockText, expectedVersion: z.number().int().min(0) })
        .parse(request.body);
      const bytes = Buffer.byteLength(input.text, 'utf8');
      if (bytes > OWNER_BLOCK_MAX_BYTES)
        throw new GardenError(
          'owner_block_full',
          `Your block holds ${OWNER_BLOCK_MAX_BYTES} bytes and this is ${bytes}. Shorten it - nothing here is dropped to make room.`
        );
      const ownerKey = ownerKnowledgeKey(user.id);
      // Empty text remains sealed so clearing cannot recycle a version held by another device.
      const written = await store.writeOwnerBlock({
        userId: user.id,
        ciphertext: encryptBytes(Buffer.from(input.text, 'utf8'), ownerKey, ownerBlockAad(user.id)),
        expectedVersion: input.expectedVersion
      });
      if (!written)
        throw new GardenError(
          'owner_block_conflict',
          'Your block changed somewhere else since this screen loaded. Reload it before saving.',
          409
        );
      return ownerBlockResponse(written, ownerKey);
    }
  );

  /**
   * One line of what a stored row actually says.
   *
   * A row this key will not open is still listed, and says so, exactly as the standing notice log
   * does with a sentence it cannot read. The point of the list is that nothing this computer holds
   * about its owner is invisible to them, and a row dropped for being unreadable would be the one
   * row they would most want to reach.
   */
  const memoryItemExcerpt = (record: MemoryItemRecord, key: Buffer): string => {
    try {
      const document = decryptJson<{ title?: string | null; body: string }>(
        record.documentCiphertext,
        key,
        `memory-item:${record.workspaceId}`
      );
      return memoryExcerpt(document.body, '', { maxChars: 200 }) || (document.title ?? '');
    } catch {
      return UNREADABLE_MEMORY_ITEM;
    }
  };

  /**
   * The whole of one row, which is the half of the promise the excerpt cannot keep.
   *
   * Both lists clamp at 200 characters and both say on screen that they are showing an opening.
   * That is honest and it is not "read the whole of what was remembered about you": the rest is on
   * the owner's own disk, under a key this request already derives, and this is where to ask for
   * it. One row at a time and never in the list, deliberately — a review queue of fifty rows
   * with every body inlined is a megabyte of ciphertext decrypted to answer a question about one of
   * them, and the screen shows two lines until the owner opens something.
   *
   * A row this key will not open answers 200 with `readable: false` and the same standing sentence
   * the lists use, not 500 and not an empty string. The list already shows the row; an expander
   * that came back blank would read as "nothing was remembered here", which is the opposite of what
   * is true, and an error would hide a row the owner would most want to reach. A row that is not in
   * this workspace at all is a 404, which is a different fact and is said differently.
   */
  app.get<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId',
    async (request) => {
      const user = requireUser(request.user);
      const workspaceId = request.params.workspaceId;
      const { key } = await workspaceKnowledgeKey(user.id, workspaceId);
      const record = await store.getMemoryItem(workspaceId, request.params.itemId);
      if (!record) throw new GardenError('memory_item_not_found', 'Memory item not found', 404);
      try {
        const document = decryptJson<{ title?: string | null; body: string }>(
          record.documentCiphertext,
          key,
          `memory-item:${record.workspaceId}`
        );
        return {
          id: record.id,
          title: document.title ?? null,
          body: document.body,
          readable: true
        } satisfies MemoryItemBody;
      } catch {
        return {
          id: record.id,
          title: null,
          body: UNREADABLE_MEMORY_ITEM,
          readable: false
        } satisfies MemoryItemBody;
      }
    }
  );

  /**
   * What the agent has written down for itself.
   *
   * Every turn that finishes files what was asked and what came of it, so this grows on its own and
   * has no natural end: newest first and capped, with the owner asking for more when they want it.
   * Every status is served, including the retired ones - a line the agent has stopped believing is
   * still a line about the owner, still on their disk, and is not hidden here.
   *
   * `trust` and `origin` are served too. Without them the list could not tell a rule the owner
   * typed from a rule a model wrote for them: both arrive as one line of text with a kind and a
   * date, and a model's sentence that has cleared the corroboration gate is pinned into every later
   * task in the workspace. A memory system whose rows are obeyed and whose provenance is invisible
   * is one nobody can audit, so the field the review queue projects is on the list the owner
   * actually browses, beside the three-way answer `trust` alone cannot give.
   */
  app.get<{ Params: { workspaceId: string }; Querystring: Record<string, string> }>(
    '/v1/workspaces/:workspaceId/memory-library',
    async (request) => {
      const user = requireUser(request.user);
      const workspaceId = request.params.workspaceId;
      const { key } = await workspaceKnowledgeKey(user.id, workspaceId);
      const query = z
        .object({
          q: z.string().trim().max(500).optional(),
          scope: z.string().uuid().optional(),
          kind: z.enum(['episode', 'fact', 'procedure']).optional(),
          status: z.enum(['active', 'superseded', 'disputed', 'archived', 'retracted']).optional(),
          cursor: z.string().max(512).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(40)
        })
        .parse(request.query);
      let cursor: { at: string; id: string } | undefined;
      if (query.cursor) {
        try {
          cursor = z
            .object({ at: z.string().datetime(), id: z.string().uuid() })
            .parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString()));
        } catch {
          throw new GardenError('memory_cursor_invalid', 'Invalid memory page', 400);
        }
      }
      const page = await store.listOwnerMemoryItems(user.id, workspaceId, {
        limit: query.limit,
        ...(query.scope ? { scope: query.scope } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { lexemes: planMemoryQuery(query.q, memoryIndexKey(key)).lexemes } : {}),
        ...(cursor ? { cursor } : {})
      });
      const keys = new Map<string, Buffer>([[workspaceId, key]]);
      for (const origin of new Set(page.items.map((item) => item.workspaceId)))
        if (!keys.has(origin)) keys.set(origin, (await workspaceKnowledgeKey(user.id, origin)).key);
      const last = page.items.at(-1);
      return {
        items: page.items.map((record) => ({
          id: record.id,
          workspaceId: record.workspaceId,
          projectId: record.projectId,
          taskId: record.taskId,
          kind: record.kind,
          status: record.status,
          excerpt: memoryItemExcerpt(record, keys.get(record.workspaceId)!),
          observedAt: record.observedAt,
          trust: record.trust,
          origin: memoryItemOrigin(record),
          validTo: record.validTo,
          lastVerified: record.lastVerified
        })),
        nextCursor:
          page.hasMore && last
            ? Buffer.from(JSON.stringify({ at: last.observedAt, id: last.id })).toString(
                'base64url'
              )
            : null
      };
    }
  );

  app.get<{ Params: { workspaceId: string }; Querystring: { limit?: string } }>(
    '/v1/workspaces/:workspaceId/memory-items',
    async (request) => {
      const user = requireUser(request.user);
      const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      const limit = z.coerce.number().int().min(1).max(200).default(20).parse(request.query.limit);
      return (await store.listMemoryItems(request.params.workspaceId, { limit })).map((record) => ({
        id: record.id,
        kind: record.kind,
        status: record.status,
        excerpt: memoryItemExcerpt(record, key),
        observedAt: record.observedAt,
        trust: record.trust,
        origin: memoryItemOrigin(record),
        workspaceId: record.workspaceId,
        taskId: record.taskId
      }));
    }
  );

  app.delete<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.forgetMemoryItem(request.params.workspaceId, request.params.itemId)
      };
    }
  );

  /**
   * The memory review queue, which three documents promise.
   *
   * The store computes which procedures have gone stale or started failing and the consolidation
   * pass keeps the ids; this route is what makes "verify or delete" a question put to the owner
   * about their own notes rather than one decided for them. Two lists, because they are two
   * different questions:
   *
   * `procedures` is "this remembered command may no longer work" - either nobody has confirmed it
   * in a season (`unverified`), or it lost more of its last five uses than it won (`failing`), and
   * `recentOkCount` of `recentGradedCount` is the evidence for the second.
   *
   * `disputed` is "two things you said contradict each other", and it carries `contradicts` - the
   * ids of the other side - because "this is disputed" with no answer to "with what" is not
   * something a person can act on.
   *
   * The projection is wider than `/memory-items`: which conversation wrote this, when it was last
   * confirmed, what it has been worth. Those are the fields a "keep it or delete it" decision rests
   * on and the narrower list has no use for. `trust` and `origin` are not among them - the
   * browsable list carries both, because provenance is not a fact about a decision, it is a
   * fact about the row.
   */
  const memoryReviewFields = (record: MemoryItemRecord, key: Buffer) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    excerpt: memoryItemExcerpt(record, key),
    observedAt: record.observedAt,
    origin: memoryItemOrigin(record),
    taskId: record.taskId,
    trust: record.trust,
    validFrom: record.validFrom,
    validTo: record.validTo,
    lastVerified: record.lastVerified,
    okCount: record.okCount,
    failCount: record.failCount,
    useCount: record.useCount,
    pin: record.pin
  });

  /**
   * A stable handle for a row that has no id of its own.
   *
   * `mem.fact_candidate` is keyed on `(workspace_id, subject_key, predicate, object_key)` and the
   * two key columns are keyed blind hashes. A surrogate `id` column would have meant a volatile
   * default on an existing table - a rewrite - to give a name to rows that already have one, so the
   * name is derived from the key instead: same row, same handle, every request, and the index keys
   * themselves never leave the server.
   *
   * Not a secret and not treated as one: it is a hash of values only the key holder can compute,
   * handed to the key holder. It exists so a client can say "that one".
   */
  const memoryProposalId = (record: MemoryFactCandidateRecord): string =>
    createHmac('sha256', PROPOSAL_HANDLE_CONTEXT)
      .update([record.subjectKey, record.predicate, record.objectKey].join(SEPARATOR))
      .digest('hex')
      .slice(0, 32);

  /**
   * What a model has nominated, in the owner's hands before it is in the agent's.
   *
   * `sentence` is the whole of the proposed rule and not an excerpt, which is the one place this
   * screen differs from every other memory list. Those clamp at 200 characters because a stored row
   * can be a paragraph and fifty of them is a megabyte of ciphertext decrypted to answer a question
   * about one. A proposal is capped at `MEMORY_STANDING_ORDER_MAX_CHARS` by the harness that wrote
   * it, so the whole of it fits - and asking somebody to accept or refuse a rule while showing them
   * the opening of it is not a decision anybody can make.
   *
   * `sightings` and `needsAnotherDay` are the gate said out loud. A proposal is one sighting and
   * nothing else; it becomes something this computer acts on when the same sentence is proposed
   * again from a different conversation at least a day later. An owner looking at this list should
   * be able to see that nothing here is believed yet.
   */
  const memoryProposalFields = (
    record: MemoryFactCandidateRecord,
    key: Buffer,
    workspaceId: string
  ) => {
    const sentence = ((): string => {
      if (!record.draftCiphertext) return UNREADABLE_MEMORY_ITEM;
      try {
        return (
          decryptJson<{ object?: string }>(
            record.draftCiphertext,
            key,
            `memory-fact-candidate:${workspaceId}`
          ).object ?? UNREADABLE_MEMORY_ITEM
        );
      } catch {
        return UNREADABLE_MEMORY_ITEM;
      }
    })();
    return {
      id: memoryProposalId(record),
      sentence,
      sightings: record.episodeCount,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      /** True while the two sightings it has are too close together to count as two. */
      needsAnotherDay:
        new Date(record.lastSeen).getTime() - new Date(record.firstSeen).getTime() <
        24 * 60 * 60 * 1000
    };
  };

  app.get<{
    Params: { workspaceId: string };
    Querystring: { staleDays?: string; limit?: string };
  }>('/v1/workspaces/:workspaceId/memory-review', async (request) => {
    const user = requireUser(request.user);
    const workspaceId = request.params.workspaceId;
    const { key } = await workspaceKnowledgeKey(user.id, workspaceId);
    const query = z
      .object({
        // Bounded on both sides: a horizon of zero would list every procedure on the box as stale,
        // and one of ten thousand years would list none, both silently.
        staleDays: z.coerce.number().int().min(1).max(3_650).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50)
      })
      .parse(request.query);
    const [procedures, disputed, proposals] = await Promise.all([
      store.listStaleMemoryProcedures(workspaceId, {
        ...(query.staleDays === undefined ? {} : { staleDays: query.staleDays })
      }),
      store.listDisputedMemoryItems(workspaceId, query.limit),
      store.listMemoryFactProposals(workspaceId, query.limit)
    ]);
    return {
      procedures: procedures.slice(0, query.limit).map((record) => ({
        ...memoryReviewFields(record, key),
        reason: record.reason,
        recentOkCount: record.recentOkCount,
        recentGradedCount: record.recentGradedCount
      })),
      disputed: disputed.map((record) => ({
        ...memoryReviewFields(record, key),
        contradicts: record.contradicts
      })),
      proposals: proposals.map((record) => memoryProposalFields(record, key, workspaceId))
    };
  });

  /**
   * "No, don't remember that", said about a sentence that is not yet a memory.
   *
   * The one bound in this whole mechanism that did not exist before it. `mem.fact_candidate` has
   * been in the schema since the memory subsystem shipped and had no production route and no screen
   * anywhere: outside the store its only appearance in this app was a single assertion in
   * `server.test.ts`. That was survivable while the only thing writing to it was a regex over the
   * owner's own sentence, and it stops being survivable the moment a model writes to it - a queue
   * nobody can look at is not a bound, it is the same promise a post-hoc audit makes, moved one
   * table over.
   *
   * A dismissal is durable and it is deliberately not a delete: the store keeps the row, drops the
   * draft and refuses the same sentence at the write point, so the proposer cannot offer it again
   * tomorrow night and every night after. Exactly per sentence, with the same honest limit
   * retraction has - the keys fold case, NFKC and whitespace and nothing else, so a paraphrase is a
   * different row.
   *
   * 404 rather than `{dismissed:0}`, matching verify and retract next door: the store refuses for
   * one reason only, which is that this workspace has no such open proposal, and a client shown
   * 200-with-nothing would have to guess whether it had been dismissed already or never existed.
   *
   * **One press for the whole group, because the group is the unit the owner judges in.** The rows
   * here are the only ones on this computer nobody has ever had a chance to refuse, they arrive
   * three a night against a standing twenty, and the thing an owner does with a screenful of
   * sentences a model wrote about them is refuse the screenful. Twenty presses to say it once is
   * the interface asking somebody to do a machine's counting, and a queue that costs twenty presses
   * to drain is a queue that is never drained - which is not a cosmetic loss, because the proposer
   * stops entirely when the list is full.
   *
   * `proposals` names the exact handles the screen is showing rather than meaning "everything open
   * now". The difference is a proposal written between the screen being drawn and the button being
   * pressed: `all: true` would refuse it permanently, unseen, which is the one thing a durable
   * refusal must never do. Naming them costs a list the client already holds.
   *
   * The single-handle form is kept exactly as it was - it is what one row's own button sends - and
   * both are the same statement over a list of one, so there is one bound, one resolution and one
   * 404 rule rather than two routes drifting apart.
   */
  app.post<{ Params: { workspaceId: string }; Body: { proposal?: string; proposals?: string[] } }>(
    '/v1/workspaces/:workspaceId/memory-proposals/dismiss',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspaceId = request.params.workspaceId;
        await workspaceKnowledgeKey(user.id, workspaceId);
        const handle = z.string().regex(/^[0-9a-f]{32}$/);
        const body = z
          .object({
            proposal: handle.optional(),
            // Bounded at the widest page `/memory-review` will serve, which is the widest group the
            // owner can have had in front of them. A longer list is a client naming rows no screen
            // has shown, and this is a refusal that cannot be taken back.
            proposals: z.array(handle).min(1).max(200).optional()
          })
          .refine((value) => value.proposal !== undefined || value.proposals !== undefined)
          .parse(request.body ?? {});
        const wanted = new Set([
          ...(body.proposals ?? []),
          ...(body.proposal ? [body.proposal] : [])
        ]);
        /*
         * The handles are resolved against the open list rather than turned back into keys, and they
         * travel in the body rather than in the path. Both are the same decision made twice.
         *
         * A candidate is named by `(subject_key, predicate, object_key)` and two of those are keyed
         * blind hashes, so there is no id to put in a URL - and the hook on every path parameter
         * ending in `Id` is right that the ones there are are UUID columns. Deriving a UUID-shaped
         * string from a hash would have satisfied the shape and lied about what it was.
         *
         * One scan for the whole group. The list is bounded at `MEMORY_MAX_OPEN_PROPOSALS`, so this
         * is at most twenty rows however many handles were named, and the index keys never leave
         * this process.
         */
        const open = await store.listMemoryFactProposals(workspaceId, 200);
        let dismissed = 0;
        for (const record of open) {
          if (!wanted.has(memoryProposalId(record))) continue;
          if (
            await store.dismissMemoryFactCandidate(
              workspaceId,
              record.subjectKey,
              record.predicate,
              record.objectKey
            )
          )
            dismissed += 1;
        }
        /*
         * Nothing at all is the 404 the single form has always answered, and a group that hit some
         * of what it named is not one: those rows are refused for good, saying so is the truth, and
         * the handles that resolved to nothing were rows already gone before the press landed.
         */
        if (dismissed === 0)
          throw new GardenError('memory_proposal_not_found', 'Proposal not found', 404);
        return { dismissed };
      });
    }
  );

  /**
   * "This is still right." Moves the procedure out of the queue by moving the clock the queue reads.
   *
   * 404 rather than `{verified:false}` because the store returns false for exactly two reasons - no
   * such row in this workspace, or the row is not a procedure - and both are the caller naming
   * something that is not there. A client that showed a row and then got 200-with-false would have
   * to guess.
   */
  app.post<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId/verify',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        await workspaceKnowledgeKey(user.id, request.params.workspaceId);
        if (!(await store.verifyMemoryProcedure(request.params.workspaceId, request.params.itemId)))
          throw new GardenError('memory_item_not_found', 'Memory item not found', 404);
        return { verified: true };
      });
    }
  );

  /**
   * "Stop believing this", which is not "delete this".
   *
   * `DELETE …/memory-items/:id` next door removes the row and every trace of it, which is what an
   * owner means when they say a line is gone. Retracting keeps the row, stops it being recalled and
   * records that it stopped being true - the audit trail the queue exists to protect. Both are
   * offered because they are different decisions, and the difference is the whole reason the review
   * queue is not a delete button.
   */
  app.post<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId/retract',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        await workspaceKnowledgeKey(user.id, request.params.workspaceId);
        if (!(await store.retractMemoryItem(request.params.workspaceId, request.params.itemId)))
          throw new GardenError(
            'memory_item_not_found',
            'Memory item not found, or already retracted',
            404
          );
        return { retracted: true };
      });
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/skills',
    async (request) => {
      const user = requireUser(request.user);
      const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      await store.curateWorkspaceSkills(request.params.workspaceId);
      return (await store.listWorkspaceSkills(user.id, request.params.workspaceId)).map(
        (record) => ({
          id: record.id,
          version: record.version,
          enabled: record.enabled,
          status: record.status,
          pinned: record.pinned,
          useCount: record.useCount,
          lastUsedAt: record.lastUsedAt,
          ...decryptJson<{ name: string; description: string; content: string }>(
            record.documentCiphertext,
            key,
            `workspace-skill:${record.workspaceId ?? request.params.workspaceId}`
          ),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        })
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { name: string; description: string; content: string };
  }>('/v1/workspaces/:workspaceId/skills', async (request) => {
    const user = requireUser(request.user);
    const input = SkillDocumentInput.parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const nameHash = createHmac('sha256', key).update(`garden-skill:${input.name}`).digest('hex');
    const saved = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: request.params.workspaceId,
      nameHash,
      documentCiphertext: encryptJson(input, key, `workspace-skill:${request.params.workspaceId}`)
    });
    return {
      id: saved.id,
      version: saved.version,
      enabled: saved.enabled,
      status: saved.status,
      pinned: saved.pinned,
      useCount: saved.useCount,
      lastUsedAt: saved.lastUsedAt,
      ...input,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt
    };
  });

  app.patch<{
    Params: { workspaceId: string; skillId: string };
    Body: { status?: 'active' | 'stale' | 'archived'; pinned?: boolean; enabled?: boolean };
  }>('/v1/workspaces/:workspaceId/skills/:skillId', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        status: z.enum(['active', 'stale', 'archived']).optional(),
        pinned: z.boolean().optional(),
        enabled: z.boolean().optional()
      })
      .refine(
        (value) =>
          value.status !== undefined || value.pinned !== undefined || value.enabled !== undefined
      )
      .parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const updated = await store.setWorkspaceSkillState({
      id: request.params.skillId,
      userId: user.id,
      workspaceId: request.params.workspaceId,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled })
    });
    if (!updated) throw new GardenError('skill_not_found', 'Skill not found', 404);
    return {
      id: updated.id,
      version: updated.version,
      enabled: updated.enabled,
      status: updated.status,
      pinned: updated.pinned,
      useCount: updated.useCount,
      lastUsedAt: updated.lastUsedAt,
      ...decryptJson<{ name: string; description: string; content: string }>(
        updated.documentCiphertext,
        key,
        `workspace-skill:${request.params.workspaceId}`
      ),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  });

  app.delete<{ Params: { workspaceId: string; skillId: string } }>(
    '/v1/workspaces/:workspaceId/skills/:skillId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.deleteWorkspaceSkill(
          user.id,
          request.params.workspaceId,
          request.params.skillId
        )
      };
    }
  );
};
