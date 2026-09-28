# Implementation status

## Implemented in source

- Task-oriented garden interface with a collapsible project sidebar, dark and light appearances,
  event-derived progress, model effort controls, direct result links and scoped source downloads.
- One primary agent computer; no SaaS pricing, provisioning, subscriptions, model resale, or local
  inference.
- First-owner pairing gate, passkeys, sessions, step-up, recovery, and scoped API tokens.
- Encrypted prompts, events, state, plans, schedules, memory, skills, credentials, and artifact names.
- Streaming, cancellation, prompt editing, retry, branch, live plan edits, and multi-device history.
- Native Linux runner with files, patches, terminal, background processes, Chromium, web research,
  Xvfb/Openbox GUI, AT-SPI semantics, screenshots, and takeover.
- Narrow approval-gated host package helper with arbitrary privilege escalation rejected.
- Private path-based previews, artifacts, file browser, and rich Markdown/media display.
- OpenRouter, Ollama Cloud, and compatible inference plus capability-aware effort and vision
  routing. Provider image, speech, transcription and video discovery retains advertised pricing,
  inputs and privacy requirements. Asynchronous jobs, compatible edits, provider libraries and
  batch work use durable receipts and explicit approval for retained provider processing.
- Reviewed native audio/video model input, microphone dictation and native live voice, with
  source and model binding, conservative reservations and recovery for unconfirmed charges.
- Native language-server queries, persistent Python/JavaScript computation and debugger sessions.
  Durable analyses have explicit lifetimes and checkpoints; browser tabs have owner controls and
  bounded cleanup of eligible idle agent tabs.
- Codex CLI, Claude Code, and OpenCode setup, publisher login paths, bounded missions, compact
  streaming progress, resume IDs, and task cancellation.
- Reviewed temporal memory with provenance/validity and a review queue for stale, failing and
  contradicting entries; reviewed skills; task search; friendly and cron
  schedules that can be edited, paused, resumed, run now or removed; read-only delegation and
  isolated writable coding missions with reviewed integration; GitHub,
  WebDAV, mailbox (IMAP and SMTP submission), calendar
  (CalDAV), and remote MCP with no-auth, bearer, or discovery/PKCE OAuth.
- Mail and calendar deliberately speak the open protocols against the owner's own server rather than
  going through a hosted provider's OAuth: a mailbox that can only be opened with Google or
  Microsoft sign-in does not connect, and each connect screen says so before the owner starts.
  Sending is scoped separately from reading and always raises an approval card.
- Bounded private extraction and source-linked BM25 retrieval for PDF, office, spreadsheet,
  OpenDocument, HTML, CSV, and text files, with phrase/title/coverage/diversity ranking and no
  duplicate vector store.
- Native installer for four distribution families - Debian/Ubuntu, Fedora/RHEL/Rocky/AlmaLinux,
  Arch and openSUSE - systemd services, loopback private ports, Nginx TLS gateway,
  PostgreSQL, doctor, strict checksum/path-validated backup/restore with approved package replay,
  merge-safe reinstall, clean-checkout transactional update with automatic data/code rollback, and
  data-preserving uninstall.
- Stable cryptographic server identity, one-time connection ticket, LAN mDNS, public endpoint
  manifest, automatic expired-ticket refresh, event-driven dynamic-address/certificate refresh, and
  a six-hour reconciliation timer.
- Generic native-client ticket import, exact server-key pinning, concurrent endpoint selection,
  manifest refresh, LAN mDNS rediscovery, safe-request failover, streaming HTTP/SSE, WebSocket
  bridging, and task/workspace deep links through a private random-port loopback gateway.
- PWA/share target/Web Push source plus generated Tauri desktop, Android, and iOS clients.
- Android release signing, exact package/permission/network/backup policy checks, four-ABI APK/AAB
  audits, 16 KiB package and 64-bit ELF alignment checks, and secret/build-path scanning.
- iOS generated Xcode source with exact `garden://` pairing, loopback-only transport policy,
  Bonjour and privacy declarations, opaque App Store icons, simulator CI, protected signing, and
  final IPA identity/provisioning/entitlement audit.
- Fail-closed macOS Developer ID notarization/stapling and Windows timestamped Authenticode release
  gates; unsigned local builds remain test artifacts only.
- Strict TypeScript, Zod trust boundaries, deterministic migrations, unit/integration tests,
  dependency-license gate, supply-chain scan, and a repository gate that parses every shipped shell
  and Python program, lints the skill library, and holds `.env.example` to the defaults the code
  declares.

## Recorded VPS evidence

The following exercises were recorded against earlier source builds. They do not establish that a
new release has passed its deployment and signed-artifact gates:

- all native services and PostgreSQL are active;
- only Nginx 80/443 and SSH are public; application/database ports are loopback-only;
- DNS and public IPv4 answer from an external client;
- IPv6 answers on the server (the test Mac has no usable IPv6 route);
- owner registration fails closed without the rotated one-time code;
- dynamic address add/remove refresh retained the same pinned public-key identity;
- an unsigned macOS native client proved the live VPS identity, proxied a health request end to end,
  persisted only its mode-0600 non-secret identity/endpoint profile, and reconnected after restart;
- an Android 16 arm64 emulator paired with the live VPS, loaded the real chat client, persisted the
  pinned server connection, and reconnected after a full app relaunch without targeted WebView or
  native crash errors;
- a local universal Android release APK and AAB passed exact four-ABI, privacy, archive,
  secret/path, and 16 KiB compatibility audits; they remain deliberately unsigned test artifacts;
