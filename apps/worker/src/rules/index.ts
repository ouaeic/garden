/**
 * Knowledge that costs nothing until the model needs it.
 *
 * Everything this harness knows about *how* has lived in one of two places: the operating contract,
 * which is paid on every request of every task for ever, or a skill body, which is free until it is
 * opened and then costs one to three thousand tokens at once. There was no tier in between, and the
 * tier in between is where most method belongs: a sentence that is only worth saying to a model
 * that is about to get something wrong should be said to that model, at that moment, and to nobody
 * else.
 *
 * That is what this is. A rule is a matcher over what the model just produced and a correction to
 * append if it fires. Until it fires it contributes **zero bytes** to the request - no schema, no
 * contract line, no index entry - and `rules.test.ts` asserts that by comparing the whole window
 * byte for byte with the rules loaded and none of them matching. The whole file is 0 B resident.
 *
 * Three deliberate boundaries, each of which was a decision rather than a default:
 *
 * **It never interrupts.** The correction is appended for the *next* request; the generation in
 * flight is left alone. Aborting a stream mid-sentence has its own failure modes - a half-written
 * answer the owner has already read, a tool call cut off from its result - and none of them are
 * paid for by the value here. The one thing this file does to a running turn is add a message to
 * the tail of its window.
 *
 * **It observes the recorded step, not the token stream.** The matcher runs at the top of the
 * following step, over the assistant message the previous step left in the window. That is the same
 * content - the window holds exactly what was streamed - and it buys two properties a per-delta
 * matcher does not have: it survives a worker handover, an approval pause and a resume, because it
 * re-derives from the persisted trajectory rather than from a local; and it cannot split an
 * assistant's tool calls from their results, because at a step boundary every call has been
 * answered. A rule that genuinely needs to act *before* the step is answered would have to
 * interrupt, and that is the half deliberately not built.
 *
 * **A rule that fires constantly is a resident rule with extra steps.** That is the failure mode
 * this mechanism invites, so the firing counter below exists from the first commit rather than
 * being added after somebody notices. A rule whose firing rate approaches one per turn is not
 * cheaper than a contract line - it is a contract line paid late, plus a matcher - and the honest
 * response is to promote it back into the contract deliberately. @see ruleFiringCounts.
 */
import type { ModelMessage } from '@garden/model-gateway';

/**
 * What one appended correction opens with, and the reason it is a fixed string.
 *
 * Two consumers depend on it. Deduplication reads it back out of the window: a rule that has
 * already fired this turn does not fire again, and the record of that is the message itself rather
 * than a counter in the persisted state - which means a compaction that condenses the correction
 * away correctly makes the rule live again, and no new state field had to be persisted, encrypted
 * and carried through every resume path to get that.
 *
 * The second is measurement. Firing rate in production is `grep` over trajectories that already
 * exist, at zero additional writes: a timeline row per firing would be narration of exactly the
 * kind the design audit already booked against "Agent started work" - the software describing its
 * own machinery to an owner who asked about something else.
 */
export const RULE_CORRECTION_MARKER = 'HARNESS CORRECTION';

