/*
 * The dot matrix, drawn as one tile at the display's own pixel size so every gap is exactly one
 * device pixel and nothing is resampled.
 *
 * A dot is one CSS pixel wherever the display has two or more device pixels to give it, which is
 * the size the screen's pixel face is drawn at, so each pixel of a letter sits in a dot of its own.
 * Coarser displays get a coarser matrix rather than none. As on the panel, the matrix shows
 * everywhere: an undriven dot is a shade darker than the reflector between dots, so blank glass
 * is finely gridded, and on ink the gaps stay pale, so a letter reads as separate dots. The gaps'
 * strength is set so they lighten ink by about the same amount at any pitch, which keeps text
 * contrast where the palettes put it.
 */

/** Lightening of ink averaged over a dot, whatever the pitch. */
const GAP_WEIGHT = 0.21;
/** How much darker an undriven dot is than the reflector around it. */
const DOT_ALPHA = 0.09;
/** How much brighter the reflector shows between dots than through them. */
const REFLECTOR = 0.16;

const channels = (colour: string): [number, number, number] => {
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.fillStyle = colour;
  const hex = probe.fillStyle;
  if (hex.startsWith('#'))
    return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  const [r = 0, g = 0, b = 0] = hex.match(/[\d.]+/g)?.map(Number) ?? [];
  return [r, g, b];
};

/** The tile for a display, as a data URL and its size in CSS pixels. */
export function glassTile(
  ratio: number,
  background: string,
  ink: string,
  lit = true
): { url: string; size: number } {
  const pitch = ratio >= 1.75 ? Math.round(ratio) : 3;
  // The panel's gaps are hairlines, a fifth of a dot or so. Where a dot is only two device
  // pixels, a hairline is half of one, drawn as half its strength, as a scaled-down photo shows it.
  const width = pitch === 2 ? 0.5 : 1;
  const share = (2 * width) / pitch - (width / pitch) ** 2;
  // An inverted screen and a coarse display each show the matrix more than ink can spare.
  const weight = GAP_WEIGHT * (lit ? 1 : 0.65) * (ratio >= 1.75 ? 1 : 0.6);
  const strength = Math.min(0.6, weight / share);
  const undriven = DOT_ALPHA * (lit ? 1 : 0.4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = pitch;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(pitch, pitch);
  // A lit screen's reflector is the bright layer; an inverted one shows dark between its dots.
  const gap = channels(background).map((value) =>
    lit ? Math.round(value + (255 - value) * REFLECTOR) : value
  ) as [number, number, number];
  const dot = channels(ink);
  for (let y = 0; y < pitch; y++)
    for (let x = 0; x < pitch; x++) {
      const at = (y * pitch + x) * 4;
      const across = x === 0 ? width : 0;
      const down = y === 0 ? width : 0;
      const covered = across + down - across * down;
      const [r, g, b] = covered ? gap : dot;
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = Math.round(255 * (covered ? covered * strength : undriven));
    }
  context.putImageData(image, 0, 0);
  return { url: canvas.toDataURL('image/png'), size: pitch / ratio };
}

/** Paints the matrix for the current display and colours; call again when either changes. */
export function paintGlass(): void {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const { url, size } = glassTile(
    window.devicePixelRatio || 1,
    style.getPropertyValue('--bg').trim(),
    style.getPropertyValue('--text').trim(),
    root.dataset.theme !== 'dark'
  );
  root.style.setProperty('--lcd-grid', `url(${url}) 0 0 / ${size}px ${size}px`);
}

/** Repaints when the window moves to a display with a different pixel density. */
export function watchGlass(): () => void {
  let query: MediaQueryList | null = null;
  const listen = () => {
    query?.removeEventListener('change', repaint);
    query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener('change', repaint);
  };
  const repaint = () => {
    paintGlass();
    listen();
  };
  paintGlass();
  listen();
  return () => query?.removeEventListener('change', repaint);
}
