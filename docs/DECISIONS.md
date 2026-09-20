# Decision inference

Garden uses a decision model for bounded semantic choices: selecting a work profile, preparing
relevant tool groups, and answering explicit choices or ratings over supplied evidence. Normal
conversation still uses a generative model. Automatic selection is the default; the existing
advanced model controls expose a Decisions purpose with the same owner, project and conversation
inheritance as other purposes.

Requests run immediately. Independent questions whose evidence is already available can share one
request. Nothing waits for a batch, and dependent questions require separate requests. This avoids
resending identical evidence without adding a scheduling delay. Decisions are useful at observable
planning and tool boundaries; the runtime cannot interrupt a provider's private reasoning stream
to insert another model.

The tool defaults to the current owner request and can reference prior tool-call IDs, so the lead
does not spend output tokens copying evidence. Repeated classifications share choice definitions
once, with short instruction strings per item. Extra context is separate from existing evidence. References resolve only within the conversation's existing working
window. Missing or compacted evidence must be read again. References cannot reach arbitrary files,
other conversations or credentials.

## Boundary and data flow

Decision inference uses the same saved connection already serving the task. An unavailable decision
route leaves ordinary execution intact. The gateway uses the owner's key
directly, outside the workspace, and sends only the supplied text and criteria. OpenRouter decision
routes use its Decisions API. They are discovered as a separate capability, never advertised as
chat or tool-calling models. Catalogue privacy eligibility and the connection's zero-retention
policy both apply. No model weights or new hosted Garden service are involved. The owner licenses
inference under their provider's service terms; Garden does not redistribute the model.

The common approval floor classifies decision inference as the same owner-configured inference
activity as the main model. A decision has no authority to approve an action, reveal a credential,
change permissions or execute code. The action still passes its own floor. Prompts, documents and
decision outputs remain data. Known candidate IDs are checked against the submitted choices;
unknown answers, incomplete coverage and out-of-range scores are rejected. A confidence value is
distribution concentration, not a guarantee of correctness. Evidence support is not source truth.

Requests are bounded by published context, task allowance, owner spending limits and cancellation.
Each attempt reserves its exposure before submission and settles reported usage, including answers
that fail validation. A lost response retains its reservation; it is never retried silently.
Automatic routing can fall back to deterministic selection when inference is unavailable. An
explicit decision tool reports unavailable instead of inventing an answer. Model selection always
applies deterministic capability, privacy, price and owner-choice constraints after classification.

## Operational behavior

Routing uses the owner's request rather than fetched pages. Explicit model choices remain binding.
Tool selection changes visibility only; the model can still load another supported group. The
decision tool accepts small, independent questions and permits an explicit insufficient-evidence
choice. Calculations, exact comparisons and execution checks belong in code. Open-ended planning,
complex inference and unresolved choices remain with the generative model.

All usage enters the existing task ledger. Request identity and selected model are recorded without
putting evidence or credentials in ordinary logs. Stored tool results and runtime state remain
encrypted with the project. Rollback restores the previous release and its encrypted preferences
backup; the extra preference field carries no authority or external state. Contract tests cover malformed
responses, privacy, spending, cancellation, ownership and fallback. Disabling decision inference
must remove an optimization, not a security boundary or access to the underlying tools.

API references: [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request),
[TypeSafe primitives](https://docs.typesafe.ai/primitives),
[confidence](https://docs.typesafe.ai/confidence),
[independent questions](https://docs.typesafe.ai/patterns/fan-out).
