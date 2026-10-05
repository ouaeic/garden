# Security policy

## Report a vulnerability

Use the repository host’s private vulnerability-reporting feature. Include affected revision, impact,
synthetic reproduction steps, and a proposed mitigation if available. Never put real credentials,
browser cookies, private files, database extracts, recovery material, or user prompts in a report.

Maintainers aim to acknowledge reports within three business days and provide an initial severity
assessment within seven. Security fixes target the current release line.

## Threat model

garden is designed for one owner. Registration closes the moment the first account is created —
there is no setting that reopens it — and claiming the server needs the single-use pairing token the
installer prints, which expires and can be rotated with `sudo garden pairing-code`. There is no
sharing model, no roles and no second party to authorize against. It is not a hardened hostile multi-tenant compute service.
Anyone with root access to the host, control of the configured operating-system package
repositories, live process memory, or an unencrypted backup can compromise the installation.

The relevant adversaries are:

- unauthenticated network clients;
- a stolen or revoked client session;
- prompt injection in webpages, repositories, documents, MCP results, or terminal output;
- a malicious or compromised external provider;
- a compromised agent subprocess;
- a relay operator, when the owner has enrolled with one: they control DNS for the relay domain, so
  they can point the relay hostname at a machine of their own and read everything a browser client
  sends over that path, though native clients pin the server identity key and are unaffected;
- accidental destructive actions; and
- credential or content leakage through logs, URLs, notifications, or previews.

## Security invariants

- The web app is the public application surface, and the one exception is written down rather than
  implied: Nginx publishes a fixed path allowlist of runner routes — the terminal socket, and
  `stream`, `action` and `holder` for each of the browser and the desktop — because a live view of
  the computer cannot be proxied through the API without buffering it. Every one of them is
  regex-anchored to a single workspace UUID and every one requires a capability token. Nothing else
  on the runner, and nothing at all of the database, is reachable from outside; `action` and
  `holder` are control routes rather than streams, which is why they are named here individually
  instead of behind the word "stream".
- The second exception is share links, and it is written down on the same terms. `GET
/v1/shares/<id>`, `/v1/shares/<id>/blob`, `/v1/shares/<id>/artifacts/<n>` and
  `/v1/shares/assets/*` answer without a session, and they are the only content routes on this
  box that do. What they serve is ciphertext: a snapshot of one conversation, sealed under a key
  that exists only in the fragment of the link the owner was handed once. No workspace key, no
  session and no owner identity is on the row; `<id>` is stored only as its SHA-256 and compared in
  constant time; the request hook returns before the session lookup, so these routes neither read a
  cookie nor set one; every one of them is throttled per address through one bucket sized for a
  reader, and the two data routes share a box-wide ceiling; a closed, expired, malformed or unknown link and a box with sharing switched
  off answer one identical 404. Making a link takes recent identity verification; what the link shows is an
  allow-list of kinds with the tool arguments, tool results, reasoning and every identifier left
  out unless the owner switches the first two on; the credential net runs over all of it.
- The first account claims the server; registration then closes by default.
- Passwords or optional passkeys, origin checks, secure cookies, revocable sessions, and recent-authentication checks guard
  owner settings.
- Generated previews use a separate browser origin from the owner application. The preview
  gateway verifies the configured public host, port and protocol before serving content; a
  same-origin development configuration retains an opaque sandbox. Cookies are not port-scoped,
  so the gateway strips owner credentials and refuses generated applications' attempts to replace
  them. Preview service workers are confined to the published preview path. Applications on the
  shared preview origin can use their own storage and same-origin requests; different previews
  sharing that origin are not isolated from one another. Private links remain bearer capabilities.
- Workspace requests require capability tokens. Every one is signed, bound to one workspace and one
  subject, scoped to the routes it may use, and rejected past its expiry — which is 90 seconds for
  the worker's own tool calls and never more than 900 seconds for anything, whatever a signer asks
  for. The interactive terminal is the one credential minted at that 900-second ceiling, and
  deliberately: the runner closes the socket when the capability expires, so a shorter life killed
  shells mid-command rather than reducing anyone's blast radius.
