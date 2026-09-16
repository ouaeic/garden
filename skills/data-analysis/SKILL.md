---
name: data-analysis
description: Clean a messy dataset and analyse it with a saved, re-runnable script that states its assumptions, so the numbers can be reproduced and audited rather than asserted. Use when the request involves a CSV, TSV, parquet file, database extract or pasted table and the deliverable is an answer, a summary statistic, a comparison or a chart. Do not use when the deliverable is a formula workbook the owner will edit, which belongs to xlsx-authoring.
license: AGPL-3.0-or-later
compatibility: The managed interpreter is /usr/local/lib/athanor/python/bin/python3. Probe required imports in the selected runtime before starting; other tools can be installed in an isolated environment through the normal execution policy.
allowed-tools: shell file_read file_write files_list document_read image_read set_acceptance publish_artifact
metadata:
  athanor.tier: 'builtin'
  athanor.version: '2.5.0'
  athanor.risk: 'workspace'
  athanor.domain: 'data'
---

# Data analysis

Save analysis code as a project artifact. Profile inputs before trusting inferred types, preserve
identifiers with leading zeros, record missing-value handling, check joins and report relevant
control totals after transformations. State statistical assumptions, units and denominators.
Compute results with tested libraries and verify important numbers independently.

## Runtime and reproducibility

The managed interpreter provides the document and analysis toolchain. Check required imports in
the actual interpreter selected for the run; a package installed elsewhere is not evidence that
it is available there. Install additional packages in an isolated project environment as needed,
using normal tool policy. Autonomous mode handles routine dependency setup. Preserve exact
dependency locks and the executable paths needed to recreate the environment.

Use the `scientific-computing` procedure and `garden-run` to record source, declared input hashes,
version probes and outputs. Keep inputs unchanged and write results separately. A clean rerun
should reproduce deterministic outputs; numerical tolerances for stochastic or platform-dependent
results need explicit independent checks. Neither exit success nor a checksum proves statistical
or biological validity. Explain uncertainty and unresolved data-quality problems in the result.

## Formats and inspection

Preserve source formats and meaningful types. For Parquet, probe an appropriate engine before
reading. Converting to CSV can lose categorical, decimal and other type information; only convert
when the output requirements justify it. Large CSV, TSV and JSONL outputs can be inspected in the
project file browser using bounded table pages. Those displayed type hints describe the page,
not the entire dataset. Use streaming, chunked or database operations when inputs exceed memory.

For a slide deck or workbook, prefer an editable native chart when the target format supports the
needed plot. For scientific reports and standalone figures, generate an appropriate vector or
raster artifact with readable labels, units and uncertainty. Inspect the rendered result before
publishing it, and keep the producing code and underlying data alongside it. Use the relevant
document or presentation procedure when assembling the final deliverable.
