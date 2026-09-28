#!/bin/sh
# What `garden update` has to keep in agreement with the checkout, and what has to be said out loud
# when it does not.
#
# `scripts/test-update.sh` drills the update as a transaction - it succeeds, it rolls back, it puts
# the data back. This drills the three things that were true *while* all of that worked perfectly:
#
#   1. The managed Chromium was fetched by the installer once and never again, so the first release
#      to bump the pinned Playwright left every existing box driving a browser it no longer has -
#      and `doctor` asked only whether ~/.cache/ms-playwright exists, which it does, holding last
#      release's revision. Verified broken on a live server: checkout wanted 1234, cache held 1228,
#      every check green, every browser job failing.
#   2. A failed unattended update wrote nothing down. The rollback works, so the box is healthy and
#      simply stops receiving releases - weekly, for as long as the cause lasts, in silence.
#   3. `spend-ceiling` set a price per million tokens while wearing the name of a money cap, and the
#      money cap had no command at all.
#
# The script is sourced rather than driven, because `garden help` prints the usage line and returns
# without exiting - so every function is in hand afterwards and each rule can be asked directly
# instead of through a whole update. There is exactly one copy of each rule, which is the point:
# `doctor` and `update` both call these, so a drill against them is a drill against both.
set -eu

repository_root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT INT TERM

fake_root="$test_root/opt/garden"
fake_home="$test_root/home/garden"
fake_state="$test_root/state"
browsers_json="$fake_root/services/workspace-runner/node_modules/playwright-core/browsers.json"
mkdir -p "$(dirname "$browsers_json")" "$fake_home" "$fake_state"
# The two files this script reads a number out of rather than restating it. `garden_root` is a
# checkout on a real box, so the fixture is one too - and copying them rather than pointing at the
# originals is what makes a case that silently reads the repository impossible to write here.
mkdir -p "$fake_root/packages/data/src/store" "$fake_root/packages/contracts/src"
cp "$repository_root/packages/data/src/store/billing.ts" \
  "$fake_root/packages/data/src/store/billing.ts"
cp "$repository_root/packages/contracts/src/index.ts" \
  "$fake_root/packages/contracts/src/index.ts"

write_browsers() {
  cat >"$browsers_json" <<JSON
{
  "browsers": [
    { "name": "chromium", "revision": "$1", "browserVersion": "149.0.7827.55" },
    { "name": "chromium-headless-shell", "revision": "$1" },
    { "name": "firefox", "revision": "1500" }
  ]
}
JSON
}

place_chromium() {
  mkdir -p "$fake_home/.cache/ms-playwright/chromium-$1" \
    "$fake_home/.cache/ms-playwright/chromium_headless_shell-$1"
}

fail_case() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

# Sourced with the one command that returns rather than exits. Usage goes to /dev/null; the
# functions stay. `set --` rather than arguments after the dot, because dash's `.` takes none and
# would run the dispatch on this script's own arguments instead.
GARDEN_ROOT="$fake_root"
GARDEN_HOME="$fake_home"
GARDEN_STATE="$fake_state"
export GARDEN_ROOT GARDEN_HOME GARDEN_STATE
set -- help
. "$repository_root/scripts/garden" >/dev/null

# ---------------------------------------------------------------------------------------------
# 1. The managed Chromium, by revision.
# ---------------------------------------------------------------------------------------------

write_browsers 1228
place_chromium 1228
test "$(managed_chromium_revision)" = 1228 ||
  fail_case "the wanted Chromium revision was not read out of the pinned Playwright"
test -z "$(managed_chromium_absent)" ||
  fail_case "a cache holding the wanted revision was reported as missing it"
printf 'ok  the Chromium revision is read from the dependency that decides it\n'

# The live failure, exactly. `playwright-core` pins a revision rather than a range, so the release
# that bumps it is the release the browser on disk stops being the one the code launches. The old
# check asked whether the cache directory exists - it does, holding 1228 - and reported health.
write_browsers 1234
test -d "$fake_home/.cache/ms-playwright" ||
  fail_case "the fixture is wrong: the old check would not have passed here"
