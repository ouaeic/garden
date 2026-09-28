# The edit-format conformance rig

```
pnpm eval:edit
pnpm eval:edit -- --ci        # on pnpm eval:rigs, and therefore on pnpm check
pnpm eval:edit -- --accept    # rewrite the committed baseline from this run
```

Offline, no key, no network, about a second.

## What it answers

`file_patch` addresses edits by line number. That format was bought on a measured saving in output
characters, and the objection that held it for two waves was that the saving is an upper bound
available only to a model that emits the dialect perfectly. This rig answers the objection by
pricing the imperfection.

**One hundred ways a model can get the format wrong** are driven through the real applier and the
real snapshot store, and each one is scored in the currency the ship decision is priced in:

| cost     | meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `0`      | landed, byte-identical to what the model asked for. Nothing extra.    |
| `1`      | refused, and the model's very next call can be the corrected patch.   |
| `2`      | refused, and the model has to read the file again first.              |
| `X`      | the tool reported success and the bytes on disk are wrong.            |
| `X-echo` | the same, but the result displays the damaged lines on the same turn. |

**The same malformed intents go through the editor this format replaced**, priced with the same
function, so the comparison is not the character count everyone has already argued about. If the
retired format's failures are more expensive, the case for the new one does not depend on the model
being perfect at all — and that is what the second table says.

## Why it is allowed to be believed

- **"Self-sufficient" is decided by a program.** A refusal about the file has to quote the file back
  under its real line numbers, three consecutive rows of it, each matching the file as it really
  reads. A refusal about spelling has to name a legal spelling. Both tests are in `conformance.ts`,
  both are applied to both formats, and `selftest.ts` exercises them on inputs whose answers are
  known — including a window that is subtly wrong, which they must reject.
- **Every case declares what a forgiving harness must do before it is run.** A refusal of an
  emission the harness had the evidence to recover is `over-refused`, and is counted even though it
  costs only one trip: it is a trip nobody had to pay. Those rows are the findings.
- **The baseline fails in both directions.** A row that gets worse is a regression; a row that gets
  better is a fix that has to be accepted on purpose, so it shows up in the diff rather than
  quietly erasing a defect nobody wrote down.
- **The comparison is pinned to the repository.** `assertIncumbentRetired` reads
  `apps/worker/src/tools/workspace.ts` and throws if the quoted editor's two load-bearing lines come
  back, because then every sentence here about "the editor this replaced" would be false. Its
  explainer, `apps/worker/src/patch-failure.ts`, is imported rather than copied, so the refusals
  priced in the second table are the real ones.
- **The rig was attacked.** Twelve bounds were broken one at a time, each watched go red, each
  restored SHA-256-identically. Two of the twelve found nothing, and both are reported rather than
  counted. `docs/design/edit/ATTACK.md` has the table.

## The anchored group

The `anchored` rows price the one `-` row the spec teaches - the start of the first addressed
line, eight non-space characters or more - in every way a model can write it and every way the
recovery it enables could be attacked. A case may carry a second patch (`then`), addressed in the
numbering the first one reported with no read between, and may be sent twice (`retry`) through the
repeated-patch bound the arm applies, scoring the second refusal. The `attack-*` rows each name a
patch whose anchor could be made to land where the patch did not: every one must be refused with
nothing written, and the guard that holds each one was watched go red with that guard reverted -
one guard at a time, each restored SHA-256-identically, and each reversion turning its own row to
`X` and no other:

| guard reverted                                                                       | row that goes red                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| the ledger half of the anchor check, and the whole-span re-check                     | `attack-anchor-matches-live-not-ledger`           |
| the neighbour rule on an anchor under eight non-space characters                     | `attack-weak-anchor-neighbour-mismatch`           |
| the refusal of a corrected range no read has shown                                   | `attack-cut-relocation-past-shown-end`            |
| the refusal of two candidates in the ring                                            | `attack-two-hits-nearest-not-chosen`              |
| the number test on a leaked display prefix                                           | `attack-prefix-strip-cannot-move`                 |
| the stale-neighbour rule: a short anchor beside a changed line is named, not skipped | `attack-weak-anchor-stale-neighbour-is-ambiguity` |
| the shown-window check on a whole-quote correction                                   | `attack-whole-quote-past-shown-end`               |
| the ledger half of a whole-quote correction                                          | `attack-whole-quote-matches-live-not-ledger`      |

Two attack rows have no single guard to revert, and are held anyway: a hit outside the shown
window is named as unseen but the far-hit path never applies at all, and a span the ledger
relocated is refused by the relocation check and, beneath it, by the ledger half above.

Three landed rows are guards of the same kind, watched the same way - each turns to a refusal or
to `X` with its guard reverted: the anchor of a span the ledger followed is checked against the
ledger's row at the number the model ADDRESSED, which is the row that moved
(`anchored-file-shifted-under-read`, `anchored-insert-after-shifted-weak-anchor`,
`anchored-same-prefix-line-inserted-above`); a row whose leading digits the file itself carries
at that line is never read as a display prefix (`body-row-genuine-digit-colon-content`,
`body-row-genuine-digit-bar-grid`); and a row inserted into a file whose every line ends CRLF
ends CRLF (`ws-crlf-file`, `ws-crlf-file-anchored-two-rows`, `ws-crlf-file-edited-on-its-last-line`).

## The dropped-marker rows

Three `body` rows draw the line for a body row that begins with none of `+`, `-` or a space.
`body-dropped-plus-mid-body-more-plus-rows-follow` is a shape watched live, three times in one
turn from a cheap model: `+`, `+`, `def nth_prime(n):`, then `+    """..."""`. The unmarked row
stands after at least one marked row and directly above a `+` row, so it has exactly one reading -
a `+` that did not survive generation - and reading it that way touches the same lines the patch
already named. It lands with a note, at cost 0. `body-unmarked-trailing-prose` is the same kind of
row at the END of the body, with no `+` row under it, which is where prose written after a patch
lives; it is still refused by name. `body-unmarked-mid-row-is-the-next-operation` is a second PUT
written directly under the first body, which must be read as the next operation and never as
text. `body-unmarked-mid-row-is-a-malformed-operation` is that second PUT misspelt - `PUT line 15:` -
which has to be refused by name at its own row rather than swallowed as text, because the swallowed
reading reports success on a file with the wrong line in it. The parser's `droppedMarkerAhead`
holds all four, and with it reverted the first row goes to `over-refused` at cost 1 and the others
do not move.

## What it cannot tell you

It runs no model. Every emission in the corpus is one a model plausibly produces, but **the rate at
which models produce each one is not measured anywhere in garden and is not measured here.** This
bounds the cost of each failure; it does not weight them. A defect that never happens costs nothing
and a cheap refusal that happens on every third edit costs a great deal, and nothing in this
directory can tell those apart.

## The files

| file             | what it holds                                                              |
| ---------------- | -------------------------------------------------------------------------- |
| `conformance.ts` | the hundred malformed emissions, the cost model, and the two message tests |
| `incumbent.ts`   | the retired editor, its batch rule, the paired intents, and the pin        |
| `corpus.ts`      | the three files the cases are edited against                               |
| `encode.ts`      | `minimalUnique`, which prices the retired format's own recovery            |
| `selftest.ts`    | the checks aimed at this rig rather than at the applier                    |
| `report.ts`      | the questions, the tables, and the baseline gate                           |
| `run.ts`         | the entry point                                                            |
