#!/bin/sh
# What `sudo garden doctor` says about a model the provider is withdrawing.
#
# The check under test is the only reader anywhere in this repository of a warning the catalogue
# refresh has been computing and storing since it was written: the withdrawal date on
# `model_releases.metadata`, rendered as `Retires <date>` and, until this arm existed, shown to
# nobody. So the assertions below are about a sentence reaching an owner, and each case exists
# because it is a state a live box can actually be in.
#
# The database is faked and nothing else is. `runuser` is replaced by a script that answers each of
# the three statements the arm issues from a fixture, which is what lets a case say "this catalogue
# holds 421 models, three of them going away, and the owner has pinned one" without a PostgreSQL.
# The rows are the shape the real queries return, verified against a live box on 2026-09-02.
#
# The single-quoted blocks below are literal fixture script bodies.
# shellcheck disable=SC2016
set -eu

repository_root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT INT TERM

fake_bin="$test_root/bin"
config="$test_root/etc/garden"
state="$test_root/state"
control_state="$test_root/control-state"
mkdir -p "$fake_bin" "$config" "$state" "$control_state" "$test_root/home"

failures=0

make_fake() {
  name="$1"
  shift
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$@"
  } >"$fake_bin/$name"
  chmod 0755 "$fake_bin/$name"
}

# `doctor` re-execs itself through sudo unless it is already root, and then asks the host about a
# dozen things that have nothing to do with models. Every one of those answers is a refusal here,
# which is deliberate: the arm under test must produce its sentence on a box where everything else
# is broken, because a diagnostic that only speaks on a healthy server is a diagnostic that never
# speaks when it is needed.
make_fake id '
if [ "${1:-}" = "-u" ]; then printf "0\n"; else printf "root\n"; fi'
make_fake systemctl 'exit 1'
make_fake pg_isready 'exit 1'
make_fake nginx 'exit 1'
make_fake fc-list 'exit 0'
make_fake curl 'exit 1'
make_fake jq 'exit 1'
make_fake df '
printf "Filesystem 1024-blocks Used Available Capacity Mounted\n"
printf "/dev/fake 1 1 99999999 1%% /\n"'

# The three statements the arm issues, told apart by a fragment of each that cannot appear in
# another, and answered from files the cases below write. An unrecognised statement answers
# nothing, which is what every other database read in `doctor` gets here.
#
# Each statement is also written out verbatim, because answering from a fixture proves the sentence
# and proves nothing whatever about the query that earned it. Measured: with the whole expiry arm
# deleted from the dependency statement - `WHERE missing` in place of `WHERE missing OR expires_on
# <> ''` - all thirteen rendering assertions below still passed. The replay at the end of this file
# is what closes that, and it runs the captured text rather than a second copy of the SQL.
make_fake runuser '
# The statement is the argument after -tAqc, taken positionally rather than by pattern, so what is
# replayed later is the exact text psql would have been handed.
statement=""
take_next=""
for argument in "$@"; do
  if [ -n "$take_next" ]; then statement=$argument; break; fi
  [ "$argument" = "-tAqc" ] && take_next=yes
done
case "$statement" in
  *"table_name = '"'"'task_schedules'"'"'"*)
    printf "%s" "$statement" >"$FIXTURES/statement-readable.sql"
    cat "$FIXTURES/readable" 2>/dev/null || true ;;
  *"COUNT(*) FILTER"*)
    printf "%s" "$statement" >"$FIXTURES/statement-counts.sql"
    cat "$FIXTURES/counts" 2>/dev/null || true ;;
  *"WITH horizon AS"*)
    printf "%s" "$statement" >"$FIXTURES/statement-dependencies.sql"
    # The one statement that can be made to fail here, because it is the one whose failure the
    # script feels: every other read in this arm ends in a pipe to `tr`, which swallows psql exit
    # status, and this one does not. A failing psql writes nothing to stdout and exits non-zero,
    # so that is exactly what this answers - no marker file means the ordinary answer below.
    [ -e "$FIXTURES/dependencies-error" ] && exit 2
    cat "$FIXTURES/dependencies" 2>/dev/null || true ;;
esac
exit 0'

printf 'x\n' >"$config/control.env"
printf 'x\n' >"$config/runner.env"
chmod 0600 "$config/control.env" "$config/runner.env"

