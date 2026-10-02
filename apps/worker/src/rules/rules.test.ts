import type { ModelMessage } from '@garden/model-gateway';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PROMPT } from '../context.js';
import { agentToolsFor } from '../tool-catalogue.js';
import {
  DORMANT_RULES,
  RULE_CORRECTION_MARKER,
  applyDormantRules,
  resetRuleFiringCounts,
  ruleFiringCounts,
  toolsRunThisTurn,
  type DormantRule
} from './index.js';

/** A window in the shape a step boundary actually leaves behind: contract, goal, step, results. */
const window = (
  assistant: { text?: string; toolCalls?: ModelMessage['toolCalls'] },
  trailing: ModelMessage[] = [{ role: 'tool', toolCallId: 'c1', content: 'ok' }]
): ModelMessage[] => [
  { role: 'system', content: BASE_SYSTEM_PROMPT },
  { role: 'user', content: 'Put together the quarterly deck and tell me what changed.' },
  {
    role: 'assistant',
    content: assistant.text ?? '',
    ...(assistant.toolCalls ? { toolCalls: assistant.toolCalls } : {})
  },
  ...trailing
];

const call = (
  name: string,
  args: Record<string, unknown>
): NonNullable<ModelMessage['toolCalls']>[number] => ({ id: 'c1', name, arguments: args });

beforeEach(() => {
  resetRuleFiringCounts();
});

describe('dormant rules cost nothing until they fire', () => {
  /*
   * The whole claim of this tier, asserted the only way it can be: byte for byte.
   *
   * A mechanism that carries 27 rules for zero resident bytes is worth having; a mechanism that
   * carries them for "almost zero" is a worse version of putting them in the contract, because it
   * pays the bytes and adds a matcher. Every other test in this file is about whether a rule is
   * right. This one is about whether the tier exists at all.
   */
  it('leaves the request byte-identical when no rule matches', () => {
    const messages = window({
      text: 'The three regional totals are in workspace/q3.csv and the trend is flat.',
      toolCalls: [call('file_read', { path: 'workspace/q3.csv' })]
    });
    const before = JSON.stringify({ messages, tools: agentToolsFor() });
    const fired = applyDormantRules(messages, toolsRunThisTurn({ c1: { name: 'file_read' } }));
    expect(fired).toEqual([]);
    expect(JSON.stringify({ messages, tools: agentToolsFor() })).toBe(before);
  });

  it('puts no rule text into the operating contract or the tool catalogue', () => {
    const wire = `${BASE_SYSTEM_PROMPT}${JSON.stringify(agentToolsFor())}`;
    // With no dormant rules there is nothing to be absent from the wire, and the whole claim of
    // this file - that a rule costs nothing until it fires - would be made by an empty loop.
    expect(DORMANT_RULES.length).toBeGreaterThan(0);
    for (const dormant of DORMANT_RULES) {
      expect(wire).not.toContain(dormant.correction);
      expect(wire).not.toContain(RULE_CORRECTION_MARKER);
    }
  });
});

