import type { CSSProperties } from 'react';

/**
 * The wordmark, and only the word. Its letters rise into place when the app opens, a breeze runs
 * through them now and then, and they ripple under the pointer; all of it transform-only and all
 * of it off when motion is reduced.
 */
export default function Brand() {
  return (
    <span className="brand">
      <span className="sr-only">garden</span>
      <span className="brand-word" aria-hidden="true">
        {[...'garden'].map((letter, index) => (
          <span key={index} className="brand-letter" style={{ '--letter': index } as CSSProperties}>
            {letter}
          </span>
        ))}
      </span>
    </span>
  );
}
