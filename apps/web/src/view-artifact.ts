import type { Artifact } from '@garden/contracts';

/** The largest view rendered inline; anything bigger is a file to download, not a view. */
export const VIEW_MAX_BYTES = 2 * 1024 * 1024;

/** A published HTML file is a view: the model's own presentation of its result. */
export const isViewArtifact = (artifact: Pick<Artifact, 'mimeType' | 'name' | 'sizeBytes'>) =>
  (artifact.mimeType.split(';')[0] === 'text/html' || /\.html?$/i.test(artifact.name)) &&
  artifact.sizeBytes <= VIEW_MAX_BYTES;
