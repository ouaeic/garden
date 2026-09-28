import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Sprite } from './Sprite';
import {
  bee,
  butterfly,
  firefly,
  flowerBloom,
  leaf,
  monkey,
  owl,
  petal,
  snail,
  snowflake,
  sparrow,
  type Frames
} from './sprites';
import { chirp } from './sound';
import { lifeMode, onLifeModeChange, type LifeMode } from './settings';
import './life.css';

interface Actor {
  id: number;
  frames: Frames;
  x: number;
  y: number;
  flip?: boolean;
  fps?: number;
  scale?: number;
  travel?: number;
  /** Timing for the current glide; creatures move smoothly, only their frames step. */
  ease?: string;
  /** A border this actor lives behind: it is clipped above this line, so it can slip out of sight. */
  clipTop?: number;
}
const GLIDE = 'cubic-bezier(0.45, 0, 0.55, 1)';

const wait = (ms: number, signal: { cancelled: boolean }) =>
  new Promise<void>((done, fail) =>
    setTimeout(() => (signal.cancelled ? fail(new Error('cancelled')) : done()), ms)
  );
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;
const between = (low: number, high: number) => low + Math.random() * (high - low);

function visible(element: Element | null) {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.bottom < 40 || box.top > innerHeight - 40) return null;
  return box;
}

function season(date = new Date()) {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
}
const isNight = (date = new Date()) => date.getHours() >= 20 || date.getHours() < 6;

/**
 * The creatures that live around the interface. They visit now and then, never while you are
 * typing or reading a dialog, and never where they could take a click: the whole layer ignores
 * the pointer. The garden blooms when a run finishes well.
 */
