/*
 * What the model is sent: its size, its shape, and whether it describes the product it is part of.
 *
 * Split out of tools.test.ts with the catalogue itself. Nothing here calls the approval floor to
 * decide anything - where `approvalRequirement` appears below it is because the catalogue promised
 * the model a card would be raised, and a promise in a description that the floor does not keep is
 * a defect in the description.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BrowserAction,
  DesktopAction,
  MAX_AGENT_NOTIFICATIONS_PER_TASK,
  publishesPublicly,
  surfaceDescribable,
  TaskScheduleSpec,
  UNKNOWN_SURFACES,
  ConnectorKind,
  type MediaModelOption,
  type WorkspaceSurfaces
} from '@athanor/contracts';
import { z } from 'zod';
import {
  connectorActions,
  mailConnectorActionInputs,
  accountConnectorInputs,
  MEMORY_RECALL_ITEM_CEILING,
  MEMORY_RECALL_MAX_ITEMS
} from '@athanor/core';
import { agentTools, agentToolsFor, CONNECTOR_ACTION_INPUTS } from './tool-catalogue.js';
import { approvalRequirement } from './approval-policy.js';
import { isMutatingToolCall } from './write-classification.js';
import { REPEATABLE_TOOLS } from './turn-bounds.js';
import { surfaceActionRequest } from './surface-actions.js';
import { MAX_NOTICES_PER_TURN } from './agent.js';
import { BASE_SYSTEM_PROMPT, COMPACT_CONTEXT_TOOL } from './context.js';
import { MEMORY_SESSION_SEARCH_MAX_RESULTS } from './memory-runtime.js';
import { resolvedMediaModel } from './media.js';
import { CODE_SEARCH_COLLAPSE_LINES, CODE_SEARCH_FILE_CEILING } from './tools/repository.js';
import { EDIT_FORMAT_SPEC } from './edit/index.js';

/** A stored media route, as the API seals one into the credential this worker decrypts. */
const mediaOption = (
  overrides: Partial<MediaModelOption> & Pick<MediaModelOption, 'id'>
): MediaModelOption => ({
  providerModelId: overrides.id,
  displayName: overrides.id,
  provider: 'openrouter',
  modality: 'image',
  usdPerImage: null,
  usdPerMillionCharacters: null,
  usdPerMinute: null,
  priceSource: 'provider',
  recommendationTags: [],
  updatedAt: '2026-08-10T00:00:00.000Z',
  ...overrides
});

describe('plan tool schema', () => {
  const setPlan = agentTools.find((tool) => tool.name === 'set_plan');

  it('lets the model report step status, not just titles', () => {
    // planStepsFromArguments reads {title,status} objects, so the schema has to admit them.
    // While it only allowed strings the model could never move a step off 'pending' and the
    // live plan the user watches stayed frozen for the whole task.
    const steps = (setPlan?.parameters as { properties?: Record<string, unknown> }).properties
      ?.steps as { items?: { oneOf?: Array<Record<string, unknown>> } } | undefined;
    const shapes = steps?.items?.oneOf ?? [];
    expect(shapes.some((shape) => shape.type === 'string')).toBe(true);
    const object = shapes.find((shape) => shape.type === 'object') as
      | { properties?: { status?: { enum?: string[] } } }
      | undefined;
    expect(object?.properties?.status?.enum).toEqual([
      'pending',
      'in_progress',
      'completed',
      'skipped'
    ]);
  });

  it('tells the model when to update status, since nothing else will', () => {
    expect(setPlan?.description).toMatch(/in_progress/);
    expect(setPlan?.description).toMatch(/completed/);
  });
});

describe('the size of the catalogue the model is sent', () => {
  // Measured rather than asserted in prose. The comment above the catalogue used to carry the
  // numbers, and a stale number in a comment reads exactly like a fresh one; this holds the real
  // catalogue against a ceiling instead, so a description that grows back fails here.
  const sent = [...agentToolsFor(), COMPACT_CONTEXT_TOOL];
  const bytes = Buffer.byteLength(JSON.stringify(sent));

  it('sends every declared tool, once', () => {
    expect(agentToolsFor()).toHaveLength(agentTools.length);
    const names = sent.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('stays inside the wire budget the whole prefix is cached against', () => {
    // Repeated decision factors measure 62,446 bytes for the complete catalogue.
    // The resident core has a separate ceiling in tool-groups.test.ts.
    expect(bytes).toBeLessThan(62_500);
    // Each tool and nested parameter description is bounded separately.
    for (const tool of sent)
      expect(Buffer.byteLength(tool.description), `${tool.name} description`).toBeLessThan(1_400);
    // Bound nested descriptions as well as each tool description.
    const nested: [string, number][] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'description' && typeof value === 'string')
          nested.push([`${path}.${key}`, Buffer.byteLength(value)]);
        else walk(value, `${path}.${key}`);
      }
    };
    for (const tool of sent) walk(tool.parameters, tool.name);
    // A walk that stops finding anything is this check failing while it looks like it passed, which
    // is exactly how the top-level cap missed 1,741 bytes for as long as it did.
    expect(nested.length).toBeGreaterThan(30);
    for (const [where, size] of nested) {
      // Native account reads and recoverable calendar creation measure 2,382 bytes.
      expect(size, where).toBeLessThan(
        where === 'connector_action.properties.input.description' ? 2_400 : 1_750
      );
    }
  });

  it('declares the line-addressed edit shape, and only that shape', () => {
    /*
     * The half of the editor that lives on the wire, pinned separately from the half that lives in
     * the arm, because each is useless without the other and they fail in opposite directions. An
     * arm that accepts a shape the catalogue does not declare is a capability nothing can reach -
     * the exact gate this programme has shipped wired to nothing twice - and a catalogue that
     * declares a shape the arm cannot apply is a round trip the model cannot avoid.
     *
     * `oldText`, `newText` and `moveAfter` are asserted ABSENT, not merely unmentioned. The quoted
     * editor was replaced rather than joined: two ways to do one thing doubles what the model has
     * to learn and pays for both entries on every request of every turn, which is what turns a
     * measured saving into a net loss on the wire.
     */
    const patch = sent.find((tool) => tool.name === 'file_patch');
    const item = (
      patch?.parameters.properties as { patches?: { items?: Record<string, unknown> } } | undefined
    )?.patches?.items as
      | { required?: string[]; properties?: Record<string, { description?: string }> }
      | undefined;
    expect(Object.keys(item?.properties ?? {})).toEqual(['path', 'edit']);
    expect(item?.required).toEqual(['path', 'edit']);
    for (const gone of ['oldText', 'newText', 'moveAfter'])
      expect(JSON.stringify(patch), gone).not.toContain(gone);
    /*
     * `path` is a field of its own rather than a header inside `edit`, and that is a safety
     * decision before it is an encoding one: `write-classification.ts` reads the files a call
     * writes out of exactly here, and a path buried in free text is a path the durable-instruction
     * rule and the approval card would both miss.
     */
    expect(item?.properties?.path).toBeTruthy();
    // The dialect itself, which is the only resident part of this vertical.
    expect(item?.properties?.edit?.description).toBe(EDIT_FORMAT_SPEC);
  });

  it('keeps the dialect under the size its saving pays for', () => {
    /*
     * THE BYTE LEDGER, measured rather than asserted in prose, because this is the number the whole
     * format had to be argued against - it is resident in the cached prefix of every request of
     * every turn, whether or not the turn edits anything.
     *
     *   model-facing spec, as written      1,090 bytes
     *   new file_patch entry, on the wire  1,694 bytes
     *   the quoted entry it replaces      -1,112 bytes
     *   NET ON THE CATALOGUE                +582 bytes
     *
     * The catalogue measured 54,949 before the format and 55,458 after it; the ceiling above moved
     * by exactly that 509, for exactly the capability named there, and the bare-box ceiling below
     * moved by the same 509 for the same reason. The previous costing of this same format put it
     * at +1,306, and almost all of the difference is one decision - the dialect it was measured
     * from makes the model copy a per-file version tag into every patch and spends three resident
     * paragraphs on what to do when it does not match, and `apps/worker/src/edit/snapshots.ts`
     * needs no tag because it remembers what each read displayed. A tag the model cannot miscopy
     * is a tag nobody has to describe.
     *
     * The spec then went from 1,020 to 1,090 bytes for ONE sentence and one example row: the
     * `-` row that anchors a line number to the text the model read at it. It is the one taught
     * forgiveness, because it closes the format's one hole - an off-by-one with nothing in the
     * patch saying what the model believed was at the line - and it was paid for out of the same
     * paragraph: five tightenings of prose already there gave back 79 of the 149 bytes it cost.
     * On the wire the entry measures 1,694, 73 more than without it.
     *
     * 1,100 is the spec with room for a few words and not for a paragraph, which is the same
     * distinction the ceiling above draws. The far side of the trade is measured offline over
     * fifteen tasks on this repository's own corpus: 4,086 characters of arguments become 1,589,
     * a 61% saving, winning fourteen of the fourteen rows where both formats do what was asked.
     */
    expect(Buffer.byteLength(EDIT_FORMAT_SPEC)).toBeLessThan(1_100);
    const patch = sent.find((tool) => tool.name === 'file_patch');
    expect(Buffer.byteLength(JSON.stringify(patch))).toBeLessThan(1_700);
  });

  it('has no tool whose own description says it unlocks nothing', () => {
    // tool_search ranked definitions already in the window, billed a full pass over that window to
    // do it, and said so in its own description.
    for (const tool of sent) expect(tool.description).not.toMatch(/does not unlock anything/);
    expect(sent.map((tool) => tool.name)).not.toContain('tool_search');
  });

  it('pays once for a machine fact, not once here and once in the contract', () => {
    /*
     * The ceiling above says that prose restating the system prompt is what gets trimmed. This is
     * that rule as a check rather than as a paragraph, because three descriptions were restating
     * it and only the whole-catalogue figure - which moves for forty other reasons - could see it.
     *
     * Three facts, each carried by the operating contract in the same request, each of which was
     * also being paid for down here: which binary controls where a page breaks, that this computer
     * runs no local model weights and edits existing video with ffmpeg, and what an anti-bot challenge
     * closes and for how long. The contract is message 0 of every window, so the model reads them
     * either way; the catalogue copy bought nothing, and the typst one was worse than nothing - it
     * was unconditional, while the contract's is gated on the box actually having a document
     * toolchain, so a bare box was told in one request both that it has no typst and that typst is
     * the route for a PDF that matters.
     *
     * What stays in a description is the part the contract cannot say: the name of the field a
     * challenge arrives in (`botWall`), and the per-job retention requirement for video.
     * The direction of the check is deliberate - it asserts the contract still carries each fact
     * before it forbids the duplicate, so deleting the original turns this red rather than green.
     */
    const paidForInTheContract: ReadonlyArray<readonly [string, RegExp]> = [
      ['typeset with typst', /\btypst\b/i],
      ['No model weights run on this computer', /\bffmpeg\b|model weights/i],
      ['anti-bot challenge', /until the user clears it|carry on with the rest/i]
    ];
    for (const [carried, restated] of paidForInTheContract) {
      expect(BASE_SYSTEM_PROMPT, `the contract stopped carrying "${carried}"`).toContain(carried);
      for (const tool of sent)
        expect(
          tool.description,
          `${tool.name} restates "${carried}", which the contract already sends on this request`
        ).not.toMatch(restated);
    }
  });
});

