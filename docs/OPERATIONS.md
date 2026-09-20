# Operations

The `athanor` command is the supported operator surface.

## Routine

```bash
sudo athanor doctor
sudo athanor status
sudo athanor logs
```

`doctor` checks root-only configuration, service state (including push delivery), API and PostgreSQL
health, Nginx syntax, loopback-only private ports, served-certificate expiry, dynamic-DNS state,
whether browser sign-in is possible at all, outbound agent connectivity, managed Chromium, the
document toolchain, backup age, whether the newest backup exists anywhere but on this disk, and disk
headroom.

Lines are prefixed `ok`, `note`, `warn`, or `fail`. Only `fail` makes the command exit non-zero.

It also reports both boundaries an agent command runs inside, which used to be one. The account
boundary - "agent commands run as athanor-agent, not as the runner" - was reported and the
filesystem boundary was not, which is how a server came to answer `filesystem=landlock` from
`athanor-sandbox check` and `agentFilesystemConfined: false` from the runner at the same moment with
nothing saying so. The filesystem line is read from the runner's own health endpoint rather than
from `CONFINE_AGENT_FILESYSTEM`, because the setting is what goes wrong, and it reads three ways:

- `ok` - the runner is confining commands to their own workspace.
- `fail` - this kernel can and the runner is not; `sudo athanor update` writes the setting from what
  the kernel measures.
- `note` - this kernel or util-linux has no Landlock, so the account and network boundaries are the
  ones in force. That is a machine whose owner can do nothing about it, and it is not a failure.

A runner older than the field says nothing about it, which is reported as a note and not as either
answer.

Dynamic DNS reports one of three things: `note dynamic DNS is not configured`; `ok dynamic DNS:
NAME published through PROVIDER`; or `fail dynamic DNS has not published for two days` when the
recorded publish is older than twice the 24-hour re-publish interval. When the last publish
attempt failed, the recorded reason is repeated as a `note`.

Browser sign-in is checked from `WEBAUTHN_RP_ID`. A WebAuthn Relying Party ID must be a registrable
domain name and the specification does not allow an address literal, so a server whose origin is a
bare IPv4 or IPv6 address gets two `warn` lines: that browser sign-in cannot work, and the shortest
way to fix it (`sudo athanor ddns configure`, or `sudo athanor set-hostname NAME` when dynamic DNS
already publishes a name that is not yet the origin). This is a warning rather than a failure
because such a server is fully usable from the native clients; only the browser and the installable
app are out of reach.

