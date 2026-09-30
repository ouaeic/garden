# Deployment

## Supported server

The production server supports four distribution families on `amd64` and `arm64`: Debian and
Ubuntu, Fedora/RHEL/Rocky/AlmaLinux, Arch, and openSUSE. The installer detects which it is on and
uses that family's package manager. It installs directly on the host. No Docker Engine, Compose, nested VM, machine image, PRoot guest, Tailscale, VPN, or SSH tunnel
is part of the architecture.

A small installation is comfortable with 4 vCPU, 8–16 GB RAM, and 40 GB free disk. Large builds,
bioinformatics, or several GUI programs benefit from more CPU, RAM, and mounted storage. A GPU is
needed only for the owner’s own compute workflows; model inference stays at the configured AI
provider.

The host needs:

- outbound internet access;
- inbound TCP 80, 443 and 8443 for off-site clients;
- SSH only for installation/recovery; and
- a router port-forward if it is behind NAT and must be reached off-site.

## One-command installation

Published release:

```bash
curl -fsSL https://raw.githubusercontent.com/ouaeic/garden/v0.2.0/install.sh | sudo env GARDEN_REF=v0.2.0 sh
```

Checked-out source:

```bash
sudo ./install.sh
```

With a domain already pointed at the server, browser sign-in can be working when the installer
finishes rather than two commands later:

```bash
curl -fsSL https://raw.githubusercontent.com/ouaeic/garden/v0.2.0/install.sh | sudo env GARDEN_REF=v0.2.0 GARDEN_HOSTNAME=your.domain GARDEN_ACME_EMAIL=you@example.com sh
```

Both variables are needed for that, for two unrelated reasons set out under **Network and TLS**:
the name is what a passkey is bound to, and the trusted certificate is what allows a browser to
create one at all. `GARDEN_ACME_EMAIL` is also the act of accepting the certificate authority's
subscriber agreement, which is why no certificate is requested without it. Neither is required to
install: without them the server runs, desktop clients can sign in, and the installer reports that
browser sign-in does not work yet instead of reporting success.

The bootstrap clones or updates `/opt/garden`; the native installer then:

1. validates the OS, CPU architecture, memory and free disk, and stops before doing any work if the
   host cannot finish;
2. installs the host's own packages through its own package manager - Node.js, pnpm, PostgreSQL,
   Nginx, Xvfb, Openbox, AT-SPI, LibreOffice,
   FFmpeg, OCR, and document utilities;
3. installs the pieces no distribution carries at the version garden pins, each against an exact
   version: the `typst` typesetting
   binary, checked against a SHA-256 recorded in the installer before it is unpacked; the document
   Python environment, installed with `--require-hashes` against a hash-locked requirement file;
   and Chromium, fetched by the lockfile-pinned Playwright dependency at the browser revision that
   version carries. On a release whose `imagemagick` package is ImageMagick 6 — Debian 12, Ubuntu
   22.04 and 24.04 — it also installs `/usr/local/bin/magick`, a small command dispatching to that
   release's `convert` and `identify`, because garden names `magick` everywhere and ImageMagick 6
   has no such binary. It stands aside for a real ImageMagick 7, and uninstall removes it;
4. builds the source in place;
5. creates three service accounts — `garden-control` for the control plane, `garden` for the
   runner, and `garden-agent` for the commands the agent runs — then proves the drop to the agent
   account actually takes effect and refuses to finish the install if it does not;
6. creates database, encryption, session, runner, Web Push, TLS identity, and pairing secrets,
   reusing any that already exist so a reinstall does not invalidate paired devices;
7. restricts PostgreSQL to the password in root-owned configuration, then verifies that neither the
   runner nor the agent account can reach the database over the local socket;
8. discovers usable DNS, IPv4, and IPv6 endpoints without asking the user for them;
9. binds internal services to `127.0.0.1` and the HTTPS gateway to 80/443 and isolated workspace previews to 8443;
10. enables native systemd services and the dynamic-address watcher, and installs the certificate
    renewal and unattended-update units without enabling them;
11. configures dynamic DNS when `GARDEN_DDNS_TOKEN` was supplied, and otherwise says plainly that a
    server without a hostname cannot be signed into from a browser and how to fix that;
12. requests a publicly trusted certificate when `GARDEN_ACME_EMAIL` was supplied, and afterwards
    inspects whatever certificate is actually being served: a server that is still on its
    self-signed one is reported as an installation the owner account cannot be created on, with the
    command that fixes it, rather than as "garden is ready"; and
13. prints a QR ticket and single-use first-owner code.

The package and browser caches are ordinary dependencies, not an garden runtime image. Installed
applications and datasets live once on the host.

