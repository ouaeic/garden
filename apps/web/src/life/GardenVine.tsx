import { Sprite } from './Sprite';
import { flowerBloom, vineLeft, vineRight } from './sprites';

/**
 * A vine that climbs the side of the prompt, one leaf for every project in bloom, and flowers
 * once three have finished. Decoration only; it keeps count of what you have grown.
 */
export default function GardenVine({ blooms }: { blooms: number }) {
  const leaves = Math.min(blooms, 9);
  if (!leaves) return null;
  return (
    <span className="garden-vine" aria-hidden="true">
      {blooms >= 3 && (
        <Sprite frames={[flowerBloom[2]!]} scale={3} className="garden-vine-flower" />
      )}
      {Array.from({ length: leaves }, (_, index) => (
        <Sprite key={index} frames={[index % 2 ? vineRight : vineLeft]} scale={3} />
      ))}
    </span>
  );
}
