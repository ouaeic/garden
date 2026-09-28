import type { ModelTool } from '@garden/model-gateway';
import { z } from 'zod';

export const TOOL_GROUPS = {
  code: ['code_search', 'repo_overview', 'code_diagnostics', 'coding_agent', 'project_update'],
  documents: ['document_read', 'document_search', 'parallel_web_read'],
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
    'Enable built-in tool groups when needed; their full definitions appear on the next step and remain available in this conversation. code: repository search, language intelligence, coding specialists and project versions. documents: document reading/search and parallel web reads. browser: isolated tabs, forms, snapshots and PDF. desktop: applications and computer control. media: images, audio and generation. publishing: private previews and public sites. connections: configured mail, calendar, files and services. This changes tool visibility only, never permissions. Core file editing, shell, processes and web search are already available.',
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
  return {
    enabled: state.enabledToolGroups,
    instruction:
      'Use the newly available definitions on the next step. Unsupported computer surfaces and disconnected services remain unavailable.'
  };
}

export function rememberToolGroup(state: { enabledToolGroups?: string[] }, name: string) {
  const group = groups.find((group) => (TOOL_GROUPS[group] as readonly string[]).includes(name));
  if (group)
    state.enabledToolGroups = enabledToolGroups([...(state.enabledToolGroups ?? []), group]);
}
