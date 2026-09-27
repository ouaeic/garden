# Contributing

Contributions are welcome when they preserve garden’s core boundary: self-hosted software, one
persistent agent computer, user-owned model access, no local model weights, and no mandatory hosted
athanor service.

`AGENTS.md` in this directory carries the same rules in the shape a coding agent reads them, and is
the shorter document. Everything below is the reasoning behind it.

## Before coding

Open an issue or design note for schema changes, new external services, new native capabilities,
approval-policy changes, or anything that exposes a new network surface. Include:

- the user problem;
- the smallest interface change;
- credential and content flow;
- failure and rollback behavior;
- license and upstream terms;
- which bound proves the security boundary holds, and what happens when it is switched off.

## Local checks

```bash
pnpm install --frozen-lockfile
CI=true pnpm check
```

The document-authoring tests use the installed runner Python, or `python3` from `PATH` on a
local machine. If your document libraries live in another environment, select its absolute
interpreter path before running the gate:

```bash
ATHANOR_DOCUMENT_PYTHON=/absolute/path/to/document-environment/bin/python3 CI=true pnpm check
```

The selected interpreter must actually produce a document; absent local dependencies are reported
with their names. CI and release probes require the complete installed toolchain.

`pnpm check` runs these gates in a fixed order, cheapest first, so the one that fails is usually the
one that costs least to run:

1. `pnpm license:check` and `pnpm release:check` — dependency licences, and the release manifest.
2. `node scripts/check-repository.mjs` — it parses every shell, Python and Node program that ships to
   a server, lints the skill library, holds `.env.example` to the defaults the code declares, holds
   the constants this repository deliberately copies between packages against each other, and holds
   several published sentences against the code they describe. It also runs `shellcheck` when it is
   installed, and requires it in CI.
3. `node scripts/test-document.mjs` — it builds and measures real documents through the installed
   toolchain, so a document route that has stopped producing bytes fails here rather than in front of
   an owner.
4. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
5. `pnpm eval:gate` — the 73-fixture behavioural suite, run for its claims and not for its numbers.
   It fails when a fixture did not really run — a route the harness stub does not model, a warning
   the loop had to survive, a tool that threw — or when a stated expectation broke. It does **not**
   fail when a committed token count or step count moved; those belong to `pnpm eval` below, and
   putting them here is what would make this the gate everybody bypasses. It takes about nine
   seconds. It is here because the suite spent two separate waves red at 71 of 73 fixtures with
   `pnpm check` green beside it, the second time after the first had been written down in
   `evals/harness.ts` as a comment nobody re-read.
6. `pnpm eval:rigs` — context quality, prompt injection, the arm comparison, approval cards,
   edit-format conformance, read cost, and independent outcome calibration. The outcome rig
   checks incorrect-result controls and durable form submission recovery; it does not measure
   model quality or spend provider credits. They are
   offline, need no key, and finish in about fourteen seconds between them. They are here rather than
   nightly because each one answers "did this change cross a floor", and a floor that quietly stops
   firing is not a drift to argue with in the morning — the cards rig in particular pins that reading
   untrusted content still costs the owner no approvals at all, and the edit rig pins what each way
   of mis-emitting a patch costs in round trips, so a change to the editor that makes a recovery
   into a refusal fails here rather than being discovered as a bill. Each of them commits only rows
   it constructs itself: the read rig runs the whole fixture corpus and deliberately leaves it out
   of its baseline, because those rows belong to `pnpm eval` and gating them here would move that
   suite's numbers into `pnpm check` without anybody deciding to.
7. `pnpm build`.

That list is checked against `package.json` by `scripts/check-repository.mjs`, in both directions and
in order, so a gate added to the script and not to this page fails the build rather than going
unmentioned.

`pnpm eval` is the same run as the gate above with the committed baseline switched on, and that half
is deliberately **not** part of `pnpm check`. The reason is not cost — the suite is offline and
deterministic, a scripted model, a stubbed workspace runner, a stubbed media provider, no provider
key and no network, and it takes about nine seconds. It is that a token count which moved is a
decision to make, not a build to fix, and a gate that refuses every commit until somebody re-accepts
a row is the gate that gets bypassed. Run it before and after any change to
`apps/worker/src/agent.ts`, `context.ts` or `tools.ts`, and read `docs/EVALUATION.md` first.

This page used to say the whole suite was kept out for that reason, and that was one argument doing
two jobs. It is true about the numbers and it was false about the claims: a fixture refused by an
unmodelled route reports no number worth arguing with, because every figure on that row came out of
a failure branch.

