# Driving garden from a script

`athanor task` is the larger half of garden's headless surface. It starts work, waits for it, and
answers with one JSON object and an exit code that says how the work ended. The one other command
here is `athanor tool-opens` at the end of this page, which reads back what the box has been doing
rather than making it do anything; it is on this page because it wants the same API token and the
same plumbing, not because it drives a run.

There is a third command on the same plumbing, and it is on its own page because its caller is not a
script the owner wrote: `athanor acp` speaks Agent Client Protocol on stdin and stdout, so an editor
or a desktop client somebody else wrote can drive this box. It creates the same tasks over the same
routes with the same token, under the same approval floor. See [ACP](ACP.md) - and read its approval
section before minting a token for it, because the scope you choose is what decides whether a client
can answer a card.

Both drive the same HTTP API a browser drives, with an API token in place of a passkey session. No
route either uses is new, and neither adds anything to what the model is sent: these are commands
an operator types, not tools the agent can see, so the tool catalogue is the same byte for byte
with them and without them.

## Getting a token, and why a script cannot get one for itself

A token is minted at a browser, by a person, with a passkey. `POST /v1/api-tokens` calls
`requireRecentStepUp` before it does anything else, so it needs a session cookie whose passkey
ceremony happened inside the step-up window. And `/v1/api-tokens` matches no entry in the scope
table in `apps/api/src/http/auth-hook.ts`, so the route falls through to `undefined` and a bearer
token is refused it outright.

That second fact is the load-bearing one: **a token cannot mint a second token**. A stolen token
buys exactly its own scopes until its own expiry, and no path widens either.

This is kept, not fixed. Two reasons:

- A server with no screen is still reached from the owner's own browser. `sudo athanor connect`
  prints the address to open and a QR code for a phone, a passkey is bound to that hostname, and
  `sudo athanor doctor` reports a box with no hostname as one where browser sign-in cannot work at
  all. Nothing needs a browser on the box itself, so "the operator only has SSH" is not the same
  claim as "no human can reach a browser pointed at this machine".
- What is genuinely not served is a first token with no human anywhere, on any device - a machine
  provisioning itself. That case is refused on purpose. A credential a machine can mint for itself
  unattended is a credential anything that reaches the machine can mint.

What was missing was not a way to mint a token but a place to keep one. `athanor task` looks for a
token in two places, in this order:

1. `ATHANOR_TOKEN` in the environment, for a caller on another machine.
2. `/etc/athanor/api-token`, for the box itself. Create it root-owned and mode `0600`, containing
   the token and nothing else. Then the token is not in a shell history, an environment, or a
   process list, and `sudo athanor task ...` is the ordinary invocation.

Override the file's location with `ATHANOR_TOKEN_FILE` and the server's address with `ATHANOR_API`,
which defaults to `http://127.0.0.1:4100`.

Nothing in garden creates that file, sets its mode, or checks it. `doctor` does not mention it.
That is open work, and it is stated here rather than implied.

### Scopes

Mint the token with the least that will do. A run that starts work and reads the result needs
`tasks:write` and `tasks:read`. Add `approvals:read` and `approvals:write` only if something will
answer the questions the run stops to ask. Add `files:read` and `files:write` to seed inputs or read
artefacts back with `curl`.

Two refusals are deliberate and are not worked around here: no scope reaches
`/v1/workspaces/:id/{terminal,browser,desktop}-token`, and none reaches `/v1/notifications`.

## The commands

```bash
sudo athanor task run --workspace ID (--prompt TEXT | --prompt-file PATH)
sudo athanor task wait TASK_ID [--timeout SECONDS]
sudo athanor task show TASK_ID
sudo athanor task cancel TASK_ID
sudo athanor task approvals [TASK_ID]
sudo athanor task approve APPROVAL_ID
sudo athanor task deny APPROVAL_ID
sudo athanor task answer TASK_ID (--text TEXT | --text-file PATH)
```

