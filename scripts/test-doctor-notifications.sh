#!/bin/sh
# What `sudo garden doctor` says about whether a notification can reach anybody.
#
# The check under test reads the notification service's health port, and the defect it exists for
# was measured on a live box: `push_subscriptions` held zero rows, `notification_deliveries` had
# never held one, four approval cards had parked tasks waiting for a person during one hour, and
# `doctor` printed `ok    push notification delivery`. The payload said `endpointsFailing:0`, which
# is trivially true when there are no endpoints, and nothing counted the endpoints that existed.
# So "every device is healthy" and "there is no device" were one answer, and it was the reassuring
# one. The cases below are about that distinction reaching the owner.
#
# The health port is faked and nothing else is: `curl` answers the notification service's URL from
# a fixture and refuses every other, which is what lets a case say "the service is up, sending, and
# has nobody to send to" without a running service. The payload shapes are the ones
# `services/notifications/src/index.ts` serves, verified against a live box on 2026-09-03.
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
# dozen things that have nothing to do with notifications. Every one of those answers is a refusal
# here, deliberately: the line under test must be produced on a box where everything else is
# broken, because a diagnostic that only speaks on a healthy server never speaks when it is needed.
make_fake id '
if [ "${1:-}" = "-u" ]; then printf "0\n"; else printf "root\n"; fi'
make_fake systemctl 'exit 1'
make_fake pg_isready 'exit 1'
make_fake nginx 'exit 1'
make_fake fc-list 'exit 0'
make_fake jq 'exit 1'
make_fake runuser 'exit 1'
make_fake df '
printf "Filesystem 1024-blocks Used Available Capacity Mounted\n"
printf "/dev/fake 1 1 99999999 1%% /\n"'

# The one URL this drill answers, told apart by its port, and answered from a file the cases below
# write. Every other address `doctor` asks about - the API, the runner, the relay - is refused, so a
# case here can only be satisfied by the notification arm reading the notification payload.
make_fake curl '
for argument in "$@"; do
  case "$argument" in
    *127.0.0.1:4203/healthz*) cat "$FIXTURES/notifications-health"; exit 0 ;;
  esac
done
exit 1'

printf 'x\n' >"$config/control.env"
printf 'x\n' >"$config/runner.env"
chmod 0600 "$config/control.env" "$config/runner.env"

fixtures="$test_root/fixtures"
mkdir -p "$fixtures"

run_doctor() {
  PATH="$fake_bin:$PATH" \
    FIXTURES="$fixtures" \
    GARDEN_ROOT="$repository_root" \
    GARDEN_CONFIG="$config" \
    GARDEN_STATE="$state" \
    GARDEN_CONTROL_STATE="$control_state" \
    GARDEN_HOME="$test_root/home" \
    sh "$repository_root/scripts/garden" doctor 2>/dev/null || true
}

# The lines this drill is about, so a failure prints what the owner would have read.
notification_lines() {
  printf '%s\n' "$1" | grep 'notification' | sed 's/^/      /' || printf '      (none)\n'
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
    printf '      the notification lines were:\n'
    notification_lines "$haystack"
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
    printf '      the notification lines were:\n'
    notification_lines "$haystack"
    failures=$((failures + 1))
  else
    printf 'ok    %s\n' "$description"
  fi
}

# The payload as the service serves it, with the three numbers the cases vary. `$4` is the phone
# transport's block, which sits after the counts in the served order.
health() {
  printf '{"ok":true,"service":"notifications","deliveryEnabled":true,"pushEnabled":true,"titlesReadable":true,"endpointsFailing":%s,"endpointsRetired":0,"endpointsTotal":%s,"destinationsPaired":%s,"destinations":{"telegram":%s}}' \
    "$1" "$2" "$3" "$4"
}
no_phone='{"paired":false,"polling":false,"pollAgeMs":null}'
polled_phone='{"paired":true,"polling":true,"pollAgeMs":1200}'

# ---------------------------------------------------------------------------
# The box as it was measured. Keys configured, the service up and sweeping, and not one device or
# phone for anything to go to. Zero endpoints failing is a fact about nothing.
health 0 0 0 "$no_phone" >"$fixtures/notifications-health"
report=$(run_doctor)
expect_line 'a box with nothing enrolled is warned, and told what enrolling is' \
  'warn  no device or phone is enrolled for notifications' "$report"
expect_line 'and the warning says where a device is enrolled' \
  'Turn on notifications' "$report"
expect_line 'and where a phone is paired' \
  'Your phone' "$report"
expect_no_line 'and is not also told delivery is fine' \
  'ok    push notification delivery' "$report"

# ---------------------------------------------------------------------------
# One subscribed device and nothing refusing: the ordinary healthy box, and the only shape the old
# check was ever right about.
health 0 1 0 "$no_phone" >"$fixtures/notifications-health"
report=$(run_doctor)
expect_line 'a subscribed device that is not refusing is delivery that works' \
  'ok    push notification delivery' "$report"
expect_no_line 'and nothing is said about enrolling' \
  'warn  no device or phone is enrolled' "$report"

# ---------------------------------------------------------------------------
# A phone and no browser. The owner chose the other transport, which is a complete answer: the
# device count is zero and that is not a warning here.
health 0 0 1 "$polled_phone" >"$fixtures/notifications-health"
report=$(run_doctor)
expect_line 'a paired phone with no browser subscription is not told to enrol a device' \
  'ok    push notification delivery' "$report"
