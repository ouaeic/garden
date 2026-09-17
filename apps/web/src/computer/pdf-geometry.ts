const PAGE_GAP = 8;

/** Prefix offsets keep document navigation independent of the number of mounted pages. */
export function pdfGeometry(
  sizes: readonly { width: number; height: number }[],
  width: number,
  zoom: number
) {
  const heights = sizes.map((size) => size.height * Math.max(0.1, width / size.width) * zoom);
  const offsets = [0];
  for (const height of heights) offsets.push(offsets.at(-1)! + height + PAGE_GAP);
  return {
    count: heights.length,
    heights,
    offsets,
    total: offsets.at(-1)!,
    pageAt(y: number): number {
      let first = 0,
        last = heights.length;
      while (first < last) {
        const middle = Math.floor((first + last) / 2);
        if (offsets[middle + 1]! <= y) first = middle + 1;
        else last = middle;
      }
      return Math.max(0, Math.min(heights.length - 1, first));
    }
  };
}