/*
 * Why `connector_action.input` is still resident, asked of the schemas rather than argued about.
 *
 * The residency ladder this catalogue is governed by puts "opened on demand" - 0 bytes resident,
 * fetched by a call the model already makes - above "resident", and `connector_action.input` is
 * 5,018 bytes of the 55,458-byte catalogue, the single largest thing in it. The proposed move is
 * to have `connector_list` return the per-action field map instead, derived from the Zod union in
 * `@athanor/core` that parses every one of these before a credential is opened. `connector_list`
 * is already the call the model is told to make first, so the round trip is free.
 *
 * The move was measured and refused, and this is the measurement rather than the argument. Two of
 * the fields the model needs are not in those schemas to be derived FROM. `saveTo` is stripped by
 * `connector-call.ts` before the parse and appears in no schema at all, and `attachments` is
 * declared there as base64 objects - which is the shape this catalogue deliberately contradicts,
 * because a 2 MB PDF is 2.7 million characters of tool call. A `connector_list` result built from
 * the schemas would therefore delete one capability and misdescribe the other, and a
 * `connector_list` result that hand-wrote them back would be the same bytes at a different
 * address plus a fresh copy to go stale - which is the duplicate this file's own header already
 * retired two kilobytes of.
 *
 * So the two cases below are not decoration. They are the condition under which the refusal
 * expires: give `saveTo` a schema and make `attachments` take paths, and this file goes red, and
 * whoever is reading it can move 4,941 bytes off every request of every turn.
 */
describe('the one part of the catalogue that has nowhere else to be opened from', () => {
  const connector = agentTools.find((tool) => tool.name === 'connector_action');
  const input = (
    connector?.parameters.properties as
      | Record<string, { properties?: Record<string, unknown>; description?: string }>
      | undefined
  )?.input;
  /** Each mail and calendar action's input schema as JSON Schema, keyed by the action it parses. */
  const parsed = new Map(
    mailConnectorActionInputs.map((schema) => {
      const shape = z.toJSONSchema(schema, { io: 'input' }) as {
        properties: Record<string, { const?: string } & Record<string, unknown>>;
      };
      return [shape.properties.action?.const ?? '', shape.properties];
    })
  );

  it('is where the model is told it may choose the file an attachment is saved as', () => {
    // The catalogue declares it, and the model has no other way to learn it exists.
    const saveTo = input?.properties?.saveTo as { description?: string } | undefined;
    expect(saveTo?.description).toMatch(/workspace/i);
    // And the schema that parses `mail_read_attachment` has never heard of it, so nothing derived
    // from that schema could carry it. `connector-call.ts:170` reads it and strips it.
    expect(parsed.get('mail_read_attachment')).toBeTruthy();
    expect(Object.keys(parsed.get('mail_read_attachment') ?? {})).not.toContain('saveTo');
    expect(JSON.stringify([...parsed.values()])).not.toContain('saveTo');
  });

  it('is where the model is told to attach a file by naming it rather than by inlining it', () => {
    const attachments = input?.properties?.attachments as
      | { items?: { type?: string }; description?: string }
      | undefined;
    expect(attachments?.items?.type).toBe('string');
    expect(attachments?.description).toMatch(/path/i);
    /*
     * The schema says the opposite, and that is the point. `outgoingAttachment` in
     * mail-connectors.ts is an object requiring `contentBase64`, capped at 20,000,000 characters,
     * and `connector-call.ts` is what turns the workspace path the model sent into one. A derived
     * map would hand the model the post-translation shape and ask it to emit megabytes of base64.
     */
    const sent = parsed.get('mail_send')?.attachments as
      | { items?: { type?: string; required?: string[] } }
      | undefined;
    expect(sent?.items?.type).toBe('object');
    expect(sent?.items?.required).toContain('contentBase64');
  });

  it('carries every action name, because the enum beside it says only that they exist', () => {
    /*
     * The other half of what would be lost. `action` declares all twenty-four names, so the model
     * always knows the capability is there - that much is not at risk. What is only here is which
     * fields go with which name, and for nineteen of the twenty-four this description is the only
     * place in the catalogue the name appears at all.
     */
    const map = input?.description ?? '';
    for (const name of Object.keys(connectorActions)) expect(map, name).toContain(name);
    const elsewhere = Object.keys(connectorActions).filter((name) =>
      JSON.stringify(input?.properties ?? {}).includes(name)
    );
    expect(elsewhere.length).toBeLessThan(Object.keys(connectorActions).length);
  });
});

/*
 * What a box without a screen or a browser is sent, which is the other half of the ceiling above.
 *
 * The ceiling above bounds the fully provisioned wire and cannot move for this, because on a box
 * with a Chromium and an X session nothing is withdrawn at all. The saving is entirely on the
 * other shape, so it needs a bound of its own or it is not ratcheted: a browser tool added outside
 * `BROWSER_SURFACE_TOOLS` would keep being described to a box with no browser, and the only thing
 * that would notice is the number below.
 *
 * These are unit measurements. The end-to-end drive - a real turn on a runner reporting a desktop
 * and a runner reporting none, read off the request that left the process - is in
 * docs/design/exec4/S1.md, because a passing unit test on a gate wired to nothing is the exact
 * defect this programme has shipped twice.
 */
describe('the wire a box without a browser or a screen is sent', () => {
  const compacted = (surfaces: WorkspaceSurfaces) => [
    ...agentToolsFor('lead', surfaces),
    COMPACT_CONTEXT_TOOL
  ];
  const provisioned = compacted({ browser: 'available', desktop: 'available' });
  const bare = compacted({ browser: 'absent', desktop: 'absent' });

  it('describes everything when nobody has said otherwise', () => {
    // The default argument, which is what every measurement, rig and test in this repo gets. A
    // gate whose default withdrew anything would move the eval baselines and the ceiling above
    // without a single caller asking it to.
    expect(agentToolsFor().map((tool) => tool.name)).toEqual(
      agentToolsFor('lead', UNKNOWN_SURFACES).map((tool) => tool.name)
    );
    expect(agentToolsFor()).toHaveLength(agentTools.length);
  });

  it('withdraws nothing from a box that has both surfaces', () => {
    // The half that would look like success while capability fell. A box with a screen and a
    // browser is sent the identical catalogue it was sent before this gate existed.
    expect(provisioned.map((tool) => tool.name)).toEqual(
      [...agentToolsFor(), COMPACT_CONTEXT_TOOL].map((tool) => tool.name)
    );
  });

  it('leaves only surface tools behind on a bare box', () => {
    const gone = provisioned
      .map((tool) => tool.name)
      .filter((name) => !bare.some((tool) => tool.name === name));
    // Named rather than counted: the point of the set is which seven, and a test that only counted
    // them would pass while a different seven went.
    expect(gone).toEqual([
      'desktop_observe',
      'desktop_launch',
      'desktop_action',
      'browser_snapshot',
      'read_elements',
      'browser_action',
      'print_pdf'
    ]);
    // The two that reach for a browser and are deliberately NOT in the bag. `web_search` is
    // answered by the provider on one of its two routes, so a box with no Chromium may still
    // search; `parallel_web_read` is the specialist's, and the specialist wire is invariant.
    // Withdrawing either would withdraw a capability the box still has.
    for (const name of ['web_search', 'parallel_web_read'])
      expect(
        bare.map((tool) => tool.name),
        name
      ).toContain(name);
  });

  it('holds the bare-box wire under a ceiling of its own', () => {
    /*
     * Measured at 42,940 bytes / 34 tools against a provisioned 54,632 / 41: 11,692 bytes, 21.4%,
     * off every request of every turn on a box that has neither surface - and off the head of the
     * cached prefix, which is the most expensive place in the request to be carrying anything.
     *
     * 43,000 was that measurement with 60 bytes of headroom, which is a ceiling and not a licence,
     * and it is the number to lower again if anything else leaves this wire. It is a *ceiling* and
     * not an equality on purpose: a tool added to the catalogue that a bare box can genuinely
     * honour should land here, and be paid for here, exactly as it is above.
     *
     * Which is exactly what then happened. file_patch's `move` operation is 317 bytes and a bare
     * box honours it in full - there is nothing about moving a block that wants a browser or a
     * screen - so it is paid for on this wire too, and the number is 43,300 against a measured
     * 43,257. The gap to the provisioned wire is unchanged at 11,692, because the same 317 bytes
     * landed on both.
     *
     * And again for the line-addressed editor that replaced the quoted one, on the same terms: it
     * is 509 bytes, a bare box honours every operation in it - editing by line number wants neither
     * a browser nor a screen - so it is paid for here too. 43,800 against a measured 43,766. The
     * gap to the provisioned wire is still exactly 11,692, because the same 509 bytes landed on
     * both, which is the property that keeps this number honest: it moves for what a bare box
     * gained, never for what a provisioned box was spared.
     *
     * And again for the reach, on exactly those terms: `session_search`'s `id` is 160 bytes, a bare
     * box honours it in full - dereferencing a stored result wants neither a browser nor a screen -
     * so it is paid for here too. 43,950 against a measured 43,908, up from 43,748. The gap to the
     * provisioned wire is still exactly 11,692, because the same 160 bytes landed on both.
     */
    /*
     * And again for long work, on exactly those terms: the two `shell` fields are 73 bytes, a bare
     * box honours both in full - a six-hour background job wants neither a browser nor a screen -
     * so they are paid for here too. 44,000 against a measured 43,981, up from 43,908. The gap to
     * the provisioned wire is still exactly 11,692, because the same 73 bytes landed on both.
     */
    // Repeated decision factors measure 50,412 bytes without computer surfaces.
    expect(Buffer.byteLength(JSON.stringify(bare))).toBeLessThan(50_500);
    // The other direction, and the one that fails silently. A gate wired to nothing returns the
    // unconditional constant on every box; this is the assertion that would go red if it did.
    expect(Buffer.byteLength(JSON.stringify(bare))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(provisioned)) - 11_000
    );
  });

  it('withdraws nothing on an answer it could not believe', () => {
    /*
     * The failure direction, stated as a bound rather than as prose. Every way of not getting an
     * answer - an unreachable runner, a timeout, an older runner with no such route, a body that
     * is not the declared shape - lands on `unknown`, and unknown describes everything.
     *
     * The two ways of being wrong are not the same size. Describing a surface the box lacks costs
     * bytes and one honest failure the model can read; withdrawing a surface the box has hides a
     * capability the owner paid for and leaves nothing behind to say it existed.
     */
    expect(surfaceDescribable('unknown')).toBe(true);
    expect(surfaceDescribable('available')).toBe(true);
    expect(surfaceDescribable('absent')).toBe(false);
    for (const surfaces of [
      UNKNOWN_SURFACES,
      { browser: 'unknown', desktop: 'absent' },
      { browser: 'absent', desktop: 'unknown' }
    ] as WorkspaceSurfaces[])
      for (const tool of compacted(surfaces))
        expect(
          provisioned.some((entry) => entry.name === tool.name),
          tool.name
        ).toBe(true);
    expect(compacted(UNKNOWN_SURFACES)).toHaveLength(provisioned.length);
  });

  it('leaves the specialist wire where it was, on every shape', () => {
    // The specialist holds no browser or desktop tool at all, so its surface is invariant by
    // construction. Asserted rather than assumed: a name added to `specialistToolNames` that is
    // also in one of the two bags would make a quarantined investigator's wire depend on the box.
    const names = agentToolsFor('specialist').map((tool) => tool.name);
    for (const surfaces of [
      { browser: 'available', desktop: 'available' },
      { browser: 'absent', desktop: 'absent' },
      UNKNOWN_SURFACES
    ] as WorkspaceSurfaces[])
      expect(agentToolsFor('specialist', surfaces).map((tool) => tool.name)).toEqual(names);
  });
});