fixtures="$test_root/fixtures"
mkdir -p "$fixtures"

run_doctor() {
  # GARDEN_ROOT is the real checkout, so `model_retirement_horizon_days` reads the horizon out of
  # the policy that enforces it rather than out of a fixture. That is the point of the constant
  # being read at all, and it is the one input here that is not faked.
  run_doctor_rooted "$repository_root"
}

# The same run against a different checkout, which is the only way to see whether the horizon was
# read or defaulted. Every assertion in this file that names 30 is satisfied by both, because 30 is
# also `model_retirement_horizon_days`'s fallback for a root it cannot read the constant out of -
# measured, with the `sed` expression in that function altered to match nothing, all of them stayed
# green. So a broken reader over an unchanged policy is invisible from the real root, and a broken
# reader over a policy that has since moved would print a horizon `doctor` no longer enforces.
run_doctor_rooted() {
  PATH="$fake_bin:$PATH" \
    FIXTURES="$fixtures" \
    GARDEN_ROOT="$1" \
    GARDEN_CONFIG="$config" \
    GARDEN_STATE="$state" \
    GARDEN_CONTROL_STATE="$control_state" \
    GARDEN_HOME="$test_root/home" \
    sh "$repository_root/scripts/garden" doctor 2>/dev/null || true
}

expect_line() {
  description="$1"
  pattern="$2"
  haystack="$3"
  if printf '%s\n' "$haystack" | grep -q -- "$pattern"; then
    printf 'ok    %s\n' "$description"
  else
    printf 'FAIL  %s\n' "$description"
    printf '      wanted a line matching: %s\n' "$pattern"
    printf '      the lines this drill reads were:\n'
    printf '%s\n' "$haystack" | grep 'model retirement\|model price ceiling' | sed 's/^/      /' ||
      printf '      (none)\n'
    failures=$((failures + 1))
  fi
}

expect_no_line() {
  description="$1"
  pattern="$2"
  haystack="$3"
  if printf '%s\n' "$haystack" | grep -q -- "$pattern"; then
    printf 'FAIL  %s\n' "$description"
    printf '      did not want a line matching: %s\n' "$pattern"
    failures=$((failures + 1))
  else
    printf 'ok    %s\n' "$description"
  fi
}

# ---------------------------------------------------------------------------
# The box as it actually stands. 421 models, 3 of them inside the horizon, one account with a pin
# on a model that is neither. The owner is told the mechanism is alive and that it is not about
# them, which is the answer a warning has to be able to give if its silence is to mean anything.
printf '2\n' >"$fixtures/readable"
printf '421|3\n' >"$fixtures/counts"
: >"$fixtures/dependencies"
report=$(run_doctor)
expect_line 'a healthy box is told the count and that nothing it depends on is going' \
  'note  model retirement: 3 of 421 models in the catalogue are withdrawn' "$report"
# 30 is `RETIREMENT_HORIZON_DAYS` in packages/core/src/model-policy.ts, read through
# `model_retirement_horizon_days` rather than restated in the shell. If the policy moves this fails
# on purpose: the sentence an owner reads names a number, and somebody has to re-read the sentence.
#
# It does NOT prove the number was read. 30 is also that function's fallback, so this line passes
# over a reader that finds nothing at all; the case below is the one that separates them, and this
# comment used to claim the separation for this line.
#
# Anchored to the retirement sentence and not left as a bare `within 30 days`, because that is what
# it was and it was saturated: `doctor` says "TLS certificate expires within 30 days" a few hundred
# lines further down, so with the horizon moved to 45 in the policy and the note correctly reading
# "within 45 days", this assertion went on passing against the certificate line.
expect_line 'the sentence names the horizon the policy enforces' \
  'model retirement: .*withdrawn by their provider within 30 days' "$report"
expect_no_line 'nothing depended on is going, so nothing is warned about' \
  'warn  model retirement' "$report"

