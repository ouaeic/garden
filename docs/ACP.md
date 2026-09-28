# Talking to garden from somebody else's client

garden speaks the **Agent Client Protocol**. An editor, a desktop app or a front end somebody wrote
themselves can drive this box without garden shipping, writing or maintaining any of them.

```bash
sudo garden acp --workspace WORKSPACE_ID [--model ID] [--credits N] [--spend-usd N]
                 [--approvals park|relay] [--turn-timeout SECONDS]
```

This is not a server and there is nothing to start. An ACP client **spawns** this command, talks
JSON-RPC 2.0 down its stdin and stdout, and the process ends when the pipe closes. Like
`garden task`, it is a command an operator configures rather than a tool the agent can see: the
tool catalogue is the same byte for byte with it and without it, and it adds no field to any model
request. It calls the same HTTP API `garden task` calls, with the same bearer token, and every turn
it runs is an ordinary garden task under the ordinary approval floor.

## Which specification this is, and how it was read

Schema **v1**, from the tagged release `schema-v1.21.0` of
`github.com/agentclientprotocol/agent-client-protocol` - `schema/v1/schema.json` and
`schema/v1/meta.json` fetched from the tag, alongside the prose at `agentclientprotocol.com`.
`protocolVersion` is the single integer `1`.

The version story is worth knowing before anyone builds on this:

- **v1 is stable and additive.** Its changelog runs from `1.13` to `1.21` over the past year with no
  breaking entry; the recent releases stabilise things that were already there, such as
  "stabilize elicitation" and "stabilize terminal authentication".
- **v2 exists and is not finished.** `schema/v2` is in the project's `main` branch with three
  pre-releases published, `schema-v2.0.0-alpha.1` through `alpha.3`. It removes `fs/*`,
  `terminal/*` and `session/load`, and renames `authenticate` to `auth/login`. **None of those are
  surfaces garden uses**, so moving to 2 is a version bump in one constant here rather than a
  rewrite. Until it leaves alpha this answers 1.
- Version negotiation is the protocol's own protection: an agent that cannot speak the client's
  version "MUST respond with the latest version it supports", and the client then decides whether to
  continue. A client that outgrows this agent finds out at `initialize` rather than mid-turn.

This was **not** declined, and it is worth saying why, because three things in this programme have
been. The protocol is small, the parts garden needs are the parts that have not moved, the mandatory
agent surface is four methods, and the one genuine hazard in it - the permission call - is optional
for an agent to make. The gap it closes is real: multiple independent projects adopted ACP without
being paid to, and it is the cheapest interop surface a self-hosted agent has.

## What the protocol requires, and what garden answers

An agent must handle `initialize`, `authenticate`, `session/new` and `session/prompt`, must send
`session/update` notifications as it works, and must return the `cancelled` stop reason after a
`session/cancel`. Everything else is optional on one side or the other.

| Method                       | garden                                                                |
| ---------------------------- | --------------------------------------------------------------------- |
| `initialize`                 | Answers version 1. No auth methods, no MCP, no session loading.       |
| `authenticate`               | Refused. There is no auth method to authenticate against - see below. |
| `session/new`                | Opens a session. Refuses a non-empty `mcpServers`.                    |
| `session/prompt`             | Creates an garden task, or continues the one this session opened.     |
| `session/cancel`             | Cancels the task. The turn then answers `cancelled`.                  |
| `session/load`               | Refused. `initialize` advertises `loadSession: false`.                |
| `session/set_mode`           | **Refused.** See the approval floor below.                            |
| `session/set_config_option`  | **Refused.** Same reason.                                             |
| `session/request_permission` | Sent only under `--approvals relay`, and never with a standing yes.   |

One ACP session is one garden task. The first `session/prompt` creates it; every later prompt in
that session continues the same conversation, so what the client is saying and what the owner sees
in garden are the same thread.