export default function GardenLife() {
  const [mode, setMode] = useState<LifeMode>(lifeMode);
  const [actors, setActors] = useState<Actor[]>([]);
  const nextId = useRef(1);
  const lastInput = useRef(0);
  const reduced = useRef(matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => onLifeModeChange(setMode), []);
  useEffect(() => {
    const touch = () => {
      lastInput.current = Date.now();
    };
    addEventListener('keydown', touch, true);
    addEventListener('pointerdown', touch, true);
    return () => {
      removeEventListener('keydown', touch, true);
      removeEventListener('pointerdown', touch, true);
    };
  }, []);

  useEffect(() => {
    if (mode === 'still' || reduced.current) return;
    const signal = { cancelled: false };
    const spawn = (actor: Omit<Actor, 'id'>) => {
      const id = nextId.current++;
      setActors((list) => [...list, { ...actor, id }]);
      return id;
    };
    const update = (id: number, patch: Partial<Actor>) =>
      setActors((list) => list.map((actor) => (actor.id === id ? { ...actor, ...patch } : actor)));
    const remove = (id: number) => setActors((list) => list.filter((actor) => actor.id !== id));
    const move = async (id: number, x: number, y: number, ms: number, ease = GLIDE) => {
      update(id, { x, y, travel: ms, ease });
      await wait(ms, signal);
      update(id, { travel: 0 });
    };
    const narrow = () => innerWidth < 700;
    const perches = () =>
      [...document.querySelectorAll('[data-perch]')]
        .map((element) => visible(element))
        .filter((box): box is DOMRect => Boolean(box && box.top > 90 && box.width > 160));

    const scenes: Record<string, () => Promise<void>> = {
      async logoVisit() {
        const brand = visible(document.querySelector('.garden-masthead .brand'));
        if (!brand) return;
        if (isNight()) {
          const id = spawn({
            frames: owl.perch,
            fps: 0.5,
            x: brand.left + brand.width * 0.55,
            y: brand.top - 12
          });
          await wait(between(9000, 16000), signal);
          remove(id);
          return;
        }
        const perchX = brand.left + brand.width * between(0.2, 0.6);
        const perchY = brand.top - 10;
        const id = spawn({ frames: sparrow.fly, fps: 8, x: -30, y: Math.max(0, perchY - 30) });
        await wait(60, signal);
        await move(id, perchX, perchY, 1400);
        update(id, { frames: sparrow.perch });
        chirp('tweet');
        await wait(900, signal);
        for (const pose of [
          sparrow.peck,
          sparrow.perch,
          sparrow.peck,
          sparrow.perch,
          sparrow.look
        ]) {
          update(id, { frames: pose });
          await wait(between(350, 900), signal);
        }
        await wait(1200, signal);
        update(id, { frames: sparrow.fly, fps: 8 });
        await move(id, innerWidth + 40, -30, 1800);
        remove(id);
      },
      async butterflyCard() {
        const box = pick(perches());
        if (!box) return;
        const id = spawn({
          frames: butterfly,
          fps: 8,
          x: box.left - 40,
          y: box.top - 60
        });
        await wait(60, signal);
        const hops = 3;
        for (let hop = 1; hop <= hops; hop++)
          await move(
            id,
            box.left + ((box.width - 40) * hop) / hops,
            box.top - 14 - (hop % 2) * 14,
            900
          );
        update(id, { frames: butterfly.slice(0, 3), fps: 1.5 });
        await wait(between(2500, 4500), signal);
        update(id, { frames: butterfly, fps: 8 });
        await move(id, box.right + 60, box.top - 140, 1600);
        remove(id);
      },
      async monkeyHang() {
        if (narrow()) return;
        const bar = document.querySelector('.garden-masthead')?.getBoundingClientRect();
        if (!bar) return;
        // It lives above the masthead's lower border: it drops out from behind it and climbs back.
        const x = between(innerWidth * 0.35, innerWidth * 0.62);
        const hidden = bar.bottom - 30;
        const id = spawn({ frames: monkey.hang, fps: 2, x, y: hidden, clipTop: bar.bottom });
        await wait(60, signal);
        await move(id, x, bar.bottom - 1, 520, 'cubic-bezier(0.2, 0.9, 0.3, 1.2)');
        await wait(2400, signal);
        update(id, { frames: monkey.wave, fps: 1 });
        chirp('ook');
        await wait(1400, signal);
        update(id, { frames: monkey.hang, fps: 2 });
        await wait(700, signal);
        await move(id, x, hidden, 460, 'cubic-bezier(0.5, 0, 0.8, 0.4)');
        remove(id);
      },
      async snailCrawl() {
        if (narrow()) return;
        const box = pick(perches());
        if (!box) return;
        const start = box.left + 12;
        const distance = Math.min(220, box.width - 60);
        const id = spawn({ frames: snail, fps: 1, x: start, y: box.top - 13 });
        await wait(60, signal);
        await move(id, start + distance, box.top - 13, distance * 120, 'linear');
        await wait(1500, signal);
        remove(id);
      },
      async seasonal() {
        const kind = season();
        if (kind === 'summer') {
          const y = between(90, innerHeight * 0.6);
          const id = spawn({ frames: bee, fps: 10, x: -20, y });
          await wait(60, signal);
          await move(id, innerWidth * 0.5, y - 40, 2600);
          await move(id, innerWidth + 20, y + 30, 2600);
          remove(id);
          return;
        }
        const frames = kind === 'autumn' ? leaf : kind === 'spring' ? petal : snowflake;
        const count = kind === 'winter' ? 3 : 1;
        await Promise.all(
          Array.from({ length: count }, async (_, index) => {
            await wait(index * 900, signal);
            let x = between(24, innerWidth - 24);
            const id = spawn({ frames, fps: 2, x, y: 70 });
            await wait(60, signal);
            for (let y = 70; y < innerHeight + 20; y += 110) {
              x += pick([-28, 28, -16, 16]);
              await move(id, x, y + 110, 1100, 'ease-in-out');
            }
            remove(id);
          })
        );
      },
      async fireflies() {
        if (!isNight()) return;
        const ids = Array.from({ length: narrow() ? 3 : 6 }, () =>
          spawn({
            frames: firefly,
            fps: between(0.8, 1.6),
            x: between(20, innerWidth - 20),
            y: between(100, innerHeight - 40)
          })
        );
        for (let round = 0; round < 6; round++) {
          await wait(2200, signal);
          for (const id of ids)
            update(id, {
              x: between(20, innerWidth - 20),
              y: between(100, innerHeight - 40),
              travel: 2000,
              ease: GLIDE
            });
        }
        await wait(2000, signal);
        for (const id of ids) remove(id);
      }
    };
    const bloom = async () => {
      const brand = visible(document.querySelector('.garden-masthead .brand'));
      if (!brand) return;
      chirp('bloom');
      const flower = spawn({
        frames: flowerBloom,
        fps: 3,
        x: brand.right + 4,
        y: brand.bottom - 18
      });
      const flutters = [0, 1, 2].map((index) =>
        spawn({ frames: butterfly, fps: 8, x: brand.right, y: brand.top + index * 4 })
      );
      await wait(80, signal);
      await Promise.all(
        flutters.map((id, index) =>
          move(id, brand.right + between(120, 360), between(80, 260) + index * 30, 2400)
        )
      );
      for (const id of flutters) remove(id);
      await wait(1200, signal);
      update(flower, { frames: [flowerBloom[2]!] });
      await wait(6000, signal);
      remove(flower);
    };
    const onBloom = () => void bloom().catch(() => undefined);
    addEventListener('garden:bloom', onBloom);
    // A named scene on request, so a visit can be watched on purpose rather than waited for.
    const onScene = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (scenes[name]) void scenes[name]().catch(() => undefined);
    };
    addEventListener('garden:scene', onScene);

    const weights: [string, number][] = [
      ['logoVisit', 5],
      ['butterflyCard', 4],
      ['seasonal', 3],
      ['monkeyHang', 1],
      ['snailCrawl', 1],
      ['fireflies', isNight() ? 4 : 0]
    ];
    const choose = () => {
      const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = Math.random() * total;
      for (const [name, weight] of weights) if ((roll -= weight) < 0) return name;
      return 'logoVisit';
    };
    let timer: ReturnType<typeof setTimeout>;
    const quiet = () =>
      document.visibilityState !== 'visible' ||
      Date.now() - lastInput.current < 6000 ||
      Boolean(document.querySelector('dialog[open]'));
    const schedule = (first = false) => {
      const [low, high] = first
        ? [5000, 11000]
        : mode === 'lively'
          ? [22000, 48000]
          : [110000, 220000];
      timer = setTimeout(
        async () => {
          if (!quiet()) await scenes[choose()]!().catch(() => undefined);
          if (!signal.cancelled) schedule();
        },
        between(low, high)
      );
    };
    schedule(true);
    return () => {
      signal.cancelled = true;
      clearTimeout(timer);
      removeEventListener('garden:bloom', onBloom);
      removeEventListener('garden:scene', onScene);
      setActors([]);
    };
  }, [mode]);

  if (mode === 'still') return null;
  const draw = (actor: Actor) => (
    <div
      key={actor.id}
      className="life-actor"
      style={
        {
          transform: `translate3d(${actor.x}px, ${actor.y - (actor.clipTop ?? 0)}px, 0)`,
          '--life-travel': `${actor.travel ?? 0}ms`,
          '--life-ease': actor.ease ?? GLIDE
        } as CSSProperties
      }
    >
      <Sprite
        frames={actor.frames}
        fps={actor.fps ?? 4}
        scale={actor.scale ?? 2}
        flip={actor.flip ?? false}
      />
    </div>
  );
  const clips = [
    ...new Set(actors.flatMap((actor) => (actor.clipTop === undefined ? [] : [actor.clipTop])))
  ];
  return (
    <div className="life-layer" aria-hidden="true">
      {actors.filter((actor) => actor.clipTop === undefined).map(draw)}
      {clips.map((top) => (
        <div key={`clip-${top}`} className="life-clip" style={{ top }}>
          {actors.filter((actor) => actor.clipTop === top).map(draw)}
        </div>
      ))}
    </div>
  );
}
