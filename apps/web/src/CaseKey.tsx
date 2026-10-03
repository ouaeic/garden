import type { ButtonHTMLAttributes, Ref } from 'react';

/** What a key's lamp says: dark, lit, flickering with work, blinking while it starts, or a fault. */
export type Lamp = 'off' | 'on' | 'busy' | 'starting' | 'fault';

/**
 * A key on the case, outside the screen: a rubber key with its name printed beneath it, as a
 * handheld's own keys are. The case has no pixels, so a key has no icon. A lamp beside the name
 * shows the state of what the key opens, so it is worth looking at before pressing.
 */
export function CaseKey({
  label,
  hint,
  lamp,
  count,
  ref,
  className = '',
  ...button
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  hint?: string;
  lamp?: Lamp | undefined;
  count?: number;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={ref} type="button" className={`case-key ${className}`} {...button}>
      <span className="case-key-cap" aria-hidden="true" />
      <span className="case-key-label">
        {lamp && <i className="case-lamp" data-lamp={lamp} aria-hidden="true" />}
        {label}
        {count ? <b className="case-key-count">{count}</b> : null}
        {hint && <small className="case-key-hint">{hint}</small>}
      </span>
    </button>
  );
}
