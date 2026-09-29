import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arms,
  conciseContract,
  transform,
  usageOf,
  withoutDescriptions,
  responseOf
} from './candidate.mjs';
import { BASE_SYSTEM_PROMPT } from '../../apps/worker/src/context.ts';
import { agentToolsFor } from '../../apps/worker/src/tool-catalogue.ts';
import { fixtureFiles } from './workspace.mjs';

test('candidate retains argument contracts, tool descriptions and authority floor', () => {
  const tools = agentToolsFor();
  assert.ok(tools.length > 0);
  const body = {
    messages: [
      { role: 'system', content: BASE_SYSTEM_PROMPT },
      { role: 'user', content: 'Hello' }
    ],
    tools: tools.map((tool) => ({ type: 'function', function: tool }))
  };
  assert.deepEqual(transform(body, 'current'), body);
  for (const arm of arms.slice(1)) {
    const changed = transform(body, arm);
    assert.deepEqual(
      changed.tools.map((tool) => tool.function.name),
      tools.map((tool) => tool.name)
    );
    for (const [index, tool] of changed.tools.entries()) {
      assert.equal(tool.function.description, tools[index].description);
      assert.deepEqual(
        withoutDescriptions(tool.function.parameters),
        withoutDescriptions(tools[index].parameters)
      );
    }
    assert.equal(changed.messages[1].content, 'Hello');
    assert.equal(
      changed.messages[0].content.split('## Safety floor')[1].split('## Your response')[0],
      BASE_SYSTEM_PROMPT.split('## Safety floor')[1].split('## Your response')[0]
    );
    assert.ok(JSON.stringify(changed).length < JSON.stringify(body).length);
  }
  assert.ok(conciseContract(BASE_SYSTEM_PROMPT).length < BASE_SYSTEM_PROMPT.length);
});

test('description-named fields and literal data are preserved', () => {
  const schema = {
    type: 'object',
    description: 'Annotation',
    properties: {
      description: { type: 'string', description: 'Field help' },
      data: { const: { description: 'Literal value' } }
    },
    required: ['description']
  };
  assert.deepEqual(withoutDescriptions(schema), {
    type: 'object',
    properties: {
      description: { type: 'string' },
      data: { const: { description: 'Literal value' } }
    },
    required: ['description']
  });
});

test('cache absence, explicit zero and streamed usage remain distinct', () => {
  assert.equal(usageOf('data: [DONE]\n'), null);
  assert.deepEqual(
    usageOf(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 2 } })),
    { input: 12, output: 2, cached: null }
  );
  assert.equal(
    usageOf('data: {"usage":{"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]\n')
      .cached,
    0
  );
  assert.equal(
    usageOf(
      'data: {"usage":{"prompt_tokens":128,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":64}}}\n\ndata: [DONE]\n'
    ).cached,
    64
  );
});

test('live tool calls are recovered from fragmented SSE', () => {
  const frame = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  const result = responseOf(
    frame({ tool_calls: [{ index: 0, function: { name: 'file_', arguments: '{"path":' } }] }) +
      frame({
        tool_calls: [{ index: 0, function: { name: 'read', arguments: '"workspace/a"}' } }]
      }) +
      'data: [DONE]\n'
  );
  assert.deepEqual(result.toolCalls, [{ name: 'file_read', arguments: '{"path":"workspace/a"}' }]);
});

test('controlled files share the production runner path semantics', () => {
  const files = fixtureFiles({ 'workspace/example.txt': 'same content' });
  for (const path of [
    'example.txt',
    './example.txt',
    'workspace/example.txt',
    './workspace/example.txt'
  ])
    assert.equal(files[path], 'same content');
  assert.equal(files['../example.txt'], undefined);
  assert.equal(files['absent.txt'], undefined);
  assert.deepEqual(Object.keys(files), ['workspace/example.txt']);
});
