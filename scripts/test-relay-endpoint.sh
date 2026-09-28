#!/bin/sh
# What this computer tells clients about itself when the relay is on, and when it is off.
#
# The relay address has to appear in the connection manifest while the relay is switched on and
# disappear the moment it is switched off - an advertised endpoint that nothing answers on costs
# every client a failed connection attempt before it finds a working one. The manifest is built by
# a shell script on a netlink event, so this drill runs that script for real against fixtures.
set -eu

repository_root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT INT TERM

fake_bin="$test_root/bin"
config="$test_root/etc/garden"
state="$test_root/state"
mkdir -p "$fake_bin" "$config/tls" "$config/relay" "$state"

make_fake() {
  name="$1"
  shift
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$@"
  } >"$fake_bin/$name"
  chmod 0755 "$fake_bin/$name"
}

make_fake id '
if [ "${1:-}" = "-u" ]; then printf "0\n"; else printf "root\n"; fi'
# One address, so the endpoint list is short enough to compare exactly.
make_fake ip '
case "$*" in
  *"-4 address show"*) printf "1: eth0    inet 203.0.113.9/24 scope global eth0\n" ;;
esac'
make_fake systemctl 'exit 1'
make_fake chown 'exit 0'
command -v sha256sum >/dev/null 2>&1 || make_fake sha256sum 'exec /usr/bin/shasum -a 256 "$@"'

printf 'PUBLIC_APP_URL=https://box.example.net\n' >"$config/control.env"
openssl ecparam -name prime256v1 -genkey -noout -out "$config/tls/server.key" 2>/dev/null
chmod 0600 "$config/tls/server.key"

run_refresh() {
  PATH="$fake_bin:$PATH" \
    GARDEN_CONFIG="$config" \
    GARDEN_STATE="$state" \
    GARDEN_DDNS="$test_root/absent-ddns" \
    /bin/sh "$repository_root/scripts/garden-network-refresh" >/dev/null
}

endpoints() {
  jq -r '.endpoints | join(" ")' "$state/connection.json"
}

# 1. No relay at all: the shipped state. Nothing about a relay reaches the manifest.
run_refresh
test "$(endpoints)" = "https://box.example.net https://203.0.113.9" ||
  { printf 'a server with no relay advertised: %s\n' "$(endpoints)" >&2; exit 1; }
printf 'ok  a server with no relay advertises only its own addresses\n'

relay_settings="$config/relay/settings.json"
write_settings() {
  cat >"$relay_settings" <<EOF
{
  "enabled": $1,
  "host": "relay.example.com",
  "label": "ab3kqz7mn4pd2xw9tyv6su5rjh",
  "port": 443
}
EOF
  chmod 0600 "$relay_settings"
}

# 2. Switched on: the relay address is offered, and last. It is the slowest path and the only one
# with a third party in it, so a client races the direct addresses first.
write_settings true
run_refresh
test "$(endpoints)" = \
  "https://box.example.net https://203.0.113.9 https://ab3kqz7mn4pd2xw9tyv6su5rjh.relay.example.com" ||
  { printf 'a server on a relay advertised: %s\n' "$(endpoints)" >&2; exit 1; }
printf 'ok  a server on a relay offers the relay address last\n'

# 3. Switched off: gone in the same step. This is the half of the off switch that lives outside
# the running server, and it is why the settings file is watched rather than polled.
write_settings false
run_refresh
test "$(endpoints)" = "https://box.example.net https://203.0.113.9" ||
  { printf 'a switched-off relay was still advertised: %s\n' "$(endpoints)" >&2; exit 1; }
printf 'ok  switching the relay off stops the server advertising it\n'

# 4. A settings file that is torn, or that names something which is not a hostname, must not reach
# the manifest: a client would spend a connection attempt on it every time.
printf '{"enabled": true, "host": "relay.example.com", "label": "not a label"}\n' >"$relay_settings"
run_refresh
test "$(endpoints)" = "https://box.example.net https://203.0.113.9" ||
  { printf 'an unusable relay label reached the manifest: %s\n' "$(endpoints)" >&2; exit 1; }
printf '{"enabled": true, "host": "relay.example.com", "label": \n' >"$relay_settings"
run_refresh
test "$(endpoints)" = "https://box.example.net https://203.0.113.9" ||
  { printf 'a torn relay settings file reached the manifest: %s\n' "$(endpoints)" >&2; exit 1; }
printf 'ok  an unreadable relay setting is treated as no relay\n'

printf '\nall relay endpoint checks passed\n'