/*
 * What a box is sent about services it has not connected, which is the third fact and the only one
 * that narrows a tool instead of removing one.
 *
 * `connector_action` declares twenty-four actions across five kinds of connection and was sent
 * whole to every box that had connected any one of them. `executeConnectorAction` in @athanor/core
 * refuses an action whose `kind` is not the connector's - "Action does not match this connector",
 * thrown before a scope is read or a credential is opened - so on a mailbox-and-calendar box the
 * eleven GitHub, WebDAV and MCP actions were not unlikely calls, they were impossible ones,
 * described at the head of the cached prefix on every request of every task.
 *
 * Two properties have to hold together or this is a capability withdrawal wearing a gate's
 * clothes, and both are asserted below rather than argued: nothing an owner CAN reach may leave
 * the wire, and everything an owner cannot reach must.
 */
describe('the wire a box is sent about the services it has actually connected', () => {
  const compacted = (kinds: ConnectorKind[]) => [
    ...agentToolsFor('lead', UNKNOWN_SURFACES, kinds),
    COMPACT_CONTEXT_TOOL
  ];
  const everything = [...agentToolsFor(), COMPACT_CONTEXT_TOOL];
  const actionsOf = (tools: typeof everything): string[] =>
    (
      tools.find((tool) => tool.name === 'connector_action')?.parameters.properties as
        | { action?: { enum?: string[] } }
        | undefined
    )?.action?.enum ?? [];
  const inputOf = (tools: typeof everything) =>
    (
      tools.find((tool) => tool.name === 'connector_action')?.parameters.properties as
        | { input?: { description?: string; properties?: Record<string, unknown> } }
        | undefined
    )?.input;

  it('omits connector calls when the owner has no connections', () => {
    const names = agentToolsFor('lead', undefined, []).map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('connector_action');
    expect(names).not.toContain('connector_list');
  });

  it('describes every action when connection availability is unknown', () => {
    expect(actionsOf(agentToolsFor())).toEqual(Object.keys(connectorActions));
  });

  it('withdraws nothing from a box that has connected every kind', () => {
    // The half that would look like success while capability fell. Byte-identical, not merely the
    // same names: the enum, the per-action sentence and the field bag are all rebuilt here, and a
    // rebuild that moved one comma would be a cache miss the owner gets nothing for.
    const all = compacted(ConnectorKind.options);
    expect(JSON.stringify(all)).toBe(JSON.stringify(everything));
  });

  it('sends exactly the actions the connected kinds can run, and every field they take', () => {
    /*
     * Derived from `connectorActions` on both sides, so this cannot pass by agreeing with a copy.
     * The forward direction is the saving; the backward direction is the one that matters, because
     * an action or a field silently dropped is a capability deleted and would look identical to a
     * gate working.
     */
    for (const kinds of [
      ['imap'],
      ['caldav'],
      ['github'],
      ['webdav'],
      ['mcp_http'],
      ['google'],
      ['microsoft'],
      ['google', 'microsoft'],
      ['imap', 'caldav'],
      ['imap', 'caldav', 'github']
    ] as ConnectorKind[][]) {
      const label = kinds.join('+');
      const sent = compacted(kinds);
      const reachable = Object.entries(connectorActions)
        .filter(([, definition]) => definition.kinds.some((kind) => kinds.includes(kind)))
        .map(([name]) => name);
      expect(actionsOf(sent), label).toEqual(reachable);
      const input = inputOf(sent);
      // Every reachable action is still named where the model finds out what shape it takes, and
      // nothing that cannot be reached is.
      for (const name of Object.keys(connectorActions))
        expect(
          new RegExp(`(?<![a-z_])${name}:`).test(input?.description ?? ''),
          `${label} / ${name}`
        ).toBe(reachable.includes(name));
      // And every field one of them takes is still declared. Read off the full bag rather than
      // listed here: a field this filter dropped while an action still needed it would be a call
      // the model cannot make and a refusal it cannot read a reason out of.
      const full = inputOf(everything)?.properties ?? {};
      const kept = Object.keys(input?.properties ?? {});
      for (const field of kept) expect(Object.keys(full), `${label} / ${field}`).toContain(field);
      expect(kept, label).toEqual(Object.keys(full).filter((field) => kept.includes(field)));
    }
  });

  it('holds a connected box under a ceiling of its own', () => {
    /*
     * Measured through `agentToolsFor` against a fully connected 55,458 / 41 tools:
     *
     *   mailbox and calendar   54,165   -1,293
     *   mailbox alone          52,947   -2,511
     *   calendar alone         51,430   -4,028
     *   GitHub alone           51,063   -4,395
     *   WebDAV alone           50,448   -5,010
     *   one MCP server         50,389   -5,069
     *   all five               55,458        0
     *
     * A mailbox and a calendar is the pairing the product leads with, so it is the one bounded
     * here: 54,200 against a measured 54,165, which is 35 bytes of headroom and a ceiling rather
     * than a licence. It moves for what a mailbox-and-calendar box gained, never for what a box
     * without GitHub was spared - the same rule the bare-box ceiling above is kept by.
     *
     * NOT bounded here, and measured so the next wave does not have to: narrowing by granted
     * SCOPE as well as by kind. `executeConnectorAction` refuses on scope two lines after it
     * refuses on kind and just as hard, and the owner chooses read-only or send when they connect
     * (`apps/web/src/connector-forms.ts`), so a read-only mailbox and calendar would go to 52,071
     * - 2,094 bytes further. It is not taken because of where the model finds out what it is
     * missing: `connector_list`'s resident description names all five kinds, so a kind absent from
     * the enum is still discoverable, and there is no equivalent resident line for a scope. How
     * often an owner grants read-only is not measured anywhere in this repository, and that
     * measurement - not this argument - is what should decide it.
     */
    const mailAndCalendar = compacted(['imap', 'caldav']);
    // Raised by the same 160 bytes as the two ceilings above and for the same reason: the reach is
    // on every wire, because a box with a mailbox connected has the same stored results behind its
    // memories as one without. 54,307 measured, up from 54,147. Then by the same 73 as those two
    // ceilings, on the same rule: `shell` is on every wire, so a box with a mailbox connected can
    // start a six-hour background job exactly as one without can. 54,380 measured.
    // Repeated decision factors measure 59,846 bytes with mail and calendar.
    expect(Buffer.byteLength(JSON.stringify(mailAndCalendar))).toBeLessThan(59_900);
    // The other direction, and the one that fails silently. A gate wired to nothing returns the
    // unconditional catalogue on every box; this is the assertion that would go red if it did.
    expect(Buffer.byteLength(JSON.stringify(mailAndCalendar))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(everything)) - 1_200
    );
  });

  it('leaves every tool but connector_action exactly where it was', () => {
    // The blast radius, bounded. This gate reshapes one entry and must not touch the order, the
    // count or the bytes of anything else - the array is the head of the cached prefix, and a tool
    // that moved position would end the common prefix at that point on every connected box.
    const narrowed = compacted(['imap']);
    expect(narrowed.map((tool) => tool.name)).toEqual(everything.map((tool) => tool.name));
    for (const [at, tool] of narrowed.entries())
      if (tool.name !== 'connector_action')
        expect(JSON.stringify(tool), tool.name).toBe(JSON.stringify(everything[at]));
  });

  it('declares a field for every action and an action for every field', () => {
    /*
     * The set equality the per-action table rests on, and the one thing the compiler cannot check.
     *
     * `CONNECTOR_ACTION_INPUTS` is a total `Record<ConnectorAction, ...>`, so an action added to
     * @athanor/core cannot compile until somebody says what it takes. What no type can say is that
     * the fields it names are the fields the bag declares: a typo would orphan a field on every
     * box at once, and a field no action reaches is 40-odd bytes nobody can use.
     *
     * Proved by construction rather than by listing: the union of the fields reachable from every
     * action is exactly the bag the fully connected box is sent.
     */
    const full = Object.keys(inputOf(everything)?.properties ?? {});
    const union = new Set(
      Object.keys(connectorActions).flatMap((name) =>
        Object.keys(
          inputOf(compacted([...connectorActions[name as keyof typeof connectorActions].kinds]))
            ?.properties ?? {}
        )
      )
    );
    expect([...union].sort()).toEqual([...full].sort());
    expect(full.length).toBeGreaterThan(0);
  });

  it('gives each action the fields its own schema accepts, not its neighbour’s', () => {
    /*
     * The question the set equality above cannot ask, and the one a per-action table has to be
     * held to.
     *
     * That test compares the UNION of the fields reachable from every action against the bag, so a
     * field assigned to the wrong action passes it whenever a sibling of the same kind reaches the
     * field anyway - which is nearly always, because the narrowing is by kind. Measured: the first
     * version of `calendar_update_event` named `calendarUrl` and `attendees`, both refused by the
     * Zod object that parses that action and the second refused again in prose by the executor
     * ("this action cannot name an attendee"), and it cost exactly nought bytes on every box,
     * because `calendar_read_range` and `calendar_create_event` reach both.
     *
     * So this reads the schema that actually decides. Thirteen of the twenty-four; the other
     * eleven are behind an unexported union in @athanor/core and are named as unchecked rather
     * than quietly skipped.
     */
    const accepted = new Map<string, string[]>();
    for (const schema of [...mailConnectorActionInputs, ...accountConnectorInputs]) {
      const shape: Record<string, unknown> = schema.shape;
      const name = (shape.action as { value: string }).value;
      accepted.set(
        name,
        Object.keys(shape).filter((field) => field !== 'action')
      );
    }
    expect(accepted.size).toBe(mailConnectorActionInputs.length + accountConnectorInputs.length);
    expect(accepted.size).toBeGreaterThan(0);
    // The one field declared here that no connector schema will ever accept, named so that it
    // stays a decision. `saveTo` is stripped before the connector layer sees it and is honoured by
    // the workspace write route instead, which is what the entry's own comment says.
    const beyondTheSchema: Record<string, string[]> = {
      mail_read_attachment: ['saveTo'],
      account_mail_attachment: ['saveTo']
    };
    for (const [name, fields] of accepted) {
      const declared = CONNECTOR_ACTION_INPUTS[name as keyof typeof CONNECTOR_ACTION_INPUTS].fields;
      expect([...declared].sort(), name).toEqual(
        [...fields, ...(beyondTheSchema[name] ?? [])].sort()
      );
    }
    // And the eleven that cannot be checked this way are eleven, so this test notices the day the
    // union is exported or an action moves kind.
    expect(Object.keys(connectorActions).length - accepted.size).toBe(11);
  });

  it('never sends a connected box an action list with nothing in it', () => {
    /*
     * The failure the heading table's totality is really guarding, stated where it can be seen.
     *
     * `connectorActionTool` is handed the actions of the connected kinds, so a kind carrying no
     * actions narrows the enum to empty - and the tool is still described, still costs its
     * description, and can no longer be called at all. The type only says every heading names a
     * real kind; nothing types the other direction, which is why it is asserted here over the
     * enum @athanor/contracts actually declares rather than over a list written beside it.
     */
    for (const kind of ConnectorKind.options) {
      const sent = actionsOf(compacted([kind]));
      expect(sent.length, kind).toBeGreaterThan(0);
      // And every one of them is described, which is what a missing heading would take away
      // without touching the enum.
      const description = inputOf(compacted([kind]))?.description ?? '';
      for (const action of sent) expect(description, `${kind} / ${action}`).toContain(`${action}:`);
    }
  });
});