/** What the model produced on one step, and what the turn behind it has actually run. */
export interface RuleObservation {
  /** The assistant's own words on that step, exactly as the window holds them. */
  readonly text: string;
  /** The calls that step asked for. `arguments` is the parsed bag, empty on a cut-off call. */
  readonly toolCalls: readonly {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[];
  /** Every tool this turn has actually run, by name. Excludes calls the harness answered itself. */
  readonly ran: ReadonlySet<string>;
}

export interface DormantRule {
  /** Stable, and part of the appended text: it is what deduplication and counting key on. */
  readonly id: string;
  readonly matches: (observation: RuleObservation) => boolean;
  /**
   * Appended verbatim behind the marker when the matcher fires, and written to be read once by a
   * model that has just done the thing it describes. It carries the fact the model could not have
   * discovered by trying - never a restatement of something the contract or the tool's own
   * description already says, because that would be paying twice for one sentence.
   */
  readonly correction: string;
}

/** Serialised arguments of one call, for matchers that look for a path or a command inside them. */
const argumentText = (call: RuleObservation['toolCalls'][number]): string => {
  try {
    return JSON.stringify(call.arguments);
  } catch {
    // A bag that will not serialise is a bag with a cycle in it, which no provider produces. It is
    // caught rather than thrown because a rule failing to match is a missed correction, and a rule
    // throwing is a dead turn.
    return '';
  }
};

/** Office formats whose defects are invisible in the source that produced them. */
const OFFICE_DOCUMENT = /\.(?:docx|pptx|xlsx)\b/i;

/**
 * The commands that *are* the proof, so the step that starts proving is not told to start proving.
 *
 * Without this the rule fires on the first conversion of a model already doing the right thing:
 * the deck is written, the convert runs, and `image_read` has not happened yet because it is two
 * calls away. One wasted correction is cheap, but it is also avoidable by naming the three binaries
 * the proof is made of.
 */
const RENDER_PROOF_COMMAND = /garden-office-convert|pdftoppm|libreoffice|soffice/i;

/** Everything that puts a page from the outside in front of the model as a page rather than a hit. */
const PRIMARY_SOURCE_READERS = [
  'parallel_web_read',
  'browser_snapshot',
  'print_pdf',
  'read_elements'
];

/**
 * A shell that waits by the clock: `sleep 5`, `while ...; do sleep 2; done`, `&& sleep 10`.
 *
 * Anchored on a statement boundary rather than matched loose, so `sleep` inside a filename, a
 * comment or the word "asleep" is left alone. The digit is required: a bare `sleep` with no
 * argument is an error the shell reports on its own.
 */
const SHELL_SLEEP = /(?:^|[;&|]|\bthen\b|\bdo\b)\s*sleep\s+\d/i;

/**
 * What a `shell` call would look like written out, from the two fields it actually has.
 *
 * There is no `command` field and there never was: `shell` runs one executable and takes its
 * arguments as an array, precisely so that nothing expands. A matcher written against a `command`
 * string would have passed its own tests and matched nothing in production for ever, which is what
 * the first draft of this file did. Both real shapes have to be caught - `sleep 30` as the
 * executable, and a `sleep` inside the script of a `bash -lc`, which is what the catalogue tells
 * the model to reach for the moment it wants a loop.
 */
const commandLine = (call: RuleObservation['toolCalls'][number]): string => {
  const executable = typeof call.arguments.executable === 'string' ? call.arguments.executable : '';
  const args = Array.isArray(call.arguments.args)
    ? call.arguments.args.filter((argument): argument is string => typeof argument === 'string')
    : [];
  return [executable, ...args].join(' ');
};

/**
 * The seed set.
 *
 * Every one of these is a sentence the operating contract used to carry unconditionally and no
 * longer does, kept here because it passed all four tests as a *triggered* rule and failed at least
 * one as a resident one. What was rejected is as much the point as what was taken, and it is
 * written down in the report rather than here: "call connector_list first" is one call away from
 * being discovered, "prefer accessibility-node actions" is already in `desktop_action`'s own
 * description, and "snapshot once then use read_elements" is already in `browser_snapshot`'s. A
 * rule that repeats something already on the wire is worse than no rule: it is the same bytes,
 * twice, plus a matcher.
 */
export const DORMANT_RULES: readonly DormantRule[] = [
  {
    /**
     * The defect nothing reports.
     *
     * A deck whose text overflows its box, a CV that runs onto a second page, a workbook of #REF!
     * - none of these fail. The script exits zero, the file is written, the model reads back a
     * valid archive, and the first thing that observes the defect is the owner opening it. Every
     * other class of mistake this harness has is announced by something; this class is announced by
     * nobody, which is exactly why it cannot be left to the model to discover by trying.
     */
    id: 'office-render-proof',
    matches: ({ toolCalls, ran }) =>
      !ran.has('image_read') &&
      toolCalls.some(
        (call) =>
          ['shell', 'file_write', 'publish_artifact'].includes(call.name) &&
          OFFICE_DOCUMENT.test(argumentText(call)) &&
          !RENDER_PROOF_COMMAND.test(argumentText(call))
      ),
    correction:
      'You have produced an Office document. Nothing in its source shows text overflowing its box, a page breaking in the wrong place, or a sheet full of #REF!, and the first thing that will observe those is the user opening the file. Before you publish it: convert it with `garden-office-convert IN OUT`, render the pages with `pdftoppm`, and look at them with image_read. The render-proof skill carries the full procedure.'
  },
  {
    /**
     * An answer built entirely out of search hits.
     *
     * The contract already says a snippet is a pointer and never a citation, and that line stays
     * where it is - what it cannot do is notice. This can: the turn ran a search, opened nothing
     * behind it, and the model has now written the user several hundred characters of answer with
     * no address in it. The bar is deliberately on length and on the absence of any URL rather than
     * on judging the prose, because a matcher that tries to decide what counts as a factual claim
     * is a matcher that fires on everything.
     */
    id: 'snippet-citation',
    matches: ({ text, toolCalls, ran }) =>
      ran.has('web_search') &&
      !PRIMARY_SOURCE_READERS.some((tool) => ran.has(tool)) &&
      !toolCalls.some((call) => PRIMARY_SOURCE_READERS.includes(call.name)) &&
      text.length >= 240 &&
      !/https?:\/\//i.test(text),
    correction:
      'Everything you have just told the user came out of search hits: this turn ran web_search and has opened none of the pages behind it. Read the sources you are relying on - parallel_web_read takes up to twelve at once - check each claim against the page itself, and give the address you actually read. Any claim you cannot relocate in a source says so in the answer.'
  },
  {
    /**
     * Waiting by the clock, on a turn that is bounded by the clock.
     *
     * The model cannot discover this one by trying, because the cost is not charged where the
     * mistake is made: a `sleep 30` succeeds, exits zero and looks free. What it spends is the
     * turn's wall-clock ceiling, which is a real bound alongside steps and credits, and the turn it
     * ends is not the step that slept. Both replacements already exist and neither is guessable
     * from the fact that `sleep` worked.
     */
    id: 'sleep-poll',
    matches: ({ toolCalls }) =>
      toolCalls.some((call) => call.name === 'shell' && SHELL_SLEEP.test(commandLine(call))),
    correction:
      "A shell that sleeps spends this turn's wall-clock budget doing nothing, and that budget is a real ceiling: a turn is stopped on the clock as well as on steps and on credits, and the step that pays is not the one that slept. Start long work with shell(background=true) and look in on it with process. Wait for a page with browser_action wait_for, which returns the moment the condition holds rather than at the end of a fixed timer."
  }
];

/**
 * How many corrections each rule has actually appended in this process.
 *
 * The instrument, and it is here from the first commit on purpose: the way this mechanism fails is
 * that a rule fires on most turns, at which point it has all the cost of a resident contract line
 * and a matcher on top, and the only honest repair is to move it into the contract deliberately. A
 * mechanism whose failure mode is invisible is a mechanism that stays broken, so the number is kept
 * where a test and an eval can read it.
 *
 * Counted on *append* rather than on match, so a step re-observed after a `continue` - the
 * truncation repair and the completion nag both send the model round without a new assistant
 * message - is one firing rather than two.
 */
const firings = new Map<string, number>();

export const ruleFiringCounts = (): ReadonlyMap<string, number> => new Map(firings);
export const resetRuleFiringCounts = (): void => firings.clear();

/** The correction as it is written into the window: marker, id, then the rule's own words. */
export const correctionMessage = (rule: DormantRule): string =>
  `${RULE_CORRECTION_MARKER} [${rule.id}]: ${rule.correction}`;

/** Rule ids whose correction is already somewhere in this window. */
const alreadyFired = (messages: readonly ModelMessage[]): ReadonlySet<string> => {
  const fired = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'system' || !message.content.startsWith(RULE_CORRECTION_MARKER)) continue;
    const id = /^ \[([^\]]+)]/.exec(message.content.slice(RULE_CORRECTION_MARKER.length))?.[1];
    if (id) fired.add(id);
  }
  return fired;
};