The document toolchain is checked by name — the pinned Python environment and its modules, `typst`,
`soffice`, `qpdf`, `ocrmypdf`, the poppler tools, `magick`, `dot`, `ffmpeg`, and the metric-compatible
fonts — because the skill library prescribes each of them, so a gap here is a job that fails in front
of the owner instead of here. On a release that packages ImageMagick 6 the installer supplies
`magick` itself; see [Deployment](DEPLOYMENT.md#one-command-installation).

The relay gets a line of its own. `note relay: off, and that is fine` is the shipped state and the
right one for most servers, which are reached directly; it is a note rather than a warning because
nothing is missing. When the relay is on, `doctor` reports the address, the connection state, the
bytes used against the operator's allowance, and a `fail` if the operator revoked this server.
`sudo athanor relay {status|on|off}` is the operator surface; enrolling needs a hostname and a
single-use token and happens in Settings, because only the running server can redeem one. See
[relay.md](relay.md).

`doctor` also reports whether unattended updates are on; that line is informational and never fails
the run.

Monitor host disk/RAM, systemd restarts, PostgreSQL health, and failed scheduled tasks; `doctor`
reports backup age itself, and says `copied locally, not yet off-host` when a configured second copy
did not get written.
Do not put prompt or file bodies into observability.

## Install preflight

The installer refuses to start on a host with less than about 2 GB of RAM, less than 15 GiB free on
the checkout, `/var`, or `/home`, or an architecture other than amd64/arm64. It warns, without
stopping, about a small-memory host with no swap and about less than 25 GiB free.

After the services start it opens inbound 80/443/8443 in ufw or firewalld when either is active, warns
when a hand-written nftables or iptables ruleset drops input by default, warns when nothing listens
on 80, 443 or 8443, warns when this computer has only private addresses, and warns when it has no
hostname, because browser sign-in cannot work without one. Warnings are repeated with
the connection ticket, and the closing banner says "installed, but these need attention first"
instead of "ready". None of these checks can prove that a request from the internet arrives; that
cannot be tested from the host itself.

## Services

`athanor-runner.service` runs the agent computer as the `athanor` user, and the commands that agent
asks for run as `athanor-agent`, a third account with less privilege than the runner's own. The
install refuses to finish if that drop does not take effect, because a box that believes it confines
agent commands and does not is worse than one that never claimed to. `athanor@api`, `@worker`,
`@registry`, and `@notifications` run the private services as `athanor-control`, all bound to
loopback and reached through Nginx. `athanor@notifications` delivers Web Push and runs the phone
transport; its VAPID key pair is generated once at install into `/etc/athanor/control.env` and
reused on every later run, because regenerating it would invalidate every browser subscription. Its health port is 4203, fixed in code
rather than configurable, and `doctor` fails if that port is missing or reachable from anywhere but
loopback.

## Network refresh

```bash
systemctl status athanor-network-refresh.timer
sudo /usr/local/lib/athanor/athanor-network-refresh
curl -k https://127.0.0.1/.well-known/athanor
```

The timer refreshes endpoint metadata and certificate SANs when addresses change while retaining the
same private identity key. It never rewrites a hostname and never contacts a relay: it reads
`/etc/athanor/relay/settings.json` and, only while the relay is switched on, appends the relay
address to the endpoint list after every direct one. `athanor-network-refresh.path` watches that
file, so switching the relay off drops the address immediately rather than at the next timer
firing. It rebuilds the
self-signed certificate in its final month, and it leaves a certificate issued by a public
certificate authority alone: when names or addresses change it prints a line saying the renewal
timer will reissue, rather than replacing a trusted certificate with a self-signed one.

## Dynamic DNS

A hostname is not cosmetic. A WebAuthn Relying Party ID must be a registrable domain name, so a
server reached only by an IP address cannot register or use a passkey in a browser however good its
TLS is. Dynamic DNS is how a server without a domain gets one.

```bash
sudo athanor ddns configure
sudo athanor ddns configure --provider duckdns --hostname my-athanor.duckdns.org
sudo athanor ddns status
sudo athanor ddns test
sudo athanor ddns disable
```

With no arguments on a terminal, `configure` asks which provider to use, then for the hostname, then
for the token with the input hidden. With `--provider`/`--hostname` it is non-interactive and reads
the token from standard input. Automation may instead set `ATHANOR_DDNS_PROVIDER`,
`ATHANOR_DDNS_HOSTNAME`, `ATHANOR_DDNS_ZONE_ID`, and `ATHANOR_DDNS_TOKEN`; the installer passes the
same variables straight through.

| Provider   | Name you get       | Notes                                                           |
| ---------- | ------------------ | --------------------------------------------------------------- |
| DuckDNS    | `NAME.duckdns.org` | Works behind NAT; the update learns the router's public address |
| deSEC      | `NAME.dedyn.io`    | Works behind NAT the same way; non-profit, no account fee       |
| Cloudflare | a domain you own   | Needs a public address on the host itself, plus an API token    |

The Cloudflare token needs `Zone:DNS:Edit` on the zone. `--zone-id` is optional: with `Zone:Read`
as well, the zone is looked up by matching the longest zone name that is a suffix of the hostname,
and the result is cached in `DDNS_ZONE_ID`. Records are written with a 60-second TTL and
`proxied: false`, because a proxied record would terminate TLS at Cloudflare and break the pinned
server identity. A record is only rewritten when its name matches exactly, so an unrelated record of
the same type in the same zone is never overwritten.

Credentials never reach an argument list or a log. The token is read from the terminal, a pipe, or
the environment; it is stored in `/etc/athanor/control.env` at mode 0600; it is written there through
awk's environment rather than `awk -v`, because a process argument list is world-readable through
`/proc`; it is passed to the provider through a curl configuration on standard input; and curl's own
diagnostics are filtered so a DuckDNS URL cannot print its token into the journal.

`configure` publishes immediately, waits up to a minute for the name to resolve, and then makes it
the public origin by running `athanor set-hostname` — which is the step that moves `PUBLIC_APP_URL`,
`PREVIEW_BASE_URL`, `PUBLIC_RUNNER_URL`, `WEBAUTHN_ORIGIN`, and `WEBAUTHN_RP_ID` onto the name and
therefore the step that turns browser sign-in on. Pass `--keep-origin` to publish the record and leave the origin alone, which is what a
server behind a separate reverse proxy wants.

Once a provider is configured, the network refresh publishes on every netlink address event and on
its 6-hour timer. An unchanged address is re-sent once a day, so an account that lost the record
recovers by itself. A host behind NAT re-asserts every 30 minutes instead: the address it publishes
is the one the provider read from the request, so a change to it produces no local netlink event and
nothing here would otherwise notice for up to a day. Thirty minutes is still far below what any of
these providers ask for, and the state file keeps a busy netlink host from publishing per event.

The configured hostname is carried into the connection manifest endpoints and the certificate SANs.
A provider that cannot be reached is reported on stderr, recorded in `/var/lib/athanor/ddns.error`
for `ddns status` and `doctor` to show, and does not stop the endpoint and certificate refresh.

Address handling follows what each provider actually does:

- A host with a public address of its own publishes exactly that address.
- A host behind NAT has no public IPv4 to publish, so the request is forced over IPv4 with no
  address parameter and the provider records the connection address, which is the router's.
- DuckDNS stops detecting the caller's IPv4 as soon as an `ipv6` parameter is present, so a host
  that is behind NAT for IPv4 but holds a public IPv6 is published in two requests, one per family.
- deSEC deletes the record of any family it is given neither a parameter nor a matching connection
  address for, so `myipv6=preserve` is sent when this host has no public IPv6, and `myipv4=preserve`
  when it turns out to have no IPv4 path at all.
- Cloudflare has no address detection, so a host behind NAT is told plainly to use DuckDNS or deSEC
  instead of failing obscurely.
- Temporary (RFC 4941) IPv6 addresses are never published: they are deprecated within a day.

`ddns test` forces a publish, prints what the provider echoed back, resolves the hostname, and says
whether the answer already includes this computer's address or is still cached.

## Price ceiling

```bash
sudo athanor price-ceiling show
sudo athanor price-ceiling set 2 10
sudo athanor price-ceiling set none 10
sudo athanor price-ceiling clear
```

`spend-ceiling` was the old name for this and still answers, printing the new one. It is not the
same command as `spend-cap`, which is the money cap the old name sounded like.

The pre-flight half of the spending brake, and the half that works while nobody is watching. The
daily, monthly and per-task caps in Settings watch what a task has already spent and halt it once it
is over; this refuses to _pick_ a model priced above the rates named here in the first place. Both
rates are dollars per million tokens — `set 2 10` means at most $2 per million in and $10 per million
out — and either may be the word `none`.

Every place garden selects a model for the owner ranks against it: the lead when a task is created,
the vision specialist, the model the picker recommends, and the support picker behind titling and the
subscription flows. When the ceiling leaves nothing eligible, selection is refused with the cheapest
route that could have done the work and what it costs, rather than quietly substituting something
weaker or reporting the model as unavailable. A model the owner names explicitly is never
constrained: the ceiling governs what garden chooses for them, not what they choose for themselves.

`show` prints the ceiling currently stored. Changes take effect on the next selection; a task
already running keeps the model it was given. On a server whose database predates the column, both
`show` and `set` say so and change nothing rather than validating a number and storing it nowhere —
a control wearing a brake's name while wired to nothing is the exact failure this command exists not
to be.

## Backup

A daily backup is enabled by the installer and needs no attention:

```bash
sudo athanor backup auto status
sudo athanor backup auto off
```

It runs at a randomised hour and waits a few minutes for the worker to go idle before starting,
because the archive stops the services for its duration. A run that finds work in progress stands
down and leaves the next window to take the copy. `doctor` reports the age of the newest one.

To take one immediately, or to write it somewhere specific:

```bash
sudo athanor backup
sudo athanor backup /mnt/encrypted-backups/athanor-2026-07-30
```

Mutating garden services pause under a restart trap. A backup contains:

- `database.dump`;
- `workspaces.tar.gz` for `/home/athanor`;
- `configuration.tar.gz` for `/etc/athanor`;
- `packages.txt` for additional operating-system packages installed through garden; and
- `SHA256SUMS`.

The configuration archive contains the keys required to decrypt the database; the workspace archive
contains files, browser state, installed user-scoped tooling, and publisher logins. Package binaries
are not duplicated into the archive: a clean restore validates `packages.txt` and reinstalls those
packages from the host's own configured repositories.

### An off-host copy

Everything above lands in `/var/backups/athanor`, on the same disk as the data it is a copy of. That
survives a mistake and it does not survive the disk, which is the commonest way a one-box server is
lost outright. Name a second place, on a disk this one failing does not take:

```bash
sudo athanor backup destination /mnt/backup-disk --recipient /root/backup-key.pub
sudo athanor backup destination show
sudo athanor backup destination off
```

Every backup is then encrypted to that recipient with `gpg` and copied there, after the services are
back, so the copy costs no downtime. A copy that fails does not fail the backup: the verified local
copy is complete either way, and `sudo athanor doctor` says which of the two happened rather than
reporting a green backup that exists in exactly one place.

The recipient is not optional. `configuration.tar.gz` carries this server's data key and session
signing key, so a copy of a backup is a copy of everything the product protects; the reason that is
tolerable in `/var/backups` is that the disk it sits on already holds those keys, and a copy that
leaves the machine has no such excuse. **Keep the private half of that key somewhere this computer is
not.** Without it nobody can open the off-host copies, including you.

The destination is a path this computer can already write to: a removable disk, a NAS mount, anything
mounted. It does not speak ssh, rsync, S3 or any provider's API, and that is a decision rather than a
gap - a credential on this box that can write to the destination can also delete what is already
there, so a server that is broken into loses every copy at once. If that trade is wrong for you,
`sudo athanor backup /path` has always written a copy wherever you say, and `cron` and `rsync` are
yours to point at it.

A destination on the same filesystem as `/var/backups/athanor` is refused when it is configured,
rather than discovered to have been pointless after a disk failure.

## Restore

```bash
sudo athanor restore /path/to/backup --yes
```

Restore accepts only the fixed backup filenames, verifies strict checksums and archive paths,
reinstalls the recorded approved packages, replaces the current database, home, and identity
configuration, fixes ownership, restarts services, waits for API health, and refreshes the connection
manifest and certificate names. It is destructive by design: make a separate backup first.

For a recovery rehearsal on an isolated machine, use:

```bash
sudo athanor restore /path/to/backup --yes --keep-stopped
```

This restores the database, files and keys while leaving Garden stopped. It skips runtime repair,
package downloads and connection refresh, so copied tasks and schedules do not resume during the
restore. Verify the recovered data before bringing it online; this mode does not establish service
readiness. It cannot be combined with `--new-host` or `--hostname`, which restart services. It does
not disable service activation on a later reboot. For a rehearsal, isolate the machine from external
networks, stop its maintenance timers and discard the restored copy after verification. Use the
ordinary restore command when recovering a server that should resume work.

To restore an off-host copy, decrypt it first with the private half of the key it was encrypted to,
then restore the decrypted directory:

```bash
cd /mnt/backup-disk/20260901T030000Z
for encrypted in *.gpg; do gpg --decrypt --output "${encrypted%.gpg}" "$encrypted"; done
sudo athanor restore . --yes
```

`SHA256SUMS.encrypted` beside them lists the checksums of the encrypted files, so you can confirm the
copy arrived whole without holding the key. `SHA256SUMS`, decrypted with the rest, is what the
restore itself verifies.

## Recoverable version archives

Project history offers an archive preview and restore controls. Archiving preserves the version's
place in history and its files in project-local recoverable storage; it does not reclaim disk space.
The head, pins, baseline inputs, unfinished updates, live commands and open downloads prevent
destructive maintenance. Restoration can proceed alongside running readers because it only returns
an absent public version tree.

If the job controller cannot verify input protection, leave its work running. The archive preview
reports that maintenance is unavailable until a compatible controller is active. Do not force a job
restart to enable cleanup. An uncertain native lease remains protective until process teardown is
verified.

After an interrupted archive or restore, the affected version remains visible with recovery
controls. Retrying uses the saved identity; restoring refuses conflicting destination files or
content that fails verification. Keep the private retention manifests and content together in
backups. Removing them manually defeats recovery and is not a supported disk-cleanup procedure.

The owner API reconciles an interrupted archive or restore against the runner's durable operation
identity before completing its response receipt. Changed request parameters cannot reuse that
identity. A stale preview reports the conflict and asks for a fresh preview; other rejected runtime
requests retain their status and a redacted explanation. Unknown upstream responses remain generic.

## Moving to a new computer

The backup carries `/etc/athanor` verbatim, which is what has to happen: the data key, the session
signing key and the pinned server identity all come back exactly, or the restored server cannot open
its own database and no paired client trusts it. `PUBLIC_APP_URL`, `WEBAUTHN_ORIGIN` and
`WEBAUTHN_RP_ID` come back with them - and on a different computer those three name the old one. Tell
the restore that the computer has changed:

```bash
sudo athanor restore /path/to/backup --yes --new-host
```

Without a name of its own, that re-derives the origin from the address the new machine actually has,
refreshes the connection manifest and the certificate's addresses, and restarts. If the domain
followed the machine - the record already points at the new box - the name is kept rather than
replaced by an address, because replacing it would throw away every browser passkey bound to it.

With a name that does not point here yet, or a new one:

```bash
sudo athanor restore /path/to/backup --yes --hostname ai.example.com
```

The whole move, on a machine that has just been built:

1. Run the one-command installer on the new machine - the exact line is in `docs/DEPLOYMENT.md`
   under "One-command installation" - so it has PostgreSQL, Nginx, the units and the checkout.
   Passing `ATHANOR_HOSTNAME` here is wasted: step 3 replaces the whole of `/etc/athanor` with the
   backup's copy, so the name has to be set after the restore rather than before it.
2. Copy the backup directory onto it, decrypting it first if it came from an off-host copy.
3. `sudo athanor restore /path/to/backup --yes --new-host` - add `--hostname NAME` if this machine
   should answer to a domain.
4. `sudo athanor connect` for a ticket and QR carrying the new addresses. Paired clients hold the old
   ones; the server identity survived in the backup, so they still trust this server and their
   passkeys still work.
5. A passkey made in a browser is bound to the origin it was made on. If the origin changed, add
   those again from a client that still signs in.
6. `sudo athanor doctor`.

Restore also reinstalls the managed browser revision excluded from the backup. If that download
fails, the restored data remains available and the command reports that browser work cannot run.
`sudo athanor update` retries the download; `sudo athanor doctor` checks the installed revision.

Nothing in step 3 is fatal after the data is back: a name that does not resolve yet from a machine
plugged in ten minutes ago prints what to run and leaves the restored server serving.

## Update

```bash
sudo athanor update
```

Backup, update, restore and rollback share a root-owned kernel lock. A competing maintenance
command stops before changing services or files; nested backup and rollback phases keep the same
lock until they finish. The lock is released with the operation, including failure or termination.

Update refuses a dirty managed checkout, pauses mutating services, makes a checksum backup,
fast-forwards the Git checkout, installs the locked dependencies, builds source, updates native
helpers/systemd/Nginx definitions, refreshes network metadata, and waits for health. If any step
fails, it resets the managed checkout to the previous revision, reinstalls that runtime, and restores
the pre-update backup before returning a failure. Keep the backup until login, history, files,
browser, GUI, and one model call pass.

### What an update carries besides code

Between the build and the restart, `athanor update` runs `scripts/install-native.sh --release-steps`
from the revision it has just pulled. That covers the three things a release carries that are not
compiled:

- **Operating-system packages.** Every package in the capability table for this host's family, so a
  release that adds one installs it on an existing box rather than only on a fresh one.
- **Workspace layout.** The permissions the agent account needs, and the move of the agent's HOME
  into `<workspace>/.home`, which is what keeps a signed-in coding CLI signed in across an upgrade.
- **Runner settings.** Every key in `/etc/athanor/runner.env` except the generated shared secret,
  including `CONFINE_AGENT_FILESYSTEM`, which is written from what `athanor-sandbox check` measures
  on this kernel rather than from a preference.

Until this existed an update ran the three build steps and nothing else an install does, so those
three arrived a release late or not at all. On the server this was found on, the Landlock boundary
had shipped present and switched off, two Python packages in the table were missing, and `doctor`
was telling the owner to run an update that would not have installed them.

The required native activation phase runs after those release steps. It verifies the lockfile's
language servers, installs the pinned Python libraries and JavaScript debugger into separate caches,
checks the process supervisor, and validates the shared sudo policy before its atomic replacement.
A missing dependency or failed integrity check prevents activation and rolls the update back.
Incomplete downloads never replace active tools. Completed environments remain available for
offline native-tool recovery, including the initial environment at
`/usr/local/lib/athanor/python-before-managed` when the installation began with a directory there.

Accounts, generated secrets, certificates and the database cluster are not recreated. Node itself is
also not upgraded by this phase. Failure of an optional operating-system package step is reported;
failure of required native activation is fatal. The database is restored only if the new release
has started and may have run migrations; failures before that point leave the database alone.

Use the exact backup path printed by the update to revert an activated release:

```bash
sudo athanor auto-update off
sudo athanor rollback /path/to/the/pre-update-backup
sudo athanor doctor
```

Rollback validates the backup and recorded Git commit before stopping services, then restores both
the source revision and checksummed data. A failed rebuild or data restore leaves the server stopped
and preserves the backup. It requires the old Git
commit and its JavaScript dependency/build inputs to remain available; the native caches alone do
not make the entire source rebuild offline. Native tools are kept at their completed, verified
versions and are not downloaded again while their cache is intact. A native compatibility issue can
be investigated against the retained previous environment without overwriting either copy. Keep the
backup and previous caches until browser sign-in, task execution, file delivery, and native tool
checks pass. Uninstall removes only native caches with garden completion receipts and preserves the
initial Python environment and unrelated operator directories.

## Unattended updates

```bash
sudo athanor auto-update status
sudo athanor auto-update on
sudo athanor auto-update off
```

Off by default. `on` enables `athanor-auto-update.timer`, which runs weekly at a randomised time and
catches up after downtime. Each run is the same transactional `athanor update` described above,
including the backup and the automatic rollback.

The run stops early and changes nothing when the timer is disabled, when the checkout is already at
the upstream revision, when a task is still running after waiting up to 30 minutes for the worker
to go idle, or when the runner reports unfinished background commands; the next weekly window
retries. A worker that cannot be reached counts as idle.

### What an update stops, and what comes back

An update stops the server for the backup and rebuild, including the workspace runner and its
commands. Recovery depends on how the work was declared:

- A **declared service** is relaunched from its saved record.
- A **foreground command** belongs to a task; active tasks hold the update off.
- A **finite job** retains its identity, bounded logs, result and any explicitly requested deadline. An interrupted
  job resumes only through its declared checkpoint recovery command. Without one it remains
  interrupted and preserves partial files. Completed, cancelled and expired jobs do not restart.
- An **ordinary background session** cannot resume after the supervisor stops. Polling its old
  session id reports that the process was not found.

Both manual and unattended updates check unfinished background work as well as active tasks.
Manual updates refuse and name the running work; unattended updates defer to their next window.
`ATHANOR_UPDATE_OVER_BACKGROUND_WORK=1` is an explicit operator override. A runner too old to report
background work produces a warning because the updater cannot establish that the workspace is idle.

For recoverable finite work, use `shell(background=true, job=...)` and declare a
`checkpointResumeCommand` that safely continues the application's saved checkpoint. Approval
covers that deferred command too. The checkpoint must be written by the application; Garden does
not reconstruct arbitrary interpreter memory or extend the original job deadline. Keep important
results in workspace files even when a job has a recovery command.

The unit files are installed on every install and update but are never enabled by them, so the
choice survives updates.

## Uninstall

```bash
sudo athanor uninstall
```

Uninstall disables garden services, the network watcher, the unattended-update timer, the
certificate renewal timer, and its Nginx site, and removes the `/etc/sudoers.d/athanor-packages` rule that let the agent account install
system packages as root, the Avahi advertisement at `/etc/avahi/services/athanor.service`, and the
`magick` compatibility command if the installer had to supply one. It preserves `/home/athanor`, `/etc/athanor`, PostgreSQL data,
and backups. Removal of preserved data is a separate, explicit operator action.

## Schedules that stop running

Two bounds make a schedule go quiet on purpose. Both write a code the schedule row carries, so read
`lastErrorCode` before assuming anything is broken.

- **`previous_run_active`.** The occurrence was skipped because the schedule's own previous run had
  not finished. A schedule does not run beside itself: before this policy, an interval watcher
  slower than its own interval started a second copy, then a third, each holding a compute
  reservation and each spending the provider account on the same instruction, with the row reading
  healthy throughout. The skip retries five minutes later - the same defer delay `workspace_starting`
  uses - and is not a failure. It is not fifteen seconds: the scheduler polls every
  `SCHEDULER_POLL_MS`, which defaults to fifteen seconds, but a deferred schedule sets its own next
  occurrence five minutes out, so a schedule carrying this code is waiting rather than stuck. It
  becomes a failure only when the blocking run has been untouched for more than a day, at which
  point the schedule is paused and an owner-visible notice is written on the conversation that is
  blocking it. Finish or cancel that conversation and turn the schedule back on.
- **Run now is refused rather than skipped.** The rule above is for a clock. An owner pressing Run
  on a schedule whose previous run is still open is answered `409 previous_run_active` at the button,
  naming the run that is in the way - not deferred, and not recorded as a failure on the row. The
  owner is not exempted from the overlap policy, because an exemption is the same duplicate spend
  the policy exists to prevent and the button gives no way to see that a run is already open. To
  start a second run deliberately, end the first - open it and let it finish, or cancel it - and
  press Run again. Pause and resume are not affected: pausing a schedule whose run is open is
  exactly what an owner does about it.
- **`model_unavailable`.** Three consecutive runs could not start because the model the schedule
  names is no longer available. Choose another model - a schedule keeps the model it was created
  with, so this means a new schedule - and turn it back on.

## Inbound triggers

A schedule may carry a webhook, which is the only way something other than the owner or a clock
starts a turn on this box. `docs/HEADLESS.md` has the request shape. Operationally:

- The URL is `POST /v1/hooks/<43-character segment>` and it is unauthenticated in the sense that it
  carries no session and no bearer token. What authorises it is an HMAC-SHA256 signature over its
  own timestamp and body, keyed with a per-schedule secret this box generated and keeps only sealed
  under the workspace key. A request without a valid signature inside a five-minute window is
  refused before anything is written.
- **There is no way to recover a lost signing secret.** It is served once, in the reply that created
  the schedule. Revoking one and rotating one are the same operation: delete the schedule and make
  another.
- Deliveries are rate-bounded twice. `minGapMinutes` - fifteen by default, the same floor
  `interval` uses - bounds how often a trigger may start a run, and a burst inside one gap produces
  one run that reads all of it. Sixty deliveries an hour and sixteen unread deliveries are the
  bounds on rows and workspace files; past either, the sender is answered `429`.
- Payloads land in `workspace/downloads/inbound/<scheduleId>/`, which is inside the download
  quarantine, so an agent reading one is treated as having read untrusted content. **Nothing prunes
  that directory.** A busy trigger grows the workspace over time; it is ordinary workspace storage
  and is deleted like any other file.
- `journalctl -u athanor@api | grep schedule.trigger_delivery` reports every delivery and its
  outcome - `accepted`, `duplicate`, `rate_limited`, `too_many_pending` or `not_armed`. It records
  no payload and no signature. The size of the backlog is not in the journal; it is in the `429`
  the sender is answered with, which says how many deliveries are unread and how many bytes they
  come to.
- A trigger run's payload files are written into the workspace before the run is queued, and a
  restart in between is finished by the maintenance sweep - which writes exactly the deliveries that
  run's instruction already named, not whatever has arrived since. Grep the journal for
  `schedule.dispatch_recovered` to see that sweep doing it. Deliveries that arrived while the box was
  down are untouched and stay pending for the next occurrence.

## Phone transport

Beside Web Push, a notification can reach the owner's phone through a bot on the Telegram Bot API.
It needs no app installed by garden - the phone runs the service's own client - and it is two-way:
an approval card arrives with Approve and Deny buttons, a question the agent asked arrives as a
message to reply to, and both are acted on from the phone. Operationally:

- **It is not end-to-end encrypted, and the owner is told so in Settings.** A bot's chat is a cloud
  chat: what a card carries transits the service's servers and is readable there. By default a
  card is therefore _redacted_ - the conversation's name and a link into garden, nothing else -
  and the buttons carry an id and a nonce, never content. With redaction switched off, a card also
  carries the class of thing an approval asks for (never the command itself; the service never
  holds the key to it) and the sentence an agent chose to send. That sentence is the agent's own
  words and can quote what it read, so the default stays on unless the owner decides otherwise -
  and switching it off asks for the passkey, as binding the phone did, because it is the one
  switch that widens what leaves the box. Every send has forwarding protection on and link
  previews off.
- **Pairing binds one numeric sender.** The owner creates a bot with BotFather, pastes its token
  into Settings, and opens the pairing link on the phone - a one-time secret of 32 random bytes,
  stored only as a SHA-256 hash, good for ten minutes and for one use. The phone that presents it
  is the sender every inbound decision is checked against: the numeric sender id, never a username
  and never a chat id, and never from anything but a private chat - and checked against the row
  as it stands at that moment, so minting a new pairing link in Settings shuts the previous phone
  out at once. A tap from any other sender is refused and recorded in the owner's security events
  as `destination_inbound_rejected`. The bot is findable by anyone on the service, so that record
  has a ceiling: twenty refusals are written, then one more every five minutes, and a refusal
  past the ceiling is still refused and is counted on the next event written
  (`unrecordedBefore`). The pairing link is served once, in the response to the request that
  minted it, and is not kept in the idempotency ledger the other write routes use.
- **A decision from the phone is the same decision as one from the web client.** The tap runs the
  approval route's three store calls in its order, so the first answer wins wherever it came from,
  and the card is edited to show the outcome and lose its buttons - also when the decision was made
  in the web client, from the command line, or by the deadline. An answer typed to a question is
  posted to `/v1/tasks/:taskId/messages` over loopback with an API token minted at pairing, so
  unparking the conversation and idempotency are that route's.
- **The bot token and the paired sender are sealed under `DATA_MASTER_KEY`** with the row's own
  id in the context, like the other secrets in this database, and neither is served again by any
  route or written to any file - the sender is also the chat every message is addressed to, so a
  copy of the table names neither the account nor the address. The API token minted for answering
  is sealed beside them and revoked on unpair.
- **A lost phone:** unpair in Settings, which deletes the destination, its ledger and the API
  token; then `/revoke` the bot's token in BotFather, which is the one credential this box cannot
  revoke for you. A new token and a new pairing link replace the phone; the old sender has no
  standing with the new bot.
- **Network:** long polling needs outbound HTTPS to the bot API and nothing inbound - no public
  URL, no open port, no certificate. `TELEGRAM_API_BASE_URL` in `/etc/athanor/control.env` has one
  real value and exists so a test can point the service at a stub. One poller runs per bot token;
  running the service twice against one database would make the two steal each other's updates.
- **Journal:** `journalctl -u athanor@notifications | grep notification.destination_` -
  `_delivery_failing` when the bot API refuses a send (retried with a growing wait, capped at half
  an hour, never retired), `_outcome_failed` when it refuses the edit that writes a decision onto
  a card (the same wait, shared with sends, so a failing bot API never holds the push sweep
  behind it) and `_outcome_unwritable` when the card itself is gone, `_poll_failed` and
  `_poll_stalled` for the inbound side, `_inbound_flood` when refusals stop being recorded one by
  one, `_unreadable` when the sealed configuration does not open under this box's key,
  `_inbound_failed` when one update could not be handled, `_answer_failed` when the task route
  refused a reply, and `_ignored` for a message that was neither a pairing nor a reply. No line
  carries the token.
- **Doctor:** `sudo athanor doctor` reads `destinations.telegram` off the health port and says
  "phone notification transport" when a paired phone is being polled, or warns when it is paired
  and not. `/metrics` on 4203 adds `athanor_notifications_destination_delivered_total`,
  `_destination_failed_total`, `_inbound_total`, `_inbound_rejected_total` and
  `_inbound_poll_age_seconds`.

## Sharing

An owner can hand out a read-only link to one conversation. Operationally:

- The link is `/v1/shares/<22-character id>#1.<key>`. The server holds the SHA-256 of the id and a
  snapshot encrypted under the key; the key is in the fragment, which a browser never sends, and it
  is nowhere on the server. A database dump or a backup therefore carries share rows nobody can
  open without the link that made them. There is nothing to rotate and nothing to leak from the
  rows themselves.
- `SHARING_ENABLED=false` in `control.env` turns the feature off: every public share route answers
  the same 404 an unknown link gets, existing links included, and the owner's own routes refuse to
  make one. Setting it back to `true` (or removing it - absent is on) restores the existing links.
- Revocation is the owner's, from the conversation's share dialog: one link, or every link on the
  conversation. An operator who needs every link on the box closed at once can run
  `UPDATE task_shares SET revoked_at = NOW() WHERE revoked_at IS NULL;` against the database; the
  public lookup refuses a revoked row in its own statement, so the effect is immediate.
- Closed and expired rows are swept a month after they closed; the artifact bytes of a revoked
  link go at once. Deleting a conversation deletes its links.
- `journalctl -u athanor@api | grep 'share\.'` reports `share.created`, `share.revoked` and
  `share.revoked_all` with row ids and sizes. It records no content, no link, and nothing about
  readers; a read is a count and a time on the row, and that is all the server knows about it.
- The viewer page is built with the web app (`apps/web/dist/share/`) and served by the API from
  `/v1/shares/assets/`. `SHARE_VIEWER_DIR` points the API elsewhere if the two are deployed apart;
  a link opened when the files are missing shows a page that says the viewer is not built. The
  native nginx block proxies `/v1/` as a `^~` prefix so that `share.js` and `share.css` reach the
  API rather than the static-asset location; a page that stays at "Opening…" on a hand-edited
  server block is that prefix losing to the regex.
- Two throttles, both answering 429: 120 requests a minute per address across the page, its
  assets, the ciphertext and the artifacts together (one open of a link carrying the maximum fifty
  files is fifty-four requests), and 600 ciphertext and artifact reads a minute box-wide, whichever
  addresses they come from. Neither records the address past the minute it counts.

## Incident priorities

1. Stop access with the firewall or `sudo athanor stop`.
2. Preserve existing logs without enabling content collection.
3. Snapshot affected storage only when policy permits.
4. Rotate model, connector, session, publisher, runner, and host credentials according to scope.
5. Restore onto a clean host when compromise is plausible.
6. State what was exposed and what remains uncertain.

## Common failures

- **API unavailable:** inspect `journalctl -u athanor@api` and PostgreSQL.
- **Runner unavailable:** inspect `athanor-runner`; history should remain readable.
- **GUI unavailable:** verify Xvfb, Openbox, D-Bus, AT-SPI, and screenshot paths.
- **Codex/Claude unauthenticated:** use Terminal and the publisher status/login command.
- **Provider setup required:** save a key/model in Settings.
- **Preview unavailable:** verify the user process, loopback port, preview state, path base, and HTTPS 8443 firewall/router forwarding. The isolated preview listener must reject garden API and runner paths; `garden doctor` checks the local listener.
- **Passkey origin mismatch:** restore the original public origin; do not repeatedly rewrite it.
- **Push notifications missing:** run `sudo athanor doctor`, which distinguishes a service that is
  not answering from one that is running with no Web Push signing keys, and both from one that is
  sending with nobody enrolled to receive: the health port reports `endpointsTotal` and
  `destinationsPaired` beside `endpointsFailing`, and `doctor` warns "no device or phone is
  enrolled for notifications" when both are zero, says `ok push notification delivery` only when
  at least one exists and none is refusing, and reports a count the service could not make as
  unknown rather than as zero. A missing key pair does not
  stop the unit — it disables delivery and says so, because a crash-looping unit hides its own
  reason. Confirm the `PUSH_VAPID_*` values in `/etc/athanor/control.env` and inspect
  `journalctl -u athanor@notifications`. This covers browsers and installed web apps only: the
  packaged desktop and mobile clients hold no push subscription and raise notices through the
  operating system themselves, so a phone that is quiet while a browser is not is a client-side
  permission rather than a server fault.
- **A quiet iPhone:** check the phone before checking the box. Safari on iOS has no `PushManager`
  in an ordinary tab, so there is nothing to subscribe and nothing the server can send to. The
  repair is on the phone and takes one gesture: Share, then Add to Home Screen, then open garden
  from there. Settings says so on an iPhone rather than reporting the browser as incapable. Below
  iOS 16.4 there is no Web Push even on the Home Screen, and there is no repair on that phone: the
  packaged client holds no push subscription either and raises its notices from a poll inside the
  page, which a suspended app does not run.
- **Nothing reached the owner at all:** two transports exist and each needs the owner's half.
  Web Push needs a subscribed device, which an iPhone in a Safari tab, a browser that refused a
  self-signed certificate, and a device whose endpoint was retired after a day of refusals all
  lack. The phone transport needs a paired phone: Settings, "Your phone", and a bot token. An
  owner with neither is offered nothing, of any kind, however much is waiting for them - the
  candidate set selects on the owner's events and joins them to the owner's targets, and with no
  target there is no candidate. All of it leaves the standing record intact: what the agent
  raised is in Settings and in each conversation. A box that is down is reported by neither,
  because the notifier that would say so is on it.
- **A paired phone gone quiet:** `sudo athanor doctor` reports "a phone is paired for
  notifications but the service is not reading from it" when the health port says `paired` and
  not `polling`. The one cause is `DATA_MASTER_KEY`: the bot token is sealed under it, and a
  service holding a different key - or none - can neither send with it nor poll for taps. Then
  `journalctl -u athanor@notifications | grep notification.destination_` for the line that names
  the destination and the refusal.
- **Changed address:** inspect `/.well-known/athanor`, timer state, mDNS, provider DNS, and firewall.
- **Dynamic DNS stale:** run `sudo athanor ddns status`, which prints the last recorded provider
  error, then `sudo athanor ddns test` to force a publish and see the provider's answer.
- **Browser sign-in impossible:** `doctor` warns when the origin is an IP address. Run
  `sudo athanor ddns configure`, or `sudo athanor set-hostname NAME` when a name is already
  published. Native clients are unaffected either way.
- **Certificate missing a new name:** `sudo athanor certificate status` prints
  `Configured names:` and names anything the served certificate does not cover. The renewal timer
  reissues within six hours; `sudo athanor certificate issue` does it now.
- **Low disk:** stop long jobs, back up, expand/mount storage, and restart.
