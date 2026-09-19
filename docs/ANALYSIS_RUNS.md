# Analysis run records

`garden-run` records a declared scientific command inside its existing project execution boundary.
It is installed on the owner machine and available through the ordinary shell and durable-job
tools. It grants no permissions of its own. `scientific-computing` contains the specification
example and model-facing procedure.

A specification declares the argument vector, source files, input files with optional expected
checksums and source URLs, output files, dependency locks and deterministic tool-version probes.
The runner streams file hashes and command output. Existing outputs and manifest paths are refused
so another run cannot silently replace their evidence. Source URLs and seeds are declarations;
the source script must apply the seeds, and a URL alone does not prove where bytes originated.

The receipt moves through preparation, execution and verification. Manifest replacements are
synced to disk, including their containing directory. The process group is stopped on interruption
while the command is active. An interrupted or unfinished record is evidence to inspect, never an
automatic instruction to execute again. Long work should use a named durable job, whose supervisor,
resource snapshots, cancellation and log handling remain responsible for the process lifecycle.

Opening a complete JSON run record in project files or saved results presents a run overview:
recorded status, command duration, declared inputs and scripts, dependency locks, environment
probes, outputs and replay comparisons. The source JSON remains available. Unrecognised or
oversized records retain the ordinary file preview or download path. A record is a snapshot;
live process state belongs to the project's jobs view.

New records carry the execution directory relative to the manifest. When opened in project
files, this allows workspace-scoped downloads of their declared files. Downloads return current
contents, which may differ from the recorded hashes. Saved artifacts and records without a
known location do not invent links to files. Source URLs and commands are displayed as data.

An explicit replay uses a completed manifest and a clean directory containing the original source
and inputs. Before launching, it compares content hashes, lock files, version-probe output and the
recorded platform. Changed dependencies refuse execution. Afterward it compares output hashes;
a mismatch fails the reproduction check even if the scientific command exited successfully.

An input derived from another recorded analysis may declare `producer` with `manifest` (a local
relative path), `sha256` (the expected hash of that manifest) and `output` (its declared output
path). The input may be a renamed or copied file: its byte count and hash must match the producer's
recorded output. Only successful completed records with unchanged dependencies are accepted.
The producer record is checked before environment preparation, before execution and afterward;
changed records or mismatched outputs refuse or fail the run. Replay requires the same producer
records alongside the other dependencies.

The input's run-overview entry includes the producer name, run identity, output path and record
checksum, plus a workspace-scoped download when its location is known. These are explicit links
to recorded evidence. Upstream commands are never executed, upstream paths are never traversed,
and no directory index is built. A file's checksum and a supplied record cannot independently
establish who created it or whether its analysis is scientifically valid. Immediate producer
records are checked; their own upstream chain is not recursively revalidated.

An optional `environment.python` recipe recreates an isolated Python environment on both the
original run and replay. It declares an `interpreter`, a workspace-relative `directory` ending
in `.venv`, and `wheels`: local `{ "path": "…whl", "sha256": "…" }` entries. Include every wheel
in `lockFiles`, including transitive dependencies. Acquire or build these wheels through the
ordinary tools before recording the run. Wheels may contain executable code; recorded hashes
identify the selected packages and do not establish their trustworthiness.

The recipe verifies wheel hashes before creating a fresh environment. Installation uses only
those local files with hash checking, no package index, no dependency resolution and no source
builds. The installer ignores caller pip configuration and Python path overrides. A dependency
check must pass before analysis. The environment's executables lead `PATH`, so the command and
probes can use `python` or installed entry points. An additional recorded probe captures the
interpreter and sorted installed package versions. Existing environments are refused; a failed
or interrupted rebuild remains available for inspection and is never silently repaired.

Replay compares source, input and lock identities before rebuilding. Preparation and its result
are recorded in the manifest and visible in the run overview. `.venv` package trees stay outside
project source snapshots; retain the wheel files and manifest to recreate them. The base Python
installation and compatible operating-system libraries must already be available.

An optional `environment.r` recipe declares the base R `interpreter`, a relative `directory`
ending in `.garden/r-library`, and `packages`: local `{ "path": "…tar.gz", "sha256": "…" }`
source archives listed in dependency order. Include every archive in `lockFiles` and acquire
its complete dependency set through the ordinary tools before recording the run. R's compiler
and required system libraries must already be available. `R CMD INSTALL` installs only the
named local archives; package installation scripts still execute within the command's existing
sandbox. A hash identifies a package and does not establish its trustworthiness.

The R recipe refuses altered archives, existing libraries and symlinked destinations. It uses
the fresh library for R package lookup and excludes user/site library overrides and startup
profiles. The recorded inventory identifies rebuilt packages plus the base/recommended runtime
packages. A dependency outside those sets refuses the run. Native compilers and system libraries
remain subject to the declared version probes; this is not a capture of the operating system.

Python and R recipes can be used together. Their preparation states are recorded separately
in `environmentSetups` and displayed in the run overview. A replay reconstructs both before
comparing the original file identities and probes. Other environments retain the ordinary
preparation and declared-probe path. The R installation behavior follows the [R administration
manual](https://cran.r-project.org/doc/manuals/r-release/R-admin.html#Installing-packages).

This contract records the declared dependency set. It does not capture containers, undeclared
packages, external service state or all ambient environment variables. It does not acquire inputs.
For stochastic algorithms or hardware-dependent numerical results, a separate independent check
must define the acceptable metrics and tolerances; exact checksum equality is not a statistical
validity test. Inputs are checked before and after execution, rather than locked throughout it.

`python3 scripts/test-reproducible-run.py` uses real commands and independent expected metrics to
exercise clean replay, changed references, changed installed dependencies, expected input hashes,
input mutation, missing outputs, duplicate requests, output mismatch, excessive probe output,
signals, path boundaries and local-package environment reconstruction. R-dependent cases report
a skip when R is unavailable and require native acceptance on an R-equipped host. It runs in the repository gate. The native update drill also verifies
that the installed executable matches the checkout.