- Every capability additionally names the request or requests it was minted for, and is refused
  against any other — so one observed on a stream cannot be turned against a control route. A token
  that names no request at all is refused everywhere, rather than admitted on its scopes. The
  worker's own tokens name one request each; the browser and desktop credentials name the three
  routes their pane spends them on and nothing else — not the browser's arbitrary-URL fetch, not its
  search.
- A capability is spent once. Every HTTP route consults a nonce ledger and refuses a replay. The
  terminal's `renew` frame arrives inside an already-open socket and so never reaches that hook; it
  consults a ledger of its own, so a captured renewal cannot re-arm this shell or any other the owner
  has open. It is also checked against the session it would extend — same owner, same workspace, same
  role, same scope, same audience — and a renewal that does not match is ignored rather than
  honoured.
- Task content, plans, events, schedules, memory, skills, connector credentials, and provider keys are
  encrypted at rest.
- Application logs, metrics, and connector audits intentionally exclude prompts, replies, file
  contents, screenshots, browser text, terminal output, URLs with tokens, and secrets.
- Notifications are the deliberate exception, because a notice with no content is not a notice. One
  carries the conversation's own title and, when the agent asked for the owner's attention, the
  sentence the agent wrote — a reply excerpt by construction. It never carries file contents,
  screenshots, terminal output, browser text or credentials. On the Web Push path the whole payload
  is encrypted to the subscription's own key, so the push relay that carries it reads none of it;
  the packaged desktop and mobile clients hold no push subscription and raise the notice through the
  operating system from data they already have, so nothing leaves the connection to the owner's own
  server at all.
- Provider and connector credentials never enter a model prompt.
- Browser/desktop secure-input mode stops agent observation and actions until the user hands control
  back.
- External submissions, messages, purchases, public publishing, destructive operations, ambiguous
  coordinate clicks, subscription-agent missions, and every MCP tool execution pass approval policy.
- Untrusted content cannot alter system policy, approval rules, or credential boundaries. Nothing in
  a tool result reaches the security mode, the approval requirement other than by raising taint, or
  any credential.
- Labelling is narrower than that and is worth stating exactly, because the difference is what an
  attacker would look for. A connector, mail or MCP read arrives wrapped as
  `{provenance, trust:"untrusted", origin, content}`. A web search, a page read, a browser snapshot,
  a delegated specialist's report, a shell command that reached the network, a background process's
  output, and a file read out of the download or mail quarantine directories are classified by the
  call that produced them rather than by a wrapper around the bytes. A file read back out of a
  repository the agent cloned earlier is judged on the clone, not on the read — so a turn that only
  reads such a file is not tainted by it.
- Remote WebDAV and MCP endpoints require HTTPS on port 443 with no credentials in the URL, public
  DNS addresses only, a lookup pinned to the addresses that were checked, redirect denial, bounded
  request and response bodies, and timeouts. The host itself is allowed because the owner named it
  when connecting; `CONNECTOR_ALLOWED_HOST_SUFFIXES` narrows which mail and calendar hosts may be
  reached at all, and ships empty, which leaves the owner's own choice standing.
- No local model server, model weight, or inference GPU is installed by garden.
- An owner-selected local model connection may use HTTP on loopback or a private LAN IP. This
  per-connection choice does not grant agent tools additional network access. Such an endpoint
  is reached by the server and may itself forward requests; it is not proof of local data retention.
- No secret is committed, baked into an image, or returned after initial token issuance.

## Native host boundary

The agent computer is the installed Linux host. Shell commands, background processes,
publisher CLIs and software started through the shell run as `garden-agent`, an unprivileged
account separate from the runner's `garden` account.

The installed GUI broker creates a private user, mount, PID, IPC and UTS namespace for each
execution workspace. It runs as `garden` with no capabilities and `NoNewPrivileges`; it does not
receive the runner's environment or a sudo grant. Its private Unix socket checks the peer identity,
accepts only validated execution roots, and holds one namespace for the lifetime of a runner lease.
A disconnected runner releases its keepers. Browser and desktop leases share their own namespace,
while transient research uses a fresh namespace and profile.

