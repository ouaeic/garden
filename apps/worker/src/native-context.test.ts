import { describe, expect, it } from 'vitest';
import {
  canonicalInputDigest,
  canonicalMessageDigest,
  responseInputs,
  type ModelMessage,
  type NativeContinuation
} from '@athanor/model-gateway';
import { estimatedContextTokens, prepareModelContext } from './context.js';

function conversation(opaque = 'opaque-private-evidence') {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Use tools' },
    { role: 'user', content: 'Owner goal' }
  ];
  const assistant: ModelMessage = {
    role: 'assistant',
    content: 'Inspecting',
    toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'workspace/data.json' } }]
  };
  const native: NativeContinuation = {
    protocol: 'openai-responses-v1',
    binding: 'a'.repeat(64),
    inputDigest: canonicalInputDigest(messages),
    messageDigest: canonicalMessageDigest(assistant),
    items: [
      { type: 'reasoning', id: 'rs-1', summary: [], encrypted_content: opaque },
      {
        type: 'function_call',
        id: 'fc-1',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"workspace/data.json"}'
      }
    ]
  };
  messages.push(
    { ...assistant, nativeContinuation: native },
    { role: 'tool', toolCallId: 'call-1', content: 'Observed data' }
  );
  return messages;
}

describe('native continuation in bounded context', () => {
  it('counts its retained envelope and keeps an unchanged continuation across a checkpoint', () => {
    const messages = conversation();
    const canonical = messages.map(({ nativeContinuation: _native, ...rest }) => rest);
    expect(estimatedContextTokens(messages)).toBeGreaterThan(estimatedContextTokens(canonical));
    const restored = JSON.parse(JSON.stringify(messages)) as ModelMessage[];
    const context = prepareModelContext(restored, 128_000, 2048);
    expect(context.messages[2]?.nativeContinuation?.items).toHaveLength(2);
    expect(JSON.stringify(responseInputs(context.messages, 'a'.repeat(64)))).toContain(
      'opaque-private-evidence'
    );
  });
  it('removes an opaque envelope when earlier canonical evidence changes, on the request copy only', () => {
    const messages = conversation();
    messages[1]!.content = 'Revised owner goal';
    const context = prepareModelContext(messages, 128_000, 2048);
    expect(context.messages[2]?.nativeContinuation).toBeUndefined();
    expect(messages[2]?.nativeContinuation).toBeDefined();
    expect(JSON.stringify(responseInputs(context.messages, 'a'.repeat(64)))).not.toContain(
      'opaque-private-evidence'
    );
  });
  it('cannot restore content removed by deterministic truncation through opaque state', () => {
    const messages = conversation();
    messages[1]!.content = 'start ' + 'x'.repeat(90_000) + ' end';
    messages[2]!.nativeContinuation!.inputDigest = canonicalInputDigest(messages.slice(0, 2));
    const context = prepareModelContext(messages, 16_000, 2048);
    expect(context.messages[1]!.content.length).toBeLessThan(messages[1]!.content.length);
    expect(context.messages.some((message) => message.nativeContinuation)).toBe(false);
    expect(context.omittedCharacters).toBeGreaterThan(0);
  });
});