`cwd` is recorded and otherwise unused. garden's unit of work is a workspace on the box, not a
directory on the client's machine, and treating a client's path as a workspace would be a lie about
where the work happens. The workspace comes from `--workspace` and from nowhere else.

## The approval floor

**This is the part to read.** ACP hands a client two things that could quietly lower how much this
box stops to ask, and both are refused.

### A client cannot change the security mode

`session/set_mode` and `session/set_config_option` are answered `Method not found`, and `session/new`
returns no `modes` and no `configOptions` - so a conforming client is never offered a mode picker in
the first place. This is the same refusal `garden task run` makes by declining a `--security-mode`
flag: how much a run stops to ask is the workspace's setting, and a control on the thing that started
the work could quietly answer questions the owner asked to be shown.

What is underneath that refusal, stated exactly, because the easy version of this paragraph is
false and an operator would act on it:

- The **create** path cannot carry a mode. `CreateTaskRequest` in `packages/contracts/src/index.ts`
  has no `securityMode` field, and the **workspace** mode is changed by
  `PATCH /v1/workspaces/:id/security-mode`, which `auth-hook.ts` puts behind `workspaces:write` - a
  scope an ACP token has no reason to carry. Mint it without one and that route is unreachable.
- **A per-task override does exist, and `tasks:write` reaches it.**
  `PATCH /v1/tasks/:taskId/security-mode` in `apps/api/src/routes/tasks.ts` sets the mode of one
  task. `requiredApiTokenScope` sends it to `tasks:write` because it sits under `/v1/tasks`, and the
  route deliberately takes no second factor: "No second factor for choosing how much this run asks."
  `tasks:write` is the minimum this bridge needs, so **every ACP token can reach that route**.

So the refusal is not held up by an unreachable route. It is held up by two narrower things:
`scripts/acp/garden-acp.mjs` never calls that route, and its `createApi` has no method that could -
the drill watches every request the bridge makes and checks that none of them was a `security-mode`
write. And on the box the bridge reads the token out of `/etc/garden/api-token` itself, so the
client that spawned it never sees the credential.

**In the remote configuration below the client is handed the token in `GARDEN_TOKEN`, and then it
holds `tasks:write`.** Such a client can set the task it was just told about in `_meta.garden.taskId`
to `autonomous` with one HTTP call that does not go through this protocol at all, and
`SECURITY_MODE_FLOOR` in `apps/worker/src/approval-policy.ts` then stops asking before reaching the
internet and before installing software. That is a property of an garden API token and is the same
for `garden task`; ACP does not create it and cannot close it. If that matters for a given client,
run the bridge on the box under `sudo` so the token stays in `/etc/garden/api-token`.

### A client is not asked to answer cards, unless the operator says so

**`--approvals park` is the default.** The bridge never calls `session/request_permission`. When
garden cards an action the task parks, the turn ends, and the client is told in words what was asked
and where to answer it. The decision stays with the owner at garden's own surface.

**`--approvals relay` is opt-in.** The bridge asks the client, and hands the answer to
`POST /v1/approvals/:id/{approve,deny}` - garden's own approval route, the same one
`garden task approve` uses. It is a mapping onto that mechanism and not a replacement for it: every
card garden raises is still raised, because the security mode decides what gets carded and this path
never touches it. Relay changes only _where the question is displayed_.

Relay offers exactly two of ACP's four `PermissionOptionKind` values: `allow_once` and `reject_once`.
**`allow_always` and `reject_always` are never offered**, because garden has nowhere to keep a
standing decision - `POST /v1/approvals/:id/:decision` resolves one approval and consults no rule
table - and a client handed `allow_always` would reasonably stop asking its user. From that moment a
toggle in somebody's editor would be answering every card instead of the owner. The cost, plainly: a
client's "always allow" affordance does not work against this agent, and an operator answering many
cards answers each of them.

### The control is the token's scope, not the flag