The mount view contains that workspace, selected read-only system resources, and private scratch
and device mounts. Other workspaces, service configuration and host processes are absent. Held
directory descriptors prevent path replacement from changing the workspace selected for a bind.
The launch helper validates held process identity, joins its namespaces, drops capabilities and
sets `no_new_privs` before executing any GUI application. Landlock scope prevents connections to
outside abstract Unix sockets; desktop D-Bus uses a private pathname socket. GUI environment
variables contain desktop and locale settings rather than runner credentials, and namespace
handles are removed before application entry. The native entry requires Linux user namespaces,
bubblewrap, Python namespace APIs and Landlock scope support; setup failure does not fall back to
an unconfined GUI.

Chromium also requires its renderer sandbox, including headless research. The desktop uses the
common approval policy and command checks. Network connections retain the host network policy;
these namespaces do not create separate project IP networks. Kernel compromise remains outside
this application boundary. The credential-bearing runner keeps its existing service restrictions;
the separate broker needs the complete parent proc mount to create a private proc filesystem.

Shell commands reach their separate account through a
root-owned helper that only ever hands back less privilege than it was called with, and that sets
`no_new_privs` — which is inherited by every descendant and cannot be removed, so a set-user-ID
binary confers nothing no matter which interpreter spelled the command.

On a host whose kernel and util-linux can do it, that identity boundary carries a filesystem one on
the same exec line: a Landlock ruleset that admits the task's own `workspace/` and its agent `$HOME`
at `.home` for writing, the system directories for reading and running, and `/tmp`, `/var/tmp` and
`/dev/shm` for scratch. `/home` is granted nowhere, and that omission is the boundary. Every workspace on the box is group-writable
by the agent account, so without it a command run for one task could read and rewrite every other
task's files, and could rename the runner's own `.garden` directory - the checkpoints, the browser
profile's parent - out from under it. Re-measured on a 7.0 kernel with util-linux 2.41.3 after
`$HOME` moved to `.home`: reading a neighbouring workspace, reading or writing `.garden`, renaming
`.garden`, listing or writing anything in the container root, moving a file out of the container -
into that root, into a neighbour or into an ungranted `/tmp` - and reading anything through a
symbolic link that points outside the grant all fail, while the command's own `workspace/` and
`.home` are writable, renames between those two succeed, `echo x > /dev/null` and `2>/dev/null` work,
and `/etc/resolv.conf` still resolves through `/run`. `pip`, `npm`, `pnpm`, `git`, a pty and a
sixty-four-way parallel write are unaffected, at a cost of about 10 ms on a 145,403-file `find` over
`/usr`. What that measurement does not establish: it was run against a stand-in root under `/tmp`,
because `/home/garden` is not writable by an account a drill may use, so no ruleset in it was ever
applied to a real workspace - and the shipped helper hard-codes the parent those workspaces live
under, so the drill exercised the mechanism rather than the installed helper. What it does
establish, and the reason the deny cases mean anything at all: every one of them was re-run with the
ruleset removed and came back permitted, so it was the ruleset that refused and not ordinary Unix
permissions.

The two grants inside a task's own directory are named one by one, and the directory that holds them
is not. That is what keeps `.garden` — the checkpoints, the artifact store, the browser profile's
parent — out of reach while the two directories beside it are writable. The agent's `$HOME` is one of
them and it sits outside `workspace/` deliberately: `workspace/` is what the turn checkpoint walks
and hashes, and a single Rust toolchain is 88,021 files against a 250,000-file ceiling that, once
crossed, costs the turn its rewind point. **A rewind therefore does not restore `$HOME`.** The
project tree goes back; the toolchain caches and the coding CLIs' sign-in state stay as the failed
run left them, for the same reason the browser profile is excluded from checkpoints — rolling a
session back signs the account out.