`run` also takes `--model ID`, `--privacy-route ROUTE`, `--credits N`, `--spend-usd N`,
`--timeout SECONDS` and `--key IDEMPOTENCY-KEY`. `--prompt-file -` reads the prompt from standard
input. Prefer it to `--prompt` for anything private: `sudo` writes the command line of every
invocation to the system journal, so a prompt given as an argument is kept there in full, while a
prompt read from a file or standard input never reaches it.

`--spend-usd` is the ceiling that actually stops work, and `--credits` is not its twin.
Compute credits are a runaway backstop rather than a budget: the server raises the number you pass
to at least what the chosen model's step limit would cost, so a value below that floor changes
nothing and the outcome reports the floor it was raised to. Set the money limit; a task parked by
one comes back `blocked`, exit 6, with `reason` carrying the sentence, `reasonCode` set to
`spend_ceiling` and `blockedBy` naming which ceiling it was - `task`, `daily` or `monthly`. One
other stop looks like it and is not: when the guard that checks the ceilings could not answer at
all - its database did not - the task is parked the same way with `reasonCode` set to
`spend_guard_unavailable` and `blockedBy` null. No limit was crossed, so raising one changes
nothing; resume the task once the box is well.

`answer` is the reply to a question the agent stopped to ask, and it is a different act from
approving a card. `awaiting_user` covers both: when a card is waiting, `pendingApprovals` holds it
and `question` is null; when the agent asked something, `pendingApprovals` is empty and `question`
carries what was asked, why, and any options offered. A card in front of the owner takes precedence
over a question already asked. `question` is only ever set on `awaiting_approval`: once the task
has ended, a question it asked along the way is history in the transcript and the field is null, so
a caller can key on it without answering a task that has stopped listening. `answer` keys itself on
the words when you pass no `--key`, so a retried call cannot become a second message in the
conversation.

`--key` is the one worth understanding. Every write on this API needs an `Idempotency-Key`, and
`run` generates a fresh one per invocation - so re-running the same command starts a **second**
task and pays for it twice. A caller that retries should pass its own `--key` and keep it across
attempts.

## The outcome

`run`, `wait`, `show` and `cancel` print one JSON object on standard output. Progress and errors go
to standard error, so `athanor task run ... > outcome.json` is a complete result.

```json
{
  "contract": "athanor.task.outcome/1",
  "outcome": "completed",
  "exitCode": 0,
  "taskId": "…",
  "workspaceId": "…",
  "status": "completed",
  "securityMode": "balanced",
  "modelId": "…",
  "spentUsd": 0.0125,
  "computeCredits": { "used": 12, "max": 200 },
  "waitedSeconds": 94,
  "transcript": "read",
  "answer": "I wrote report.pdf and checked it opens.",
  "verification": { "…": "the completion contract the turn declared" },
  "outstanding": ["what the turn left open"],
  "reason": null,
  "reasonCode": null,
  "pendingApprovals": [],
  "lastEventSequence": 42
}
```

`answer`, `verification` and `outstanding` are read out of the `completed` event's payload, which is
where the worker writes the model's own account of the turn.

`verification.evidence` holds two kinds of item, told apart by `source`. The model's own citations
are `tool_result`, `published_artifact` or `user_visible_result`. Every command check the harness
ran and saw pass is added by the harness itself as `acceptance_check`, and its `claim` carries the
label and the command that was run, in the form `check-2: <label> — ran <command> — exit 0`. The
label is the model's sentence; the command is what the computer tested, so read the one against the
other. The model cannot write that source.

`reason` and `reasonCode` come from the latest, by sequence, of the events that can end a run: an
`error` or `warning` the worker addressed to the owner - the one whose payload carries
`owner: true` - or the `status` a spend pause writes. Latest, because a task can be resumed past a
stop: a provider wall at sequence 5 and a ceiling at sequence 11 is a task parked by the ceiling,
and the wall is history. They are filled only on an ending that has a reason, which is `failed`
and `blocked`. A spend pause is the one `blocked` ending the worker records without a code: it
writes a `status` event carrying `blockedBy`, so on that ending `reasonCode` is given by the
command - `spend_ceiling` when `blockedBy` is `task`, `daily` or `monthly`, and
`spend_guard_unavailable`, with `blockedBy` null, when the guard itself could not answer. Two
things make the rule narrower and wider than "the last `error` event":

