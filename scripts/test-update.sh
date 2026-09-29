#!/bin/sh
# The single-quoted blocks below are literal fixture script bodies.
# shellcheck disable=SC2016
set -eu

repository_root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT INT TERM

remote="$test_root/remote.git"
seed="$test_root/seed"
checkout="$test_root/checkout"
fake_bin="$test_root/bin"
runtime="$test_root/runtime"
config="$test_root/etc/garden"
state="$test_root/state"
home="$test_root/home"
backups="$test_root/backups"
command_log="$test_root/commands.log"
worker_busy="$test_root/worker-busy"
# Stands in for the PostgreSQL cluster; see the `runuser` fixture below for what that does and
# does not prove.
database_file="$test_root/database"
off_host="$test_root/off-host"
recipient_key="$test_root/backup-recipient.pub"
mkdir -p "$seed/scripts" "$seed/infra/native" "$seed/packages/data/src" \
  "$fake_bin" "$config" "$state" "$home" "$backups"

real_git=$(command -v git)

make_fake() {
  name="$1"
  shift
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$@"
  } >"$fake_bin/$name"
  chmod 0755 "$fake_bin/$name"
}

# fcntl exercises the same inherited-descriptor kernel lock on this non-Linux test host.
make_fake flock '
exec python3 -c "
import fcntl, os, pathlib, sys, time
wait = float(sys.argv[2]) if sys.argv[1] == \"-w\" else 0
end = time.monotonic() + wait
while True:
    try:
        fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        marker = os.environ.get(\"GARDEN_TEST_LOCK_BLOCKED\")
        if marker and wait: pathlib.Path(marker).touch()
        if time.monotonic() >= end: sys.exit(1)
        time.sleep(0.02)
" "$@"'

make_fake id '
if [ "${1:-}" = "-u" ]; then printf "0\n"; else printf "root\n"; fi'
make_fake systemctl '
printf "systemctl %s\n" "$*" >>"$GARDEN_TEST_COMMAND_LOG"'
# Stands in for the running server. The readiness gate asks four separate questions, so the
# fixtures make it answer them the way a broken release would: FAIL_HEALTH is a build that boots
# and cannot serve, FAIL_MIGRATION is one whose schema never reached the version it expects. Both
# markers live in the checkout, so a rollback to the previous revision clears them exactly as a
# real rollback would.
make_fake curl '
requested=""
for argument in "$@"; do
  case "$argument" in http*) requested="$argument" ;; esac
done
if [ -f "$GARDEN_TEST_CHECKOUT/FAIL_HEALTH" ]; then exit 22; fi
case "$requested" in
  # The worker metrics the backup reads to decide whether anybody is using the computer. Silence
  # means idle, which is what an unattended box normally is.
  */metrics)
    if [ -f "$GARDEN_TEST_WORKER_BUSY" ]; then printf "garden_worker_active 1\n"; fi
    # A worker that goes busy in the fraction of a second between the unattended run finding it idle
    # and the update re-checking on the way in. That gap is the only path through update_garden
    # that returns without recording an outcome, and a drill cannot produce it with a static marker:
    # this one answers idle the first time it is asked and busy every time after.
    if [ -f "$GARDEN_TEST_WORKER_BUSY_LATE" ]; then
      metrics_asks=$(cat "$GARDEN_TEST_WORKER_BUSY_LATE" 2>/dev/null || printf 0)
      case "$metrics_asks" in ""|*[!0-9]*) metrics_asks=0 ;; esac
      metrics_asks=$((metrics_asks + 1))
      printf "%s\n" "$metrics_asks" >"$GARDEN_TEST_WORKER_BUSY_LATE"
      [ "$metrics_asks" -le 1 ] || printf "garden_worker_active 1\n"
    fi
    ;;
  */v1/legal) printf "{\"applicationLicense\":\"AGPL-3.0-only\",\"accepted\":false}\n" ;;
  # The runner health document, which is where `doctor` reads the rung the sandbox is actually on
  # rather than the one runner.env asked for. Other cases receive an idle, healthy runner.
  *4300/healthz)
    if [ -f "$GARDEN_TEST_RUNNER_HEALTH" ]; then
      cat "$GARDEN_TEST_RUNNER_HEALTH"
    else
      printf "{\"ok\":true,\"backgroundCommands\":0}\n"
    fi
    ;;
esac
exit 0'
make_fake nginx 'exit 0'
make_fake chown 'exit 0'
make_fake chgrp 'exit 0'
# Ownership is accepted and ignored: this drill runs as an ordinary user, and what it is checking
# is which files an update puts where, not who ends up owning them.
make_fake install '
mode=""
directory_only=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) directory_only=yes; shift ;;
    -D) shift ;;
    -m) mode="$2"; shift 2 ;;
    -o|-g) shift 2 ;;
    *) break ;;
  esac
done
if [ -z "$mode" ]; then
  printf "unexpected synthetic install arguments: %s\n" "$*" >&2
  exit 64
fi
if [ -n "$directory_only" ]; then
  for target in "$@"; do
    mkdir -p "$target"
    chmod "$mode" "$target"
  done
  exit 0
fi
if [ "$#" -ne 2 ]; then
  printf "unexpected synthetic install arguments: %s\n" "$*" >&2
  exit 64
fi
mkdir -p "$(dirname "$2")"
cp "$1" "$2"
chmod "$mode" "$2"'
make_fake sha256sum '
exec /usr/bin/shasum -a 256 "$@"'
# The database, as one file this drill can read and write, so that a restore proves something.
#
# `pg_dump` used to print a literal string and `pg_restore` was silence, so the whole database half
# of a backup was unpinned: a dump written to the wrong path, read before the drop instead of after
# it, or never read at all would have passed every case below with the same "ok". A backup nobody
# has restored is a hope, and this tree's own doctrine is that a check nobody watched fire is not a
# check. The stand-in is a single file: the dump is a copy of it, dropdb and createdb empty it, and
# pg_restore fills it from whatever it is fed on standard input.
#
# What that pins is the WIRING of the round trip - which file is written, which is read, and that
# the drop happens before the read. It pins nothing whatever about PostgreSQL: custom-format dumps,
# large objects, extensions and role grants are not in it and are not claimed. Proving those needs
# a real cluster, which is a separate rig and not this one.
make_fake runuser '
case "$*" in
  *"playwright-core/cli.js install chromium"*)
    printf "managed browser fetch\n" >>"$GARDEN_TEST_COMMAND_LOG"
    [ "${GARDEN_TEST_BROWSER_FETCH_FAIL:-0}" != 1 ] || exit 44
    mkdir -p "$GARDEN_HOME/.cache/ms-playwright/chromium-1234" \
      "$GARDEN_HOME/.cache/ms-playwright/chromium_headless_shell-1234"
    ;;
  *"pg_dump"*) cat "$GARDEN_TEST_DATABASE" ;;
  *"pg_restore"*)
    [ "${GARDEN_TEST_RESTORE_FAIL:-0}" != 1 ] || exit 43
    cat >"$GARDEN_TEST_DATABASE" ;;
  *"dropdb"*|*"createdb"*) : >"$GARDEN_TEST_DATABASE" ;;
  *"schema_migrations"*)
    if [ -f "$GARDEN_TEST_CHECKOUT/FAIL_MIGRATION" ]; then printf "6\n"; else printf "7\n"; fi
    ;;
  # The sandbox helper, which both boundary arms of `doctor` reach through runuser and sudo. Silent
  # unless a report is in place, which is the box where the helper answers nothing.
  *garden-sandbox*)
    if [ -f "$GARDEN_TEST_SANDBOX_REPORT" ]; then cat "$GARDEN_TEST_SANDBOX_REPORT"; fi
    ;;
esac
exit 0'
make_fake pnpm '
printf "pnpm %s at %s\n" "$*" "$PWD" >>"$GARDEN_TEST_COMMAND_LOG"
if [ "$1" = "-r" ] && [ "${2:-}" = "build" ] && { [ -f "$PWD/FAIL_BUILD" ] || [ "${GARDEN_TEST_REVERSE_BUILD_FAIL:-0}" = 1 ]; }; then
  printf "intentional synthetic build failure\n" >&2
  exit 42
fi'
make_fake git '
exec "$GARDEN_TEST_REAL_GIT" "$@"'

# Everything install_runtime_files installs has to exist in the checkout, otherwise the update
# fails partway through for a reason that has nothing to do with what is being tested.
cp "$repository_root/scripts/garden" \
  "$repository_root/scripts/garden-package-helper" \
  "$repository_root/scripts/garden-sandbox" \
  "$repository_root/scripts/mission-supervisor.py" \
  "$repository_root/scripts/reproducible-run.py" \
  "$repository_root/scripts/garden_system.py" \
  "$repository_root/scripts/garden-system-packages" \
  "$repository_root/scripts/garden-service" \
  "$repository_root/scripts/garden-network-refresh" \
  "$repository_root/scripts/garden-network-watch" \
  "$repository_root/scripts/garden-ddns" \
  "$repository_root/scripts/garden-certificate" \
  "$repository_root/scripts/garden-document" \
  "$repository_root/scripts/garden-office-convert" \
  "$repository_root/scripts/garden-pdf-tables" \
  "$repository_root/scripts/garden-document-proof" \
  "$repository_root/scripts/garden-gui" \
  "$repository_root/scripts/garden-gui-broker" \
  "$repository_root/scripts/garden-snapshot" \
  "$seed/scripts/"
cat >"$seed/scripts/garden-native-runtime" <<'NATIVE_FIXTURE'
#!/bin/sh
set -eu
printf 'native activation %s\n' "$*" >>"$GARDEN_TEST_COMMAND_LOG"
if [ -f "$GARDEN_ROOT/FAIL_NATIVE" ]; then exit 29; fi
NATIVE_FIXTURE
cp "$repository_root/infra/native/start-desktop-session.sh" \
  "$repository_root/infra/native/garden-desktop-bridge.py" \
  "$repository_root/infra/native/garden@.service" \
  "$repository_root/infra/native/garden-runner.service" \
  "$repository_root/infra/native/garden-jobs.service" \
  "$repository_root/infra/native/garden-gui.service" \
  "$repository_root/infra/native/garden-work.slice" \
  "$repository_root/infra/native/garden.target" \
  "$repository_root/infra/native/garden-network-refresh.service" \
  "$repository_root/infra/native/garden-network-refresh.timer" \
  "$repository_root/infra/native/garden-network-refresh.path" \
  "$repository_root/infra/native/garden-network-watch.service" \
  "$repository_root/infra/native/garden-auto-update.service" \
  "$repository_root/infra/native/garden-auto-update.timer" \
  "$repository_root/infra/native/garden-auto-update-alert.service" \
  "$repository_root/infra/native/garden-certificate-renew.service" \
  "$repository_root/infra/native/garden-certificate-renew.timer" \
  "$repository_root/infra/native/garden-certificate-alert.service" \
  "$repository_root/infra/native/garden-backup.service" \
  "$repository_root/infra/native/garden-backup.timer" \
  "$repository_root/infra/native/garden-backup-alert.service" \
  "$repository_root/infra/native/garden-motd" \
  "$repository_root/infra/native/nginx.conf" \
  "$repository_root/infra/native/nginx-security-headers.conf" \
  "$repository_root/infra/native/nginx-app-csp.conf" \
  "$seed/infra/native/"
# The readiness gate compares the schema the database reports against the highest migration in
# the checkout, so the checkout needs one to read.
printf 'export const migrations = [\n  {\n    version: 7,\n    name: "fixture",\n    sql: ``\n  }\n];\n' \
  >"$seed/packages/data/src/migrations.ts"
printf '#!/bin/sh\nexit 0\n' >"$seed/scripts/garden-network-refresh"
chmod 0755 "$seed/scripts/garden-network-refresh"
printf '#!/bin/sh\nexit 0\n' >"$seed/scripts/garden-network-watch"
chmod 0755 "$seed/scripts/garden-network-watch"
# The last act of install.sh is to exec this. The bootstrap cases below only need to know whether it
# was reached, and reaching it with an unverified source is the defect they are here for.
printf '#!/bin/sh\nprintf "the installer ran\\n" >>"$GARDEN_TEST_COMMAND_LOG"\n' \
  >"$seed/scripts/install-native.sh"
chmod 0755 "$seed/scripts/install-native.sh"

