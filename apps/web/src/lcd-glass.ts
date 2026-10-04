/*
 * The panel: its dot matrix, and the shadow its driven crystal casts on the reflector behind it.
 *
 * One physical model serves both themes. The panel has two colours that matter: the reflector,
 * which is the palette's lightest shade, and fully driven crystal, its darkest. Light mode shows
 * mostly reflector and dark mode mostly driven crystal; nothing below knows which.
 *
 * The matrix is one tile at the display's own pixel size, so every gap is exactly one device pixel
 * and nothing is resampled. Measured from a photograph of a running DMG, dots are fat squares and
 * the gaps between them are hairlines; and a dot is 0.29 mm seen from about 30 cm, which at a desk
 * is about two CSS pixels. Between dots the reflector shows, slightly brighter than an undriven
 * dot, so blank glass is faintly gridded and driven areas carry a pale lattice.
 *
 * The shadow is the screen's own darkness, moved down and to the right, softened, and multiplied
 * back over the screen. Wherever something driven sits beside something that is not, the shadow
 * falls on the undriven side: around ink on light glass, and inside lit strokes and pictures on a
 * dark field. Everything on the screen casts it the same way - text, lines, icons, sprites - so no
 * element needs a rule of its own. It is one SVG filter, which the compositor runs.
 */

/** Lightening of driven crystal averaged over a dot, whatever the density. */
const GAP_WEIGHT = 0.045;
/** How much darker an undriven dot is than the reflector around it. */
const DOT_ALPHA = 0.025;
/** How much brighter the reflector shows between dots than through them. */
const REFLECTOR = 0.04;
/** The pitch, in CSS pixels. */
const PITCH = 2;
/**
 * How far the shadow falls, and how soft it is, in CSS pixels: half a dot down and right, and
 * softened by about half of one, as in a photograph of the panel.
 */
const SHADOW_FALL = 1;
const SHADOW_SOFTNESS = 0.9;
/** How dark the shadow of fully driven crystal is on the reflector. */
const SHADOW_DEPTH = 0.35;

type Rgb = [number, number, number];

const channels = (colour: string): Rgb => {
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.fillStyle = colour;
  const hex = probe.fillStyle;
  if (hex.startsWith('#')) return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb;
  const [r = 0, g = 0, b = 0] = hex.match(/[\d.]+/g)?.map(Number) ?? [];
  return [r, g, b];
};
const luma = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** The matrix tile for a display, as a data URL and its size in CSS pixels. */
export function glassTile(
  ratio: number,
  reflector: string,
  driven: string
): { url: string; size: number } {
  // Never a dot narrower than three device pixels, so a gap is never more than a third of it.
  const pitch = Math.max(3, Math.round(PITCH * ratio));
  const share = (2 * pitch - 1) / pitch ** 2;
  const strength = Math.min(0.5, GAP_WEIGHT / share);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = pitch;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(pitch, pitch);
  const gap = channels(reflector).map((value) =>
    Math.round(value + (255 - value) * REFLECTOR)
  ) as Rgb;
  const dot = channels(driven);
  for (let y = 0; y < pitch; y++)
    for (let x = 0; x < pitch; x++) {
      const at = (y * pitch + x) * 4;
      const between = x === 0 || y === 0;
      const [r, g, b] = between ? gap : dot;
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = Math.round(255 * (between ? strength : DOT_ALPHA));
    }
  context.putImageData(image, 0, 0);
  return { url: canvas.toDataURL('image/png'), size: pitch / ratio };
}

const SVG = 'http://www.w3.org/2000/svg';
/** The shadow filter, made once and retuned whenever the palette changes. */
function shadowFilter(): SVGFilterElement {
  const existing = document.getElementById('lcd-shadow');
  if (existing instanceof SVGFilterElement) return existing;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  // The shadow is the screen's driven parts moved and softened, landing only where the reflector
  // shows: crystal that is itself driven sits above its own shadow.
  svg.innerHTML = `<filter id="lcd-shadow" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
<feColorMatrix in="SourceGraphic" type="matrix" data-role="driven" result="driven"/>
<feColorMatrix in="SourceGraphic" type="matrix" data-role="lit" result="lit"/>
<feOffset in="driven" dx="${SHADOW_FALL}" dy="${SHADOW_FALL}"/>
<feGaussianBlur stdDeviation="${SHADOW_SOFTNESS}"/>
<feComposite in2="lit" operator="arithmetic" k1="1" result="landing"/>
<feFlood flood-opacity="${SHADOW_DEPTH}"/>
<feComposite in2="landing" operator="in" result="shadow"/>
<feBlend in="shadow" in2="SourceGraphic" mode="multiply"/>
</filter>`;
  document.body.append(svg);
  return svg.querySelector('filter')!;
}

/**
 * How driven each point of the screen is, from its brightness - none at the reflector's, fully at
 * driven crystal's - as the alpha of an otherwise empty image; or, inverted, how lit it is.
 */
const drivenMatrix = (reflector: Rgb, driven: Rgb, inverted = false): string => {
  const light = luma(reflector);
  const dark = luma(driven);
  const span = Math.max(0.05, light - dark);
  const sign = inverted ? 1 : -1;
  const weight = [0.2126, 0.7152, 0.0722].map((w) => ((sign * w) / span).toFixed(4));
  const offset = inverted ? -dark / span : light / span;
  return `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${weight.join(' ')} 0 ${offset.toFixed(4)}`;
};

/** Paints the matrix and tunes the shadow for the current display and palette. */
export function paintGlass(): void {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const reflector = style.getPropertyValue('--s0').trim();
  const driven = style.getPropertyValue('--s3').trim();
  const { url, size } = glassTile(window.devicePixelRatio || 1, reflector, driven);
  root.style.setProperty('--lcd-grid', `url(${url}) 0 0 / ${size}px ${size}px`);
  const filter = shadowFilter();
  const [light, dark] = [channels(reflector), channels(driven)];
  filter.querySelector('[data-role="driven"]')!.setAttribute('values', drivenMatrix(light, dark));
  filter
    .querySelector('[data-role="lit"]')!
    .setAttribute('values', drivenMatrix(light, dark, true));
  filter.querySelector('feFlood')!.setAttribute('flood-color', driven);
}

/**
 * Paints now, and again whenever the display's pixel density or the screen's theme or palette
 * changes, however it changes.
 */
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
  const looks = new MutationObserver(paintGlass);
  looks.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-palette']
  });
  paintGlass();
  listen();
  return () => {
    looks.disconnect();
    query?.removeEventListener('change', repaint);
  };
}
