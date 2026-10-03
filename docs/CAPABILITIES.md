# Capability and design audit

This is an engineering audit of what garden actually does, written against the source rather than
against intentions. It records the deliberate boundaries too, because a boundary that is not written
down gets mistaken for an oversight — or for a promise.

## Scope

garden is built for one owner and one computer. It covers chat, a persistent Linux machine,
terminal, browser, web search, GUI applications, human takeover, files, rich artifacts, durable
history, reviewed memory, saved skills, schedules, model selection, coding-specialist handoff, previews,
device clients, the owner's own mailbox and calendar over open protocols, MCP, and a single approval
model.

It deliberately leaves out messaging-channel bots, hosted-provider resale, multi-tenant enterprise
administration, and a plugin marketplace. Those belong to a different product with a different
support burden.

There is no paid tier and no metering of the owner against a plan. The owner holds the
model-provider account and pays it directly. Four ceilings bound a run, and none of them is an
allowance:

- the **pre-flight price ceiling** (`sudo garden price-ceiling`), a maximum rate in dollars per
  million tokens that garden will not select a model above. It is the only one that acts before
  any money is spent, and the only one that works while the owner is asleep; a model the owner
  names explicitly is never constrained by it;
- the **daily, monthly and per-task spending caps** in Settings, which watch what a task has
  already spent and halt it;
- a **per-turn compute budget**, which stops one runaway loop from spending the afternoon; and
- a **two-hour wall clock per leased execution**, because the other three compose rather than cap
  and a turn that is cheap per step and never stops is invisible to all of them.

All four stop work rather than throttle it, and a stopped turn hands over what it did with a reply
that resumes it.

A turn may hand itself another step budget rather than stopping to be spoken to, but only while the
harness has just run the turn's own acceptance checks and found them failing, only while it is still
changing things, and at most twice. It buys steps, not money: the compute budget above is sized once
when the task is created and nothing raises it, so a self-continuing turn spends the remainder a
stopped one would have left behind.

## Deliberate design decisions

### Reviewed memory rather than automatic capture

Automatic fact extraction preserves wrong and sensitive claims with equal confidence. garden lets
the agent propose a compact memory, and pauses for review where review is worth having: every
replacement and every removal, because both destroy something the owner already approved; and an
addition that would reach user memory, that carries anything the credential scanner recognises, that
has no expiry or one more than a year out, or that was written on a turn which had read untrusted
content. A dated, workspace-scoped addition on a clean turn is saved without a card. That boundary
is deliberate and was moved: a card on every write read as a strict floor and behaved as the
opposite, because an agent keeping a nightly journal woke the owner at 3am and taught them to
approve without reading. What remains behind the card is what is hard to undo or is loaded into
every future task.

Judgement that does not belong on the write path is served by a review queue instead: the stale and
failing procedures, and the items recorded as contradicting one another, are listed together, and
each can be verified as still right, retracted — kept, but no longer recalled, with the record that
it stopped being true — or forgotten outright. Exact conversation evidence stays searchable without
promoting every message into long-term memory.

Each accepted fact records owner/agent provenance, optional source task, update lineage, and
`validFrom`/`validUntil`. Expired and future facts remain inspectable but are excluded from model
context. Active facts are ranked locally against recent user turns using lexical overlap, recency,
and a durable user-preference boost, within a fixed prompt budget. No content leaves the server to
perform recall.

That ranking happens once per task, from the opening request, so the cached prompt prefix survives —
which is right for what a task starts with and wrong for what it turns out to need. The agent can
therefore also ask its memory a question mid-task, and get back what the frozen pack did not already
print.

The cost of this choice is real: a fact the owner never reviews is a fact the agent will not have.
That is preferred here over a memory store that quietly accumulates whatever passed through it.

Memory recall is lexical throughout, and the semantic channel was removed rather than left dormant.
An earlier migration had created vector columns, two HNSW indexes and an embed-state enum; nothing
ever wrote a vector and no query ever read one, so it amounted to an index of nothing plus a
capability flag reporting a channel the retrieval query had no branch for. That is worse than the
absence, because it reads as a component the main path depends on. It is dropped. Finishing it would
have meant storing an embedding of every memory body unencrypted beside its ciphertext — a dense
derivative of the plaintext that the plaintext can be reconstructed from — which defeats the
encryption the memory store is built on, and does so whether the vector comes from an API or from a
model running on this computer. Lexical recall cannot reach a row from a paraphrase sharing none of
its words, and that cost is carried openly: the committed memory eval holds a probe that misses for
this reason and asserts that it still does.

### A definition of done the harness can run

A turn ends when the model replies without a tool call. When the turn changed something and the model
declared what would prove the job done, the harness runs those checks itself and sends the answer
back while any fails; past the fourth failure the answer stands with the failures stated beside it.
The model writes the checks, in its own words, for whatever the job turns out to be; the harness only
insists that "done" means something it can execute, and executes it.

### Files are the knowledge source

