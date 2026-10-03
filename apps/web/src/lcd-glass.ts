/*
 * The dot matrix, drawn as one tile at the display's own pixel size so every gap is exactly one
 * device pixel and nothing is resampled.
 *
 * Measured from a photograph of a running DMG: dots are fat squares and the gaps between them are
 * hairlines, about a fifth of the pitch; and a dot is 0.29 mm seen from about 30 cm. At a desk,
 * the same apparent size is about two CSS pixels, so that is the pitch, with a one-device-pixel
 * gap: a quarter of the pitch on a laptop's display, a sixth on a phone's. A display with one
 * device pixel to a CSS pixel gets three-pixel dots, so its gap is still the narrower part.
 *
 * As on the panel, the matrix shows everywhere. An undriven dot is a shade darker than the
 * reflector between dots, so blank glass is finely gridded, and the gaps stay pale over ink. Their
 * strength is set so they lighten ink by about the same amount at any density, which keeps text
 * contrast where the palettes put it.
 */

/** Lightening of ink averaged over a dot, whatever the density. */
const GAP_WEIGHT = 0.17;
/** How much darker an undriven dot is than the reflector around it. */
const DOT_ALPHA = 0.08;
/** How much brighter the reflector shows between dots than through them. */
const REFLECTOR = 0.16;
/** The pitch, in CSS pixels. */
const PITCH = 2;

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
  // Never a dot narrower than three device pixels, so a gap is never more than a third of it.
  const pitch = Math.max(3, Math.round(PITCH * ratio));
  const share = (2 * pitch - 1) / pitch ** 2;
  // An inverted screen shows the matrix more than its ink can spare.
  const strength = Math.min(0.7, (GAP_WEIGHT * (lit ? 1 : 0.65)) / share);
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
      const covered = x === 0 || y === 0 ? 1 : 0;
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
