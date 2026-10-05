# garden

[![Verify](https://github.com/ouaeic/garden/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/ouaeic/garden/actions/workflows/verify.yml)
[Beta downloads](https://github.com/ouaeic/garden/releases) · [Help](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

**One private AI computer, available from every device.**

garden is free, open-source software that turns a Linux computer into a persistent AI
agent. You hand it goals. Anything substantial comes back first as a deal: what it will make, how
you will know it is done, what it should cost, and which keys it may hold, such as acting as you or
spending up to a cap. Once you plant it, the work goes on quietly with the machine’s files,
terminal, browser, installed GUI applications, long-running processes and hosted previews, and
comes back to you only for what it was not lent. One record keeps everything that left the
computer, and the computer itself stays out of the way until you want to watch it.

garden has no hosted account, paid tier, VPS marketplace, telemetry service, model server, or local
inference fallback. Model access belongs to the owner: use OpenRouter, a key from Anthropic, OpenAI,
Google, xAI, Mistral, DeepSeek or another listed model company, Ollama Cloud, any other
OpenAI-compatible endpoint including an owner-installed Ollama server, Codex with a ChatGPT subscription, Claude Code with a Claude
subscription, or OpenCode with a publisher login it officially supports. Any number can be connected
at once; the model picker groups every connected model by who made it and names the connection it
travels through.

See [local models and LAN connections](docs/LOCAL_MODELS.md) for Ollama setup, same-network access
and server GPU statistics.

The app and command are named `garden`. Existing `garden` commands, installation paths,
and device identities remain supported, so an update preserves the same computer and access.

## Start with the beta

Use the latest **prerelease** on [Releases](https://github.com/ouaeic/garden/releases) for the
current desktop and Android downloads and its exact, pinned server installation command.
Beta downloads require no app-store account. Desktop builds may show operating-system trust
prompts; [beta client details](docs/BETA_CLIENTS.md) explain signing and notification limits.

Install the server, connect your model access, then open its address in a browser or native app.
Sign in with your password; passkeys are optional. A native app remembers your server and device
session. For a home server with a private certificate, the optional connection ticket establishes
its identity.

Share setup questions and beta feedback in [Discussions](https://github.com/ouaeic/garden/discussions),
or use the [bug form](https://github.com/ouaeic/garden/issues/new?template=bug_report.yml).

## Install

The commands below select the tagged release line. For the current beta source revision, use the
pinned command on its prerelease page or the app's installer. An installed server can move
forward through `sudo garden update`.

On a fresh Debian, Ubuntu, Fedora, RHEL, Rocky, AlmaLinux, Arch or openSUSE computer:

```bash
curl -fsSL https://raw.githubusercontent.com/ouaeic/garden/v0.2.0/install.sh | sudo env GARDEN_REF=v0.2.0 sh
```

The command is pinned to a tag rather than a branch. The install actions in the web and native clients go
further: they pass the exact commit their own build was made from, and the installer refuses to
continue if the source it checked out is not that commit.

That command installs the computer, and native clients pin the server’s own key. For browser
access, configure trusted HTTPS for the server's public IP address or hostname. You can sign in with a password;
optional passkeys also require a domain name and a secure browser context. If a domain already
points at the server, configure it during installation:

```bash
curl -fsSL https://raw.githubusercontent.com/ouaeic/garden/v0.2.0/install.sh | sudo env GARDEN_REF=v0.2.0 GARDEN_HOSTNAME=your.domain GARDEN_ACME_EMAIL=you@example.com sh
```

`GARDEN_ACME_EMAIL` is the contact address the certificate authority is given, and supplying it is
how the subscriber agreement is accepted — garden will not accept it on the operator’s behalf, so
without that variable no certificate is requested. Install without them and nothing is lost: the
installer explains the remaining certificate setup. `sudo garden certificate enable` enables
trusted HTTPS; `sudo garden set-hostname` adds an optional domain name. `sudo garden doctor`
reports certificate readiness. See [home servers and direct addresses](docs/relay.md) for
changing addresses, router forwarding and connections behind carrier-grade NAT.

From a checked-out source tree:

```bash
sudo ./install.sh
```

The installer refuses to start unless the host has enough RAM, disk, and a supported architecture,
so a machine that cannot finish is told before packages are installed rather than half-way through.

The native client also has a quiet **Install on a cloud server** action on the sign-in
screen. It connects directly from the client to SSH, shows the server’s SHA-256 host-key fingerprint
for confirmation, keeps the password or key passphrase only in client memory, runs the same fixed
installer, and imports the returned connection ticket. No garden website or relay receives the SSH
secret. Browsers cannot safely open raw SSH, so the PWA shows the command instead.

The installer gathers the computer’s usable addresses, installs its dependencies as ordinary host
packages — plus the three pinned pieces no distribution carries at these versions: the `typst` typesetter against a
recorded SHA-256, a hash-locked document Python environment, and Chromium at the revision the
lockfile’s Playwright carries — builds garden, creates isolated service accounts and keys, starts
systemd services, opens the existing HTTPS gateway on ports 80/443, and prints the address of the
computer, a QR code that opens it on a phone, and an expiring, single-use owner code. It does not
ask for a domain, unpack a machine image, start a container, create a VM, or install a VPN.

SSH is needed only to run the install command and for recovery. Normal clients connect directly to
garden over HTTPS.

## Connect

Open the address the installer printed in a browser, or scan its QR code with a phone — the code is
an ordinary `https://` link to the computer, so any camera opens it and the owner code travels in
the fragment. In the native app, enter that server address and sign in with your usual password.
A trusted HTTPS certificate verifies the first connection, after which the app pins the server's
identity and remembers the connection. For a home server with a self-signed certificate, use the
optional connection ticket instead. The installer prints a ticket containing:

- every useful endpoint detected at install time;
- the server’s stable cryptographic identity;
- local mDNS discovery information; and
- the expiring first-owner code.

The identity is independent of an IP address. The native client probes saved addresses concurrently,
pins the server public key, refreshes the address set from `/.well-known/garden`, retries safe
requests after an address change, and runs `_garden._tcp.local` discovery alongside saved-address
probes. Private LAN routes get a short head start over public routes. A
newly discovered address is accepted only after it proves the same pinned identity.

Dynamic addresses work automatically on the same LAN through mDNS and off-site when the host has a
stable provider hostname or dynamic-DNS name. There is no protocol trick that lets an offline,
off-site client discover an unknown new public IP without some stable name or rendezvous service.
If every saved route fails, the native client asks once whether the address might be dynamic. It can
remember that the address is fixed and never ask again, or show a short dynamic-DNS recovery path.
garden does not silently add a relay, VPN, or tracking directory; see
[Deployment](docs/DEPLOYMENT.md#dynamic-addresses).

## What is built in

### Agent computer

- Native execution as a dedicated unprivileged `garden` Linux user.
- Persistent home, files, Chromium profile, installed programs, and publisher CLI logins.
- Foreground and background commands with timeouts, output bounds, polling, cancellation, and
  explicit network intent.
- Named services the computer keeps running: no timeout, restarted with backoff if they die, and
  still there after the machine reboots — which is what a link the agent hands the owner needs in
  order to still answer in the morning.
- Approval-gated host package installation through a narrow root helper; arbitrary `sudo`, `su`,
  `doas`, and package-manager injection are rejected.
- Repository map, fast search, symbols, diagnostics, conflict-checked patches, and verification.
- Chromium control using semantic elements and screenshots.
- Xvfb/Openbox Linux desktop with AT-SPI accessibility control and visual fallback.
- Human takeover for login, CAPTCHA, secure input, ambiguous controls, or any action the agent should
  not complete alone.
- Files, screenshots, images, audio, video, documents, code, tables, Markdown, and private app
  previews delivered on the task surface with browser links and scoped downloads.
- Private, bounded extraction and source-linked BM25 search for PDF, Word, PowerPoint, spreadsheet,
  OpenDocument, HTML, CSV, and text collections already on the computer—with phrase, title,
  coverage, and result-diversity ranking, without uploading or duplicating them into a vector
  database.

### Agent behavior

- Task-specific progress built from plans, tool receipts, checks and real outputs, with no
  additional model calls to narrate or decorate the work.
- Prompt editing as a new trajectory, retry, branches, replay-safe events, cancellation, and
  reconnection across devices.
- Review, Balanced, and Autonomous security modes with a non-bypassable safety floor.
- Encrypted task history plus reviewed, compact durable memory with provenance and validity windows,
  so superseded or time-sensitive facts do not silently remain active forever.
- Saved skills: procedures the owner approves are resident as one indexed line each, and a full
  procedure is loaded when the agent opens it.
- One-time, interval, daily, weekly, and advanced five-field cron schedules with IANA time zones.
  Schedules can be edited, paused, resumed, run now, or removed and keep working while clients are
  offline.
- A request assembled for the cache as much as for the model: the operating contract, then the
  active memory entries and the index of saved skills, then the recalled memory pack,
  then the workspace brief, then the request and the trajectory, then the current plan — and last of
  all a hidden runtime block naming this computer, the time in the owner’s own time zone, the
  working root, the commands and modules installed for documents and data, the security mode, and the
  preview gateway. The runtime block is last because it is the only part that changes during a task,
  and anything that changes early re-bills everything behind it.
- Capability-aware model routing: a lead model without vision receives bounded observations from the
  best eligible vision model and remains responsible for the result.
- Notifications to the owner's own devices for an approval, a finished task, a paused spend, a
  notice the agent decided to raise, and a page only a person can get past. Browsers and installed
  web apps receive them over Web Push; the packaged desktop and mobile clients, which have no push
  subscription, raise them through the operating system themselves. Every kind has its own switch
  and a switched-off kind is dropped by the server rather than hidden by the phone; quiet hours
  still let an approval through, and everything the agent has said is kept in one list across
  conversations.

### Models and specialist tools

- Every chat model the owner's own provider account can reach, so a model released after this build
  appears without a garden update. `MODEL_CATALOG_SCOPE=reviewed_open_weight` narrows selection to
  models carrying an independent open-weight licence review.
- Stable prompt prefixes use provider caching where available, with actual cached usage reported
  by the provider.
- Bounded retry with backoff on transient provider failures, and a request deadline, so one 429 or a
  hung provider does not end a long task.
- Live OpenRouter model metadata, modalities, context windows, price estimates, route privacy, and
  zero-data-retention eligibility.
- Direct keys from the listed model companies: Claude over Anthropic's own Messages protocol (signed
  thinking, tool use and prompt caching carried across), OpenAI over Responses, and the rest over
  chat completions with the request fields each one refuses left out. Ollama Cloud and generic
  OpenAI-compatible endpoints work the same way. Optional local models connect to a runtime the
  owner installs; garden never downloads weights or silently switches providers.
- Codex CLI, Claude Code, and OpenCode as bounded coding specialists using the owner’s publisher
  login. Publisher sessions persist in the same backed-up agent home.
- Integrated writable coding specialists use isolated working copies, bounded allocations and
  conflict-checked owner review before integration. Native language servers, persistent Python and
  JavaScript computation, and [debugging](docs/NATIVE_DEBUGGING.md) share the workspace and approval
  boundaries.
- Zero-retention provider mode fails closed for model inference and voice transcription; publisher
  CLI retention remains a separate policy and is never mislabeled as the provider’s ZDR route.
- Provider-backed image, speech, transcription and asynchronous video routes are discovered from
  the connected account. Compatible editing, references, provider libraries and batch controls
  appear with their advertised capabilities. Retained provider work requires explicit approval;
  uncertain submissions remain recoverable without automatic resubmission.
- Native audio and video input can be submitted to an eligible selected model through the
  approval floor, with exact source identity and bounded spending. Unsupported formats, models or
  prices are refused before uploading.
- [Dictation](docs/VOICE_AND_DICTATION.md) reviews its model, cost and retention before recording.
  [Live voice](docs/LIVE_VOICE.md) uses a supported native provider account, with owner-confirmed
  task proposals and durable charge recovery.
- Scoped GitHub and WebDAV connections, the owner’s own mailbox over IMAP with SMTP submission, and
  their own calendar over CalDAV — open protocols against their own server, with reading, marking
  and sending as separate scopes and every send stopping for approval.
- Remote MCP Streamable HTTP with no-auth, bearer, or standards-based OAuth discovery,
  protected-resource metadata, PKCE S256, resource binding, rotating encrypted tokens, SSRF/DNS
  protections, response limits, and user confirmation.

## One computer, not a workspace manager

The interface presents one persistent computer. An internal workspace ID remains as an authorization
and encryption boundary, but the owner does not create, price, or resize a collection of cloud
machines. Storage is the host’s storage; compute is the host’s compute; model inference remains at the
chosen provider.

## Server commands

```text
sudo garden doctor
sudo garden connect
sudo garden pairing-code
sudo garden start
sudo garden stop
sudo garden restart
sudo garden status
sudo garden logs
sudo garden backup [directory]
sudo garden restore DIRECTORY --yes
sudo garden update
sudo garden rollback [directory]
sudo garden auto-update {status|on|off}
sudo garden certificate
sudo garden ddns
sudo garden set-hostname NAME
sudo garden price-ceiling {show|set INPUT OUTPUT|clear}
sudo garden spend-cap {show|set DAILY MONTHLY|clear}
sudo garden spend-ceiling ...                 # the old name for price-ceiling; still answers
sudo garden relay {status|on|off}
sudo garden uninstall
```

`price-ceiling` is the pre-flight half of the spending brake, and it was called `spend-ceiling`
until the release that added the other half; the old name still answers and tells you the new one.
It refuses to pick a model priced above the rates you name, which is the half that works while you
are asleep. Both rates are dollars per million tokens - `sudo garden price-ceiling set 2 10` means
"at most $2 per million in and $10 per million out" - and either may be the word `none`. A model you
choose by name is never constrained by it: the ceiling governs what garden picks for you, not what
you pick for yourself.

`spend-cap` is the running half: what a day and a month may cost you in dollars, which is what
actually halts a task. `sudo garden spend-cap set 5 100` is "at most $5 a day and $100 a month",
and either may be `none`. It is the same setting as the caps in Settings, on the command line,
because an owner setting a headless server up over ssh has no browser open yet. `sudo garden doctor`
says which caps are in force every time it runs.

`certificate` requests a publicly trusted certificate for the existing server identity key, so the
pinned client identity is unchanged. It is a separate command rather than part of install because
issuing one accepts a certificate authority's subscriber agreement, which garden will not do on
the operator's behalf without being asked. `ddns` keeps a chosen hostname pointed at a changing
public address, and `set-hostname` moves the public origin onto a name that is already published.

`auto-update` is off by default; turning it on runs the same transactional update weekly, with the
same backup and automatic rollback. `relay` reports and switches a connection relay, which ships off
and is only for a server no inbound connection can reach. Enrolling with one happens in Settings,
because only the running server can redeem an enrollment token. See
[Operations](docs/OPERATIONS.md) for the full surface.

`uninstall` disables garden but preserves `/home/garden`, `/etc/garden`, PostgreSQL data, and
backups. See [Deployment](docs/DEPLOYMENT.md) and [Operations](docs/OPERATIONS.md).

Backups contain the database encryption keys, server identity, browser profile, publisher logins,
and user files. They also record the additional packages the owner approved, so a clean host can
reinstall them. Store backups in an operator-provided encrypted destination and copy them off-host; garden
never uploads them.

## Architecture

```text
web / PWA / native clients
                 |
       direct HTTPS on 443
                 |
          nginx + API
            /       \
   encrypted DB     worker
                       |
             native Linux runner
           /        |        |       \
        files   Chromium   desktop   terminal
                       |
            owner-selected AI services
```

Private services listen only on loopback. Nginx is the sole public application gateway. The runner is
authenticated, is never exposed directly, and does not contain an inference server.

## Privacy

garden does not intentionally put prompts, replies, screenshots, browser text, terminal output, file
contents, credentials, or generated assets in application logs. That is not the same as zero
observation: the machine host, model provider, destination websites, connected tools, certificate
authority, DNS, and network operators receive the content or metadata required to provide their
services.

Read [Security](SECURITY.md), [Privacy](docs/PRIVACY.md), and the
[capability audit](docs/CAPABILITIES.md) before exposing a computer to the internet.

## Development

Node 24 and pnpm 11 are required — the pinned pnpm refuses to start on anything older, and the
server installer provisions Node 24 for the same reason.

```bash
cp .env.example .env
# .env ships with placeholders that the services refuse to start on. Three need real values:
printf 'DATA_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >>.env
printf 'SESSION_SIGNING_KEY=%s\n' "$(openssl rand -base64 32)" >>.env
printf 'RUNNER_SHARED_SECRET=%s\n' "$(openssl rand -base64 32)" >>.env
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the web client, the API, the worker and the workspace runner together, and each
service reads `.env` from the repository root. A development database is not required: with
`DATABASE_DRIVER=pglite`, which `.env.example` sets, the stack keeps its data in `.garden/postgres`
under the repository.

Open `http://localhost:5173` and run the full source verification with:

```bash
CI=true pnpm check
pnpm license:rust
pnpm release:check
```

The production installer and native services are Linux-only today. The open-source Tauri client
targets Linux, macOS, Windows, Android, and iOS. A tag-driven workflow builds desktop packages, a
universal Android APK/AAB, and an iOS IPA into one checksum-manifested draft release. It fails closed
unless protected macOS, Windows, Android, and iOS signing credentials are configured and every
platform artifact passes its post-build audit. No release is claimed as published here; see
[Releasing clients](docs/RELEASING.md).

## Independent implementation

garden is an independent implementation. Its code, prompts, and interface are its own, and it is
not affiliated with or endorsed by any provider it can connect to. Product names appear only to
identify services the owner may choose to use. See
[Third-party notices](THIRD_PARTY_NOTICES.md).

## Sign in with a password

Create your owner account with a password and the installer pairing code. Passkeys are optional.
On another device, open your Garden address and sign in with the same password. Device sessions
stay signed in and can be revoked from Settings → Access.

For an existing account, add a password in Settings → Access or choose **Recover access** with your
saved recovery code. If you cannot sign in, run this on your server:

```sh
sudo garden password-reset
```

Open the temporary setup link it prints. Choose your own password in the browser and save the new recovery
code. Recovery signs out existing devices and revokes prior passkeys, API tokens and invitations;
issuing a setup link alone does not change access.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