### The part an update runs again

Steps 2 and 4 above, the workspace layout, and the runner settings written in step 6 other than the
generated secret are not install-only. They are the things a release carries that are not compiled,
and `sudo garden update` runs them by calling `scripts/install-native.sh --release-steps` from the
revision it has just pulled - one entry point rather than a second copy of the list, so a package
added to the capability table or a key added to `runner.env` reaches an existing box with the
release that adds it. `scripts/check-repository.mjs` fails the build if a `runner.env` key is written
outside that step, and `scripts/test-update.sh` runs the entry point and watches the key land.

Native tools also have a required activation step, shared with installation through
`scripts/garden-native-runtime`. It verifies the locked language-server versions and entry points,
prepares the hash-locked Python environment and checksum-verified JavaScript debugger before
switching their active paths, and validates the runner's sudo policy before replacing it atomically.
The process supervisor is installed with the runtime files. Failure in this phase prevents the new
release from starting and invokes the updater's rollback. Completed native environments are retained
for offline recovery; an interrupted download leaves the active environment in place.

Private workspace apps use the same host and certificate on HTTPS port 8443, a browser origin
separate from garden on port 443. That listener serves only the preview gateway; API, runner and
garden static routes return 404. Existing preview links on port 443 redirect with their path and
query intact. The required native activation migrates only the standard same-origin preview URL,
preserves an explicitly configured isolated preview origin, and generates the application's frame
policy from that exact configured origin. Open or forward TCP 8443 alongside 443; managed ufw and
firewalld rules are added during activation. A custom reverse proxy must forward the complete Host
including its port and set `X-Forwarded-Proto: https`. An optional relay must advertise and
forward its separate preview HTTPS channel; the default local preview port is 8443.

The updater restores verified private configuration before activating the previous revision during
rollback, including failures before the new services start. When upgrading an installation whose
updater predates that configuration rollback, run the exact reviewed incoming updater from a
root-owned staging file through its normal `update` command. Verify the staging file against the
committed release before invoking it with `GARDEN_ROOT=/opt/garden`; retain the installed command
until the ordinary runtime installation replaces it. This preserves backup, maintenance locking,
build, activation and rollback gates during the transition.

The proxy can be checked without production traffic using `node scripts/test-preview-proxy.mjs`
on a machine with nginx and OpenSSL installed. `NGINX_EXECUTABLE` selects an isolated nginx binary;
the drill creates temporary loopback HTTPS listeners and synthetic app/gateway servers, then removes
them. It exercises the shipped configuration's redirect, allowed preview route, forwarded origin,
frame policy and refused control-plane paths.

Account creation, secret generation, database initialization, and certificate issuance stay outside
both update entry points. Existing accounts, encryption and session keys, and trusted certificates
are preserved. The shared sudo policy is refreshed because a release can add a narrowly scoped
native helper operation; an invalid candidate never replaces the installed policy.

### Install from a client

The native client’s sign-in screen can install garden on a fresh server without making the owner
retype the shell command. The flow:

1. accepts an address, port, Linux login, and password or private-key path locally;
2. performs SSH key exchange before authentication and shows the server’s SHA-256 host-key
   fingerprint;
3. requires the owner to compare that **server host-key** fingerprint with the value obtained
   through the provider console (for ED25519:
   `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`), explicitly distinguishing it
   from the fingerprint of the owner’s SSH login key;
4. reconnects and pins that exact SSH identity before sending credentials;
5. runs only the fixed public installer as root or through noninteractive passwordless sudo; and
6. extracts and imports the returned one-time garden connection ticket.

Passwords and key passphrases are zeroed from the client request object on completion and are never
stored in the server profile, sent to an garden API, placed in a process argument, or passed through
a hosted relay. The PWA cannot make arbitrary TCP/SSH connections and therefore only offers the
copyable install command. This is a deliberate browser security boundary, not a missing permission.

## Pairing and first owner

The connection ticket contains endpoints and a public-key fingerprint; the pairing code expires
after 24 hours and is consumed when the first owner is created. Registration then closes.

```bash
sudo garden connect
sudo garden pairing-code
```

`connect` shows the current ticket. If its embedded first-owner code has expired, the root-only
command rotates it and restarts only the API before printing a usable ticket. This also makes a
new-device import work long after an already claimed server was installed; registration itself
remains closed once the owner exists. `pairing-code` always invalidates the previous code and creates
a new 24-hour code explicitly.