It is a rung and it says which rung it is on. The installer runs `garden-sandbox check`, which
reports `filesystem=landlock` or `filesystem=none`, and writes `CONFINE_AGENT_FILESYSTEM` in the
runner's environment from that answer rather than from a preference; `/healthz` reports
`agentFilesystemConfined` from the sandbox the runner actually resolved, not from the setting it was
given. A kernel that cannot apply a ruleset gets the identity and network boundaries and says so,
because a host that fails every command is worse than one that confines fewer of them. The owner's
own interactive terminal is deliberately never confined.

What it is not: it does not stop a command reading `/etc`, `/usr` or `/proc`, which it needs in
order to run anything at all; it does not bound how much a command writes, which is the host-disk
floor's job - and the per-workspace storage figure covers `workspace/`, the artifact store and the
browser profile but deliberately not `$HOME`, so a toolchain cache is bounded by that floor alone;
and it is applied when the command starts, so a command already running in a workspace
races the check that its `workspace/` and its `.home` are real directories rather than symbolic
links somebody substituted. Closing that race means the workspace root ceasing to be agent-writable,
which the move of `$HOME` into `.home` makes possible — nothing creates entries directly in that
root any more — and which nothing has yet done.

A command is also bounded in time, and it is worth being exact about what that bound is for, because
it is easy to read it as the thing standing between the box and a runaway and it is not. A
foreground command may run for `MAX_EXECUTION_SECONDS`, an hour by default, chosen to sit inside the
worker's own request timeout. A background command may run for as long as it declared, up to
`MAX_BACKGROUND_SECONDS`, a day by default; an owner can raise it, and raising it now raises what
the box will actually run. A declared service has no deadline at all. What actually holds a runaway
are the bounds that are not clocks: the runner unit's memory ceiling, its task limit, the per-command
limits on memory, processes and open files, and the host-disk floor, which is polled while the
command runs and stops it with a sentence saying why. The clock bounds a job nobody will ever come
back for. So raising it for a forty-hour genome assembly does not lower any of the boundaries above,
and a job that hits the ceiling is killed with its reason on its own stderr, keeps whatever it had
already written to a file, and **is not resumed** - nothing on this computer restarts a background
command where it left off, across a deadline or across a restart.

They can intentionally read and change workspace files, which the two accounts share through a
group, and can communicate with networks reachable from the host. They cannot read the root-owned
control configuration, the database keys, or the runner's capability secret: that secret is removed
from the environment once the runner has read it, and the runner's `/proc` entry is not readable
from another account. The browser profile stays owner-only, so a command cannot read the cookie jar
for sites the owner signed into during a takeover. The installer verifies at install time that a
command really does land on the agent account, and stops rather than come up believing it confines
commands when it does not.

The database refuses local-socket connections for the application role, so a command cannot use
peer authentication to open the database as the owner of every encrypted row. Access needs the
password held in root-owned configuration.

Direct `sudo`, `su`, and `doas` execution is rejected. An approved package-index refresh or
package-name-only install passes through a root-owned helper that rejects options, paths, hooks, and
shell syntax. Package maintainer scripts still execute as root, so approving a package extends trust
to the host's configured package repositories and to that package.

The API, worker, registry, media, and notification services run as a separate `garden-control`
account under systemd hardening and cannot read `/home/garden` directly. They reach the runner over a loopback-only
port using short-lived, task/workspace-bound capabilities. PostgreSQL and every application service
other than Nginx remain loopback-only; Nginx is the sole public application gateway.

`ISOLATE_AGENT_NETWORK=false` is the shipped default, and the reason is a trade rather than a
limitation: the sandbox helper can put a command in its own network namespace, and the installer
checks that the kernel allows it, but a command isolated that way also gets its own loopback, so
nothing outside it — the preview proxy included — can reach a port the command is listening on.
Turning it on therefore costs published previews. With it off, garden records network intent and
applies approval policy, but an allowed process can use the host's ordinary network access.
Operators who want the stronger boundary can turn it on, or dedicate the machine and enforce
ingress and egress at their host or cloud firewall.

## The two dials

An owner sets two independent things. Neither is a position on the other, and this section says so
plainly because the natural request is for a single slider from “careful” to “let it run”, and that
is not what this is.

**What the agent computer is allowed to be.** A ladder, and the installer measures which rung this
host is on rather than taking a preference for it.