In ACP the **client** spawns the agent, so the client controls the command line and could pass
`--approvals relay` itself. What it cannot do is give itself a scope. `requiredApiTokenScope` in
`apps/api/src/http/auth-hook.ts` routes every write under `/v1/approvals` to `approvals:write`, and a
token minted without it is refused by the server with a 403 whatever the command line said.

**So: an operator who wants the approval floor to be unreachable from an editor mints the ACP token
without `approvals:write`, and is done.** The flag is a convenience; the scope is the control. A run
that parks then stays parked until a human answers it in garden.

`scripts/acp/test-acp-bridge.mjs` drives that exact case - relay mode, a client that says approve, an
API that answers 403 the way the real one does - and checks the turn reports an error rather than
success.

### Scopes

`tasks:write` and `tasks:read` are the minimum. Add `approvals:read` so a parked turn can say what it
stopped to ask; without it the park is still reported, just without the wording of the question. Add
`approvals:write` **only** if `--approvals relay` is wanted, and understand from the section above
what that grants.

Read the minimum honestly: `tasks:write` is not a read-only grant. It creates tasks, cancels them,
resumes them, and reaches `PATCH /v1/tasks/:taskId/security-mode` - so anything holding that token
can change how much one task stops to ask. There is no smaller scope that still lets a client start
work. Keeping the token off the client's machine, by running `sudo garden acp` on the box, is the
control for that; there is no scope that is.

No scope here reaches `/v1/notifications`, by the API's own design: "an automation token that could
switch off approval prompts could act unwatched, which is the one thing the prompts exist to
prevent."

## How a turn ends

The result of `session/prompt` is a `stopReason`, with the garden detail beside it under `_meta`.

| garden status                        | stopReason                          | `_meta.garden.parked` |
| ------------------------------------ | ----------------------------------- | --------------------- |
| `completed`                          | `end_turn`                          | -                     |
| `cancelled`                          | `cancelled`                         | -                     |
| `awaiting_user`                      | `refusal`                           | `awaiting_approval`   |
| `paused`, `awaiting_resource`        | `refusal`                           | `needs_resume`        |
| still running when the watch ran out | `refusal`                           | `still_running`       |
| `failed`                             | _no stop reason - a JSON-RPC error_ |                       |

Two of those rows are arguments, so here is the argument.

**A failed task answers with an error, not a stop reason.** ACP has no stop reason meaning "it
broke", and this repository has been bitten twice by a wrapper that returned success while the work
died. There must be no success field a client can read and believe the work was done.

**A parked task reports `refusal`, not `end_turn`.** ACP v1 has five stop reasons and none of them
means "parked, waiting on a decision nobody has made yet", which is what garden's `awaiting_user`,
`paused` and `awaiting_resource` all are. Neither available answer is right:

- `end_turn` means the turn ended successfully. A parked task reported that way looks _finished_ to
  any client that reads only the stop reason.
- `refusal` is documented as meaning the prompt "won't be included in the next prompt, so this should
  be reflected in the UI", so a client may drop the turn from its own display.

The second is cosmetic here and only here, because garden owns the transcript: the task keeps its
full context on the box, and the next `session/prompt` continues it whatever the client chose to
show. The first costs money and lets a live task go unwatched. So `refusal` it is, and the turn also
says in words what happened. **If you are writing a client, read `_meta.garden` - it carries the
status, the task id and which kind of park this was.**

The watch running out is the one to be careful with. It does not stop anything: the task **keeps
running and keeps spending**, `--turn-timeout` only bounds how long this bridge watches. The turn
says so, and names the command:

```bash
sudo garden task cancel TASK_ID
```

## Exit codes

These describe the **bridge**, not the work. They are deliberately not `garden task`'s table: a
session holds many turns, and how each ended is answered inside the protocol by `stopReason` and
`_meta`. Picking one turn's ending to stand for the process would be the same dishonesty in a new
place.

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | The client closed the connection and every turn it asked for was answered. |
| 1    | Could not do its job: no `--workspace`, an unreadable option, no node.     |
| 2    | The API stopped answering, or the client's pipe broke mid-session.         |