fixture_maintenance_path() {
  sed 's#^  maintenance_lock_directory=/run/garden-maintenance$#  maintenance_lock_directory="${GARDEN_STATE}/maintenance-lock"#' \
    "$seed/scripts/garden" >"$seed/scripts/garden.next"
  mv "$seed/scripts/garden.next" "$seed/scripts/garden"
  chmod 0755 "$seed/scripts/garden"
}
fixture_maintenance_path
# A previous revision's proxy is intentionally distinct from the incoming listener.
printf '# previous proxy revision\n' >"$seed/infra/native/nginx.conf"
awk '
  /^  install .*scripts\/mission-supervisor.py / { getline; next }
  /^install_runtime_files\(\) \{$/ {
    print
    print "  printf '\''previous runtime activation\\n'\'' >>\"$GARDEN_TEST_COMMAND_LOG\""
    next
  }
  { print }
' "$seed/scripts/garden" >"$test_root/previous-cli"
mv "$test_root/previous-cli" "$seed/scripts/garden"
chmod 0755 "$seed/scripts/garden"
rm "$seed/scripts/mission-supervisor.py"

"$real_git" init --bare "$remote" >/dev/null
"$real_git" -C "$seed" init -b main >/dev/null
"$real_git" -C "$seed" config user.name "Garden update drill"
"$real_git" -C "$seed" config user.email "update-drill@localhost"
"$real_git" -C "$seed" add .
"$real_git" -C "$seed" commit -m v1 >/dev/null
"$real_git" -C "$seed" remote add origin "$remote"
"$real_git" -C "$seed" push -u origin main >/dev/null
"$real_git" --git-dir="$remote" symbolic-ref HEAD refs/heads/main
"$real_git" clone "$remote" "$checkout" >/dev/null

printf 'postgres://garden:synthetic-password@127.0.0.1:5432/garden\n' |
  sed 's|^|DATABASE_URL=|' >"$config/control.env"
printf 'runner=true\nISOLATE_AGENT_NETWORK=false\n' >"$config/runner.env"
printf 'PUBLIC_APP_URL=https://preview-box.example\nPREVIEW_BASE_URL=https://preview-box.example/__garden/preview\n' >>"$config/control.env"
printf 'data-before-update\n' >"$home/persistent.txt"
printf 'database-before-update\n' >"$database_file"

# The installer's database-password reuse, read out of the installer itself.
#
# One line decides whether re-running the installer on a working box keeps the PostgreSQL password
# that box already has or invents a new one, and it was written with doubled backslashes inside
# single quotes, so the capture group never matched and every re-install rotated the password.
# `doctor` tells the owner to re-run the installer for two ordinary conditions; `ALTER ROLE` runs
# hundreds of lines before `DATABASE_URL` is written back, with a dozen `fail` points in between,
# and any of them left the role holding a password nothing on the box knew. The two pieces are
# lifted out of the installer and run rather than restated here, because a second copy of the
# expression is a second thing free to drift away from the one that actually executes.
installer_source="$repository_root/scripts/install-native.sh"
asset_fixture="$test_root/installer-assets"
mkdir -p "$asset_fixture"
awk '
  /^install_asset\(\) \{$/ { emitting = 1 }
  emitting { print }
  emitting && /^\}$/ { exit }
' "$installer_source" >"$asset_fixture/install-asset.sh"
[ -s "$asset_fixture/install-asset.sh" ] || {
  printf 'the installer asset operation could not be read\n' >&2; exit 1;
}
cat >>"$asset_fixture/install-asset.sh" <<'ASSET_CASES'
set -eu
cd "$1"
printf 'source bytes\n' >source
chmod 0644 source
ln source hardlink
ln -s source symlink
for target in source hardlink symlink; do
  install_asset 0755 source "$target"
  [ -x "$target" ] || { printf 'same-file asset did not receive its mode\n' >&2; exit 1; }
  [ "$(cat "$target")" = 'source bytes' ] || exit 1
  chmod 0644 source
done
[ -L symlink ] || { printf 'same-file symlink was replaced\n' >&2; exit 1; }
env test source -ef hardlink || { printf 'same-file hardlink was replaced\n' >&2; exit 1; }
printf 'old bytes\n' >existing
for target in existing new; do
  install_asset 0755 source "$target"
  [ -x "$target" ] || exit 1
  [ "$(cat "$target")" = 'source bytes' ] || {
    printf 'a distinct asset destination was not installed\n' >&2; exit 1;
  }
done
ASSET_CASES
if ! sh "$asset_fixture/install-asset.sh" "$asset_fixture"; then
  printf 'assertion failed: installer asset identity, mode or replacement behavior\n' >&2
  exit 1
fi
printf 'ok  installer assets preserve file identity and install distinct destinations\n'
{
  awk '
    /^existing_control_value\(\) \{$/ { emitting = 1 }
    emitting { print }
    emitting && /^\}$/ { exit }
  ' "$installer_source"
  awk '
    /^database_password=/ { emitting = 1 }
    emitting { print }
    emitting && /database_password=\$\(openssl/ { exit }
  ' "$installer_source"
  printf 'printf "%%s\\n" "$database_password"\n'
} >"$test_root/installer-password-reuse.sh"
reused_password=$(garden_config="$config" sh "$test_root/installer-password-reuse.sh")
if [ "$reused_password" != synthetic-password ]; then
  printf 'the installer did not reuse the password in an existing control.env: %s\n' \
    "$reused_password" >&2
  exit 1
fi
# And the window between setting the role's password and writing it down is closed rather than
# merely narrowed: the write happens before the next step that can fail.
alter_role_line=$(grep -n 'ALTER ROLE garden WITH LOGIN PASSWORD' "$installer_source" |
  sed -n '1s/:.*//p')
url_write_line=$(grep -n 'set_env_value "\$control_env" DATABASE_URL' "$installer_source" |
  sed -n '1s/:.*//p')
next_failure_line=$(grep -n 'the PostgreSQL client authentication file could not be located' \
  "$installer_source" | sed -n '1s/:.*//p')
if [ -z "$alter_role_line" ] || [ -z "$url_write_line" ] || [ -z "$next_failure_line" ] ||
  [ "$url_write_line" -lt "$alter_role_line" ] || [ "$url_write_line" -gt "$next_failure_line" ]; then
  printf 'the installer can abort between rotating the database password and writing it down\n' >&2
  exit 1
fi
printf 'ok  the installer reuses an existing database password and writes it back at once\n'

# The commit pin, on the box whose state is already unknown.
#
# `GARDEN_EXPECTED_COMMIT` is how the packaged client pins the source it installs, and the fetch,
# the checkout and the whole verification block sat inside `if [ ! -f scripts/install-native.sh ]`.
# The arrangement that reaches the bootstrap a second time is not "the owner ran it twice" - the
# client asks a working box for a pairing code instead - it is a partial install, where the source
# is on disk and the `garden` CLI never reached PATH. There the pin went unchecked and the
# installer ran against whatever revision happened to be lying in /opt/garden.
bootstrap_root="$test_root/bootstrap-root"
"$real_git" clone "$remote" "$bootstrap_root" >/dev/null 2>&1
run_bootstrap() {
  PATH="$fake_bin:$PATH" \
    GARDEN_TEST_COMMAND_LOG="$command_log" \
    GARDEN_TEST_REAL_GIT="$real_git" \
    GARDEN_ROOT="${2:-$bootstrap_root}" \
    GARDEN_REPOSITORY="$remote" \
    GARDEN_REF="${3:-main}" \
    GARDEN_EXPECTED_COMMIT="$1" \
    /bin/sh "$repository_root/install.sh"
}
: >"$command_log"
if wrong_pin_output=$(run_bootstrap 0000000000000000000000000000000000000000 2>&1); then
  printf 'a partial install accepted a source that does not match the pinned commit\n' >&2
  exit 1
fi
grep -q 'does not match the client release commit' <<EOF
$wrong_pin_output
EOF
if grep -q 'the installer ran' "$command_log"; then
  printf 'the installer was handed an unverified source on a partial install\n' >&2
  exit 1
fi
# And the same arrangement with the right pin reaches the installer, at the revision it names.
: >"$command_log"
published_head=$("$real_git" --git-dir="$remote" rev-parse HEAD)
run_bootstrap "$published_head" >/dev/null 2>&1
grep -q 'the installer ran' "$command_log"
test "$("$real_git" -C "$bootstrap_root" rev-parse HEAD)" = "$published_head"
# The path that was already covered by the verification, kept covered: a box with nothing on it at
# all still clones, still lands on the update branch, and still checks the pin.
make_fake apt-get '
printf "apt-get %s\n" "$*" >>"$GARDEN_TEST_COMMAND_LOG"'
: >"$command_log"
first_install_root="$test_root/first-install-root"
run_bootstrap "$published_head" "$first_install_root" >/dev/null 2>&1
grep -q 'apt-get install' "$command_log"
grep -q 'the installer ran' "$command_log"
test "$("$real_git" -C "$first_install_root" rev-parse HEAD)" = "$published_head"
test "$("$real_git" -C "$first_install_root" rev-parse --abbrev-ref HEAD)" = garden
: >"$command_log"
commit_install_root="$test_root/commit-install-root"
run_bootstrap "$published_head" "$commit_install_root" "$published_head" >/dev/null 2>&1
grep -q 'the installer ran' "$command_log"
test "$("$real_git" -C "$commit_install_root" rev-parse HEAD)" = "$published_head"
test "$("$real_git" -C "$commit_install_root" rev-parse --abbrev-ref HEAD)" = garden
rm -f "$fake_bin/apt-get"
printf 'ok  the bootstrap checks the commit pin on a partial install and on a fresh one\n'

run_garden() {
  PATH="$fake_bin:$PATH" \
    GARDEN_TEST_COMMAND_LOG="$command_log" \
    GARDEN_TEST_REAL_GIT="$real_git" \
    GARDEN_TEST_CHECKOUT="$checkout" \
    GARDEN_ROOT="$checkout" \
    GARDEN_CONFIG="$config" \
    GARDEN_STATE="$state" \
    GARDEN_HOME="$home" \
    GARDEN_BACKUP_ROOT="$backups" \
    GARDEN_BACKUP_KEEP="${GARDEN_TEST_BACKUP_KEEP:-5}" \
    GARDEN_BACKUP_IDLE_WAIT_SECONDS="${GARDEN_TEST_BACKUP_IDLE_WAIT:-0}" \
    GARDEN_TEST_WORKER_BUSY="$worker_busy" \
    GARDEN_TEST_WORKER_BUSY_LATE="${GARDEN_TEST_WORKER_BUSY_LATE:-$test_root/worker-busy-late}" \
    GARDEN_TEST_RUNNER_HEALTH="$test_root/runner-health" \
    GARDEN_TEST_SANDBOX_REPORT="$test_root/sandbox-report" \
    GARDEN_TEST_DATABASE="$database_file" \
    GARDEN_TEST_OFF_HOST="$off_host" \
    GARDEN_READY_TIMEOUT_SECONDS=3 \
    GARDEN_RUNTIME_PREFIX="$runtime" \
    "${GARDEN_TEST_CLI:-$checkout/scripts/garden}" "$@"
}

run_update() {
  run_garden update
}

publish_fixture() {
  fixture_maintenance_path
  # Distinct seconds, because a backup directory is named for the second it was taken in.
  sleep 1
  "$real_git" -C "$seed" add -A
  "$real_git" -C "$seed" commit -m "$1" >/dev/null
  "$real_git" -C "$seed" push >/dev/null
}

backup_count() {
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | wc -l | tr -d ' '
}

# A staged incoming updater must reverse-install the previous source and private configuration
# even when required activation changed the preview origin and then failed before service start.
cp "$repository_root/infra/native/nginx.conf" "$seed/infra/native/nginx.conf"
cp "$repository_root/scripts/garden" "$seed/scripts/garden"
cp "$repository_root/scripts/mission-supervisor.py" "$seed/scripts/mission-supervisor.py"
fixture_maintenance_path
cp "$repository_root/scripts/garden-native-runtime" "$seed/scripts/preview-activation.sh"
cat >>"$seed/scripts/garden-native-runtime" <<'PREVIEW_FIXTURE'
/bin/sh "$GARDEN_ROOT/scripts/preview-activation.sh" preview-origin
if [ -f "$GARDEN_ROOT/FAIL_AFTER_PREVIEW" ]; then exit 31; fi
PREVIEW_FIXTURE
cp "$seed/scripts/garden" "$test_root/staged-updater"
chmod 0700 "$test_root/staged-updater"
cp "$config/control.env" "$test_root/before-preview-control"
cp "$config/runner.env" "$test_root/before-preview-runner"
previous_preview_revision=$("$real_git" -C "$checkout" rev-parse HEAD)
: >"$seed/FAIL_AFTER_PREVIEW"
publish_fixture preview-activation-interrupted
if preview_failure=$(GARDEN_TEST_CLI="$test_root/staged-updater" run_update 2>&1); then
  printf 'an interrupted preview migration was accepted\n' >&2; exit 1
fi
grep -q 'failed with exit 31' <<EOF
$preview_failure
EOF
grep -q 'Rollback completed' <<EOF
$preview_failure
EOF
grep -q '^previous runtime activation$' "$command_log" || {
  printf 'assertion failed: staged rollback did not execute the previous runtime installer\n' >&2; exit 1;
}
cmp "$config/control.env" "$test_root/before-preview-control" || {
  printf 'assertion failed: pre-start rollback did not restore private preview configuration\n' >&2; exit 1;
}
cmp "$config/runner.env" "$test_root/before-preview-runner"
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$previous_preview_revision"
grep -q '^# previous proxy revision$' "$runtime/etc/nginx/sites-available/garden" || {
  printf 'assertion failed: staged updater did not install the previous proxy source\n' >&2; exit 1;
}
rm "$seed/FAIL_AFTER_PREVIEW"
printf 'ok  staged updater restores configuration and previous runtime after interrupted preview activation\n'

printf '\n# fixture-version=v2\n' >>"$seed/scripts/garden-service"
# What an installation from before the helper was moved looks like, so the update is asked to
# remove it rather than merely to install the replacement somewhere else.
mkdir -p "$runtime/usr/local/bin"
printf '#!/bin/sh\nexit 0\n' >"$runtime/usr/local/bin/garden-package-helper"
chmod 0755 "$runtime/usr/local/bin/garden-package-helper"
# Stands in for the relay identity key an owner who turned the relay on already has.
mkdir -p "$runtime/etc/garden/relay"
printf 'relay-identity\n' >"$runtime/etc/garden/relay/identity-marker"
mkdir -p "$home/workspace/project/node_modules"
printf 'regenerable\n' >"$home/workspace/project/node_modules/dependency.js"
# The managed browser. Roughly 400 MB of already-compressed binaries that gzip cannot help, in a
# tree the runner knows how to fetch again, copied into every daily backup and every pre-update
# rollback copy while the printed line said package caches were skipped.
mkdir -p "$home/.cache/ms-playwright/chromium-1228/chrome-linux"
printf 'binary\n' >"$home/.cache/ms-playwright/chromium-1228/chrome-linux/chrome"
publish_fixture v2
expected_revision=$("$real_git" -C "$seed" rev-parse HEAD)

success_output=$(run_update 2>&1) || { printf 'assertion failed: transactional update must install a usable runtime\n%s\n' "$success_output" >&2; exit 1; }
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
grep -q 'fixture-version=v2' "$runtime/usr/local/lib/garden/garden-service"
grep -q 'Update complete' <<EOF
$success_output
EOF
test "$(cat "$home/persistent.txt")" = "data-before-update"
grep -q '^PREVIEW_BASE_URL=https://preview-box.example:8443/__garden/preview$' "$config/control.env" || {
  printf 'assertion failed: update did not activate the isolated preview origin\n' >&2; exit 1;
}
grep -q 'https://preview-box.example:8443' "$runtime/etc/nginx/snippets/garden-preview-origin.conf"
grep -q '^ISOLATE_AGENT_NETWORK=false$' "$config/runner.env"
printf 'ok  transactional update success path\n'

# The package helper reaches root with no capability scope and no approval card of its own. On
# the agent's PATH it was one command name away from a silent root package install, so an update
# has to both put it out of reach and take away the copy earlier releases left behind.
test -x "$runtime/usr/local/lib/garden/garden-package-helper"
test ! -e "$runtime/usr/local/bin/garden-package-helper"
test -x "$runtime/usr/local/lib/garden/garden-sandbox"
printf 'ok  root helpers are installed off the agent PATH\n'

# What the installer places and the update did not. The backup units were one instance of it; these
# were the rest, and both were found by comparing the two lists rather than by anything failing. The
# document commands are named by absolute path in the shipped skills, so on a box that has only ever
# been updated the agent was reading this release's instructions and running install day's binary,
# or on a box older than they are, running nothing. The nginx snippets are included by the site file
# the update replaces, so the policy and the site that expects it moved apart at every release.
test -x "$runtime/usr/local/bin/garden-office-convert"
test -x "$runtime/usr/local/bin/garden" || { printf 'assertion failed: garden command was not installed\n' >&2; exit 1; }
cmp -s "$checkout/scripts/garden" "$runtime/usr/local/bin/garden"
test -x "$runtime/usr/local/bin/garden-pdf-tables"
test -x "$runtime/usr/local/lib/garden/garden-document-proof"
test -f "$runtime/etc/nginx/snippets/garden-security-headers.conf"
test -f "$runtime/etc/nginx/snippets/garden-app-csp.conf"
printf 'ok  the update places every runtime file the installer does\n'
mkdir -p "$runtime/etc/nginx/conf.d"
printf 'previous conf.d proxy\n' >"$runtime/etc/nginx/conf.d/garden.conf"
run_garden update install-runtime-files >/dev/null 2>&1
cmp "$checkout/infra/native/nginx.conf" "$runtime/etc/nginx/conf.d/garden.conf" || {
  printf 'assertion failed: existing conf.d proxy did not receive the new listener\n' >&2; exit 1;
}
rm "$runtime/etc/nginx/conf.d/garden.conf"
printf 'ok  runtime activation refreshes the existing conf.d proxy layout\n'


# The relay identity key is this server's address on every relay it has enrolled with: replacing it
# would silently change the hostname every paired client holds. An update has to leave what is in
# that directory alone, and to provision it on a server installed before the relay existed.
test "$(cat "$runtime/etc/garden/relay/identity-marker")" = "relay-identity"
test -f "$runtime/etc/systemd/system/garden-network-refresh.path"
printf 'ok  the relay identity survives an update\n'

# The backup runs with the server stopped, so its contents are outage time. Dependency trees are
# the bulk of a working agent computer and every one of them can be fetched again.
newest_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
tar -tzf "$newest_backup/workspaces.tar.gz" >"$test_root/backup-listing"
grep -q 'persistent.txt' "$test_root/backup-listing"
if grep -q 'node_modules' "$test_root/backup-listing"; then
  printf 'the backup still archives regenerable dependency trees\n' >&2
  exit 1
fi
if grep -q 'ms-playwright' "$test_root/backup-listing"; then
  printf 'the backup still archives the managed browser\n' >&2
  exit 1
fi
grep -q 'Dependency trees and package caches were skipped' <<EOF
$success_output
EOF
printf 'ok  backup excludes regenerable trees and says so\n'

printf '\n# fixture-version=v3\n' >>"$seed/scripts/garden-service"
: >"$seed/FAIL_BUILD"
publish_fixture v3-fails

printf 'data-before-rollback\n' >"$home/persistent.txt"
if failure_output=$(run_update 2>&1); then
  printf 'synthetic failed update unexpectedly succeeded\n' >&2
  exit 1
fi
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
test ! -e "$checkout/FAIL_BUILD"
grep -q 'fixture-version=v2' "$runtime/usr/local/lib/garden/garden-service"
test "$(cat "$home/persistent.txt")" = "data-before-rollback"
grep -q 'Rollback completed; the failed update was not activated' <<EOF
$failure_output
EOF
printf 'ok  failed update restored source, runtime, and user data\n'

# A release that builds and boots but cannot serve. The old gate polled /healthz, a route that
# answers from a static literal, so this case reported "Update complete" over a dead product.
rm -f "$seed/FAIL_BUILD"
printf '\n# fixture-version=v4\n' >>"$seed/scripts/garden-service"
: >"$seed/FAIL_HEALTH"
publish_fixture v4-does-not-serve

if unserving_output=$(run_update 2>&1); then
  printf 'a release that never served was accepted as a completed update\n' >&2
  exit 1
fi
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
grep -q 'fixture-version=v2' "$runtime/usr/local/lib/garden/garden-service"
grep -q 'this release is not serving' <<EOF
$unserving_output
EOF
grep -q 'Rollback completed; the failed update was not activated' <<EOF
$unserving_output
EOF
printf 'ok  a release that boots but cannot serve is rolled back\n'

# And one whose migrations never reached the version the new code expects.
rm -f "$seed/FAIL_HEALTH"
printf '\n# fixture-version=v5\n' >>"$seed/scripts/garden-service"
: >"$seed/FAIL_MIGRATION"
publish_fixture v5-schema-behind

if stale_schema_output=$(run_update 2>&1); then
  printf 'a release running against an unmigrated database was accepted\n' >&2
  exit 1
fi
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
grep -q 'schema version 6 but this release expects 7' <<EOF
$stale_schema_output
EOF
printf 'ok  a release whose migrations did not apply is rolled back\n'

rm -f "$seed/FAIL_MIGRATION"
: >"$seed/FAIL_NATIVE"
publish_fixture native-capability-unavailable
if native_failure=$(run_update 2>&1); then
  printf 'a release missing its native runtime was accepted\n' >&2
  exit 1
fi
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$expected_revision"
grep -q "activating native tools.*failed with exit 29" <<EOF
$native_failure
EOF
grep -q 'Rollback completed; the failed update was not activated' <<EOF
$native_failure
EOF
cmp "$checkout/scripts/mission-supervisor.py" "$runtime/usr/local/lib/garden/mission-supervisor.py"
cmp "$checkout/scripts/reproducible-run.py" "$runtime/usr/local/bin/garden-run"
test -x "$runtime/usr/local/bin/garden-run"
cmp "$checkout/scripts/garden_system.py" "$runtime/usr/local/lib/garden/garden_system.py"
rm "$seed/FAIL_NATIVE"
printf 'ok  missing native capabilities roll back before the new release starts\n'

# Four updates have now been taken, each leaving a full copy of the database and every workspace.
rm -f "$seed/FAIL_MIGRATION"
printf '\n# fixture-version=v6\n' >>"$seed/scripts/garden-service"
publish_fixture v6
before_prune=$(backup_count)
test "$before_prune" -ge 2
GARDEN_TEST_BACKUP_KEEP=2 run_update >/dev/null 2>&1
test "$(backup_count)" -eq 2
printf 'ok  superseded backups are pruned to the retention limit\n'

# The operator is told what the outage will cost before the server is taken away, and what it
# actually cost afterwards.
printf '\n# fixture-version=v7\n' >>"$seed/scripts/garden-service"
publish_fixture v7
outage_output=$(run_update 2>&1)
grep -q 'stopping the server now' <<EOF
$outage_output
EOF
grep -q 'The previous update was offline for about' <<EOF
$outage_output
EOF
grep -q 'Update complete after' <<EOF
$outage_output
EOF
printf 'ok  the outage is announced beforehand and measured afterwards\n'

# A file added in a release has to land in that release.
#
# `garden update` is /usr/local/bin/garden, the previous release's copy of the script, and the
# running shell goes on executing it after the pull: the tree being installed from was the new one
# and the list of what to install from it was the old one. So anything a release added reached an
# existing box a release late, and nothing reported an error, because nothing had gone wrong. The
# server that showed this had the backup units in its checkout, no timer anywhere on disk, and an
# interface still describing a daily copy. The fixture is a unit the published revision installs and
# the revision performing the update has never heard of.
printf '[Unit]\nDescription=A unit the published release adds\n' \
  >"$seed/infra/native/garden-late-addition.service"
awk '
  { print }
  /^install_runtime_files\(\) \{$/ {
    print "  install -D -m 0644 infra/native/garden-late-addition.service \\"
    print "    \"$(runtime_path /etc/systemd/system/garden-late-addition.service)\""
  }
' "$seed/scripts/garden" >"$test_root/seed-garden"
mv "$test_root/seed-garden" "$seed/scripts/garden"
chmod 0755 "$seed/scripts/garden"
printf '\n# fixture-version=v8\n' >>"$seed/scripts/garden-service"
publish_fixture v8-adds-a-unit
run_update >/dev/null 2>&1
test -f "$runtime/etc/systemd/system/garden-late-addition.service"
grep -q 'fixture-version=v8' "$runtime/usr/local/lib/garden/garden-service"
printf 'ok  a file added in a release is installed by that release\n'

# And the phase is asked only of a revision that answers it.
#
# Handing it to one that does not is not a no-op: before this release `update` ignored anything
# after it and simply updated, so a checkout that mentions the phase without answering to it turns
# the install step into a whole second update, run from inside the first, against a server the
# first one has already stopped - and that second update asks the same question again. Drilled with
# a real checkout, that chain did not end; it was still forking full updates, each taking its own
# backup, ten minutes later. So what the run looks for is the dispatch arm rather than the name,
# which also appears in prose. The fixture keeps every mention and loses the arm, and answers an
# unrecognised argument the way releases before this one did: without failing.
cp "$seed/scripts/garden" "$test_root/seed-garden-answering"
sed \
  -e 's/^      install-runtime-files)$/      a-phase-under-some-other-name)/' \
  -e 's|^      \*) fail "usage: garden update" ;;$|      *) printf "asked for the phase\\n" >>"$GARDEN_TEST_COMMAND_LOG"; exit 0 ;;|' \
  "$test_root/seed-garden-answering" >"$seed/scripts/garden"
chmod 0755 "$seed/scripts/garden"
grep -q 'install-runtime-files' "$seed/scripts/garden"
if grep -q '^ *install-runtime-files)' "$seed/scripts/garden"; then
  printf 'the fixture still answers to the phase, so it tests nothing\n' >&2
  exit 1
fi
printf '\n# fixture-version=v9\n' >>"$seed/scripts/garden-service"
publish_fixture v9-mentions-the-phase-without-answering
: >"$command_log"
if run_update >/dev/null 2>&1; then unanswered_update=completed; else unanswered_update=""; fi
if grep -q 'asked for the phase' "$command_log"; then
  printf 'the install step was handed to a revision with no arm to answer it\n' >&2
  exit 1
fi
[ -n "$unanswered_update" ] || {
  printf 'the update did not complete against a revision that does not answer the phase\n' >&2
  exit 1
}
grep -q 'fixture-version=v9' "$runtime/usr/local/lib/garden/garden-service"
printf 'ok  the install phase is asked only of a revision that answers to it\n'

# And a generation that came from the phase does not start another.
#
# The marker above is a reading of a file, and the file is the one thing here nobody controls. This
# is the bound that does not depend on reading it right: the phase is entered once, and a child
# that finds itself already inside one places the files itself instead of passing the job on. The
# fixture is the mistake this is for - a revision whose arm calls the wrapper rather than the list -
# and it counts its own generations so that a regression fails the drill rather than forking until
# something else stops it.
awk '
  /^        install_runtime_files$/ {
    print "        printf \"phase generation\\\\n\" >>\"$GARDEN_TEST_COMMAND_LOG\""
    print "        [ \"$(grep -c \"phase generation\" \"$GARDEN_TEST_COMMAND_LOG\")\" -lt 4 ] ||"
    print "          fail \"the phase re-entered itself\""
    print "        install_checked_out_runtime_files"
    next
  }
  { print }
' "$test_root/seed-garden-answering" >"$seed/scripts/garden"
chmod 0755 "$seed/scripts/garden"
printf '\n# fixture-version=v10\n' >>"$seed/scripts/garden-service"
publish_fixture v10-the-phase-calls-the-wrapper
: >"$command_log"
run_update >/dev/null 2>&1 || true
phase_generations=$(grep -c 'phase generation' "$command_log")
if [ "$phase_generations" -ne 1 ]; then
  printf 'the install phase ran %s times in one update\n' "$phase_generations" >&2
  exit 1
fi
grep -q 'fixture-version=v10' "$runtime/usr/local/lib/garden/garden-service"
printf 'ok  the install phase does not start a second generation of itself\n'

# The daily backup, and whether the box can say anything true about it.
#
# Settings asserted "A backup is taken daily, at a randomised hour, when nothing is running". Two
# ordinary paths made that false without leaving a mark anywhere: a run that stands down because
# the worker is busy exits zero and speaks only to the journal, and a run that fails leaves no
# directory at all, because a copy with no checksum manifest cannot restore anything and is pruned
# as wreckage. Both of them ended with the sentence still on the screen.
backup_status_file="$state/backup.status"
status_field() {
  sed -n "s/^$1=//p" "$backup_status_file" | sed -n '1p'
}

# Every route to a verified copy records itself, so the update just above already left one.
test "$(status_field outcome)" = ok
test -n "$(status_field copy_at)"
test "$(status_field copy_bytes)" -gt 0
test -d "$backups/$(status_field copy_at | tr -d ':-')"
printf 'ok  a completed backup records when it happened and how big it is\n'

# The first silent path. The run stands down for a task that is still going, which is the design,
# and the exit status says nothing happened wrong - so a box that is busy every time the window
# comes round stands down every night behind an unchanged promise.
: >"$worker_busy"
skipped_output=$(run_garden backup auto run 2>&1)
grep -q 'the next window will take the backup' <<EOF
$skipped_output
EOF
test "$(status_field outcome)" = skipped
test "$(status_field reason)" = "a task was still running when the window came round"
# And the copy it did not take is still described, because how far back the owner can restore to is
# a different question from what last night's run did.
test -n "$(status_field copy_at)"
printf 'ok  a run that stands down for a busy worker says so and says why\n'
rm -f "$worker_busy"

# Active or uncertain background work must not be interrupted by an unattended archive.
commands_before_background=$(wc -l <"$command_log" | tr -d ' ')
for health in '{"ok":true,"backgroundCommands":1}' '{"ok":true}' 'not json' '{"ok":true,"backgroundCommands":false}'; do
  printf '%s\n' "$health" >"$test_root/runner-health"
  run_garden backup auto run >/dev/null 2>&1
  test "$(status_field outcome)" = skipped
  test "$(status_field reason)" = 'background computation is active or the runner could not confirm it is idle'
done
rm -f "$test_root/runner-health"
tail -n +"$((commands_before_background + 1))" "$command_log" >"$test_root/background-skipped-commands"
if grep -q 'systemctl stop' "$test_root/background-skipped-commands"; then
  printf 'unattended backup interrupted active or uncertain work\n' >&2
  exit 1
fi
printf '0\n' >"$test_root/worker-busy-late"
run_garden backup auto run >/dev/null 2>&1
rm -f "$test_root/worker-busy-late"
test "$(status_field reason)" = 'a task started while waiting for maintenance'
printf 'ok  automatic backups recheck active work and preserve background computations\n'

# The second. A full disk is the ordinary way a backup fails, and it is exactly when every retained
# copy is already there - so nothing new is written, nothing is left behind, and the box carries on
# serving perfectly.
make_fake df '
printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
printf "/dev/synthetic 1024 1000 24 98%% /\n"'
if failed_backup_output=$(run_garden backup auto run 2>&1); then
  printf 'a backup that could not fit reported success\n' >&2
  exit 1
fi
rm -f "$fake_bin/df"
grep -q 'not enough room for a backup' <<EOF
$failed_backup_output
EOF
test "$(status_field outcome)" = failed
case "$(status_field reason)" in
  'not enough room for a backup'*) ;;
  *)
    printf 'the failure was not written down in words the owner can read: %s\n' \
      "$(status_field reason)" >&2
    exit 1
    ;;
esac
printf 'ok  a backup that could not be taken is written down with its reason\n'

# What OnFailure= is for: a run stopped by its own ninety-minute limit never reaches a line that
# could write anything, so the pessimistic record it left on the way in is the one that stands.
printf 'at=2026-08-10T03:00:00Z\noutcome=running\nreason=\n' >"$backup_status_file"
run_garden backup auto alert >/dev/null 2>&1
test "$(status_field outcome)" = failed
test "$(status_field reason)" = "the run was stopped before it finished"
# And it leaves a finished run alone, because it fires after those too.
printf 'at=2026-08-10T03:00:00Z\noutcome=ok\nreason=\n' >"$backup_status_file"
run_garden backup auto alert >/dev/null 2>&1
test "$(status_field outcome)" = ok
printf 'ok  a run killed before it finished is recorded, and a finished one is left alone\n'

# Restore is the command the owner reaches for on their worst day, and it empties the workspace
# tree before it extracts into it. The backup path has refused before stopping anything since the
# day a full disk cost somebody an outage; restore checked nothing at all, so a destination too
# small to hold the archive was discovered with the data already deleted and the copy half unpacked
# - the exact loss this command exists to undo, caused by the command itself.
printf 'data-worth-recovering\n' >"$home/persistent.txt"
run_garden backup >/dev/null 2>&1
recovery_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
sleep 1
printf 'data-written-since\n' >"$home/persistent.txt"
run_garden backup >/dev/null 2>&1
: >"$command_log"
make_fake df '
printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
printf "/dev/synthetic 1024 1000 24 98%% /\n"'
# Retaining one copy while restoring from the older of two: the prune that makes room would
# otherwise take the very directory being read from, which is how a recovery becomes a loss.
if refused_restore=$(
  GARDEN_TEST_BACKUP_KEEP=1 run_garden restore "$recovery_backup" --yes 2>&1
); then
  printf 'a restore that could not fit reported success\n' >&2
  exit 1
fi
rm -f "$fake_bin/df"
grep -q 'not enough room to restore' <<REFUSAL
$refused_restore
REFUSAL
# The three things that make the refusal worth having: nothing was stopped, the data that was about
# to be deleted is still there, and the copy being restored from survived the prune.
if grep -q 'systemctl stop' "$command_log"; then
  printf 'the restore stopped the server before finding out it could not fit\n' >&2
  exit 1
fi
test "$(cat "$home/persistent.txt")" = "data-written-since"
test -f "$recovery_backup/SHA256SUMS"
printf 'ok  a restore that would not fit refuses before it stops or wipes anything\n'

# And it is a check rather than a wall: with room on the disk the same restore puts the data back.
run_garden restore "$recovery_backup" --yes >/dev/null 2>&1
test "$(cat "$home/persistent.txt")" = "data-worth-recovering"
printf 'ok  a restore that fits still restores\n'

# The database half of that restore, which nothing used to look at.
#
# Everything above proves the workspace tree comes back. The database was a literal string printed
# by a stand-in and swallowed by another, so the archive's dump could have been written from
# nowhere, read in the wrong order, or never read, and every case still said ok. Here the row goes
# in, a backup is taken, the row changes, the restore runs, and the row is read back out.
printf 'row-worth-recovering\n' >"$database_file"
printf 'files-worth-recovering\n' >"$home/persistent.txt"
sleep 1
run_garden backup >/dev/null 2>&1
database_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
# What went into the archive is the database as it stood, rather than something written once.
test "$(cat "$database_backup/database.dump")" = "row-worth-recovering"
printf 'row-written-since\n' >"$database_file"
printf 'files-written-since\n' >"$home/persistent.txt"
run_garden restore "$database_backup" --yes >/dev/null 2>&1
test "$(cat "$database_file")" = "row-worth-recovering"
test "$(cat "$home/persistent.txt")" = "files-worth-recovering"
printf 'ok  a restore puts the database back, not only the files\n'

# Managed browsers are excluded from backups, so restoring the home tree must repair that runtime.
restore_playwright="$checkout/services/workspace-runner/node_modules/playwright-core"
mkdir -p "$restore_playwright"
printf '{"browsers":[{"name":"chromium","revision":"1234"}]}\n' >"$restore_playwright/browsers.json"
: >"$restore_playwright/cli.js"
mkdir -p "$home/.cache/ms-playwright/chromium-1234" \
  "$home/.cache/ms-playwright/chromium_headless_shell-1234"
: >"$command_log"
run_garden restore "$database_backup" --yes >/dev/null 2>&1
grep -q '^managed browser fetch$' "$command_log" || {
  printf 'restore removed the managed browser without fetching its pinned replacement\n' >&2; exit 1;
}
test -d "$home/.cache/ms-playwright/chromium-1234"
test -d "$home/.cache/ms-playwright/chromium_headless_shell-1234"
test "$(cat "$database_file")" = "row-worth-recovering"
test "$(cat "$home/persistent.txt")" = "files-worth-recovering"
printf 'ok  restore repairs the excluded managed browser after recovering data\n'

restore_browser_warning=$(GARDEN_TEST_BROWSER_FETCH_FAIL=1 run_garden restore "$database_backup" --yes 2>&1)
printf '%s\n' "$restore_browser_warning" | grep -q 'could not be fetched; browser jobs will fail'
printf '%s\n' "$restore_browser_warning" | grep -q 'Restore complete.'
test "$(cat "$database_file")" = "row-worth-recovering"
test "$(cat "$home/persistent.txt")" = "files-worth-recovering"
printf 'ok  a failed browser fetch leaves recovered data serving with an explicit warning\n'

# An offline rehearsal must recover the data without waking copied tasks or taking the network.
printf 'row-written-since\n' >"$database_file"
printf 'files-written-since\n' >"$home/persistent.txt"
: >"$command_log"
offline_restore=$(run_garden restore "$database_backup" --yes --keep-stopped 2>&1)
printf '%s\n' "$offline_restore" | grep -q 'Restore complete. Garden remains stopped'
test "$(cat "$database_file")" = "row-worth-recovering"
test "$(cat "$home/persistent.txt")" = "files-worth-recovering"
test -s "$command_log"
grep -q '^systemctl stop garden.target$' "$command_log"
if grep -Eq '^systemctl (start|restart|reload)|^managed browser fetch$|^network-refresh|^system-packages' "$command_log"; then
  printf 'offline restore started a service or attempted runtime/network repair\n' >&2; exit 1
fi
printf 'ok  offline restore recovers database and files without starting services or repairs\n'

for offline_origin in --new-host --hostname=ai.example.com; do
  : >"$command_log"
  if run_garden restore "$database_backup" --yes --keep-stopped "$offline_origin" >/dev/null 2>&1; then
    printf 'offline restore accepted an option that restarts services\n' >&2; exit 1
  fi
  test ! -s "$command_log"
done
printf 'ok  offline restore refuses online origin changes before touching data\n'
rm -rf "$restore_playwright"

# Moving to a new computer, which was not merely undrilled but mechanically broken.
#
# A backup carries /etc/garden verbatim, which is what has to happen: the data key, the session
# key and the pinned server identity all come back exactly or the box cannot open its own database.
# PUBLIC_APP_URL, WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID came back with them, so a restored box served
# an origin nobody could reach and scoped browser sign-in to an address it no longer had. Nothing
# failed anywhere; the box simply could not be opened. `rollback` has called
# garden-network-refresh since the day it was written and `restore` never did.
#
# The two fixtures are the whole of "what computer is this": the addresses `ip` reports, and what
# the resolver says the old origin's name points at.
make_fake ip '
case "$*" in
  *-6*) exit 0 ;;