/*
 * The wire is two surfaces, not one, and the smaller of them is a security boundary.
 *
 * The ceiling above measures what the lead is sent. It is the larger number and the one the owner
 * pays on every step, but it is not the only one: `runDelegateMission` builds an isolated read-only
 * specialist and sends it a ninth of that. The two figures belong in the same file because the
 * pressure to demote a tool off the lead's wire is exactly the pressure that would blind the
 * specialist, and until this block existed nothing put them in front of the same reader.
 *
 * Measured when this block was written: lead 40 tools / 55,113 bytes (55,782 with the compaction
 * tool the loop adds), specialist 9 tools / 7,431 bytes. The specialist's surface did not change
 * when it moved out of delegate.ts - it is byte-identical, asserted below, because the array a
 * provider caches must not move for a refactor.
 */
describe('the wire surface each audience is sent', () => {
  const lead = agentToolsFor();
  const specialist = agentToolsFor('specialist');
  const specialistNames = specialist.map((tool) => tool.name);

  it('sends the specialist a strict subset of what the lead can see', () => {
    // The lead is the union by construction. If a name ever appears only on the specialist's wire,
    // the delegate path has grown a capability the lead cannot audit or perform itself, and the
    // report it gets back would be unreproducible by the agent that has to act on it.
    const leadNames = new Set(lead.map((tool) => tool.name));
    for (const name of specialistNames) expect(leadNames.has(name), name).toBe(true);
    expect(specialist.length).toBeLessThan(lead.length);
  });

  it('gives the specialist nothing the harness itself classifies as a change', () => {
    /*
     * Derived, because enumerated did not hold. The only guard on this set was four names in
     * agent-run.test.ts - shell, file_write, browser_action, finish - and `file_patch`, whose whole
     * purpose is changing a file the specialist's own system prompt tells it it cannot change, went
     * straight through with all 1,145 worker tests green. A blocklist protects the names somebody
     * thought of.
     *
     * These are the two sets the containment property actually rests on, and both are consulted at
     * runtime rather than restated here. `isMutatingToolCall` decides whether a call takes a
     * workspace checkpoint and sets `mutatedBeyondProse`; `REPEATABLE_TOOLS` decides whether it is
     * safe to replay after an interrupted turn. A read-only investigator that fails either is not
     * read-only, whatever the allowlist is called.
     */
    for (const name of specialistNames) {
      expect(isMutatingToolCall(name), `${name} is classified as a change`).toBe(false);
      expect(REPEATABLE_TOOLS.has(name), `${name} is not safe to replay`).toBe(true);
    }
    // Named as well as derived, only because these four are the ones a future edit reaches for:
    // the shell is the whole reason the specialist is a containment path and not just a cheaper
    // model, and `finish` would let a quarantined agent close the owner's task.
    for (const name of ['shell', 'process', 'file_write', 'finish'])
      expect(specialistNames).not.toContain(name);
  });

  it('still gives it a way to read the workspace and the web', () => {
    // The non-vacuity half. Every assertion above passes on an empty set, and an empty set is how
    // this test would look if the tier were ever filtered by a name that no longer exists - which
    // is how the catalogue's own nested-description walk once passed while finding nothing.
    expect(specialistNames).toContain('file_read');
    expect(specialistNames).toContain('web_search');
    expect(specialistNames).toContain('parallel_web_read');
    expect(specialist.length).toBeGreaterThan(4);
  });

  it('costs the specialist a ninth of what the lead pays, and did not move when it moved', () => {
    // The ceiling for the smaller audience, on the same terms as the one above: it moves for a
    // capability and not for prose. 7,431 measured, and the headroom is deliberately thin because
    // nine read-only tools is what this agent is.
    expect(Buffer.byteLength(JSON.stringify(specialist))).toBeLessThan(7_600);
    // Byte-identical to the array delegate.ts used to build for itself: the same nine entries in
    // the same order, so the refactor cannot have moved a cached prefix. Order is the point - core
    // set first, then declaration order, exactly as the lead's is.
    expect(specialistNames).toEqual([
      'files_list',
      'file_read',
      'session_search',
      'web_search',
      'document_read',
      'document_search',
      'code_search',
      'repo_overview',
      'parallel_web_read'
    ]);
  });

  it('keeps the four readers the specialist depends on out of any lead-side demotion', () => {
    /*
     * The record of a refusal, kept where the next person to propose it will meet it.
     *
     * `files_list`, `repo_overview`, `document_read` and `document_search` have been proposed for
     * removal from the lead's wire on the grounds that `shell` substitutes for them - about 2.8 kB.
     * It does not substitute. `shell` is in neither of the sets asserted above, so the same read
     * arriving through it becomes a change: a workspace checkpoint, `mutatedBeyondProse` set, and a
     * completion-evidence rule that now wants a check performed after it. That is the defect the
     * comment on `audio_read` in write-classification.ts records happening once already, for one
     * voice memo.
     *
     * So the assertion is not that the four are present - it is that the substitution being offered
     * is false, checked against the classifier rather than against a sentence in a design document.
     */
    for (const name of ['files_list', 'repo_overview', 'document_read', 'document_search']) {
      expect(specialistNames).toContain(name);
      expect(isMutatingToolCall(name)).toBe(false);
    }
    expect(isMutatingToolCall('shell', { executable: 'ls', args: ['-la'] })).toBe(false);
    // The half that matters: the shell the model is actually told to reach for whenever it needs a
    // pipe, a glob or a redirect. Every one of those reads is a change.
    expect(isMutatingToolCall('shell', { executable: 'bash', args: ['-lc', 'ls -la'] })).toBe(true);
    expect(REPEATABLE_TOOLS.has('shell')).toBe(false);
  });
});

