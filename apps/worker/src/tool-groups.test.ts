import { expect, it } from 'vitest';
import { UNKNOWN_SURFACES } from '@garden/contracts';
import { agentToolsFor } from './tool-catalogue.js';
import { enableToolGroups, rememberToolGroup, TOOL_GROUPS } from './tool-groups.js';
import { COMPACT_CONTEXT_TOOL } from './context.js';
import { approvalRequirement } from './approval-policy.js';
import { isMutatingToolCall } from './write-classification.js';
import { PLAN_MODE_PERMITTED } from './turn/dispatch.js';
import type { AgentState } from './agent-state.js';
import { requestToolsFor } from './request-tools.js';

it('partitions all advanced capabilities into discoverable groups without duplicates or omissions', () => {
  const core = agentToolsFor('lead', UNKNOWN_SURFACES, undefined, []);
  const full = agentToolsFor();
  const grouped = Object.values(TOOL_GROUPS).flat();
  expect(grouped.length).toBeGreaterThan(0);
  expect(new Set(grouped).size).toBe(grouped.length);
  expect([...core.map((tool) => tool.name), ...grouped].sort()).toEqual(
    full.map((tool) => tool.name).sort()
  );
  // The resident core, sent on every request: 11,264 bytes measured, 1,385 of them `propose_deal`
  // and 174 the default an unanswered `ask` falls back to.
  expect(Buffer.byteLength(JSON.stringify([...core, COMPACT_CONTEXT_TOOL]))).toBeLessThan(11_350);
});

it('adds chosen groups in activation order while preserving the entire existing prefix', () => {
  const state = {} as { enabledToolGroups?: string[] };
  const catalogue = () =>
    requestToolsFor(UNKNOWN_SURFACES, [], state.enabledToolGroups ?? [], new Set());
  const core = catalogue();
  enableToolGroups(state, { groups: ['browser'] });
  const browser = catalogue();
  expect(browser.slice(0, core.length)).toEqual(core);
  expect(browser.map((tool) => tool.name)).toContain('browser_action');
  expect(browser.map((tool) => tool.name)).not.toContain('code_diagnostics');
  enableToolGroups(state, { groups: ['code', 'browser'] });
  const code = catalogue();
  expect(code.slice(0, browser.length)).toEqual(browser);
  expect(code.map((tool) => tool.name)).toContain('code_diagnostics');
  const resumed = JSON.parse(JSON.stringify(state)) as { enabledToolGroups: string[] };
  expect(requestToolsFor(UNKNOWN_SURFACES, [], resumed.enabledToolGroups, new Set())).toEqual(code);
  expect(() => enableToolGroups(state, { groups: ['desktop', 'arbitrary_plugin'] })).toThrow();
  expect(catalogue()).toEqual(code);
});

it('continues to filter unavailable hardware and only describes configured connection actions', () => {
  const tools = agentToolsFor(
    'lead',
    { browser: 'absent', desktop: 'absent' },
    [],
    Object.keys(TOOL_GROUPS)
  );
  expect(tools.length).toBeGreaterThan(0);
  expect(tools.map((tool) => tool.name)).not.toEqual(
    expect.arrayContaining(['browser_action', 'desktop_action', 'connector_action'])
  );
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of ['browser_action', 'desktop_action', 'connector_action'])
    expect(names.has(name)).toBe(false);
  const connected = agentToolsFor('lead', UNKNOWN_SURFACES, ['imap'], ['connections']);
  const action = connected.find((tool) => tool.name === 'connector_action');
  expect(action).toBeDefined();
  expect(JSON.stringify(action)).toContain('mail');
  expect(JSON.stringify(action)).not.toContain('github.create_issue');
});

it('loads definitions without granting authority or changing files', () => {
  const state = { messages: [], step: 1, credits: 0 } as AgentState;
  enableToolGroups(state, { groups: ['browser', 'publishing'] });
  expect(isMutatingToolCall('load_tools')).toBe(false);
  expect(PLAN_MODE_PERMITTED.has('load_tools')).toBe(true);
  for (const mode of ['review', 'balanced', 'autonomous'] as const)
    expect(approvalRequirement('load_tools', { groups: ['publishing'] }, mode)).toBeNull();
  expect(state).not.toHaveProperty('approvalGrants');
});

it('remembers a valid known tool use without affecting the read-only specialist catalogue', () => {
  const state = {} as { enabledToolGroups?: string[] };
  rememberToolGroup(state, 'code_search');
  expect(state.enabledToolGroups).toEqual(['code']);
  rememberToolGroup(state, 'made_up_tool');
  expect(state.enabledToolGroups).toEqual(['code']);
  expect(agentToolsFor('specialist', UNKNOWN_SURFACES, undefined, [])).toEqual(
    agentToolsFor('specialist')
  );
  expect(agentToolsFor('specialist').map((tool) => tool.name)).not.toContain('load_tools');
});
