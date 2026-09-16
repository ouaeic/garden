# Scientific workflows

Use a pipeline when an analysis has dependent stages, parallel samples or expensive intermediate
results worth reusing. A single long command can remain an ordinary durable job.

Garden supports local Nextflow pipelines through `process(action="workflow", options=...)`.
`process(action="describe")` returns the current request schema. The optional runtime is Nextflow
with a compatible Java installation; these are ordinary local tools and require no hosted account.
The runtime must be installed at `/usr/local/bin/nextflow`. Installation and downloads use the
existing governed command tools. The workflow endpoint does not install software implicitly.

Start with a project script, a descriptive name, explicit config paths when needed, and JSON
parameters. Large datasets belong in files; pass their paths as parameters. Relative inputs resolve
from the run directory, so use absolute workspace input paths or the script's `projectDir`.
Network access defaults off. Configuration files are executable code and follow the command
approval floor. Only explicitly selected configs and Garden's reporting config are loaded.

The returned `sessionId` is a durable finite job. It has no automatic execution deadline; the
owner's machine resource policy still applies. `process(action="wait", sessionIds=[...])` releases
the model turn while the job runs and resumes dependent work when the attempt ends. The project
process panel shows elapsed time, sampled CPU and RAM, captured logs and a stop control.

## Outcomes and recovery

The panel also shows completed, cached, failed and stopped stage records, including exit status,
duration and captured peak memory. A dynamic pipeline can discover more tasks as it runs: these
are recorded outcomes, not a predicted completion percentage. Missing or partially written trace
records remain explicit. Reading status never starts work or opens an active engine cache database.

Each attempt has a trace, engine log, report and timeline beneath the workflow's project directory.
The cache and work directories persist beside them. Keep both when resuming; the cache alone is
not enough. These directories can be inspected and downloaded through project files.

Resume explicitly by workflow ID, optionally changing parameters. The engine reuses eligible
completed stages and invalidates changed work according to its cache rules. The model must inspect
failures and independently validate scientific results; a successful engine exit is not scientific
validation. `garden-run` can additionally record dependency locks, source and input hashes, versions
and output checks for a reproducible command; see [Analysis runs](ANALYSIS_RUNS.md).

The owner can resume an interrupted or failed workflow from its process card, or rerun a completed
one using the cache. This uses the displayed attempt's stored parameters. Repeated clicks reconcile
the same request, and a stale card cannot start a newer attempt. Cancel waits for no further model
steps: it stops the managed job and its children. Resume is refused while a stopped job is still
exiting. Saved stage files remain available.

A lost launch acknowledgement is reconciled against the durable job receipt. If no receipt can be
found, Garden reports uncertainty and does not repeat the command. Browser disconnects and runner
restarts do not own the lifetime of an active job. After a host reboot, resume the workflow
explicitly to let its engine reuse eligible stages.
