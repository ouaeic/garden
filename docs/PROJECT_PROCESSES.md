# Project processes

Large analyses run as named finite jobs, with an optional owner-selected deadline. Their lifetime
is independent of an open browser, a model request or an agent turn. A successful job never repeats
automatically. A runner restart can resume only an explicitly declared checkpoint command; other
interrupted jobs retain their result and logs for inspection. Unnamed background commands retain
the configured task-session ceiling. Services remain a separate, supervised lifetime.

The project view lists managed processes belonging to the project and its branches, including jobs
and their sampled child processes. It uses the existing authenticated runner boundary; neither
listing nor sampling starts a command in a workspace. The owner can inspect output and stop a
managed process tree through the existing process action. Project membership comes from owned task
lineage, never from client-supplied process IDs or workspace names.

This view covers managed background sessions, finite jobs and services. Foreground tool calls remain
in the task activity record. Finished finite jobs retain the runner's existing `JOB_HISTORY_LIMIT`;
unnamed session history is temporary. The monitor does not claim a permanent inventory of arbitrary
daemonized processes or recover history the runner has already retired.

Resource readings are cached kernel observations. CPU is an interval average, with a full logical
CPU represented by 100%; multi-threaded work can exceed that. RAM is summed resident memory and
may count shared pages more than once. Samples include their time and interval, and missing or stale
measurements remain explicit. One shared sampler reads process metadata, without environment,
arguments or file contents, and does not poll in proportion to the number of open browser tabs.
On the native host, the fixed observer runs as the existing unprivileged analysis account through
the existing identity-drop helper. It reads only that account's `/proc` statistics. Hidden control
wrappers are attributed by the process group held by the runner's live child handle; their own
resource use is excluded. No sudoers permission or `ProtectProc` setting changes.

The machine can use all available CPUs. Its existing memory, task-count and storage safeguards
protect the control services; monitoring does not lower those limits. The interface reports the
configured command memory allowance. Changing a host limit remains an explicit operator action.
Operators configure the command allowance with `COMMAND_MEMORY_LIMIT_BYTES` and the runner service
envelope with `MemoryHigh` and `MemoryMax` in `infra/native/garden-runner.service`. CPU readings use
the kernel counters documented in [proc_pid_stat](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).

No new credentials, external service, paid dependency or public network listener is introduced.
The API returns only records whose task and workspace belong to the signed-in owner. Mutations keep
their existing exact-path capabilities and approval behavior. Unsupported kernel observations fail
as unavailable while process control remains usable. Older runners can serve process records without
resource samples. Rolling back removes the monitor but preserves finite-job records; jobs without a
deadline require the updated runner for checkpoint recovery.

The behavioral checks cover optional and long deadlines, timer overflow, checkpoint recovery,
successful jobs not repeating, process-tree attribution and PID reuse, cached samples, project
scope, authenticated stop actions, responsive layout and stale/error states.

## Project directories

The file card lists the project's owned execution directories, with the current continuation first.
Each root exposes its actual `workspace` tree, including nested and hidden folders. Work sharing an
execution root also shares its files, and the interface says so. Browsing is paginated and detects
directory changes between pages. Text inspection reuses the windowed editor and its conflict checks.

Individual downloads support byte ranges and flow directly to the browser's download manager. ZIP
downloads stream the selected folder or entire execution directory, preserving empty directories,
hidden files, permissions and symbolic links without following their targets. ZIP metadata grows
with the number of entries; file bytes use bounded streams and backpressure. There is no source
bundle file-count ceiling or temporary copy of the archive. Compressed scientific file formats are
stored without redundant compression. Cancellation closes the stream and its open descriptors.

Only owner file-read authority can reach the directory routes. Container credentials remain outside
the accessible tree. Non-regular special files cannot be archived, and a filename containing a
backslash cannot be represented faithfully by the ZIP writer. Those downloads fail rather than omit
content. A file or directory changing during its read also fails the archive; this is a streamed
copy, not a point-in-time filesystem snapshot. Tests exercise complete trees, pagination, concurrent
changes, cancellation, forbidden roots and scopes, and responsive directory navigation.