esac
printf "2: eth0    inet %s/24 brd 203.0.113.255 scope global eth0\n" "$GARDEN_TEST_HOST_ADDRESS"'
make_fake getent '
if [ "${1:-}" = ahosts ] && [ "${2:-}" = "$GARDEN_TEST_RESOLVES_TO_HERE" ]; then
  printf "%s STREAM %s\n" "$GARDEN_TEST_HOST_ADDRESS" "$2"
  exit 0
fi
exit 2'
network_refresh_binary="$runtime/usr/local/lib/garden/garden-network-refresh"
printf '#!/bin/sh\nprintf "network refresh\\n" >>"$GARDEN_TEST_COMMAND_LOG"\n' \
  >"$network_refresh_binary"
chmod 0755 "$network_refresh_binary"

run_new_host() {
  GARDEN_TEST_HOST_ADDRESS="${GARDEN_TEST_HOST_ADDRESS:-203.0.113.9}" \
    GARDEN_TEST_RESOLVES_TO_HERE="${GARDEN_TEST_RESOLVES_TO_HERE:-nothing.invalid}" \
    run_garden "$@"
}

# Replaces in place rather than appending, because the script under test replaces in place: a
# second PUBLIC_APP_URL line further down the file is one nothing reads, so a fixture that appends
# would be asserting against a line no production caller ever sees.
set_config_value() {
  awk -v key="$1" -v value="$2" '
    index($0, key "=") == 1 { if (!replaced) print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$config/control.env" >"$test_root/control.env.next"
  mv "$test_root/control.env.next" "$config/control.env"
}

# The old machine's configuration, as a backup taken there carries it.
set_config_value PUBLIC_APP_URL https://old-box.example
set_config_value PREVIEW_BASE_URL https://old-box.example/__garden/preview
set_config_value PUBLIC_RUNNER_URL wss://old-box.example/runner
set_config_value WEBAUTHN_RP_ID old-box.example
set_config_value WEBAUTHN_ORIGIN https://old-box.example
sleep 1
run_garden backup >/dev/null 2>&1
new_host_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)