test "$(managed_chromium_absent)" = 1234 ||
  fail_case "a Playwright bump left the box on the old revision and nothing noticed"
printf 'ok  a Playwright bump is seen as a missing browser rather than as a healthy cache\n'

# And fetching it clears the fault, which is what `update_garden` now does before the restart.
place_chromium 1234
test -z "$(managed_chromium_absent)" ||
  fail_case "fetching the wanted revision did not clear the fault"
printf 'ok  fetching the wanted revision clears it\n'

# A fetch interrupted partway leaves one of the two directories. The runner launches the headless
# shell and Playwright's own probe reaches for the full browser, so half a cache is not a cache -
# and it is indistinguishable from a whole one to anything that only counts directories.
rm -rf "$fake_home/.cache/ms-playwright/chromium_headless_shell-1234"
test "$(managed_chromium_absent)" = 1234 ||
  fail_case "a half-fetched cache was reported as complete"
printf 'ok  a fetch interrupted partway is not mistaken for a complete one\n'

# With no pinned Playwright there is nothing to compare against, and the answer is nothing rather
# than a guess. `doctor` reports that separately, because it is a different fault with a different
# repair, and `update` skips the fetch instead of running a downloader that is not there.
mv "$browsers_json" "$browsers_json.away"
test -z "$(managed_chromium_revision)" ||
  fail_case "a revision was invented with no pinned Playwright to read it from"
test -z "$(managed_chromium_absent)" ||
  fail_case "a missing dependency was reported as a missing browser"
mv "$browsers_json.away" "$browsers_json"
printf 'ok  a missing Playwright answers nothing rather than guessing\n'

# ---------------------------------------------------------------------------------------------
# 2. The unattended update, written down.
# ---------------------------------------------------------------------------------------------

record_update_status ok ''
test "$(update_status_field outcome)" = ok ||
  fail_case "a completed update recorded nothing"
test -n "$(update_status_field at)" || fail_case "the record does not say when"
test -n "$(update_status_field revision)" ||
  fail_case "the record does not say what revision the box is on"
printf 'ok  a completed update records when it happened and what the box is running\n'

# What OnFailure= is for. A run stopped by its own two-hour limit, or by the power going off,
# never reaches a line that could write anything - so the pessimistic record it left on the way in
# is the one that has to stand, and something has to turn it into a report.
record_update_status running ''
auto_update_alert >/dev/null 2>&1 || true
test "$(update_status_field outcome)" = failed ||
  fail_case "a run stopped before it finished was left recorded as still running"
case "$(update_status_field reason)" in
  *'stopped before it finished'*) ;;
  *) fail_case "the reason a killed run left behind is not readable: $(update_status_field reason)" ;;
esac
printf 'ok  an update killed before it finished is recorded as failed\n'

# And it fires after successful runs too, so it must leave those alone.
record_update_status ok ''
auto_update_alert >/dev/null 2>&1 || true
test "$(update_status_field outcome)" = ok ||
  fail_case "the alert filed a report about an update that did not fail"
printf 'ok  a finished update is left alone by the alert\n'

# The three endings `auto_update_run` can reach itself, each said in the words the interface uses.
record_update_status skipped 'a task was still running when the window came round'
case "$(report_update_status)" in
  *'stood down'*'a task was still running'*) ;;
  *) fail_case "a run that stood down is not reported as one: $(report_update_status)" ;;
esac
record_update_status failed 'the update was rolled back and the previous release put back'
case "$(report_update_status)" in
  *'failed'*'rolled back'*) ;;
  *) fail_case "a failed run is not reported as one: $(report_update_status)" ;;
esac
rm -f "$fake_state/update.status"
case "$(report_update_status)" in
  *'nothing recorded yet'*) ;;
  *) fail_case "a box that has never run one does not say so: $(report_update_status)" ;;
esac
printf 'ok  every ending an update run can have is reported in the owner words\n'

# ---------------------------------------------------------------------------------------------
# 3. The spending cap, and the command that used to wear its name.
# ---------------------------------------------------------------------------------------------