- Avahi loaded and successfully established the `_garden._tcp` publisher on the VPS's IPv4 and
  IPv6 interfaces with the manifest identity;
- native package installation persisted across a runner restart;
- two consecutive files/browser/GUI/preview/storage drills passed without leaked GUI processes;
- a strict checksum/path-validated backup restored the database, home, configuration, pinned
  identity, recorded approved package, and Codex publisher login;
- the official Codex CLI logged in with a ChatGPT subscription, completed a sandboxed repository
  mission, and resumed the same persisted session ID;
- a synthetic private-content canary passed across garden, Nginx, and PostgreSQL journals/logs;
- API, worker, native runner, and native-client suites pass at the revisions recorded by the release
  drill; exact counts are reported by CI rather than frozen in this document;
- `garden doctor` passes configuration, services, API, database, Nginx, port isolation, outbound
  agent internet, Chromium, and disk checks;
- a quiet reinstall preserved arbitrary control/runner settings and the exact TLS identity, and an
  expired connection ticket refreshed successfully without exposing it.
- the final synchronized tree has zero checksum content drift from `/opt/garden`; every installed
  native helper matches that source, the complete native-computer drill passed again, and its
  temporary GUI/process/workspace state was removed;
- a fresh root-only full-host backup passed strict checksums, restored database, home, configuration,
  packages, and identity, and was followed by a clean `garden doctor` run;
- synthetic terminal and file-content canaries were absent from garden, Nginx, and PostgreSQL logs;
  the only public TCP listeners are SSH and Nginx, while application and database ports stay on
  loopback; and
- six unused Compose-era images and two unreferenced Docker volumes were removed after the volume
  contents were preserved in a root-only checksum archive. garden has no container, image, or
  volume and every garden service runs in a native systemd cgroup; unrelated provider-installed
  Docker software was left untouched.

This evidence is still narrower than a stable release.

## Compatibility internals

The schema of a product garden is not has been removed rather than left dormant: the four
organization tables and the four-role authorization model, the workspace order and checkout flow,
the machine shape and GPU tier columns, the per-user plan id, and the payment-processor reference.
Each was a column or a table that decided something this program has nobody to decide it for.

The `subscriptions` table went the same way, and it was the last of that shape. It held one row per
owner carrying a plan id that could only ever be `community`, an included allowance no real value
could reach, and a billing period written when the row was created and never advanced — so usage
accrued against the month of the install for as long as the box lived. Two gates read it, and
neither could fail for a reason worth having. The index named for a managed AI service went with it.

What the numbers were always for is in `apps/api/src/plans.ts` instead, and it is a server bounding
itself rather than an account being metered: `serverLimits` caps workspaces, storage, recovery
points, schedules and previews at deliberately generous values, and `currentPeriod()` is the
calendar month the usage pane totals against, because nothing is being billed and so nothing has to
remember a period. What actually stops a runaway unattended run is the owner's own two numbers, in
the currency the provider bills: the spending caps, which halt a task once it is over, and the
pre-flight price ceiling (`sudo garden price-ceiling`), which refuses to pick a model priced above
the rates the owner named in the first place. The second is the one that works overnight.

The workspace table can hold more than one row, and the server allows exactly one: `maxWorkspaces`
is 1, and the interface presents one computer. The id remains the authorization and encryption
boundary every task, file and key hangs from.

The retired Compose, Dockerfile, guest-image, SSH-tunnel, VPN, and container CI paths have been
removed. Native Linux is the only production server architecture.

## Remaining release gates

- Run the protected tag workflow with real operator-controlled signing credentials, then
  independently install and verify every separately downloaded draft artifact.
- Exercise the generic native client's first-owner passkey flow in packaged desktop and mobile
  webviews, including secure-cookie persistence and QR scanning. On Android this needs the webview
  to opt into WebAuthn through `WebSettingsCompat.setWebAuthenticationSupport`, which cannot be
  done from `RustWebView.kt` — that file is regenerated by Tauri and says so — so it has to come
  from the Tauri side or a plugin. Until then, assume a packaged Android build cannot complete a
  passkey ceremony and pair it from a browser instead.
- Exercise a real Claude Pro/Max login on the released build.
- Exercise OpenCode installation, at least one officially supported publisher login, and persisted
  session behavior on the released build.
- Repeat browser, full GUI takeover, path-preview, package-persistence, long-task/reconnect, and
  no-content log-canary drills against the signed release artifacts. `scripts/release-drill.mjs`
  passes end to end against a live installation built from source (2026-08-07): the document
  toolchain builds a CV, report, tables, deck, workbook and letter; Chromium navigates and returns a
  visual snapshot and extracted text; a GUI desktop launches and is observed semantically and
  visually; previews are detected and proxied; path traversal and unauthenticated runner control are
  refused; and a recovery point restores the workspace byte-for-byte. What remains is repeating it
  against the _signed artifacts_ rather than a source build.
- Restore onto a clean second host from an encrypted off-host backup. The in-place half is
  exercised (2026-08-07): `sudo garden backup` writes aside and renames only once checksummed and
  records the revision it was taken from, `sudo garden rollback DIR` puts code and data back
  together, and the box came up with every check passing and the owner still signed in. A backup
  written by the previous release is still accepted, which is the property that matters on the day
  the current release is what went wrong. What remains is doing it onto a _second_ host.
- Exercise packaged clients with VoiceOver, NVDA, and TalkBack and complete an independent release
  security review.

Passing compilation and tests is not production proof.
