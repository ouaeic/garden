---
name: skill-authoring
description: Turn a procedure the owner has now needed more than once into a workspace skill they approve, or correct one that has been wrong the same way twice, written in the exact shape the skill tool accepts. Use after finishing a task that repeated a non-obvious procedure the owner has asked for before, or after a saved skill has misled a run. Do not use to install, import or copy a skill from any external registry or marketplace, never to author one from a single successful run, and never to record a preference, which is memory.
license: AGPL-3.0-or-later
compatibility: No external binaries required.
allowed-tools: skill session_search file_read file_write
metadata:
  garden.tier: 'builtin'
  garden.version: '2.0.0'
  garden.risk: 'workspace'
  garden.domain: 'discipline'
---

# Skill authoring

This is the only writer of the workspace library. Nothing is ever installed from a registry:
breadth comes from the built-in library, from general computer capability that skills are
procedures over, from connected services, and from the owner's own approved procedures.

An agent-authored skill is worth roughly nothing on average; a carefully authored one is worth a
lot. The whole difference is in the preconditions and in the pitfalls. Do not skip either.

## When a proposal is even allowed

All four must hold. If any fails, do not propose — say why in your reply and move on.

1. The source task completed with real verification evidence, or the owner explicitly accepted it.
2. There is genuine procedural content: at least one self-corrected failure, one owner correction,
   or a sequence of more than a dozen tool calls that is not obvious from the tool descriptions.
3. **At least two distinct episodes of the same task shape exist.** Use `session_search` to find
   the earlier one and cite it in your reply. A skill induced from a single run encodes that run's
   file names, paths and data shapes and fails on the next one. This is the rule most worth obeying.
4. `skill(action=list)` returns nothing that already covers it. One call answers for both tiers: it
   returns this workspace's skills and the built-in index together.

A stable preference — "always use UK spelling" — is a `memory` entry, not a skill. A skill is a
procedure with steps and a verification.

## The shape the tool accepts

`skill(action=upsert)` takes exactly three things: `name`, `description` and `content`. There is no
field for tools, binaries, hosts or spend. A workspace skill runs with the capability the task
already has, and nothing written in the body grants anything — so write what to do, never what to
be allowed.

The body is **rejected outright** unless it contains all four of these as headings on their own
lines, spelled exactly like this:

```markdown
## When to use

When this applies, when it does not, and what to reach for instead.

## Procedure

Numbered steps carrying the commands that actually ran, verbatim, with their real flags. Say why
each step exists, so it can be adapted when the next case differs.

## Pitfalls

Every owner correction and every self-correction from the runs this came from, as a concrete
counter-assumption. "The `users` table uses soft deletes, so every query needs
`WHERE deleted_at IS NULL`" — not "be careful with the users table". This carries most of the value.

## Verification

What proves the procedure worked, as a command and the result it must produce.
```

`name` is lowercase words separated by hyphens, at most 64 characters. `description` is at most 240
characters and is the whole routing decision — it is what the model reads in the index and what
decides whether the skill is ever opened. Write it as when to use this and when not to, not as a
description of the subject.

Three more limits are enforced before the owner sees anything: at most 24,000 characters of body;
no credential assignment anywhere in it; no hidden control or bidirectional characters.

## What the review card shows the owner

The whole body, never a truncated version of it — hiding instructions past the point a reviewer
stops reading is a documented evasion. Alongside it the card names anything that should stop them:

- the body runs past 500 lines or roughly 5,000 tokens, which is past readable;
- it appears to contain a credential;
- it hardcodes an absolute path outside the workspace, which is one run's machine state rather than
  anything durable — write `workspace/`-relative paths instead;
- the name is one of the built-in skills, in which case approving it shadows that built-in for this
  workspace only and leaves the built-in itself intact.

Nothing is saved until the owner approves it. Propose once, after the work, in the same reply as
the result — not in the middle of a task, and not twice for the same procedure.

## Correcting a skill that was wrong

First attribute fault: was the rule wrong, or did the run ignore a correct rule? Rewriting a rule
because a task failed while it was open degrades instructions that were already right.

Revise only on skill fault, and only once it has been wrong the same way at least twice in
different contexts — a different repository, dataset or document. Single-context evidence transfers
badly. Four kinds of fault account for most of it: a missing validation step, a brittle assumption
about the input, a tool invoked with the wrong flags, and an output whose required shape was never
stated.

Then prefer patching to rewriting. `skill(action=upsert)` with the same `name` replaces the saved
body, so add the pitfall, tighten the one step, or narrow the description, and leave the rest
alone. Rebuild from scratch only when three or more distinct kinds of fault have appeared, which
means the procedure itself has drifted from the work. Say in your reply what changed and why; the
card shows the owner the new body.

## The library keeps itself small

A workspace skill that goes thirty days unused is marked stale and drops out of the resident index;
at ninety days it is archived. Pinning one exempts it. So there is nothing to retire by hand and no
reason to delete a skill that has merely gone quiet. `skill(action=remove)` is for a procedure that
is _wrong_, and it asks the owner first.

## Failure modes

- Proposing from one impressive run. The most common and the most damaging.
- Writing the procedure from memory of what should have worked rather than from what actually ran.
- Missing one of the four required headings, which fails the call outright instead of saving a
  slightly worse skill.
- A description that names the subject instead of the decision, so the skill never triggers, or
  triggers on everything.
- Recording no pitfalls, which produces a skill that restates the tool descriptions.
- Hardcoding a path, a filename or a date from the source run, so the skill works exactly once.
- Saving a preference as a skill. It belongs in `memory`, and it will go stale in the index.