# The counter-direction first, because it is the one a fix here could break: restoring onto the
# same computer must put the configuration back exactly as it was and change nothing about it.
: >"$command_log"
run_new_host restore "$new_host_backup" --yes >/dev/null 2>&1
test "$(sed -n 's/^PUBLIC_APP_URL=//p' "$config/control.env" | sed -n '1p')" = "https://old-box.example"
test "$(sed -n 's/^WEBAUTHN_RP_ID=//p' "$config/control.env" | sed -n '1p')" = "old-box.example"
grep -q 'network refresh' "$command_log"
printf 'ok  a plain restore puts the configuration back untouched, and refreshes the network\n'

# And on a new computer the old name no longer points at, the origin is re-derived from the
# address this machine actually has. All five settings move together: an origin that disagrees
# with the WebAuthn relying party is a page no browser will create a passkey on.
: >"$command_log"
new_host_output=$(run_new_host restore "$new_host_backup" --yes --new-host 2>&1)
test "$(sed -n 's/^PUBLIC_APP_URL=//p' "$config/control.env" | sed -n '1p')" = "https://203.0.113.9"
test "$(sed -n 's/^WEBAUTHN_ORIGIN=//p' "$config/control.env" | sed -n '1p')" = "https://203.0.113.9"
test "$(sed -n 's/^WEBAUTHN_RP_ID=//p' "$config/control.env" | sed -n '1p')" = "203.0.113.9"
test "$(sed -n 's/^PUBLIC_RUNNER_URL=//p' "$config/control.env" | sed -n '1p')" = "wss://203.0.113.9/runner"
test "$(sed -n 's/^PREVIEW_BASE_URL=//p' "$config/control.env" | sed -n '1p')" = \
  "https://203.0.113.9:8443/__garden/preview"
grep -q 'network refresh' "$command_log"
# The data still came back; re-deriving the origin is an addition to the restore, not a detour
# around it.
test "$(cat "$home/persistent.txt")" = "files-worth-recovering"
test "$(cat "$database_file")" = "row-worth-recovering"
grep -q 'Restore complete' <<EOF
$new_host_output
EOF
printf 'ok  a fresh-host restore re-derives the origin from the address this machine has\n'

# The planned move: the domain followed the machine. Rewriting a name that already points here
# would throw away every browser passkey bound to it, which is the opposite of the repair.
set_config_value PUBLIC_APP_URL https://ai.example.com
set_config_value WEBAUTHN_RP_ID ai.example.com
set_config_value WEBAUTHN_ORIGIN https://ai.example.com
sleep 1
run_garden backup >/dev/null 2>&1
followed_backup=$(
  find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
kept_name_output=$(
  GARDEN_TEST_RESOLVES_TO_HERE=ai.example.com \
    run_new_host restore "$followed_backup" --yes --new-host 2>&1
)
test "$(sed -n 's/^PUBLIC_APP_URL=//p' "$config/control.env" | sed -n '1p')" = "https://ai.example.com"
grep -q 'already points at this computer' <<EOF
$kept_name_output
EOF
printf 'ok  a name that followed the machine is kept rather than replaced by an address\n'
rm -f "$fake_bin/ip" "$fake_bin/getent"

# An off-host copy, encrypted, on a disk this computer's own failure does not take.
#
# Every retained copy lives in /var/backups/garden, on the same disk as the data it is a copy of,
# and both docs/OPERATIONS.md and the settings screen advised an off-host copy the product had no
# way to make. The stand-in for gpg is a real round trip - a marker line naming the recipient, then
# the plaintext - so what is pinned is that the encrypted file is what lands, that the recipient
# was used, and that decrypting the copy yields something `restore` accepts. It pins nothing about
# OpenPGP, which is gpg's claim and not this drill's.
make_fake gpg '
recipient=""
output=""
mode=""
subject=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --recipient-file|--output|--trust-model)
      case "$1" in
        --recipient-file) recipient="$2" ;;
        --output) output="$2" ;;
      esac
      shift 2
      ;;
    --encrypt) mode=encrypt; shift ;;
    --decrypt) mode=decrypt; shift ;;
    --show-keys) mode=show; shift ;;
    --*) shift ;;
    *) subject="$1"; shift ;;
  esac
