---
name: verification-evidence
description: Decide what counts as proof that a task is actually done, gather that proof with the tools that produce it, and refuse to report completion without it. Use before calling finish, whenever a deliverable file has been written, and whenever a command "succeeded" but nothing was inspected. Do not use as a substitute for the format-specific verification in render-proof, typst-pdf or xlsx-authoring; this skill decides what evidence is required, those produce it.
license: AGPL-3.0-or-later
compatibility: No external binaries required.
allowed-tools: set_acceptance shell file_read files_list document_read image_read audio_read publish_artifact finish
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.4.0'
  athanor.risk: 'read_only'
  athanor.domain: 'discipline'
---

# Verification evidence

A task is finished when the requested outcome has been observed, not when the last tool call
returned without an error. What counts as observing it — read the file back, run the thing, look at
the rendered page, ask a second mechanism — is your judgement and it changes per deliverable. This
skill is about the one part of it the harness enforces, and about the ways declaring it goes wrong.

## Declaring the checks

Before you change anything, declare the checks with `set_acceptance`. The harness runs them itself
when you call `finish` and refuses the finish while any of them fails, so they are the definition of
done rather than a claim about it — which is exactly why they are declared before the work, when you
have no stake in what passes. A `command` check is an executable, its arguments, and the exit code
and stdout it must produce; an `artifact` check is a path that must exist, must not be under a size,
and — for a document — must render to the pages the job asked for.

Make each one specific enough to fail. "The budget workbook exists" is not a check;
`athanor-office-convert budget.xlsx proofs/budget.pdf` with `expectExit: 0` is.

**A check may not reach the network or change the machine**, and the harness refuses it by the shape
of the command rather than by a name list: `curl`, `wget`, `ssh`, `scp`, `rsync`, `gh`, `rm`, `mv`,
`dd`, `chmod`, `chown`, the package managers, `systemctl`, `reboot` and
`git push`/`clean`/`reset`/`restore`/`checkout`. A wrapper is judged by what it runs and an
interpreter by the script it is handed, so `bash -lc "curl …"` is refused too. When the thing you
want to prove needed one of those — a deployment health check is the usual case — make the request
during the work, save what came back, and declare an `artifact` check on the saved response.

## Three things about it that are not obvious

**A definition of done that already passes is refused.** When you declare checks before anything has
changed, the harness runs them there and then. If every one of them passes at that moment it says
what it saw and asks for one that fails now — so `test -f report.pdf` on a file already sitting
there, or a bare `true`, is rejected rather than banked. Declare the check against the work that
does not exist yet. An already-passing check is welcome _alongside_ a failing one, because that is a
regression guard.

**Declare them before you change anything.** Checks declared after the turn has already written
something are still accepted, and nothing marks them — the hold on `finish` is the only thing that
ever asks for a record, and it fires because something has already changed, so a caveat for it would
print on nearly every completed task and would be about this box's step order rather than about your
checks. Declaring late costs you the one thing worth having instead: a check written after the work
is a check written by someone with a stake in what passes. A record inherited from an earlier turn
_is_ marked, because it was green before this turn began, so it shows that nothing broke rather than
that this work is right — and finishing is held until this turn declares its own.

**Calling it again is allowed and both versions are shown to the owner**, because weakening your own
test is a different act from passing it.

## Where the harness stops and you start

It runs commands, looks at files, and measures the pages of a document — how many, whether any word
was cut at an edge, whether any page is blank. It cannot tell you the chart is mislabelled. So a
rendered page read with `image_read` is evidence you gather and attach, never a check you can
declare, and the final summary is where it lands.

Gather that evidence in the same session: a tool result from twenty steps ago may describe a file a
later step overwrote. Gather it with a different reader than the one that wrote the artifact —
asking the writer to read back its own in-memory model proves nothing, which is why the recalculation
engine, the renderer and a fresh request are worth more than a second look from the same code path.
And compare the result against the request rather than against your plan; the most common silent
failure is delivering the thing you decided to build.

When an analysis reports no matches, test the actual analysis code on a small positive control
with a known match as well as a negative control. Two implementations returning empty lists do
not prove either can detect anything. Exercise relevant boundaries, such as overlapping matches
and a circular sequence's origin, and compare exact coordinates rather than just counts.

The summary states, per deliverable: what it is, where it is, what was checked, and what was not.
"Not checked" is an acceptable answer. "Checked", without saying how, is not.
