import { describe, expect, it } from 'vitest';
import { resolveArtifactReference } from './artifact-reference.js';

describe('scoped artifact references', () => {
  const artifact = { id: 'id-one', name: 'Report with spaces.pdf' };
  it('resolves names, exact IDs and encoded artifact links to the same immutable file', () => {
    for (const reference of [
      'id-one',
      'Report with spaces.pdf',
      'artifact:id-one',
      'artifact:Report%20with%20spaces.pdf',
      'artifact:Report with spaces.pdf (id-one)'
    ]) {
      expect(resolveArtifactReference(reference, [artifact])).toBe(artifact);
    }
  });
  it('does not guess across same-name artifacts or accept a mismatched ID and name', () => {
    expect(
      resolveArtifactReference('artifact:Report with spaces.pdf', [
        artifact,
        { ...artifact, id: 'id-two' }
      ])
    ).toBeNull();
    expect(resolveArtifactReference('artifact:Other.pdf (id-one)', [artifact])).toBeNull();
    expect(resolveArtifactReference('artifact:id-two', [artifact])).toBeNull();
    expect(resolveArtifactReference('artifact:%zz', [artifact])).toBeNull();
    expect(resolveArtifactReference('https://external.test/Report.pdf', [artifact])).toBeNull();
  });
});