done
# The header is a fixed 78 bytes - "encrypted-to:", a sha256 of the recipient file, and a newline -
# so decrypting is a byte count rather than a line count. Line-oriented would have been wrong:
# workspaces.tar.gz is binary, and a round trip that is not byte-exact fails the checksum manifest
# for a reason that has nothing to do with what is being tested.
case "$mode" in
  show) grep -q "PUBLIC KEY" "$subject" || exit 2 ;;
  encrypt)
    {
      printf "encrypted-to:%s\n" "$(sha256sum <"$recipient" | awk "{print \$1}")"
      cat "$subject"
    } >"$output"
    ;;
  decrypt) tail -c +79 "$subject" >"$output" ;;
  *) exit 64 ;;
esac
exit 0'
# A second filesystem, which is the whole of what an off-host destination is. The drill runs
# everything under one temporary directory, so `df` is what stands in for the second disk - the
# same fixture the full-disk cases above use, answering per path rather than everywhere.
make_fake df '
for df_argument in "$@"; do
  case "$df_argument" in
    "$GARDEN_TEST_OFF_HOST"*)
      printf "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
      printf "/dev/second-disk 10485760 1024 10484736 1%% /mnt/second\n"
      exit 0
      ;;
  esac
done
exec /bin/df "$@"'
mkdir -p "$off_host"
printf -- '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsynthetic\n' >"$recipient_key"

# Configured while somebody is watching, and refused there rather than at three in the morning.
if same_disk_refusal=$(
  run_garden backup destination "$backups" --recipient "$recipient_key" 2>&1
); then
  printf 'a destination on the same filesystem as the local copies was accepted\n' >&2
  exit 1
fi
grep -q 'same filesystem' <<EOF
$same_disk_refusal
EOF
# And a destination with nobody to open it: the archive carries the data key and the session key,
# so a copy of it that leaves the machine is a copy of everything this product protects.
if no_recipient_refusal=$(run_garden backup destination "$off_host" 2>&1); then
  printf 'an off-host destination was accepted with no encryption recipient\n' >&2
  exit 1
fi
grep -q -- '--recipient' <<EOF
$no_recipient_refusal
EOF
run_garden backup destination "$off_host" --recipient "$recipient_key" >/dev/null 2>&1
printf 'ok  an off-host destination is refused on the same disk, and refused unencrypted\n'

sleep 1
printf 'row-for-the-second-disk\n' >"$database_file"
printf 'files-for-the-second-disk\n' >"$home/persistent.txt"
off_host_output=$(run_garden backup 2>&1)
off_host_copy=$(
  find "$off_host" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p'
)
test -n "$off_host_copy"
# What landed is ciphertext for the configured recipient, and the plaintext did not land at all.
test -f "$off_host_copy/configuration.tar.gz.gpg"
test ! -e "$off_host_copy/configuration.tar.gz"
# And it was encrypted to the recipient this box was configured with, rather than to nothing.
grep -q "encrypted-to:$("$fake_bin/sha256sum" <"$recipient_key" | awk '{print $1}')" \
  "$off_host_copy/database.dump.gpg"
# Sums of the encrypted files, in the clear, because that is the one question an owner can still
# answer at the destination without the private key: did the copy arrive whole.
test -f "$off_host_copy/SHA256SUMS.encrypted"
test "$(sed -n 's/^off_host=//p' "$backup_status_file" | sed -n '1p')" = ok
# One line, not two. The record is written pessimistically on the way in - the daily unit has a
# start timeout and a copy killed by it reaches no further line - and corrected on the way out. A
# field that appended would leave the pessimistic line permanently in front of the true one, and
# every reader here takes the first match, so the status could never say anything but "running".
test "$(grep -c '^off_host=' "$backup_status_file")" -eq 1
grep -q 'Encrypted copy written to' <<EOF
$off_host_output
EOF
printf 'ok  a backup is also encrypted to the recipient and copied to the second disk\n'

