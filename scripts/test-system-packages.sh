#!/bin/sh
set -eu

# Exercises scripts/garden-system-packages without root and without a real package manager.
#
# That helper is the one root-privileged path on this computer: the agent asks for a package, the
# owner approves it, the runner rewrites the command onto a single sudoers rule, and this is what
# runs on the other side. Two properties of it are load-bearing and neither had a test on any
# branch until this file:
#
#   1. It dispatches to the package manager the host actually has. It knew apt and nothing else,
#      so on a Fedora, Rocky, Arch or openSUSE box an approved install ran /usr/bin/apt-get and
#      exited 127 - after the owner had already said yes.
#   2. The package-name filter is a security control, and it has to reject on *every* family. A
#      regex that is right on the apt branch and absent on the dnf branch is a root package
#      manager taking `-o APT::Update::Pre-Invoke::=id` as an argument on three hosts out of four.
#
# The managers are recorders rather than the real thing, so what is asserted is the command line
# the helper builds and the order it builds it in. The helper's own absolute literals - its search
# path, the host table it sources, the state directory it writes - are rewritten in a copy, the
# way scripts/test-sandbox.sh does, so that nothing here can be satisfied by an environment
# variable the production script does not read.

repository_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d)
# KEEP=1 leaves the tree behind, which is the only practical way to read the copy under test after
# a failure.
if [ -n "${KEEP:-}" ]; then
  printf 'test_root=%s\n' "$test_root"
else
  trap 'rm -rf "$test_root"' EXIT INT TERM
fi

fake_bin="$test_root/bin"
active="$test_root/active"
records="$test_root/records"
state="$test_root/state"
host_bin="$test_root/host-bin"
mkdir -p "$fake_bin" "$active" "$records" "$state" "$host_bin"

# An inherited manager is a trap recorder: fixture dispatch must never reach it.
cat >"$host_bin/apt-get" <<'HOST_MANAGER'
#!/bin/sh
printf 'inherited host manager reached\n' >>"$GARDEN_TEST_RECORDS/calls"
exit 97
HOST_MANAGER
chmod 0755 "$host_bin/apt-get"
PATH="$host_bin:$PATH"
export PATH

failures=0
checks=0

# Dash makes special-builtin errors match the Linux /bin/sh contract even on another host.
helper_shell=/bin/sh
if command -v dash >/dev/null 2>&1; then helper_shell=$(command -v dash); fi

cat >"$fake_bin/id" <<'FAKE_ID'
#!/bin/sh
if [ "$1" = "-u" ]; then
  printf '%s\n' "${GARDEN_TEST_UID:-0}"
  exit 0
fi
printf 'unexpected id arguments: %s\n' "$*" >&2
exit 1
FAKE_ID
chmod 0755 "$fake_bin/id"

# One recorder per manager, placed in "$active" one at a time. `garden_detect_package_manager`
# probes apt-get, dnf5, dnf, zypper, pacman in that order and takes the first it finds, so a
# directory holding exactly one of them is how a family is chosen here.
make_manager() {
  rm -f "$active"/*
  cat >"$active/$1" <<'RECORDER'
#!/bin/sh
printf '%s %s\n' "${0##*/}" "$*" >>"$GARDEN_TEST_RECORDS/calls"
RECORDER
  chmod 0755 "$active/$1"
}

# The helper names the tools that write its manifest by absolute path, which is right on every
# host it runs on and wrong on the one this fixture is usually developed on: macOS keeps cat, chmod
# and mv in /bin rather than /usr/bin. Resolved into a directory of links here so that the property
# under test stays "an absolute path this script chose" rather than becoming "whatever is on PATH".
coreutils="$test_root/coreutils"
mkdir -p "$coreutils"
# Looked for by path rather than with `command -v`, which answers "printf" for a shell builtin and
# would have linked the directory to itself.
for tool in cat chmod install mktemp mv printf sort; do
  resolved=""
  for directory in /usr/bin /bin /usr/local/bin; do
    if [ -x "$directory/$tool" ]; then
      resolved="$directory/$tool"
      break
    fi
  done
  if [ -z "$resolved" ]; then
    printf 'this host has no %s on a standard path, so the manifest cannot be exercised\n' "$tool" >&2
    exit 1
  fi
  ln -sf "$resolved" "$coreutils/$tool"
done