# The reader itself, against a checkout whose policy says something other than 30. This is the only
# case in this file that does not use the real root, and it exists because every other one is
# satisfied by the fallback: `model_retirement_horizon_days` answers 30 when it cannot read the
# constant, so over today's policy a reader that matches nothing is indistinguishable from a reader
# that works. The failure that hides there is not a red drill, it is a `doctor` quietly reporting a
# 30-day horizon on a release that enforces some other one - and the same number is interpolated
# into both SQL statements, so the count and the dependency list would be about 30 days as well.
#
# 45 rather than 0 or 60-something arbitrary: it has to be a number nothing else in `doctor` prints,
# and "expires within 30 days" already appears in the certificate check further down.
horizon_root="$test_root/other-policy"
mkdir -p "$horizon_root/packages/core/src"
printf 'export const RETIREMENT_HORIZON_DAYS = 45;\n' \
  >"$horizon_root/packages/core/src/model-policy.ts"
horizon_report=$(run_doctor_rooted "$horizon_root")
expect_line 'the horizon is read from the policy rather than defaulted to the same number' \
  'model retirement: .*withdrawn by their provider within 45 days' "$horizon_report"

# ---------------------------------------------------------------------------
# The defect this arm exists for. `rankModels` short-circuits on an explicit `requestedId` and
# never reaches `isRetiringSoon`, so a pin is the one selection the health filter does not cover -
# and it was also the one selection nothing said anything about.
printf 'pin|dan|openrouter/nex-agi/nex-n2-pro|2026-09-08|Nex-N2-Pro\n' >"$fixtures/dependencies"
report=$(run_doctor)
expect_line 'a pinned model being withdrawn reaches the owner by name and date' \
  'warn  model retirement: the model dan pinned in Settings - Nex-N2-Pro (openrouter/nex-agi/nex-n2-pro) - is withdrawn by its provider on 2026-09-08' "$report"
expect_line 'and says why the routing did not already handle it' \
  'deliberately exempt from the routing' "$report"
# The pin's own consequence, which is the one that is true of a pin: `pickModelUnderPriceCeiling`
# in apps/api/src/routes/support.ts ranks the moment the pinned id stops resolving, so the account
# goes on working on a model nobody chose. Pinned here as well as the schedule's, so the two
# sentences cannot quietly collapse back into one.
expect_line 'a pin is told the quiet fallback that is true of a pin' \
  'the ranking then picks for that account instead without saying so' "$report"
expect_no_line 'the reassuring count is not also printed beside a warning' \
  'note  model retirement: 3 of 421' "$report"

# ---------------------------------------------------------------------------
# A schedule is the same setting for a run nobody is present for, and it is the case that matters
# most: the pin at least has a person at a screen who might notice the model list changed.
printf 'schedule|dan|openrouter/nex-agi/nex-n2-mini|2026-09-08|Nex-N2-Mini\n' >"$fixtures/dependencies"
report=$(run_doctor)
expect_line 'a schedule pinned to a withdrawn model is reported too' \
  'warn  model retirement: the model a schedule of dan runs on - Nex-N2-Mini (openrouter/nex-agi/nex-n2-mini) - is withdrawn by its provider on 2026-09-08' "$report"
# And it says what actually happens to a schedule, which is not what happens to a pin. Measured in
# apps/api/src/maintenance/schedule-dispatch.ts: `dispatchOneDueSchedule` finds the model in the
# catalogue itself, forces `model_unavailable` when it is absent, and the run never starts - after
# `MODEL_UNAVAILABLE_PAUSE_AFTER` of those the schedule is turned off. Nothing ranks. Both arms of
# this warning used to carry the pin's sentence, so the owner of the unattended case was told the
# one thing that was not true of it.
expect_line 'and says the schedule stops rather than falling back to the ranking' \
  'the schedule does not fall back to anything - its runs fail to start' "$report"
expect_no_line 'so it does not promise a schedule the fallback only a pin gets' \
  'the ranking then picks for that account instead' "$report"
# The line above is anchored to the pin arm's wording as it stands, which catches a collapse back
# into one shared sentence and does not catch a regression to the wording this arm carried before
# the split: "it is used until it stops answering and then falls back to the ranking without saying
# so". Replaying that exact sentence into the schedule arm left this drill red on one assertion
# rather than two, so the claim is pinned here as well as the phrasing. Nothing correct on a
# schedule line says "ranking" at all - the warning's fixed half says "routing", and both schedule
# sentences say the runs stop - so any ranking promised to a schedule is the defect returning in
# whatever words.
expect_no_line 'and a schedule is never told the ranking picks up after it, in any wording' \
  'model a schedule of .*ranking' "$report"

