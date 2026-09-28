import type { Artifact, TaskPresentation } from '@garden/contracts';

/** Registry metadata keeps inherited immutable results viewable after a project moves workspace. */
export function presentationArtifacts(
  presentation: TaskPresentation,
  known: readonly Artifact[]
): Artifact[] {
  const artifacts = new Map(
    known
      .filter((artifact) => artifact.taskId === presentation.taskId)
      .map((artifact) => [artifact.id, artifact])
  );
  for (const result of presentation.results) {
    if (
      result.kind !== 'artifact' ||
      !result.artifactId ||
      artifacts.has(result.artifactId) ||
      !result.workspaceId ||
      !result.sha256 ||
      !result.createdAt ||
      !result.mimeType ||
      result.sizeBytes === undefined ||
      result.version === undefined
    )
      continue;
    artifacts.set(result.artifactId, {
      id: result.artifactId,
      workspaceId: result.workspaceId,
      taskId: presentation.taskId,
      name: result.title,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      version: result.version,
      sha256: result.sha256,
      createdAt: result.createdAt
    });
  }
  return [...artifacts.values()];
}