test "$(spend_cap_amount 20)" = 20 || fail_case "a whole-dollar cap was refused"
test "$(spend_cap_amount 5.50)" = 5.50 || fail_case "a cap with pence was refused"
test "$(spend_cap_amount none)" = NULL || fail_case "clearing a cap did not become a NULL"
for refused in -5 abc '20; DROP TABLE users' '' '1e9'; do
  if (spend_cap_amount "$refused" >/dev/null 2>&1); then
    fail_case "an amount that is not an amount was accepted: '$refused'"
  fi
done
printf 'ok  a spending cap is an amount or nothing, and nothing else reaches the statement\n'

# The default the running code applies to a box with no row, read out of the file that decides it.
# `garden price-ceiling set` creates that row, and every money cap in a new row is NULL - so before
# this was read, setting a price per million tokens silently removed the only dollar ceiling on the
# box. A number this script invented instead would stop a run at a figure nothing can account for.
monthly_default=$(default_monthly_cap)
case "$monthly_default" in
  '' | *[!0-9]*) fail_case "the monthly cap default could not be read: '$monthly_default'" ;;
esac
grep -q "^export const DEFAULT_MONTHLY_CAP_USD = $monthly_default;\$" \
  "$repository_root/packages/data/src/store/billing.ts" ||
  fail_case "the default read here is not the one the running code applies"

# Derived, not copied, and this is what proves it. The first draft of this case asserted only that
# the two numbers agreed - which they do just as well when one of them is a literal typed into this
# script, and a literal is precisely the failure the reading exists to prevent. Moving the number in
# the fixture checkout has to move the answer.
sed -i.away 's/^export const DEFAULT_MONTHLY_CAP_USD = [0-9][0-9]*;$/export const DEFAULT_MONTHLY_CAP_USD = 37;/' \
  "$fake_root/packages/data/src/store/billing.ts"
moved_default=$(default_monthly_cap)
cp "$fake_root/packages/data/src/store/billing.ts.away" \
  "$fake_root/packages/data/src/store/billing.ts"
test "$moved_default" = 37 ||
  fail_case "the monthly cap default is a copy in this script, not a reading: got '$moved_default'"

# And the statement that creates the row has to be the one that carries it. A `spend_limits` row
# created with every money cap NULL takes the running default off the box, which is how a command
# about dollars per million tokens came to remove the only dollar ceiling there was.
ceiling_insert=$(
  sed -n '/^INSERT INTO spend_limits (user_id, max_input_usd_per_million_tokens,/,/^SQL$/p' \
    "$repository_root/scripts/garden"
)
case "$ceiling_insert" in
  *monthly_cap_usd*'$(default_monthly_cap)'*) ;;
  *) fail_case "setting a price ceiling creates a row with no monthly cap, removing the default" ;;
esac
printf 'ok  the monthly cap default comes from the code that applies it, not from here\n'

# The rename, and the old name still answering. An owner with `spend-ceiling` in a note should be
# told what it is called now and that there is now a real cap - not told there is no such command.
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
printf '#!/bin/sh\nif [ "${1:-}" = "-u" ]; then printf "0\\n"; else printf "root\\n"; fi\n' \
  >"$fake_bin/id"
chmod 0755 "$fake_bin/id"
alias_output=$(
  PATH="$fake_bin:$PATH" GARDEN_ROOT="$fake_root" GARDEN_HOME="$fake_home" \
    GARDEN_STATE="$fake_state" \
    /bin/sh "$repository_root/scripts/garden" spend-ceiling show 2>&1 || true
)
case "$alias_output" in
  *'garden price-ceiling'*'spend-cap'*) ;;
  *) fail_case "the old name does not name the new one: $alias_output" ;;
esac
usage_output=$(/bin/sh "$repository_root/scripts/garden" help 2>&1 || true)
case "$usage_output" in
  *'price-ceiling'*) ;;
  *) fail_case "the usage line does not offer price-ceiling" ;;
esac
case "$usage_output" in
  *'spend-cap'*) ;;
  *) fail_case "the usage line does not offer spend-cap" ;;
esac
printf 'ok  the price ceiling is named for what it does and the spending cap has a command\n'
