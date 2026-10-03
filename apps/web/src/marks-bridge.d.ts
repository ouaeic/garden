import type { ResultAnchor } from '@garden/contracts';

export function labelOf(element: Element | null): string;
export function contextOf(element: Element, root: Element): string;
export function pathOf(element: Element, root: Element): string;
export function anchorAt(root: Element, clientX: number, clientY: number): ResultAnchor | null;
export function anchorForRange(
  root: Element,
  range: Range
): Extract<ResultAnchor, { kind: 'text' }> | null;
export function rangeFor(
  root: Element,
  anchor: Extract<ResultAnchor, { kind: 'text' }>
): Range | null;
export function forget(): void;
export function placeOf(
  root: Element,
  anchor: ResultAnchor | undefined
): { x: number; y: number; node: Element; range?: Range } | null;
export function shown(node: Element, root: Element, x: number, y: number): boolean;