describe('the catalogue as the model reads it', () => {
  it('gives every tool a distinct name and a description inside the size budget', () => {
    // Named for what it proves. It used to be called "a description that survives being read
    // alone", which it never checked: eighty-one repeated characters passed it, and both the
    // notify limit and the video kind that could not be generated passed it too.
    const names = agentTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of agentTools) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      // Short enough to skim, long enough to say what the tool is for and where its edge is.
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
      expect(tool.description.length, tool.name).toBeLessThan(3_000);
    }
  });

  it('states the retrieval bounds the runtime enforces rather than a second copy of them', () => {
    /*
     * A schema bound is a promise, and the only one the model can see. Both retrieval tools were
     * making promises nothing kept.
     *
     * `session_search` advertised `maximum: 50` against a `MEMORY_SESSION_SEARCH_MAX_RESULTS` of
     * 30, which is the worst shape this defect takes: the model asks for fifty, is given thirty
     * without being told, reads `conversations: 14` off the truncated set and reports fourteen to
     * the owner as the whole history (ATH-165). Its `taskId` also offered "search or browse", and
     * a call with a task and no query throws `session_search_query_empty` before `taskId` is even
     * read - there is no browse mode and there never was.
     *
     * `memory_recall` wrote both of its item bounds out as literals, under a comment at the handler
     * claiming they were applied "against the store's own ceilings rather than here, so the tool
     * schema and the retrieval agree by construction instead of by two copies of the same numbers"
     * (ATH-164). They are interpolated now, so the two cannot drift and no eighth `copiedConstants`
     * entry is needed to notice if they did.
     */
    const schema = (
      name: string
    ): { additionalProperties?: unknown; properties: Record<string, Record<string, unknown>> } =>
      agentTools.find((tool) => tool.name === name)?.parameters as never;

    const schemaOf = (name: string): Record<string, unknown> =>
      agentTools.find((tool) => tool.name === name)?.parameters as never;

    const search = schema('session_search');
    expect(search.properties.maxResults?.maximum).toBe(MEMORY_SESSION_SEARCH_MAX_RESULTS);
    // No default here: the number the loop passes when the model omits this lives at the call
    // site, and a third copy could only ever drift away from it.
    expect(search.properties.maxResults).not.toHaveProperty('default');
    expect(String(search.properties.taskId?.description)).not.toMatch(/browse/);
    /*
     * The arm the description promises, declared where a model can reach it.
     *
     * "then optionally inspect matching messages around a result" was resident, paid for, and
     * false: `session_search` returned an id and accepted none. The same shape as the "or browse"
     * claim the line above holds down, and it stood for longer.
     *
     * `required` is gone with it. A reach carries an id and no query, so `['query']` would have
     * been the next version of the same false statement - and a call carrying neither is still
     * refused, in words, by `searchMemorySessions`.
     */
    expect(search.properties).toHaveProperty('id');
    expect(schemaOf('session_search')).not.toHaveProperty('required');
    const promise = agentTools.find((tool) => tool.name === 'session_search')?.description ?? '';
    expect(promise).toContain('set id to');
    // Which id, not just that there is one: the two a match carries reach different halves.
    expect(promise).toContain('episodeId');
    expect(promise).not.toMatch(/optionally inspect/);

    const recall = schema('memory_recall');
    expect(recall.properties.maxItems?.maximum).toBe(MEMORY_RECALL_ITEM_CEILING);
    expect(recall.properties.maxItems?.default).toBe(MEMORY_RECALL_MAX_ITEMS);
    // The budget is fixed and no longer pretends otherwise. `budgetTokens` was clamped between 256
    // and a 4,000 ceiling in packages/core and was never declared here - and with
    // additionalProperties false the model could not have sent it if it had tried.
    expect(recall.additionalProperties).toBe(false);
    expect(recall.properties).not.toHaveProperty('budgetTokens');
  });

  it('states code_search’s two thresholds as the numbers the arm actually applies', () => {
    /*
     * The same defect class as the two above, in the one place it could not be closed the same way.
     *
     * `session_search` and `memory_recall` interpolate their bounds out of the modules that enforce
     * them, so the catalogue and the runtime cannot drift. `code_search` cannot: `tools/repository.ts`
     * imports `agent.js`, `agent.js` imports `tools.js`, and `tools.js` is this catalogue - so an
     * import from here into the arm closes a cycle, and whether `agentTools` reads an initialised
     * constant or throws on the temporal dead zone would come down to which module the process
     * loaded first. A test importing both has no such ordering: nothing here is evaluated while
     * either module is still initialising.
     *
     * So the drift is caught here instead. The description is the only place a model can learn what
     * this tool refuses before it spends a call finding out, and a stated refusal that fires at a
     * different number than the stated one is worse than no sentence at all.
     */
    const description = agentTools.find((tool) => tool.name === 'code_search')?.description ?? '';
    expect(description).toContain(`Past ${CODE_SEARCH_FILE_CEILING} matching files`);
    /*
     * The collapse threshold is stated as "a few dozen" rather than as a figure, on purpose: it is
     * a harness bound the model has no reason to tune against, and a model that knows the exact
     * line it will not be collapsed under has been handed an incentive to sit just below it.
     * Vague prose still has to be true, though, which is all this asserts - a threshold moved to
     * two hundred makes the sentence a lie, and this is where that is noticed.
     */
    expect(description).toContain('more than a few dozen lines');
    expect(CODE_SEARCH_COLLAPSE_LINES).toBeGreaterThanOrEqual(24);
    expect(CODE_SEARCH_COLLAPSE_LINES).toBeLessThan(60);
    /*
     * And the field is declared as what it adds, never as what it turns off. A wide result collapses
     * whether `summary` is set or not, so a description promising it as a switch would be the
     * `session_search` defect again in a boolean: a bound the model believes it set.
     */
    const summary = (
      agentTools.find((tool) => tool.name === 'code_search')?.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties.summary;
    expect(summary?.description).toMatch(/^Return the per-file rows even for/);
    expect(String(summary?.description)).not.toMatch(/instead of|rather than|turn off|disable/i);
  });

  it('names nothing in a description that the schemas do not declare', () => {
    // The descriptions are the only map the model has, and they cross-reference constantly:
    // "use parallel_web_read", "actions from browser_snapshot", "mode keys", "status in_progress".
    // A tool renamed or a variant removed leaves every one of those pointing at nothing, which is
    // worse than a thin description because the model believes it. So every snake_case token in
    // every description has to resolve to something actually declared - a tool name, a connector
    // action, a parameter, or a value one of the enums accepts.
    //
    // Declared is not the same as sent, and the gap between them is where the fabricated research
    // answer came from: `web_search` was declared here and withdrawn from the catalogue of every run
    // on the provider's route, so four descriptions went on pointing at a tool the model was not
    // holding. That half is asserted against the catalogue as it actually goes out, in
    // agent-run.test.ts under "the web route a run is pinned to".
    const declared = new Set<string>([
      ...agentTools.map((tool) => tool.name),
      ...Object.keys(connectorActions),
      'compact_context'
    ]);
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const entry of node) collect(entry);
        return;
      }
      const record = node as Record<string, unknown>;
      const properties = record.properties;
      if (properties && typeof properties === 'object')
        for (const key of Object.keys(properties)) declared.add(key);
      if (typeof record.const === 'string') declared.add(record.const);
      if (Array.isArray(record.enum))
        for (const value of record.enum) if (typeof value === 'string') declared.add(value);
      for (const value of Object.values(record)) collect(value);
    };
    for (const tool of agentTools) collect(tool.parameters);

    // Counted, because both collections this walks can go empty without anything else changing:
    // a catalogue that stopped being assembled, or descriptions that stopped containing a single
    // snake_case cross-reference. Either one satisfies the loops below in no time at all and
    // reports that every name in every description resolves.
    let resolved = 0;
    for (const tool of agentTools)
      for (const token of tool.description.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? []) {
        resolved += 1;
        expect(
          declared.has(token),
          `${tool.name} names "${token}", which no tool, connector action, parameter or enum declares`
        ).toBe(true);
      }
    expect(resolved).toBeGreaterThan(0);
  });

  it('prices a generation itself instead of believing the number the model sent', () => {
    // estimatedCostUsd was a required parameter, and both the approval card and the tool result
    // quoted whatever arrived in it. A call carrying 0 spent the owner's money with no card.
    const generate = agentTools.find((tool) => tool.name === 'generate_media');
    expect(Object.keys((generate?.parameters.properties ?? {}) as object)).not.toContain(
      'estimatedCostUsd'
    );
    const image = { kind: 'image', prompt: 'A logo', modelId: 'x', width: 1024, height: 1024 };
    // One image is a cent and a half: below the ceiling, and no card - which is why the ceiling is
    // cumulative rather than per call.
    const mediaModel = resolvedMediaModel('image', {
      image: mediaOption({ id: 'fixture/image', usdPerImage: 0.015, priceSource: 'provider' })
    });
    expect(approvalRequirement('generate_media', image, 'balanced', { mediaModel })).toBeNull();
    const card = approvalRequirement('generate_media', image, 'balanced', {
      mediaCommittedUsd: 0.3,
      mediaModel
    });
    expect(card?.sideEffect).toBe('external_reversible');
    expect(card?.preview).toContain('already spent about $0.30');
    // And the model saying it is free changes nothing, because it is not asked.
    expect(
      approvalRequirement('generate_media', { ...image, estimatedCostUsd: 0 }, 'balanced', {
        mediaCommittedUsd: 0.3,
        mediaModel
      })?.sideEffect
    ).toBe('external_reversible');
  });

  it('prices the generation against the model the owner actually chose', () => {
    // The two ids in the manifest used to be the whole of the answer in both the pricer and the
    // dispatch arm, so an owner who picked a route ten times the price still read the default's
    // figure on the card they were about to approve.
    const image = { kind: 'image', prompt: 'A logo', width: 1000, height: 1000 };
    const expensive = resolvedMediaModel('image', {
      image: mediaOption({
        id: 'openrouter/studio/canvas-1',
        displayName: 'Canvas 1',
        usdPerImage: 0.4
      })
    });
    const card = approvalRequirement('generate_media', image, 'balanced', {
      mediaModel: expensive
    });
    expect(card?.preview).toContain('Canvas 1');
    expect(card?.preview).toContain('$0.400');
  });

  it('asks every time for a route whose price the provider never published', () => {
    const unpriced = resolvedMediaModel('image', {
      image: mediaOption({ id: 'openrouter/studio/quiet-1', priceSource: 'unknown' })
    });
    expect(unpriced.priceKnown).toBe(false);
    // A cumulative threshold cannot govern a number nobody stated, and comparing it against an
    // invented one is how spend approval stops meaning anything. So the card is raised on the first
    // generation rather than on the eighteenth.
    const card = approvalRequirement(
      'generate_media',
      { kind: 'image', prompt: 'A logo', width: 1000, height: 1000 },
      'balanced',
      { mediaModel: unpriced, mediaCommittedUsd: 0 }
    );
    expect(card?.sideEffect).toBe('external_reversible');
    expect(card?.preview).toContain('publishes no price');
  });

  it('speaks with the chosen route’s own voice, and with none when it names none', () => {
    // The voice was a constant belonging to one specific speech model. The moment the model became
    // the owner's choice, sending it to any other route would have asked for a voice from a
    // different model's list.
    expect(resolvedMediaModel('audio').voice).toBeUndefined();
    expect(
      resolvedMediaModel('audio', {
        audio: mediaOption({
          id: 'fixture/audio',
          modality: 'audio',
          defaultVoice: 'fixture-voice'
        })
      }).voice
    ).toBe('fixture-voice');
    expect(
      resolvedMediaModel('audio', {
        audio: mediaOption({
          id: 'openrouter/studio/speaker-1',
          modality: 'audio',
          usdPerMillionCharacters: 1
        })
      }).voice
    ).toBeUndefined();
  });

  it('will not price one modality against a route stored for the other', () => {
    // A speech route standing in for an image would be priced per million characters against a
    // request measured in pixels, and the owner would first see it on an invoice.
    const crossed = resolvedMediaModel('image', {
      image: mediaOption({ id: 'openrouter/studio/speaker-1', modality: 'audio' })
    });
    expect(crossed.modelId).toBe('');
    expect(crossed.priceKnown).toBe(false);
  });

  it('never describes the computer as somebody else’s', () => {
    // It is the owner's own Linux host. Hosted-service vocabulary survived here long after the
    // product it belonged to was removed, and the operating contract says the opposite one line
    // earlier - which is worse than either wording on its own.
    const prose = agentTools.map((tool) => JSON.stringify(tool)).join('\n');
    expect(prose).not.toMatch(/cloud comput|cloud desktop|cloud-workspace|cloud workspace/i);
    expect(prose).not.toMatch(/platform approval|machine hours|included active/i);
  });

  it('says where the edge is between each pair a model would otherwise confuse', () => {
    // Each of these is a real pair: two tools whose jobs overlap in one word, where a model with
    // only one of the descriptions in front of it would pick either. The arbitration clause has to
    // exist, and it has to be phrased "use <other>": that is the form a model reads as an
    // arbitration rule rather than as a claim about this tool.
    const description = (name: string): string =>
      agentTools.find((tool) => tool.name === name)?.description ?? '';
    const known = new Set(agentTools.map((tool) => tool.name));
    const clauseNaming = (tool: string, other: string): string | undefined =>
      description(tool)
        .split(/(?<=[.;])\s+/)
        .find((sentence) => new RegExp(`\\b${other}\\b`).test(sentence));

    const instead: ReadonlyArray<readonly [string, string]> = [
      ['file_read', 'document_read'],
      ['file_write', 'file_patch'],
      ['document_search', 'code_search'],
      ['document_search', 'session_search'],
      ['session_search', 'web_search'],
      // The pair a model is most likely to get wrong now: two tools with "memory" in the name over
      // two different stores - the short reviewed list already in context, and the retrieval store
      // the pack was drawn from.
      ['memory', 'memory_recall'],
      ['memory_recall', 'session_search'],
      ['memory_recall', 'document_search'],
      ['browser_snapshot', 'web_search'],
      ['browser_snapshot', 'read_elements'],
      ['web_search', 'document_search'],
      ['parallel_web_read', 'browser_action'],
      ['files_list', 'code_search'],
      ['files_list', 'repo_overview'],
      ['repo_overview', 'files_list'],
      ['file_write', 'publish_artifact'],
      ['desktop_observe', 'browser_snapshot'],
      ['desktop_action', 'browser_action'],
      ['delegate', 'coding_agent'],
      ['coding_agent', 'file_patch'],
      ['image_read', 'generate_media'],
      ['image_read', 'document_read']
    ];
    for (const [tool, other] of instead) {
      const clause = clauseNaming(tool, other);
      expect(clause, `${tool} never says when to use ${other} instead`).toBeDefined();
      // The scorer's own rule, applied here: a sentence that sends the reader to another tool is
      // dropped from this tool's score. One "use <tool>" is enough for the whole sentence, which
      // is why a single clause may go on to list three alternatives.
      const arbitrates = [...known].some(
        (name) => name !== tool && new RegExp(`\\buse\\s+${name}\\b`, 'i').test(clause ?? '')
      );
      expect(
        arbitrates,
        `${tool} points at ${other} in a sentence the scorer still counts for ${tool}: "${clause}"`
      ).toBe(true);
    }

    // The other relationship: not "instead of" but "and then". These name a step rather than an
    // alternative, so they belong in the referring tool's own score and only have to be there.
    /*
     * `['print_pdf', 'typst']` was the third pair here and it is deleted with the clause it
     * pinned, rather than kept as evidence the clause should have survived.
     *
     * What it protected - that a PDF whose pagination matters is typeset rather than captured from
     * a browser - has a better home and already occupies it: the operating contract states it, and
     * states it *gated* on this box actually having a document toolchain, pinned in both
     * directions in context.test.ts ("typeset with typst" present when provisioned, absent when
     * bare). The catalogue's copy was unconditional, so a box with no typst read in one request
     * that it has no document toolchain and that typst is the route for a PDF that matters. A pin
     * that holds an unconditional duplicate in place against a gated original is a ratchet.
     */
    const thenPairs: ReadonlyArray<readonly [string, string]> = [
      ['web_search', 'parallel_web_read'],
      ['shell', 'process']
    ];
    for (const [tool, other] of thenPairs)
      expect(clauseNaming(tool, other), `${tool} never mentions ${other}`).toBeDefined();
  });

  it('names only result fields the runner really ships, for the two surfaces that omit things', () => {
    /*
     * THE DEFECT THIS PROGRAMME HAS SHIPPED FIVE TIMES, caught from the description side.
     *
     * A tool description that names a field of its own result is the strongest thing this
     * catalogue says, because the model cannot check it: it reads "framesOmitted says how many did
     * not fit", finds no such key, and has no way to tell a field that is absent from a field that
     * is zero. Both omission clauses here were written AFTER the field existed - `nodesOmitted` on
     * `desktop_observe`, and `elementsOmitted`/`framesOmitted` on `browser_snapshot`, which the
     * browser lane shipped through `composeBrowserSnapshot` - and the previous catalogue wave
     * declined to write the second one precisely because the fields did not exist yet. This is what
     * keeps that decision from having to be made by memory next time.
     *
     * WHAT EACH ROW IS ANCHORED ON, because the two surfaces are not built the same way and an
     * anchor on the wrong literal is this check wearing the costume it exists to strip off.
     * `composeBrowserSnapshot` is a single funnel - all three snapshot returns in browser.ts go
     * through it and it names every key it emits - so its body is what the model receives. The
     * desktop has no such funnel: `snapshot()` in desktop.ts returns an object literal at three
     * places, and two of them are the fallbacks for a box without the GUI dependencies and for a
     * desktop held in secure input, both of which write `nodesOmitted: 0` as a CONSTANT. Anchoring
     * this row on the first `screenshotMimeType` in the file matched the first of those fallbacks,
     * and deleting `nodesOmitted: selected.omitted` from the real observation left this test green
     * - measured, by doing exactly that. It is anchored on `nodes: selected.kept` instead, which
     * appears once and only in the observation the agent actually reads.
     *
     * A field added to the payload TYPE and not to the literal is computed and never shipped, which
     * is the same defect from the other end and is asserted where those functions live.
     */
    const emitted = (tool: string, path: string, find: RegExp): string => {
      const body = readFileSync(new URL(path, import.meta.url), 'utf8').match(find);
      // A pattern that stops matching passes this test by comparing a description against nothing,
      // which is the costume every check in this repository has to be stopped from wearing.
      expect(
        body?.[1],
        `${tool}: ${path} no longer parses, so nothing is being compared`
      ).toBeTruthy();
      return body?.[1] ?? '';
    };
    const rows: ReadonlyArray<readonly [string, string, RegExp, readonly string[]]> = [
      [
        'browser_snapshot',
        '../../../services/workspace-runner/src/browser.ts',
        /composeBrowserSnapshot = [\s\S]*?return \{([\s\S]*?)\n {2}\};/,
        ['elementsOmitted', 'framesOmitted']
      ],
      [
        'desktop_observe',
        '../../../services/workspace-runner/src/desktop.ts',
        /nodes: selected\.kept,([\s\S]*?)screenshotBase64: screenshot\.toString/,
        ['nodesOmitted']
      ]
    ];
    for (const [tool, path, find, fields] of rows) {
      const description = agentTools.find((entry) => entry.name === tool)?.description ?? '';
      const payload = emitted(tool, path, find);
      for (const field of fields) {
        expect(description, `${tool} never names ${field}`).toContain(field);
        expect(
          payload,
          `${tool} names ${field}, which the runner does not put in the result`
        ).toContain(field);
      }
    }
  });
});

