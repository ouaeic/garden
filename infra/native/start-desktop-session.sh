#!/bin/sh
set -eu

workspace_root="${1:?workspace root is required}"
display_number="${2:?display number is required}"
state_dir="$workspace_root/.athanor/desktop"
environment_file="$state_dir/environment"

for desktop_binary in /usr/bin/Xvfb /usr/bin/xdpyinfo /usr/bin/dbus-run-session /usr/bin/xauth; do
  [ -x "$desktop_binary" ] || {
    printf 'Desktop prerequisite is missing: %s. Run sudo garden update to repair the installation.\n' "$desktop_binary" >&2
    exit 1
  }
done

# Rejects anything that is not exactly <digits>x<digits>, because these values become Xvfb
# arguments.
valid_resolution() {
  case "$1" in
  '' | *[!0-9x]* | *x*x* | x* | *x) return 1 ;;
  *x*) return 0 ;;
  *) return 1 ;;
  esac
}

# Xvfb allocates its framebuffer once and RandR can only ever shrink below the boot geometry
# (RRScreenSetSizeRange is pinned to the -screen size), so the session boots at a ceiling and
# the runner resizes down to follow whoever is watching. 3840x2160 is a 33 MB lazily faulted
# mapping; the 15360x8640 seen in other projects is half a gigabyte of virtual address space
# for no benefit.
: "${ATHANOR_MAX_RES:=3840x2160}"
: "${ATHANOR_BOOT_RES:=1280x800}"
: "${ATHANOR_KEYBOARD_LAYOUT:=us}"
valid_resolution "$ATHANOR_MAX_RES" || ATHANOR_MAX_RES=3840x2160
valid_resolution "$ATHANOR_BOOT_RES" || ATHANOR_BOOT_RES=1280x800
case "$ATHANOR_KEYBOARD_LAYOUT" in
*[!a-z0-9,_-]*) ATHANOR_KEYBOARD_LAYOUT=us ;;
esac

# X11 and D-Bus sockets belong on a tmpfs. A workspace directory is the last resort: it may be
# synced or on a network filesystem, where socket semantics and latency are both wrong.
runtime_parent=""
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -w "${XDG_RUNTIME_DIR:-}" ]; then
  runtime_parent="$XDG_RUNTIME_DIR"
elif [ -w "/run/user/$(id -u)" ]; then
  runtime_parent="/run/user/$(id -u)"
fi
if [ -n "$runtime_parent" ]; then
  runtime_dir="$runtime_parent/athanor-desktop-$display_number"
else
  runtime_dir="$state_dir/run"
fi

mkdir -p "$state_dir"
# The runtime directory holds the D-Bus socket, so it is private to this account - and the mode is
# set at creation rather than by a chmod afterwards. The workspace tree is setgid so the agent
# account can reach it, chmod on a directory carries the setgid bit through to the syscall, and the
# runner runs under RestrictSUIDSGID, which refuses exactly that. A chmod here therefore fails on
# a hardened box while passing on every machine where the hardening is absent.
# Not `mkdir -p -m`: with -p the mode applies only to the deepest directory, and the parent is
# already there either way - state_dir was made on the line above, and /run/user/<uid> belongs to
# the system. Guarded rather than -p so the mode is applied on creation and the call stays idempotent.
[ -d "$runtime_dir" ] || mkdir -m 0700 "$runtime_dir"
rm -f "$environment_file"

export HOME="${HOME:-$workspace_root}"
export DISPLAY=":$display_number"
export XAUTHORITY="$state_dir/Xauthority"
# X11 uses a public local socket; a private cookie keeps other sessions and agent commands out.
authority_file=$(mktemp "$state_dir/Xauthority.XXXXXX")
chmod 0600 "$authority_file"
authority_cookie=$(/usr/bin/python3 -c 'import secrets; print(secrets.token_hex(16))')
printf 'add %s MIT-MAGIC-COOKIE-1 %s\n' "$DISPLAY" "$authority_cookie" | /usr/bin/xauth -q -f "$authority_file"
unset authority_cookie
mv -f "$authority_file" "$XAUTHORITY"
export XDG_RUNTIME_DIR="$runtime_dir"
export ATHANOR_MAX_RES ATHANOR_BOOT_RES ATHANOR_KEYBOARD_LAYOUT
export NO_AT_BRIDGE=0
export GTK_MODULES="gail:atk-bridge"
export QT_ACCESSIBILITY=1
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export SAL_ACCESSIBILITY_ENABLED=1

