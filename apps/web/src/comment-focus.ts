/*
 * Which numbered comment the owner is looking at. The composer's list and the pins it numbers live
 * in different parts of the page, so they meet here rather than through props.
 */
const FOCUS = 'garden-comment-focus';

/** Lights a comment's pin; `reveal` also brings it on screen. Zero lights none. */
export const focusComment = (n: number, reveal = false): void => {
  window.dispatchEvent(new CustomEvent(FOCUS, { detail: { n, reveal } }));
};

export const onCommentFocus = (listener: (n: number, reveal: boolean) => void): (() => void) => {
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<{ n: number; reveal: boolean }>).detail;
    listener(detail.n, detail.reveal);
  };
  window.addEventListener(FOCUS, receive);
  return () => window.removeEventListener(FOCUS, receive);
};