describe('the search route and the notice', () => {
  const tool = (name: string) => agentTools.find((entry) => entry.name === name);

  it('offers search as one call against the runner contract, not a browsing procedure', () => {
    const search = tool('web_search');
    expect(search?.parameters.required).toEqual(['query']);
    const properties = search?.parameters.properties as Record<
      string,
      { maximum?: number; maxLength?: number; default?: number }
    >;
    // These bounds are the runner's own: query max 500, limit 1..10 with a default of 10. A tool
    // that offered more would be rejected at the route rather than trimmed.
    expect(properties.query?.maxLength).toBe(500);
    expect(properties.limit?.maximum).toBe(10);
    expect(properties.limit?.default).toBe(10);
    expect(search?.description).toMatch(/parallel_web_read/);
  });

  it('tells the notice what it is for, and what it is not for', () => {
    const notify = tool('notify');
    expect(notify?.parameters.required).toEqual(['headline']);
    expect(notify?.description).toMatch(/unattended run says nothing at all unless you call this/);
    expect(notify?.description).toMatch(/do not call it to announce that a task finished/);
  });

  it('states both limits the box enforces, in the numbers it enforces them at', () => {
    // The description promised a per-turn limit that the counter never reset, so it was really per
    // conversation and an agent went permanently silent after three notices while being told the
    // current turn had sent them. There are genuinely two bounds - this turn's three, and the
    // store's ten for the whole conversation - and the model can only read what is written here,
    // so a change to either constant has to change this sentence.
    expect(MAX_NOTICES_PER_TURN).toBe(3);
    expect(MAX_AGENT_NOTIFICATIONS_PER_TASK).toBe(10);
    const notify = tool('notify')?.description ?? '';
    expect(notify).toMatch(/three in a turn/);
    expect(notify).toMatch(/counted again from zero on the turn after they reply/);
    expect(notify).toMatch(/ten notifications in the whole conversation/);
  });
});