Re-running the checked-out installer preserves unowned operator settings already present in
`/etc/garden/control.env` and `runner.env`, including provider/privacy/connector and runtime limits,
while refreshing only the security-critical managed bindings and generated secrets that must stay
consistent. A stable custom HTTPS hostname is retained; a raw IP origin follows the currently
detected address. The server identity, data key, session key, runner secret, and database password
remain unchanged.

The TLS private key never enters the ticket. The stable identity is the SHA-256 fingerprint of its
public key. Clients must verify that identity before trusting a ticket endpoint or an address learned
later.

## Network and TLS

Nginx is the only public process:

| Port | Binding          | Purpose                                      |
| ---- | ---------------- | -------------------------------------------- |
| 80   | IPv4 and IPv6    | HTTPS redirect and ACME challenge path       |
| 443  | IPv4 and IPv6    | UI, API, WebSockets, previews, connection ID |
| 4100 | `127.0.0.1` only | API                                          |
| 4201 | `127.0.0.1` only | worker health and metrics                    |
| 4202 | `127.0.0.1` only | media service health and metrics             |
| 4203 | `127.0.0.1` only | notification service health and metrics      |
| 4300 | `127.0.0.1` only | authenticated computer runner                |
| 4400 | `127.0.0.1` only | preview gateway                              |
| 5432 | `127.0.0.1` only | PostgreSQL                                   |

The model registry has no listener at all: it refreshes the catalogue on a timer and writes to
PostgreSQL. The loopback rows above are also the exact set a published preview may not target: each
process derives the ports it already has settings for and is told the rest as
`RESERVED_PREVIEW_PORTS`, so “publish my demo on 5432” is refused rather than pointed at the
database.

The installer creates a self-signed certificate from the stable server key covering every current
address, so the server is usable from desktop clients immediately. That certificate is a
bootstrap, not the destination, and what a browser withholds on it is more than cosmetic: it will
not register a service worker on a certificate error, so there is no installable app, no push
notification and no share target — and it will not run WebAuthn at all, so no passkey can be
created or used, which means no owner account. Accepting the interstitial does not restore either;
the page is loaded but still marked as having certificate errors.

```bash
sudo garden certificate enable --agree-tos --email you@example.com
```

That command obtains a publicly trusted certificate and enables a renewal timer. It is a separate,
explicit step because requesting one accepts the certificate authority's subscriber agreement, and
garden will not accept external legal terms on the operator's behalf without being asked.

**A domain is not required for TLS.** Let's Encrypt has issued certificates for bare IP addresses
since January 2026, so a server with no hostname at all is certified for its own IPv4 and IPv6
addresses and browsers trust it. Address certificates are only issued under the `shortlived`
profile, which lasts 160 hours, so the renewal timer runs every six hours and renews inside the
final 72. A server that does have a usable hostname keeps ordinary 90-day certificates and is not
renewed every few days for nothing; `--include-ips` covers both in one certificate.

**Password sign-in works at a public IP address with trusted HTTPS.** A hostname is needed for
optional browser passkeys: a WebAuthn Relying Party ID cannot be an IP address literal. A server at
`https://203.0.113.9` can use password sign-in, remembered device sessions, a service worker, an
installable app, and Web Push when its certificate is trusted. See **Getting a hostname** below
if you want to add passkeys.

**Trusted TLS is required for browser sign-in.** A hostname alone does not make a self-signed
certificate trusted. Browsers also disable WebAuthn on pages carrying a certificate error. For a
home server using a private certificate, the native client's optional connection ticket pins the
server identity before password sign-in. `garden doctor` checks password sign-in and optional
passkey readiness separately.

Renewal also reissues when the served certificate is missing a configured name, not only when it is
close to expiry. Acquiring a hostname after issuance is the normal case, and no expiry check would
ever notice it. `sudo garden certificate status` prints which configured names the served
certificate covers. IPv6 address SANs are excluded from that comparison because OpenSSL prints them
fully expanded, and comparing that against the compact form would report a permanent mismatch and
reissue on every timer firing.

The certificate always carries the server's existing identity key, so the fingerprint that native
clients pinned at first pairing is unchanged by issuance or renewal. Trusted TLS and pinned identity
are not alternatives here — the same key satisfies both.

The ACME client is lego, installed on demand as a single static binary at a pinned version and
verified against a checksum recorded in `scripts/garden-certificate`. It is used rather than
certbot because certbot refuses an address identifier when the request supplies its own key, which
is exactly what preserving the pinned identity requires.

## Getting a hostname

The installer prints this when it finds no usable hostname, and `sudo garden doctor` repeats it as
a warning for as long as it is true. Warnings do not fail `doctor`: an address-only server works,
it just cannot be signed into from a browser.

```bash
sudo garden ddns configure
```