- a run that died of anything the provider did is recorded as a `warning`, not an `error`
  (`apps/worker/src/agent.ts`), and it still ends `failed` unless the code is one of the three
  provider walls that park a task instead. Reading only `error` events left the commonest class of
  failure with no reason at all.
- a tool call that throws and is recovered from writes an `error` event mid-run
  (`apps/worker/src/tool-recording.ts`). On a run that then finished, reporting it would put
  `reason: "shell failed"` beside a successful answer.

So on `completed` both fields are `null` by construction, not because nothing went wrong along the
way. The transcript is where the mid-run failures are.

Before this existed a caller recovered the result by filtering the event list for
`kind === "completed"` and then searching the JSON for a string; `scripts/live-drill.mjs` still
does, and looks for `exit 0`.

`status` is garden's own word for the task and `outcome` is this contract's. They are not the same
vocabulary and both are given.

`transcript` is `read` or `unavailable`. Without it an `answer` of `null` on a completed task means
either that the turn wrote nothing or that the transcript could not be fetched, and a caller scoring
on the answer could not tell those apart.

### Exit codes

| Code | Outcome             | Meaning                                                            |
| ---- | ------------------- | ------------------------------------------------------------------ |
| 0    | `completed`         | The task finished.                                                 |
| 1    | -                   | The command could not do its job: no token, bad option, no answer. |
| 2    | `failed`            | The task failed. `reason` and `reasonCode` say what happened.      |
| 3    | `awaiting_approval` | The task stopped to ask: see `pendingApprovals`, or `question`.    |
| 4    | `timed_out`         | The wait ran out. The task is still running and still spending.    |
| 5    | `cancelled`         | The task was cancelled.                                            |
| 6    | `blocked`           | Stopped and needing a resume: `paused` or `awaiting_resource`.     |
| 7    | `running`           | `show` only: the task has not stopped.                             |
| 64   | -                   | No such subcommand.                                                |

Exit 4 does not stop anything. The task keeps running and keeps spending; `athanor task cancel`
is how it is stopped, and `athanor task wait` picks the same task back up.

Exit 6 is the one worth reading twice. `awaiting_resource` sounds like a wait that clears on its
own and is not: it is where a provider wall, a disconnected provider or an unreachable model parks
a task, and nothing leases it again without a resume.

`approvals`, `approve` and `deny` describe a request about work that is still going rather than an
ending, so they exit 0 or 1 and print what they did.

## Approvals, and the mode they follow from

**`athanor task` never answers an approval.** A run that reaches one stops, exits 3, and hands back
what was asked as data. There is no `--yes` and there is deliberately no `--security-mode`: how much
a run stops to ask is the workspace's setting, and a flag on the command that started the work could
quietly answer questions the owner had asked to be shown. The mode is reported in every outcome
instead, so a result always carries the terms it was produced under.

The three modes, and what each still stops for, are in `apps/worker/src/approval-policy.ts`:

- **Review** asks before every command, every file written, and every browser or desktop action.
- **Balanced** asks whenever a command reaches an address on the internet, and before installing
  software, and before consequential browser or desktop actions. The built-in web tools — search, page reads and the browser — read without asking;
  what leaves on a turn that has read untrusted content is still carded, in every mode.
- **Autonomous** completes browser and desktop actions within the requested scope, including
  uploads and submissions, without repeated approvals. CAPTCHA and private input require takeover.
  Provenance checks and non-surface approval floors still apply.

An unattended run can still stop for a human-only challenge or another enforced boundary.

A task inherits its mode from its workspace when it is created. Change the workspace's default with
one call, using a token carrying `workspaces:write`:

