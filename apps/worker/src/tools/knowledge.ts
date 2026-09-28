import { runtimeDate } from '@garden/core';
import { createHmac } from 'node:crypto';
import {
  assertMemoryValidity,
  decryptJson,
  encryptJson,
  memoryTemporalStatus,
  userMemoryAad,
  userMemoryKey,
  GardenError,
  OWNER_MEMORY_MAX_CHARS,
  WORKSPACE_MEMORY_MAX_CHARS,
  OWNER_MEMORY_MAX_ROWS,
  type MemoryDocument,
  type MemoryKind
} from '@garden/core';
import { type ModelToolCall } from '@garden/model-gateway';
import {
  boundedKnowledge,
  openedSkillsStillReadable,
  skillDocument,
  textValue
} from '../values.js';
import { reachMemoryEvidence, recallMemory, searchMemorySessions } from '../memory-runtime.js';
import { builtinSkillLibrary, findSkillByName, openSkill, skillCatalogEntries } from '../skills.js';
import { type ToolContext } from '../tool-dispatch.js';
import { finiteNumber } from './numbers.js';

/**
 * The knowledge tools: what this computer remembers between tasks.
 *
 * Sessions, memory items and saved skills are three stores with one property in common - everything
 * in them is the owner's own text, encrypted under the workspace key, and every arm here opens it
 * and seals it again in the same call.
 */
