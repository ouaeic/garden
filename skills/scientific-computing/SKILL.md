---
name: scientific-computing
description: Bring a toolchain this computer does not ship onto it, and run work whose data or width is larger than the workspace was sized for - a pipeline installed from a package index, a multi-gigabyte download, a command run across the box's cores. Use when the job needs a program that is not installed, a dataset of several gigabytes or more, or a run spread across many workers. Do not use for analysis the pinned interpreter already covers, which is data-analysis, and do not use for the mechanics of a run that outlives the turn, which is background-jobs; prefer isolated environments under $HOME to keep project snapshots small.
license: AGPL-3.0-or-later
compatibility: Needs python3 with the venv module, curl and the shell, all installed on every supported host. Probe the live tools before choosing or installing a runtime. Installed capabilities differ across owner machines.
allowed-tools: shell process file_read file_write files_list set_plan set_acceptance notify
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.6.0'
  athanor.risk: 'workspace'
  athanor.domain: 'science'
---

# Scientific computing

Choose the appropriate scientific toolchain and verify its actual availability. Missing software
is a dependency to install through the ordinary execution policy. Autonomous mode handles routine
installations without asking the owner to make technical choices. Read the live Machine details
and measure a representative input before choosing thread count, memory and temporary storage.
Use available hardware sensibly; avoid oversubscription across concurrently running project jobs.

## Environments and data

Keep isolated environments under `$HOME`, with project-specific names, so package trees do not
dominate source snapshots. Invoke their executables by explicit path or link entry points into
`$HOME/.local/bin`. The managed document interpreter is read-only. Probe compilers and package
managers when needed; install the missing dependency through the normal tools. Record exact
dependency locks and version probes in the project. Environments under `$HOME` are outside project
rewind, so a code rollback does not restore installed packages.

Download large datasets once using resumable transfers. Record source URLs, accessions and
published checksums; independently verify each completed download. Preserve raw inputs and write
outputs separately. Check host free space and leave capacity for temporary files. Large inputs may
be outside snapshot coverage; do not promise rewind protection for them.

## Reproducible runs

Use `garden-run` for a saved analysis with declared files and environment identity. It runs inside
the same execution sandbox and approval policy as other commands. Write a JSON specification:

```json
{
  "name": "Sequence summary",
  "command": ["python3", "analysis.py"],
  "sources": ["analysis.py"],
  "inputs": [{ "path": "input.fa", "sourceUrl": "https://example.org/input.fa" }],
  "outputs": ["results.json"],
  "environment": {
    "lockFiles": ["requirements.lock"],
    "probes": [
      { "name": "Python", "command": ["python3", "--version"] },
      { "name": "Packages", "command": ["python3", "-m", "pip", "freeze", "--all"] }
    ]
  },
  "seeds": { "simulation": 42 }
}
```

Use the interpreter belonging to the chosen environment, and replace the example URL with the
actual input source. Set seeds explicitly in the script; the manifest records declarations and
does not set library random generators. For standard-library-only work, an empty `lockFiles` plus
`"runtimeOnly": true` is an explicit declaration. Otherwise supply dependency locks and probes
that identify the actual installed packages and native tools. Probe output must be deterministic.

Run `garden-run run --spec run-spec.json --manifest run.json` in the analysis directory. For long
work, launch that command as a named durable job and wait using the process tool. It streams
command output to the job log and hashes declared files without reading whole datasets into RAM.
It refuses existing outputs and manifests; use a clean run directory.

For an input produced by an earlier recorded run, add `producer` with `manifest` (a relative path
to its completed receipt), `sha256` (that receipt's checksum), and `output` (the output path inside
that receipt). Keep the earlier receipt unchanged beside the input. The recorder checks the input
against its recorded output and retains the link in the run overview. Copied or renamed inputs
are supported when their bytes match. This verifies the immediate recorded relationship, not
scientific validity or the complete upstream chain. It never runs earlier commands automatically.

For automatic Python environment reconstruction, prepare a complete set of local wheels through
the ordinary package tools. Add `environment.python` with `interpreter` (the base Python),
`directory` (a relative path ending in `.venv`), and `wheels` (objects with `path` and `sha256`).
Include every wheel in `lockFiles`, including all transitive dependencies. Use `python` or the
installed command name in the analysis and probes. The recorder verifies the hashes, creates a
fresh environment, installs offline, checks dependencies and records an installed-package inventory.
The environment leads `PATH`; existing `.venv` directories are refused. Keep the wheel files for
replay; `.venv` package trees are excluded from project source snapshots.

