#!/bin/sh
set -eu

athanor_root="${ATHANOR_ROOT:-/opt/athanor}"
athanor_state="/var/lib/athanor"
# Overridable for the same reason ATHANOR_ROOT above is, and with the same default: scripts/athanor
# already reads ATHANOR_CONFIG, and scripts/test-update.sh runs this file's release steps against a
# temporary tree rather than against this host's /etc. Nothing in a real install sets it.
athanor_config="${ATHANOR_CONFIG:-/etc/athanor}"
control_user="athanor-control"
runner_user="athanor"
# Commands the agent runs get their own account, so a command cannot read the runner's process,
# its capability signing secret, or the browser profile the owner's logins live in. The two
# accounts share a group, which is how each can still work on the same workspace files.
agent_user="athanor-agent"

say() {
  printf '\n%s\n' "$1"
}

fail() {
  printf 'athanor install: %s\n' "$1" >&2
  exit 1
}

# Warnings are collected as well as printed: they matter most at the end, next to the
# connection ticket, where an operator would otherwise read “ready” and stop looking.
install_warnings=""
warn() {
  printf 'athanor install: %s\n' "$1" >&2
  install_warnings="$install_warnings  - $1
"
}

install_asset() {
  asset_mode="$1"
  asset_source="$2"
  asset_target="$3"
  if [ -e "$asset_target" ] && env test "$asset_source" -ef "$asset_target"; then
    chmod "$asset_mode" "$asset_target"
  else
    install -m "$asset_mode" "$asset_source" "$asset_target"
  fi
}

existing_control_value() {
  existing_key="$1"
  [ -f "$athanor_config/control.env" ] || return 0
  sed -n "s/^${existing_key}=//p" "$athanor_config/control.env" | sed -n '1p'
}

set_env_value() {
  env_file="$1"
  env_key="$2"
  env_temp=$(mktemp "${env_file}.XXXXXX")
  chmod 0600 "$env_temp"
  if [ -f "$env_file" ]; then
    # The value reaches awk through the environment, never through `-v`: these files hold the
    # database password, the data master key and the Web Push private key, and a process
    # argument list is world-readable through /proc/PID/cmdline while the command runs.
    ATHANOR_ENV_VALUE="$3" awk -v key="$env_key" '
      BEGIN { replaced = 0; value = ENVIRON["ATHANOR_ENV_VALUE"] }
      index($0, key "=") == 1 {
        if (!replaced) print key "=" value
        replaced = 1
        next
      }
      { print }
      END { if (!replaced) print key "=" value }
    ' "$env_file" >"$env_temp"
  else
    printf '%s=%s\n' "$env_key" "$3" >"$env_temp"
  fi
  mv "$env_temp" "$env_file"
}

set_env_default() {
  env_file="$1"
  env_key="$2"
  env_value="$3"
  if ! grep -q "^${env_key}=" "$env_file" 2>/dev/null; then
    set_env_value "$env_file" "$env_key" "$env_value"
  fi
}

# A setting an earlier release wrote and nothing reads any more. Left in place it is worse than
# absent: an operator reading the file has no way to tell it from a setting that still works, and
# would change it expecting something to happen.
remove_env_key() {
  env_file="$1"
  env_key="$2"
  [ -f "$env_file" ] || return 0
  grep -q "^${env_key}=" "$env_file" || return 0
  env_temp=$(mktemp "${env_file}.XXXXXX")
  chmod 0600 "$env_temp"
  awk -v key="$env_key" 'index($0, key "=") != 1 { print }' "$env_file" >"$env_temp"
  mv "$env_temp" "$env_file"
}

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "run this installer as root"
  exec sudo -E "$0" "$@"
fi

# What this host is, and what everything athanor needs is called on it. One table, read here and by
# the runner's toolchain probe and by `athanor doctor`, so the three cannot drift apart. The
# variables it sets are assigned by the sourced file, which shellcheck cannot follow through a
# runtime path.
# shellcheck source=scripts/athanor-host.sh
. "$athanor_root/scripts/athanor-host.sh"
athanor_detect_host || fail "this host could not be identified well enough to install onto"
# Every athanor_* below is assigned by athanor_detect_host in the file sourced above; shellcheck
# cannot follow a source through a runtime path, so it is told once here.
# shellcheck disable=SC2154
os_id="$athanor_os_id"
# shellcheck disable=SC2154
architecture="$athanor_arch"
# shellcheck disable=SC2154
host_family="$athanor_family"
# shellcheck disable=SC2154
host_pm="$athanor_pm"
# shellcheck disable=SC2154
host_version="${athanor_os_version:-}"
# Not said by the single-step arm at the bottom of this section, which `run_release_steps` re-enters
# this file through once per step: an update would otherwise print this identification and the
# capability warning below three times over.
if [ "${1:-}" != --release-step ]; then
  say "Installing onto $os_id $host_version ($host_family family, $host_pm, $architecture)"

  # Said before anything is installed rather than discovered at the first document job. A capability
  # with no package here is not a failed install - the toolchain probe reports it and the skills
  # that need it say so - but the owner should hear it from the installer, once, in a list.
  unavailable=$(athanor_missing_for_family "$host_family" | tr '\n' ' ')
  [ -z "$unavailable" ] ||
    warn "this host has no package for: ${unavailable}- those capabilities will be unavailable"
fi

# --- what a release carries, which an update has to deliver too ---------------------------------
#
# WHAT WENT WRONG. `athanor update` ran three named steps - fetch the revision, install
# dependencies, build - plus the runtime files and the database migrations, and nothing else an
# install does. So three things a release carries arrived on the owner's server present and inert,
# measured on it after an update that printed "Update complete" and exited 0.
# CONFINE_AGENT_FILESYSTEM was absent from runner.env, so the Landlock boundary this branch built
# was shipped switched off while `athanor-sandbox check` answered `filesystem=landlock`;
# python3-scipy and statsmodels were in the capability table and not on the disk; and no workspace
# had the `.home` the agent's HOME had moved to, so a workspace where a coding CLI had been signed
# in would come up signed out.
# `athanor doctor` then told the owner "sudo athanor update reinstalls it", which was false.
#
# WHY THE STEPS ARE NOT COPIED INTO scripts/athanor. Two hand-kept lists drift, and this tree has
# both a gate against that shape ("Copied constants") and a case in scripts/test-update.sh that
# watched a file added in one release reach an existing box a release late. So the steps stay in the
# file that owns them and `athanor update` calls this script with `--release-steps`.
#
# WHAT THAT BUYS THAT A COPY DOES NOT, and it is the whole reason for the shape: the installer that
# runs during an update is the one from the revision being installed, because the update pulls
# before it calls this. A step added to a function below therefore lands on an existing box with the
# release that adds it, with no second list to remember and no one-generation lag - which is exactly
# the lag `install_checked_out_runtime_files` in scripts/athanor exists to work around for the
# runtime-file list, and which it can only work around because that list is inside a file the update
# re-executes. Adding a runner.env key outside `release_step_runner_settings` is refused by
# scripts/check-repository.mjs rather than left to be noticed on a server.
#
# WHAT IS DELIBERATELY NOT HERE, because running it again on a box that is serving would break it:
#   - the three system accounts; native policy activation validates a separate candidate before
#     atomically replacing the installed sudoers file;
#   - every generated secret (the runner shared secret, the data master key, the session key, the
#     Web Push pair, the database password) - regenerating one leaves two services holding
#     different halves until both restart, and some of them cannot be regenerated at all without
#     losing the rows they encrypt;
#   - the TLS certificate - issuing has a rate limit at the certificate authority, and enabling
#     HSTS is a decision `athanor certificate enable` makes and an update must not unmake;
#   - the database cluster, initdb, the role and the client-authentication file;
#   - the nginx site and the listen snippet - the update already places the site through
#     install_runtime_files, and the listen form is chosen from the host's nginx version, which an
#     update has no reason to re-decide;
#   - Node itself and the NodeSource repository - a release that needs a newer Node major is a
#     thing an owner should be told about rather than a thing a 3 a.m. timer does to their host;
#   - the managed Chromium, which `athanor update` already fetches by itself.
# A step nobody was sure about stays out. Adding one is a decision, and the comment beside it should
# say why re-running it on a live box is safe.

# The filesystem rung this kernel actually gives, asked of the helper rather than taken from a
# preference.
#
# THREE ANSWERS, NOT TWO. `true` and `false` are measurements; EMPTY means the measurement could not
# be taken at all - no helper on disk, or runuser/sudo refused - and that is not the same statement
# as "this kernel cannot". Writing `false` for it would take a working Landlock boundary off a box
# during an update because a probe failed, silently. An unmeasurable box keeps whatever runner.env
# already says and is warned about instead.
# Not guarded on the helper being on the disk first. The command failing IS the unmeasurable answer,
# and one path through here rather than two is also what lets scripts/test-update.sh drive all three
# outcomes without the drill needing to write into this host's /usr.
measure_agent_filesystem_confinement() {
  agent_filesystem_confinement=""
  sandbox_measurement=$(
    runuser -u "$runner_user" -- sudo -n /usr/local/lib/athanor/athanor-sandbox check 2>&1
  ) || return 0
  case "$sandbox_measurement" in
    *filesystem=landlock*) agent_filesystem_confinement=true ;;
    *) agent_filesystem_confinement=false ;;
  esac
}

# The built-in skill library reaches the model, and its procedures are specific: "run build_deck.py"
# is confident and wrong on a machine without python-pptx. Everything services/workspace-runner's
# DOCUMENT_TOOLCHAIN declares is installed here - and the one binary apt spells differently across
# supported releases is settled immediately after - so a vetted procedure can be followed rather
# than read and abandoned. Carlito and Caladea are the metric-compatible stand-ins for Calibri and
# Cambria, without which an .docx written elsewhere reflows the moment it is opened; Liberation,
# DejaVu and Noto are what a typeset document and a rendered slide actually fall back to, and
# without them LibreOffice substitutes whatever it can find and the page proof measures a layout
# the owner will never see. ocrmypdf brings tesseract and ghostscript with it, which is how a
# scanned PDF becomes readable and how an oversized one is compressed. libreoffice-gtk3 looks
# cosmetic and is not: LibreOffice reaches the accessibility bus only through its gtk3 drawing
# backend, and without that package it falls back to the plain X11 one without saying so, the
# accessibility tree comes back empty, and the agent is left reading a screenshot of a document it
# could otherwise have read the text of.
#
# SAFE TO REPEAT because the table is declarative and every one of the four package managers is
# asked to converge on it rather than to add to it: apt-get install on a package that is present is
# a no-op, and so are the dnf, zypper and pacman spellings in athanor_pm_install. A release that
# adds a row here installs it on every existing box at that release.
release_step_packages() {
  say "Installing native operating-system dependencies"
  # The names come from the host table rather than from a list written here, so the installer, the
  # runner's toolchain probe and `athanor doctor` cannot disagree about what a capability is called.
  # Packages this family does not have are simply absent from the list; the warning above already
  # said which, and the toolchain probe reports the capability as missing rather than the install
  # failing on a name that was never going to resolve.
  athanor_pm_refresh "$host_pm"
  # shellcheck disable=SC2046
  athanor_pm_install "$host_pm" $(athanor_packages_for_family "$host_family")

  # gnupg is the one thing that is not a capability: it dearmors the NodeSource signing key, which
  # is an apt-only step, so it is installed where that step exists and nowhere else.
  case "$host_family" in
  debian) athanor_pm_install "$host_pm" gnupg ;;
  esac
}