`document_search` ranks supported formats locally with BM25 plus phrase, title, coverage, and
per-file diversity bonuses; `document_read` extracts grounded content or PDF page ranges. Results
keep their source path and page provenance, so a claim can always be traced back.

This is a deliberate trade, not a free win. Lexical search cannot retrieve a passage that shares no
wording with the query, which a vector index can. In exchange there is no embedding model, no second
copy of the owner's documents, no index that silently goes stale when a file changes or is deleted,
and no upload of private material to compute embeddings. The agent compensates by reformulating
queries, which it is good at. A semantic index would be a different product with its own retention
story, not a hidden component needed to make the main path work.

### A curated bench, and what is deliberately not on it

The execution substrate is the owner's own persistent Linux host: seven tenths of box memory as the
ceiling on any one command, the cores the runner's control group allows, host disk, real network
access, and background work measured in hours. What that machine is stocked _with_ is a separate and
much narrower decision, because every package on it is disk, install time and attack surface on a
computer the owner uses for other things.

One table carries most of it - `scripts/garden-host.sh`, a row per capability and a column per
supported distribution family - and the installer hands that family's whole column to the package
manager: the office suite and the metric-compatible fonts a document needs to hold its layout,
poppler, qpdf, ghostscript, tesseract, ImageMagick, graphviz, ffmpeg, and the distribution's own
pandas, matplotlib, scipy, statsmodels, Pillow, lxml, openpyxl and XlsxWriter - numpy
arrives with them rather than as a row of its own, and python-docx is a row only the Debian and Red
Hat columns fill, which the installer names out loud before it installs anything on the other two.
Two mechanisms are deliberately outside that table, because a distribution name is the wrong pin
for what they carry: the typst release, fetched by `scripts/install-native.sh` at a version and a
sha256, and the hash-pinned `infra/native/garden-python-requirements.txt`, which supplies
python-pptx, pypdf and pyarrow. These supply slide generation, PDF form writing and Parquet
support consistently across supported distributions. Both land in the one pinned Python at
`/usr/local/lib/garden/python`, built with `--system-site-packages` so it is a superset of the
packages above rather than a second environment competing with them. Editing the table is therefore
the right move for an operating-system package and the wrong one for these pinned Python dependencies.

Parquet is a common data format, and `pandas.read_parquet` needs a reader. PyArrow therefore
comes from verified wheels because its OS package is absent on some supported releases. A package
earns a place here when its
absence makes the first hour of a workload the product is sold on fail. Nothing earns one by being
generally useful.

These are therefore absent on purpose, and the absence is a decision rather than an oversight:

- **scikit-learn, and any local model runtime.** The statistics capability exists so that a
  confidence interval or a p-value comes from a library instead of from a model's memory, and scipy
  and statsmodels answer that. A fitted estimator is a different question, asked far less often, and
  costs hundreds of megabytes to keep standing by; a deep-learning runtime is gigabytes on a computer
  whose contract says no model weights run locally. Either one is a single approved install away.
- **R.** An owner who works in R can install it, and which CRAN packages matter is the part that
  cannot be guessed in advance - so guessing a subset would be resident weight bought for a guess.
- **A compiler.** gcc, cc, g++ and make are not installed. That is why a `pip install` of a package
  publishing no wheel for the pinned interpreter fails on a missing compiler rather than on a missing
  library. A compiler is an ordinary approved system-package install.

The installer and release-carried update steps apply the host package table. An update runs those
steps before restarting the services; failed installation is a failed update. Runtime toolchain
reports probe the installed binaries, Python modules and fonts on the actual computer. Package
presence and import success establish availability, while representative workflows establish that a
particular task works. The Parquet capability probes both pandas and pyarrow independently of CSV
analysis, so a missing Parquet reader does not hide working CSV tools.

`scripts/garden-document-proof --manifest` lists each representative workflow and the runtime
capabilities it exercises. The runner suite checks that every capability has a workflow and that
workflow identifiers are unique. Run the proof with the pinned Python and `--require-all --json`
on the provisioned host; each job reports its measured checks and missing tools. This is a set of
representative contracts, not proof of every supported operation: image geometry and graph labels,
for example, do not establish the quality of an arbitrary design. Retain the report with the
release revision and host identity. `scripts/test-document.mjs` separately checks extraction,
OCR and paginated search coverage.

### One approval boundary

Browser, desktop, shell, files, media spend, external services, MCP, and coding specialists all feed
the same Review, Balanced, or Autonomous policy. Autonomous removes ordinary interruptions but
cannot lower the safety floor: credentials, CAPTCHAs, payments, submissions, publishing, destructive
operations, and ambiguous coordinate actions still transfer to the owner or require confirmation.

An approved action is bound to what the owner saw. The approval row stores an HMAC over the tool
arguments, and the resume path recomputes it before executing, so an approval cannot be spent on
different arguments than the ones it was granted for.

### Plan mode, enforced rather than described

