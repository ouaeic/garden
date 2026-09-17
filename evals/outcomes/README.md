# Independent outcome checks

This rig evaluates delivered artifacts and received form submissions against an evaluator-owned
oracle. Agent-written acceptance checks and an agent's completion claim do not decide correctness.
The cases are development calibrations, with public generators and negative controls. They are not
held-out tasks, a model benchmark, or evidence of broad task success.

Run the keyless calibration:

```sh
pnpm eval:outcomes --ci
```

The calibration uses actual temporary files and a loopback HTTP form. Its positive answer parses the
public FASTA independently of the generator's segment counts. Incorrect GC denominators, lost duplicate
records, wrong reference bytes, missing report sections, stale evidence, unsupported causality,
fabricated quotations and wrong form values must fail even when completion is recorded as successful.
It also saves a submission before dropping the acknowledgement, restarts the fixture server, checks
saved state, retries idempotently and refuses conflicting values for the same submission key.

## Running a task

Prepare new, separate directories under an existing parent:

```sh
pnpm eval:outcomes prepare /tmp/outcome-public /tmp/outcome-private
pnpm eval:outcomes serve /tmp/outcome-private /tmp/outcome-public --lose-ack
```

Transfer **only** the public directory into the task's project. Supply the printed form URL separately. Its `/inputs/` routes serve only the verified public bundle.
Keep the private directory on the evaluator's machine, outside every filesystem and process namespace
the agent can access. File permissions alone do not isolate it from another process with the same
identity. The private directory contains expected answers, the signing key and received submissions;
none belongs in task attachments, repository context, prompt text or model-visible tool results.
The fixture binds only to loopback. For a task on a different host, forward that port through the
operator's existing authenticated connection rather than exposing the evaluator on a public address.

The form uses synthetic identities. Its server records received fields without comparing them with
expected values, and has no oracle, grading or receipt-signing HTTP endpoint. A persisted route and
idempotency key survive fixture restart. Checking the saved-status page after a lost acknowledgement
records that the saved result was recovered. This narrow fault does not simulate all browser crashes,
provider failures or application-specific submission contracts.

Stop `serve` with SIGINT or SIGTERM after the task ends. It writes a signed `receipt.json`. Pass
`--metrics=/absolute/path/metrics.json` to attach trusted task/provider observations using the metrics
fields in `schema.ts`: completion, model, provider, billed cost, input/output/cached tokens, elapsed
milliseconds and intervention categories. Collect these from the evaluator's authenticated task
records and provider accounting, never from the agent's answer. Omitted observations are `null`, not
zero or successful. A signature binds the case and public-input digest; it attests to the evaluator's
record, not to the independent accuracy of manually supplied metrics.

Retrieve the task's `result.json` and grade it on the evaluator's machine:

```sh
pnpm eval:outcomes grade /tmp/outcome-private /tmp/outcome-public /tmp/result.json /tmp/outcome-private/receipt.json
```

The public directory must still contain the original input files only. A digest mismatch refuses to
grade a modified task. Keep the JSON output alongside the task and provider receipts. Correctness,
completion, interventions, cost, latency and recovery remain separate dimensions; a correct artifact
does not imply the task completed successfully, and completion cannot excuse a wrong artifact.
Invalid or foreign observation signatures make the observation dimensions unknown and fail integrity.

## Coverage limits

Science grading checks the explicit sequence-counting contract, not scientific discovery. Document
grading checks required nonempty sections; it does not establish prose quality, page layout or the
correctness of arbitrary statements in those sections. Citation grading checks the requested claims,
evidence date, exact source and supporting quotation; a genuine but irrelevant quotation is rejected.
It is not general natural-language entailment. Extend cases and independent validators for each new
workflow, then reserve separate unseen tasks before making model-quality comparisons. Do not train
prompts against a calibration and describe its score as held-out performance.