# Workspaces that predate the separate agent account are owner-only, so the account that now runs
# commands could not read the home it works in. Everything except .athanor - the browser profile,
# the desktop session and the artifact store, which stay the runner's alone - joins the group.
#
# SAFE TO REPEAT: chgrp and chmod converge, `install -d` on a directory that exists only re-applies
# its mode, and the one move is `mv -n`, so a second run moves nothing.
#
# A BOX WITHOUT THE AGENT ACCOUNT IS LEFT ALONE. Creating accounts is an install-only step and is
# not in this section, so on a server installed before that account existed the `install -d -g`
# below would fail under `set -eu` and take an otherwise good update down with it. It is skipped
# and said out loud instead; re-running the installer is what makes such a box current.
release_step_workspace_layout() {
  if ! id "$agent_user" >/dev/null 2>&1; then
    warn "there is no $agent_user account on this host, so the workspace layout this release expects was not applied; re-run the installer"
    return 0
  fi
  # The one place the workspace root is a variable rather than the literal it is everywhere else in
  # this file, and it is the same override scripts/athanor already carries as ATHANOR_HOME: the
  # migration below moves files, and scripts/test-update.sh has to be able to watch it move them
  # somewhere other than this host's /home. Unset, it is /home/athanor.
  for workspace_directory in "${ATHANOR_WORKSPACE_ROOT:-/home/athanor}"/*/; do
    [ -d "$workspace_directory" ] || continue
    chgrp "$agent_user" "$workspace_directory"
    chmod 2770 "$workspace_directory"
    find "$workspace_directory" -mindepth 1 -maxdepth 1 ! -name .athanor -exec \
      chgrp -R "$agent_user" {} + 2>/dev/null || true
    find "$workspace_directory" -mindepth 1 -maxdepth 1 ! -name .athanor -exec \
      chmod -R g+rwX {} + 2>/dev/null || true
    # The agent's HOME was the workspace root itself and is now `.home` inside it (execution.ts
    # `agentHome`), which is what gives it a Landlock write grant of its own without putting a
    # toolchain's caches inside `workspace/`, where the turn checkpoint would walk and hash them
    # every turn. Everything the old home accumulated is carried across rather than abandoned:
    # without this, a workspace where Codex or Claude Code was signed in comes up signed out after
    # an upgrade, and on a box that then confines the filesystem the old copies at the root are not
    # readable to go and fetch - $ROOT is granted nowhere, only $ROOT/workspace and $ROOT/.home are.
    #
    # ONE old home is carried and only one: the container root, which is where every released
    # version has put HOME. `workspace/.home` is DELIBERATELY LEFT WHERE IT IS, and this is the
    # decision in this block that matters.
    #
    # An intermediate build on this branch put HOME at `workspace/.home`, and carrying that across
    # looks like kindness. It is not: under every version an owner can actually be running,
    # `workspace/.home` is a directory the AGENT can write with no card and no prompt, because
    # `assertUserDataPath` folds a bare `.home/.bashrc` into it and the worker's write
    # classification declines the card on the stated ground that a `.bashrc` there is inert
    # (apps/worker/src/write-classification.ts). Moving that directory into `$ROOT/.home` would make
    # it the real one - the file `agentHome` hands every agent command, and the file the OWNER's own
    # interactive terminal sources, since services/workspace-runner/src/server.ts points its pty at
    # the same HOME. An upgrade would take a write nobody was asked about and promote it into the
    # owner's login shell. That is the exact hole moving HOME to the container root was for.
    #
    # Nothing is lost by leaving it: it stays in `workspace/`, readable and writable by the agent,
    # inside the checkpoint and the snapshot, and visible to the owner in the file browser. A box
    # that ran the intermediate build comes up needing its coding CLIs signed in again, with the old
    # credentials still on disk where a person can look at them and decide. That is the right way
    # round: a re-sign-in is a minute, and a promoted `.bashrc` is not noticed at all.
    #
    # `mv -n` for the move that is made, so nothing is overwritten and a second run moves nothing -
    # this loop runs on every install and every update and must be safe to repeat.
    #
    # `workspace/` gates all of it, as the one test that this directory is a workspace rather than
    # something an operator left under /home/athanor by hand.
    [ -d "$workspace_directory/workspace" ] || continue
    install -d -m 2770 -o "$runner_user" -g "$agent_user" "$workspace_directory/.home"
    # Everything at the root except `workspace`, `.athanor` and `.home` itself, because that is
    # exactly what the ORIGINAL HOME was. What this leaves behind is a root entry whose name the new
    # home already has; it stays at the root, where a confined command cannot read it. Deliberate:
    # litter is cheaper than clobbering a live credential, and the file is still there to be read by
    # the owner's own terminal, which is not confined.
    find "$workspace_directory" -mindepth 1 -maxdepth 1 \
      ! -name .athanor ! -name workspace ! -name .home -exec \
      mv -n {} "$workspace_directory/.home/" \; 2>/dev/null || true
  done
}

# Every runner setting except the shared secret, which is generated and stays with the install.
#
# SAFE TO REPEAT: `set_env_value` replaces one key in place and `set_env_default` writes only when
# the key is absent, so an operator's own MAX_EXECUTION_SECONDS survives and a path this release
# moved does not. CONFINE_AGENT_FILESYSTEM is the one that is measured rather than chosen, and it is
# `set_env_value` for the reason written beside it.
#
# The runner is not restarted here. On an install it has not started yet; on an update the caller
# restarts everything a few steps later, which is the same outage the owner is already paying for.
release_step_runner_settings() {
  runner_env="$athanor_config/runner.env"
  set_env_value "$runner_env" JOB_SUPERVISOR_SOCKET /run/athanor-jobs/control.sock
  set_env_value "$runner_env" RUNNER_HOST 127.0.0.1
  set_env_value "$runner_env" RUNNER_PORT 4300
  set_env_value "$runner_env" WORKSPACE_ROOT /home/athanor
  set_env_value "$runner_env" TAR_EXECUTABLE /usr/bin/tar
  set_env_value "$runner_env" GUI_NAMESPACE_HELPER /usr/local/lib/athanor/athanor-gui
  set_env_value "$runner_env" SNAPSHOT_EXECUTABLE /usr/local/lib/athanor/athanor-snapshot
  set_env_value "$runner_env" DESKTOP_BRIDGE_EXECUTABLE \
    /usr/local/lib/athanor/athanor-desktop-bridge.py
  set_env_value "$runner_env" DESKTOP_SESSION_EXECUTABLE \
    /usr/local/lib/athanor/start-desktop-session.sh
  set_env_value "$runner_env" SYSTEM_PACKAGE_HELPER /usr/local/lib/athanor/athanor-package-helper
  set_env_value "$runner_env" AGENT_SANDBOX_HELPER /usr/local/lib/athanor/athanor-sandbox
  # Written from what `athanor-sandbox check` measured on this kernel, not from a preference.
  # `set_env_value` rather than `set_env_default` on purpose: a box that gains Landlock through a
  # kernel upgrade, or loses it, has this rewritten by the next install or update rather than
  # keeping whatever the first one found. The runner refuses to start if this is on and the helper
  # is unset, so the two keys are written together.
  #
  # An install has already measured this a few hundred lines below, where the drop to the agent
  # account is hard-gated; an update has not, and measures it here.
  [ -n "${agent_filesystem_confinement:-}" ] || measure_agent_filesystem_confinement
  if [ -n "${agent_filesystem_confinement:-}" ]; then
    set_env_value "$runner_env" CONFINE_AGENT_FILESYSTEM "$agent_filesystem_confinement"
  else
    # Left exactly as it was. "Could not ask" is not "cannot confine", and the difference between
    # them is a boundary an owner already has.
    warn "the filesystem boundary could not be measured on this host, so CONFINE_AGENT_FILESYSTEM in $runner_env was left as it stands; sudo athanor doctor reports the rung actually in force"
  fi
  # Publishing a preview points the public internet at a loopback port, so the runner is told every
  # port this installation already serves something private on: the API, the preview gateway, the
  # database, and the worker and notification health endpoints. Its own port is added in code.
  set_env_value "$runner_env" RESERVED_PREVIEW_PORTS 4100,4400,5432,4201,4203,443,8443
  # The transposed spelling this key carried for a while, cleared so an upgraded box does not keep
  # a stale list under a name nothing reads.
  remove_env_key "$runner_env" PREVIEW_RESERVED_PORTS
  set_env_default "$runner_env" MAX_EXECUTION_SECONDS 3600
  set_env_default "$runner_env" MAX_FILE_BYTES 2147483648
  # A command in its own network namespace also has its own loopback, so nothing outside it - the
  # preview proxy included - can reach a port the command is listening on. Turning this on therefore
  # costs published previews, which is why it is off rather than on: with the sandbox helper in
  # place it is now a working setting rather than one that made every command fail.
  set_env_default "$runner_env" ISOLATE_AGENT_NETWORK false
  chmod 0600 "$runner_env"
}

# The steps, named once. The dispatch below validates against this same list, so there is no second
# copy of it to fall behind.
release_steps='release_step_packages release_step_workspace_layout release_step_runner_settings'

# Every step above, for a box that is already installed.
#
# EACH IN A PROCESS OF ITS OWN, and this is the bound that matters. A package mirror that is down at
# three in the morning must not take the two steps after it with it, and the runner settings are the
# step that carries the security boundary. A subshell is not enough and this was measured on this
# tree: `set -e` is ignored for any command that is not the last of an AND-OR list, the suppression
# is inherited by a subshell, and `set -e` written inside that subshell does not re-arm it - so
# `(step) || note_failure` ran a step whose chmod had already failed all the way to its last line
# and called it a success. Re-executing this file gives each step its own errexit and its own exit
# status, which is the only arrangement here that actually stops at the first thing that goes wrong.
run_release_steps() {
  release_steps_failed=""
  for release_step in $release_steps; do
    /bin/sh "$0" --release-step "$release_step" ||
      release_steps_failed="$release_steps_failed $release_step"
  done
  [ -z "$release_steps_failed" ] ||
    fail "these steps this release carries did not finish:$release_steps_failed"
}

# The entry point `athanor update` calls, and the only arguments this script takes.
#
# It exits before the install proper: everything below creates accounts, writes sudoers, generates
# secrets, issues a certificate and initialises a database, and none of that may happen twice on a
# machine that is serving.
case "${1:-}" in
  --release-steps)
    say "Applying what this release carries: packages, workspace layout and runner settings"
    run_release_steps
    exit 0
    ;;
  --release-step)
    # One step, in the process `run_release_steps` gave it. The name is checked against the list
    # above rather than run as given, so this arm can only reach a step that exists.
    case " $release_steps " in
      *" ${2:-} "*) "$2" ;;
      *) fail "there is no release step called '${2:-}'" ;;
    esac
    exit 0
    ;;
  '') ;;
  *) fail "usage: install-native.sh [--release-steps]" ;;
esac


[ -f "$athanor_root/package.json" ] ||
  fail "source checkout not found at $athanor_root (the bootstrap installer should create it)"
chmod 0755 "$athanor_root"

# Everything below this point installs packages, writes system configuration, and builds
# for several minutes. A host that cannot finish should be told now, not half-way through.
say "Checking that this computer can run athanor"
memory_kilobytes=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf 0)
swap_kilobytes=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf 0)
case "$memory_kilobytes" in
  ''|*[!0-9]*) fail "the amount of memory on this host could not be read from /proc/meminfo" ;;
esac
case "$swap_kilobytes" in
  ''|*[!0-9]*) swap_kilobytes=0 ;;
esac
[ "$memory_kilobytes" -ge 1900000 ] ||
  fail "athanor needs about 2 GB of RAM; this host has $((memory_kilobytes / 1024)) MB"
if [ "$memory_kilobytes" -lt 3800000 ] && [ "$swap_kilobytes" -lt 1900000 ]; then
  warn "$((memory_kilobytes / 1024)) MB of RAM and no meaningful swap: the build and the browser will be tight, add swap or use a 4 GB host"
fi

for measured_path in "$athanor_root" /var /home; do
  free_kilobytes=$(df -Pk "$measured_path" 2>/dev/null | awk 'NR == 2 {print $4}')
  case "$free_kilobytes" in
    ''|*[!0-9]*) continue ;;
  esac
  [ "$free_kilobytes" -ge 15728640 ] ||
    fail "$measured_path has $((free_kilobytes / 1048576)) GiB free; athanor needs at least 15 GiB for packages, the managed browser, and the database"
  [ "$free_kilobytes" -ge 26214400 ] ||
    warn "$measured_path has $((free_kilobytes / 1048576)) GiB free; workspaces and backups are comfortable from 25 GiB"
done

export DEBIAN_FRONTEND=noninteractive
# The same step an update runs, defined once above with what each package is for.
release_step_packages

# ImageMagick 7 is one `magick` command. ImageMagick 6 - which is what the `imagemagick` package
# resolves to on Debian 12 and on Ubuntu 22.04 and 24.04 - provides convert, identify and mogrify
# and no `magick` at all. Everything else in athanor names `magick`: the runner probes it for the
# image-work capability the model is shown before it plans, `athanor doctor` checks it, and the
# media-creation and pdf-assembly skills run it directly. Absorbing the difference here, once, is
# what lets all of those keep one spelling instead of carrying a branch the agent has to reason
# about halfway through a job.
if ! command -v magick >/dev/null 2>&1; then
  command -v convert >/dev/null 2>&1 ||
    fail "the imagemagick package provided neither magick nor convert on this host"
  install_asset 0755 "$athanor_root/scripts/athanor-magick" /usr/local/bin/magick
fi

# The one Node major athanor is built and tested on, named once so the repository, the apt source
# and the check below cannot drift apart. It matches the version the verification workflow runs, and
# that is the whole point: a box used to be brought up on whatever the host already had as long as
# it was 20 or newer, and otherwise on 22, so the runtime every owner actually ran was the one
# nothing had ever been tested against. Native addons are covered - the terminal's prebuilt binaries
# carry this ABI for both supported architectures - so there is nothing to compile here either.
node_required_major=24

node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')
if [ "$node_major" -lt "$node_required_major" ] && [ "$host_family" != "debian" ]; then
  # Every other family ships a current Node in its own repositories, which is both simpler and one
  # fewer third-party source on the box. The apt route below exists because Debian and Ubuntu do
  # not: their nodejs is too old on every release athanor supports.
  say "Installing the supported Node.js runtime from this host's own packages"
  case "$host_family" in
  rhel) athanor_pm_install "$host_pm" "nodejs$node_required_major" || athanor_pm_install "$host_pm" nodejs ;;
  arch) athanor_pm_install "$host_pm" nodejs npm ;;
  suse) athanor_pm_install "$host_pm" "nodejs$node_required_major" npm || athanor_pm_install "$host_pm" nodejs npm ;;
  esac
  node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')
fi
if [ "$node_major" -lt "$node_required_major" ] && [ "$host_family" = "debian" ]; then
  say "Installing the supported Node.js runtime (Node $node_required_major)"
  key_temp=$(mktemp)
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_temp"
  gpg --dearmor --yes --output /usr/share/keyrings/nodesource.gpg "$key_temp"
  rm -f "$key_temp"
  chmod 0644 /usr/share/keyrings/nodesource.gpg
  cat >/etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_$node_required_major.x
Suites: nodistro
Components: main
Architectures: $architecture
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
  cat >/etc/apt/preferences.d/nodejs <<'EOF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
  apt-get update
  apt-get install -y nodejs
fi

# npm comes with whichever nodejs won above - NodeSource bundles its own, and from Ubuntu 26.04 the
# distribution's npm package Conflicts with it, so asking apt for both ends the install rather than
# resolving. It is used once, to place pnpm.
command -v npm >/dev/null 2>&1 || fail "npm did not arrive with Node.js"
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$node_major" -ge "$node_required_major" ] ||
  fail "Node.js $node_required_major or newer could not be installed"
npm install --global "pnpm@11.9.0"

# Typesetting, for the documents people actually want out of this: a CV, a one-pager, a report.
# The office toolchain above can produce a PDF, but only by converting a word-processor file, which
# gives up control of pagination - the thing that decides whether a CV is one page or two. typst is
# a single static binary with no runtime dependencies, and it is not packaged for Debian or Ubuntu,
# so it is pinned by version and by the hash of the exact archive, the same way the ACME client is.
typst_version="0.15.1"
typst_sha256_amd64="a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c"
typst_sha256_arm64="5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee"
if [ -x /usr/local/bin/typst ] &&
  /usr/local/bin/typst --version 2>/dev/null | grep -q "typst $typst_version"; then
  say "Typesetting engine already installed (typst $typst_version)"
else
  case "$architecture" in
    amd64) typst_target="x86_64-unknown-linux-musl"; typst_expected="$typst_sha256_amd64" ;;
    arm64) typst_target="aarch64-unknown-linux-musl"; typst_expected="$typst_sha256_arm64" ;;
    *) fail "no typst build for $architecture" ;;
  esac
  say "Installing the typesetting engine (typst $typst_version)"
  typst_dir=$(mktemp -d)
  typst_archive="$typst_dir/typst.tar.xz"
  curl -fsSL --retry 3 --retry-delay 2 -o "$typst_archive" \
    "https://github.com/typst/typst/releases/download/v${typst_version}/typst-${typst_target}.tar.xz" ||
    fail "could not download typst $typst_version"
  typst_observed=$(sha256sum "$typst_archive" | awk '{print $1}')
  if [ "$typst_observed" != "$typst_expected" ]; then
    rm -rf "$typst_dir"
    fail "typst archive did not match its expected checksum"
  fi
  tar -xJf "$typst_archive" -C "$typst_dir"
  install -m 0755 "$typst_dir/typst-${typst_target}/typst" /usr/local/bin/typst
  rm -rf "$typst_dir"
  /usr/local/bin/typst --version >/dev/null || fail "typst did not run after installation"
fi

/bin/sh "$athanor_root/scripts/athanor-native-runtime" tools

if ! id "$runner_user" >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/athanor --shell /bin/bash "$runner_user"
fi
if ! id "$agent_user" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$agent_user"
fi
# The runner joins the agent's group so it can read back what a command wrote and replace it.
# The agent account is deliberately not a member of the runner's group: that direction would
# hand it the runner's own files.
usermod -a -G "$agent_user" "$runner_user"
if ! id "$control_user" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/athanor-control \
    --shell /usr/sbin/nologin "$control_user"
fi
# Traverse only, and set-group-ID so every workspace created below inherits the shared group
# without the runner needing a privilege it does not have. Nothing here is listable: the agent
# account reaches its own workspace by name and cannot enumerate the others.
install -d -m 2710 -o "$runner_user" -g "$agent_user" /home/athanor
install -d -m 0700 -o "$control_user" -g "$control_user" /var/lib/athanor-control
install -d -m 0755 "$athanor_state" "$athanor_state/acme" "$athanor_config" "$athanor_config/tls"
# Home for the relay identity key and the relay settings, created empty and left empty: nothing is
# written here, and nothing dials anywhere, until an owner enrolls with a relay of their own. It
# sits under the configuration directory so it survives an update and travels in the backup - the
# identity key is this computer's address on that relay, and replacing it would change the hostname
# every paired client holds. Only the control account can read it.
install -d -m 0700 -o "$control_user" -g "$control_user" "$athanor_config/relay"
install -d -m 0755 /usr/local/lib/athanor

# The same step an update runs, defined once above with what the `.home` move does and does not
# carry across.
release_step_workspace_layout

say "Building athanor"
cd "$athanor_root"
# CI=true because this runs without a terminal. When an upgrade removes a workspace package, pnpm
# decides the modules directory has to be rebuilt and stops to ask permission first; with nothing
# to answer it, the install aborts on ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY and the box is left
# on the previous release. An installer is a non-interactive context and should say so.
CI=true pnpm install --frozen-lockfile
CI=true pnpm -r build
/bin/sh "$athanor_root/scripts/athanor-native-runtime" language-servers

playwright_cli="$athanor_root/services/workspace-runner/node_modules/playwright-core/cli.js"
playwright_package="$athanor_root/services/workspace-runner/node_modules/playwright-core/package.json"
[ -f "$playwright_cli" ] && [ -f "$playwright_package" ] ||
  fail "the pinned Playwright dependency was not installed"
playwright_version=$(
  node -e 'process.stdout.write(require(process.argv[1]).version)' "$playwright_package"
)
say "Installing the managed Chromium dependency (Playwright $playwright_version)"
# Playwright implements install-deps for Debian and Ubuntu and exits non-zero everywhere else, which
# under `set -e` ended the install with an error about a browser rather than about the host. On the
# other families the shared libraries Chromium needs come from the packages the table already
# installed, and a browser that will not start is caught immediately below by the launch probe -
# which is the honest place to find out, because it tests the thing rather than its dependencies.
case "$host_family" in
debian) node "$playwright_cli" install-deps chromium ;;
*) say "Playwright's dependency installer is Debian-only; relying on this host's own packages" ;;
esac
runuser -u "$runner_user" -- env \
  HOME=/home/athanor \
  node "$playwright_cli" install chromium

# Let that Chromium build its own renderer sandbox. Ubuntu refuses unprivileged user namespaces
# under AppArmor from 23.10, and the profiles it ships cover its own packaged browsers rather than
# the one athanor manages. A host that denies the sandbox cannot start the browser. Skipped
# rather than fatal where AppArmor is absent, because a
# Debian box without it has nothing to refuse in the first place.
if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
  install_asset 0644 "$athanor_root/infra/native/athanor-chromium.apparmor" \
    /etc/apparmor.d/athanor-chromium
  apparmor_parser -r /etc/apparmor.d/athanor-chromium 2>/dev/null ||
    warn "the Chromium AppArmor profile did not load; browser startup requires its renderer sandbox. Load the profile and run garden doctor before using the browser."
fi

# SELinux, which the RHEL family enforces by default and which nothing here used to mention at all.
#
# The failure it produces is the worst kind: the install completes, every service starts, and then
# nginx answers 403 for the whole application - because SELinux forbids httpd_t from opening a
# network connection unless one boolean says otherwise, and the athanor API is a loopback port
# behind that proxy. An owner would read "ready", open the address, and get a permission error with
# nothing in any athanor log to explain it.
#
# Three settings, all of them narrow, and each one skipped rather than fatal where the tool for it
# is absent. Nothing here disables SELinux or drops the box to permissive: a self-hosted agent
# computer turning off the host's mandatory access control to make itself work would be trading the
# owner's security for the installer's convenience.
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" != "Disabled" ]; then
  say "Adjusting SELinux for the reverse proxy and the private database"
  # Without this every request through nginx is refused, which is the whole product.
  if command -v setsebool >/dev/null 2>&1; then
    setsebool -P httpd_can_network_connect 1 2>/dev/null ||
      warn "SELinux still forbids nginx from reaching the athanor API; the site will answer 403 until httpd_can_network_connect is on"
  else
    warn "SELinux is enforcing but setsebool is missing (policycoreutils); nginx will answer 403"
  fi
  # The workspaces live under /home, which SELinux labels as user content rather than as something
  # a service may write. Relabelled so the runner can own its own tree.
  if command -v semanage >/dev/null 2>&1 && command -v restorecon >/dev/null 2>&1; then
    semanage fcontext -a -t var_lib_t "/home/${runner_user}(/.*)?" 2>/dev/null ||
      semanage fcontext -m -t var_lib_t "/home/${runner_user}(/.*)?" 2>/dev/null || true
    restorecon -R "/home/${runner_user}" 2>/dev/null ||
      warn "the workspace tree could not be relabelled for SELinux; the runner may be denied writes"
  else
    warn "SELinux is enforcing but semanage or restorecon is missing (policycoreutils-python-utils); the workspace tree is unlabelled"
  fi
fi

install_asset 0755 "$athanor_root/scripts/athanor" /usr/local/bin/athanor
install_asset 0755 "$athanor_root/scripts/athanor" /usr/local/bin/garden
install_asset 0755 "$athanor_root/scripts/reproducible-run.py" /usr/local/bin/garden-run
# Outside every directory on the agent's PATH, and not executable by the agent's account. On
# /usr/local/bin it was a root package install with no capability scope and no approval card, one
# command name away from anything running on this box.
rm -f /usr/local/bin/athanor-package-helper
install -m 0750 -o root -g "$runner_user" "$athanor_root/scripts/athanor-package-helper" \
  /usr/local/lib/athanor/athanor-package-helper
install_asset 0755 "$athanor_root/scripts/athanor-system-packages" \
  /usr/local/sbin/athanor-system-packages
# Root-owned and reached only through the sudoers rule below. It hands back less privilege than
# the runner already has, which is why it may take a command line the agent influenced.
install_asset 0644 "$athanor_root/scripts/mission-supervisor.py" /usr/local/lib/athanor/mission-supervisor.py
install_asset 0755 "$athanor_root/scripts/athanor-sandbox" \
  /usr/local/lib/athanor/athanor-sandbox
install_asset 0755 "$athanor_root/scripts/athanor-service" \
  /usr/local/lib/athanor/athanor-service
install_asset 0755 "$athanor_root/scripts/athanor-network-refresh" \
  /usr/local/lib/athanor/athanor-network-refresh
install_asset 0755 "$athanor_root/scripts/athanor-network-watch" \
  /usr/local/lib/athanor/athanor-network-watch
install_asset 0755 "$athanor_root/scripts/athanor-document" \
  /usr/local/lib/athanor/athanor-document
# On the agent's own PATH, unlike the helpers above, because these two are what the skill library
# tells the agent to run. Neither holds any privilege the agent does not already have; they exist
# so that "convert this to PDF" is one command with one behaviour instead of a LibreOffice
# invocation the agent has to reassemble, and get subtly wrong, on every job.
install_asset 0755 "$athanor_root/scripts/athanor-office-convert" \
  /usr/local/bin/athanor-office-convert
install_asset 0755 "$athanor_root/scripts/athanor-pdf-tables" /usr/local/bin/athanor-pdf-tables
install_asset 0755 "$athanor_root/scripts/athanor-document-proof" \
  /usr/local/lib/athanor/athanor-document-proof
install_asset 0755 "$athanor_root/scripts/athanor-gui" \
  /usr/local/lib/athanor/athanor-gui
install_asset 0755 "$athanor_root/scripts/athanor-gui-broker" \
  /usr/local/lib/athanor/athanor-gui-broker
install_asset 0755 "$athanor_root/scripts/athanor-snapshot" \
  /usr/local/lib/athanor/athanor-snapshot
install_asset 0755 "$athanor_root/infra/native/start-desktop-session.sh" \
  /usr/local/lib/athanor/start-desktop-session.sh
install_asset 0755 "$athanor_root/infra/native/athanor-desktop-bridge.py" \
  /usr/local/lib/athanor/athanor-desktop-bridge.py
install_asset 0644 "$athanor_root/infra/native/athanor@.service" \
  /etc/systemd/system/athanor@.service
install_asset 0644 "$athanor_root/infra/native/athanor-jobs.service" /etc/systemd/system/athanor-jobs.service
install_asset 0644 "$athanor_root/infra/native/athanor-gui.service" /etc/systemd/system/athanor-gui.service
install_asset 0644 "$athanor_root/infra/native/athanor-work.slice" /etc/systemd/system/athanor-work.slice
install_asset 0644 "$athanor_root/infra/native/athanor-runner.service" \
  /etc/systemd/system/athanor-runner.service
install_asset 0644 "$athanor_root/infra/native/athanor.target" \
  /etc/systemd/system/athanor.target
install_asset 0644 "$athanor_root/infra/native/athanor-network-refresh.service" \
  /etc/systemd/system/athanor-network-refresh.service
install_asset 0644 "$athanor_root/infra/native/athanor-network-refresh.timer" \
  /etc/systemd/system/athanor-network-refresh.timer
# Watches the relay setting, so switching the relay off stops this computer advertising the relay
# address in the same moment rather than six hours later.
install_asset 0644 "$athanor_root/infra/native/athanor-network-refresh.path" \
  /etc/systemd/system/athanor-network-refresh.path
install_asset 0644 "$athanor_root/infra/native/athanor-network-watch.service" \
  /etc/systemd/system/athanor-network-watch.service
# Installed, deliberately not enabled: unattended updates are opt-in through
# `sudo athanor auto-update on`.
install_asset 0644 "$athanor_root/infra/native/athanor-auto-update.service" \
  /etc/systemd/system/athanor-auto-update.service
install_asset 0644 "$athanor_root/infra/native/athanor-auto-update.timer" \
  /etc/systemd/system/athanor-auto-update.timer
# Installed and deliberately not enabled. OnFailure= on the update unit above starts it, and it is
# the only thing that can report a 3 a.m. update that was killed partway - the unit exits into a
# journal nobody reads, the rollback leaves a perfectly healthy server, and the box stops moving.
install_asset 0644 "$athanor_root/infra/native/athanor-auto-update-alert.service" \
  /etc/systemd/system/athanor-auto-update-alert.service
# Installed and enabled, unlike the update timer above: an unattended update is a change the owner
# should opt into, and a backup is the thing that makes every other risk survivable. A server left
# alone for a year previously had no copy of its conversations, files, connector credentials or
# keys, because the only paths that ever called the backup were the operator's own command and the
# update.
install_asset 0644 "$athanor_root/infra/native/athanor-backup.service" \
  /etc/systemd/system/athanor-backup.service
install_asset 0644 "$athanor_root/infra/native/athanor-backup.timer" \
  /etc/systemd/system/athanor-backup.timer
# Never enabled: started only by OnFailure= when a backup run is stopped before it can write down
# why, so the settings screen says what happened instead of standing by its daily promise.
install_asset 0644 "$athanor_root/infra/native/athanor-backup-alert.service" \
  /etc/systemd/system/athanor-backup-alert.service
install_asset 0755 "$athanor_root/scripts/athanor-certificate" \
  /usr/local/lib/athanor/athanor-certificate
# The network refresh runs this on every netlink address event, by absolute path.
install_asset 0755 "$athanor_root/scripts/athanor-ddns" \
  /usr/local/lib/athanor/athanor-ddns
# Installed, deliberately not enabled: `athanor certificate enable` turns the timer on once the
# operator has accepted the certificate authority's subscriber agreement. Without the timer a
# publicly trusted certificate would simply expire after 90 days.
install_asset 0644 "$athanor_root/infra/native/athanor-certificate-renew.service" \
  /etc/systemd/system/athanor-certificate-renew.service
install_asset 0644 "$athanor_root/infra/native/athanor-certificate-renew.timer" \
  /etc/systemd/system/athanor-certificate-renew.timer
# Never enabled: started only by OnFailure= when a renewal fails, so the owner learns about it
# from `athanor doctor` and the login banner rather than from a browser refusing to connect.
install_asset 0644 "$athanor_root/infra/native/athanor-certificate-alert.service" \
  /etc/systemd/system/athanor-certificate-alert.service
# Silent unless something is wrong. An owner whose certificate expired cannot reach the interface
# to be told, so the message has to be waiting where they will go instead.
install -d -m 0755 /etc/update-motd.d
install_asset 0755 "$athanor_root/infra/native/athanor-motd" \
  /etc/update-motd.d/99-athanor

/bin/sh "$athanor_root/scripts/athanor-native-runtime" policy

# A box must never come up believing it confines agent commands when it does not, so this is a
# hard gate rather than a warning: if the drop to the agent account does not take effect, the
# install stops here instead of quietly running every command as the runner.
say "Checking that agent commands are confined to their own account"
sandbox_report=$(
  runuser -u "$runner_user" -- sudo -n /usr/local/lib/athanor/athanor-sandbox check 2>&1
) || fail "the agent sandbox helper could not run: $sandbox_report"
case "$sandbox_report" in
  *"user=$agent_user"*) ;;
  *) fail "agent commands would run as $runner_user, not $agent_user: $sandbox_report" ;;
esac
case "$sandbox_report" in
  *network-isolation=yes*) ;;
  *) warn "this kernel refused a network namespace, so ISOLATE_AGENT_NETWORK cannot be turned on" ;;
esac
# The filesystem rung, warned on rather than hard-gated, and the difference from the check above is
# the difference between the two boundaries. A box that cannot drop to the agent account is a box
# where every command runs as the runner, which is not something to come up believing; a box that
# cannot apply a Landlock ruleset still confines every command to the agent account and to the
# network policy, and refusing to install there would take the whole computer away over the newest
# of its three boundaries. So it is measured here, said out loud, and written into runner.env below
# - which is what stops the runner asking for a ruleset the kernel would reject and turning every
# command into exit 125.
case "$sandbox_report" in
  *filesystem=landlock*) agent_filesystem_confinement=true ;;
  *)
    agent_filesystem_confinement=false
    warn "this kernel or util-linux cannot apply a Landlock ruleset, so agent commands will run\
 with the identity boundary only and can read and write every workspace on this box"
    ;;
esac

say "Preparing the private database"
# Debian's postgresql metapackage initialises a cluster on install; everywhere else the package is a
# bare server and starting it without initdb leaves a database that never comes up, after an install
# that reported success.
athanor_postgres_prepare "$host_family"
systemctl enable --now postgresql
# Reused from the file when the box already has one. The capture group was written `\\(` inside
# single quotes, which is a literal backslash followed by a literal parenthesis, so it never matched
# anything and every re-install invented a new password - the one secret on this box that was not
# reused, under a deployment document promising that all of them are. The same extraction is spelled
# with single backslashes in the restore path, which is what showed this was a typo and not an
# idiom.
database_password=$(existing_control_value DATABASE_URL |
  sed -n 's|^postgres://athanor:\([^@]*\)@.*|\1|p')
[ -n "$database_password" ] || database_password=$(openssl rand -hex 32)
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v password="$database_password" <<'SQL'
SELECT format('CREATE ROLE athanor LOGIN PASSWORD %L', :'password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'athanor')\gexec
SELECT format('ALTER ROLE athanor WITH LOGIN PASSWORD %L', :'password')\gexec
SELECT 'CREATE DATABASE athanor OWNER athanor'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'athanor')\gexec
SQL
# Written down the instant the role holds it, and not three hundred lines later with a dozen `fail`
# points in between. `doctor` sends the owner back through this installer for two ordinary
# conditions, and any abort inside that window left the role holding a password nothing on the box
# knew: the API, worker, registry and notifier all fail authentication on their next restart, and a
# previously working server is down with no repair but another full run. control.env is the file
# every one of those services reads, so it learns the password in the same breath the role does.
control_env="$athanor_config/control.env"
set_env_value "$control_env" DATABASE_URL \
  "postgres://athanor:$database_password@127.0.0.1:5432/athanor"

# Stock Debian and Ubuntu ship `local all all peer`, which maps a Unix account to the same-named
# database role. The agent computer runs on this host under an account of its own, and the
# database role is called athanor as well, so without this a command could open the database as
# the owner of every encrypted row - and one INSERT into sessions is a signed-in owner reachable
# from the internet. The password in root-owned control.env becomes the only way in.
say "Restricting the database to the password in root-owned configuration"
hba_file=$(runuser -u postgres -- psql -Atqc 'SHOW hba_file' 2>/dev/null || printf '')
[ -n "$hba_file" ] && [ -f "$hba_file" ] ||
  fail "the PostgreSQL client authentication file could not be located"
hba_begin="# BEGIN athanor - managed by the installer, edits here are replaced"
hba_end="# END athanor"
hba_temp=$(mktemp)
{
  printf '%s\n' "$hba_begin"
  printf '%s\n' "local   all             athanor                                 reject"
  printf '%s\n' "host    all             athanor         127.0.0.1/32            scram-sha-256"
  printf '%s\n' "host    all             athanor         ::1/128                 scram-sha-256"
  printf '%s\n' "$hba_end"
  awk -v begin="$hba_begin" -v end="$hba_end" '
    $0 == begin { inside = 1; next }
    $0 == end { inside = 0; next }
    !inside { print }
  ' "$hba_file"
} >"$hba_temp"
chown --reference="$hba_file" "$hba_temp"
chmod --reference="$hba_file" "$hba_temp"
mv "$hba_temp" "$hba_file"
systemctl reload postgresql

if command -v psql >/dev/null 2>&1; then
  if runuser -u "$agent_user" -- psql -h /var/run/postgresql -U athanor -d athanor \
    -c 'SELECT 1' >/dev/null 2>&1; then
    fail "the agent account can still authenticate to PostgreSQL over the local socket"
  fi
  if runuser -u "$runner_user" -- psql -h /var/run/postgresql -U athanor -d athanor \
    -c 'SELECT 1' >/dev/null 2>&1; then
    fail "the runner account can still authenticate to PostgreSQL over the local socket"
  fi
else
  warn "psql is not installed, so the database socket restriction could not be verified"
fi

say "Discovering this computer's connection addresses"
ipv4_addresses=$(
  ip -o -4 address show scope global |
    awk '$2 !~ /^(docker|br-|veth|cni|podman|virbr)/ {
      address = $4
      sub(/\/.*/, "", address)
      print address
    }' |
    sort -u
)
ipv6_addresses=$(
  ip -o -6 address show scope global -temporary |
    awk '$2 !~ /^(docker|br-|veth|cni|podman|virbr)/ {
      address = $4
      sub(/\/.*/, "", address)
      print address
    }' |
    sort -u
)

