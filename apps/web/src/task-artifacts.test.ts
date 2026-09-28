import { expect, it } from 'vitest';
import type { TaskPresentation } from '@garden/contracts';
import { presentationArtifacts } from './task-artifacts';

it('supplies complete immutable metadata for a source-workspace artifact absent from the new workspace list', () => {
  const presentation: TaskPresentation = {
    version: 1,
    taskId: 'task',
    eventCursor: 3,
    results: [
      {
        id: 'artifact:a',
        kind: 'artifact',
        title: 'Research.pdf',
        status: 'ready',
        url: '/v1/artifacts/a/content',
        downloadUrl: '/v1/artifacts/a/content',
        accessPath: null,
        artifactId: 'a',
        workspaceId: 'source-workspace',
        mimeType: 'application/pdf',
        sizeBytes: 456,
        version: 1,
        sha256: 'a'.repeat(64),
        createdAt: new Date(0).toISOString(),
        evidenceEventIds: ['published']
      }
    ],
    progress: {
      kind: 'research',
      phases: [],
      history: [],
      current: null,
      metrics: [],
      milestones: [],
      updatedAt: null
    }
  };
  const artifacts = presentationArtifacts(presentation, []);
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]).toMatchObject({
    id: 'a',
    workspaceId: 'source-workspace',
    taskId: 'task',
    mimeType: 'application/pdf',
    name: 'Research.pdf'
  });
  expect(presentationArtifacts(presentation, artifacts)).toHaveLength(1);
  const incomplete = { ...presentation.results[0]! };
  delete incomplete.workspaceId;
  expect(presentationArtifacts({ ...presentation, results: [incomplete] }, [])).toEqual([]);
});
