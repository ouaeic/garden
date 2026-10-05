import { useEffect, useRef } from 'react';

/**
 * Light through leaves, behind everything.
 *
 * Drawn at a seventh of the screen and scaled up, so the browser's own filtering does the
 * softening and a frame costs a few hundred pixels. It sleeps while the page is hidden, holds still
 * for anyone who asked for less motion, and reads its colours from the theme so night and day are
 * the same scene in different light.
 */
const BLOBS = Array.from({ length: 11 }, (_, i) => ({
  x: Math.random(),
  y: Math.random(),
  r: 0.28 + Math.random() * 0.34,
  sx: 0.00004 + Math.random() * 0.00007,
  sy: 0.00003 + Math.random() * 0.00006,
  p: Math.random() * 6.28,
  c: i % 4
}));
const CANOPY = Array.from({ length: 34 }, (_, i) => {
  const edge = i % 3;
  return {
    x: edge === 0 ? Math.random() : edge === 1 ? 0.82 + Math.random() * 0.22 : Math.random() * 0.2,
    y: edge === 0 ? -0.05 + Math.random() * 0.22 : Math.random() * 0.9,
    s: 0.05 + Math.random() * 0.07,
    r: Math.random() * 6.28,
    p: Math.random() * 6.28
  };
});

/** A theme colour with an alpha. The build writes `#ffffff` as `#fff`, so both lengths are read. */
export const rgba = (hex: string, alpha: number) => {
  const digits = hex.replace('#', '');
  const full = digits.length < 6 ? [...digits.slice(0, 3)].map((d) => d + d).join('') : digits;
  const n = parseInt(full.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

export default function Light() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    let palette = {
      bg: '#07120e',
      canopy: 'rgba(2,8,5,.42)',
      light: false,
      colors: [] as string[]
    };
    const readPalette = () => {
      const style = getComputedStyle(document.documentElement);
      const token = (name: string) => style.getPropertyValue(name).trim();
      palette = {
        bg: token('--bg'),
        canopy: token('--canopy'),
        light: style.colorScheme === 'light',
        colors: ['--light-a', '--light-b', '--light-c', '--light-d'].map(token)
      };
    };
    const size = () => {
      element.width = Math.max(64, Math.round(innerWidth / 7));
      element.height = Math.max(64, Math.round(innerHeight / 7));
    };
    const draw = (t: number) => {
      const { width: w, height: h } = element;
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = palette.bg;
      context.fillRect(0, 0, w, h);
      // Night lifts the dark with coloured light; day is the same garden with the sun behind it,
      // so its light brightens what is there rather than tinting it.
      context.globalCompositeOperation = 'screen';
      for (const blob of BLOBS) {
        const x = (blob.x + 0.32 * Math.sin(t * blob.sx + blob.p)) * w;
        const y = (blob.y + 0.28 * Math.cos(t * blob.sy + blob.p * 1.3)) * h;
        const r = blob.r * Math.max(w, h);
        const gradient = context.createRadialGradient(x, y, 0, x, y, r);
        const color = palette.colors[blob.c] || '#1e6a49';
        gradient.addColorStop(0, rgba(color, palette.light ? 0.3 : 0.17));
        gradient.addColorStop(1, rgba(color, 0));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, y, r, 0, 6.283);
        context.fill();
      }
      context.globalCompositeOperation = palette.light ? 'soft-light' : 'screen';
      for (let i = 0; i < 3; i++) {
        const alpha = (palette.light ? 0.22 : 0.035) * (0.6 + 0.4 * Math.sin(t * 0.00012 + i * 2));
        const x0 = w * (0.08 + i * 0.2);
        const shaft = context.createLinearGradient(x0, 0, x0 + w * 0.5, h);
        shaft.addColorStop(0, `rgba(255,240,200,${alpha})`);
        shaft.addColorStop(1, 'rgba(255,240,200,0)');
        context.fillStyle = shaft;
        context.beginPath();
        context.moveTo(x0, 0);
        context.lineTo(x0 + w * 0.07, 0);
        context.lineTo(x0 + w * 0.55, h);
        context.lineTo(x0 + w * 0.38, h);
        context.closePath();
        context.fill();
      }
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = palette.canopy;
      const m = Math.max(w, h);
      for (const leaf of CANOPY) {
        const sway = 0.025 * Math.sin(t * 0.0004 + leaf.p);
        const len = leaf.s * m;
        context.save();
        context.translate((leaf.x + sway) * w, (leaf.y + sway * 0.6) * h);
        context.rotate(leaf.r + sway * 4);
        context.beginPath();
        context.moveTo(0, 0);
        context.bezierCurveTo(len * 0.3, -len * 0.32, len * 0.75, -len * 0.3, len, 0);
        context.bezierCurveTo(len * 0.75, len * 0.3, len * 0.3, len * 0.32, 0, 0);
        context.fill();
        context.restore();
      }
    };
    let frame = 0;
    let last = 0;
    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      draw(t);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      if (still.matches || document.visibilityState === 'hidden') draw(0);
      else frame = requestAnimationFrame(loop);
    };
    const restyle = () => {
      readPalette();
      draw(last);
    };
    readPalette();
    size();
    start();
    const themeWatch = new MutationObserver(restyle);
    themeWatch.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    const scheme = matchMedia('(prefers-color-scheme: light)');
    scheme.addEventListener('change', restyle);
    still.addEventListener('change', start);
    document.addEventListener('visibilitychange', start);
    addEventListener('resize', size);
    return () => {
      cancelAnimationFrame(frame);
      themeWatch.disconnect();
      scheme.removeEventListener('change', restyle);
      still.removeEventListener('change', start);
      document.removeEventListener('visibilitychange', start);
      removeEventListener('resize', size);
    };
  }, []);
  return <canvas ref={canvas} className="light" aria-hidden="true" />;
}