candidate_hostname=""
for possible_name in "$(hostname -f 2>/dev/null || true)" "$(hostname 2>/dev/null || true)"; do
  case "$possible_name" in
    ""|localhost|localhost.localdomain|*.*.*.*) continue ;;
  esac
  case "$possible_name" in
    *.*) ;;
    *) continue ;;
  esac
  resolved_addresses=$(getent ahosts "$possible_name" 2>/dev/null | awk '{print $1}' | sort -u || true)
  matched=false
  for local_address in $ipv4_addresses $ipv6_addresses; do
    if printf '%s\n' "$resolved_addresses" | grep -Fqx "$local_address"; then
      matched=true
      break
    fi
  done
  if [ "$matched" = true ]; then
    candidate_hostname="$possible_name"
    break
  fi
done
if [ -z "$candidate_hostname" ]; then
  for public_address in $ipv4_addresses $ipv6_addresses; do
    reverse_name=$(
      getent hosts "$public_address" 2>/dev/null |
        awk 'NR == 1 {print $2}' |
        sed 's/\.$//' || true
    )
    case "$reverse_name" in
      ""|localhost|localhost.localdomain|*.*.*.*) continue ;;
    esac
    case "$reverse_name" in
      *.*) ;;
      *) continue ;;
    esac
    if getent ahosts "$reverse_name" 2>/dev/null |
      awk '{print $1}' |
      grep -Fqx "$public_address"; then
      candidate_hostname="$reverse_name"
      break
    fi
  done