Review mode cards each action one at a time, which means the owner approves steps and never the
approach: the first wrong step is on disk before the correction channel can fire. Plan mode is the
other half of that. A conversation in plan mode may read, search, look at the page the browser is
already on, and send delegated read-only missions; anything that changes this computer, or reaches
out of it other than to read or to message you, is answered with a sentence naming the mode and
saying what to do with the step instead.

It costs nothing at the head of the prompt. The tool catalogue handed to the model is byte-identical
in both modes - 55,307 bytes, unchanged by this feature - and the model is never told the mode
exists. The refusal is where it finds out, which is also why it cannot read its way out: no tool on
the wire writes the mode, and dispatch drives every tool in the catalogue to prove it. Leaving plan
mode is the owner's action and only theirs.

What may still run is derived rather than listed, from the two classifications the harness already
maintains: the checkpoint rule's set of tools that cannot change the computer, and the write
classifier. A tool added to the catalogue is refused until it is in both. That direction is
deliberate - being wrong the safe way costs one refused read, and being wrong the other way is a
plan-mode turn that changed something.

Said plainly, because a mode is judged on what it stops: plan mode refuses every `shell` call,
including `ls`, because the write classifier deliberately reads an unrecognised executable as a
check and that asymmetry runs the wrong way here. It refuses every browser action including
navigation, because the harmless verbs are separated by the approval floor and a second copy of that
list would drift from it. It refuses the compiler, because compilers were measured writing. It lets
the agent answer, and does not run the acceptance checks when it does: those checks are your own
build and test commands, executed on your computer, and a record declared on an earlier turn is
still on the trajectory when you switch the conversation over. Nothing is lost by not running them,
because a plan-mode turn changed nothing for them to be evidence about. And it
is a promise about the computer, not about the bill: web reads, delegated missions and the step
budget are unchanged, and the spending caps remain the bound for that.

WHAT IS NOT WIRED YET, said here rather than left for a reader to discover: the enforcement is
complete and tested, and the control that turns the mode on is not. The mode is carried on the
persisted turn state, so it survives a park, a resume and a worker restart; nothing in the API or
the web yet sets it, because that needs a task column this change did not own. Until that lands,
every conversation is in act mode and behaves exactly as it did.

### Specialist runtimes, not competing histories

Codex, Claude Code, and OpenCode run as bounded coding specialists invoked by the lead model.
Compact progress and resumable session IDs return into the same task, so there is one history rather
than several. A task routed through a provider's zero-retention route cannot silently cross into a
subscription CLI, because those retention policies are separate and are not represented as
equivalent.

### An honest browser

The browser uses a stable, persistent profile on the owner's own server. `navigator.webdriver` is
left truthful: masking it is bot-defence evasion, the owner is the party who would be exposed for
it, and the security policy places it out of scope. A site that refuses automation stops the agent
on that tab and that host, and nowhere else — the rest of the browser keeps working, the agent is
told to carry on with the rest of the task, and the owner is told about the one page, with taking
control a single button that brings that tab to the front. Handing the browser back clears the stop.

CAPTCHAs, identity checks, credentials, and payments always transfer to the owner. garden does not
claim to bypass site controls, and does not ship proxy or fingerprint-rotation services.

### No channel or plugin sprawl

Every additional messaging channel and community plugin multiplies credentials, retention
disclosures, unreviewed code, formatting limits, and approval ambiguity. The web, PWA, and native
clients already expose the complete task surface. Narrow external capability goes through reviewed
built-in connectors or MCP, and stays in advanced settings.

## How this was audited

- **Capability:** every claim in the README maps to a tool, API route, or client surface.
- **Reliability:** terminal work is bounded and resumable, schedules lease atomically, model calls
  retry with backoff and a deadline, task leases renew while long tools run, and updates roll back
  code and data together.
- **Security:** passkeys, exact server-key pinning, encrypted state, an unprivileged runner, narrow
  package elevation, a shared approval floor, and human takeover guard consequential work.
- **Privacy:** zero-retention routing is enforced per request, each provider is labelled by its own
  policy, and no invented privacy promise is attached to a custom endpoint.
- **Recovery:** tickets carry multiple endpoints plus identity, mDNS covers LAN changes, backups
  include publisher sessions, and restore verifies identity continuity.
- **Performance:** the GUI and desktop stream only when open, skill bodies load only when a
  procedure is opened, prompt prefixes are cached and deliberately kept byte-stable, superseded
  turns are condensed into a running brief instead of being cut out of the window, networking is
  event-driven, and execution is native rather than inside a guest VM.

## Release gates

These are open items, not hidden claims:

1. Build, sign, and attach desktop and mobile binaries. Source targets exist; store releases do not.
2. Complete packaged-client first-owner passkey, secure-cookie, and QR pairing drills, and a
   fresh-host restore.
3. Exercise real Claude Pro/Max and officially supported OpenCode publisher logins on the release
   build. Codex persistence has been exercised on a test server.
4. Run a fresh end-to-end install on a clean host against the published tag.
5. Complete packaged-client screen-reader, signed-update, long-reconnect, and no-content logging
   drills against release artifacts.

Passing compilation and tests is not production proof.