describe('the sleep-poll rule', () => {
  /*
   * The defect this bound exists for, found by reading the schema rather than by running the turn.
   *
   * The first draft matched `arguments.command`. There is no such field and there never was -
   * `shell` runs one executable and takes its arguments as an array, precisely so that nothing
   * expands - so the matcher passed a fixture somebody had invented and would have matched nothing
   * in production for ever. A rule that cannot fire is worse than no rule: it is a mechanism the
   * next reader believes is covering something.
   */
  it('matches the fields the shell tool actually has', () => {
    const shell = agentToolsFor().find((tool) => tool.name === 'shell');
    const properties = Object.keys(
      (shell?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    );
    expect(properties).toContain('executable');
    expect(properties).toContain('args');
    expect(properties).not.toContain('command');
  });

  it('fires on a shell that waits by the clock', () => {
    const messages = window({
      toolCalls: [call('shell', { executable: 'sleep', args: ['30'] })]
    });
    expect(applyDormantRules(messages, new Set(['shell']))).toEqual(['sleep-poll']);
    expect(messages.at(-1)?.content).toContain('wait_for');
  });

  it('fires on a polling loop', () => {
    const messages = window({
      toolCalls: [
        call('shell', {
          executable: 'bash',
          args: ['-lc', 'while ! curl -sf localhost:8080; do sleep 2; done']
        })
      ]
    });
    expect(applyDormantRules(messages, new Set(['shell']))).toEqual(['sleep-poll']);
  });

  it('leaves the word alone where it is not a command', () => {
    const messages = window({
      toolCalls: [call('shell', { executable: 'grep', args: ['-rn', 'sleep mode', 'src/'] })]
    });
    expect(applyDormantRules(messages, new Set(['shell']))).toEqual([]);
  });
});

describe('a rule is corrected once, not every step', () => {
  it('does not append a second copy while the first is still in the window', () => {
    const messages = window({
      toolCalls: [call('shell', { executable: 'sleep', args: ['30'] })]
    });
    expect(applyDormantRules(messages, new Set(['shell']))).toEqual(['sleep-poll']);
    const after = JSON.stringify(messages);
    expect(applyDormantRules(messages, new Set(['shell']))).toEqual([]);
    expect(JSON.stringify(messages)).toBe(after);
    expect(ruleFiringCounts().get('sleep-poll')).toBe(1);
  });

  /*
   * Deduplication is the window itself rather than a persisted flag, and this is the property that
   * buys: a compaction genuinely deletes the messages it condensed, so a correction that has been
   * condensed away is a correction the model can no longer read - and a rule whose evidence has
   * left the window is a live rule again. A counter in the state would have said "already said
   * that" about a sentence nothing in the request contains.
   */
  it('becomes live again once a compaction has condensed the correction away', () => {
    const messages = window({
      toolCalls: [call('shell', { executable: 'sleep', args: ['30'] })]
    });
    applyDormantRules(messages, new Set(['shell']));
    const condensed = messages.filter(
      (message) => !message.content.startsWith(RULE_CORRECTION_MARKER)
    );
    condensed.push({ role: 'assistant', content: '', toolCalls: [] });
    condensed.push({ role: 'tool', toolCallId: 'c1', content: 'ok' });
    condensed[condensed.length - 2] = {
      role: 'assistant',
      content: '',
      toolCalls: [call('shell', { executable: 'sleep', args: ['30'] })]
    };
    expect(applyDormantRules(condensed, new Set(['shell']))).toEqual(['sleep-poll']);
  });
});

describe('a rule cannot damage the turn it observes', () => {
  /*
   * The one shape that would break the next request outright. An assistant message carrying tool
   * calls has to be followed immediately by their results; a system message wedged in between is a
   * malformed request the provider refuses, which turns a correction into a dead turn.
   */
  it('appends nothing while a tool call is still unanswered', () => {
    const messages = window(
      { toolCalls: [call('file_write', { path: 'workspace/q.docx', content: '' })] },
      []
    );
    const before = JSON.stringify(messages);
    expect(applyDormantRules(messages, new Set(['file_write']))).toEqual([]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('appends nothing before the model has said anything at all', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: BASE_SYSTEM_PROMPT },
      { role: 'user', content: 'Build the deck.' }
    ];
    const before = JSON.stringify(messages);
    expect(applyDormantRules(messages, new Set())).toEqual([]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('survives a matcher that throws', () => {
    const broken: DormantRule = {
      id: 'broken',
      matches: () => {
        throw new Error('bad rule');
      },
      correction: 'never appended'
    };
    const messages = window({ text: 'A perfectly ordinary answer.' });
    const before = JSON.stringify(messages);
    expect(applyDormantRules(messages, new Set(), [broken])).toEqual([]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('reads the step the model produced, not a tool result that quotes it', () => {
    const messages = window({ text: 'Done.' }, [
      { role: 'tool', toolCallId: 'c1', content: 'wrote workspace/notes.docx' }
    ]);
    expect(applyDormantRules(messages, new Set(['shell']))).toEqual([]);
  });
});

describe('what a turn has actually run', () => {
  it('does not count a call the harness answered itself', () => {
    expect(
      toolsRunThisTurn({
        a: { name: 'image_read', skipped: true },
        b: { name: 'file_write' }
      })
    ).toEqual(new Set(['file_write']));
  });
});

/*
 * The instrument, and the number this mechanism has to keep watching.
 *
 * A rule that fires on most turns has all the cost of a resident contract line and a matcher on
 * top. The corpus below is the ordinary shape of the work - reading, editing, searching, answering
 * - and the bar is that none of the seed rules touches any of it. It is a floor rather than a
 * measurement of production: what makes production countable is the marker in the appended message,
 * which is greppable over trajectories that already exist at no extra write.
 */
describe('firing rate over ordinary work', () => {
  const ordinary: { assistant: Parameters<typeof window>[0]; ran: string[] }[] = [
    { assistant: { toolCalls: [call('repo_overview', {})] }, ran: ['repo_overview'] },
    {
      assistant: { toolCalls: [call('code_search', { query: 'startTurnState' })] },
      ran: ['code_search']
    },
    {
      assistant: { toolCalls: [call('file_read', { path: 'src/agent.ts' })] },
      ran: ['file_read']
    },
    {
      assistant: { toolCalls: [call('file_patch', { path: 'src/agent.ts', oldText: 'a' })] },
      ran: ['file_patch']
    },
    {
      assistant: { toolCalls: [call('shell', { executable: 'pnpm', args: ['test'] })] },
      ran: ['shell']
    },
    {
      assistant: { toolCalls: [call('shell', { executable: 'git', args: ['diff', '--stat'] })] },
      ran: ['shell']
    },
    { assistant: { toolCalls: [call('web_search', { query: 'council minutes' })] }, ran: [] },
    {
      assistant: { toolCalls: [call('parallel_web_read', { urls: ['https://example.gov'] })] },
      ran: ['web_search']
    },
    {
      assistant: { text: 'The scheme was approved on 12 March: https://example.gov/minutes' },
      ran: ['web_search', 'parallel_web_read']
    },
    {
      assistant: { toolCalls: [call('document_search', { query: 'invoice' })] },
      ran: ['document_search']
    },
    {
      assistant: { toolCalls: [call('image_read', { path: 'workspace/page-1.png' })] },
      ran: ['image_read']
    },
    {
      assistant: { toolCalls: [call('browser_action', { action: 'wait_for', text: 'Signed in' })] },
      ran: ['browser_action']
    },
    {
      assistant: { text: 'Starting on the migration now.', toolCalls: [call('set_plan', {})] },
      ran: ['set_plan']
    },
    {
      assistant: { toolCalls: [call('set_acceptance', { checks: [] })] },
      ran: ['set_acceptance']
    },
    { assistant: { toolCalls: [call('finish', { summary: 'done' })] }, ran: ['shell'] },
    {
      assistant: { text: 'That is the whole of it - the three totals are unchanged.' },
      ran: ['file_read']
    },
    { assistant: { toolCalls: [call('process', { action: 'list' })] }, ran: ['process'] },
    {
      assistant: { toolCalls: [call('publish_preview', { port: 8080 })] },
      ran: ['publish_preview']
    },
    {
      assistant: { toolCalls: [call('memory', { action: 'write', text: 'prefers metric' })] },
      ran: ['memory']
    },
    {
      assistant: { toolCalls: [call('skill', { action: 'view', name: 'render-proof' })] },
      ran: ['skill']
    }
  ];

  it('fires on none of twenty ordinary steps', () => {
    let observations = 0;
    for (const step of ordinary) {
      observations += 1;
      expect(applyDormantRules(window(step.assistant), new Set(step.ran))).toEqual([]);
    }
    expect(observations).toBe(20);
    expect([...ruleFiringCounts().values()]).toEqual([]);
  });
});