fi

# A name the owner has already pointed at this computer.
#
# Most servers need nothing here: the loops above find the name the provider gave the machine, which
# is why a rented server usually arrives with one already. What had no way of being said was "this
# address is static and I have put a domain in front of it" - an A record is all such a server needs,
# and dynamic DNS, which exists to chase an address that moves, is the wrong tool for it entirely.
# Without this the install finished, the browser then refused to make a passkey, and the way out was
# a second SSH session.
if [ -n "${ATHANOR_HOSTNAME:-}" ]; then
  requested_name=$(printf '%s' "$ATHANOR_HOSTNAME" | tr 'A-Z' 'a-z' | sed 's/\.$//')
  case "$requested_name" in
    *.*) ;;
    *) fail "ATHANOR_HOSTNAME must be a domain name with at least two labels, not '$ATHANOR_HOSTNAME'" ;;
  esac
  case "$requested_name" in
    *[!a-z0-9.-]*|-*|*-|.*|*.) fail "ATHANOR_HOSTNAME is not a valid domain name: '$ATHANOR_HOSTNAME'" ;;
  esac
  # Warned rather than refused: a record added minutes ago may not have reached this resolver yet,
  # and refusing would send the owner back to a shell, which is the thing being removed.
  if ! getent ahosts "$requested_name" >/dev/null 2>&1; then
    warn "$requested_name does not resolve from this computer yet; continuing, but clients cannot reach it until the DNS record is live"
  fi
  candidate_hostname="$requested_name"