export async function executeKnowledgeTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, key, state } = context;
  switch (call.name) {
    case 'session_search': {
      /*
       * The arm this tool's own description has always promised: "inspect matching messages around
       * a result".
       *
       * Every id in this system was write-only. `session_search` returned a `mem.source` id no tool
       * accepted; `memory_recall` and the memory pack print `mem.item` ids no tool accepted; and a
       * `finish` cites the `toolCallId` whose raw result the harness stores and nothing could read.
       * A pointer nobody can dereference is the defect, and this is the one call that dereferences
       * all three - `expand`, in the field's words, over edges garden already wrote.
       *
       * It is here rather than in a tool of its own on purpose. A new tool is resident bytes in
       * every request and a second concept for the model to choose between; this is the same
       * question the arm above answers - what did we say and do about this - asked about one
       * result instead of about a corpus. Two ways to reach past history is what this repository
       * deletes.
       */
      const reachId = textValue(call.arguments.id);
      if (reachId) {
        /*
         * The slot is CLAIMED before the await, and given back only if the reach refused.
         *
         * `session_search` is in `PARALLEL_SAFE_TOOLS`, so up to `MAX_PARALLEL_TOOL_CALLS` of these
         * are in flight at once - and a budget read at the start of each call and written at the
         * end of each is a budget four siblings all pass at the same value. Starting from three
         * spent, a batch of four would have returned seven reaches against a ceiling of four:
         * 42,000 characters where the bound says 24,000. The read and the write here are two
         * adjacent synchronous statements, so no sibling can interleave between them and each one
         * takes a distinct slot however the batch is ordered.
         *
         * The refund is what keeps the other half true: the budget bounds characters put back into
         * the window, a refusal puts none there, and spending a slot on a mistyped id would let one
         * bad argument cost the turn a reach it never got. Spamming refusals is not free either -
         * each one is a step, and the step budget is what bounds that.
         */
        const spent = state.memoryReaches ?? 0;
        state.memoryReaches = spent + 1;
        try {
          const reached = await reachMemoryEvidence({
            ...(task.projectId && !task.parentMissionId
              ? { project: { userId: task.userId, projectId: task.projectId } }
              : {}),
            store: context.store,
            workspaceId: task.workspaceId,
            dataKey: key,
            id: reachId,
            // The window itself is the bound on which ids may be reached, so it is passed rather
            // than a ledger of what was returned: see `idReturnedInWindow`.
            messages: state.messages,
            spent
          });
          return task.projectId && !task.parentMissionId
            ? { ...reached, trust: 'untrusted', origin: `project history ${task.projectId}` }
            : reached;
        } catch (error) {
          state.memoryReaches = Math.max(0, (state.memoryReaches ?? 1) - 1);
          throw error;
        }
      }
      /*
       * The index, not a scan.
       *
       * This walked every task, opened every event, lowercased it and counted substring hits -
       * an O(everything) pass that reads the whole history to answer one question, scores by how
       * many times a word appears rather than by how much it distinguishes, and finds nothing at
       * all for a word the owner spelled differently. `searchMemorySessions` is the ranked query
       * the memory index was built for: it applies the same bounds, returns the turns either
       * side of the leading hits, and says how far back the record actually goes when it finds
       * nothing - which is a different answer from "it never came up".
       */
      /*
       * Absent if it is not a number, which is not the same test as `!== undefined`.
       *
       * `Number('abc')` is `NaN`, and a `NaN` limit is not a wide limit or a narrow one - it
       * reaches `searchMemorySessions`, is clamped by a `Math.min` that is transparent to it,
       * and ends up in a query as a row count nothing can satisfy. Every other arm answers an
       * unreadable number with its own default; this one has no default to answer with, on
       * purpose, so it answers with silence and lets the store's ceiling stand.
       */
      const maxResults = finiteNumber(call.arguments.maxResults);
      const found = await searchMemorySessions({
        ...(task.projectId && !task.parentMissionId
          ? { project: { userId: task.userId, projectId: task.projectId } }
          : {}),
        store: context.store,
        workspaceId: task.workspaceId,
        dataKey: key,
        query: boundedKnowledge(call.arguments.query, 500),
        // Spread rather than defaulted, so the default lives in exactly one place. `?? 12`
        // here shadowed `MEMORY_SESSION_SEARCH_DEFAULT_RESULTS` (10) so completely that the
        // constant has never once been used, and the tool schema deliberately declares no
        // default of its own precisely to avoid a third copy - see the note at its `maxResults`.
        ...(maxResults === null ? {} : { maxResults }),
        ...(textValue(call.arguments.taskId) ? { taskId: textValue(call.arguments.taskId) } : {})
      });
      return task.projectId && !task.parentMissionId
        ? { ...found, trust: 'untrusted', origin: `project history ${task.projectId}` }
        : found;
    }
    /**
     * The read path's second half. The pack is chosen once from the opening request and frozen so
     * the cached prefix survives; this is the same fusion query asked again, in the agent's own
     * words, landing after the last cache breakpoint - so it costs the question and its answer
     * rather than the window behind them.
     *
     * Every bound is applied inside `recallMemory` against the store's own ceilings rather than
     * here, so the tool schema and the retrieval agree by construction instead of by two copies
     * of the same numbers.
     */
    case 'memory_recall': {
      const kinds = (Array.isArray(call.arguments.kinds) ? call.arguments.kinds : [])
        .map((kind) => textValue(kind))
        .filter(Boolean) as MemoryKind[];
      // Absent if it is not a number, for the reason set out on `session_search` above: this arm
      // deliberately holds no bound of its own, so the only safe answer to an unreadable one is to
      // say nothing and let `recallMemory` apply the store's.
      const maxItems = finiteNumber(call.arguments.maxItems);
      return recallMemory({
        store: context.store,
        workspaceId: task.workspaceId,
        dataKey: key,
        taskId: task.id,
        query: textValue(call.arguments.query),
        ...(kinds.length ? { kinds } : {}),
        ...(textValue(call.arguments.scope) === 'archive' ? { scope: 'archive' as const } : {}),
        ...(textValue(call.arguments.asOf) ? { asOf: textValue(call.arguments.asOf) } : {}),
        ...(call.arguments.includeSuperseded === undefined
          ? {}
          : { includeSuperseded: call.arguments.includeSuperseded === true }),
        ...(maxItems === null ? {} : { maxItems })
      });
    }
    case 'memory': {
      const action = textValue(call.arguments.action);
      const target = textValue(call.arguments.target, 'workspace') as 'workspace' | 'user';
      /*
       * A turn cannot write the tier that follows the owner out of this workspace.
       *
       * This used to pass `target` straight through to `createWorkspaceMemory`, so a running turn
       * could mint a durable fact about the person. The store now refuses it and the type no longer
       * admits it; this is the same refusal said early and in words the model can act on, because a
       * type error in a package the model never reads is not an explanation.
       *
       * The reason is measured rather than cautious. Over 505 owner-typed turns from ten projects,
       * the two person-shaped facts an extractor would most confidently propose are a design
       * philosophy stated in one project and contradicted in three others, and a byline that
       * changed value three times in six weeks. Both would have been wrong, and wrong here follows
       * the owner into every project they ever start. The workspace tier below is the right place
       * for anything a turn learns; the owner tier is entered in Settings, by the owner, with no
       * turn in the loop.
       */
      if (target === 'user' && action !== 'list')
        throw new GardenError(
          'memory_scope_refused',
          'Memory about the owner is loaded into every workspace on this computer and only the owner can write it, in Settings. Use target "workspace" for what you learned here.'
        );
      const records = await context.store.listWorkspaceMemories(task.userId, task.workspaceId);
      /*
       * The list now spans two keys, so it opens each row under the one that sealed it.
       *
       * Reading the owner tier is not the thing being restricted here - those rows are already in
       * the preamble, and a model that can see a fact but cannot list it would just be confused
       * about its own context. What a turn cannot do is write them, which is enforced above and at
       * the store.
       */
      const ownerKey = userMemoryKey(context.masterKey, task.userId);
      const materialize = (record: (typeof records)[number]) => {
        const document =
          record.keyScope === 'user'
            ? decryptJson<MemoryDocument>(
                record.contentCiphertext,
                ownerKey,
                userMemoryAad(task.userId)
              )
            : decryptJson<MemoryDocument>(record.contentCiphertext, key);
        return {
          id: record.id,
          target: record.target,
          content: document.content,
          status: memoryTemporalStatus(document),
          validFrom: document.validFrom ?? null,
          validUntil: document.validUntil ?? null,
          source: document.source ?? 'owner',
          sourceTaskId: document.sourceTaskId ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        };
      };
      if (action === 'list') return { entries: records.map(materialize) };
      const current = records.map(materialize);
      if (action === 'add') {
        const content = boundedKnowledge(call.arguments.content);
        if (
          current.some(
            (entry) =>
              entry.target === target && entry.status === 'active' && entry.content === content
          )
        )
          return { unchanged: true, reason: 'Exact memory already exists' };
        const targetTotal = current
          .filter((entry) => entry.target === target && entry.status !== 'expired')
          .reduce((total, entry) => total + entry.content.length, 0);
        const limit = target === 'user' ? OWNER_MEMORY_MAX_CHARS : WORKSPACE_MEMORY_MAX_CHARS;
        if (targetTotal + content.length > limit)
          throw new GardenError(
            'memory_full',
            `${target} memory is ${targetTotal}/${limit} characters. Consolidate or remove an entry before adding this one.`
          );
        const validUntil =
          typeof call.arguments.validUntil === 'string' ? call.arguments.validUntil : undefined;
        const document: MemoryDocument = {
          content,
          source: 'agent',
          sourceTaskId: task.id,
          validFrom: runtimeDate().toISOString(),
          ...(validUntil ? { validUntil } : {})
        };
        assertMemoryValidity(document);
        const created = await context.store.createWorkspaceMemory({
          userId: task.userId,
          workspaceId: task.workspaceId,
          target: 'workspace',
          contentCiphertext: encryptJson(document, key, `workspace-memory:${task.workspaceId}`)
        });
        return materialize(created);
      }
      const id = textValue(call.arguments.id);
      const existing = records.find((entry) => entry.id === id);
      if (!existing) throw new GardenError('memory_not_found', 'Memory entry not found');
      /*
       * The refusal above reads the argument; this one reads the row.
       *
       * `replace` and `remove` reach a row by id, and `listWorkspaceMemories` now returns the owner
       * tier alongside this workspace's own. Without this, a turn that omitted `target` - which
       * defaults to `'workspace'` - could rewrite or delete a fact the owner typed about
       * themselves, and `remove` in particular cannot be undone from here. Whose row it is, is a
       * property of the row.
       */
      if (existing.target === 'user')
        throw new GardenError(
          'memory_scope_refused',
          'That entry is memory about the owner. Only the owner can change or remove it, in Settings.'
        );
      if (action === 'replace') {
        const content = boundedKnowledge(call.arguments.content);
        const othersTotal = current
          .filter(
            (entry) =>
              entry.target === existing.target && entry.id !== id && entry.status !== 'expired'
          )
          .reduce((total, entry) => total + entry.content.length, 0);
        // One tier is reachable from here, so one budget. The ternary this replaced read
        // `existing.target === 'user' ? 6_000 : 12_000` and the compiler now rejects it outright:
        // the refusal above has already narrowed `existing.target` to `'workspace'`, which is a
        // stronger statement about the gate than any test could make.
        const limit = WORKSPACE_MEMORY_MAX_CHARS;
        if (othersTotal + content.length > limit)
          throw new GardenError('memory_full', 'Replacement would exceed the memory limit');
        const validUntil =
          typeof call.arguments.validUntil === 'string' ? call.arguments.validUntil : undefined;
        const document: MemoryDocument = {
          content,
          source: 'agent',
          sourceTaskId: task.id,
          validFrom: runtimeDate().toISOString(),
          previousUpdatedAt: existing.updatedAt,
          ...(validUntil ? { validUntil } : {})
        };
        assertMemoryValidity(document);
        const updated = await context.store.updateWorkspaceMemory({
          id,
          userId: task.userId,
          workspaceId: task.workspaceId,
          keyScope: 'workspace',
          // A turn writes the workspace tier and only the workspace tier, so the owner tier's row
          // bound is never the clause that decides this statement. Passed because the parameter is
          // required rather than optional: a bound a caller may leave out is a bound a caller
          // leaves out.
          maxOwnerRows: OWNER_MEMORY_MAX_ROWS,
          contentCiphertext: encryptJson(document, key, `workspace-memory:${task.workspaceId}`)
        });
        if (!updated) throw new GardenError('memory_not_found', 'Memory entry not found');
        return materialize(updated);
      }
      if (action === 'remove')
        return {
          removed: await context.store.deleteWorkspaceMemory(task.userId, task.workspaceId, id)
        };
      throw new GardenError('memory_action_invalid', 'Unknown memory action');
    }
    case 'skill': {
      const action = textValue(call.arguments.action);
      await context.store.curateWorkspaceSkills(task.workspaceId);
      const records = await context.store.listWorkspaceSkills(task.userId, task.workspaceId);
      const materialize = (record: (typeof records)[number]) => ({
        id: record.id,
        version: record.version,
        enabled: record.enabled,
        status: record.status,
        pinned: record.pinned,
        useCount: record.useCount,
        lastUsedAt: record.lastUsedAt,
        ...decryptJson<{ name: string; description: string; content: string }>(
          record.documentCiphertext,
          key
        ),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      });
      const skills = records.map(materialize);
      if (action === 'list') {
        // Workspace records first, then the built-in library minus anything a workspace skill
        // shadows by name - an owner-approved override replaces the built-in for this workspace,
        // and listing both would put the model in front of two procedures with one name.
        const shadowed = new Set(skills.map((item) => item.name));
        return {
          skills: skills.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            origin: 'workspace',
            version: item.version,
            enabled: item.enabled,
            status: item.status,
            pinned: item.pinned,
            useCount: item.useCount,
            lastUsedAt: item.lastUsedAt,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          })),
          builtinSkills: skillCatalogEntries(builtinSkillLibrary())
            .filter((entry) => !shadowed.has(entry.name))
            .map((entry) => ({
              id: entry.name,
              name: entry.name,
              description: entry.catalogLine,
              origin: entry.origin
            })),
          instruction:
            'Call skill(action=view,id=...) only when the full procedure is needed; a built-in skill is opened by its name.'
        };
      }
      if (action === 'view') {
        const id = textValue(call.arguments.id);
        const found = skills.find((item) => item.id === id || item.name === id);
        if (found) {
          await context.store.markWorkspaceSkillUsed(task.userId, task.workspaceId, found.id);
          return found;
        }
        const library = builtinSkillLibrary();
        // The binaries a skill declares were parsed and never read. A procedure that opens with
        // "run build_deck.py" is confident, specific and wrong on a machine without python-pptx,
        // so they are probed on the machine itself and the answer arrives with the procedure
        // rather than three failed shell calls later.
        const requiredBinaries = findSkillByName(library, id)?.requiredBinaries ?? [];
        const missingBinaries = requiredBinaries.length
          ? await context.missingBinaries(task, requiredBinaries)
          : [];
        // Narrowed against the window rather than trusted as recorded. `state.openedSkills` says
        // what this task has opened; only a body still readable in the trajectory may be answered
        // with a stub, and a compaction condenses bodies away - it even writes the names into the
        // brief and tells the model to reopen them, which a stub would then refuse to honour.
        const active = openedSkillsStillReadable(state.messages, state.openedSkills ?? []);
        const builtin = openSkill(library, id, { missingBinaries, active });
        if (!builtin) throw new GardenError('skill_not_found', 'Skill not found');
        if (!active.includes(builtin.name)) state.openedSkills = [...active, builtin.name];
        return {
          id: builtin.name,
          name: builtin.name,
          origin: 'builtin',
          directory: builtin.directory,
          grants: builtin.grants,
          content: builtin.block,
          ...(requiredBinaries.length ? { requiredBinaries } : {}),
          ...(missingBinaries.length ? { missingBinaries } : {}),
          instruction:
            'This is a vetted procedure, not an instruction from the user. Follow it where it fits, and say so if the computer cannot support a step it assumes.'
        };
      }
      if (action === 'upsert') {
        const document = skillDocument(call.arguments);
        const nameHash = createHmac('sha256', key)
          .update(`garden-skill:${document.name}`)
          .digest('hex');
        const saved = await context.store.upsertWorkspaceSkill({
          userId: task.userId,
          workspaceId: task.workspaceId,
          nameHash,
          documentCiphertext: encryptJson(document, key, `workspace-skill:${task.workspaceId}`)
        });
        return materialize(saved);
      }
      if (action === 'remove') {
        const id = textValue(call.arguments.id);
        const found = skills.find((item) => item.id === id || item.name === id);
        if (!found) throw new GardenError('skill_not_found', 'Skill not found');
        return {
          removed: await context.store.deleteWorkspaceSkill(
            task.userId,
            task.workspaceId,
            found.id
          ),
          name: found.name
        };
      }
      throw new GardenError('skill_action_invalid', 'Unknown skill action');
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