- _No sandbox helper._ Commands run as the runner's own account, with no identity boundary and no
  filesystem one. This is a developer laptop with no second account to drop to, and the runner says
  so instead of pretending otherwise.
- _`AGENT_SANDBOX_HELPER` set._ Commands run as `garden-agent` with `no_new_privs`, so a
  set-user-ID binary confers nothing, but they still reach every file that account can reach -
  including every other task's workspace.
- _`CONFINE_AGENT_FILESYSTEM=true`._ The same exec line also carries a Landlock ruleset: this task's
  `workspace/` and `.home` writable, the system directories readable, `/home` granted nowhere - so
  a neighbouring workspace and the runner's own `.garden` stop being reachable at all.
- _`ISOLATE_AGENT_NETWORK=true`._ The command additionally gets a network namespace of its own. It
  ships off, because that namespace has a loopback of its own and published previews then stop
  answering.

**When it stops and asks you.** Three positions, each one everything the position below it asks
about plus more.

- _Autonomous_ authorizes browser, desktop and native mail/calendar actions for the requested task,
  including uploads, form submissions, sending and calendar changes. Existing account grants still
  limit access. CAPTCHA, private input and provenance checks still apply. Other tools retain their
  external, destructive and durable-operation approval rules.
- _Balanced_ also asks before consequential browser and desktop actions, commands reaching the
  internet, and software installation.
- _Review_ is Balanced plus a card in front of every command, every file written, and every browser
  or desktop action.

**Keys beyond the mode.** The owner can also lend four keys - spend, publish, remove and rules - on
the computer as a standing default for new goals, through a deal, or on one goal. Each answers in
advance the cards the mode still raises for that kind of consequence: priced media and
transcription spending; public links, deploys, registry publishes, uploads and services others can
reach; removals outside the undo point, store destruction, forced pushes and deletes in connected
services; schedules, memory, skills, services and anything set to run later. A card names the keys
that answer it, all of which must be lent, and a merged card keeps a key only when every part of it
names one. A card raised because the turn read untrusted content names no key, so nothing a page,
document or message says can spend one; private input, signatures, CAPTCHAs, stopping the computer,
credentials in memory and unpriced spending name none either. Every action a key allowed is written
to the approvals table as approved by the key before it runs. Lending is the owner's: API tokens
cannot change keys on a goal or on the computer.

The authoritative wording of all three is `SECURITY_MODE_FLOOR` in
`apps/worker/src/approval-common.ts`, used by the branches that enforce it and is held
against the page the owner reads by `scripts/check-repository.mjs`. It is deliberately not restated
here in full: three descriptions of this behaviour once existed in three files and had drifted
apart, and a fourth copy in a document no check reads is how that happens again.

**Permissions for the current run.** Eligible cards offer approval once or a reusable permission
whose programs, referenced network origins, or project directories are shown before selection.
The owner session can grant only the scope sealed by the worker; API tokens cannot create reusable
permissions. Grant creation and approval settlement share a transaction. Scope bodies are encrypted,
and matching uses a keyed digest bound to the owner, task, turn and approval mode. Each new proposal
still passes the complete approval floor; an additional requirement without a reusable scope keeps
its individual decision. Referenced origins are a static command constraint, not a per-host runtime
firewall for arbitrary interpreter code.

Permissions survive pauses and reconnects. A new owner direction does not inherit the preceding
turn's permissions, and completing or stopping a run or changing its approval mode revokes them.
They do not transfer into forks or specialist tasks. Work options lists the current permissions and
allows revocation. Revocation stops future reuse; it does not undo an action already approved or
interrupt a process already running.

### Why two dials and not one

Each ladder is ordered on its own, so either could be a slider. Joining them into one cannot be
done honestly, because they answer different questions: the sandbox decides what a command is
_able_ to do, and the mode decides what you are _asked_ about. A rung of one does not stand in for
a position of the other, and the concerns underneath them - local file churn, network egress, and
what gets installed - do not dominate each other, so a single slider would assert an order the code
does not have. Spend is a fourth thing again, with its own ceiling.