describe('declared action shapes', () => {
  const properties = (name: string): Record<string, Record<string, unknown>> =>
    (agentTools.find((entry) => entry.name === name)?.parameters.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
  const verbs = (name: string): string[] => (properties(name).action?.enum ?? []) as string[];
  const verbGuide = (name: string): string => {
    const described = properties(name).action?.description;
    return typeof described === 'string' ? described : '';
  };

  it('names every browser field at the top level and every verb in the enum', () => {
    // These were twenty `oneOf` variants, each repeating
    // {"type":"object","additionalProperties":false,…,"properties":{"type":{"const":…}}} and each
    // repeating the selector and tabId definitions - about five kilobytes of scaffolding on every
    // request for twenty facts. The facts are what matter and they are all still here: one typed
    // declaration per field, one enum entry per verb, and the required set per verb in the enum's
    // own description.
    expect(Object.keys(properties('browser_action'))).toEqual(
      expect.arrayContaining([
        'action',
        'url',
        'selector',
        'text',
        'mode',
        'values',
        'paths',
        'key',
        'deltaX',
        'deltaY',
        'state',
        'urlIncludes',
        'timeoutMs',
        'activate',
        'x',
        'y',
        'response',
        'promptText',
        'path',
        'tabId',
        'actions',
        'purpose'
      ])
    );
    expect(verbs('browser_action')).toEqual([
      'navigate',
      'click',
      'double_click',
      'hover',
      'type',
      'select_option',
      'upload',
      'text_input',
      'press',
      'scroll',
      'wait_for',
      'back',
      'reload',
      'new_tab',
      'select_tab',
      'close_tab',
      'inspect_tab',
      'click_at',
      'dialog',
      'screenshot',
      'batch'
    ]);
    // The required set is the one thing that moved into prose, so it has to actually be there.
    for (const [verb, field] of [
      ['navigate', 'url'],
      ['click', 'selector'],
      ['type', 'text'],
      ['select_option', 'values'],
      ['upload', 'paths'],
      ['press', 'key'],
      ['scroll', 'deltaY'],
      ['click_at', 'x'],
      ['dialog', 'response'],
      ['screenshot', 'path'],
      ['batch', 'actions']
    ])
      expect(
        new RegExp(`\\b${verb}\\b[^.]*\\b${field}\\b`).test(verbGuide('browser_action')),
        `the browser action enum never says that ${verb} takes ${field}`
      ).toBe(true);
  });

  it('does not send the model at the wait the browser design bans by name', () => {
    /*
     * docs/design/browser-automation.md bans `waitForLoadState('networkidle')` from this codebase
     * twice and gives the reason both times - ":302 ... deprecated and wrong on SPAs with
     * long-polling/websockets", ":526 ... never fires on SPAs with websockets or long-polling".
     * The clause pinned here used to say the opposite, in the tool the model reads before it acts:
     * "with none of those three it waits for the network to go idle, WHICH IS WHAT A SINGLE-PAGE
     * APPLICATION NEEDS AFTER NAVIGATE". A banned mechanism recommended, for the one page shape it
     * is banned for. That is a description defect by this file's own rule, and it is worse than a
     * stale one: it steers every model on every turn into the arm's worst branch.
     *
     * The two directions are scoped DIFFERENTLY, and the difference is the whole of what makes
     * this hold. The POSITIVE checks are taken on the extracted clause, because scanning the guide
     * is how those saturate - the guide is 1.3 kB describing twenty verbs, so a
     * `toMatch(/selector/)` over it passes on `click`'s clause for ever after `wait_for` loses its
     * own. `waitForClause` starting empty is checked first for the same reason: a renamed verb
     * turns every positive assertion into a test of the empty string.
     *
     * The NEGATIVE check is taken on the WHOLE guide, and was moved there after it was measured
     * failing to fire. Sentence-scoped, it is evaded by a full stop: restoring the banned advice as
     * "...and timeoutMs. With none of those three it waits for the network to go idle, which is
     * what a single-page application needs after navigate." leaves `find(startsWith('wait_for'))`
     * holding only the fields half, and all 57 tests in this file passed with the ban's exact text
     * on the wire. Widening a negative is strictly stronger and cannot saturate the way a widened
     * positive does: absence everywhere is not satisfiable by another verb's clause. It costs
     * nothing here because the shipped guide names the network zero times - re-derive with
     * `verbGuide('browser_action').match(/network/gi)`, which is null - so any occurrence at all is
     * the regression, wherever in the guide someone puts it.
     *
     * It does not pin the replacement WORDING, and that is deliberate rather than lazy. The runner
     * default this describes is being changed in the same wave - `waitForLoadState('networkidle')`
     * out, `waitForLoadState('load')` plus a settle in - and a test that froze a sentence naming a
     * mechanism would have to be edited by whoever lands that, which is how a pin becomes a chore
     * and then a deletion. What has to stay true whatever the default becomes is both halves
     * below: the three conditions are named so the model can reach for one, and the fall-through
     * is not sold as the answer. Both hold against `load` exactly as they hold against `networkidle`
     * - an empty shell satisfies `load` too.
     */
    const waitForClause = verbGuide('browser_action')
      .split(/(?<=\.)\s+/)
      .find((sentence) => sentence.startsWith('wait_for'));
    expect(
      waitForClause,
      'the browser action enum no longer describes wait_for at all'
    ).toBeTruthy();
    for (const condition of ['selector', 'text', 'urlIncludes'])
      expect(
        waitForClause,
        `wait_for no longer names ${condition}, so the model cannot reach for a real condition`
      ).toContain(condition);
    // The whole of the ban, as a bound, and taken on the guide rather than the clause for the
    // reason above: this description has no business naming the network at all. Quiescence is not
    // a condition the model can reason about and it is not one this codebase is allowed to wait
    // on, so the honest fall-through is described by what it is worth, not by what it watches.
    expect(
      verbGuide('browser_action'),
      'the browser action guide is recommending network quiescence again - see docs/design/browser-automation.md:302 and :526'
    ).not.toMatch(/network/i);
  });

  it('names the desktop fields the description previously only alluded to', () => {
    expect(Object.keys(properties('desktop_action'))).toEqual(
      expect.arrayContaining([
        'action',
        'nodeId',
        'actionIndex',
        'text',
        'key',
        'direction',
        'amount',
        'x',
        'y',
        'width',
        'height',
        'button',
        'clicks',
        'fromX',
        'fromY',
        'toX',
        'toY',
        'durationMs',
        'milliseconds',
        'purpose'
      ])
    );
    expect(verbs('desktop_action')).toEqual([
      'invoke',
      'focus',
      'set_text',
      'text_input',
      'zoom',
      'press',
      'scroll',
      'click_at',
      'drag',
      'wait'
    ]);
    for (const [verb, field] of [
      ['invoke', 'nodeId'],
      ['set_text', 'text'],
      ['zoom', 'height'],
      ['drag', 'toY'],
      ['wait', 'milliseconds']
    ])
      expect(
        new RegExp(`\\b${verb}\\b[^.]*\\b${field}\\b`).test(verbGuide('desktop_action')),
        `the desktop action enum never says that ${verb} takes ${field}`
      ).toBe(true);
  });

  /*
   * The two enums above are hand-written, and the runner's unions are the thing that actually
   * answers a call. Either list can be edited without the other, and the failure is silent in both
   * directions: a verb declared here and absent there is a call the model will make and the runner
   * will refuse, spent round trip and all; a verb there and absent here is a capability the model
   * can never find out it has. Nothing compared them until now.
   *
   * Held as sets, both ways, rather than derived. Deriving would make the catalogue's order follow
   * the union's, and the order of these enums is prompt-prefix bytes that a provider caches - the
   * catalogue's order is fixed for the life of a task on purpose. The two orders do differ today
   * (`click_at` sits fifth in BrowserAction and eighteenth here; the desktop lists disagree from
   * the fourth entry on), and that difference carries no meaning to a validator, which is why it is
   * left alone and named here instead of quietly normalised away.
   */
  it('declares exactly the verbs the runner unions accept, in both directions', () => {
    const unionVerbs = (union: { options: readonly unknown[] }): string[] =>
      union.options.map(
        (option) => (option as { shape: { type: { value: string } } }).shape.type.value
      );
    // A read that stops working is this comparison silently passing on two empty sets.
    expect(unionVerbs(BrowserAction).length).toBeGreaterThan(15);
    expect(unionVerbs(DesktopAction).length).toBeGreaterThan(5);
    expect(new Set(verbs('browser_action'))).toEqual(new Set(unionVerbs(BrowserAction)));
    expect(new Set(verbs('desktop_action'))).toEqual(new Set(unionVerbs(DesktopAction)));
  });

  it('hands the runner the nested action its union is discriminated on', () => {
    // The wire shape is flat and the contract is not. If this remap ever stopped happening the
    // runner would reject every call, and `purpose` - the model's sentence for the owner's card -
    // would ride along into the request, which is not what it is for.
    expect(
      surfaceActionRequest({ action: 'navigate', url: 'https://example.test', purpose: 'Read it' })
    ).toEqual({ type: 'navigate', url: 'https://example.test' });
    expect(
      surfaceActionRequest({
        action: 'batch',
        purpose: 'Fill it in',
        actions: [
          { action: 'type', selector: '#a', text: 'Ada' },
          { action: 'click', selector: '#go' }
        ]
      })
    ).toEqual({
      type: 'batch',
      actions: [
        { type: 'type', selector: '#a', text: 'Ada' },
        { type: 'click', selector: '#go' }
      ]
    });
    // Nothing descends past one level: the runner's union has no nested batch, so a model that
    // sends one gets a step the runner refuses rather than a remap that recurses on its input.
    expect(
      surfaceActionRequest({
        action: 'batch',
        actions: [{ action: 'batch', actions: [{ action: 'click', selector: '#x' }] }]
      })
    ).toEqual({ type: 'batch', actions: [{ type: 'batch' }] });
  });

  it('declares each schedule kind, including the two fields the daily brief needs', () => {
    /*
     * Re-pointed at the flat property bag that replaced the five-variant `oneOf`, and re-pointed
     * rather than deleted because what it pins is a capability rather than an encoding: every one
     * of the five kinds is still reachable, and `daily` still names the two fields that decide
     * whether "brief me at eight" can be scheduled at all. The union frame it used to read is
     * gone; the kinds and those two fields are the part that has to survive an encoding.
     *
     * The per-kind required set is prose now, so it is asserted as prose - which is the honest
     * shape of the promise, since the wire no longer carries a required list per kind and
     * `TaskScheduleSpec` in @athanor/contracts is what refuses a spec that is missing one.
     */
    const schedule = agentTools.find((tool) => tool.name === 'schedule');
    const spec = (
      schedule?.parameters.properties as Record<
        string,
        { description?: string; properties?: Record<string, { enum?: string[] }> }
      >
    ).spec;
    expect(spec?.properties?.kind?.enum).toEqual(['once', 'interval', 'daily', 'weekly', 'cron']);
    expect(spec?.description).toMatch(/daily: timeZone and localTime/);
    expect(Object.keys(spec?.properties ?? {})).toEqual(
      expect.arrayContaining([
        'runAt',
        'everyMinutes',
        'timeZone',
        'localTime',
        'weekdays',
        'expression'
      ])
    );
    expect(schedule?.description).toMatch(/time zone/i);
  });

  it('accepts every kind it declares through the schema that actually decides', () => {
    /*
     * The flat bag is a wire encoding, not a validator: what a schedule may be is
     * `TaskScheduleSpec`, and this drives one spec of every declared kind through it so a kind
     * that the catalogue offers and the contract refuses cannot ship. It is the half the byte
     * measurement above cannot see - a saving that quietly withdrew `weekly` would pass the
     * ceiling and fail here.
     */
    const specs: Record<string, Record<string, unknown>> = {
      once: { kind: 'once', runAt: '2027-03-04T09:00:00.000Z' },
      interval: { kind: 'interval', everyMinutes: 60 },
      daily: { kind: 'daily', timeZone: 'Europe/London', localTime: '08:00' },
      weekly: {
        kind: 'weekly',
        timeZone: 'Europe/London',
        localTime: '08:00',
        weekdays: [1, 2, 3, 4, 5]
      },
      cron: { kind: 'cron', timeZone: 'Europe/London', expression: '0 8 * * 1-5' }
    };
    const schedule = agentTools.find((tool) => tool.name === 'schedule');
    const declared = (
      schedule?.parameters.properties as Record<
        string,
        { properties?: { kind?: { enum?: string[] } } }
      >
    ).spec?.properties?.kind?.enum;
    expect(Object.keys(specs)).toEqual(declared);
    for (const [kind, spec] of Object.entries(specs))
      expect(TaskScheduleSpec.parse(spec), kind).toMatchObject({ kind });
    // And the flat bag's own hazard, stated rather than assumed: a field belonging to another kind
    // is stripped by the union rather than fatal, which is the property that makes one bag safe
    // where five variants used to be.
    expect(
      TaskScheduleSpec.parse({
        kind: 'daily',
        timeZone: 'Europe/London',
        localTime: '08:00',
        everyMinutes: 60
      })
    ).toEqual({ kind: 'daily', timeZone: 'Europe/London', localTime: '08:00' });
  });
});

describe('the reach each publishing call has, and the card the floor raises for it', () => {
  /*
   * THE TRIPWIRE THAT SURVIVED THE MERGE IT WAS WRITTEN AGAINST. Read this before touching either
   * side of it.
   *
   * It stood here as a refusal. `publish_site` and `publish_preview` took the same required pair,
   * ran the same runner action and minted the same kind of token; 188 bytes of their two
   * descriptions went on telling the model which NAME to pick, and folding one into the other as a
   * `reach` argument was measured at about 450 bytes of a cached prefix. What blocked it was that
   * the approval floor could not see reach at all. Three branches in approval-policy.ts read the
   * tool NAME - the taint branch, the ordinary branch, and the review-only `asksBeforeEveryChange`
   * row - and a FOURTH read it in apps/web/src/approval-facts.ts to tell the owner, on the card
   * itself, who could reach the thing. Measured through `approvalRequirement` at 06b0493:
   *
   *   publish_site      review/balanced/autonomous  clean AND tainted -> external_consequential
   *   publish_preview   review                      clean -> workspace_write
   *   publish_preview   balanced/autonomous         clean -> NONE
   *   publish_preview   any mode                    tainted -> external_reversible
   *
   * and, for the merged shape with the floor left alone:
   *
   *   publish_preview {reach:'public'}   balanced (the default) and autonomous, clean -> NONE
   *
   * A tool that puts something on the public internet with no card at all in the default security
   * mode, silently, while context.ts told the model public publishing "always stops for the user's
   * approval". So the floor moved first and the merge came with it, in one change: the three
   * branches read `publishReachOfCall` and the card reads `args.reach`, and the two tools are one.
   *
   * WHAT THIS TEST IS NOW. The same table, keyed on reach instead of on a name, and BOTH rows are
   * still here because each is the other's counter-direction. A merge proved only for `public`
   * would be satisfied by carding every private preview in every mode, which is the card that
   * fires on everything and that this file's own floor says nobody reads. A merge proved only for
   * `private` is the defect above. The set below is asserted as an EXACT set, not a superset, for
   * the same reason it always was: a fourth publishing tool, or `publish_site` coming back, fails
   * here and the reader arrives at this comment.
   *
   * The precedent for the shape is in approval-policy.ts, where browser_action collapsed a
   * twenty-variant union onto a sibling field for about five kilobytes and every gate below kept
   * reading the fields it always read.
   */
  const declared = agentTools.map((tool) => tool.name).filter((name) => name.startsWith('publish'));

  it('declares exactly the two publishing tools the floor has branches for', () => {
    expect([...declared].sort()).toEqual(['publish_artifact', 'publish_preview']);
    // The reach the floor judges on has to be a declared, closed field or the model cannot ask for
    // the public one at all - and an undeclared argument is the shape this programme has shipped
    // five times: computed, and reachable by nothing.
    const preview = agentTools.find((tool) => tool.name === 'publish_preview');
    const reach = (preview?.parameters.properties as Record<string, { enum?: string[] }>).reach;
    expect(reach?.enum).toEqual(['private', 'public']);
    // Absent must be the NARROW reach on both sides. `publishesPublicly` in @athanor/contracts is
    // the single reader the floor and `tools/publishing.ts` share, so this is the one place the
    // default and the reader are checked to agree.
    expect(publishesPublicly(undefined)).toBe(false);
    expect(publishesPublicly('private')).toBe(false);
    expect(publishesPublicly('public')).toBe(true);
  });

  it('stops for the owner every time something is put on the public internet', () => {
    const args = { port: 8080, label: 'Demo', reach: 'public' };
    for (const mode of ['review', 'balanced', 'autonomous'] as const) {
      expect(approvalRequirement('publish_preview', args, mode, {})?.sideEffect, mode).toBe(
        'external_consequential'
      );
      // Not merely "still carded": the tainted path used to REPLACE the ordinary card rather than
      // sit above it, so a public deployment on the turn that had read a hostile page is exactly
      // where a downgrade would hide.
      expect(
        approvalRequirement('publish_preview', args, mode, { taintSources: ['a web page'] })
          ?.sideEffect,
        `${mode}, tainted`
      ).toBe('external_consequential');
    }
  });

  it('leaves the private tier free on a clean turn, which is what the merge must not lose', () => {
    // The other direction, and the reason the merge could not simply be done under the publish_site
    // name to keep the floor honest: that would card every private preview in every mode. This
    // file's own floor says a card that fires on everything is a card nobody reads.
    //
    // Driven with the reach spelled AND with it omitted, because the default is what almost every
    // real call will send and a table that only ever states the field would not notice the default
    // flipping.
    for (const args of [
      { port: 8080, label: 'Demo' },
      { port: 8080, label: 'Demo', reach: 'private' }
    ]) {
      expect(approvalRequirement('publish_preview', args, 'balanced', {})).toBeNull();
      expect(approvalRequirement('publish_preview', args, 'autonomous', {})).toBeNull();
      expect(approvalRequirement('publish_preview', args, 'review', {})?.sideEffect).toBe(
        'workspace_write'
      );
      expect(
        approvalRequirement('publish_preview', args, 'balanced', { taintSources: ['a web page'] })
          ?.sideEffect
      ).toBe('external_reversible');
    }
  });

  it('reads a reach it does not recognise as the narrow one, on both sides of the call', () => {
    /*
     * The floor and the arm must not be able to disagree, and this is the case where they could:
     * a `reach` the schema should have refused. Both call `publishesPublicly`, which is an equality
     * against the literal `public`, so a misspelling is private for the floor AND private for
     * `tools/publishing.ts` - the safe pairing, because the dangerous one is a floor reading
     * private on a call the arm publishes publicly. It is asserted rather than assumed because
     * "the schema stops it" is a promise about a different file.
     */
    const args = { port: 8080, label: 'Demo', reach: 'PUBLIC' };
    expect(approvalRequirement('publish_preview', args, 'balanced', {})).toBeNull();
    expect(approvalRequirement('publish_preview', args, 'review', {})?.action).toBe(
      'Create a private preview'
    );
  });
});

describe('the contract each answer is written to', () => {
  it('says where the answer goes and how long the card is', () => {
    const finish = agentTools.find((tool) => tool.name === 'finish');
    const properties = finish?.parameters.properties as Record<string, { description?: string }>;
    expect(properties.answer?.description).toMatch(/user-facing answer/);
    expect(properties.summary?.description).toMatch(/answer is omitted/);
    expect(properties.deliverables?.description).toMatch(/can now open/);
  });

  it('keeps memory governance on the memory tool, where it is read at the moment of use', () => {
    const memory = agentTools.find((tool) => tool.name === 'memory');
    expect(memory?.description).toMatch(/validUntil/);
    expect(memory?.description).toMatch(/never transient task state/);
  });
});

/**
 * The frame each path is read in, said on the two fields that had no description at all.
 *
 * The shell runs in `workspace/` and the file tools fold a bare name into `workspace/`, so a model
 * shown `cwd: {default: 'workspace'}` and `path: {type: 'string'}` had no way to know that the
 * string `workspace/probe/x` is a file to one tool and a directory that does not exist to the other.
 * Measured live: six of ten tasks, a third of their tool calls. The runner now reads a bare cwd from
 * `workspace/` and the shell result carries a note when a command trips on the prefix; these two
 * clauses are the resident half, kept to one sentence each because they sit in every request.
 */
describe('which frame a path is read in', () => {
  const properties = (name: string): Record<string, { description?: string }> =>
    (agentTools.find((tool) => tool.name === name)?.parameters.properties ?? {}) as Record<
      string,
      { description?: string }
    >;

  it('tells the shell that the command already runs inside workspace/', () => {
    const cwd = properties('shell').cwd?.description ?? '';
    expect(cwd).toMatch(/already runs inside workspace\//);
    expect(cwd).toMatch(/never workspace\/probe\/x/);
  });

  it('tells file_write that the bare name and the prefixed name are one file', () => {
    const path = properties('file_write').path?.description ?? '';
    expect(path).toMatch(/probe\/x and workspace\/probe\/x are the same file/);
  });
});