fi

primary_host=""
if [ -n "$candidate_hostname" ]; then
  primary_host="$candidate_hostname"
else
  for address in $ipv4_addresses; do
    case "$address" in
      10.*|127.*|169.254.*|192.168.*) ;;
      172.*)
        second_octet=$(printf '%s' "$address" | cut -d. -f2)
        if [ "$second_octet" -lt 16 ] || [ "$second_octet" -gt 31 ]; then
          primary_host="$address"
          break
        fi
        ;;
      *)
        primary_host="$address"
        break
        ;;
    esac
  done
fi
if [ -z "$primary_host" ]; then
  primary_host=$(
    printf '%s\n' "$ipv6_addresses" "$ipv4_addresses" |
      sed -n '/./{p;q;}'
  )
fi
[ -n "$primary_host" ] || fail "no usable network address was detected"

case "$primary_host" in
  *:*)
    public_url="https://[$primary_host]"
    webauthn_rp_id="[$primary_host]"
    ;;
  *)
    public_url="https://$primary_host"
    webauthn_rp_id="$primary_host"
    ;;
esac
existing_public_url=$(existing_control_value PUBLIC_APP_URL)
if [ -n "$existing_public_url" ]; then
  canonical_existing_url=$(
    node -e '
      const { isIP } = require("node:net");
      try {
        const url = new URL(process.argv[1]);
        const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
        if (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          (!url.port || url.port === "443") &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash &&
          !isIP(host)
        ) {
          process.stdout.write(url.origin);
        }
      } catch {}
    ' "$existing_public_url"
  )
  if [ -n "$canonical_existing_url" ]; then
    public_url="$canonical_existing_url"
    webauthn_rp_id=$(
      node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$public_url"
    )
  fi
