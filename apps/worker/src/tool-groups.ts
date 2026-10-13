import type { ModelTool } from '@garden/model-gateway';
import { z } from 'zod';

export const TOOL_GROUPS = {
  planning: ['set_plan', 'set_acceptance', 'propose_deal'],
  code: ['code_search', 'repo_overview', 'code_diagnostics', 'coding_agent', 'project_update'],
  documents: ['document_read', 'document_search', 'parallel_web_read', 'delegate'],
  memory: ['memory_recall', 'session_search', 'memory', 'skill'],
  automation: ['notify', 'schedule'],
  browser: ['browser_snapshot', 'read_elements', 'browser_action', 'print_pdf'],
  desktop: ['desktop_observe', 'desktop_launch', 'desktop_action'],
  media: ['image_read', 'audio_read', 'generate_media'],
  publishing: ['publish_preview'],
  connections: ['connector_list', 'connector_action']
} as const;
export type ToolGroup = keyof typeof TOOL_GROUPS;
const groups = Object.keys(TOOL_GROUPS) as ToolGroup[];
const Selection = z
  .object({
    groups: z
      .array(z.enum(groups as [ToolGroup, ...ToolGroup[]]))
      .min(1)
      .max(groups.length)
  })
  .strict();

export const LOAD_TOOLS: ModelTool = {
  name: 'load_tools',
  description:
    'Load more tools. planning: a plan the user sees, checks that run when you answer, agreeing a long job up front. code: code search, diagnostics, coding agents, project versions. documents: documents, many web pages, research agents. memory: past work, memory, skills. automation: notify, schedule. browser. desktop. media: images, audio, generation. publishing: app previews. connections: mail, calendar, services.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['groups'],
    properties: {
      groups: {
        type: 'array',
        minItems: 1,
        maxItems: groups.length,
        uniqueItems: true,
        items: { type: 'string', enum: groups }
      }
    }
  }
};

export function enabledToolGroups(value: readonly string[] = []): ToolGroup[] {
  return [...new Set(value.filter((name): name is ToolGroup => Object.hasOwn(TOOL_GROUPS, name)))];
}

export function enableToolGroups(state: { enabledToolGroups?: string[] }, input: unknown) {
  const requested = Selection.parse(input).groups;
  state.enabledToolGroups = enabledToolGroups([...(state.enabledToolGroups ?? []), ...requested]);
  return { enabled: state.enabledToolGroups };
}

export function rememberToolGroup(state: { enabledToolGroups?: string[] }, name: string) {
  const group = groups.find((group) => (TOOL_GROUPS[group] as readonly string[]).includes(name));
  if (group)
    state.enabledToolGroups = enabledToolGroups([...(state.enabledToolGroups ?? []), group]);
}