```bash
curl -fsS -X PATCH "$ATHANOR_API/v1/workspaces/$WORKSPACE/security-mode" \
  -H "Authorization: Bearer $ATHANOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: mode-$(date +%s)" \
  -d '{"securityMode":"autonomous"}'
```

An unattended caller that answers its own questions writes that loop itself:

```bash
athanor task run --workspace "$WORKSPACE" --prompt-file brief.txt >outcome.json
task=$(jq -r .taskId outcome.json)
while [ "$(jq -r .outcome outcome.json)" = awaiting_approval ]; do
  for id in $(jq -r '.pendingApprovals[].id' outcome.json); do
    athanor task approve "$id"
  done
  # The other kind of stop. A card is decided; a question is answered, and a loop that only
  # decides cards spins here for ever against an empty list.
  if [ "$(jq -r '.question.question // empty' outcome.json)" != "" ]; then
    jq -r .question.question outcome.json >&2
    athanor task answer "$task" --text "use your judgement and say what you assumed"
  fi
  athanor task wait "$task" >outcome.json
done
exit "$(jq -r .exitCode outcome.json)"
```

That loop is four lines and it is meant to be. Answering approvals automatically is a real decision
about what may happen with nobody watching, and a caller that has made it should have it written
down in its own source, where it can be read, counted and disclosed - not folded into a flag.

## What the box has been reaching for

```bash
sudo athanor tool-opens [DAYS] [--json]
```

The one command on this page that is not about a run. It reports the share of this box's turns over
the last `DAYS` - seven by default - that reached each tool at least once. Turns, not calls: a tool
used five times inside one turn was opened once. It reads `GET /v1/usage/tool-opens`, needs
`usage:read` and nothing else, calls no provider, and is billed nothing.

It refuses to divide by a small sample. Under 33 turns in the window it prints no share at all and
says why: at 33 a tool nobody called once has a 95% upper bound below the 9.2% threshold the
tool-deferral decision uses, and below 33 the rule of three that decision is quoted in does not
clear it. Thirty-three is the floor of that shorthand and not of the tighter bound the table
actually prints, which clears at 32; the two are held together on purpose, and
`MIN_TURNS_TO_ANSWER` in `apps/api/src/routes/usage.ts` carries the working and the cost of that
choice. `docs/design/organs/PREAMBLE.md` is the decision it feeds - and that file is excluded by
`.gitignore`, so it is not in a clone of this repository and the working in `usage.ts` is the copy
you have.

`--json` prints the object the route returned instead of the table. Both arguments are optional and
independent: `tool-opens`, `tool-opens 30`, `tool-opens --json` and `tool-opens 30 --json` are all
accepted, and the day count defaults to 7 whether or not `--json` is given.

## Starting a run from outside: the inbound trigger

Everything above is a script this box's owner runs. The inbound trigger is the other direction -
something that is not the owner and is not a clock starting a turn here - and it is the only one.

A trigger is attached to a schedule when the schedule is created:

```bash
curl -sS -X POST "$ATHANOR_URL/v1/schedules" \
  -H "authorization: Bearer $ATHANOR_TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"workspaceId":"…","prompt":"Look at the build that just failed and say what broke it.",
       "spec":{"kind":"weekly","timeZone":"UTC","localTime":"03:00","weekdays":[0]},
       "trigger":{"kind":"webhook","minGapMinutes":15}}'
```

The reply carries two things that are never served again together: `triggerUrlPath`, the path a
sender posts to, and `triggerSecret`, which is **shown once** and is not stored in plaintext
anywhere on this box. `GET /v1/schedules` returns the path afterwards and never the secret. Losing
it means deleting the schedule and making another, which is also how a leaked secret is revoked.

A sender signs each delivery:

```
POST https://<your box>/v1/hooks/<triggerUrlPath segment>
x-athanor-timestamp: <unix seconds>
x-athanor-signature: v1=<hex HMAC-SHA256 of "v1:<timestamp>:" followed by the exact body bytes,
                          keyed with triggerSecret>
```

