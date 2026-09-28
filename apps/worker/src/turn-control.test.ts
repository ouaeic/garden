/**
 * The third question a turn asks between steps: is the request about to go out the one this turn's
 * own log accounts for?
 *
 * This repository's named signature defect is a control wired to nothing - a gate that computes the
 * right verdict and is never consulted, a set that is built and never read, a withdrawal decided
 * and then not applied. The audit found that shape more than thirty times, and every one of them was
 * found by a person reading two files against each other, because nothing in the product ever
 * re-derived what it was about to do from what it had recorded.
 *
 * The model request is the largest such control there is: it is the whole of what the model sees, it
 * is assembled from four independent inputs at three points in the loop, and a divergence in it is
 * silent - a provider answers a wrong window exactly as readily as a right one, and the answer looks
 * like an ordinary reply.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelMessage, ModelTool } from '@garden/model-gateway';
import { UNKNOWN_SURFACES, type ConnectorKind } from '@garden/contracts';
import { describe, expect, it } from 'vitest';
import { requestDerivationBreach } from './turn-control.js';
import { agentToolsFor } from './tool-catalogue.js';
import { COMPACT_CONTEXT_TOOL } from './context.js';

const window = (): ModelMessage[] => [
  { role: 'system', content: 'GARDEN RUNTIME CONTEXT (dynamic)' },
  { role: 'user', content: 'fix the importer' },
  {
    role: 'assistant',
    content: 'looking',
    toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pytest' } }]
  },
  { role: 'tool', content: 'exit 0', toolCallId: 'call-1' }
];

/**
 * Four tools out of the real catalogue, and real ones on purpose.
 *
 * These were `{ name: 'file_read' }` and three more like it - a shape the code under test can
 * never be handed, which is this programme's own "test-proves-nothing" class. It stopped being
 * harmless when the check grew a content comparison: `connector_action`'s definition is now built
 * per box from the kinds the owner has connected, so a stub with no `parameters` cannot exercise
 * the one class the comparison exists for.
 */
const tools = (): ModelTool[] =>
  ['file_read', 'file_write', 'shell', 'compact_context'].map((name) => {
    const tool = [...agentToolsFor(), COMPACT_CONTEXT_TOOL].find((entry) => entry.name === name);
    if (!tool) throw new Error(`${name} is no longer in the catalogue`);
    return tool;
  });

/** The real entry, which is the only thing whose content varying by box is the point. */
const connectorAction = (kinds?: ConnectorKind[]): ModelTool => {
  const tool = agentToolsFor('lead', UNKNOWN_SURFACES, kinds).find(
    (entry) => entry.name === 'connector_action'
  );
  if (!tool) throw new Error('connector_action is no longer in the catalogue');
  return tool;
};

const request = (
  overrides: Partial<Parameters<typeof requestDerivationBreach>[0]> = {}
): Parameters<typeof requestDerivationBreach>[0] => ({
  prepared: window(),
  rederived: window(),
  sent: tools(),
  entitled: tools(),
  reservedTokens: 1_200,
  reservedTokensOfSent: 1_200,
  ...overrides
});

describe('the request garden is about to send', () => {
  it('says nothing about a request the log derives', () => {
    expect(requestDerivationBreach(request())).toBeNull();
  });

  /**
   * The class the programme names: anything that edits `state.messages` after the window is
   * prepared - a taint notice, a pushback, a compaction re-entered on a retry path - produces a
   * request the persisted trajectory cannot account for, and a resume then replays a different
   * conversation than the one that was billed.
   */
  it('catches a window edited after it was prepared', () => {
    const edited = window();
    edited.push({ role: 'system', content: 'A notice that arrived after the window was built.' });
    const breach = requestDerivationBreach(request({ rederived: edited }));
    expect(breach).toContain('4 messages');
    expect(breach).toContain('5');
  });

  it('catches a message whose content moved without the count changing', () => {
    const rewritten = window();
    rewritten[1] = { role: 'user', content: 'fix the importer, and then deploy it' };
    expect(requestDerivationBreach(request({ rederived: rewritten }))).toContain(
      'message 1 (user)'
    );
  });

  it('catches a message whose role or addressee moved', () => {
    const reroled = window();
    reroled[3] = { role: 'tool', content: 'exit 0', toolCallId: 'call-2' };
    expect(requestDerivationBreach(request({ rederived: reroled }))).toContain('message 3');
  });

  it('catches a tool call appearing on a message the log does not carry one on', () => {
    const extra = window();
    extra[2] = {
      role: 'assistant',
      content: 'looking',
      toolCalls: [
        { id: 'call-1', name: 'shell', arguments: { command: 'pytest' } },
        { id: 'call-2', name: 'shell', arguments: { command: 'rm -rf /' } }
      ]
    };
    expect(requestDerivationBreach(request({ rederived: extra }))).toContain('tool calls');
  });

  /**
   * The withdrawal class. The set is built once for the whole run precisely so the catalogue stays
   * byte-identical across steps; a later rebuild that forgets a withdrawal restores a tool the box
   * cannot honour, and moves the head of the cached prefix while doing it.
   */
  it('catches a tool the run withdrew being sent anyway', () => {
    const breach = requestDerivationBreach(request({ sent: [...tools(), connectorAction()] }));
    expect(breach).toContain('withdrew');
    expect(breach).toContain('5');
  });

  it('catches the same tools in a different order, because the prefix is bytes and not a set', () => {
    expect(requestDerivationBreach(request({ sent: [...tools()].reverse() }))).toContain('tools');
  });

  /**
   * The content class, which the name comparison above cannot see and which now has a live cause.
   *
   * `connector_action` is built per box from the kinds of service the owner has connected, so the
   * two derivations of the catalogue can agree on all forty-one names and disagree on what one of
   * them says. The failure that produces is silent in the worst way: the request goes out with a
   * mailbox-shaped tool while the run believes it sent a fully connected one, or the reverse, and
   * a provider answers either as readily.
   *
   * Both arms use the real entry rather than a fabricated one - a stub with no `parameters` cannot
   * produce the shape this comparison is for, and would pass while proving nothing.
   */
  it('catches one tool whose definition is not the one this run may send', () => {
    const mailbox = connectorAction(['imap']);
    const everything = connectorAction();
    // The premise, asserted rather than assumed: same name, different definition.
    expect(mailbox.name).toBe(everything.name);
    expect(JSON.stringify(mailbox)).not.toBe(JSON.stringify(everything));
    const breach = requestDerivationBreach(
      request({ sent: [...tools(), mailbox], entitled: [...tools(), everything] })
    );
    expect(breach).toContain('connector_action');
    expect(breach).toContain('entitled to send');
    // And the direction that must stay silent: the same box on both sides.
    expect(
      requestDerivationBreach(
        request({ sent: [...tools(), mailbox], entitled: [...tools(), connectorAction(['imap'])] })
      )
    ).toBeNull();
  });

  /**
   * The budget class. `reservedTokens` is computed in three places from three arrays, and it is the
   * number the input budget, the compaction trigger and the handoff's own floor are all derived
   * from. A drift there is a window sized against a request nobody is sending.
   */
  it('catches a budget computed against a different catalogue than the one going out', () => {
    const breach = requestDerivationBreach(request({ reservedTokensOfSent: 1_900 }));
    expect(breach).toContain('1200');
    expect(breach).toContain('1900');
  });

  it('reports the tools before the window, because a wrong catalogue explains a wrong window', () => {
    const both = requestDerivationBreach(
      request({ sent: [...tools(), connectorAction()], rederived: [] })
    );
    expect(both).toContain('withdrew');
  });
});