# ---------------------------------------------------------------------------
# After the withdrawal. `support.ts` falls back to the ranking rather than failing the run, which
# is correct and is why nothing on the box ever mentions it: the setting is simply not being used.
printf 'pin|dan|openrouter/nex-agi/nex-n2-pro||\n' >"$fixtures/dependencies"
report=$(run_doctor)
expect_line 'a pin on a model that is gone says the setting is already being ignored' \
  "warn  model retirement: the model dan pinned in Settings - openrouter/nex-agi/nex-n2-pro - is not in this server's catalogue at all" "$report"

# ---------------------------------------------------------------------------
# Two accounts, two problems, two lines. The loop reads rows rather than a first row.
{
  printf 'pin|dan|openrouter/nex-agi/nex-n2-pro|2026-09-08|Nex-N2-Pro\n'
  printf 'schedule|dan|openrouter/dots-studio/dots-3-note-preview:free|2026-09-30|Dots3-Note Preview (free)\n'
} >"$fixtures/dependencies"
report=$(run_doctor)
expect_line 'every dependency is reported, not the first' \
  'Nex-N2-Pro (openrouter/nex-agi/nex-n2-pro)' "$report"
expect_line 'including the second one' \
  'Dots3-Note Preview (free) (openrouter/dots-studio/dots-3-note-preview:free)' "$report"

# ---------------------------------------------------------------------------
# A database that did not answer. The whole value of the reassuring line is that it is only printed
# when something was actually read, so an empty answer must not be rendered as "nothing is going".
printf '2\n' >"$fixtures/readable"
: >"$fixtures/counts"
: >"$fixtures/dependencies"
report=$(run_doctor)
expect_line 'an unanswered catalogue is reported as unknown, not as clear' \
  'note  model retirement: the catalogue did not answer' "$report"
expect_no_line 'and never as a count' \
  'models in the catalogue are withdrawn' "$report"

# ---------------------------------------------------------------------------
# A release too old to hold a withdrawal date at all. Saying so plainly beats a silence that reads
# exactly like a catalogue with nothing being withdrawn in it.
printf '0\n' >"$fixtures/readable"
printf '421|3\n' >"$fixtures/counts"
report=$(run_doctor)
expect_line 'a schema with no column for the date says so rather than staying quiet' \
  "note  model retirement: this release's database has no column for a withdrawal date" "$report"

# One of the two columns is the same answer as neither: `model_releases.metadata` without
# `task_schedules.model_id` can report on pins and is blind to every schedule, which is half the
# question and must not read as all of it.
printf '1\n' >"$fixtures/readable"
report=$(run_doctor)
expect_line 'half the columns is a release that cannot answer, and is told so' \
  "note  model retirement: this release's database has no column for a withdrawal date" "$report"

# ---------------------------------------------------------------------------
# No database to ask. `runuser` answers nothing at all - a stopped PostgreSQL, a `psql` that is not
# installed, a `runuser` that is not either - so the schema probe comes back empty rather than as a
# number.
#
# This is the case the guard used to get wrong, and it got it wrong in the worst available
# direction: an empty answer is not 2, so the owner was told "this release's database has no column
# for a withdrawal date", which is a fact about their release that nothing had established. A check
# that could not run has to read as silence. The count guard one branch below has said so since it
# was written - "must not be rendered as the reassuring one" - and this guard was reading its own
# empty answer as a confident zero.
: >"$fixtures/readable"
printf '421|3\n' >"$fixtures/counts"
report=$(run_doctor)
expect_line 'a database that did not answer says so rather than blaming the release' \
  'note  model retirement: the database did not answer, so it is not known whether this release can even record a withdrawal date' "$report"
expect_no_line 'and does not state a fact about the release it never established' \
  "no column for a withdrawal date" "$report"
expect_no_line 'and does not reach the counts on a schema it could not confirm' \
  'models in the catalogue are withdrawn by their provider' "$report"

# The guard four lines away in `doctor` reads the same silence the same way. It had the identical
# collapse - `spend_ceiling_storable` returning false for a down database and for an old schema
# alike - and under this drill's fake host, which answers nothing to the `spend_limits` probe in
# every case above as well, it is in exactly that state. Pinned here rather than in a drill of its
# own because the defect is that two adjacent lines of one report disagreed about one failure, and
# that is only visible in one report.
expect_line 'the price ceiling guard beside it reads an unanswered database the same way' \
  'note  model price ceiling: the database did not answer' "$report"