Answers: `202` accepted and the schedule armed; `200` with `duplicate: true` for the same signed
request arriving twice, which is what a publisher retrying on a timeout gets; `401` for a missing,
wrong or stale signature; `413` over 64 KiB; `429` when the hour's allowance or the unread backlog
is full; `404` for an address this box never minted.

Four bounds are worth knowing before you point anything at it.

- **The run is a scheduled run.** The delivery does not create a task; it moves the schedule's next
  occurrence forward, and the dispatcher materialises the run through the same statement a clock
  occurrence uses. The spend guard, the workspace's security mode, the compute reservation, the
  approval floor and the three-strike pause therefore apply because it is the same code.
- **`minGapMinutes` is the bound on money**, and it bounds model turns rather than requests: a
  thousand deliveries inside one gap produce exactly one run, which reads all of them. Fifteen
  minutes is the floor and the default, matching the shortest `interval` this software offers.
- **The payload is untrusted content and is treated as such.** It is never put into the
  instruction. It is written into `workspace/downloads/inbound/<scheduleId>/`, and the run is told
  the file names. Reading those files taints the turn exactly as a downloaded web page does, so the
  approval floor tightens around what the run does afterwards.
- **A one-time schedule cannot carry a trigger.** It would answer one delivery and then be a dead
  URL; the route refuses it with `trigger_needs_repeating_schedule`. `PATCH /v1/schedules/:id` gives
  the same refusal for moving a schedule that already has a trigger onto a `once` spec, so the dead
  URL is not reachable in two calls either.

Two more things a script driving this API should expect:

- **Every schedule reply carries `trigger` and `triggerUrlPath`**, and `null` means there is no
  trigger. That is `GET /v1/schedules`, the create reply, `PATCH /v1/schedules/:id` and
  `POST /v1/schedules/:id/{pause,resume,run}`. Absent would have been a third answer; there is no
  reply that omits them, so a client may refresh its row from any of these without losing the URL.
  `triggerSecret` is on the create reply alone.
- **`POST /v1/schedules/:id/run` is refused with `409 previous_run_active`** when that schedule
  already has a run that has not finished. It is not deferred and it does not record a failure: an
  owner asking for a run gets a run or a sentence. Finish or cancel the open run and ask again.

## What this does not do

- It does not mint tokens, rotate them, or check the permissions on the file it reads one from.
- It does not create workspaces, upload inputs, or download artefacts. Those are `curl` against
  `/v1/workspaces` and `/v1/workspaces/:id/file`, with `files:read` and `files:write`.
- It does not stream. `run` polls every two seconds (`ATHANOR_TASK_POLL_SECONDS`). The live
  transcript is `GET /v1/tasks/:taskId/events/stream`, which reconnects with `Last-Event-ID`.
- It does not read the transcript. The outcome carries the ending; `GET /v1/tasks/:taskId/events`
  carries the whole trajectory, and `athanor task` deliberately does not wrap it.
- It does not resume. `paused` and `awaiting_resource` are reported, not cleared;
  `POST /v1/tasks/:taskId/resume` is the call.
- It does not put the computer back. `POST /v1/tasks/:taskId/trajectory` accepts
  `rewind: "conversation"` from a bearer token and refuses `"computer"` and `"both"` with 403,
  because those delete and rewrite the workspace tree; the other door to the same act,
  `POST /v1/workspaces/:id/snapshots/:sid/restore`, is closed to bearer tokens for the same reason.
  A rewind that touches files is signed in from the interface.

`scripts/test-task-cli.mjs` runs the real subcommand against a stand-in API and checks each of the
exit codes above, the shape of the outcome, and that nothing answers an approval. It costs nothing
and runs inside `node scripts/check-repository.mjs`. What it cannot prove is that the API still
sends the shapes it stands in for - that is `scripts/live-drill.mjs`, against a real box and a real
model, and it costs money to run.