With no arguments on a terminal that asks which provider to use — DuckDNS (`NAME.duckdns.org`),
deSEC (`NAME.dedyn.io`), or Cloudflare for a domain already on Cloudflare DNS — then for the
hostname, then for the provider token with the input hidden. It then:

1. publishes this computer's current address under that name;
2. waits up to a minute for the name to resolve;
3. runs `garden set-hostname`, which moves `PUBLIC_APP_URL`, `PREVIEW_BASE_URL`,
   `PUBLIC_RUNNER_URL`, `WEBAUTHN_ORIGIN`, and `WEBAUTHN_RP_ID` onto the name;
4. reissues the certificate for the new name when automatic issuance is already on; and
5. refreshes the connection manifest and restarts the services.

Step 3 is what moves the passkey's scope onto the name. Publishing DNS alone does not: `--keep-origin`
stops after step 1 for a server that sits behind a separate reverse proxy, and `ddns status` and
`doctor` both point out that the published name is not the origin. Step 4 is the other half, and it
is conditional — on a server with automatic issuance still off, the name is in place and the
certificate is still self-signed, so browser sign-in remains impossible. `set-hostname` says which
of the two states it left the server in rather than announcing that sign-in works.

Unattended installs pass `GARDEN_DDNS_PROVIDER`, `GARDEN_DDNS_HOSTNAME`, optionally
`GARDEN_DDNS_ZONE_ID`, and `GARDEN_DDNS_TOKEN` to the installer, which runs the same path without
prompting. The token stays in the environment and is never placed in a command argument.

Passkeys already registered against the old address origin do not carry over, because they were
scoped to it. Native-client passkeys are unaffected, and the pinned server identity does not change.