A missing or malformed token is **not** a startup failure. The session opens and the first
`session/prompt` is refused with ACP's `-32000` "Authentication required", which is where a client
knows how to show the problem. `garden acp` offers no auth method to fix it from inside the
protocol, because none exists: a token is minted at a browser, by a person, with a passkey, and
`POST /v1/api-tokens` is reachable by no bearer token at all. docs/HEADLESS.md has the whole of that
and why the refusal is kept rather than fixed.

## Configuring a client

Most ACP clients take a command and its arguments. The shape is always some version of:

```json
{
  "garden": {
    "command": "sudo",
    "args": ["garden", "acp", "--workspace", "YOUR-WORKSPACE-ID"],
    "env": { "GARDEN_API": "http://127.0.0.1:4100" }
  }
}
```

On the box itself the token is read from `/etc/garden/api-token`, which is why `sudo` is there. From
another machine, drop the `sudo`, set `GARDEN_API` to the server's address and put the token in
`GARDEN_TOKEN`. Overrides are the same three `garden task` uses: `GARDEN_API`, `GARDEN_TOKEN` and
`GARDEN_TOKEN_FILE`.

## What this does not do

- **It does not stream from the stream route.** It polls `GET /v1/tasks/:taskId/events?after=N` every
  two seconds (`GARDEN_ACP_POLL_SECONDS`). `GET /v1/tasks/:taskId/events/stream` exists, reconnects
  with `Last-Event-ID`, and would put the client's first token on screen sooner. It is not used
  because a poll is a handful of lines with no reconnection state machine, and this bridge is meant
  to be small enough to audit. The cost is up to two seconds of latency per frame and nothing else.
- **It does not take images or audio.** `initialize` says so. `POST /v1/tasks` takes a string prompt
  and an `attachments` array of workspace paths, not inline bytes, so a client's image would have to
  be uploaded through `/v1/workspaces/:id/file` first - which needs `files:write`, a scope this
  bridge never asks for. Advertising the capability would promise a path that does not exist.
- **It does not use the client's filesystem or terminal.** ACP lets an agent read and write files
  through the client and run commands in the client's terminal. garden does neither: work happens in
  a workspace on the box, and nothing here touches the machine the client runs on.
- **It does not accept MCP servers from a client.** `session/new` refuses a non-empty `mcpServers`.
  Running whatever a client names would be third-party code arriving on the owner's box through a
  protocol field - a plugin marketplace with a specification on it, which this repository declined.
  garden's connectors are configured by its owner.
- **It does not implement `session/load`, `session/list`, `session/delete` or `session/resume`.** A
  client that reconnects starts a new session; the garden task it opened is still there and
  `garden task show` reads it.
- **It does not resume a parked task.** `POST /v1/tasks/:taskId/resume` is the call.
- **It does not report cost.** ACP has a `usage_update` for it. garden's `cost` events are not
  mapped onto it, so a client sees no running spend; `garden task show` does, and the spend ceiling
  is enforced server-side regardless of what any client displays.

## Proof

`scripts/acp/test-acp-bridge.mjs` spawns the real `garden acp` arm, speaks the client half of ACP
down its stdin, and answers its HTTP calls from a stand-in API on a loopback port. It needs no token,
no model and no network beyond localhost, and costs a few seconds:

```bash
pnpm acp:check
```

It runs inside `node scripts/check-repository.mjs`. The checks that matter are the approval floor
from four directions - that park mode never asks the client, that relay mode never offers a standing
yes, that a client cannot approve past a token without the scope, and that no method changes the
mode - plus one that exists because a poller gets it wrong: the store **deletes** the streamed frames
when the settled answer lands, so a naive bridge shows every reply twice.

What it cannot prove is that the API still sends the shapes it stands in for. That is
`scripts/live-drill.mjs`, against a real box and a real model, and it costs money to run.