# The single-quoted body is an inner shell program; environment_file is passed as $1.
# shellcheck disable=SC2016
exec /usr/bin/dbus-run-session -- /bin/sh -c '
  set -eu
  openbox_pid=""
  atspi_pid=""
  audio_started=false
  # The X server puts its socket in /tmp/.X11-unix, and on a normal boot systemd-tmpfiles creates
  # that directory. The runner runs under PrivateTmp, which hands it a fresh empty tmpfs instead -
  # so the directory is simply not there, Xvfb cannot bind, and the session dies before it writes
  # anything. Creating it here rather than in the unit keeps the requirement next to the thing that
  # has it, and works the same whether or not the caller is isolated.
  mkdir -p /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix 2>/dev/null || true
  # DAMAGE and XFIXES back the capture and cursor paths, MIT-SHM keeps a full-screen fetch a
  # single memcpy, and RANDR is how the display follows the client viewport.
  /usr/bin/Xvfb "$DISPLAY" -auth "$XAUTHORITY" \
    -screen 0 "${ATHANOR_MAX_RES}x24" \
    +extension RANDR +extension DAMAGE +extension XFIXES +extension MIT-SHM \
    +extension Composite \
    -dpi 96 -nolisten tcp -nolisten local -noreset &
  xvfb_pid=$!
  cleanup() {
    kill "$xvfb_pid" 2>/dev/null || true
    if [ -n "$openbox_pid" ]; then kill "$openbox_pid" 2>/dev/null || true; fi
    if [ -n "$atspi_pid" ]; then kill "$atspi_pid" 2>/dev/null || true; fi
    if [ "$audio_started" = true ]; then pulseaudio --kill >/dev/null 2>&1 || true; fi
  }
  trap cleanup EXIT INT TERM
  desktop_ready=false
  for attempt in $(seq 1 80); do
    kill -0 "$xvfb_pid" 2>/dev/null || {
      printf "Xvfb exited before display %s became ready\n" "$DISPLAY" >&2
      exit 1
    }
    if /usr/bin/xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      desktop_ready=true
      break
    fi
    sleep 0.1
  done
  [ "$desktop_ready" = true ] || {
    printf "Display %s did not become ready\n" "$DISPLAY" >&2
    exit 1
  }
  # Printable keys are injected as keycodes and resolved by the server layout, so dead keys,
  # AltGr and non-US layouts only work if this matches the human at the other end.
  /usr/bin/setxkbmap -display "$DISPLAY" "$ATHANOR_KEYBOARD_LAYOUT" >/dev/null 2>&1 || true
  # A null sink, not because anything streams audio yet, but because GUI applications that
  # cannot open any audio device log continuously and some of them stall on startup.
  if command -v pulseaudio >/dev/null 2>&1; then
    if pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1; then
      audio_started=true
      pactl load-module module-null-sink sink_name=athanor >/dev/null 2>&1 || true
    fi
  fi
  /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
  atspi_pid=$!
  /usr/bin/openbox-session >/dev/null 2>&1 &
  openbox_pid=$!
  printf "DISPLAY=%s\nXAUTHORITY=%s\nDBUS_SESSION_BUS_ADDRESS=%s\nXDG_RUNTIME_DIR=%s\nATHANOR_MAX_RES=%s\nATHANOR_BOOT_RES=%s\nATHANOR_KEYBOARD_LAYOUT=%s\n" \
    "$DISPLAY" "$XAUTHORITY" "$DBUS_SESSION_BUS_ADDRESS" "$XDG_RUNTIME_DIR" \
    "$ATHANOR_MAX_RES" "$ATHANOR_BOOT_RES" "$ATHANOR_KEYBOARD_LAYOUT" > "$1"
  chmod 0600 "$1"
  wait "$xvfb_pid"
' athanor-desktop-session "$environment_file"