# The copy is a backup rather than a hope: decrypted by hand the way the command prints, it
# restores. This is the only end-to-end claim about the off-host copy worth making.
decrypted="$test_root/decrypted"
mkdir -p "$decrypted"
for encrypted_file in "$off_host_copy"/*.gpg; do
  plain_name=$(basename -- "$encrypted_file" .gpg)
  PATH="$fake_bin:$PATH" gpg --decrypt --output "$decrypted/$plain_name" "$encrypted_file"
done
printf 'row-written-after-the-copy\n' >"$database_file"
printf 'files-written-after-the-copy\n' >"$home/persistent.txt"
run_garden restore "$decrypted" --yes >/dev/null 2>&1
test "$(cat "$database_file")" = "row-for-the-second-disk"
test "$(cat "$home/persistent.txt")" = "files-for-the-second-disk"
printf 'ok  the encrypted off-host copy decrypts and restores\n'

# A copy that cannot be written is not a failed backup: the local copy is complete and verified,
# and calling that a failure sends an owner hunting for a copy that is sitting right there.
rm -rf -- "$off_host"
sleep 1
if ! unreachable_output=$(run_garden backup 2>&1); then
  printf 'a backup failed because its off-host destination was unmounted\n' >&2
  exit 1
fi
test "$(sed -n 's/^outcome=//p' "$backup_status_file" | sed -n '1p')" = ok
test "$(sed -n 's/^off_host=//p' "$backup_status_file" | sed -n '1p')" = failed
grep -q 'is not a directory this computer can see' <<EOF
$unreachable_output
EOF
# And `doctor` says which of the two happened rather than reporting a green backup that exists in
# exactly one place.
doctor_output=$(run_garden doctor 2>&1 || true)
grep -q 'copied locally, not yet off-host' <<EOF
$doctor_output
EOF
printf 'ok  an unreachable destination fails the copy, not the backup, and doctor says so\n'

# The ordinary day that made that report false. `record_backup_status` rewrites backup.status from
# nothing on every run, so a run that stands down for a busy worker - the design, drilled above -
# carries the off-host field of the copy before it away with it. Reading the record alone then left
# `doctor` telling an owner who had already named a second disk that their backups are kept on this
# computer only, one line after `backup destination show` says where they go, and pointing them at
# the command they had already run.
: >"$worker_busy"
run_garden backup auto run >/dev/null 2>&1
rm -f "$worker_busy"
test "$(status_field outcome)" = skipped
test -z "$(sed -n 's/^off_host=//p' "$backup_status_file" | sed -n '1p')"
configured_doctor=$(run_garden doctor 2>&1 || true)
if grep -q 'kept on this computer only' <<EOF
$configured_doctor
EOF
then
  printf 'doctor called a box with a named off-host destination single-disk\n' >&2
  exit 1
fi
grep -q 'an off-host destination is named' <<EOF
$configured_doctor
EOF
rm -f "$fake_bin/gpg" "$fake_bin/df"
run_garden backup destination off >/dev/null 2>&1
# The counter-direction, and the reason the branch cannot simply be deleted: a box that has never
# named a second place must still be told so, from the same arm and the same empty record.
unconfigured_doctor=$(run_garden doctor 2>&1 || true)
grep -q 'kept on this computer only' <<EOF
$unconfigured_doctor
EOF
printf 'ok  a skipped run does not turn a configured destination into no destination\n'

# `garden rollback` itself, which had no case of its own.
#
# The update's internal rollback is drilled three ways above, but the command an operator types
# after a release passes every automatic gate and is still wrong went through `restore_garden`
# without anything watching it do so. That matters here because `restore` grew an argument parser
# in this change and `rollback` is one of its two callers - a parser that mishandled the positional
# would have left the command an owner reaches for on their worst day quietly restoring nothing.
sleep 1
printf 'row-before-the-rollback\n' >"$database_file"
printf 'files-before-the-rollback\n' >"$home/persistent.txt"
run_garden backup >/dev/null 2>&1
printf 'row-after-the-rollback\n' >"$database_file"
printf 'files-after-the-rollback\n' >"$home/persistent.txt"
: >"$command_log"
rollback_output=$(run_garden rollback 2>&1)
test "$(cat "$database_file")" = "row-before-the-rollback"
test "$(cat "$home/persistent.txt")" = "files-before-the-rollback"
grep -q 'Rollback complete' <<EOF
$rollback_output
EOF
printf 'ok  rollback with no argument consumes the newest backup and puts both halves back\n'

rollback_stop_line=$(sed -n '/systemctl stop garden.target/=' "$command_log" | sed -n '1p')
rollback_build_line=$(sed -n '/pnpm -r build/=' "$command_log" | sed -n '1p')
test -n "$rollback_stop_line" && test -n "$rollback_build_line"
test "$rollback_stop_line" -lt "$rollback_build_line"
rollback_reference=$(find "$backups" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' | sort -r | sed -n '1p')
test -n "$rollback_reference"
cp -R "$rollback_reference" "$test_root/invalid-rollback"
printf 'corruption\n' >>"$test_root/invalid-rollback/database.dump"
: >"$command_log"
if run_garden rollback "$test_root/invalid-rollback" >/dev/null 2>&1; then
  printf 'a corrupt rollback archive was accepted\n' >&2; exit 1
fi
test ! -s "$command_log"
: >"$command_log"
if GARDEN_TEST_REVERSE_BUILD_FAIL=1 run_garden rollback "$rollback_reference" >/dev/null 2>&1; then
  printf 'a failed reverse build was accepted\n' >&2; exit 1
fi
unset GARDEN_TEST_REVERSE_BUILD_FAIL
grep -q 'systemctl stop garden.target' "$command_log"
if grep -q 'systemctl start garden.target' "$command_log"; then
  printf 'a failed reverse build started the server\n' >&2; exit 1
fi
test -f "$rollback_reference/SHA256SUMS"
: >"$command_log"
if GARDEN_TEST_RESTORE_FAIL=1 run_garden restore "$rollback_reference" --yes >/dev/null 2>&1; then
  printf 'a failed data restore was accepted\n' >&2; exit 1
fi
unset GARDEN_TEST_RESTORE_FAIL
if grep -q 'systemctl start garden.target' "$command_log"; then
  printf 'a failed data restore started the server\n' >&2; exit 1
fi
run_garden restore "$rollback_reference" --yes >/dev/null 2>&1
printf 'ok  rollback validates before stopping, stops before build and keeps failures stopped\n'

# What a release carries besides its code, and whether an update delivers any of it.
#
# Measured on the owner's server, updated from f02ca24 to 9bf2bdc with `sudo garden update`, which
# printed "Update complete after 1 minutes offline" and exited 0. Four things did not arrive:
# CONFINE_AGENT_FILESYSTEM was absent from /etc/garden/runner.env, so the Landlock boundary was
# present and switched off while `garden-sandbox check` answered `filesystem=landlock`;
# python3-scipy and statsmodels were in the capability table and not on the disk; no workspace had
# the `.home` the agent's HOME had moved to; and nothing recorded the run, so `doctor` said "no
# update run recorded yet" minutes afterwards. The update ran three steps - fetch, install
# dependencies, build - plus the runtime files and the migrations, and nothing else an install does.
#
# The case below is generic on purpose: what it publishes is a revision whose OWN installer answers
# `--release-steps`, and what it checks is that the update called it and that what it did landed.
# That is the property that has to hold for a step nobody has written yet.
: >"$command_log"
cat >"$seed/scripts/install-native.sh" <<'RELEASE_INSTALLER'
#!/bin/sh
set -eu
case "${1:-}" in
  --release-steps)
    printf 'the release steps ran\n' >>"$GARDEN_TEST_COMMAND_LOG"
    printf 'installed newly-declared-package\n' >>"$GARDEN_TEST_COMMAND_LOG"
    printf 'NEWLY_DECLARED_KEY=written-by-the-release\n' >>"$GARDEN_CONFIG/runner.env"
    exit 0
    ;;
esac
printf 'the installer ran\n' >>"$GARDEN_TEST_COMMAND_LOG"
RELEASE_INSTALLER
chmod 0755 "$seed/scripts/install-native.sh"
printf '\n# fixture-version=v11\n' >>"$seed/scripts/garden-service"
publish_fixture v11-carries-release-steps
run_update >/dev/null 2>&1
if ! grep -q 'the release steps ran' "$command_log"; then
  printf 'the update never asked the new release for the steps it carries\n' >&2
  exit 1
fi
grep -q 'installed newly-declared-package' "$command_log"
# Once in one update, and this is the ordinary path where it could be twice. The checkout's own
# `update install-runtime-files` phase applies the steps and leaves a marker; the shell that started
# the update reads that marker and does not do it again. Without it the owner pays for a second
# package resolution in the middle of their outage.
if [ "$(grep -c 'the release steps ran' "$command_log")" -ne 1 ]; then
  printf 'the release steps ran %s times in one update\n' \
    "$(grep -c 'the release steps ran' "$command_log")" >&2
  exit 1
fi
# And the marker the two shells talk through is cleared, so the next run cannot read a stale one.
test ! -e "$state/release-steps-applied"
if ! grep -q '^NEWLY_DECLARED_KEY=written-by-the-release$' "$config/runner.env"; then
  printf 'a setting the new release declares was not written to runner.env by the update\n' >&2
  exit 1
fi
# And what ran was the release entry point, not an install. Creating accounts, writing sudoers,
# regenerating the shared secret and re-issuing a certificate on a box that is already serving is
# the mistake this whole shape is arranged to avoid, and the fixture says which of the two it was.
if grep -q 'the installer ran' "$command_log"; then
  printf 'the update ran a full install on a box that was already installed\n' >&2
  exit 1
fi
printf 'ok  an update delivers the packages and settings the new release carries\n'

# And it delivers them to the box that cannot ask for them.
#
# `garden update` is /usr/local/bin/garden, the PREVIOUS release's copy of this script, so the
# release that first calls the release steps from `update_garden` cannot make itself arrive: the
# shell running that update has never heard of the call. That is exactly the server this lane came
# from - it runs the copy of `garden` the last update placed, which knows how to hand the runtime
# files to the checkout and nothing about the steps beside them. Without a route through the phase,
# the boundary that shipped switched off stays off for one more release.
#
# The fixture is that server: this release's script with the one line in `update_garden` removed,
# keeping the phase. What it must do is apply the steps anyway, once, from the checkout's own arm.
predating_updater="$test_root/predating-garden"
# The call is replaced by a no-op rather than deleted, because deleting it would leave the `else` it
# sits in empty and the fixture would fail to parse instead of standing in for a real server. What a
# release that predates the call has at that point in `update_garden` is nothing happening.
sed 's/^    install_release_carried_steps$/    : "this release had no such call"/' \
  "$checkout/scripts/garden" >"$predating_updater"
if cmp -s "$predating_updater" "$checkout/scripts/garden"; then
  printf 'the fixture changed nothing, so it stands in for no server at all\n' >&2
  exit 1
fi
if grep -q '^    install_release_carried_steps$' "$predating_updater"; then
  printf 'the fixture still calls the release steps from update_garden\n' >&2
  exit 1
fi
# And it keeps the one route this case is about: the phase it hands the runtime files to.
grep -q '^      install-runtime-files)' "$predating_updater"
chmod 0755 "$predating_updater"
: >"$command_log"
: >"$config/runner.env"
printf '\n# fixture-version=v11a\n' >>"$seed/scripts/garden-service"
publish_fixture v11a-updated-by-a-script-that-predates-the-call
PATH="$fake_bin:$PATH" \
  GARDEN_TEST_COMMAND_LOG="$command_log" \
  GARDEN_TEST_REAL_GIT="$real_git" \
  GARDEN_TEST_CHECKOUT="$checkout" \
  GARDEN_ROOT="$checkout" \
  GARDEN_CONFIG="$config" \
  GARDEN_STATE="$state" \
  GARDEN_HOME="$home" \
  GARDEN_BACKUP_ROOT="$backups" \
  GARDEN_BACKUP_KEEP=5 \
  GARDEN_BACKUP_IDLE_WAIT_SECONDS=0 \
  GARDEN_TEST_WORKER_BUSY="$worker_busy" \
  GARDEN_TEST_WORKER_BUSY_LATE="$test_root/worker-busy-late" \
  GARDEN_TEST_DATABASE="$database_file" \
  GARDEN_TEST_OFF_HOST="$off_host" \
  GARDEN_READY_TIMEOUT_SECONDS=3 \
  GARDEN_RUNTIME_PREFIX="$runtime" \
  /bin/sh "$predating_updater" update >/dev/null 2>&1
if ! grep -q '^NEWLY_DECLARED_KEY=written-by-the-release$' "$config/runner.env"; then
  printf 'a box whose garden predates the call never received what the release carries\n' >&2
  exit 1
fi
# Once, not twice: a second package resolution is minutes of the owner's outage for nothing.
if [ "$(grep -c 'the release steps ran' "$command_log")" -ne 1 ]; then
  printf 'the release steps ran %s times in one update\n' \
    "$(grep -c 'the release steps ran' "$command_log")" >&2
  exit 1
fi
# And the marker the two shells talk through is not left behind for the next run to read.
test ! -e "$state/release-steps-applied"
printf 'ok  a box whose garden predates the call still gets what the release carries, once\n'

# Every route to a completed update records itself, so `doctor` can answer "when did this box last
# actually move". `record_update_status` has been drilled as a function in
# scripts/test-native-provisioning.sh since it was written; what had never been watched is the call
# site, which is the half that was missing on the server - it ran the previous release's script,
# and that script had no such line.
update_status_file="$state/update.status"
update_field() {
  sed -n "s/^$1=//p" "$update_status_file" | sed -n '1p'
}
test -f "$update_status_file"
test "$(update_field outcome)" = ok
test -n "$(update_field at)"
test "$(update_field revision)" = "$("$real_git" -C "$checkout" rev-parse --short HEAD)"
printf 'ok  a completed update records itself, with the revision it landed on\n'

# The counter-direction, and the one that would break somebody's server. A checkout from before the
# entry point existed treats `--release-steps` as an argument it has never heard of and runs a whole
# install: three accounts, a sudoers file, a regenerated runner secret and a certificate re-issue,
# on a stopped production box. So the phase is asked only of a revision that answers to it, and an
# update against one that does not still completes.
: >"$command_log"
cat >"$seed/scripts/install-native.sh" <<'OLD_INSTALLER'
#!/bin/sh
set -eu
printf 'the installer ran\n' >>"$GARDEN_TEST_COMMAND_LOG"
OLD_INSTALLER
chmod 0755 "$seed/scripts/install-native.sh"
printf '\n# fixture-version=v12\n' >>"$seed/scripts/garden-service"
publish_fixture v12-installer-predates-the-entry-point
older_installer_output=$(run_update 2>&1)
if grep -q 'the installer ran' "$command_log"; then
  printf 'a full install was run against a checkout that has no release-steps entry point\n' >&2
  exit 1
fi
grep -q 'fixture-version=v12' "$runtime/usr/local/lib/garden/garden-service"
grep -q 'Update complete' <<EOF
$older_installer_output
EOF
printf 'ok  the release steps are asked only of an installer that answers to them\n'

# The unattended run that returns without saying anything.
#
# `auto_update_run` writes `running` before it starts, because a run killed by its own start timeout
# reaches no further line. `update_garden` then re-checks the worker in the fraction of a second
# the earlier wait cannot cover, and returned through that gate without correcting the record - so a
# box whose worker happened to pick up a task at that instant was reported by `doctor` as an update
# that started and never came back, every week, for as long as the pattern lasted. The loudest thing
# the record can say, for the most ordinary thing that can happen.
printf '\n# fixture-version=v13\n' >>"$seed/scripts/garden-service"
publish_fixture v13-a-task-starts-late
revision_before_stand_down=$("$real_git" -C "$checkout" rev-parse HEAD)
busy_late="$test_root/worker-busy-late-marker"
: >"$busy_late"
stand_down_output=$(
  GARDEN_TEST_WORKER_BUSY_LATE="$busy_late" run_garden auto-update run 2>&1
)
grep -q 'a task started while the update was preparing' <<EOF
$stand_down_output
EOF
test "$("$real_git" -C "$checkout" rev-parse HEAD)" = "$revision_before_stand_down"
if [ "$(update_field outcome)" = running ]; then
  printf 'a run that stood down at the last moment is still recorded as one that never came back\n' >&2
  exit 1
fi
test "$(update_field outcome)" = skipped
test "$(update_field reason)" = "a task started while the update was preparing"
printf 'ok  an update that stands down at the last moment corrects its own record\n'

# The installer's release steps themselves, run rather than read.
#
# Everything above pins the WIRING - that the update asks the incoming release for its steps and
# that what they do lands. This runs the real scripts/install-native.sh, with one line replaced,
# and asks what `--release-steps` actually does on a box that is already installed.
#
# THE ONE LINE. `garden_detect_host` reads /etc/os-release, which does not exist on the machine
# this drill runs on, and the host it reports decides which column of the package table is used. It
# is replaced with a debian answer; every other line of the installer is the one that ships.
#
# WHAT CATCHES AN ENTRY POINT THAT STOPS EXITING before the install body: the run itself. Execution
# continues into `[ -f "$garden_root/package.json" ]`, which this rig's root does not have, so the
# run ends non-zero and every case below it goes red - measured by deleting that `exit 0`. On a real
# box the same fall-through would find a checkout and go on to create accounts, so the exit status
# is the whole of what this rig can prove there, and it is enough to fail the drill.
#
# WHAT THE ONE-TIME STAND-INS BELOW CATCH IS A DIFFERENT THING, and they are not decorative: they
# fire if a once-only command is ever added INSIDE a release step - a `usermod -a -G` that looks
# harmless, an `openssl rand` that quietly rotates a secret two services are holding. That is the
# mistake this shape makes easy to make, because the steps sit in the installer beside the code that
# legitimately does those things.
release_root="$test_root/release-root"
release_config="$test_root/release-etc"
release_home="$test_root/release-home"
release_bin="$test_root/release-bin"
mkdir -p "$release_root/scripts" "$release_config" "$release_bin" \
  "$release_home/signed-in/workspace" "$release_home/signed-in/.garden" \
  "$release_home/not-a-workspace" "$release_home/signed-in/workspace/.home"
cp "$repository_root/scripts/garden-host.sh" "$release_root/scripts/"
sed 's#^garden_detect_host || fail .*#garden_os_id=debian; garden_os_version=12; garden_family=debian; garden_pm=apt-get; garden_arch=x86_64#' \
  "$repository_root/scripts/install-native.sh" >"$release_root/scripts/install-native.sh"
if cmp -s "$release_root/scripts/install-native.sh" "$repository_root/scripts/install-native.sh"; then
  printf 'the host-detection line this rig replaces is no longer in the installer\n' >&2
  exit 1
fi
chmod 0755 "$release_root/scripts/install-native.sh"
# What an upgraded workspace looks like on the way in: a credential at the container root, where
# every released version put HOME, and a `.home` inside `workspace/` that an intermediate build put
# there and that must be left exactly where it is.
printf 'signed-in\n' >"$release_home/signed-in/.codex-auth.json"
printf 'agent-written\n' >"$release_home/signed-in/workspace/.home/.bashrc"
printf 'runner-only\n' >"$release_home/signed-in/.garden/profile"
printf 'left-alone\n' >"$release_home/not-a-workspace/stray-file"
printf 'runner=true\n' >"$release_config/runner.env"

# A bin directory of its own rather than the one every case above shares, because two of these -
# runuser and sudo - would otherwise replace the stand-ins the backup and restore cases depend on.
release_fake() {
  release_fake_name="$1"
  shift
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$@"
  } >"$release_bin/$release_fake_name"
  chmod 0755 "$release_bin/$release_fake_name"
}
release_fake chgrp 'exit 0'
release_fake chmod '
# macOS refuses the set-group-ID bit on a directory whose group is not the caller own, and this
# drill runs as an ordinary user on a temporary tree. A four-digit mode is dropped to its low three
# and passed on; everything else goes through untouched. What this rig pins is which files the
# migration moves, and not the mode the installer asks for - that is a Linux fact and this is not a
# Linux machine.
mode="$1"
case "$mode" in
  [0-7][0-7][0-7][0-7]) shift; exec /bin/chmod "${mode#?}" "$@" ;;
esac
exec /bin/chmod "$@"'
release_fake apt-get '
printf "apt-get %s\n" "$*" >>"$GARDEN_TEST_COMMAND_LOG"'
# The once-only steps, each with a stand-in that says so if it is ever reached. Nothing here is
# expected to run: reaching any of them on a box that is already serving is the mistake that would
# regenerate a shared secret two services are holding, or re-issue a rate-limited certificate.
for one_time_tool in useradd usermod visudo certbot initdb createuser openssl; do
  release_fake "$one_time_tool" '
printf "one-time tool %s ran\n" "$(basename "$0")" >>"$GARDEN_TEST_COMMAND_LOG"'
done
# The sandbox helper the measurement runs, reached the way the installer reaches it: through runuser
# and sudo. The report file is what this drill varies - present and naming a rung, or absent, which
# is the box where the helper is not installed and the measurement cannot be taken at all.
release_fake runuser '
while [ "$#" -gt 0 ]; do
  case "$1" in -u) shift 2 ;; --) shift; break ;; *) break ;; esac
done
exec "$@"'
release_fake sudo '
while [ "$#" -gt 0 ]; do
  case "$1" in -n|-E) shift ;; *) break ;; esac
done
case "${1:-}" in
  */garden-sandbox)
    # The helper is named by absolute path, which this drill cannot create, so the stand-in answers
    # in its place. No report file at all is the box where the helper is not installed: nothing to
    # run, and a non-zero exit, which is what the installer treats as "could not be measured".
    [ -f "$GARDEN_TEST_SANDBOX_REPORT" ] || exit 127
    cat "$GARDEN_TEST_SANDBOX_REPORT"
    exit 0
    ;;
esac
exec "$@"'
sandbox_report="$test_root/sandbox-report"

run_release_steps_rig() {
  : >"$command_log"
  PATH="$release_bin:$fake_bin:$PATH" \
    GARDEN_TEST_COMMAND_LOG="$command_log" \
    GARDEN_TEST_SANDBOX_REPORT="$sandbox_report" \
    GARDEN_ROOT="$release_root" \
    GARDEN_CONFIG="$release_config" \
    GARDEN_WORKSPACE_ROOT="$release_home" \
    /bin/sh "$release_root/scripts/install-native.sh" --release-steps
}

release_setting() {
  sed -n "s/^$1=//p" "$release_config/runner.env" | sed -n '1p'
}

printf 'user=garden-agent\nnetwork-isolation=yes\nfilesystem=landlock\n' >"$sandbox_report"
run_release_steps_rig >"$test_root/release-steps.out" 2>&1
# The packages the owner's box was missing, asked for by the names this family uses. Read from the
# capability table through the installer rather than restated, so a row added there is covered here
# without anybody remembering to come back.
grep -q 'apt-get install.*python3-scipy' "$command_log"
grep -q 'apt-get install.*python3-statsmodels' "$command_log"
# The setting that shipped present and off, written from what the helper measured.
test "$(release_setting CONFINE_AGENT_FILESYSTEM)" = true
test "$(release_setting AGENT_SANDBOX_HELPER)" = /usr/local/lib/garden/garden-sandbox
# An operator's own value is left alone, which is what set_env_default is for.
test "$(release_setting MAX_EXECUTION_SECONDS)" = 3600
# The workspace whose HOME moved: the credential is carried into `.home`, the runner's own directory
# is not, and the `.home` an intermediate build left inside `workspace/` stays exactly where it is.
test "$(cat "$release_home/signed-in/.home/.codex-auth.json")" = "signed-in"
test ! -e "$release_home/signed-in/.home/.garden"
test -d "$release_home/signed-in/workspace"
test "$(cat "$release_home/signed-in/workspace/.home/.bashrc")" = "agent-written"
# And a directory under the workspace root that is not a workspace is not treated as one.
test ! -e "$release_home/not-a-workspace/.home"
test "$(cat "$release_home/not-a-workspace/stray-file")" = "left-alone"
# None of the once-only steps. This is the half that breaks a server rather than leaving it stale.
if grep -q 'one-time tool' "$command_log"; then
  printf 'the release steps reached a step that may only run on a fresh install:\n' >&2
  grep 'one-time tool' "$command_log" >&2
  exit 1