expect_no_line 'a paired phone is enrolment enough' \
  'warn  no device or phone is enrolled' "$report"
expect_line 'and the phone line beside it still stands on its own' \
  'ok    phone notification transport' "$report"

# ---------------------------------------------------------------------------
# The same phone on a box with no DATA_MASTER_KEY. Paired is the owner's half; this box's half is
# reading from the phone, and that stops without the key that opens the bot token - and then
# nothing can be sent to the phone either, so a count of one is a count of nothing reachable.
# Measured on such a box: `ok    push notification delivery`, one line above the warning saying
# the phone could not be read from.
printf '{"ok":true,"service":"notifications","deliveryEnabled":true,"pushEnabled":true,"titlesReadable":false,"endpointsFailing":0,"endpointsRetired":0,"endpointsTotal":0,"destinationsPaired":1,"destinations":{"telegram":{"paired":true,"polling":false,"pollAgeMs":null}}}' \
  >"$fixtures/notifications-health"
report=$(run_doctor)
expect_no_line 'a paired phone the service is not reading from is not delivery that works' \
  'ok    push notification delivery' "$report"
expect_line 'and the delivery line says the one route there is cannot be reached' \
  'warn  the only notification route is a paired phone this box is not reading from' "$report"
expect_line 'and the phone line beside it still says why' \
  'warn  a phone is paired for notifications but the service is not reading from it' "$report"

# ---------------------------------------------------------------------------
# A device subscribed, and the signing keys gone since. A master key keeps the service delivering,
# so the switched-off warning does not fire, and one device is one device nothing can sign a push
# for. Subscribing is gated on the keys, so this is a box whose keys were removed after a device
# enrolled - an edge, and the same shape as the phone above.
printf '{"ok":true,"service":"notifications","deliveryEnabled":true,"pushEnabled":false,"titlesReadable":true,"endpointsFailing":0,"endpointsRetired":0,"endpointsTotal":1,"destinationsPaired":0,"destinations":{"telegram":%s}}' \
  "$no_phone" >"$fixtures/notifications-health"
report=$(run_doctor)
expect_no_line 'a subscribed device with no signing keys to send with is not delivery that works' \
  'ok    push notification delivery' "$report"
expect_line 'and the delivery line says what is missing' \
  'warn  a device is subscribed for notifications but there are no Web Push signing keys' "$report"

# ---------------------------------------------------------------------------
# Two devices, one of them refusing. The warning that already existed, still reached, and not
# displaced by the count: a box with devices that are failing is not a box with no devices.
health 1 2 0 "$no_phone" >"$fixtures/notifications-health"
report=$(run_doctor)
expect_line 'a refusing device is still reported as refusing' \
  'warn  a device is refusing notifications' "$report"
expect_no_line 'and not as delivery that works' \
  'ok    push notification delivery' "$report"

# ---------------------------------------------------------------------------
# The service answered and could not count: its database did not. That is not zero and it is not
# fine, and the two are told apart because the one below reads exactly like this one otherwise.
health 0 null null "$no_phone" >"$fixtures/notifications-health"
report=$(run_doctor)
expect_line 'a count the service could not make is reported as unknown' \
  'note  push notification delivery: the service is sending but could not count' "$report"
expect_no_line 'and not as nothing enrolled' \
  'warn  no device or phone is enrolled' "$report"
expect_no_line 'and not as delivery that works' \
  'ok    push notification delivery' "$report"

# ---------------------------------------------------------------------------
# A notifier from before the count existed. It cannot say how many devices there are, and its
# silence is read as exactly that rather than as a reassuring zero refusing.
printf '{"ok":true,"service":"notifications","deliveryEnabled":true,"titlesReadable":true,"endpointsFailing":0,"endpointsRetired":0}' \
  >"$fixtures/notifications-health"
report=$(run_doctor)
expect_line 'a service that does not count devices is not read as having healthy ones' \
  'note  push notification delivery: the service is sending but could not count' "$report"
expect_no_line 'and its zero refusing is not read as delivery that works' \
  'ok    push notification delivery' "$report"

# ---------------------------------------------------------------------------
# Switched off, which comes first whatever the counts say: a device enrolled on a box with no
# signing keys is a device nothing can sign a push for.
printf '{"ok":true,"service":"notifications","deliveryEnabled":false,"pushEnabled":false,"titlesReadable":true,"endpointsFailing":0,"endpointsRetired":0,"endpointsTotal":1,"destinationsPaired":0,"destinations":{"telegram":%s}}' \
  "$no_phone" >"$fixtures/notifications-health"
report=$(run_doctor)
expect_line 'no signing keys is reported before any count is' \
  'warn  push notifications are switched off' "$report"
expect_no_line 'and a device enrolled on that box is not delivery that works' \
  'ok    push notification delivery' "$report"

# `disk headroom` is the last line `doctor` prints, and the fake `df` above makes it a fixed one:
# the arm must not end the run, whatever it printed.
expect_line 'and the rest of the report is still printed' \
  'ok    disk headroom' "$report"

if [ "$failures" -eq 0 ]; then
  printf '\nall doctor notification checks passed\n'
else
  printf '\n%s doctor notification check(s) failed\n' "$failures" >&2
  exit 1
fi
