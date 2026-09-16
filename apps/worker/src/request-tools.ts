import type { WorkspaceSurfaces } from '@athanor/contracts';
import type { AnyConnectorKind } from '@athanor/core';
import { COMPACT_CONTEXT_TOOL } from './context.js';
import { agentToolsFor } from './tool-catalogue.js';

/** Core definitions keep their positions as advanced groups are appended. */
export function requestToolsFor(
  surfaces: WorkspaceSurfaces,
  connectorKinds: readonly AnyConnectorKind[],
  groups: readonly string[],
  withdrawn: ReadonlySet<string>
) {
  const core = agentToolsFor('lead', surfaces, connectorKinds, []);
  const coreNames = new Set(core.map((tool) => tool.name));
  return [
    ...core,
    COMPACT_CONTEXT_TOOL,
    ...agentToolsFor('lead', surfaces, connectorKinds, groups).filter(
      (tool) => !coreNames.has(tool.name)
    )
  ].filter((tool) => !withdrawn.has(tool.name));
}