expect_no_line 'rather than telling the owner their release cannot hold a ceiling' \
  'model price ceiling: this release has no column to store one' "$report"

# ---------------------------------------------------------------------------
# A database that answered two statements and errored on the third. Not a hypothetical: the three
# reads are three separate `psql` invocations, so a connection can drop between them, a statement
# timeout can land on the slowest of them, and only the first two columns either statement needs
# are probed for - a schema carrying `model_releases.metadata` and `task_schedules.model_id` but
# not `users.preferences` reaches this statement and fails inside it.
#
# THE REASON THIS CASE EXISTS. `model_retirement_columns` and `model_retirement_counts` both end in
# `| tr`, so psql's exit status is the pipe's and their failures arrive as an empty answer, which
# the two arms above read correctly. `model_retirement_dependencies` ends in `runuser` itself, so
# its failure is the assignment's status and `set -eu` at the top of `scripts/garden` ended
# `doctor` on that line - the spending brake, the update state, the backup age and the disk all
# silently unreached, with a bare exit 2 as the only sign. Hence the third assertion, which is
# about the rest of the report existing rather than about models at all. Re-run it by putting the
# bare assignment back: two of these three go red, and the run stops mid-report.
printf '2\n' >"$fixtures/readable"
printf '421|3\n' >"$fixtures/counts"
: >"$fixtures/dependencies-error"
report=$(run_doctor)
rm -f "$fixtures/dependencies-error"
expect_line 'a dependency query that errored is reported as unknown' \
  'note  model retirement: the catalogue answered, but the question of what on this server depends on a model it is withdrawing did not' "$report"
expect_no_line 'and is not read as nothing on this box depending on a dying model' \
  'no pin or schedule on this server names one of them' "$report"
# `disk headroom` is the last line `doctor` prints, and the fake `df` above makes it a fixed one.
# Anchored on the end of the report rather than on a count of lines, because a line count is a
# number that has to be re-read every time any other check is added.
expect_line 'and the rest of the report is still printed rather than the run ending there' \
  'ok    disk headroom' "$report"

# ---------------------------------------------------------------------------
# The statements themselves, replayed against a real PostgreSQL over a schema shaped like the one
# on a live box, because everything above this line would pass over a query that answered by
# accident. What is replayed is the text the runs above captured, not a second copy kept in step by
# hand - a query written twice is a query that disagrees with itself the first time one is edited.
#
# The rows are relative to CURRENT_DATE rather than written as dates, so the boundary case stays a
# boundary case next year. `m-bad` is the one that is not about arithmetic: a provider feed is free
# JSON, and `soon` sorts below every real ISO date, so without the pattern guard it would be
# reported to an owner as a model going away this month.
pglite_entry="$repository_root/packages/data/node_modules/@electric-sql/pglite/dist/index.js"
if [ ! -r "$pglite_entry" ]; then
  # Loud rather than quiet. A replay that silently does not run is the saturated harness this
  # section exists to replace, wearing a green tick.
  printf 'FAIL  the SQL replay needs @electric-sql/pglite; run pnpm install\n' >&2
  failures=$((failures + 1))
elif [ -n "${SKIP_SQL_REPLAY:-}" ]; then
  printf 'note  SQL replay skipped by SKIP_SQL_REPLAY\n'
else
  FIXTURES="$fixtures" PGLITE_ENTRY="$pglite_entry" \
    node --input-type=module - <<'REPLAY' || failures=$((failures + 1))
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_ENTRY);

