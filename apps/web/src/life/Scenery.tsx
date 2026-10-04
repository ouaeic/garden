import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { lifeMode, onLifeModeChange } from './settings';
import { compose, toneNearer, pixels, type Layer, type Scene } from './garden-scene';
import './scenery.css';

/** One garden dot is one dot of the screen's matrix. */
const DOT = 2;
/** Seconds a cloud takes to drift one dot. */
const CLOUD_PACE = 1.6;

/** The garden's four shades as RGBA, read from the theme. */
function readShades(): [number, number, number, number][] {
  const style = getComputedStyle(document.documentElement);
  const probe = document.createElement('canvas');
  probe.width = 4;
  probe.height = 1;
  const context = probe.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  // At night the leaves stay deep, a shade above the screen, and only their highlights catch light.
  const night = document.documentElement.dataset.theme === 'dark';
  (night
    ? ['--bg', '--muted', '--tint', '--tint']
    : ['--bg', '--tint', '--muted', '--text']
  ).forEach((name, i) => {
    context.fillStyle = style.getPropertyValue(name).trim() || '#000';
    context.fillRect(i, 0, 1, 1);
  });
  const data = context.getImageData(0, 0, 4, 1).data;
  return [0, 1, 2, 3].map((i) => [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!, 255]);
}

function draw(
  canvas: HTMLCanvasElement | null,
  layer: Layer,
  shades: [number, number, number, number][]
) {
  if (!canvas) return;
  canvas.width = layer.w;
  canvas.height = layer.h;
  canvas.style.width = `${layer.w * DOT}px`;
  canvas.style.height = `${layer.h * DOT}px`;
  const context = canvas.getContext('2d');
  if (!context || shades.length < 4) return;
  context.putImageData(new ImageData(pixels(layer, shades), layer.w, layer.h), 0, 0);
}

/*
 * The garden behind the interface: a clearing seen from under the trees, painted at one canvas
 * pixel per dot and scaled up whole. It is grown again only when the window's size changes, and
 * recoloured when the theme or palette does. Cards are frames and what they hold is drawn on the
 * screen's own background, so the garden shows only where nothing is in use. A card that holds
 * other cards lets the garden through instead, a tone nearer the background.
 *
 * What moves is stepped by CSS, a dot at a time: the near leaves and grass shift between two
 * poses in gusts, clouds drift, and now and then a leaf comes down. With motion reduced, or the
 * garden kept still, it all stands.
 */
export default function Scenery() {
  const back = useRef<HTMLCanvasElement>(null);
  const nearA = useRef<HTMLCanvasElement>(null);
  const nearB = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [mode, setMode] = useState(lifeMode);
  const drifters = useRef<(HTMLCanvasElement | null)[]>([]);
  useEffect(() => onLifeModeChange(setMode), []);

  useEffect(() => {
    let timer = 0;
    let last = '';
    const grow = () => {
      const width = Math.ceil(innerWidth / DOT);
      const height = Math.ceil(document.documentElement.clientHeight / DOT);
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      setScene(compose(width, height));
    };
    grow();
    const resized = () => {
      clearTimeout(timer);
      timer = window.setTimeout(grow, 200);
    };
    addEventListener('resize', resized);
    return () => {
      clearTimeout(timer);
      removeEventListener('resize', resized);
    };
  }, []);

  useEffect(() => {
    if (!scene) return;
    let image = '';
    const root = document.documentElement;
    const paint = () => {
      const shades = readShades();
      const down = document.createElement('canvas');
      down.width = scene.back.w;
      down.height = scene.back.h;
      down
        .getContext('2d')
        ?.putImageData(
          new ImageData(
            toneNearer(scene, shades, root.dataset.theme === 'dark'),
            down.width,
            down.height
          ),
          0,
          0
        );
      down.toBlob((blob) => {
        if (!blob) return;
        if (image) URL.revokeObjectURL(image);
        image = URL.createObjectURL(blob);
        root.style.setProperty('--scenery-nearer', `url(${image})`);
        root.style.setProperty('--scenery-size', `${down.width * DOT}px ${down.height * DOT}px`);
      });
      draw(back.current, scene.back, shades);
      draw(nearA.current, scene.near[0], shades);
      draw(nearB.current, scene.near[1], shades);
      scene.drifters.forEach((drifter, i) =>
        draw(drifters.current[i] ?? null, drifter.sprite, shades)
      );
    };
    paint();
    const looks = new MutationObserver(paint);
    looks.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette']
    });
    return () => {
      looks.disconnect();
      if (image) URL.revokeObjectURL(image);
      root.style.removeProperty('--scenery-nearer');
    };
  }, [scene]);

  const width = scene?.back.w ?? 0;
  return (
    <div className="scenery" data-still={mode === 'still' || undefined} aria-hidden="true">
      <canvas ref={back} className="scenery-layer" />
      {scene?.drifters.map((drifter, i) => {
        const travel = width + drifter.sprite.w;
        const style =
          drifter.kind === 'cloud'
            ? ({
                left: `${-drifter.sprite.w * DOT}px`,
                top: `${drifter.y * DOT}px`,
                '--travel': `${travel * DOT}px`,
                '--steps': travel,
                animationDuration: `${travel * CLOUD_PACE}s`,
                animationDelay: `${-(drifter.x + drifter.sprite.w) * CLOUD_PACE}s`
              } as CSSProperties)
            : ({
                left: `${drifter.x * DOT}px`,
                '--fall': `${(scene.back.h + 8) * DOT}px`,
                animationDelay: `${-i * 13}s`
              } as CSSProperties);
        return (
          <canvas
            key={`${drifter.kind}-${i}`}
            ref={(element) => {
              drifters.current[i] = element;
            }}
            className={`scenery-${drifter.kind}`}
            style={style}
          />
        );
      })}
      <canvas ref={nearA} className="scenery-layer scenery-near is-rest" />
      <canvas ref={nearB} className="scenery-layer scenery-near is-gust" />
    </div>
  );
}