fi
runner_public_url=$(printf '%s/runner' "$public_url" | sed 's/^https:/wss:/')

say "Preparing the server identity and owner connection ticket"
identity_key="$athanor_config/tls/server.key"
if [ ! -f "$identity_key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$identity_key"
  chmod 0600 "$identity_key"
fi

server_identity=$(
  openssl pkey -in "$identity_key" -pubout 2>/dev/null |
    openssl pkey -pubin -outform DER 2>/dev/null |
    openssl dgst -sha256 -binary |
    openssl base64 -A
)
pairing_code=$(existing_control_value REGISTRATION_BOOTSTRAP_TOKEN)
pairing_expires=$(existing_control_value REGISTRATION_BOOTSTRAP_EXPIRES_AT)
current_epoch=$(date +%s)
case "$pairing_expires" in
  ''|*[!0-9]*) pairing_expires=0 ;;
esac
if [ -z "$pairing_code" ] || [ "$pairing_expires" -le "$current_epoch" ]; then
  pairing_code=$(openssl rand -hex 16)
  pairing_expires=$((current_epoch + 86400))
fi
data_master_key=$(existing_control_value DATA_MASTER_KEY)
[ -n "$data_master_key" ] || data_master_key=$(openssl rand -base64 32 | tr -d '\n')
session_signing_key=$(existing_control_value SESSION_SIGNING_KEY)
[ -n "$session_signing_key" ] || session_signing_key=$(openssl rand -hex 32)
runner_shared_secret=$(existing_control_value RUNNER_SHARED_SECRET)
[ -n "$runner_shared_secret" ] || runner_shared_secret=$(openssl rand -hex 32)
push_public_key=$(existing_control_value PUSH_VAPID_PUBLIC_KEY)
push_private_key=$(existing_control_value PUSH_VAPID_PRIVATE_KEY)
if [ -z "$push_public_key" ] || [ -z "$push_private_key" ]; then
  # Rotating this pair invalidates every browser subscription, so it is generated once and
  # then reused from the existing configuration on every later run of this installer.
  push_key_pair=$(
    node -e '
      const { generateVAPIDKeys } = require(process.argv[1]);
      const keys = generateVAPIDKeys();
      process.stdout.write(`${keys.publicKey} ${keys.privateKey}`);
    ' "$athanor_root/services/notifications/node_modules/web-push"
  ) || fail "the Web Push signing keys could not be generated"
  push_public_key=${push_key_pair%% *}
  push_private_key=${push_key_pair##* }
fi
[ -n "$push_public_key" ] && [ -n "$push_private_key" ] ||
  fail "the Web Push signing keys could not be generated"

set_env_value "$control_env" DEPLOYMENT_MODE production
set_env_value "$control_env" REGISTRATION_BOOTSTRAP_TOKEN "$pairing_code"
set_env_value "$control_env" REGISTRATION_BOOTSTRAP_EXPIRES_AT "$pairing_expires"
previous_public_url=$(existing_control_value PUBLIC_APP_URL)
previous_preview_url=$(existing_control_value PREVIEW_BASE_URL)
set_env_value "$control_env" PUBLIC_APP_URL "$public_url"
# Where this build came from, so the app can offer it.
#
# The licence row in Settings says the source is always available and links it when the server knows
# a URL - and nothing ever wrote one, so the link never appeared under a sentence promising it. The
# clone origin is the honest answer and the installer has had it all along. An https URL only: a
# local path or an ssh remote is not something a browser can open.
source_origin=$(git -C "$athanor_root" remote get-url origin 2>/dev/null || true)
case "$source_origin" in
  https://*)
    set_env_value "$control_env" PUBLIC_SOURCE_URL "${source_origin%.git}"
    ;;
esac
case "$previous_preview_url" in
  ''|"$previous_public_url/__athanor/preview"|"$previous_public_url:8443/__athanor/preview")
    set_env_value "$control_env" PREVIEW_BASE_URL "$public_url/__athanor/preview"
    ;;
esac
set_env_value "$control_env" API_HOST 127.0.0.1
set_env_value "$control_env" API_PORT 4100
set_env_value "$control_env" PREVIEW_GATEWAY_HOST 127.0.0.1
set_env_value "$control_env" PREVIEW_GATEWAY_PORT 4400
set_env_value "$control_env" DATABASE_DRIVER postgres
# DATABASE_URL is not written here: it goes down beside the ALTER ROLE that sets it, so the file and
# the role cannot disagree across the failures that sit between the two points.
set_env_value "$control_env" DATA_MASTER_KEY "$data_master_key"
set_env_value "$control_env" SESSION_SIGNING_KEY "$session_signing_key"
set_env_value "$control_env" RUNNER_SHARED_SECRET "$runner_shared_secret"
set_env_value "$control_env" WORKSPACE_RUNNER_URL http://127.0.0.1:4300
set_env_value "$control_env" PUBLIC_RUNNER_URL "$runner_public_url"
set_env_value "$control_env" WORKSPACE_IMAGE_REVISION native-host
set_env_value "$control_env" RELAY_STATE_DIR "$athanor_config/relay"
# A relayed connection is delivered to this computer's own listeners: TLS terminates here, at
# nginx, which is why a relay operator can only ever see byte counts and connection metadata.
set_env_value "$control_env" RELAY_LOCAL_HOST 127.0.0.1
set_env_value "$control_env" RELAY_LOCAL_PORT 443
set_env_value "$control_env" RELAY_LOCAL_HTTP_PORT 80
set_env_default "$control_env" RELAY_LOCAL_PREVIEW_PORT 8443
set_env_value "$control_env" WEBAUTHN_RP_ID "$webauthn_rp_id"
set_env_value "$control_env" WEBAUTHN_RP_NAME athanor
set_env_value "$control_env" WEBAUTHN_ORIGIN "$public_url"
set_env_value "$control_env" ALLOW_INSECURE_DEV_AUTH false
set_env_default "$control_env" AI_PROVIDER openrouter
set_env_default "$control_env" AI_BASE_URL https://openrouter.ai/api/v1
set_env_default "$control_env" OPENROUTER_BASE_URL https://openrouter.ai/api/v1
set_env_default "$control_env" AI_REQUIRE_ZDR true
set_env_default "$control_env" ALLOW_INSECURE_PROVIDER_URLS false
set_env_value "$control_env" WORKER_HEALTH_HOST 127.0.0.1
set_env_value "$control_env" PUSH_VAPID_PUBLIC_KEY "$push_public_key"
set_env_value "$control_env" PUSH_VAPID_PRIVATE_KEY "$push_private_key"
# The subject is the contact URL push services show when they reject deliveries; the server's
# own public URL is used unless the operator records an address of their own.
set_env_default "$control_env" PUSH_VAPID_SUBJECT "$public_url"
# The phone transport reads its bot API address and its long-poll length from here; the bot token
# itself is entered in Settings and sealed in the database, so nothing secret is written for it.
set_env_default "$control_env" TELEGRAM_API_BASE_URL https://api.telegram.org
set_env_default "$control_env" NOTIFICATION_INBOUND_POLL_TIMEOUT_S 50
# Written by earlier releases, read by nothing now. A private service's health endpoint has one
# correct bind address and one port on this box - `athanor doctor` probes them as literals and a
# published preview is refused them as literals - so the notification service fixes both in code
# rather than reading a setting that could only make those disagree.
remove_env_key "$control_env" ENABLE_GPU_WORKLOADS
remove_env_key "$control_env" NOTIFICATION_HEALTH_HOST
remove_env_key "$control_env" NOTIFICATION_HEALTH_PORT
remove_env_key "$control_env" MEDIA_HEALTH_HOST
remove_env_key "$control_env" MEDIA_HEALTH_PORT
chmod 0600 "$athanor_config/control.env"

runner_env="$athanor_config/runner.env"
# The one runner setting an update must never touch, so it is here and not in the release step.
# Rewriting it would leave the API holding one secret and the runner another until both restart,
# and there is no release that has a reason to change it.
set_env_value "$runner_env" RUNNER_SHARED_SECRET "$runner_shared_secret"
# Everything else, from the same function an update calls, so a key added to one is written by both.
# `agent_filesystem_confinement` is already measured above, at the hard gate, and the function uses
# that measurement rather than taking its own.
release_step_runner_settings

/usr/local/lib/athanor/athanor-network-refresh

