export interface ArtifactReference {
  id: string;
  name: string;
}

/** Resolve only within the caller's authorized artifact collection; ambiguous names stay unresolved. */
export const resolveArtifactReference = <T extends ArtifactReference>(
  value: string,
  artifacts: readonly T[]
): T | null => {
  let reference = value.trim();
  if (reference.startsWith('artifact:')) {
    try {
      reference = decodeURIComponent(reference.slice('artifact:'.length));
    } catch {
      return null;
    }
  }
  const exactId = artifacts.find((artifact) => artifact.id === reference);
  if (exactId) return exactId;
  const decorated = /^(.*) \(([^()]+)\)$/.exec(reference);
  if (decorated) {
    const artifact = artifacts.find((artifact) => artifact.id === decorated[2]);
    if (artifact) return artifact.name === decorated[1] ? artifact : null;
  }
  const matches = artifacts.filter((artifact) => artifact.name === reference);
  return matches.length === 1 ? matches[0]! : null;
};
