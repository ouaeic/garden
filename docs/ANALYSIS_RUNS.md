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

This contract records the declared dependency set. It does not capture containers, undeclared
packages, external service state or all ambient environment variables. It does not acquire inputs
or install dependencies automatically. Recreate the recorded environment through the usual tools.
For stochastic algorithms or hardware-dependent numerical results, a separate independent check
must define the acceptable metrics and tolerances; exact checksum equality is not a statistical
validity test. Inputs are checked before and after execution, rather than locked throughout it.

`python3 scripts/test-reproducible-run.py` uses real commands and independent expected metrics to
exercise clean replay, changed references, changed installed dependencies, expected input hashes,
input mutation, missing outputs, duplicate requests, output mismatch, excessive probe output,
signals and path boundaries. It runs in the repository gate. The native update drill also verifies
that the installed executable matches the checkout.