### They do not compose, and that is measured rather than assumed

The approval floor does not read which sandbox rung this host is on. A card is raised identically on
a confined box and an unconfined one, and there is no setting that trades one for the other.

That is a deliberate gap rather than an unfinished one. Driven through `evals/cards` - ten ordinary
owner tasks, 178 tool calls - Balanced raises 18 cards and Autonomous 12, and the filesystem
boundary retires none of them. They are: sending a message through a connector; installing a
subscription coding CLI and handing it work; publishing a site; a Git push and two commands that
reach another machine; creating a scheduled job; keeping a background service running; installing
software; and two writes to the agent's own `$HOME` - a shell startup file and a Git hooks path -
which the ruleset grants precisely so that `pip`, `cargo` and `npm` can work at all. The one card
that looks retirable is `apt-get install`, and it is not: an approved package install is rewritten
onto the root-owned package helper and runs with no ruleset at all, because it needs the runner's
identity to reach `sudo`. Review's cards are a promise that you see what your computer is doing, which a kernel
boundary is not a reason to withdraw.

There is also a trap worth naming, because it is what a future version of this composition would
walk into. Measured on a 7.0 kernel with util-linux 2.41.3: `rm -rf $ROOT/workspace` under the
shipped ruleset _exits non-zero_, because removing the directory entry itself needs a right granted
nowhere - and it still empties the tree first, because everything inside it is writable. A refusal
from the kernel is not evidence that nothing was destroyed. The full argument, and what would have
to change for the two dials to be worth joining, is recorded beside `ApprovalContext` in
`apps/worker/src/approval-policy.ts`.

## External trust boundaries

- The configured model provider sees inference content and service metadata according to its terms.
- Codex CLI and Claude Code store publisher OAuth state inside the persistent workspace home and
  communicate directly with their publishers.
- MCP, GitHub, WebDAV, destination websites, DNS, certificate authorities, push relays, and network
  operators see the data required to perform their service.
- A connection relay, once enrolled, sees the server's label, the addresses of the server and of
  every device that connects to it, byte counts and connection timings. It sees no traffic: TLS
  terminates on the server, so no URL, header, token or message is readable there. It ships off,
  there is no default and no garden-operated relay, and enrolling takes a hostname and a
  single-use token from an operator the owner chose. [docs/relay.md](docs/relay.md) sets out both
  halves in full.
- Browser logins and cookies live in the persistent browser profile.
- Generated files can contain sensitive model output or source content.

“No content logging by garden” is not “no metadata anywhere.”

## Backups and recovery

`garden backup` pauses mutating services, dumps PostgreSQL, archives `/home/garden` and
`/etc/garden`, records the additional packages the owner approved, and writes checksums. The backup contains
encryption keys, browser state, publisher logins, installed user tooling, and user files, so it is as
sensitive as the live server. Store it in an operator-provided encrypted destination and off-host,
then test `garden restore` before depending on it.

Losing `DATA_MASTER_KEY` makes encrypted records unrecoverable. Rotating or replacing
`/etc/garden/control.env` without a coordinated migration can cause permanent data loss.

## Hardening checklist

1. Patch the host and reboot when kernel/security updates require it. Any of the four supported
   distribution families is fine; the installer and `garden doctor` both know which one this is.
2. Expose only SSH as needed and Nginx on 80/443; use `garden doctor` to verify every private service
   remains loopback-only.
3. Restrict SSH, disable password login where practical, and protect the server provider account.
4. Rotate an unused pairing ticket after accidental disclosure: `sudo garden pairing-code`.
   Registration closes on its own once an owner exists and cannot be reopened by configuration.
5. Do not rewrite the passkey origin after owner registration. Native clients follow address changes
   by the pinned server identity.
6. Keep custom connector and MCP hosts to the minimum required.
7. Review model-provider retention and training settings; keep `AI_REQUIRE_ZDR=true` where supported.
8. Store backups encrypted and off-host, with access independent of the server being recovered.
9. Run `garden doctor`, dependency/secret scans, content-log canaries, and restore drills after
   upgrades.
