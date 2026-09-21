# Native text inference

Direct connections to the official OpenAI API use Responses for text, images and Garden function
calls. Catalogue discovery remains shared with compatible connections. Native audio uses its
supported chat endpoint. Other compatible endpoints retain their existing protocol; a provider
label does not silently select a different endpoint.

The shared adapter factory is used by the lead, specialists, auxiliary titles and connection
checks. Responses explicitly disable API object storage, automatic context truncation and premium
service tiers. Disabling response storage is distinct from the provider account's zero-retention
eligibility. Garden does not enable hosted agents, remote MCP, hosted file search or a hosted code
interpreter through this transport. Approved provider web search retains its separate tool policy
and usage accounting.

Completed native output items retain function-call identities, assistant phases and encrypted
reasoning. They are sealed inside the conversation checkpoint with its ordinary messages. A
continuation is bound to the actual endpoint, credential, privacy route, model and conversation.
Only an unchanged canonical prefix can replay it. Editing, truncation or compaction of that prefix
discards the affected opaque state on the request copy, so removed content cannot return through
an old envelope. Numerical context-budget notices do not invalidate otherwise unchanged history.
Switching models or connections uses the canonical transcript without another route's opaque data.

Incomplete function arguments are never executable. Interrupted streams retain visible progress and
an accounting receipt; they cannot trigger an automatic retry that duplicates a partly generated
response. Output, request, framing and time bounds apply to streamed and ordinary responses.
Provider usage takes precedence over estimates, and cache reads remain separately counted. These
inference bounds do not limit managed analysis processes or their lifetimes.

Protocol fixtures exercise request bodies, tool cycles, checkpoint serialization, changed context,
parallel stream items, refusal, malformed arguments, interruption and cancellation. They establish
the client contract, not live account access or model quality. A live native-provider acceptance
requires that provider's configured account; an aggregator test does not establish it.

Protocol references: [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[reasoning continuity](https://developers.openai.com/api/docs/guides/reasoning#keeping-reasoning-items-in-context),
[function calling](https://developers.openai.com/api/docs/guides/function-calling).
