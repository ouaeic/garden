# garden blueprint

## Product sentence

Install one free open-source application on a Linux computer and get a persistent, private AI agent
computer that works through an excellent chat interface on every device.

## Non-negotiable boundaries

1. No model weights, model server, or local inference fallback.
2. No garden subscription, checkout, usage resale, VPS marketplace, or managed user account.
3. Model access belongs to the owner: provider API keys and authenticated Codex/Claude subscriptions.
4. One agent computer in the interface, not a workspace-management product.
5. Chat first; browser, desktop, terminal, files, and advanced settings appear only when useful.
6. Linux server is canonical; web/PWA and open-source native clients connect from other systems.
7. Durable history, files, browser state, memory, schedules, and credentials survive client shutdown.
8. No intentional content logging, with honest external-provider boundaries.
9. One approval model across every tool and specialist.
10. Independent implementation under AGPL-3.0.

## Experience

### Setup

- One install command.
- Secure random configuration generated automatically.
- Native Linux dependencies and systemd services; no container, VM, image, VPN, or tunnel.
- Direct HTTPS connection ticket with automatically detected endpoints and pinned server identity.
- Single-use expiring code claims the first owner and closes registration.
- LAN discovery and address refresh preserve identity when an IP changes.
- Settings asks for model access only when the first task needs it.
- Codex/Claude setup uses explicit install and publisher login actions.

### Daily use

- Open garden and continue the same conversation from any device.
- Choose “Recommended” or a specific model.
- Ask for an outcome, attach files/media, or share into the PWA.
- Watch a concise plan and compact activity summary.
- Open the computer only for observation, takeover, login, CAPTCHA, or detailed debugging.
- Receive files, screenshots, media, and previews inside chat.
- Edit a prior prompt, retry, or branch without destroying the original path.

### Advanced use

- Security mode, model/capability details, memory, skills, connections, MCP, API tokens, plans,
  terminal, process logs, previews, and recovery points remain accessible but do not crowd the main
  path.

## Architecture

### Client plane

- React web app and PWA.
- Tauri wrapper for Linux, macOS, Windows, Android, and iOS.

Clients keep presentation state only. Durable data remains on the server.

### Control plane

- Fastify API for auth, tasks, events, files, plans, branches, approvals, memory, skills, schedules,
  connectors, media, previews, devices, and privacy operations.
- PostgreSQL for durable encrypted records and leases.
- Worker for model loop, policy, situational context, tool execution, and scheduling.
- Model registry for live provider metadata.

### Computer plane

- One native unprivileged `garden` Linux account on the installed host.
- Host packages, files, and publisher CLI credentials persist under normal Linux storage.
- Approval-gated system package helper; arbitrary privilege escalation is unavailable.
- Chromium and persistent browser profile.
- Openbox/Xvfb GUI desktop with AT-SPI semantic control and screenshot fallback.
- Terminal and background process manager.
- Path-based preview proxy to loopback user-started servers.

### External plane

- Owner-selected model provider.
- Publisher Codex/Claude services.
- Optional GitHub, WebDAV, the owner's own mail and calendar servers over IMAP/SMTP and CalDAV,
  MCP, websites, push relay, DNS, TLS, and VPS provider.

## Agent design

- Stable operating contract, including the craft guidance, plus a small runtime block kept at the
  tail of the request, where a block that changes during a task costs its own bytes and not the
  window behind it.
- The whole tool catalogue on every request, in a fixed order, with nothing gated and no search over
  it. A search was built and removed: it ranked definitions the model already had in front of it and
  billed a pass over the window to do so.
- Visible, user-editable plan.
- Lead model owns decisions; vision/coding/read-only specialists return bounded evidence.
- Durable memory is compact and reviewed.
- Skills are progressively loaded, reviewed, and versioned.
- Long work uses background processes and schedules.
- Completion requires explicit verification evidence.
- Untrusted content cannot grant authority.

## Safety design

| Mode       | Ordinary workspace work | Network installs | External changes        |
| ---------- | ----------------------- | ---------------- | ----------------------- |
| Review     | Confirm                 | Confirm          | Confirm                 |
| Balanced   | Allow                   | Confirm          | Confirm                 |
| Autonomous | Allow                   | Allow            | Confirm at safety floor |

Always protected: credentials, submissions, messages, purchases, public publishing, destructive
commands, ambiguous coordinate actions, subscription specialist missions, connector writes/deletes,
and MCP executions.

## Storage and compute

garden does not price or allocate hardware. The owner chooses any machine and expands its disks or
volumes using normal host tooling. Large datasets can live on mounted block, file, or object-backed
storage granted to the `garden` account.

Inference GPUs remain at the model provider. Optional user workflow GPUs are simply host hardware or
ordinary scheduled/on-demand compute available to host programs; they are unrelated to Garden model
inference.

## Release definition

A stable release requires:

- clean VPS install from the public repository;
- packaged source, dependency scan, SBOM, and reproducible native service definitions;
- provider, Codex, Claude, MCP, browser, desktop, and preview drills;
- phone/PWA and desktop packages;
- pairing, pinned-identity, endpoint failover, LAN rediscovery, and address-change drills;
- task branch/reconnect/cancel/long-run tests;
- no-content-canary log pass;
- backup and fresh-host restore;
- dependency/license/security review;
- published limitations and rollback instructions.

Passing TypeScript tests alone is not release proof.
