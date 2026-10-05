import { useId } from 'react';
import { WORDMARK } from './wordmark-outline';

/** The mark, in the current text colour. The word is the whole of it; it is named for readers. */
export default function Wordmark({ className = '' }: { className?: string }) {
  const cut = `wordmark-cut-${useId().replace(/:/g, '')}`;
  return (
    <svg
      className={`wordmark ${className}`}
      viewBox={WORDMARK.viewBox}
      role="img"
      aria-label="garden"
      fill="currentColor"
    >
      <clipPath id={cut}>
        <path clipRule="evenodd" d={WORDMARK.cut} />
      </clipPath>
      <path d={WORDMARK.word} clipPath={`url(#${cut})`} />
      <path d={WORDMARK.tendril} />
    </svg>
  );
}
