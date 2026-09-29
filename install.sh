#!/bin/sh
set -eu

garden_root="${GARDEN_ROOT:-/opt/garden}"
repository="${GARDEN_REPOSITORY:-https://github.com/ouaeic/garden.git}"
revision="${GARDEN_REF:-main}"
# The local branch the box lives on, and the upstream it follows for updates. A release is pinned by
# tag for reproducibility; updates arrive on the branch that tag was cut from.
garden_branch="${GARDEN_BRANCH:-garden}"
garden_track="${GARDEN_TRACK:-main}"
expected_commit="${GARDEN_EXPECTED_COMMIT:-}"

fail() {
  printf 'garden bootstrap: %s\n' "$1" >&2
  exit 1
}

if [ -n "$expected_commit" ]; then
  case "$expected_commit" in
    *[!0-9a-fA-F]*) fail "GARDEN_EXPECTED_COMMIT must be a Git commit hash" ;;
  esac
  case "${#expected_commit}" in
    40|64) ;;
    *) fail "GARDEN_EXPECTED_COMMIT must be a full Git commit hash" ;;
  esac
fi

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "run this command as root"
  exec sudo -E /bin/sh "$0" "$@"
fi

if [ ! -f "$garden_root/scripts/install-native.sh" ]; then
  # Only two packages are needed to reach the real installer, and the shape of that command is the
  # only thing this bootstrap has to know about the host. It used to test for apt-get and stop, so
  # an owner on Fedora, Rocky or Arch was refused before the repository was even cloned, by a
  # message naming two distributions and no reason.
  bootstrap_pm=""
  for candidate in apt-get dnf5 dnf zypper pacman; do
    if command -v "$candidate" >/dev/null 2>&1; then
      bootstrap_pm="$candidate"
      break
    fi
  done
  [ -n "$bootstrap_pm" ] ||
    fail "no supported package manager found: garden installs with apt-get, dnf, zypper or pacman"
  case "$bootstrap_pm" in
  apt-get)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates git
    ;;
  dnf | dnf5)
    "$bootstrap_pm" install -y --setopt=install_weak_deps=False ca-certificates git
    ;;
  zypper)
    zypper --non-interactive install --no-recommends ca-certificates git
    ;;
  pacman)
    pacman -Sy --noconfirm --needed ca-certificates git
    ;;
  esac
  if [ -e "$garden_root" ]; then
    [ -d "$garden_root/.git" ] ||
      fail "$garden_root already exists and is not an garden Git checkout"
  else
    # Not shallow. The update path rolls back by resetting to the revision it came from, and a
    # depth-1 clone has no revision to go back to.
    if [ -n "$expected_commit" ] && [ "$revision" = "$expected_commit" ]; then
      git clone "$repository" "$garden_root"
    else
      git clone --branch "$revision" "$repository" "$garden_root"
    fi
  fi
fi

# Everything below runs on every bootstrap, including one that found a checkout already here.
#
# It used to sit inside the block above, so a run that found /opt/garden/scripts/install-native.sh
# already on disk skipped the fetch, the checkout and the commit verification, and installed
# whatever revision happened to be lying there. The arrangement that reaches this a second time is
# not an owner running the command twice - the packaged client asks a working box for a pairing code
# instead of installing - it is a partial install, where the source arrived and the `garden` CLI
# never reached PATH. That is precisely the box whose state nobody can vouch for, and it was the one
# box where GARDEN_EXPECTED_COMMIT was not checked. The same skip meant the documented
# `GARDEN_REF=v0.1.1` never moved an existing checkout to v0.1.1; it rebuilt what was on disk.
[ -d "$garden_root/.git" ] ||
  fail "$garden_root is not an garden Git checkout"
command -v git >/dev/null 2>&1 ||
  fail "git is needed to verify the source at $garden_root and is not installed"
git -C "$garden_root" fetch --tags --prune origin

# A branch name is taken from the remote and everything else is taken as written. `main` names a
# local branch too, and on a box that has been here a while that local ref is whatever the clone
# left behind - checking it out would quietly move the server backwards to install day. A tag or a
# commit has no remote-tracking ref and is resolved as itself, which is what a pin means.
if git -C "$garden_root" rev-parse --verify --quiet "refs/remotes/origin/$revision" >/dev/null; then
  target="origin/$revision"
else
  target="$revision"
fi

# Installed at a pinned revision, but on a branch that can move.
#
# Checking out a tag leaves a detached HEAD with no upstream, so `git pull --ff-only` answers
# "Already up to date" for ever: the box never received another line of code while `doctor`
# cheerfully reported that unattended updates were on. Since the documented install command pins a
# tag, that was every installation. The tree still starts exactly at the pinned revision - that is
# what the pin is for - and this only gives the update path somewhere to fast-forward to.
git -C "$garden_root" checkout -B "$garden_branch" "$target"
git -C "$garden_root" branch --set-upstream-to="origin/$garden_track" "$garden_branch" ||
  fail "could not follow origin/$garden_track for updates"
if [ -n "$expected_commit" ]; then
  installed_commit=$(git -C "$garden_root" rev-parse --verify HEAD)
  [ "$installed_commit" = "$expected_commit" ] ||
    fail "the downloaded source does not match the client release commit"
fi

exec /bin/sh "$garden_root/scripts/install-native.sh" "$@"
