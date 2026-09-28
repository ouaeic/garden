/**
 * The half that costs nothing and is exact, and the reason it is run first.
 *
 * Everything in this file is arithmetic over bytes garden itself produces. It needs no key, no
 * network and no model, it is deterministic to the byte, and it is therefore the half that can
 * gate on every commit - the same split `evals/context-quality` and `evals/agentdojo` both
 * settled on, for the same reason: the half of a rig that can run always is the half that is still
 * running in six months.
 *
 * ── What it can and cannot say, stated here rather than discovered by a reader ─────────────────
 *
 * It CAN say, exactly: what each arm costs on the wire, per request, for ever. That is the column
 * the residency rule is actually about, and it is knowable today at zero cost. It is also the
 * column that is still true in a year: the accuracy premium of a harness decision decays as models
 * improve, and the token premium does not.
 *
 * It CANNOT say whether an arm completes the work. Nothing offline can: a scripted model is a
 * function of what garden just said, so a smaller catalogue produces a byte-identical reply and
 * the rig would report a perfect tie for every arm and call it a finding. Saying so plainly is
 * most of the value of this file, because a tie that means "the instrument is blind here" and a
 * tie that means "the candidate is free" print identically.
 *
 * So: resident cost here, outcomes in `live.ts`, and the report never puts a completion figure in
 * a column this file filled in.
 */
import { TASKS } from './tasks.js';
import { settingsFor, type ArmSettings } from './arms.js';
import {
  catalogueOnTheWire,
  contractFor,
  danglingToolMentions,
  knowledgeFor,
  toolsFor,
  type ContractCut
} from './wire.js';

/**
 * Four characters to the token.
 *
 * The same conversion `evals/harness.ts:348-354` bills a request at and the same one the loop's
 * own fallback estimate uses. It is a rough conversion and it is deliberately the rough one both
 * of those use: a second, better tokeniser here would make this rig's numbers incomparable with
 * every other number in the repository, which is a worse fault than being uniformly approximate.
 */
const tokensOf = (bytes: number): number => Math.ceil(bytes / 4);

export interface Resident {
  readonly armId: string;
  readonly settings: ArmSettings;
  readonly toolCount: number;
  readonly catalogueBytes: number;
  readonly contractBytes: number;
  readonly knowledgeBytes: number;
  /** Everything the arm carries on every request before the conversation starts. */
  readonly residentBytes: number;
  readonly residentTokens: number;
  /** Tools the contract still names that this arm no longer sends. A diagnostic, not a verdict. */
  readonly dangling: readonly string[];
  /**
   * Resident tokens x tasks in the sample, at one request per task.
   *
   * The floor of what a run of this sample pays for its prefix, not the total: a real task makes
   * several requests and pays the prefix on each. Labelled as a floor everywhere it is printed,
   * because a number that looks like a total and is a floor is the kind of thing that ends up in
   * somebody's slide.
   */
  readonly samplePrefixTokensFloor: number;
}

export const measureArm = (armId: string, cut: ContractCut = {}): Resident => {
  const settings = settingsFor(armId);
  const tools = toolsFor(settings);
  const contract = contractFor(settings, cut);
  const knowledge = knowledgeFor(settings);
  const catalogueBytes = Buffer.byteLength(catalogueOnTheWire(tools));
  const contractBytes = Buffer.byteLength(contract);
  const knowledgeBytes = Buffer.byteLength(knowledge);
  const residentBytes = catalogueBytes + contractBytes + knowledgeBytes;
  return {
    armId,
    settings,
    toolCount: tools.length,
    catalogueBytes,
    contractBytes,
    knowledgeBytes,
    residentBytes,
    residentTokens: tokensOf(residentBytes),
    dangling: danglingToolMentions(contract, tools),
    samplePrefixTokensFloor: tokensOf(residentBytes) * TASKS.length
  };
};

export const measureAll = (armIds: readonly string[], cut: ContractCut = {}): readonly Resident[] =>
  armIds.map((armId) => measureArm(armId, cut));