The server's shell is not covered by the TypeScript suites, so a set of drills runs it against
fixtures. They need no root, no network and no server, and they finish in seconds:

```bash
python3 scripts/test-gui-entry.py      # namespace handles, pinned mounts and private GUI state
python3 infra/native/athanor-desktop-bridge.test.py # native accessibility identity and states
python3 scripts/test-reproducible-run.py # analysis manifests, clean rerun and changed-dependency refusal
python3 scripts/test-system-environment.py # confined image extraction; Linux service/data replay with bwrap and cc
sh scripts/test-sandbox.sh          # which account an agent command really lands on
sh scripts/test-certificate.sh      # renewal, reissue and the recorded failure alarm
sh scripts/test-relay-endpoint.sh   # what the connection manifest advertises, relay on and off
sh scripts/test-update.sh           # transactional update, its rollback, and what a release carries
sh scripts/test-native-provisioning.sh  # the browser revision, the update record, the spending cap
sh scripts/test-system-packages.sh  # which package manager an approved install actually reaches
sh scripts/test-doctor-retirement.sh # what doctor says about a model the provider is withdrawing
sh scripts/test-doctor-notifications.sh # what doctor says when nothing is enrolled to be notified
```

Two of the server's shell commands are contracts rather than conveniences, because something outside
this repository reads their output, so each has a drill in Node that runs the real command against a
stand-in API on a loopback port. Both run inside `scripts/check-repository.mjs`; run one directly to
read its output:

```bash
node scripts/test-task-cli.mjs        # athanor task: one JSON object, and an exit code per ending
pnpm acp:check                        # athanor acp: the ACP wire shapes, and the approval floor
```

`pnpm acp:check` is `node scripts/acp/test-acp-bridge.mjs`. It is the one whose callers are code
this repository did not write - ACP clients are somebody else's editors - so it checks the approval
floor from four directions as well as the protocol: see docs/ACP.md.

Three of the shell drills - `test-sandbox.sh`, `test-certificate.sh` and `test-relay-endpoint.sh` - also run in
CI's `native-units` job; `test-update.sh`, `test-doctor-retirement.sh` and
`test-doctor-notifications.sh` run in the `application` job, at `.github/workflows/verify.yml`,
after that job's `pnpm install`; and
`test-system-packages.sh` already runs inside `pnpm check` by way of
`scripts/check-repository.mjs`. They are listed here because running one directly is how you read
its output; `test-native-provisioning.sh` is the one with nothing but this list standing behind it. A new drill that this
page does not name fails `scripts/check-repository.mjs`, for the same reason as the gate list above.

`test-doctor-retirement.sh` is the one that does not fit "no root, no network and no server"
cleanly: it wants a completed `pnpm install` on Node 24, because its last section replays the three
SQL statements the check issues against the PGlite in `packages/data/node_modules`. With PGlite
absent it fails loudly rather than skipping, and `SKIP_SQL_REPLAY` cannot rescue it because that
skip is tested after the PGlite guard, not before it. Both are deliberate: a replay that quietly
does not run is the saturated harness it exists to replace. It runs in CI in `application` beside
`test-update.sh`, which is the job that has already installed - `native-units` is
`actions/checkout` and the drills alone, with no `setup-node` and no install, so it would fail
there on the replay's first line.

The native R computation drill runs against an installed `Rscript` and `jsonlite`, with no provider calls or network. Pass workspace library directories when the package is project-local:

```bash
python3 scripts/test-r-computation.py /path/to/project/R-library
```

It exercises native values, typed JSON checkpoints, multiple plots, error recovery and interrupts. Missing R or jsonlite fails explicitly; the TypeScript suite separately checks lifecycle, confinement and streaming protocol bounds.

For the Tauri shell:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

## Tests

garden's suites are not one kind of thing, and the difference decides both whether a test is worth
writing and when it is safe to delete. Every test in this repository is one of four kinds, and you
should be able to say which before you write it.

**An instrument** reports a number nobody could otherwise see, and does not care what the number is.
`pnpm eval`'s cost report, `context.test.ts`'s sixty-step cache harness, `evals/context-quality`'s
matrix and `evals/agentdojo` are instruments. They are how a change is priced before it is argued
about, and they are the only reason any figure in `docs/` exists. **Required, and never deleted.**

**A bound** asserts that a limit actually fires: a step budget, a spend ceiling, a byte cap, a
refusal, an approval card, a taint mark. Its title names the limit. `turn-bounds.test.ts` is almost
entirely bounds. **Required for every limit you add, and never deleted while the limit exists.**

