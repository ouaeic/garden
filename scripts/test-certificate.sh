#!/bin/sh
# The single-quoted blocks below are literal fixture script bodies.
# shellcheck disable=SC2016
set -eu

repository_root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT INT TERM

fake_bin="$test_root/bin"
config="$test_root/etc/garden"
state="$test_root/state"
mkdir -p "$fake_bin" "$config/tls" "$state"

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
make_fake systemctl 'exit 0'
make_fake nginx 'exit 0'

run_certificate() {
  PATH="$fake_bin:$PATH" \
    GARDEN_CONFIG="$config" \
    GARDEN_STATE="$state" \
    sh "$repository_root/scripts/garden-certificate" "$@"
}

printf 'ACME_ENABLED=true\nPUBLIC_APP_URL=https://garden.test\n' >"$config/control.env"
chmod 0600 "$config/control.env"

# A renewal that cannot even start - here, an installation with automatic issuance on and no
# contact address recorded. Before, the reason left with the process and the only symptom was a
# browser warning days later when the served certificate ran out.
if failure_output=$(run_certificate renew 2>&1); then
  printf 'a renewal that could not issue reported success\n' >&2
  exit 1
fi
test -r "$state/certificate.error"
grep -q 'no ACME contact address is recorded' "$state/certificate.error"
grep -q 'no certificate is installed' "$state/certificate.error"
printf '%s\n' "$failure_output" | grep -q 'no ACME contact address is recorded'
printf 'ok  a failed renewal records why, and still fails\n'

# What OnFailure= runs. It must not overwrite the reason the renewal already wrote down.
recorded_reason=$(sed -n '2p' "$state/certificate.error")
alert_output=$(run_certificate alert-failed 2>&1)
test "$(sed -n '2p' "$state/certificate.error")" = "$recorded_reason"
printf '%s\n' "$alert_output" | grep -q 'renewal failed'
printf '%s\n' "$alert_output" | grep -q 'security warning'
printf 'ok  the failure alert reports the recorded reason\n'

# And when the renewal was killed before it could write anything - a run that hit its own start
# timeout - the alert is what leaves the record.
rm -f "$state/certificate.error"
run_certificate alert-failed >/dev/null 2>&1
test -r "$state/certificate.error"
grep -q 'renewal did not finish' "$state/certificate.error"
printf 'ok  a renewal killed before it could report still leaves a record\n'

# A certificate that is authority-issued, in date, and covers the configured name needs no
# renewal, and that success has to clear the standing alarm.
authority="$test_root/ca"
mkdir -p "$authority"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$authority/ca.key" -out "$authority/ca.crt" \
  -days 120 -subj '/CN=garden test authority' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$authority/leaf.key" -out "$authority/leaf.csr" \
  -subj '/CN=garden.test' >/dev/null 2>&1
printf 'subjectAltName=DNS:garden.test\n' >"$authority/extensions"
# Sixty days of validity is outside the thirty-day renewal margin, so this run has nothing to do
# and must say so by leaving no alarm behind.
openssl x509 -req -in "$authority/leaf.csr" -CA "$authority/ca.crt" -CAkey "$authority/ca.key" \
  -CAcreateserial -days 60 -extfile "$authority/extensions" -out "$config/tls/server.crt" \
  >/dev/null 2>&1
run_certificate renew >/dev/null 2>&1
test ! -e "$state/certificate.error"
printf 'ok  a renewal that has nothing to do clears the recorded failure\n'

# A certificate inside its margin is reissued, and an issuance that cannot run records both the
# reason and how much validity is left before clients start seeing warnings.
openssl x509 -req -in "$authority/leaf.csr" -CA "$authority/ca.crt" -CAkey "$authority/ca.key" \
  -CAcreateserial -days 2 -extfile "$authority/extensions" -out "$config/tls/server.crt" \
  >/dev/null 2>&1
if run_certificate renew >/dev/null 2>&1; then
  printf 'a certificate inside its renewal margin was left alone\n' >&2
  exit 1
fi
grep -q 'the served certificate is still valid until' "$state/certificate.error"
printf 'ok  a due certificate that cannot be reissued records the remaining validity\n'

# Turning automatic issuance off must not leave an alarm about a job that no longer runs.
printf 'boom\n' >"$state/certificate.error"
run_certificate disable >/dev/null 2>&1 || true
test ! -e "$state/certificate.error"
printf 'ok  disabling automatic issuance clears the alarm\n'

# Browser readiness is independent of whether the server has a DNS name.
runtime="$test_root/runtime"
mkdir -p "$runtime/usr/local/lib/garden"
cat >"$runtime/usr/local/lib/garden/garden-certificate" <<'SCRIPT'
#!/bin/sh
printf 'Certificate: %s\n' "$TEST_CERTIFICATE_STATUS"
SCRIPT
chmod 0755 "$runtime/usr/local/lib/garden/garden-certificate"
make_fake curl 'exit 1'
make_fake runuser 'exit 1'
make_fake pg_isready 'exit 1'
make_fake fc-list 'exit 0'
make_fake df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/fake 1 1 99999999 1%% /\n"'
run_browser_doctor() {
  PATH="$fake_bin:$PATH" \
    GARDEN_ROOT="$repository_root" \
    GARDEN_CONFIG="$config" \
    GARDEN_STATE="$state" \
    GARDEN_CONTROL_STATE="$state" \
    GARDEN_HOME="$test_root/home" \
    GARDEN_RUNTIME_PREFIX="$runtime" \
    TEST_CERTIFICATE_STATUS="$1" \
    sh "$repository_root/scripts/garden" doctor 2>/dev/null || true
}
printf 'PUBLIC_APP_URL=https://203.0.113.10\nWEBAUTHN_RP_ID=203.0.113.10\n' >"$config/control.env"
browser_report=$(run_browser_doctor 'issued by a certificate authority')
printf '%s\n' "$browser_report" | grep -q 'ok    browser password sign-in origin https://203.0.113.10'
printf '%s\n' "$browser_report" | grep -q 'optional passkeys need a hostname'
if printf '%s\n' "$browser_report" | grep -q 'browser sign-in cannot work'; then
  printf 'doctor incorrectly requires a hostname for browser passwords\n' >&2
  exit 1
fi
browser_report=$(run_browser_doctor 'self-signed')
printf '%s\n' "$browser_report" | grep -q 'browser access needs trusted HTTPS'
if printf '%s\n' "$browser_report" | grep -q 'ok    browser password sign-in'; then
  printf 'doctor accepts an untrusted browser certificate\n' >&2
  exit 1
fi
printf 'ok  doctor separates password certificate readiness from optional passkey hostnames\n'
