# Experience audit

## Main path

The default path requires four concepts:

1. install garden on a computer;
2. create the owner passkey;
3. connect model access;
4. ask for an outcome.

The installed client can perform step 1 from a small secondary action on the sign-in screen. It
verifies the SSH host fingerprint, runs the fixed installer directly, and imports the returned
ticket. The browser client shows the same command but never asks for SSH secrets.

There are no machine tiers, storage products, GPU subscriptions, provider marketplaces, workspaces,
or plugin bundles in the main flow.

## Progressive disclosure

- Chat and composer dominate the screen.
- The activity group is compact while running and collapses to a result when complete.
- Browser/desktop/terminal/files open only when requested or needed.
- Model selection shows a recommended default; capability and vision handoff details appear when
  relevant.
- Memory, skills, connections, API tokens, and server details live in Settings.
- Remote MCP is labeled advanced and hidden inside Connections.
- Technical users can still inspect plans, events, files, terminals, previews, model metadata,
  security modes, and scoped API tokens.

## Task lifecycle

- Send and stream.
- See a concise live plan.
- Expand activity only for detail.
- Approve a clearly described consequential step.
- Take over browser/desktop for secure or human-only input, or for one page a site is challenging —
  the agent keeps working everywhere else while that page waits.
- Hear from the agent itself: a notice when it decides the owner wants to know something now, and a
  takeover request when a site is challenging one page. Those two are the agent's own judgement
  rather than the box deriving an interruption from a status change, and both can still be switched
  off.
- Edit an earlier prompt to create a new path.
- Retry a response or branch without destroying history.
- Resume on another device.
- Receive a compact completion summary with files/previews attached.

Running indicators derive from task and process terminal state; completion removes spinners even when
an inner tool emitted a stale “running” event.

## Error language

Errors explain the next action:

- connect a provider;
- log in to Codex, Claude Code, or OpenCode;
- open the computer for secure input;
- approve or deny;
- open one page a site is challenging and take control of it;
- expand storage/host disk;
- restart the runner;
- change a retention route;
- inspect logs or run `garden doctor`.

Old subscription, upgrade, allowance, checkout, and cloud-provisioning wording is not part of the
self-hosted interface.

## Accessibility and efficiency

- Keyboard-operable controls and labeled icon buttons.
- Reduced-motion support for decorative glow animation.
- Dark-only OLED-conscious theme.
- Responsive narrow layout and installable PWA.
- Virtualized/compact task activity instead of one bubble per tool event.
- Screenshots and desktop frames are streamed on demand, not continuously when hidden.
- Skills are resident as one line each and load in full only when a procedure is opened. The tool
  catalog is deliberately not gated: withholding tools cost more in wrong answers than it saved in
  tokens, and it sits in the cached prompt prefix either way.

## Release UX gates

Before a stable tag:

1. fresh Linux install by a nontechnical tester;
2. connection-ticket/first-owner setup over provider DNS, raw IPv4, raw IPv6, and LAN mDNS;
3. phone PWA installation and browser/desktop takeover;
4. OpenRouter, Ollama Cloud, compatible-provider, Codex, Claude Code, and OpenCode setup from empty
   state;
5. 8-hour analysis with reconnect and cancellation;
6. prompt edit/retry/branch on another device;
7. low-disk, provider outage, runner restart, and denied approval;
8. backup/restore onto a clean host;
9. screen-reader and keyboard pass;
10. no-content-canary log scan.

Dynamic public-address UX must state the physical boundary: an off-site client that was offline
cannot discover an unknown new public IP without a stable hostname or rendezvous service. garden
must never disguise a relay, VPN, or directory as “automatic broadcasting.”
