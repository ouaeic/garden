# Live context comparison

This opt-in experiment compares the current operating contract and tool schemas with
smaller wire payloads. It uses the real worker and model gateway, synthetic files and
fixed web responses. It does not run commands or validate browser/artifact execution.
No production code imports the candidate transforms.

Use Node and pnpm versions declared by the repository. Check the meter and schema
preservation before spending provider quota:

```sh
NODE_OPTIONS=--conditions=development node --import tsx --test evals/context-live/*.test.mjs
```

Supply `AI_API_KEY` through the environment. The runner accepts only the Ollama Cloud
endpoint; it does not fall back to another provider. The explicit live flag is required:

```sh
NODE_OPTIONS=--conditions=development node --import tsx evals/context-live/run.mjs --live --output /tmp/garden-context-comparison
node evals/context-live/report.mjs /tmp/garden-context-comparison/results.json
```

`--task`, `--arms` and `--repetitions` select a bounded pilot. The complete task list,
candidate hashes, source revision, request ceilings and decision rule are written to
`plan.json` before the first request. Arm order rotates across tasks and repetitions.
Provider caching cannot be flushed, so these are repeated requests under an unknown
initial cache state, not guaranteed cold/warm pairs.

The current arm preserves the production prompt. The short-contract arm rewrites the
working and response guidance while preserving environment and authority text. The
schema-only arm removes parameter description annotations while preserving field names,
types, required fields, enums, limits, tool-level descriptions and tool discovery.
The combined arm applies both transforms. Runtime validation and approval controls remain
active in every arm.

Results contain synthetic prompts, tool calls, outcomes, provider input/output/cache
counts and timings. Credentials are neither logged nor included. Missing cache counters
remain unknown. Input and output totals are provider counts; there is no dollar-cost
claim. Full-task totals include retries and completion repair calls.

Scoring checks exact requested formats, expected facts, required reads, completion and
tool errors. The stricter efficiency score also excludes unexpected tools. Review failed
answers and authority-sensitive tool calls alongside the aggregate: a text matcher is
not a general model-quality judge, and repeated tasks are not independent task families.

The fixture filesystem resolves names using the runner's own path normalization. Its
command responses are synthetic, so shell-based alternatives cannot establish real
execution success. The web-discovery probe explicitly requests the built-in reader to
keep that limitation out of its expected path.

Nothing ships automatically from this exploratory sample. A cheaper request can require
more steps or lose required instructions, and successful small read-only tasks do not
establish safety or quality for long coding, browser, publishing or compaction workflows.