10. Do not install untrusted skills, MCP servers, coding agents, or packages merely because a webpage
    asks.
11. Leave the connection relay off unless inbound connections cannot arrive at all. If one is
    needed, run your own rather than someone else's, and prefer the native clients on that path:
    the operator controls DNS for the relay domain, which a browser cannot defend against.
    [docs/relay.md](docs/relay.md).

## Native dependency advisory

The Linux native client inherits `glib` through Tauri's GTK bindings. Its compatible dependency
line is covered by [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html), an
unsound implementation of `VariantStrIter`. Garden does not directly call that iterator or
`Variant::array_iter_str`. The patched `glib` release belongs to a different GTK binding family
and cannot be substituted as an isolated version override. The dependency alert remains open;
re-evaluate it before a stable Linux native release or when changing native variant handling.

## Out of scope

Physical access to an unlocked client, deliberate host-root compromise, behavior of third-party
services, model-quality disagreements, CAPTCHA bypass, bot-defense evasion, and unauthorized testing
of other systems are not vulnerabilities in this repository.

Managed project Git operations use private, Garden-owned repositories and fixed system Git
commands. Source configuration and hooks are never copied into those repositories; bundles import
objects and references. The adapter disables hooks, filesystem monitors, inherited system/global
configuration, credential prompts, automatic maintenance and transport protocols. Source file
content is length-delimited and path bytes are quoted before the streaming Git import. Owner
repository controls and downloads require the registered project working area and signed scopes.
A branch-history download reads a captured commit through an independent temporary repository;
its object alternate refers only to the same managed repository. Open downloads retain a lock
until the response closes, so cleanup cannot remove their files in flight.

Conversation-history capture runs inside the existing command sandbox with network isolation and
an additional read-only Landlock layer. The permitted executables are the fixed system Git binary,
its object packer and their ELF loader. Hooks, filesystem monitors, alternate-reference commands,
packing hooks, inherited system/global configuration and transport protocols are disabled explicitly. The only new
project file it can write is a private history bundle through a pre-opened descriptor; working-copy files and indexes
cannot be changed by the capture. Managed import holds the regular-file descriptor, checks its
identity for concurrent changes, verifies object connectivity and binds the advertised commit before
retaining a reference. Neither repository configuration nor a history bundle grants network or
external-write authority.

Remote Git is a dedicated connected-account boundary. It accepts only fixed GitHub HTTPS URLs
assembled from validated owner and repository names, with redirects disabled and TLS verification
enabled. Its transport explicitly enables HTTPS; other managed Git operations retain disabled
protocols. Source configuration, hooks, credential helpers, signing and recursive submodule
transports are not inherited. A connection needs repository read access and a separate explicit
repository publishing grant for pushes. No existing grant is widened by enabling this feature.

Signed capabilities separate fetch, push, inspection and cancellation and bind agent requests to
the conversation's registered project and working area. Agent pushes pass the approval floor;
owner UI requests are authenticated and show the exact destination and commit. Only commits bound
to published project versions are eligible. Fast-forward ancestry and an explicit expected-head
lease protect remote history. Transfers retain intent before network writes and never repeat an
ambiguous push during recovery. Tokens exist only in the trusted transport child's environment;
provider diagnostics are replaced with credential-free status. Fetched bundles remain untrusted
content and confer no command or publication authority.

### Password sign-in and recovery

Owners may use a password or a passkey. Passwords use salted, memory-hard scrypt hashes;
password guesses are throttled both by caller and by a persistent account-wide bucket. Authentication
opens a remembered, revocable device session. Sensitive settings accept recent password or passkey
verification; a session alone cannot change the password after that verification window expires.

The installer pairing code can create the first owner with either method. Existing owners can add a
password in Settings, redeem their recovery code, or run `sudo garden password-reset` on the host.
That command creates an expiring, single-use setup link; issuing it does not change existing access.
Redeeming recovery rotates the recovery code and revokes previous sessions, passkeys, API tokens and
device invitations. Password changes from Settings sign out other devices. Credentials and setup
codes are never included in account responses or security-event metadata.