# `http2 on;` only exists from nginx 1.25.1. Ubuntu 22.04 ships 1.18 and 24.04 ships 1.24, where
# HTTP/2 is a `listen` parameter instead, so the wrong form stops nginx from starting at all and
# takes the whole install down. Pick the listener block the packaged nginx actually understands.
nginx_version=$(nginx -v 2>&1 | sed -n 's|.*/\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*|\1|p')
nginx_major=${nginx_version%%.*}
nginx_rest=${nginx_version#*.}
nginx_minor=${nginx_rest%%.*}
nginx_patch=${nginx_rest#*.}
[ -n "$nginx_major" ] || nginx_major=0
[ -n "$nginx_minor" ] || nginx_minor=0
[ -n "$nginx_patch" ] || nginx_patch=0
if [ "$nginx_major" -gt 1 ] ||
  { [ "$nginx_major" -eq 1 ] && [ "$nginx_minor" -gt 25 ]; } ||
  { [ "$nginx_major" -eq 1 ] && [ "$nginx_minor" -eq 25 ] && [ "$nginx_patch" -ge 1 ]; }; then
  https_listen_asset=nginx-https-listen.conf
else
  https_listen_asset=nginx-https-listen-legacy.conf
fi
install -d -m 0755 /etc/nginx/snippets
install_asset 0644 "$athanor_root/infra/native/$https_listen_asset" \
  /etc/nginx/snippets/athanor-https-listen.conf
install_asset 0644 "$athanor_root/infra/native/nginx-security-headers.conf" \
  /etc/nginx/snippets/athanor-security-headers.conf
install_asset 0644 "$athanor_root/infra/native/nginx-app-csp.conf" \
  /etc/nginx/snippets/athanor-app-csp.conf
# Only written when absent: `athanor certificate enable` turns HSTS on by replacing this file, and
# an upgrade must not quietly switch it back off on a box that has a real certificate.
[ -f /etc/nginx/snippets/athanor-hsts.conf ] ||
  install_asset 0644 "$athanor_root/infra/native/nginx-hsts-off.conf" \
    /etc/nginx/snippets/athanor-hsts.conf

# sites-available/sites-enabled is Debian's layout and its nginx.conf is what includes it. Everyone
# else includes conf.d, and writing the site into a directory that does not exist is how an install
# finishes and then serves nothing at all.
nginx_site=$(athanor_nginx_site_path)
mkdir -p "$(dirname "$nginx_site")"
if [ -d /etc/nginx/sites-available ]; then
  install_asset 0644 "$athanor_root/infra/native/nginx.conf" /etc/nginx/sites-available/athanor
  ln -sfn /etc/nginx/sites-available/athanor "$nginx_site"
  rm -f /etc/nginx/sites-enabled/default
else
  install_asset 0644 "$athanor_root/infra/native/nginx.conf" "$nginx_site"
  # The stock server block listens on 80 and would answer before ours does.
  [ ! -f /etc/nginx/conf.d/default.conf ] || mv /etc/nginx/conf.d/default.conf \
    /etc/nginx/conf.d/default.conf.athanor-disabled
fi
/bin/sh "$athanor_root/scripts/athanor-native-runtime" preview-origin
nginx -t

# The installer creates every other directory it writes into and this heredoc assumed one. A host
# whose avahi package had not been installed - or had been installed without its service directory -
# aborted here under `set -eu`, after the configuration was written and the database password set
# and before daemon-reload, enable and every service start: a box with units on disk and nothing
# running at all.
install -d -m 0755 /etc/avahi/services
cat >/etc/avahi/services/athanor.service <<EOF
<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">athanor on %h</name>
  <service>
    <type>_athanor._tcp</type>
    <port>443</port>
    <txt-record>version=1</txt-record>
    <txt-record>identity=sha256/$server_identity</txt-record>
  </service>
</service-group>
EOF

# The unattended update runs git as root from a systemd timer, and the checkout usually belongs to
# the person who cloned it. Git refuses a repository owned by somebody else - "detected dubious
# ownership" - and it refuses it only in that context: `sudo athanor update` works, because sudo
# leaves SUDO_UID behind for git to match against, while the timer has no such variable. The result
# was an update that passed every manual test and silently never ran on its own. Recorded
# system-wide because the timer's root has no user configuration to read.
git config --system --add safe.directory "$athanor_root" 2>/dev/null || true

systemctl daemon-reload
systemctl enable avahi-daemon nginx athanor.target
# The instances this release runs, written once in this file and derived everywhere else in it.
#
# There were three copies here - this list, the `systemctl enable` line, and the restart loop -
# beside two in athanor.target and one in the dispatcher. The dispatcher already records what a
# disagreement between them costs: an arm naming a directory that is not in this repository, which
# is not a spare capability but a unit enabled once and then crash-looping on a missing file.
athanor_services="api worker registry notifications"

# Three other files hold this same list, and a disagreement with any of them breaks the box in a
# different way. This is not tidiness; each of the three is a failure somebody has to debug.
#
# - athanor.target. `Wants=` starts the unit it names whenever the target starts, enabled or not.
#   A release that drops an instance here and leaves it in the target has the stale sweep below stop
#   it and `systemctl start athanor.target` start it again seconds later, and again on every boot:
#   the removal reports success and does not happen.
# - scripts/athanor-service. An arm missing here is a unit that starts, exits 1 on the usage line,
#   and is brought back by `Restart=always` for ever. The dispatcher's own comment records this one
#   happening: an arm naming a directory that is not in this repository.
# - scripts/athanor's `service_units`, which is what `athanor restart` - and therefore the last step
#   of every update - restarts by name. A withdrawn instance left in it is restarted into that same
#   crash loop by the command the owner runs to fix things.
#
# Checked here, before daemon-reload has activated anything, because this script installs all four
# files and is the only place that sees them together. `athanor logs registry` and the doctor arms
# are deliberately not checked: a stale name there reports "no such unit" to an owner who asked a
# question, which is a wrong answer and not a broken machine.
# shellcheck disable=SC2086 # splitting the list into one instance per line is the point
declared_instances=$(printf '%s\n' $athanor_services | sort | tr '\n' ' ')
instances_must_match() {
  [ "$2" = "$declared_instances" ] ||
    fail "$1 names instances [ $2] but this installer runs [ $declared_instances]; a service named in only one of them either never starts, crash-loops, or comes back after every reboot"
}
instances_must_match "athanor.target" "$(sed -n 's/^Wants=//p' \
  "$athanor_root/infra/native/athanor.target" | tr ' ' '\n' |
  sed -n 's/^athanor@\(.*\)\.service$/\1/p' | sort | tr '\n' ' ')"
# `runner` is an arm of the dispatcher and not an instance of this template - it is its own unit,
# with its own user and its own cgroup ceilings - so it is removed before the comparison.
instances_must_match "scripts/athanor-service" "$(sed -n 's/^  \([a-z-]*\)) entry=.*/\1/p' \
  "$athanor_root/scripts/athanor-service" | grep -v '^runner$' | sort | tr '\n' ' ')"
instances_must_match "scripts/athanor" "$(sed -n 's/^service_units="//p' \
  "$athanor_root/scripts/athanor" | tr ' ' '\n' |
  sed -n 's/^athanor@\(.*\)\.service$/\1/p' | sort | tr '\n' ' ')"

athanor_units="athanor-jobs.service athanor-gui.service athanor-runner.service"
for service_name in $athanor_services; do
  athanor_units="$athanor_units athanor@$service_name.service"
done
# The services are enabled individually as well as being wanted by the target. The target alone did
# bring them up, so this looks redundant, but it left every one of them reporting "disabled" to
# `systemctl is-enabled` - which is what an owner or a support script checks when the box comes back
# from a reboot with nothing serving - and it made the target the single thing standing between a
# power cut and a dead machine. Each unit already declares `WantedBy=multi-user.target`; this makes
# the installed state match what the unit says about itself.
# shellcheck disable=SC2086 # the list is built above from a known set of instance names
systemctl enable $athanor_units
systemctl enable --now athanor-network-watch.service athanor-network-refresh.timer \
  athanor-network-refresh.path athanor-backup.timer
systemctl restart avahi-daemon
systemctl reload-or-restart athanor-jobs.service
systemctl restart athanor-gui.service
systemctl restart athanor-runner.service
for service_name in $athanor_services; do
  systemctl restart "athanor@$service_name.service"
done
systemctl restart nginx
systemctl start athanor.target

# An upgrade that drops a service leaves the old one running: the target stops wanting it, which
# prevents it starting again but never stops the copy already up. It then holds its port and its
# database connections until someone reboots. Anything still running under the instance template
# and no longer named here is stopped, so the set of units on the box is the set this release has.
#
# After the target is started, not before. Started first, the target pulls in everything it wants -
# so a sweep that ran ahead of it stopped a dropped instance and then watched the next line start it
# again. The cross-check above is what makes this terminal rather than a race the sweep can lose.
#
# The unit name is picked out by pattern rather than by column: systemd indents this listing, and
# prefixes a status glyph to some rows, so neither the first character nor the first field is
# reliably the name.
stale_units=$(systemctl list-units --state=active --no-legend 'athanor@*.service' |
  awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^athanor@.*\.service$/) { print $i; break } }')
for unit in $stale_units; do
  instance=${unit#athanor@}
  instance=${instance%.service}
  case " $athanor_services " in
  *" $instance "*) ;;
  *)
    say "Stopping $unit, which this release no longer installs"
    systemctl stop "$unit" || true
    systemctl disable "$unit" 2>/dev/null || true
    ;;
  esac
done

say "Opening the network path to this computer"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
elif command -v nft >/dev/null 2>&1 &&
  nft list ruleset 2>/dev/null | grep -q 'hook input .* policy drop'; then
  # Hand-written packet filters are not edited here: a wrong guess at the rule position
  # can lock the operator out of the host entirely.
  warn "the nftables input chain drops by default; allow inbound TCP 80, 443 and 8443 yourself"
elif command -v iptables >/dev/null 2>&1 &&
  iptables -S INPUT 2>/dev/null | grep -q '^-P INPUT DROP'; then
  warn "the iptables INPUT policy is DROP; allow inbound TCP 80, 443 and 8443 yourself"
fi

for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4100/healthz >/dev/null 2>&1; then
    break
  fi
  [ "$attempt" -lt 60 ] || {
    systemctl --no-pager --full status athanor@api.service >&2 || true
    fail "the API did not become healthy"
  }
  sleep 1
done

# A WebAuthn Relying Party ID has to be a registrable domain name; the specification does not
# allow an address literal. Trusted TLS for a bare address is now obtainable, so an address-only
# server does get the installable app and push notifications - but a passkey cannot be created
# or used in a browser against it, which means the owner can only ever sign in from a native
# client. A hostname is therefore part of ordinary setup, not an optional extra.
if [ -n "${ATHANOR_DDNS_TOKEN:-}" ]; then
  say "Publishing this computer under ${ATHANOR_DDNS_HOSTNAME:-the requested hostname}"
  # The token stays in the environment: athanor-ddns reads it from there rather than from an
  # argument, so it never appears in this host's process list.
  if /usr/local/lib/athanor/athanor-ddns configure </dev/null; then
    candidate_hostname="${ATHANOR_DDNS_HOSTNAME:-$candidate_hostname}"
    public_url=$(existing_control_value PUBLIC_APP_URL)
    webauthn_rp_id=$(existing_control_value WEBAUTHN_RP_ID)
  else
    warn "dynamic DNS could not be configured; run sudo athanor ddns configure to retry"
  fi
fi

case "$webauthn_rp_id" in
  '['*|*:*) server_has_hostname="" ;;
  *[!0-9.]*) server_has_hostname=yes ;;
  *) server_has_hostname="" ;;