const fixtures = process.env.FIXTURES;
const read = (name) => readFileSync(`${fixtures}/statement-${name}.sql`, 'utf8');
let failed = 0;
// A count comes back from PGlite as a BigInt, which JSON.stringify refuses outright, so both sides
// are rendered the same way before they are compared rather than one of them being coerced.
const shown = (value) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}` : item));
const check = (description, actual, wanted) => {
  const got = shown(actual);
  const want = shown(wanted);
  if (got === want) return void console.log(`ok    ${description}`);
  failed += 1;
  console.log(`FAIL  ${description}\n      wanted ${want}\n      got    ${got}`);
};

const database = new PGlite();
await database.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, preferences JSONB NOT NULL);
  CREATE TABLE model_releases (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, metadata JSONB NOT NULL);
  CREATE TABLE task_schedules (id TEXT PRIMARY KEY, user_id TEXT, model_id TEXT, enabled BOOLEAN NOT NULL);

  INSERT INTO model_releases(id, display_name, metadata)
  SELECT id, name, jsonb_build_object('expiresAt', expires)
  FROM (VALUES
    ('m-soon-1', 'Soon One',  to_char(CURRENT_DATE + 6,  'YYYY-MM-DD')),
    ('m-soon-2', 'Soon Two',  to_char(CURRENT_DATE + 6,  'YYYY-MM-DD')),
    ('m-soon-3', 'Soon Three',to_char(CURRENT_DATE + 28, 'YYYY-MM-DD')),
    ('m-edge',   'On The Day',to_char(CURRENT_DATE + 30, 'YYYY-MM-DD')),
    ('m-past',   'Just Past', to_char(CURRENT_DATE + 31, 'YYYY-MM-DD')),
    ('m-far',    'Sentinel',  '2098-12-31'),
    ('m-bad',    'Malformed', 'soon'),
    ('m-empty',  'Blank',     '')
  ) AS seed(id, name, expires);
  INSERT INTO model_releases(id, display_name, metadata)
  VALUES ('m-quiet', 'No Expiry At All', '{}'::jsonb);

  INSERT INTO users(id, username, preferences) VALUES
    ('u1','pinner',   '{"model":{"modelId":"m-soon-1","automatic":false,"preference":"best"}}'),
    ('u2','automatic','{"model":{"modelId":"m-soon-2","automatic":true,"preference":"best"}}'),
    ('u3','blank',    '{"model":{"modelId":"","automatic":false,"preference":"best"}}'),
    ('u4','content',  '{"model":{"modelId":"m-far","automatic":false,"preference":"best"}}'),
    ('u5','stranded', '{"model":{"modelId":"m-vanished","automatic":false,"preference":"best"}}'),
    ('u6','unlucky',  '{"model":{"modelId":"m-bad","automatic":false,"preference":"best"}}'),
    ('u7','nodial',   '{"place":{"taskId":null,"workspaceId":null}}');

  INSERT INTO task_schedules(id, user_id, model_id, enabled) VALUES
    ('s1','u1','m-soon-3', TRUE),
    ('s2','u1','m-soon-1', FALSE),
    ('s3','u1', NULL,      TRUE);
`);

const scalar = async (name) => (await database.query(read(name))).rows[0];
const readable = await scalar('readable');
check(
  'the guard finds both columns a live schema carries',
  Object.values(readable ?? {}).map(Number),
  [2]
);

const counts = await scalar('counts');
// Nine models. Four are inside the horizon, the fourth being the one landing exactly on the edge:
// `<=` is the comparison, so a model withdrawn on the last day of the horizon is inside it.
// `m-past` is one day out, `m-far` is the provider sentinel, and `m-bad`, `m-empty` and `m-quiet`
// publish nothing this can read.
check('nine models, four of them going', Object.values(counts ?? {}), ['9|4']);

const dependencies = (await database.query(read('dependencies'))).rows.map(
  (row) => Object.values(row)[0]
);
// Read off the same clock the rows were seeded from. The rows are `CURRENT_DATE + n` in the
// database's own day; a date computed here from the process clock in UTC is a different day for
// two hours out of every twenty-four on a box east of Greenwich, and this check failed for exactly
// that reason at one in the morning.
const today = async (days) =>
  String(
    Object.values(
      (await database.query(`SELECT to_char(CURRENT_DATE + ${days}, 'YYYY-MM-DD') AS day`)).rows[0]
    )[0]
  );
check(
  'only the pins and schedules with something wrong come back, in order',
  dependencies,
  [
    `pin|pinner|m-soon-1|${await today(6)}|Soon One`,
    'pin|stranded|m-vanished||',
    `schedule|pinner|m-soon-3|${await today(28)}|Soon Three`
  ]
);

await database.close();
process.exit(failed === 0 ? 0 : 1);
REPLAY
fi

if [ "$failures" -eq 0 ]; then
  printf '\nall doctor retirement checks passed\n'
else
  printf '\n%s doctor retirement check(s) failed\n' "$failures" >&2
  exit 1
fi