fi
test -z "$(release_setting RUNNER_SHARED_SECRET)"
printf 'ok  the release steps install the declared packages, write the measured boundary and migrate a workspace\n'

# A second run changes nothing, because an update runs these every week for as long as the box
# lives. `mv -n` is what makes the migration repeatable, and a credential that the first run carried
# across must not be clobbered by a file the agent has written at the root since.
printf 'written-since\n' >"$release_home/signed-in/.codex-auth.json"
run_release_steps_rig >/dev/null 2>&1
test "$(cat "$release_home/signed-in/.home/.codex-auth.json")" = "signed-in"
printf 'ok  running the release steps again moves nothing and overwrites nothing\n'

# The three answers the filesystem rung has, and why it is not two. `false` is a measurement - this
# kernel cannot - and the runner has to be told, or it asks for a ruleset the kernel rejects and
# every command exits 125. EMPTY is "could not ask", which is not the same statement, and writing
# `false` for it would take a working boundary off a box during an update because a probe failed.
printf 'user=garden-agent\nnetwork-isolation=yes\nfilesystem=none\n' >"$sandbox_report"
run_release_steps_rig >/dev/null 2>&1
test "$(release_setting CONFINE_AGENT_FILESYSTEM)" = false
printf 'user=garden-agent\nnetwork-isolation=yes\nfilesystem=landlock\n' >"$sandbox_report"
run_release_steps_rig >/dev/null 2>&1
test "$(release_setting CONFINE_AGENT_FILESYSTEM)" = true
rm -f "$sandbox_report"
unmeasured_output=$(run_release_steps_rig 2>&1)
if [ "$(release_setting CONFINE_AGENT_FILESYSTEM)" != true ]; then
  printf 'a host that could not be measured had its filesystem boundary rewritten anyway\n' >&2
  exit 1
fi
grep -q 'could not be measured' <<EOF
$unmeasured_output
EOF
printf 'ok  the filesystem boundary is written from a measurement, and left alone when there is none\n'

# A step that goes wrong stops there and says so, and the steps beside it still run.
#
# Both halves were broken in the first arrangement of this, and the drill is what showed it. `set -e`
# is ignored for any command that is not the last of an AND-OR list, a subshell inherits that
# suppression, and `set -e` written inside the subshell does not re-arm it - so `(step) || note`
# ran the settings step through fourteen consecutive failed writes to its last line and reported
# success. Each step now re-enters the installer as its own process. This case is the one that goes
# red if that ever becomes a subshell again: one failure, not fourteen, and a non-zero ending.
printf 'user=garden-agent\nfilesystem=landlock\n' >"$sandbox_report"
failing_config="$test_root/release-etc-unwritable"
if failing_step_output=$(
  : >"$command_log"
  PATH="$release_bin:$fake_bin:$PATH" \
    GARDEN_TEST_COMMAND_LOG="$command_log" \
    GARDEN_TEST_SANDBOX_REPORT="$sandbox_report" \
    GARDEN_ROOT="$release_root" \
    GARDEN_CONFIG="$failing_config" \
    GARDEN_WORKSPACE_ROOT="$release_home" \
    /bin/sh "$release_root/scripts/install-native.sh" --release-steps 2>&1
); then
  printf 'a release step that could not write its settings reported success\n' >&2
  exit 1
fi
grep -q 'did not finish: release_step_runner_settings' <<EOF
$failing_step_output
EOF
if [ "$(grep -c '^mktemp:' <<EOF
$failing_step_output
EOF
)" -ne 1 ]; then
  printf 'the settings step carried on past its first failed write:\n%s\n' "$failing_step_output" >&2
  exit 1
fi
# And the step before it was not taken down with it, which is the reason each one runs on its own:
# a distribution mirror that is unreachable must not cost the box its security boundary.
grep -q 'apt-get install' "$command_log"
printf 'ok  a release step that fails stops at its first failure and does not take the others with it\n'

# What the owner can see about the boundary this branch added, which until now was nothing.
#
# `doctor` reported the identity boundary - "agent commands run as garden-agent, not as the runner"
# - and said nothing at all about the filesystem. On the server this was measured on, that silence
# was the whole of the report: `garden-sandbox check` answered `filesystem=landlock`, the runner's
# /healthz answered `agentFilesystemConfined: false`, and no line anywhere put those two together.
#
# READ FROM THE RUNNER AND NOT FROM THE SETTING, because the setting is the thing that was wrong.
runner_health="$test_root/runner-health"
doctor_sandbox="$runtime/usr/local/lib/garden/garden-sandbox"
printf 'AGENT_SANDBOX_HELPER=%s\n' "$doctor_sandbox" >>"$config/runner.env"
printf '{"ok":true,"agentSandbox":true,"agentFilesystemConfined":true}\n' >"$runner_health"
printf 'user=garden-agent\nnetwork-isolation=yes\nfilesystem=landlock\n' >"$sandbox_report"
confined_doctor=$(run_garden doctor 2>&1 || true)
grep -q '^ok  *agent commands are confined to their own workspace as well as their own account' <<EOF
$confined_doctor
EOF
# The box the lead measured: the kernel can, and the runner is not doing it. That is a fault with a
# repair, and the sentence has to name the repair rather than the symptom.
printf '{"ok":true,"agentSandbox":true,"agentFilesystemConfined":false}\n' >"$runner_health"
unconfined_doctor=$(run_garden doctor 2>&1 || true)
grep -q '^fail  *this kernel can confine agent commands to their own workspace and the runner is not doing it' <<EOF
$unconfined_doctor
EOF
grep -q 'sudo garden update writes it from what this kernel measures' <<EOF
$unconfined_doctor
EOF
# And the box that honestly cannot. Failing `doctor` for the life of a machine whose kernel has no
# Landlock would make it a report nobody finishes reading, and the two boundaries that ARE in force
# are the thing to say instead.
printf 'user=garden-agent\nnetwork-isolation=yes\nfilesystem=none\n' >"$sandbox_report"
old_kernel_doctor=$(run_garden doctor 2>&1 || true)
if grep -q 'this kernel can confine agent commands' <<EOF
$old_kernel_doctor
EOF
then
  printf 'doctor called a kernel without Landlock a fault\n' >&2
  exit 1
fi
# The LEVEL and not only the words. A machine whose kernel has no Landlock can do nothing about it,
# and a `doctor` that fails for the life of that machine is one nobody finishes reading - so this
# reads the prefix the line is filed under, which is the whole of the difference. Written first as a
# words-only check, which stayed green when the note was changed to a failure.
grep -q '^note  *agent commands are not confined to their own workspace: this kernel or util-linux has no Landlock' <<EOF
$old_kernel_doctor
EOF
# A runner older than the field says nothing about it, which is not evidence either way.
rm -f "$runner_health"
silent_runner_doctor=$(run_garden doctor 2>&1 || true)
grep -q '^note  *this runner does not report whether agent commands are confined' <<EOF
$silent_runner_doctor
EOF
printf 'ok  doctor reports the filesystem rung the runner is enforcing, and calls an old kernel a note\n'

# The advice `doctor` gives an owner whose document tooling is incomplete. It read "On Debian and
# Ubuntu, sudo garden update reinstalls it" and was false on every family, because an update
# installed no packages at all; the owner of the measured server followed it and nothing happened.
make_fake fc-list 'exit 0'
tooling_doctor=$(run_garden doctor 2>&1 || true)
rm "$fake_bin/fc-list"
if grep -q 'sudo garden update reinstalls it' <<EOF
$tooling_doctor
EOF
then
  printf 'doctor still tells the owner to run an update that will not install anything\n' >&2
  exit 1
fi
grep -q "sudo garden update installs every package this host's family has for them" <<EOF
$tooling_doctor
EOF
printf 'ok  the missing-tooling advice names a command that now does what it says\n'

# Uninstall, last, because it takes the runtime files every case above installed.
#
# On a self-hosted product "uninstall" is a promise about the owner's own machine, and the daily
# backup timer broke it silently: the installer enabled it with --now, the removal lists never named
# it, and it went on starting as root every day for ever. On a fully removed box it fails on a
# target whose unit file is gone and starts its alert companion, every day; on a partly removed one
# it stops and restarts the whole product and writes a fresh keys-bearing archive into
# /var/backups/garden until the disk fills. The nginx site had the same shape on the conf.d
# layout - only the sites-enabled path was removed, so on rhel, arch and suse nginx went on serving
# a deleted application.
: >"$command_log"
run_garden uninstall >/dev/null 2>&1
if ! grep -q 'systemctl disable --now .*garden-backup\.timer' "$command_log"; then
  printf 'uninstall left the daily backup timer enabled\n' >&2
  exit 1
fi
backup_leftovers=$(find "$runtime" -name 'garden-backup*' -print)
if [ -n "$backup_leftovers" ]; then
  printf 'uninstall left the backup units on disk:\n%s\n' "$backup_leftovers" >&2
  exit 1
fi
for removed in \
  /etc/systemd/system/garden.target \
  /etc/systemd/system/garden-runner.service \
  /etc/systemd/system/garden-gui.service \
  /etc/nginx/sites-available/garden \
  /etc/nginx/conf.d/garden.conf \
  /etc/nginx/snippets/garden-security-headers.conf \
  /etc/nginx/snippets/garden-app-csp.conf \
  /etc/update-motd.d/99-garden; do
  if [ -e "$runtime$removed" ]; then
    printf 'uninstall left %s behind\n' "$removed" >&2
    exit 1
  fi
done
printf 'ok  uninstall disables the backup timer and removes what it installed\n'

# Exercise the native activation entry point against an existing installation. The package/network
# fixtures stand in only for acquisition; real filesystem links, version checks, policy staging and
# subprocess failure propagation run unchanged.
fail_case() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
native_case="$test_root/native-runtime"
native_source="$native_case/source"
native_runtime="$native_case/runtime"
native_bin="$native_case/bin"
native_lib="$native_runtime/usr/local/lib/garden"
mkdir -p "$native_source/scripts" "$native_source/infra/native" "$native_bin" \
  "$native_source/services/workspace-runner/node_modules" "$native_lib/python/bin" \
  "$native_runtime/etc/sudoers.d"
cp "$repository_root/scripts/garden-native-runtime" "$native_source/scripts/"
cp "$repository_root/infra/native/garden-python-requirements.txt" \
  "$repository_root/infra/native/garden-packages.sudoers" "$native_source/infra/native/"
cp "$repository_root/scripts/mission-supervisor.py" "$native_lib/"
cp "$repository_root/services/workspace-runner/package.json" "$native_source/services/workspace-runner/"
node - "$native_source/services/workspace-runner/package.json" <<'JS'
const fs=require('node:fs'), path=require('node:path');
const manifest=JSON.parse(fs.readFileSync(process.argv[2]));
for (const [name, entry] of [['typescript-native','bin/tsc'],['pyright','langserver.index.js']]) {
 const dir=path.join(path.dirname(process.argv[2]),'node_modules',name);
 fs.mkdirSync(path.dirname(path.join(dir,entry)),{recursive:true});
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,version:manifest.dependencies[name].replace(/^npm:[^@]+@/,'')}));
 fs.writeFileSync(path.join(dir,entry),'console.log("native server fixture");');
}
JS
mkdir -p "$native_case/config"
printf 'PUBLIC_APP_URL=https://native-box.example\nPREVIEW_BASE_URL=https://native-box.example/__garden/preview\n' >"$native_case/config/control.env"
printf 'ISOLATE_AGENT_NETWORK=false\nRESERVED_PREVIEW_PORTS=4100,4400,9999\n' >"$native_case/config/runner.env"
printf 'old policy\n' >"$native_runtime/etc/sudoers.d/garden-packages"
printf 'original Python\n' >"$native_lib/python/owner-marker"
native_real_python=$(command -v python3)
export NATIVE_REAL_PYTHON="$native_real_python" NATIVE_CASE="$native_case"
cat >"$native_bin/python3" <<'PYTHON'
#!/bin/sh
set -eu
if [ "${1:-}" = -m ] && [ "${2:-}" = venv ]; then
  for target in "$@"; do :; done
  mkdir -p "$target/bin"
  cp "$NATIVE_CASE/python-fixture" "$target/bin/python3"
  chmod 0755 "$target/bin/python3"
  exit 0
fi
exec "$NATIVE_REAL_PYTHON" "$@"
PYTHON
cat >"$native_case/python-fixture" <<'PYTHON'
#!/bin/sh
set -eu
if [ "${1:-}" = -m ]; then
  printf '%s\n' "$*" >>"$NATIVE_CASE/pip-arguments"
  test ! -f "$NATIVE_CASE/fail-pip"
fi
PYTHON
cat >"$native_bin/curl" <<'CURL'
#!/bin/sh
set -eu
printf 'download\n' >>"$NATIVE_CASE/downloads"
if [ -f "$NATIVE_CASE/interrupt-download" ]; then kill -TERM "$PPID"; exit 143; fi
for argument in "$@"; do destination="$argument"; done
"$NATIVE_REAL_PYTHON" - "$destination" <<'PYTHON'
import io, os, sys, tarfile
body = b'function {\n' if os.path.exists(os.path.join(os.environ['NATIVE_CASE'], 'invalid-js')) else b'console.log("debugger fixture");\n'
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for name, content in [('js-debug', None), ('js-debug/src', None),
                          ('js-debug/src/dapDebugServer.js', body)]:
        entry = tarfile.TarInfo(name)
        entry.uid = entry.gid = 1000
        entry.uname = entry.gname = 'archive-builder'
        entry.mode = 0o777 if content is None else 0o6777
        if content is None:
            entry.type = tarfile.DIRTYPE
            archive.addfile(entry)
        else:
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
PYTHON
CURL
cat >"$native_bin/sha256sum" <<'HASH'
#!/bin/sh
set -eu
if [ "${1:-}" = --check ]; then
  cat >"$NATIVE_CASE/hash-check"
  test ! -f "$NATIVE_CASE/fail-hash"
else
  exec /usr/bin/shasum -a 256 "$@"