/**
 * And that it is consulted, which is the half a unit test cannot reach.
 *
 * Read from the source for `preamble-ownership.test.ts`'s stated reason, and it applies here more
 * strongly: the failure is an *ordering* inside one method - the check must sit past every branch
 * that can still edit the window and in front of the one call that spends the owner's money - and
 * there is deliberately no live mutation between those two points today, so a driven turn can only
 * observe this by arranging one, which measures the arrangement rather than the program.
 */
describe('and it is asked before the request goes out', () => {
  /**
   * Two files rather than one since the phase decomposition, and the ordering now spans the seam
   * between them: the window is prepared in `turn/request.ts`, which `run()` calls strictly before
   * `turn/generate.ts` asks this question and sends the request. So the claim is made twice - once
   * about the order `run()` runs the two phases in, and once about where inside the second phase
   * the question sits - which together say exactly what one file used to say on its own.
   */
  const read = (path: string): string[] =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').split('\n');
  const at = (source: string[], file: string, needle: string, from = 0): number => {
    const index = source.findIndex((line, on) => on >= from && line.includes(needle));
    if (index < 0) throw new Error(`anchor not found in ${file}: ${needle}`);
    return index + 1;
  };
  const source = read('./turn/generate.ts');
  const lineOf = (needle: string, from = 0): number => at(source, 'turn/generate.ts', needle, from);

  it('sits between the window being prepared and the step being sent', () => {
    // The seam: the phase that prepares the window runs before the phase that asks the question.
    const loop = read('./agent.ts');
    const prepares = at(loop, 'agent.ts', 'const request = await prepareStepRequest(');
    const generates = at(loop, 'agent.ts', 'const generated = await generateModelStep(', prepares);
    expect(generates).toBeGreaterThan(prepares);
    // And inside that second phase, past every branch that can still edit the window and in front
    // of the one call that spends the owner's money.
    const prepared = lineOf('const { preparedContext, reasoningEffort, windowOptions } = request;');
    const asked = lineOf('const derivationBreach = requestDerivationBreach({', prepared);
    const sent = lineOf('gateway.chat(provider, {', asked);
    expect(asked).toBeGreaterThan(prepared);
    expect(sent).toBeGreaterThan(asked);
  });

  /**
   * And that the raise is guarded by the answer, which is a stronger claim than that a `throw`
   * exists somewhere below the question - and it had to be, because it did not start out that way.
   * The first version of this test asserted only that the throw was present in the following thirty
   * lines, and the mutation it was written to catch - `if (false as boolean)` in front of an
   * otherwise untouched raise, which is this repository's signature defect exactly - walked straight
   * past it. A gate that has never been seen to fail is a gate nobody knows works, and that goes for
   * the test as much as for the code it watches.
   */
  it('raises on the answer itself, so a request this side cannot account for is never billed', () => {
    const asked = lineOf('const derivationBreach = requestDerivationBreach({');
    const guard = lineOf('if (derivationBreach)', asked);
    // The condition is the breach and nothing else: not a constant, not a flag, not a negation.
    expect(source[guard - 1]?.trim()).toBe('if (derivationBreach)');
    // And the next two statements are the raise, so nothing can be inserted between the two.
    expect(source[guard]?.trim()).toBe('throw new GardenError(');
    expect(source[guard + 1]?.trim()).toBe("'request_not_derivable',");
  });
});
