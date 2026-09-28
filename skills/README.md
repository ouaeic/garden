# The garden built-in skill library

Every directory here is one skill: a procedure over capability the agent already has. Nothing in
this library adds a tool, and nothing is ever installed from a registry or a marketplace.

## Layout

```
skills/<name>/
├── SKILL.md        # agentskills.io-conformant front matter + the body the model reads on demand
├── garden.yaml    # garden-only sidecar: capability, verification, lineage
├── scripts/        # executable, non-interactive helpers that print JSON to stdout
├── references/     # loaded on demand, one level deep only
└── assets/         # templates and house styles
```

`SKILL.md` front matter carries **only** specification fields — `name`, `description`, `license`,
`compatibility`, `allowed-tools`, and a `metadata` map whose values are all flat strings. The
specification defines `metadata` as a map of string keys to string _values_, so garden's structured
declarations live in the `garden.yaml` sidecar, which other clients ignore.

Exactly four metadata keys are used: `garden.tier`, `garden.version`, `garden.risk`,
`garden.domain`.

## What a skill declares it uses

`allowed-tools` in the front matter and `requires.tools` in the sidecar are the same set said twice,
once in the specification's vocabulary and once in garden's. They must match: `requires.tools` is
what `openSkill` sends the model as `<skill_grants>`, and a tool the procedure uses but the sidecar
omits is a step the grants line disowns. A loader test holds them together and checks both against
the real tool catalogue, so a renamed tool cannot leave a skill pointing at nothing.

The `capability` block is what the procedure _acts on_, not what it reads about:

| Field                  | Means                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs.read` / `fs.write` | Path globs, rooted at `$WORKSPACE` or `$TMP`.                                                                                                  |
| `net.hosts`            | Hosts the procedure reaches directly.                                                                                                          |
| `exec`                 | Binaries the procedure may run through `shell`. Wider than `requires.binaries`, which is the narrower probed-and-installed list below.         |
| `connectors`           | Connector kinds the procedure calls — `imap`, `caldav`, `github`, `webdav`, `mcp_http`. Empty when it only says how to treat what one returns. |
| `spend`                | `none`, `metered` or `approval`.                                                                                                               |

**`capability` is a review declaration, not a sandbox, and reading it as one is the mistake it is
easiest to make here.** Nothing at run time consults `fs.read`, `fs.write`, `net.hosts`, `exec` or
`connectors`: what actually bounds a skill is the same approval policy, command policy and account
separation that bound the agent before the skill was opened, and the only part of the sidecar the
model is shown is `requires.tools`, rendered as an advisory `<skill_grants>` line. Narrowing these
fields therefore buys a reviewer's understanding, not a refusal. `scripts/garden-skill-check`
enforces the two ceilings that are worth enforcing — a non-builtin skill may not claim
`net.hosts: ['*']` or `spend: metered` — and it does so as a repository lint, which is what it has
always been.

There is no learned-skill file format. `skill(action=upsert)` takes exactly `name`, `description`
and `content`; there is no field for tools, binaries, hosts or spend, and a learned skill is
encrypted into PostgreSQL rather than written into this directory. The `origin: learned` branch in
the lint exists for a library that lives in a repository, which is this one.

The sidecar carries nothing else. `schema:`, `lineage.parent` and a `budget:` block of tuned-looking
millisecond values were all removed in Wave 8 after grepping both directions and finding no reader:
the body budget is a constant in the loader (`SKILL_BUDGET`, 500 lines / 5,000 tokens / 20 catalog
words) and in `garden-skill-check`, not a per-skill number, and a per-skill activation timeout was
never implemented. A tuned-looking constant is the most convincing thing a dead control can leave
behind, which is exactly why the loader's own header records having removed the last one.

## Progressive disclosure

Two levels, because full descriptions for the whole library would sit in every prompt:

1. **Catalog line** — `catalog_line` in `garden.yaml`, at most 20 words, always resident.
2. **Body** — the whole of `SKILL.md` below the front matter, injected only when the skill is
   opened.

The `description` is the trigger. Model-driven activation is the only activation: nothing in the
loader matches keywords, and the sidecar declares no trigger phrases. Say when to use the skill and
when not to in the description itself.

## Writing a skill

Describe _what it does_, _when to use it_, and _when not to_ in the description. In the body, give
the exact commands with their real flags, the failure modes, and how to verify the result. A step
that says "use the browser to fill the form" is worthless; say which actions in which order, what to
check after each, and what to do when a field rejects input.

Budget: at most 500 lines and roughly 5,000 tokens per body. The cap exists because a reviewer stops
reading, and instructions hidden past the first screen are a known evasion.

## Knowledge, not choreography

One test decides whether a skill — or a section of one — earns its place:

> Would a capable model, reading only the tool catalogue, arrive here unaided?

If yes, cut it. The catalogue already says what `repo_overview` is for, that `file_patch` detects a
stale edit, that a clean diagnostic is not a passing test suite, and that a search snippet is a
pointer rather than a citation. Restating any of that in a procedure costs the reviewer's attention
and teaches the model nothing, while making the whole file read as though it were all equally
load-bearing.

What survives is what only this skill knows: that a project's real commands are in its CI workflow
because the README goes stale; that pandas turns `007` into `7` on read; that the preview proxy
cannot reach a loopback-bound socket; that a PowerPoint text box clips instead of growing, silently,
with no error anywhere. Failure modes are usually the densest part of a skill for exactly this
reason — a failure that produces no error message cannot be rediscovered from a tool description.

**No task tracks.** A skill is not a mould for a job the model has not seen yet. Numbered phases, a
prescribed `workspace/<thing>/<name>/` layout, and a fixed deliverable shape are the signature, and
two skills were removed for it: `job-application` and `research-report`. Both decided in advance how
a job would be done, and both had a tool half that was the always-on operating contract said a
second time. When a track is cut, the facts it genuinely knew move to where the work happens — the
silent portal failures into `web-form-filling`, the guards against motivated searching into
`citation-discipline` — and a test holds both halves, that the track is gone and that its knowledge
is still somewhere.

A numbered list is fine when the order is the content: enumerate the form before planning values
before filling it, because a value planned against an assumed field is wrong. It is choreography
when the numbers only impose a sequence the model would have chosen anyway.

## One way to do each thing

A skill prescribes exactly one procedure. No "or X if you have it", no "fall back to Y", no tool
that may or may not be on the machine. A flexible instruction is one the agent has to evaluate at
run time, in front of the owner, with no way to check the answer — and a procedure that is
sometimes right is worse than a narrower one that is always right.

The one exception is a capability a distribution family genuinely does not package, and it is not a
fallback: the procedure still names one route, and where that route is absent it says so and stops,
because "this computer cannot do this" is an answer the owner can act on and a weaker substitute
silently is not. `<skill_missing_binaries>` in the opened block is what tells the model which case
it is in. Every such gap is recorded by name in `apps/worker/src/skills.test.ts`, so it cannot be
introduced quietly.

Three names carry that rule for document work, and a skill uses them rather than the tools
underneath:

| Name                                       | What it is                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/usr/local/lib/garden/python/bin/python3` | The one Python. It has python-pptx, python-docx, openpyxl, pandas, matplotlib, Pillow and the pinned pypdf. Plain `python3` does not. |
| `garden-office-convert IN OUT`             | The one way an Office file becomes a PDF or a workbook is recalculated. Exits non-zero when the bytes are not there.                  |
| `garden-pdf-tables --path F --page N`      | The one way a table comes out of a PDF.                                                                                               |

Anything a new skill names in `requires.binaries` must already be in
`services/workspace-runner/src/toolchain.ts`, installed by `scripts/install-native.sh`, and
asserted by `scripts/release-drill.mjs` — with one carve-out, named in the test so that the rule and
the test say the same thing: binaries the init system itself provides, currently `systemctl` and
`journalctl`, belong to a skill's own subject matter rather than to the document toolchain and are
exempt. A test in the workspace runner enforces the chain, so a skill cannot quietly acquire a
dependency the box does not have — which is exactly how this library drifted away from the machine
once already.

A second test, `apps/worker/src/skills.test.ts`, holds the same declarations against
`scripts/garden-host.sh` — the one table that says what each of the four supported distribution
families installs — **column by column**. A `-` in any family's column is an invisible degradation
rather than a missing feature: the skill still loads, still names the command, and fails on that
family only. Where a family genuinely has no package the degradation is recorded in that test by
name and asserted exactly, so a gap can shrink by intent and can never grow by accident.

## Checking the library

```
scripts/garden-skill-check                          # structural lint over every skill directory
pnpm --filter @garden/worker -s test                # loader and library invariants
pnpm --filter @garden/workspace-runner -s test      # toolchain chain, and documents built and measured
```