esac
if [ -z "$server_has_hostname" ]; then
  warn "this computer has no hostname, so signing in from a browser is not possible: a passkey is bound to a domain name and the standard does not allow an IP address"
  # Ordered by what is true of most servers. A rented server has a fixed address, so it needs one A
  # record and nothing else; dynamic DNS exists for an address that changes, which is a home
  # connection, and offering it first sent owners of perfectly stable servers to configure a service
  # that solves a problem they do not have.
  say "  Fixed address: point a domain at $(printf '%s' "$ipv4_addresses" | awk '{print $1}') and re-run with ATHANOR_HOSTNAME=your.domain ATHANOR_ACME_EMAIL=you@example.com, or run sudo athanor set-hostname your.domain"
  say "  Address that changes, as on a home connection: sudo athanor ddns configure"
fi

# None of this proves a request from the internet arrives, which cannot be tested from the
# host itself. It does catch the cases that silently produce an unreachable installation.
say "Checking that clients can reach this computer"
listening_ports=$(
  ss -ltnH 2>/dev/null |
    awk '{ count = split($4, fields, ":"); print fields[count] }' |
    sort -u
)
for gateway_port in 80 443 8443; do
  printf '%s\n' "$listening_ports" | grep -qx "$gateway_port" ||
    warn "nothing is listening on TCP $gateway_port, so no client can connect"
done
curl -fsS -k -o /dev/null --max-time 15 https://127.0.0.1/healthz ||
  warn "the TLS gateway did not answer on this host; run sudo athanor doctor"
public_address_found=""
for address in $ipv4_addresses; do
  case "$address" in
    10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
    *) public_address_found=yes ;;
  esac
done
for address in $ipv6_addresses; do
  case "$address" in
    [fF][cCdD]*) ;;
    *) public_address_found=yes ;;
  esac
done
[ -n "$public_address_found" ] ||
  warn "this computer only has private addresses: forward inbound TCP 80, 443 and 8443 to it on your router, and run sudo athanor ddns configure so clients can find it by name"

endpoints_json=$(
  {
    [ -n "$candidate_hostname" ] && printf 'https://%s\n' "$candidate_hostname"
    for address in $ipv4_addresses; do printf 'https://%s\n' "$address"; done
    for address in $ipv6_addresses; do printf 'https://[%s]\n' "$address"; done
  } |
    awk 'NF && !seen[$0]++' |
    sed -n '1,16p' |
    jq -R . |
    jq -s -c .
)
ticket=$(
  # The JavaScript is intentionally single-quoted so the shell cannot expand ticket data.
  # shellcheck disable=SC2016
  node -e '
    const payload = {
      version: 2,
      endpoints: JSON.parse(process.argv[1]),
      identity: `sha256/${process.argv[2]}`,
      discovery: { mdnsService: "_athanor._tcp.local", mdnsPort: 443 },
      pairingCode: process.argv[3],
      expiresAt: Number(process.argv[4])
    };
    process.stdout.write(Buffer.from(JSON.stringify(payload)).toString("base64url"));
  ' "$endpoints_json" "$server_identity" "$pairing_code" "$pairing_expires"
)
pairing_uri="garden://pair/$ticket"
# The same grant as an address a camera can open, which is the only form worth putting in a code
# printed at install time: the device being paired is by definition one with nothing installed yet,
# so a phone pointed at an `athanor://` code did nothing at all. The API mints exactly this shape
# for the settings screen (apps/api/src/server.ts, the enrollment `webUri`), and the ticket rides in
# the fragment, where it never appears in a request line or an access log.
web_pairing_uri="$public_url/#pair=$ticket"

# A self-signed certificate is not merely an ugly warning: browsers refuse to register a service
# worker on a certificate error, so the installable app, push notifications and the share target
# are all unavailable until TLS is publicly trusted. Offer it during install, where the operator is
# already present, rather than leaving it as a step most people will never discover. It stays
# explicit because requesting a certificate accepts the authority's subscriber agreement.
if [ -n "${ATHANOR_ACME_EMAIL:-}" ]; then
  say "Requesting a publicly trusted certificate"
  if /usr/local/lib/athanor/athanor-certificate enable \
    --agree-tos --email "$ATHANOR_ACME_EMAIL"; then
    :
  else
    warn "a publicly trusted certificate could not be issued; the server is serving its self-signed certificate and browsers will warn. Retry with: sudo athanor certificate enable --agree-tos --email you@example.com"
  fi
fi

# What the certificate now on disk is, asked of the script that owns that file rather than worked
# out again here. Asked afterwards, about what is actually being served, rather than from whether an
# email was supplied: a reinstall can already have a trusted certificate and no email set, and a
# request that was made can still have failed. "Unknown" stays unknown - not having reached that
# script is not the same as having learned the certificate is self-signed.
certificate_description=$(
  /usr/local/lib/athanor/athanor-certificate status 2>/dev/null |
    sed -n 's/^Certificate: *//p' | sed -n '1p'
)
case "$certificate_description" in
  'issued by a certificate authority') certificate_trust=trusted ;;
  'self-signed'*) certificate_trust=self-signed ;;
  *) certificate_trust=unknown ;;
esac
# A browser switches WebAuthn off completely on a page whose certificate it does not trust, and
# accepting the warning does not switch it back on. So a self-signed certificate is not only an ugly
# first visit: it is an install nobody can create the owner account on. The no-hostname case above
# has already said its piece; this is the one that used to finish in silence, with a real hostname, a
# certificate dated two years out, and a sign-in screen offering a button that could not work.
if [ -n "$server_has_hostname" ] && [ "$certificate_trust" = self-signed ]; then
  warn "the owner account cannot be created from a browser yet: this computer is serving a certificate it signed itself, and no browser will create a passkey on a page whose certificate it does not trust. Re-run with ATHANOR_ACME_EMAIL=you@example.com, or run sudo athanor certificate enable --agree-tos --email you@example.com"
elif [ "$certificate_trust" = unknown ]; then
  warn "what certificate this computer is serving could not be confirmed, so whether a browser will accept it is unknown; run sudo athanor certificate status"
fi

printf '\n'
if [ -n "$install_warnings" ]; then
  printf 'athanor is installed, but these need attention first:\n\n'
  printf '%s\n' "$install_warnings"
else
  printf 'athanor is ready.\n\n'
fi
printf 'Open your computer at: %s\n' "$public_url"
# Directly under the address, because it is what happens when the address is opened. The owner used
# to be told "athanor is ready", open the link, and meet a full-page "Your connection is not
# private" with the explanation thirty lines further down, below a rule this script's own comment
# describes as being for diagnosing a connection rather than making the first one. Keyed on the
# certificate that is serving rather than on whether an email was passed, so a requested certificate
# that failed to issue is described as what it left behind.
if [ "$certificate_trust" = self-signed ]; then
  printf '\nYour browser will warn you the first time and ask you to accept the certificate -\n'
  printf 'this server signed its own. Accepting that warning is not enough to get in: a browser\n'
  printf 'will not create a passkey on a page whose certificate it does not trust, so the owner\n'
  printf 'account cannot be created from a browser until this is done. athanor also cannot be\n'
  printf 'installed as an app and cannot send notifications until then. To fix it now (no domain\n'
  printf 'needed for the certificate itself - a bare IP address works):\n'
  printf '  sudo athanor certificate enable --agree-tos --email you@example.com\n'
fi
printf '\nOr scan this from a phone:\n\n'
# qrencode is one of the host packages this installer places (scripts/athanor-host.sh lists it for
# every family), so the code is normally drawn. If a package manager left it out, the address it
# encodes is printed instead: an empty gap under “scan this” is exactly the pointing-at-nothing this
# block exists to remove.
qrencode -t ANSIUTF8 "$web_pairing_uri" 2>/dev/null || printf '  %s\n' "$web_pairing_uri"
printf '\nOne-time pairing code, if you opened the address by hand: %s\n' "$pairing_code"
printf 'Connection ticket, for the native client:\n%s\n' "$pairing_uri"
printf '\nThe pairing code expires in 24 hours and stops working after the owner is created.\n'
printf 'To show a fresh code later: sudo athanor pairing-code\n'
printf 'To check the installation: sudo athanor doctor\n'
# The one thing this box now does on its own without ever being told to. It pauses the services, it
# writes an archive containing this server's keys, and it was enabled here silently: the owner was
# told about updates, the doctor, the pairing code and the certificate, and not about the job that
# touches their data every day.
printf '\nA backup is taken daily, at a randomised hour, when nothing is running. It pauses the\n'
printf 'computer for the length of the copy. Copies are kept in /var/backups/athanor (the newest\n'
printf '5) and contain this server%s keys - treat them as you would the server itself.\n' "'s"
printf 'To turn it off: sudo athanor backup auto off\n'
# Everything below the rule is for diagnosing a connection, not for making the first one. It was
# printed above the address, so the one line a new owner needed arrived after two they did not.
printf '\n%s\n' '────────────────────────────────────────────────────────────'
printf 'Detected endpoints:\n'
printf '%s' "$endpoints_json" | jq -r '.[] | "  " + .'
printf 'Server identity: sha256/%s\n' "$server_identity"
if [ -z "$server_has_hostname" ]; then
  printf '\nThis computer has no hostname, so it is reachable only by address. Signing in from a\n'
  printf 'browser needs a hostname: a passkey is bound to a domain name and the WebAuthn standard\n'
  printf 'does not allow an IP address, so today only the native clients can sign in.\n'
  # Fixed address first, because that is what a rented server has. Dynamic DNS chases an address
  # that moves, and leading with it sent owners of perfectly stable servers to set up a service
  # against a problem they do not have.
  printf '\nIf this address is fixed, which it usually is on a rented server, point a domain at\n'
  printf '%s and then:\n' "$(printf '%s' "$ipv4_addresses" | awk '{print $1}')"
  printf '  sudo athanor set-hostname your.domain\n'
  printf '  sudo athanor certificate enable --agree-tos --email you@example.com\n'
  printf 'Both, not either: the name is what a passkey is bound to, and the trusted certificate is\n'
  printf 'what lets the browser create one at all. Or re-run this installer with\n'
  printf 'ATHANOR_HOSTNAME=your.domain ATHANOR_ACME_EMAIL=you@example.com to do it in one step.\n'
  printf '\nIf the address changes, as on a home connection, dynamic DNS is the tool for that:\n'
  printf '  1. create a name at https://www.duckdns.org or https://desec.io\n'
  printf '  2. sudo athanor ddns configure\n'
  printf 'Either way the name becomes the public origin and goes into the TLS certificate.\n'
fi
printf '\nUpdates are manual (sudo athanor update). For weekly unattended updates with\n'
printf 'automatic rollback: sudo athanor auto-update on\n'