/**
 * Reads the step the model just produced and appends any correction it earned.
 *
 * Returns the ids that fired, which is nothing the loop needs and everything a test does. It
 * mutates `messages` in place because that is what every other tail block in this window does, and
 * a copy would move the bytes of the whole trajectory behind it - the exact disease the runtime
 * block was moved to the tail to cure.
 *
 * Two refusals, both about shape rather than about content. It does nothing when the window ends on
 * an assistant message carrying tool calls, because a system message wedged between a call and its
 * result makes the next request malformed - the same rule the cut-off-reply branch in `agent.ts`
 * obeys. And it does nothing when there is no assistant message at all, which is the opening step.
 */
export const applyDormantRules = (
  messages: ModelMessage[],
  ran: ReadonlySet<string>,
  rules: readonly DormantRule[] = DORMANT_RULES
): readonly string[] => {
  const tail = messages.at(-1);
  if (tail?.role === 'assistant' && tail.toolCalls?.length) return [];
  let last: ModelMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      last = message;
      break;
    }
  }
  if (!last) return [];
  const observation: RuleObservation = {
    text: last.content,
    toolCalls: (last.toolCalls ?? []).map((call) => ({
      name: call.name,
      arguments: call.arguments
    })),
    ran
  };
  const fired = alreadyFired(messages);
  const appended: string[] = [];
  for (const rule of rules) {
    if (fired.has(rule.id)) continue;
    let matched = false;
    try {
      matched = rule.matches(observation);
    } catch {
      // A matcher that throws is a bug in the rule, and a bug in a rule must not be able to end a
      // turn that was otherwise fine. It is swallowed rather than reported because there is no
      // channel here that is not narration, and the rule simply not firing is the safe direction.
      matched = false;
    }
    if (!matched) continue;
    messages.push({ role: 'system', content: correctionMessage(rule) });
    firings.set(rule.id, (firings.get(rule.id) ?? 0) + 1);
    appended.push(rule.id);
  }
  return appended;
};

/**
 * The names of the tools a turn has actually run, from the results it recorded.
 *
 * `skipped` is excluded deliberately: a call the harness answered itself - a repeat read, a call
 * cut off mid-JSON - never reached the tool, so it is not evidence that anything was read or looked
 * at. The render-proof rule is the one that cares: an `image_read` the harness short-circuited did
 * not put a rendered page in front of the model.
 */
export const toolsRunThisTurn = (
  results: Record<string, { name: string; skipped?: boolean }> | undefined
): ReadonlySet<string> => {
  const ran = new Set<string>();
  for (const result of Object.values(results ?? {})) if (!result.skipped) ran.add(result.name);
  return ran;
};