**A contract** asserts that two things which cannot import each other still agree — a value copied
across a bundle gate, a table in one process against a branch in another, a published sentence
against the code it describes. Required, but read the next section first: a test is usually the
_worst_ available home for a contract.

**A ratchet** pins current behaviour so that changing it costs work. It asserts what the code does
rather than what it must never do. Not required, and the only kind that may be deleted along with
the code it pins.

### Bounds a change has to leave standing

Stated as the properties, not as a list of files to add tests to. If your change touches one of
these, the bound that proves it must still fire afterwards, and you should have watched it go red:

- a migration runs forward and the PGlite and PostgreSQL stores answer the same;
- authentication, origin, ownership, idempotency and recent-authentication checks each refuse;
- the runner refuses out-of-scope capability, blacks out secure input, truncates unbounded output,
  honours cancellation, and refuses an SSRF target;
- a malformed tool call is tombstoned, a specialist handoff stays read-only, and hostile untrusted
  content neither grants authority nor replaces the goal;
- no content canary reaches an application log;
- the interface stays reachable by keyboard, lays out on a phone, reconnects, and can show a task
  completing and an approval waiting;
- install, update, backup checksum, restore, and uninstall each do what they say, and uninstall
  preserves data.

### A pinning test is a placeholder for a contract that has not found its home yet

That is the rule, and it is the reason ratchets are allowed at all. A behaviour pin is what you write
when you know two things must agree and you have nowhere better to say so. It is a note in the margin
that happens to run in CI.

So: **a pinning test must name, in its own comment, the contract it stands in for.** Not the incident
— the contract. "This asserts that the card's wording and the floor's branch list stay the same set"
is a contract. "This asserts `approvalReach` returns this string" is not, and should not be written.

And **when the contract moves to a better home, delete the test in the same change and say so in the
message.** Leaving it behind is not caution. It is a second copy of a rule, and this repository's
worst recurring defect is a second copy of a rule outliving the first.

Homes for a contract, best first. The tiers are the residency tiers the runtime uses, applied to
verification:

1. **Enforced in code.** A type, a discriminated union, one exported constant both sides import. No
   test can fail because no disagreement can be written. Always try this first, and note that the
   commonest reason it is impossible here is a bundle gate or a process boundary — say which.
2. **A repository check** in `scripts/check-repository.mjs`. This is the right home for anything
   static: two files that must agree, a list that must be complete, a published sentence that must
   match the code, a constant copied across a boundary. It runs in `pnpm check`, it reads the tree
   rather than a driven scenario, it fails on the day the drift lands, and it belongs to the whole
   repository rather than to one package's suite. Several checks in that file exist precisely because
   the same assertion was previously a unit test in a client that had no business reading the
   worker's source.
3. **A runtime probe** — `doctor`, a startup assertion, an eval fixture's stated target. Right when
   the fact is only true of a running box.
4. **A prose rule** in `AGENTS.md`, when the property is real but nothing can check it mechanically.
   A rule nobody enforces is weaker than a test; a rule nobody _can_ enforce is stronger than
   pretending otherwise with a test that pins one example of it.

A test is what is left when none of the four fit.

### Adding a step to the installer

`scripts/install-native.sh` does two kinds of work, and every new step is one or the other.

A step a **release carries** - a package, a permission, a setting, a data migration - goes in one of
the `release_step_*` functions near the top of that file. `sudo athanor update` runs those, and only
those, by calling `install-native.sh --release-steps` from the revision it has just pulled, so a step
added there reaches every existing box with the release that adds it. Say beside it why running it
again on a machine that is serving is safe; the ones already there are safe because they converge -
the package table is declarative, `set_env_value` replaces, the workspace migration is `mv -n`.

A step an install does **once** - an account, a sudoers file, a generated secret, a certificate, the
database cluster - stays in the body below, which `--release-steps` exits before reaching. Repeating
one of those on a running server is how a shared secret gets regenerated under two services that are
holding it, or a rate-limited certificate gets re-issued. A step nobody is sure about belongs there.

Two things stop the first kind from quietly becoming neither: `scripts/check-repository.mjs` fails
the build when a `runner.env` key is written outside `release_step_runner_settings`, and
`scripts/test-update.sh` runs the entry point against a fixture release and watches what it does
land. This existed because it did not: an update ran the build steps and nothing else an install
does, and a Landlock boundary, two packages and a workspace migration reached an owner's server
present and inert, under an update that printed "Update complete" and exited 0.

### Every assertion must be capable of failing

The cheapest way to write a test that can never fail is to put every assertion inside a loop over a
production collection and assert nothing about the collection. Empty the collection and the body
never runs; the test passes in zero milliseconds and reports a guarantee it is not making. This
repository has shipped that shape more than twenty times, including a command-injection guard and an
AGPL compliance claim.

