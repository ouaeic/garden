---
name: scientific-computing
description: Bring a toolchain this computer does not ship onto it, and run work whose data or width is larger than the workspace was sized for - a pipeline installed from a package index, a multi-gigabyte download, a command run across the box's cores. Use when the job needs a program that is not installed, a dataset of several gigabytes or more, or a run spread across many workers. Do not use for analysis the pinned interpreter already covers, which is data-analysis, and do not use for the mechanics of a run that outlives the turn, which is background-jobs; prefer isolated environments under $HOME to keep project snapshots small.
license: AGPL-3.0-or-later
compatibility: Needs python3 with the venv module, curl and the shell, all installed on every supported host. Probe the live tools before choosing or installing a runtime. Installed capabilities differ across owner machines.
allowed-tools: shell process file_read file_write files_list set_plan set_acceptance notify
metadata:
  athanor.tier: 'builtin'
  athanor.version: '1.1.0'
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

To reproduce, recreate the locked environment and copy the unchanged source and inputs into a
clean directory, then run `garden-run replay --from-manifest /path/to/run.json --manifest rerun.json`.
Changed inputs, source, lock files, environment probes or platform cause refusal before execution.
Output checksum differences fail the reproduction check. The manifest does not install packages,
fetch data, capture undeclared dependencies or prove scientific validity. For nondeterministic
analyses, record and test justified numerical tolerances separately rather than reporting exact
reproduction. A run interrupted during execution is never automatically replayed.

## Verification

Independently check expected metrics and control totals, coordinate conventions, reference versions
and treatment of missing/ambiguous observations. Keep the script, specification, manifest, locks
and resulting artifacts together. Explain biological or statistical limitations separately from
execution success. Use `background-jobs` for checkpoint and recovery mechanics.
