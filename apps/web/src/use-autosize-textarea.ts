import { useLayoutEffect, useRef } from 'react';

function fit(input: HTMLTextAreaElement) {
  input.style.height = '0px';
  input.style.height = `${input.scrollHeight}px`;
  input.style.overflowY = input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
}

export function useAutosizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [value]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let width = input.clientWidth;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        fit(input);
      });
    });
    observer.observe(input);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);
  return ref;
}