For R reconstruction, prepare local source package archives and declare `environment.r` with
`interpreter` (the base R executable), `directory` (a relative `.garden/r-library` path), and
`packages` (objects with local `.tar.gz` `path` and `sha256`, in dependency order). Include all
archives in `lockFiles`; install system build dependencies through ordinary tools first. The
recorder verifies archives, installs into a new library and records rebuilt and base/recommended
package versions. It does not fetch missing packages. Use R with `--vanilla` in commands and
probes. Python and R recipes may coexist for a mixed pipeline. Library directories are disposable;
retain source archives and native-tool probes for replay.

For compiled tools and shared libraries, use a complete local Conda package set and a local
micromamba executable. Verify the manager against its official release checksum through ordinary
tools. Declare `environment.conda` with `directory` (a relative `.garden/conda` path), `manager`
(an object with `path` and `sha256`), and `packages` (local `.conda` or `.tar.bz2` objects with
`path` and `sha256`). Include the executable and every package in `lockFiles`. The recorder verifies
their identities, installs without package downloads, and solves the complete pinned set offline
against the host platform before running analysis. An incomplete or incompatible dependency set
fails preparation. Existing environments are refused, and caller package-manager configuration
cannot change the recipe.

The rebuilt `environment/bin` leads `PATH`. Use installed command names in probes and analysis.
Package installation scripts run under the existing command authority; this recipe is not a new
sandbox. Package activation scripts are not automatically sourced into analysis. If a tool needs
additional runtime configuration, make it explicit in the declared source and probes. Python and R
recipes may layer on the native toolchain using its explicit interpreter paths. The package
inventory and archive hashes support replay; operating-system services, kernel, hardware and
unsaved interpreter state are outside this recipe. Preserve the complete local archive set.

For a complete Linux userland or a service with saved local data, declare `environment.system`
instead of package recipes. It takes `directory: ".garden/system"`, an `image` object with local
archive `path` and `sha256`, an optional `data` archive of the same shape, and `launcher` with the
installed `/usr/bin/bwrap` or `/usr/bin/proot` path and SHA-256. Put both archives in `lockFiles`.
Choose the host architecture and include all required interpreters, libraries and configuration
inside the image. Probe launcher availability through governed commands first. Use PRoot where
Garden's filesystem sandbox prevents Bubblewrap namespace setup; never relax the sandbox. PRoot
adds system-call overhead, so keep ordinary host execution for work that needs no image replay.

Optional `services` contain distinct `name`, `command`, `ready` command, and `readySeconds` startup
deadline. The guest sees project files at `/work`, saved service data at `/state` and temporary
storage at `/tmp`. Prefer project-local sockets or explicitly configured unprivileged ports.
Service commands must remain in the foreground. The recorder waits for readiness, monitors them,
and stops them with the run. Logs and process timestamps appear in the receipt. Preserve a
consistent data snapshot, not a copy of a database changing during export. Image archives must
contain regular files, directories and confined links, without device nodes. Restored image
changes, changed locks or failed services prevent a successful reproduction. This does not
reconstruct a guest kernel, remote services or unsaved process memory.

To reproduce, copy the unchanged source, inputs and dependency files into a clean directory, then
run `garden-run replay --from-manifest /path/to/run.json --manifest rerun.json`. Recorded Python, R, native-package and Linux-userland
recipes rebuild their environments; otherwise recreate dependencies through normal tools.
Changed inputs, source, lock files, environment probes or platform cause refusal before execution.
Output checksum differences fail the reproduction check. The manifest does not fetch data,
capture undeclared dependencies or prove scientific validity. For nondeterministic
analyses, record and test justified numerical tolerances separately rather than reporting exact
reproduction. A run interrupted during execution is never automatically replayed.

## Dependent pipelines

For dependent stages, scatter/gather or reusable intermediate results, inspect `process(action="describe")`
and use its workflow controls. Start a project Nextflow script with explicit JSON parameters and
configuration paths. Probe the optional local Nextflow/Java runtime before choosing it; install
missing tools through governed commands. Use absolute workspace paths for input parameters or
`projectDir` in the script because the engine runs from its retained workflow directory.

Wait on the returned job `sessionId` while independent work continues. The project process panel
shows observed stage outcomes and sampled resources. Retain both the cache and work directories.
After an interrupted or failed attempt, resume explicitly with the workflow ID; changed parameters,
source or inputs can invalidate cached stages. Do not infer a completion percentage from a dynamic
task graph or treat cached execution as scientific validation.

## Verification

Independently check expected metrics and control totals, coordinate conventions, reference versions
and treatment of missing/ambiguous observations. Keep the script, specification, manifest, locks
and resulting artifacts together. Explain biological or statistical limitations separately from
execution success. Use `background-jobs` for checkpoint and recovery mechanics.