Operational detail, including the per-provider address handling and the credential rules, is in
[OPERATIONS.md](OPERATIONS.md#dynamic-dns).

## Dynamic addresses

`garden-network-watch.service` listens to Linux netlink events from the kernel. It refreshes
immediately after a route, link, or interface-address change, without polling an IP service. A
low-frequency `garden-network-refresh.timer` runs every six hours (with jitter) only to reconcile a
missed event or manual file change. The refresh operation:

1. keeps the existing private identity key;
2. regenerates the address SAN list;
3. reloads Nginx only when the network set actually changed;
4. refreshes `/var/lib/garden/connection.json`; and
5. leaves user data, sessions, provider credentials, and the pairing identity unchanged.

The same non-secret manifest is available at `/.well-known/garden`. Avahi advertises
`_garden._tcp.local` with the pinned identity and follows LAN address changes.

The native client stores the identity and the non-secret endpoint set, but never persists the
first-owner code. On each cold connection it races the saved endpoints, verifies the TLS public key,
and replaces stale addresses with the signed-in server's current manifest. If they all fail, it
browses mDNS for the expected identity on the current LAN and still requires the pinned TLS proof
before accepting the discovered address. Safe/idempotent HTTP requests receive one transparent
reconnect attempt; uploads, command streams, and other non-replayable requests are never duplicated.
After total reconnect failure, the client asks once whether the public address may be dynamic. “My
address is fixed” is stored locally and suppresses that suggestion permanently. The dynamic choice
shows concise hostname/DDNS instructions and how to issue a fresh QR ticket.

### Mobile device authorization

The mobile client opens the pinned server's authorization page in the system browser. The owner
checks the code shown in both places and verifies a passkey on that server. The app redeems the
approval with an ephemeral device key and a PKCE verifier; the server creates a separate app session.
The browser's session cookie and passkey never leave the browser. Sensitive app actions use the same
flow to verify only the requesting app session. Declined, expired, consumed, or revoked requests
cannot create another session.

This mobile flow requires a stable hostname with browser-trusted HTTPS. An IP-only server with a
private certificate must be given a hostname before mobile sign-in. Desktop clients retain their
local passkey ceremony and pinned connection. Enrollment and recovery material travels only in the
authorization URL fragment, which the browser removes on arrival. It is never a query parameter or
a callback address. Requests expire, pending app requests can be cancelled, and owner authorization
and completion appear in the security event history.

Discovery behavior:

| Situation                                      | Result                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| LAN address changes                            | Client rediscovers through mDNS and verifies the pinned key   |
| Public IP changes; provider hostname follows   | Client resolves the same hostname and verifies the pinned key |
| Public IP changes; user has dynamic DNS        | Same as above                                                 |
| Client stayed connected while routes changed   | It learns the refreshed manifest before reconnecting          |
| Offline client, unknown new public IP, no name | Cannot be discovered globally without a directory/relay/DNS   |

The final row is a property of internet routing, not an garden limitation that can be hidden with
code. A remote client needs at least one stable discovery signal. garden deliberately does not add a
central directory, VPN, or relay by default because those would change the account-free privacy
boundary and disclose connection metadata. The UI explains this plainly instead of pretending that
“broadcasting to the internet” exists.

A relay is available for the one case the direct paths cannot cover — a server behind carrier-grade
NAT, where no inbound connection can arrive at all. It ships off, there is no default and no
garden-operated relay, and turning it on takes a hostname and a single-use enrollment token from
the operator of a relay the owner chose. TLS terminates on the server, so a relay operator sees
connection metadata and byte counts and no traffic. [relay.md](relay.md) opens by saying that most
owners do not need one, and recommends running your own over using someone else's.

A hosted locator is deliberately not part of garden. Even a content-blind directory would expose
connection metadata, create an operator and availability dependency, and contradict the
account-free deployment boundary. Owners who need off-site recovery after an unknown public-IP
change should use a provider hostname or a dynamic-DNS service they choose; the client still pins
the garden server key, so DNS cannot silently substitute another server.

If a server has no useful hostname, garden uses its raw IPv4/IPv6 addresses and never invents a
domain for it. It does say plainly, at install and in `doctor`, that browser sign-in is unavailable
until the server has a name, and offers `sudo garden ddns configure` as the shortest way to get
one; the choice of provider and whether to have a name at all stays with the operator. LAN changes
remain automatic. If an address-only server's public address changes while every client is offline
and away from the LAN, run `sudo garden connect` through the operator's existing recovery access
and paste the refreshed ticket. Pairing the new route cannot change the already pinned server
identity.

## AI access

### Provider API

Save an OpenRouter or compatible key in **Settings → AI**. It is encrypted before PostgreSQL storage
and is never returned. `AI_REQUIRE_ZDR=true` asks eligible routes to deny content retention; it is a
provider routing/contract property, not proof of zero billing, abuse, or network metadata.

### Codex, Claude Code, and OpenCode

Ask garden to set one up; it installs the publisher's unmodified CLI into the workspace after you
approve, and you sign in from the Terminal pane:

```bash
codex login
# or
claude
# or
opencode auth login
```

The owner completes the publisher’s device/browser flow. garden does not ask for the account
password and never reads, stores or forwards the resulting token: the subscription is used only by
the publisher's own CLI, for the coding missions garden hands it. garden's own agent uses API keys. Publisher credentials live in `/home/garden` and are therefore included in a full backup.
OpenCode supports the publisher logins described in its own documentation; Claude Pro/Max remains on
the official Claude Code integration rather than an unofficial OpenCode auth plugin.

## Installing software

Commands the agent runs execute as `garden-agent`, an unprivileged account separate from the
`garden` account the runner itself uses, so a command cannot read the runner's process, its
capability signing secret, or the browser profile the owner's logins live in. The two share a group,
which is how the runner still reads back what a command wrote. A fixed root helper permits only an
approved package-index refresh and package-name-only installs; it rejects options, paths, hooks and
shell syntax on every branch, and the package-name filter is a security control rather than a
convenience. Review and Balanced modes pause for approval. The runner rejects arbitrary privilege
escalation and shell/package-manager injection.

Programs installed this way are real host packages and survive garden restarts. GUI programs run in
the private Xvfb/Openbox session; the user opens the computer panel only when useful.

## Storage

`/home/garden` is the persistent computer. Mount large block, network, or object-backed filesystems
using ordinary Linux administration and grant only the required paths to the `garden` account and
the `garden-agent` group it shares with the commands the agent runs. garden imposes no storage
tier and does not copy a second guest filesystem.

Recovery points normally preserve the greater of 2 GB or 2% of the filesystem (capped at 20 GB) as
free staging headroom. A trusted administrator of a deliberately small host may set
`GARDEN_SNAPSHOT_RESERVE_BYTES` in `/etc/garden/runner.env` to a whole number from 67,108,864 bytes
(64 MiB) through 1,099,511,627,776 bytes (1 TiB), then run
`sudo systemctl restart garden-runner`. The create and restore paths enforce the same setting; an
invalid or dangerously low value fails closed.

## Failure rules

- Provider unavailable: tasks wait or fail; garden never falls back to a local model.
- Runner unavailable: history stays readable; computer actions fail closed.
- Browser/GUI unavailable: terminal and file tools remain available, but visual completion is not
  claimed.
- Public address changed without any discovery signal: local mDNS still works; off-site users need a
  stable hostname or the new address.
- Lost encryption key: encrypted database content cannot be recovered.
- Lost only passkey/device: sign in with the owner password, use another paired device, or use the
  recovery process.