# The copy under test. Every path the production script hard-codes is rewritten here rather than
# read from the environment, because the production script reading any of them from the
# environment would be the defect this file exists to make impossible.
helper="$test_root/garden-system-packages"
sed \
  -e "s|^PATH=/usr/sbin:/usr/bin:/sbin:/bin$|PATH='$active:$fake_bin'|" \
  -e "s|^host_definitions=/opt/garden/scripts/garden-host.sh$|host_definitions='$repository_root/scripts/garden-host.sh'|" \
  -e "s|^garden_state_dir=/var/lib/garden$|garden_state_dir='$state'|" \
  -e "s|/usr/bin/|$coreutils/|g" \
  "$repository_root/scripts/garden-system-packages" >"$helper"
chmod 0755 "$helper"

# A sed that matched nothing would leave the copy pointed at /opt and /var, where it would either
# fail for the wrong reason or - as root - do something real. Refuse to run rather than report a
# pass that measured the wrong file.
for rewritten in "$active:$fake_bin" "$repository_root/scripts/garden-host.sh" "$state" "$coreutils/mktemp"; do
  grep -q -- "$rewritten" "$helper" || {
    printf 'the fixture could not rewrite %s into its copy of the helper\n' "$rewritten" >&2
    exit 1
  }
done

run_helper() {
  rm -f "$records/calls"
  set +e
  GARDEN_TEST_RECORDS="$records" "$helper_shell" "$helper" "$@" >"$records/out" 2>"$records/err"
  helper_status=$?
  set -e
}

calls() { cat "$records/calls" 2>/dev/null || printf ''; }

check() {
  checks=$((checks + 1))
  if [ "$2" = "$3" ]; then
    printf 'ok   %s\n' "$1"
  else
    failures=$((failures + 1))
    printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$1" "$3" "$2" >&2
  fi
}

check_contains() {
  checks=$((checks + 1))
  case "$2" in
  *"$3"*) printf 'ok   %s\n' "$1" ;;
  *)
    failures=$((failures + 1))
    printf 'FAIL %s\n  expected to contain: %s\n  actual: %s\n' "$1" "$3" "$2" >&2
    ;;
  esac
}

# --- per-family dispatch ------------------------------------------------------------------------
#
# The refresh and the install are both asserted, in order, because the helper runs the index
# refresh itself: an install that skipped it succeeds on a box whose metadata is a month old and
# fails on the box the owner is actually watching.

# With the active family empty, neither inherited nor system managers may enter the fixture.
run_helper update
check 'an empty fixture refuses before reaching any host manager' "$helper_status" 1
check_contains 'the empty fixture reports no supported manager' "$(cat "$records/err")" \
  'no supported package manager found'
check 'an empty fixture invokes no host manager' "$(calls)" ''

printf '\n# dispatch\n'