So every loop over a production collection asserts the collection is non-empty first, with a floor
rather than a bare presence test where the size is known:

```ts
// A regex that stopped matching would pass this silently, which is the failure the check
// exists to prevent wearing the costume of a pass.
expect(checked).toBeGreaterThan(0);
```

The same rule applies to a regex that scrapes a source file, a `git ls-files` glob, and a directory
walk. If the thing being read can come back empty, say what empty means.

### Before you delete a test

Delete freely, and say what you did. A behaviour pin goes with the code it pins; a contract's pin
goes when the contract lands somewhere better; a bound goes only with its limit; an instrument does
not go. What is not acceptable is deleting a test because it failed. If a bound goes red, either the
limit moved on purpose — change the bound and say why in the message — or you have found the thing
it was written for.

## Code rules

- Strict TypeScript and Zod at every trust boundary.
- No `any` or non-null assertion at a security boundary.
- No user content or credentials in logs, metrics, notifications, audit labels, or URLs.
- No model server, weight downloader, inference GPU deployment, or silent local fallback.
- External side effects must pass the common approval policy.
- Dynamic tools must be discoverable, bounded, scoped, and attributable.
- Prefer conflict-checked patches and idempotent mutations.
- Pin dependencies and GitHub Actions; update license notices and the lockfile together.
- A comment may say why the code is not the obvious thing. It may not say what the code used to be,
  or which wave changed it: that decays faster than the code and reads as fact long after it stops
  being one.
- No tracked file weighs another product against anything. The rule covers comments as surely as
  prose — the whole checkout lands on every owner's machine — and `scripts/check-repository.mjs`
  enforces it.
- Do not commit `.env`, generated builds, browser profiles, workspace volumes, or publisher OAuth
  state.

Contributions are accepted under the license of the component changed. By submitting a change, you
certify that you have the right to do so.

The browser layout drill is `pnpm test:ui`. It uses the runner’s installed Chromium and local
fixtures, with no provider credentials or network calls. It exercises responsive layout, keyboard
focus, effort drafts, preview playback, downloads, and expansion without restarting the preview.
Set `GARDEN_UI_REPORT` to a local directory to retain its screenshots.
The SVG drill checks real image rendering from attachment responses, script and external-resource
isolation, bounded streaming, failed loads, replacement cancellation and phone layout. Set
`GARDEN_SVG_REPORT` to retain its screenshot and request evidence.
The analysis-viewer drill also creates a real native run receipt and checks its project-file and
saved-result presentations, source editing, scoped downloads and phone layout. Set
`GARDEN_ANALYSIS_REPORT` to retain its screenshot and accessibility tree. The provenance drill
checks explicit parent navigation, current hashes, missing/changed records, stale response
cancellation and keyboard return using native run records. Set `GARDEN_PROVENANCE_REPORT` to retain
its phone screenshot and request evidence. The selected-rerun drill checks encrypted draft recovery,
server conflicts, changed-record refusal, conversation submission and phone layout. Set
`GARDEN_RERUN_REPORT` to retain its screenshot and request evidence.

The account-connection drill checks scoped consent, callback completion and recovery when a provider
severs the popup opener, using local fixtures. Set `GARDEN_ACCOUNT_REPORT` to retain its phone
screenshot and accessibility tree.

The private-diagnostics browser drill checks opt-in controls, lost acknowledgement recovery,
scoped download links, deletion and phone/keyboard layout. Set `GARDEN_DIAGNOSTIC_SCREENSHOT` to
retain its screenshot. The private replay command executes the real worker controller against recorded observations.
Every external boundary must refuse live fallback; tests disable transports during playback.

The project Git browser drill checks durable setup identity after an interrupted response,
scoped history downloads, cleanup of prepared downloads, and phone/keyboard layout. Set
`GARDEN_GIT_SCREENSHOT` to retain its screenshot.

The voice recovery browser drill uses a local WebSocket service and simulated audio. It checks
reconnection without another session, preserved mute, paused capture, keyboard Stop and phone
layout. Set `GARDEN_VOICE_SCREENSHOT` to retain its screenshot. Provider and physical audio-device
acceptance remain separate checks.

The native analysis recipe checks run when `GARDEN_TEST_MICROMAMBA` names a local micromamba
executable and a C compiler is available. They build a fixture executable and shared library,
exercise both archive formats, reproduce the result in a fresh directory, and reject dependency
or installer drift. The repository gate explicitly reports skipped optional toolchain coverage;
run installed native acceptance before releasing a change to that recipe.
