import { markSprout } from './life/growth';
import { Sprite } from './life/Sprite';

/** The wordmark, with a sprout that grows out of it once each time the app opens. */
export default function Brand() {
  return (
    <span className="brand">
      <span>garden</span>
      <Sprite frames={markSprout} scale={2} fps={4} once className="brand-sprout" />
    </span>
  );
}