fi
HASH
cat >"$native_bin/visudo" <<'POLICY'
#!/bin/sh
set -eu
for argument in "$@"; do policy="$argument"; done
if [ -f "$NATIVE_CASE/fail-policy" ]; then exit 1; fi
grep -q '^Cmnd_Alias GARDEN_MISSION_STATUS = ' "$policy"
grep -q '^Defaults!GARDEN_SANDBOX_RUN !use_pty$' "$policy"
POLICY
chmod 0755 "$native_bin/"*
# The installer must normalize archive modes even under a permissive caller umask.
run_native() (
  umask 000
  PATH="$native_bin:$fake_bin:$PATH" GARDEN_ROOT="$native_source" \
    GARDEN_RUNTIME_PREFIX="$native_runtime" GARDEN_CONFIG="$native_case/config" \
    /bin/sh "$native_source/scripts/garden-native-runtime" "$@"
)
assert_original_native() {
  test ! -L "$native_lib/python"
  test "$(cat "$native_lib/python/owner-marker")" = 'original Python'
  test "$(cat "$native_runtime/etc/sudoers.d/garden-packages")" = 'old policy'
}
: >"$native_case/fail-pip"
if run_native all >/dev/null 2>&1; then fail_case 'failed Python install was accepted'; fi
assert_original_native
rm "$native_case/fail-pip"
: >"$native_case/interrupt-download"
if run_native all >/dev/null 2>&1; then fail_case 'interrupted native download was accepted'; fi
assert_original_native
rm "$native_case/interrupt-download"
: >"$native_case/fail-hash"
if run_native all >/dev/null 2>&1; then fail_case 'invalid debugger hash was accepted'; fi
assert_original_native
rm "$native_case/fail-hash"
printf 'ok  failed and interrupted native acquisition preserves active tools and policy\n'

run_native all >"$native_case/activated.log" 2>&1 || {
  cat "$native_case/activated.log" >&2
  fail_case 'valid archive ownership and modes must normalize before activation'
}
for installed in python/bin/python3 js-debug/src/dapDebugServer.js mission-supervisor.py; do
  test -f "$native_lib/$installed" || fail_case "native activation omitted $installed"
done
test -L "$native_lib/python"
test -L "$native_lib/js-debug"
"$NATIVE_REAL_PYTHON" - "$native_lib/js-debug" <<'PYTHON'
import os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1]).resolve()
entries = [root, *root.rglob('*')]
assert len(entries) > 1, 'archive extraction did not create files'
for file in entries:
    info = file.lstat()
    assert info.st_uid == os.geteuid(), f'archive owner was preserved: {file}'
    assert not info.st_mode & 0o6022, f'archive write/special modes were preserved: {file}'
    assert stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), file
PYTHON
test "$(cat "$native_lib/python-before-managed/owner-marker")" = 'original Python'
grep -q -- '--require-hashes --no-deps --only-binary=:all:' "$native_case/pip-arguments" ||
  fail_case 'native Python wheels were not hash-verified'
grep -q '^ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772 ' "$native_case/hash-check"
grep -q '^Cmnd_Alias GARDEN_MISSION_STATUS = ' "$native_runtime/etc/sudoers.d/garden-packages"
cp "$native_runtime/etc/sudoers.d/garden-packages" "$native_case/verified-policy"
: >"$native_case/fail-policy"
if run_native policy >/dev/null 2>&1; then fail_case 'invalid sudo policy was activated'; fi
cmp "$native_case/verified-policy" "$native_runtime/etc/sudoers.d/garden-packages"
rm "$native_case/fail-policy"
: >"$native_case/fail-pip"
: >"$native_case/interrupt-download"
run_native all >/dev/null 2>&1
grep -q '^PREVIEW_BASE_URL=https://native-box.example:8443/__garden/preview$' "$native_case/config/control.env"
grep -q '^RESERVED_PREVIEW_PORTS=4100,4400,9999,443,8443$' "$native_case/config/runner.env"
grep -q '^ISOLATE_AGENT_NETWORK=false$' "$native_case/config/runner.env"
printf 'ok  native activation verifies pins, retains rollback tools and reuses its cache offline\n'
# A previously writable completed cache cannot become trusted through chmod/chown alone. Failed
# fresh acquisition preserves the exact active bytes; success replaces the tampered tree atomically.
rm "$native_case/fail-pip" "$native_case/interrupt-download"
js_cached=$(readlink "$native_lib/js-debug")
printf 'console.log("tampered cache");\n' >"$js_cached/src/dapDebugServer.js"
chmod 0777 "$js_cached/src/dapDebugServer.js"
printf 'do not retain unsafe cache entry\n' >"$js_cached/untrusted-extra"
: >"$native_case/fail-hash"
if run_native tools >/dev/null 2>&1; then fail_case 'unsafe cached debugger bypassed verified acquisition'; fi
grep -q 'tampered cache' "$js_cached/src/dapDebugServer.js"
test -f "$js_cached/untrusted-extra"
test "$(readlink "$native_lib/js-debug")" = "$js_cached"
rm "$native_case/fail-hash"
: >"$native_case/invalid-js"
if run_native tools >/dev/null 2>&1; then fail_case 'invalid debugger syntax was accepted'; fi
grep -q 'tampered cache' "$js_cached/src/dapDebugServer.js" || fail_case 'syntax validation replaced the active cache before it passed'
test -f "$js_cached/untrusted-extra"
test "$(readlink "$native_lib/js-debug")" = "$js_cached"
rm "$native_case/invalid-js"
native_downloads_before=$(wc -l <"$native_case/downloads")
run_native tools >"$native_case/repaired-cache.log" 2>&1 || {
  cat "$native_case/repaired-cache.log" >&2
  fail_case 'unsafe cached debugger was not safely replaced'
}
native_downloads_after=$(wc -l <"$native_case/downloads")
test "$native_downloads_after" -eq "$((native_downloads_before + 1))" || fail_case 'unsafe cache was not reacquired'
grep -q 'debugger fixture' "$js_cached/src/dapDebugServer.js"
test ! -e "$js_cached/untrusted-extra" || fail_case 'unsafe cache was repaired in place'
test "$(readlink "$native_lib/js-debug")" = "$js_cached"
"$NATIVE_REAL_PYTHON" - "$js_cached" <<'PYTHON'
import os, pathlib, sys
entries = [pathlib.Path(sys.argv[1]), *pathlib.Path(sys.argv[1]).rglob('*')]
assert len(entries) > 1
for file in entries:
    info = file.lstat()
    assert info.st_uid == os.geteuid() and not info.st_mode & 0o6022, file
assert not list(pathlib.Path(sys.argv[1]).parent.glob('.debug-install.*')), 'staged replacement was not cleaned'
PYTHON
: >"$native_case/interrupt-download"
run_native tools >/dev/null 2>&1
rm "$native_case/interrupt-download"
printf 'ok  real archive ownership/modes are normalized and unsafe completed adapters are reacquired before atomic replacement\n'
# The generated frame policy follows an explicitly configured isolated origin, including a
# custom gateway path. No reactivation rewrites the operator's route or networking preference.
printf 'PUBLIC_APP_URL=https://native-box.example\nPREVIEW_BASE_URL=https://private-apps.example:9443/custom/preview\nRESERVED_PREVIEW_PORTS=5555\n' >"$native_case/config/control.env"
run_native preview-origin
cp "$native_case/config/control.env" "$native_case/custom-control"
run_native preview-origin
cmp "$native_case/config/control.env" "$native_case/custom-control"
grep -q '^PREVIEW_BASE_URL=https://private-apps.example:9443/custom/preview$' "$native_case/config/control.env"
grep -Fq 'set $garden_preview_origin "https://private-apps.example:9443";' "$native_runtime/etc/nginx/snippets/garden-preview-origin.conf"
grep -q '^RESERVED_PREVIEW_PORTS=5555,443,8443$' "$native_case/config/control.env"
printf 'PUBLIC_APP_URL=https://[2001:db8::1]\nPREVIEW_BASE_URL=https://[2001:db8::1]/__garden/preview\n' >"$native_case/config/control.env"
run_native preview-origin
grep -Fq 'PREVIEW_BASE_URL=https://[2001:db8::1]:8443/__garden/preview' "$native_case/config/control.env"
printf 'PUBLIC_APP_URL=https://native-box.example\nPREVIEW_BASE_URL=https://native-box.example/unsafe-path\n' >"$native_case/config/control.env"
cp "$native_case/config/control.env" "$native_case/refused-control"
cp "$native_runtime/etc/nginx/snippets/garden-preview-origin.conf" "$native_case/refused-snippet"
if run_native preview-origin >/dev/null 2>&1; then fail_case 'same-origin custom preview configuration was accepted'; fi
cmp "$native_case/config/control.env" "$native_case/refused-control"
cmp "$native_runtime/etc/nginx/snippets/garden-preview-origin.conf" "$native_case/refused-snippet"
printf 'PUBLIC_APP_URL=https://native-box.example\n' >"$native_case/config/control.env"
run_native preview-origin
grep -q '^PREVIEW_BASE_URL=https://native-box.example:8443/__garden/preview$' "$native_case/config/control.env"
printf 'ok  preview activation preserves custom origins, refuses unsafe sharing and derives IPv6/fresh origins\n'

for server in typescript-native pyright; do
  server_dir="$native_source/services/workspace-runner/node_modules/$server"
  mv "$server_dir" "$server_dir.away"
  if run_native all >/dev/null 2>&1; then fail_case "native activation accepted missing $server"; fi
  mv "$server_dir.away" "$server_dir"
done
mv "$native_lib/mission-supervisor.py" "$native_lib/mission-supervisor.py.away"
if run_native all >/dev/null 2>&1; then fail_case 'native activation accepted missing supervisor'; fi
mv "$native_lib/mission-supervisor.py.away" "$native_lib/mission-supervisor.py"
printf 'ok  native activation refuses a missing language server or supervisor\n'

mkdir -p "$native_lib/python-owner" "$native_case/outside"
printf 'owner data\n' >"$native_lib/python-owner/keep"
printf 'external data\n' >"$native_case/outside/keep"
ln -s "$native_case/outside" "$native_lib/js-debug-999.0.0"
run_native remove
for removed in python js-debug; do test ! -e "$native_lib/$removed"; done
test "$(cat "$native_lib/python-owner/keep")" = 'owner data'
test "$(cat "$native_case/outside/keep")" = 'external data'
test "$(cat "$native_lib/python-before-managed/owner-marker")" = 'original Python'
printf 'ok  uninstall removes only receipt-owned native caches and keeps owner paths\n'

# Competing entry points run against one real kernel lock; only its root-owned path is substituted
# in this unprivileged fixture. Environment booleans cannot claim an acquired descriptor.
lock_holder="$test_root/maintenance-holder.sh"
cat >"$lock_holder" <<'HOLDER'
#!/bin/sh
set -eu
set -- help
. "$GARDEN_ROOT/scripts/garden" >/dev/null
need_root backup
acquire_maintenance_lock "${GARDEN_TEST_LOCK_WAIT:-}"
printf '%s\n' "$$" >"$GARDEN_TEST_LOCK_PID"
case "$GARDEN_TEST_LOCK_MODE" in
  hold) exec sleep 30 ;;
  fail) exit 71 ;;
  probe) exit 0 ;;
  child) /bin/sh "$GARDEN_ROOT/scripts/garden" update install-runtime-files ;;
esac
HOLDER
run_lock_holder() {
  PATH="$fake_bin:$PATH" GARDEN_ROOT="$checkout" GARDEN_STATE="$state" \
    GARDEN_CONFIG="$config" GARDEN_RUNTIME_PREFIX="$runtime" \
    GARDEN_TEST_COMMAND_LOG="$command_log" GARDEN_TEST_LOCK_MODE="$1" \
    GARDEN_TEST_LOCK_WAIT="${GARDEN_TEST_LOCK_WAIT:-}" \
    GARDEN_TEST_LOCK_BLOCKED="${GARDEN_TEST_LOCK_BLOCKED:-}" \
    GARDEN_TEST_LOCK_PID="$test_root/lock-holder-pid" \
    /bin/sh "$lock_holder"
}
rm -f "$test_root/lock-holder-pid"
run_lock_holder hold >"$test_root/lock-holder.log" 2>&1 &
lock_holder_job=$!
lock_wait=0
while [ ! -s "$test_root/lock-holder-pid" ] && [ "$lock_wait" -lt 100 ]; do
  sleep 0.02
  lock_wait=$((lock_wait + 1))
done
test -s "$test_root/lock-holder-pid"
lock_reference="$test_root/lock-reference"
mkdir -p "$lock_reference"
for entry in database.dump workspaces.tar.gz configuration.tar.gz SHA256SUMS; do
  : >"$lock_reference/$entry"
done
commands_before_lock=$(wc -l <"$command_log" | tr -d ' ')
for operation in backup update rollback restore; do
  set -- "$operation"
  [ "$operation" != restore ] || set -- "$operation" "$lock_reference" --yes
  if lock_refusal=$(maintenance_lock_acquired=1 GARDEN_MAINTENANCE_LOCKED=1 \
    run_garden "$@" 2>&1); then
    kill -TERM "$(cat "$test_root/lock-holder-pid")"
    fail_case "$operation overlapped the active maintenance operation"
  fi
  printf '%s\n' "$lock_refusal" | grep -q 'holds the maintenance lock'
done
test "$(wc -l <"$command_log" | tr -d ' ')" = "$commands_before_lock"
lock_skip=$(run_garden backup auto run 2>&1)
test "$(status_field outcome)" = skipped
test "$(status_field reason)" = 'another maintenance operation was still running'
printf '%s\n' "$lock_skip" | grep -q 'maintenance is busy'
held_pid=$(cat "$test_root/lock-holder-pid")
GARDEN_TEST_LOCK_WAIT=3 GARDEN_TEST_LOCK_BLOCKED="$test_root/lock-blocked" run_lock_holder probe >"$test_root/lock-waiter.log" 2>&1 &
lock_waiter_job=$!
lock_wait=0
while [ ! -e "$test_root/lock-blocked" ] && [ "$lock_wait" -lt 100 ]; do
  sleep 0.02
  lock_wait=$((lock_wait + 1))
done
test -e "$test_root/lock-blocked"
kill -0 "$lock_waiter_job"
kill -TERM "$held_pid"
wait "$lock_holder_job" || true
wait "$lock_waiter_job"
run_lock_holder probe
if run_lock_holder fail; then fail_case 'failure fixture succeeded'; fi
run_lock_holder probe
run_lock_holder child >"$test_root/lock-child.log" 2>&1
printf 'ok  maintenance entries exclude each other, reuse nested descriptors and release after failure or TERM\n'