for family in 'apt-get|apt-get update|apt-get install -y --no-install-recommends nmap tcpdump' \
  'dnf|dnf -y makecache|dnf install -y --setopt=install_weak_deps=False nmap tcpdump' \
  'zypper|zypper --non-interactive refresh|zypper --non-interactive install --no-recommends nmap tcpdump' \
  'pacman|pacman -Sy --noconfirm|pacman -S --noconfirm --needed nmap tcpdump'; do
  manager=${family%%|*}
  rest=${family#*|}
  refresh=${rest%%|*}
  install=${rest#*|}
  make_manager "$manager"

  run_helper update
  check "$manager: update exits 0" "$helper_status" 0
  check "$manager: update refreshes the index and nothing else" "$(calls)" "$refresh"

  rm -f "$state/installed-packages"
  run_helper install nmap tcpdump
  check "$manager: install exits 0" "$helper_status" 0
  check "$manager: install refreshes then installs" "$(calls)" "$(printf '%s\n%s' "$refresh" "$install")"
  check "$manager: the install is recorded in the manifest" \
    "$(cat "$state/installed-packages")" "$(printf 'nmap\ntcpdump')"

  # A second install adds to the manifest rather than replacing it - the owner's record of what
  # this computer has been asked to add to itself is cumulative or it is nothing.
  run_helper install curl
  check "$manager: the manifest accumulates" \
    "$(cat "$state/installed-packages")" "$(printf 'curl\nnmap\ntcpdump')"
done

# --- the name filter, on every branch -----------------------------------------------------------
#
# Asserted per family rather than once, and asserting that the manager was never reached rather
# than only that the exit code was 1. "Refused before root ran anything" is the property; an exit
# 1 after `pacman -S ../x` had already been spawned would satisfy a weaker test and be the defect.

printf '\n# the package-name filter\n'

for manager in apt-get dnf zypper pacman; do
  make_manager "$manager"
  for unsafe in '-x' 'a::b' '../x' 'a b' '/etc/passwd' 'a;b' '-o APT::Update::Pre-Invoke::=id' \
    'nmap&&id' '$(id)' 'x:' '.hidden'; do
    run_helper install "$unsafe"
    check "$manager: refuses [$unsafe]" "$helper_status" 1
    check_contains "$manager: says why it refused [$unsafe]" "$(cat "$records/err")" \
      'Rejected unsafe package name'
    check "$manager: runs nothing as root for [$unsafe]" "$(calls)" ''
  done
  # One unsafe name among safe ones refuses the whole request. Installing the safe ones and
  # dropping the rest would be a partial answer to an approval the owner gave as a whole.
  run_helper install nmap '../x' tcpdump
  check "$manager: one unsafe name refuses the whole list" "$helper_status" 1
  check "$manager: and installs none of the safe ones" "$(calls)" ''
  # Names the families genuinely use, which the filter must not reject: epoch-style and
  # plus-suffixed names are ordinary on rhel and debian respectively.
  run_helper install 'python3-pyatspi' 'libreoffice-still' 'g++' 'ImageMagick' 'ttf-dejavu'
  check "$manager: accepts the names the host table actually holds" "$helper_status" 0
done

# --- argument shape -----------------------------------------------------------------------------

printf '\n# argument shape\n'

make_manager apt-get

run_helper install
check 'install with nothing to install is refused' "$helper_status" 1
check_contains 'and says so without naming a distribution' "$(cat "$records/err")" \
  'install requires at least one package name'
check 'and reaches no package manager' "$(calls)" ''

run_helper update extra
check 'update takes no arguments' "$helper_status" 1
check 'and reaches no package manager when given one' "$(calls)" ''

run_helper upgrade
check 'an operation the helper does not have is refused' "$helper_status" 1
check_contains 'with the two it does have' "$(cat "$records/err")" \
  'Usage: garden-system-packages {update|install PACKAGE...}'

run_helper
check 'no operation at all is refused' "$helper_status" 1
check_contains 'no operation prints the helper usage' "$(cat "$records/err")" \
  'Usage: garden-system-packages {update|install PACKAGE...}'
check 'no operation invokes no package manager' "$(calls)" ''

# --- the two things that must stop it before it starts ------------------------------------------

printf '\n# refusals before any work\n'

GARDEN_TEST_UID=1000
export GARDEN_TEST_UID
run_helper install nmap
check 'a caller that is not root is refused' "$helper_status" 1
check_contains 'and is told which policy it should have come through' "$(cat "$records/err")" \
  'must run through the installed sudo policy'
check 'and nothing runs' "$(calls)" ''
unset GARDEN_TEST_UID

# The host table is what makes this helper know more than one family. Carrying on without it -
# falling back to apt, say - is how a Debian assumption survives a repair that removed it.
missing_table="$test_root/garden-system-packages.no-table"
sed -e "s|^host_definitions='$repository_root/scripts/garden-host.sh'$|host_definitions='$test_root/absent/garden-host.sh'|" \
  "$helper" >"$missing_table"
chmod 0755 "$missing_table"
rm -f "$records/calls"
set +e
GARDEN_TEST_RECORDS="$records" "$helper_shell" "$missing_table" install nmap >"$records/out" 2>"$records/err"
helper_status=$?
set -e
check 'a missing host table stops the install' "$helper_status" 1
# The helper's own sentence, not the shell's. Without this the check passes on a helper that
# stopped reading the table at all and merely fell over on the next undefined function - which is
# the same pass a silent fall-back to apt would earn once someone made that fall-back quiet.
check_contains 'and says so in its own words' "$(cat "$records/err")" \
  'garden-system-packages cannot read'
check_contains 'and names the file it could not read' "$(cat "$records/err")" 'garden-host.sh'
check 'and installs nothing on a guess' "$(calls)" ''

printf '\n%s checks, %s failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ] || exit 1
