---
name: background-jobs
description: Run work that outlives a single turn — long builds, large batches, scheduled routines, watchers — as a manifest that a later run resumes from, with a key on every external write that makes a retry land once. Use when a task will take many minutes or hours, processes many items, or must run again later on a schedule. Do not use for a command that finishes in seconds, and never replay a checkpointed job whose external writes are not idempotent.
license: AGPL-3.0-or-later
compatibility: No external binaries required beyond the job's own toolchain.
allowed-tools: shell process schedule notify file_read file_write files_list set_plan set_acceptance publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.4.0'
  athanor.risk: 'workspace'
  athanor.domain: 'long-running'
---

# Long-running and background work

The `shell`, `process`, `schedule`, `notify` and `memory` schemas already carry the mechanics of
this: what ends an unnamed background process, what a named service survives, how much a scheduled
run may spend, that an unattended run says nothing at all unless you call `notify`, and that a
running record belongs in an ordinary project file such as `workspace/RUN_LOG.md`, rather than in
standing instructions or durable memory. None of that is
repeated here. What follows is the part that is true on this computer and nowhere in the schemas.

## The manifest is the checkpoint

Run a long analysis with `shell(background=true, job="Analysis name", ...)`. Omit `timeoutSeconds`
when its duration is unknown; an explicitly requested deadline is preserved across recovery.
Write scripts and let them use the machine's available CPUs within its reported memory allowance.
Closing the browser or finishing the agent turn does not stop a named job. Report its session ID
and output paths so the owner can follow it in the project's process view.

Verify startup, then hand over when the work can continue independently. Do not spend model turns
polling a long job in a tight loop. Schedule a follow-up only when later interpretation or an
owner-requested notification is needed; the process monitor updates without model calls.

For work that can checkpoint, keep `workspace/jobs/<job>/manifest.json` or the analysis tool's native
checkpoint and declare `checkpointResumeCommand` only when it can safely resume saved work. A runner
restart cannot restore arbitrary process memory. Without a checkpoint command Garden preserves an
interruption for inspection. Use a schedule when later independent runs are wanted, and a service
for a server that should restart after every exit. A successful finite job never repeats itself.

One entry per item, each `pending`, `running`, `done` or `failed`, carrying its output path and its
error text, rewritten after every item rather than at the end — which is exactly when the crash
makes it unwritable.

Count the outcome out of the manifest, never out of the loop. The loop counts what it tried; the
manifest records what landed, and they differ precisely when it matters. That count is the check to
hand `set_acceptance` before the batch starts, so the harness itself refuses the finish while any
item still reads `pending`.

## What may not run unattended

Every external write in a batch carries a key derived from the item rather than from the clock, so
a retry produces the identical key and the write lands once.

An operation that cannot be made idempotent — sending a message, making a payment, submitting a
form — does not go into an unattended batch at all. It goes into a list the owner approves and then
runs once.

Never leave an unnamed background process running when the task ends. Kill it, or hand over its
session id and say plainly that it dies with the next restart of this computer.

## Watching something

A watcher compares against saved state, never against its own judgement: read
`workspace/watch/<name>/previous.json`, fetch, extract the same fields, write the new snapshot, and
notify only on a difference — naming the field, the old value and the new one. Without that saved
state a run can only notify every time or never, which is the whole defect the silence rule exists
to prevent.
