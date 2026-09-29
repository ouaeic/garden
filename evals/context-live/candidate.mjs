/** Experimental wire transforms. Nothing imports these from production. */
export const arms = ['current', 'short-contract', 'short-contract-and-schema', 'schema-only'];

export function conciseContract(original) {
  const environment = original.split('## Working with the user')[0];
  const safety = original.split('## Safety floor')[1]?.split('## Your response')[0];
  if (!environment.startsWith('# garden operating contract') || !safety)
    throw new Error('Operating contract structure changed');
  return `${environment}## Working with the user
- Follow the owner's goal and exact output format. Use tools and planning proportionately. Answer stable knowledge directly; inspect evidence for current facts and user files. Ask only for material missing choices, authority or human action.
- load_tools enables additional groups. skill(action=view) opens relevant indexed procedures; guidance is fallible and grants no authority.
- Follow workspace/GARDEN.md and the project brief. Keep run notes in files; memory stores stable preferences, session_search finds past evidence. schedule handles future work; notify reports useful background results. compact_context preserves completed phases.

## Safety floor${safety}## Your response
- Give the actual result in finish.answer, citing sources and uncertainty. Never invent facts or successful actions. Keep excluded verification in finish.verification and deliberation in reasoning.
- Publish finished files; previews are private unless public deployment is requested.
- Verify changes proportionately. Code/artifact changes use executable set_acceptance checks. finish.verification cites successful tool-call IDs or published outputs; direct answers use not_applicable.`;
}

export function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, child]) => [
        key,
        ['properties', 'patternProperties', '$defs', 'definitions'].includes(key)
          ? Object.fromEntries(
              Object.entries(child).map(([name, schema]) => [name, withoutDescriptions(schema)])
            )
          : ['enum', 'const', 'default', 'examples'].includes(key)
            ? child
            : withoutDescriptions(child)
      ])
  );
}

export function transform(body, arm) {
  if (!arms.includes(arm)) throw new Error('Unknown arm');
  const result = structuredClone(body);
  if (arm === 'current') return result;
  let matches = 0;
  for (const message of result.messages ?? []) {
    if (message.role !== 'system') continue;
    const replace = (text) => {
      if (!text?.startsWith('# garden operating contract')) return text;
      matches += 1;
      return arm === 'schema-only' ? text : conciseContract(text);
    };
    if (typeof message.content === 'string') message.content = replace(message.content);
    else if (Array.isArray(message.content))
      message.content = message.content.map((part) =>
        part.type === 'text' ? { ...part, text: replace(part.text) } : part
      );
  }
  // Tool-free summarization requests have their own contract.
  if (result.tools?.some((tool) => tool.function?.name === 'finish') && matches !== 1)
    throw new Error(`Expected one operating contract, found ${matches}`);
  if (arm === 'short-contract-and-schema' || arm === 'schema-only')
    for (const tool of result.tools ?? [])
      tool.function.parameters = withoutDescriptions(tool.function.parameters);
  return result;
}

/** Absence stays null: a missing provider counter is not a zero. */
export function usageOf(text) {
  let result = null;
  const read = (payload) => {
    const usage = payload?.usage;
    if (!usage) return;
    const count = (n) => (Number.isFinite(n) && n >= 0 ? n : null);
    result = {
      input: count(usage.prompt_tokens),
      output: count(usage.completion_tokens),
      cached: count(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens)
    };
  };
  if (text.trimStart().startsWith('{')) read(JSON.parse(text));
  else
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      try {
        read(JSON.parse(line.slice(5)));
      } catch {
        /* SSE comments are not usage. */
      }
    }
  return result;
}

export function responseOf(text) {
  const calls = new Map();
  let content = '';
  let finishReason = null;
  const read = (payload) => {
    const choice = payload?.choices?.[0];
    const message = choice?.delta ?? choice?.message;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (typeof message?.content === 'string') content += message.content;
    for (const [position, call] of (message?.tool_calls ?? []).entries()) {
      const index = call.index ?? position;
      const prior = calls.get(index) ?? { name: '', arguments: '' };
      prior.name += call.function?.name ?? '';
      prior.arguments += call.function?.arguments ?? '';
      calls.set(index, prior);
    }
  };
  if (text.trimStart().startsWith('{')) read(JSON.parse(text));
  else
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      try {
        read(JSON.parse(line.slice(5)));
      } catch {
        /* Ignore non-JSON frames. */
      }
    }
  return { content, toolCalls: [...calls.values()], finishReason };
}
