import { useSyncExternalStore } from 'react';
import type { Artifact } from '@garden/contracts';

/**
 * The one file open over whatever the owner is looking at.
 *
 * A deliverable opens as itself wherever it is mentioned - Home, a goal, the Library - instead of
 * sending the owner to a file browser to find it again by name.
 */
export type Viewed = Pick<Artifact, 'id' | 'name' | 'mimeType' | 'sizeBytes'> &
  Partial<Pick<Artifact, 'taskId' | 'createdAt' | 'version'>>;

let open: Viewed | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());

export function openArtifact(artifact: Viewed): void {
  open = artifact;
  publish();
}
export function closeArtifact(): void {
  open = null;
  publish();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useViewed = (): Viewed | null => useSyncExternalStore(subscribe, () => open);
