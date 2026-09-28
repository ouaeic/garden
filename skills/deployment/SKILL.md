---
name: deployment
description: Get a built application running and reachable, on this computer or the owner's own host, with the two facts about this machine that decide whether it works — bind 127.0.0.1, and choose deliberately between a process that ends and a service the computer keeps running — stated plainly to the owner along with the rollback command. Use when the owner asks to run, preview, publish or deploy an application. Do not use to publish anything publicly without explicit approval, do not use for third-party paid hosting platforms, and never claim a systemd unit was installed, because the agent account cannot install one.
license: AGPL-3.0-or-later
compatibility: Requires the application's own runtime. A service the computer keeps running is supervised by garden's own workspace runtime and needs no root. systemctl and journalctl exist here but the agent account has no root, so a systemd unit file is written for the owner to install rather than installed here; neither binary is part of the document toolchain and neither is installed by garden.
allowed-tools: shell process publish_preview file_read file_write files_list browser_snapshot browser_action
metadata:
  garden.tier: 'builtin'
  garden.version: '2.0.0'
  garden.risk: 'external'
  garden.domain: 'code'
---

# Deployment

Never deploy something that has not been run. The rollback command is written down before the
switch, not after it fails.

## The two facts about this computer

Both are invisible until they bite, and between them they cause most failed demos here.

**Bind to `127.0.0.1`, never `0.0.0.0`.** The preview proxy connects to `127.0.0.1` and nothing
else, so loopback is what publishing is built on — `previewTarget` in the runner's `preview.ts`
builds `http://127.0.0.1:<port>/`. A socket on `0.0.0.0` is on every interface this computer has,
including the public one, where it is reachable by anyone who can reach the box whether or not the
preview was ever published. That is a different act from previewing and now raises its own
approval card; a loopback bind is the ordinary case and does not.

This file used to say the opposite, and said it in its own description, where every agent read it
before deciding anything. It was wrong on the day it was written: no version of the proxy has ever
connected to anything but loopback. A service was declared `--bind 0.0.0.0` on that advice and
served the workspace directory to the internet after the owner had declined to publish it.

**A plain background process ends; a named service does not.** Pick one deliberately and say which
one the owner got.

A `shell background=true` process without a name is scoped to the work: it ends at whichever comes
first — its own `timeoutSeconds`, which is an hour at most; a `process action=kill`; or the next
restart of the workspace runtime. Nothing brings it back.

`shell background=true service=<name>` is the other primitive and it is the answer whenever the
owner is being handed a link. The computer keeps it running: no timeout, started again with backoff
whenever it stops, and still there after a reboot, an update or an `garden restart`. It stops for
good on `process action=kill`. Starting one raises an approval card that says exactly this, so the
owner has agreed to a program that outlives the task before it starts. There are sixteen services
per computer, and a program that dies immediately five times in a row is treated as misconfigured
rather than restarted forever — read the state back through `process` rather than assuming it.

So say which of three things the owner is getting, in words, every time:

- **Something they will keep using** — the normal case for anything with a link.
  `shell background=true service=<name>`, then publish a preview, and tell them it stays up and
  comes back by itself, and that asking you to stop it is what ends it.
- **A throwaway demonstration** — a plain `background=true` process. Tell them plainly that it runs
  until the computer restarts or the timeout expires, and that asking you again brings it straight
  back.
- **A systemd unit on a host garden does not manage** — their action, not yours, and it is a
  different machine or a deliberate choice to sit outside garden's supervision. Write the unit file
  into the workspace with `Restart=on-failure`, a `RestartSec`, an explicit `WorkingDirectory` and an
  `EnvironmentFile` pointing at a root-readable secrets file, then hand them the three commands to
  run as root: `systemctl daemon-reload`, `systemctl enable --now <unit>`, and
  `journalctl -u <unit> -n 100 --no-pager`. Never say the unit is installed; say it is written and
  waiting for them. Do not reach for this on this computer when `service` would do — a unit file the
  owner has to install by hand is a worse answer to "give me a link" than one string.

## Proving it runs, before anyone else sees it

Build from a clean state — dependencies installed from the lockfile, then the project's own build
command — and check the output actually contains something. An empty `dist/` from a build that
"succeeded" is common when the entry point moved.

Read the startup logs before touching the port. Most failures announce themselves there and then the
process exits, and a health check against a dead port produces a confusing connection error instead
of the real message.

Then exercise it from `shell`, with `curl`, not from the browser — **the browser reaches the public
internet and nothing else, so a request to this computer's own port is refused**. Check the health
endpoint returns the expected status _and body_: a 200 serving an error page passes a status check.
Save the response body to `workspace/deploy/health-response.txt` as you go: `set_acceptance` refuses
`curl`, `wget` and `ssh` outright, by the shape of the command and inside an inline script too, so
the durable check is an artifact check on what the request returned rather than a check that makes
the request again. Walk the primary user path end to end, carrying the session cookie between
requests if it needs one. Read the logs again afterwards; errors often appear only on the first real
request.

Check configuration explicitly. Every environment variable the app reads must be present and correct
for the environment being deployed to — a missing one usually surfaces as a runtime 500 on the first
request rather than at startup. Never put a secret in a command line, a log, or a file that gets
published. Confirm any database migration ran and is reversible, or that the owner accepted that it
is not.

Once it is published, the preview URL _is_ a public address, so `browser_action` to navigate there
and `browser_snapshot` to check what the page renders and whether the console is clean.

## Preview, then publish

`publish_preview` gives the owner a private link with an Open button in chat, reachable from their
devices and nobody else's. It keeps working as long as they keep using it, closes on its own after a
month with no visits, and they can revoke it at any time. That is the right answer for everything
they should look at.

`publish_preview` with `reach: 'public'` makes it publicly reachable and stops for explicit approval
every time, in every security mode, on a clean turn and on a tainted one. Ask with the specifics:
what URL, what is exposed, and who will be able to reach it.

Both publish a **port**, not a running program. The link lives in garden's database; what it
proxies to is whatever is still listening. That is why the lifetime above has to be said out loud —
it is the single most common way a demo is broken by the time the owner opens it.

For a remote host the owner controls and has given you access to: deploy to a new directory or a new
unit instance, health check it, switch the symlink or the proxy target, and leave the previous
release in place. Rollback is then switching the symlink back — one command, prepared before the
switch.

## Failure modes

- **Bound to localhost.** The single most common preview failure; the app is fine and unreachable.
- **A health check that only checks the status code.** Check the body.
- **The passing check on a crash-looping service.** Check twice, a minute apart.
- **Config drift.** Works here, fails there, because a variable exists in this shell and not in the
  unit's environment. Diff the actual environments.
- **Publishing without asking.** Public exposure is irreversible in the sense that matters: the URL
  has been seen.
- **A link handed over as if it were permanent.** The link outlives the process behind it, so a
  preview the owner opens tomorrow answers with a proxy error unless the program behind it is a
  named service. This is the failure `service` exists to remove: reach for it before handing over a
  link, not after the owner reports the link is dead.
- **No rollback path.** Write the rollback command in the report _before_ switching.
- **Migrations without a plan.** A schema change the previous release cannot read makes rollback
  impossible; deploy backward-compatible migrations in two steps.
