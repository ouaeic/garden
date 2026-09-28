import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Sprite } from './Sprite';
import {
  bat,
  butterfly,
  flowerBloom,
  frog,
  ladybird,
  monkey,
  owl,
  snail,
  sparrow,
  type Frames
} from './sprites';
import { chirp } from './sound';
import { lifeMode, onLifeModeChange, type LifeMode } from './settings';
import './life.css';

/**
 * A border a creature is tucked behind. `below` shows it only under the line (the masthead's lower
 * edge, which it hangs from); `above` shows it only over the line (a card's top edge, which it peeks
 * over). Crossing back past the line is how it leaves.
 */
type Clip = { side: 'below' | 'above'; line: number };

interface Actor {
  id: number;
  kind: 'bird' | 'owl' | 'bat' | 'butterfly' | 'monkey' | 'frog' | 'ladybird' | 'snail' | 'flower';
  frames: Frames;
  x: number;
  y: number;
  flip?: boolean;
  fps?: number;
  clip?: Clip | undefined;
}

type Signal = { cancelled: boolean };
const wait = (ms: number, signal: Signal) =>
  new Promise<void>((done, fail) =>
    setTimeout(() => (signal.cancelled ? fail(new Error('cancelled')) : done()), ms)
  );
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
const between = (low: number, high: number) => low + Math.random() * (high - low);
const isNight = (date = new Date()) => date.getHours() >= 20 || date.getHours() < 6;
const clipKey = (clip?: Clip) => (clip ? `${clip.side}:${Math.round(clip.line)}` : 'free');

function visible(element: Element | null) {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.bottom < 40 || box.top > innerHeight - 40) return null;
  return box;
}

/** Card edges a creature can stand on: wide enough, fully on screen, below the masthead. */
function ledges() {
  const bar = document.querySelector('.garden-masthead')?.getBoundingClientRect().bottom ?? 56;
  return [...document.querySelectorAll('[data-perch], .desk-card, .desk-work-card')]
    .filter((element) => !element.closest('dialog'))
    .map((element) => visible(element))
    .filter((box): box is DOMRect =>
      Boolean(box && box.top > bar + 20 && box.width > 140 && box.right < innerWidth - 8)
    );
}

/**
 * The creatures that live around the interface. They visit now and then, never while you are
 * typing or reading a dialog, and never where they could take a click: the whole layer ignores
 * the pointer. They move on the compositor through the Web Animations API, so a leap is a smooth
 * arc at the display's own rate; only their sprite frames step. The garden blooms when a run
 * finishes well.
 */
export default function GardenLife() {
  const [mode, setMode] = useState<LifeMode>(lifeMode);
  const [actors, setActors] = useState<Actor[]>([]);
  const nodes = useRef(new Map<number, HTMLDivElement>());
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
    const world: Signal = { cancelled: false };
    const state = new Map<number, Actor>();
    /** How each creature gets away when the pointer comes near: its quickest exit from where it is. */
    const escapes = new Map<number, () => Promise<void>>();
    const lives = new Map<number, Signal>();
    const commit = () => setActors([...state.values()]);
    const spawn = (actor: Omit<Actor, 'id'>) => {
      const id = nextId.current++;
      state.set(id, { ...actor, id });
      lives.set(id, { cancelled: false });
      commit();
      return id;
    };
    const life = (id: number): Signal => ({
      get cancelled() {
        return world.cancelled || (lives.get(id)?.cancelled ?? true);
      }
    });
    const pose = (id: number, patch: Partial<Actor>) => {
      const actor = state.get(id);
      if (!actor) return;
      state.set(id, { ...actor, ...patch });
      commit();
    };
    const remove = (id: number) => {
      state.delete(id);
      escapes.delete(id);
      lives.delete(id);
      commit();
    };
    const offset = (actor: Actor) => (actor.clip?.side === 'below' ? actor.clip.line : 0);
    const settle = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
    /** Where a creature is right now, mid-flight included. */
    const where = (id: number) => {
      const actor = state.get(id);
      const node = nodes.current.get(id);
      if (!actor || !node) return null;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      return { x: matrix.m41, y: matrix.m42 + offset(actor) };
    };

    /**
     * Glide along a path of points, arcing upward by `arc` pixels at the midpoint or weaving
     * sideways by `sway`. The keyframes are computed once and the compositor interpolates them.
     */
    const travel = async (
      id: number,
      x: number,
      y: number,
      ms: number,
      { arc = 0, easing = 'cubic-bezier(0.45, 0, 0.55, 1)', sway = 0, force = false } = {}
    ) => {
      await settle();
      const actor = state.get(id);
      const node = nodes.current.get(id);
      if (!actor || !node || (!force && life(id).cancelled) || world.cancelled) return;
      const shift = offset(actor);
      const steps = arc || sway ? 16 : 1;
      const keyframes = Array.from({ length: steps + 1 }, (_, index) => {
        const t = index / steps;
        const px = actor.x + (x - actor.x) * t + sway * Math.sin(t * Math.PI * 3);
        const py = actor.y + (y - actor.y) * t - arc * 4 * t * (1 - t);
        return { transform: `translate3d(${px}px, ${py - shift}px, 0)` };
      });
      node.getAnimations().forEach((running) => running.cancel());
      const animation = node.animate(keyframes, {
        duration: ms,
        easing: arc ? 'linear' : easing,
        fill: 'forwards'
      });
      await animation.finished.catch(() => undefined);
      if (world.cancelled || !state.has(id)) return;
      if (!force && life(id).cancelled) return;
      state.set(id, { ...actor, x, y });
      node.style.transform = `translate3d(${x}px, ${y - shift}px, 0)`;
      animation.cancel();
    };
    /** Stop whatever a creature is doing and run its escape instead. */
    const spook = (id: number) => {
      const escape = escapes.get(id);
      const own = lives.get(id);
      if (!escape || !own || own.cancelled) return;
      own.cancelled = true;
      const here = where(id);
      const node = nodes.current.get(id);
      node?.getAnimations().forEach((running) => running.cancel());
      if (here) {
        const actor = state.get(id)!;
        state.set(id, { ...actor, x: here.x, y: here.y });
        if (node) node.style.transform = `translate3d(${here.x}px, ${here.y - offset(actor)}px, 0)`;
      }
      void escape()
        .catch(() => undefined)
        .finally(() => remove(id));
    };
    /** Away from the pointer, and off the nearest edge of the screen. */
    const flee = (id: number, pointer: { x: number; y: number }, frames: Frames, ms: number) => {
      escapes.set(id, async () => {
        const here = where(id);
        if (!here) return;
        pose(id, { frames, fps: 12, clip: undefined });
        const dx = here.x - pointer.x || 1;
        const dy = here.y - pointer.y || -1;
        const length = Math.hypot(dx, dy);
        const reach = Math.max(innerWidth, innerHeight);
        await travel(id, here.x + (dx / length) * reach, here.y + (dy / length) * reach - 80, ms, {
          easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
          force: true
        });
      });
    };
    const pointer = { x: -9999, y: -9999 };
    /** Down behind the line it stands on, the way it came. */
    const duck = (id: number, line: () => number, depth: number, ms: number) => {
      escapes.set(id, async () => {
        const here = where(id);
        if (!here) return;
        pose(id, { clip: { side: 'above', line: line() } });
        await travel(id, here.x, here.y + depth, ms, {
          easing: 'cubic-bezier(0.5, 0, 0.9, 0.5)',
          force: true
        });
      });
    };
    const narrow = () => innerWidth < 700;

    const scenes: Record<string, () => Promise<void>> = {
      async logoVisit() {
        const brand = visible(document.querySelector('.garden-masthead .brand'));
        if (!brand) return;
        const top = brand.top - 14;
        if (isNight()) {
          const id = spawn({
            kind: 'owl',
            frames: owl.perch,
            fps: 0.5,
            x: brand.left + brand.width * 0.55,
            y: top - 6
          });
          duck(id, () => brand.top + 4, 24, 360);
          await wait(between(9000, 16000), life(id));
          await travel(id, state.get(id)!.x, top + 30, 500, { easing: 'ease-in' });
          remove(id);
          return;
        }
        const perch = (share: number) => brand.left + brand.width * share;
        const id = spawn({ kind: 'bird', frames: sparrow.fly, fps: 8, x: -40, y: top - 40 });
        flee(id, pointer, sparrow.fly, 700);
        const own = life(id);
        await travel(id, perch(0.1), top, 1500, { arc: -30 });
        pose(id, { frames: sparrow.perch, fps: 4 });
        chirp('tweet');
        await wait(700, own);
        // Hops along the word, pecking at a letter or two.
        for (const share of [0.3, 0.5, 0.68]) {
          await travel(id, perch(share), top, 260, { arc: 10 });
          pose(id, { frames: sparrow.peck });
          await wait(between(300, 700), own);
          pose(id, { frames: sparrow.perch });
          await wait(between(300, 900), own);
        }
        pose(id, { frames: sparrow.look });
        await wait(900, own);
        pose(id, { frames: sparrow.fly, fps: 8 });
        await travel(id, innerWidth + 40, -60, 1900, { arc: 40 });
        remove(id);
      },
      async birdLedge() {
        const box = pick(ledges());
        if (!box) return;
        const top = box.top - 17;
        const fromLeft = Math.random() < 0.5;
        const id = spawn({
          kind: 'bird',
          frames: sparrow.fly,
          fps: 8,
          x: fromLeft ? -40 : innerWidth + 40,
          y: top - 90
        });
        flee(id, pointer, sparrow.fly, 700);
        const own = life(id);
        let x = box.left + box.width * between(0.2, 0.5);
        await travel(id, x, top, 1600, { arc: -40 });
        pose(id, { frames: sparrow.perch, fps: 4 });
        for (let hop = 0; hop < 3; hop++) {
          await wait(between(500, 1200), own);
          x = Math.min(box.right - 40, x + between(24, 60));
          await travel(id, x, top, 280, { arc: 12 });
          pose(id, { frames: pick([sparrow.peck, sparrow.look, sparrow.perch])! });
        }
        await wait(1000, own);
        pose(id, { frames: sparrow.fly, fps: 8 });
        await travel(id, fromLeft ? innerWidth + 40 : -40, top - 160, 1800, { arc: 30 });
        remove(id);
      },
      async butterflyPlant() {
        const plants = [...document.querySelectorAll('.status-sprite.stage-bloom')]
          .map((element) => visible(element))
          .filter((box): box is DOMRect => Boolean(box));
        const target = pick(plants) ?? pick(ledges());
        if (!target) return;
        const x = target.left + target.width / 2 - 9;
        const y = target.top - 12;
        const id = spawn({ kind: 'butterfly', frames: butterfly, fps: 10, x: x - 240, y: y - 160 });
        flee(id, pointer, butterfly, 1100);
        const own = life(id);
        await travel(id, x, y, 2600, { sway: 26, easing: 'cubic-bezier(0.3, 0, 0.3, 1)' });
        pose(id, { frames: butterfly.slice(0, 3), fps: 1.5 });
        await wait(between(3000, 5000), own);
        pose(id, { frames: butterfly, fps: 10 });
        await travel(id, x + 260, y - 200, 2400, { sway: 22, easing: 'ease-in' });
        remove(id);
      },
      async monkeyTour() {
        if (narrow()) return;
        const bar = document.querySelector('.garden-masthead')?.getBoundingClientRect();
        const cards = ledges();
        if (!bar || !cards.length) return;
        /*
         * Out from behind one border, a leap or two between card edges, and back behind another -
         * the masthead's lower edge (it climbs up out of sight) or a card's top edge (it sinks).
         * Frightened, it takes the nearest of those at once.
         */
        type Spot = { x: number; y: number; hang: boolean; clip: Clip; box?: DOMRect };
        const onCard = (box: DOMRect): Spot => ({
          x: box.left + between(24, Math.max(30, box.width - 60)),
          y: box.top - 24,
          hang: false,
          clip: { side: 'above', line: box.top },
          box
        });
        const onBar = (): Spot => ({
          x: between(innerWidth * 0.3, innerWidth * 0.7),
          y: bar.bottom - 1,
          hang: true,
          clip: { side: 'below', line: bar.bottom }
        });
        const hidden = (spot: Spot) => (spot.hang ? spot.y - 30 : spot.y + 26);
        const start = Math.random() < 0.5 ? onBar() : onCard(pick(cards)!);
        const id = spawn({
          kind: 'monkey',
          frames: start.hang ? monkey.hang : monkey.sit,
          fps: 2,
          x: start.x,
          y: hidden(start),
          clip: start.clip
        });
        const own = life(id);
        let here = start;
        escapes.set(id, async () => {
          const at = where(id);
          if (!at) return;
          chirp('ook');
          pose(id, { clip: here.clip, frames: here.hang ? monkey.hang : monkey.jump });
          await travel(id, at.x, hidden(here), 240, {
            easing: 'cubic-bezier(0.5, 0, 0.9, 0.5)',
            force: true
          });
        });
        await travel(id, start.x, start.y, 520, { easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.15)' });
        await wait(900, own);
        pose(id, { frames: start.hang ? monkey.wave : monkey.blink, fps: 1 });
        chirp('ook');
        await wait(900, own);
        const leaps = 1 + Math.floor(Math.random() * 3);
        for (let leap = 0; leap < leaps && !own.cancelled; leap++) {
          const box = pick(cards.filter((card) => card !== here.box)) ?? pick(cards)!;
          const next = onCard(box);
          // Free of any border while it is in the air.
          pose(id, { frames: monkey.jump, clip: undefined });
          await travel(id, next.x, next.y, 700 + Math.abs(next.x - here.x) * 0.6, {
            arc: 70 + Math.random() * 50
          });
          here = next;
          pose(id, { frames: monkey.sit, fps: 2 });
          await wait(between(700, 1400), own);
          pose(id, { frames: pick([monkey.scratch, monkey.blink, monkey.sit])!, fps: 3 });
          await wait(between(900, 1800), own);
        }
        const exit = Math.random() < 0.4 ? onBar() : here;
        if (exit !== here) {
          pose(id, { frames: monkey.jump, clip: undefined });
          await travel(id, exit.x, exit.y, 900, { arc: 30 });
          here = exit;
          pose(id, { frames: monkey.hang, fps: 2 });
          await wait(700, own);
        }
        if (own.cancelled) return;
        pose(id, { clip: exit.clip, frames: exit.hang ? monkey.hang : monkey.sit });
        await travel(id, exit.x, hidden(exit), 460, { easing: 'cubic-bezier(0.5, 0, 0.8, 0.4)' });
        remove(id);
      },
      async snailCrawl() {
        if (narrow()) return;
        const box = pick(ledges());
        if (!box) return;
        const start = box.left + 16;
        const distance = Math.min(220, box.width - 80);
        const id = spawn({
          kind: 'snail',
          frames: snail,
          fps: 1,
          x: start,
          y: box.top + 2,
          clip: { side: 'above', line: box.top }
        });
        duck(id, () => box.top, 16, 600);
        const own = life(id);
        // Up over the edge, a slow crawl, and back down behind it.
        await travel(id, start, box.top - 13, 900, { easing: 'ease-out' });
        pose(id, { clip: undefined });
        await travel(id, start + distance, box.top - 13, distance * 110, { easing: 'linear' });
        await wait(800, own);
        pose(id, { clip: { side: 'above', line: box.top } });
        await travel(id, start + distance, box.top + 2, 900, { easing: 'ease-in' });
        remove(id);
      }
    };
    Object.assign(scenes, {
      async batFlit() {
        if (!isNight()) return;
        // A bat at dusk: an erratic loop across the top of the screen and gone.
        const fromLeft = Math.random() < 0.5;
        const y = between(70, Math.min(260, innerHeight * 0.35));
        const id = spawn({
          kind: 'bat',
          frames: bat,
          fps: 10,
          x: fromLeft ? -30 : innerWidth + 30,
          y
        });
        flee(id, pointer, bat, 600);
        const own = life(id);
        let x = fromLeft ? -30 : innerWidth + 30;
        for (let leg = 0; leg < 4 && !own.cancelled; leg++) {
          x += (fromLeft ? 1 : -1) * between(innerWidth * 0.18, innerWidth * 0.32);
          await travel(id, x, between(60, Math.min(280, innerHeight * 0.4)), between(700, 1100), {
            arc: between(-50, 50),
            sway: between(8, 20)
          });
        }
        await travel(id, fromLeft ? innerWidth + 40 : -40, between(40, 160), 900, { arc: 30 });
        remove(id);
      },
      async frogHop() {
        if (narrow()) return;
        const cards = ledges();
        const box = pick(cards);
        if (!box) return;
        // Up over a card's top edge, a few hops along it, and back down behind it.
        const line = box.top;
        let x = box.left + between(20, box.width * 0.4);
        const id = spawn({
          kind: 'frog',
          frames: frog.sit,
          x,
          y: line + 2,
          clip: { side: 'above', line }
        });
        duck(id, () => line, 16, 260);
        const own = life(id);
        await travel(id, x, line - 14, 380, { easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });
        pose(id, { clip: undefined });
        for (let hop = 0; hop < 3 + Math.floor(Math.random() * 3) && !own.cancelled; hop++) {
          await wait(between(500, 1300), own);
          pose(id, { frames: Math.random() < 0.3 ? frog.blink : frog.sit });
          await wait(between(200, 600), own);
          const next = Math.min(box.right - 30, x + between(30, 70));
          if (next <= x) break;
          pose(id, { frames: frog.leap });
          await travel(id, next, line - 14, 420, { arc: 22 });
          pose(id, { frames: frog.sit });
          x = next;
        }
        await wait(700, own);
        pose(id, { clip: { side: 'above', line } });
        await travel(id, x, line + 2, 320, { easing: 'ease-in' });
        remove(id);
      },
      async ladybirdWalk() {
        if (narrow()) return;
        const box = pick(ledges());
        if (!box) return;
        const leftward = Math.random() < 0.5;
        const from = leftward ? box.right - 30 : box.left + 16;
        const to = leftward ? box.left + 16 : box.right - 30;
        const id = spawn({ kind: 'ladybird', frames: ladybird, fps: 6, x: from, y: box.top - 10 });
        flee(id, pointer, ladybird, 700);
        await travel(id, to, box.top - 10, Math.abs(to - from) * 28, { easing: 'linear' });
        await travel(id, to + (leftward ? -60 : 60), box.top - 120, 1400, { sway: 12 });
        remove(id);
      }
    });
    const bloom = async () => {
      const brand = visible(document.querySelector('.garden-masthead .brand'));
      if (!brand) return;
      chirp('bloom');
      const flower = spawn({
        kind: 'flower',
        frames: flowerBloom,
        fps: 3,
        x: brand.right + 6,
        y: brand.bottom - 16
      });
      const flutters = [0, 1, 2].map((index) =>
        spawn({
          kind: 'butterfly',
          frames: butterfly,
          fps: 10,
          x: brand.right,
          y: brand.top + index * 4
        })
      );
      for (const id of flutters) flee(id, pointer, butterfly, 1000);
      await Promise.all(
        flutters.map((id, index) =>
          travel(id, brand.right + between(160, 420), between(120, 320) + index * 30, 2600, {
            sway: 24
          })
        )
      );
      for (const id of flutters) if (state.has(id) && !lives.get(id)?.cancelled) remove(id);
      pose(flower, { frames: [flowerBloom[2]!] });
      await wait(5000, world);
      remove(flower);
    };

    /*
     * The pointer frightens what it comes close to. Measured once a frame at most, and only while
     * something is on screen, so an empty garden costs nothing.
     */
    let measuring = 0;
    const onPointer = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (measuring || !state.size) return;
      measuring = requestAnimationFrame(() => {
        measuring = 0;
        for (const id of state.keys()) {
          const node = nodes.current.get(id);
          if (!node || !escapes.has(id)) continue;
          const box = node.getBoundingClientRect();
          const near = Math.hypot(
            pointer.x - (box.left + box.width / 2),
            pointer.y - (box.top + box.height / 2)
          );
          if (near < 90) spook(id);
        }
      });
    };
    addEventListener('pointermove', onPointer, { passive: true });
    // Capture, so a tap that lands on a button still counts.
    addEventListener('pointerdown', onPointer, { passive: true, capture: true });

    const onBloom = () => void bloom().catch(() => undefined);
    addEventListener('garden:bloom', onBloom);
    // A named scene on request, so a visit can be watched on purpose rather than waited for.
    const onScene = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (scenes[name]) void scenes[name]().catch(() => undefined);
    };
    addEventListener('garden:scene', onScene);

    const weights: [string, number][] = [
      ['monkeyTour', 5],
      ['logoVisit', 4],
      ['birdLedge', 3],
      ['butterflyPlant', 3],
      ['snailCrawl', 1],
      ['frogHop', 3],
      ['ladybirdWalk', 2],
      ['batFlit', isNight() ? 4 : 0]
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
      Date.now() - lastInput.current < 5000 ||
      Boolean(document.querySelector('dialog[open]:modal'));
    const schedule = (first = false) => {
      const [low, high] = first
        ? [3000, 6000]
        : mode === 'lively'
          ? [9000, 22000]
          : [60000, 120000];
      timer = setTimeout(
        async () => {
          if (!quiet()) await scenes[choose()]!().catch(() => undefined);
          if (!world.cancelled) schedule();
        },
        between(low, high)
      );
    };
    schedule(true);
    return () => {
      world.cancelled = true;
      clearTimeout(timer);
      cancelAnimationFrame(measuring);
      removeEventListener('pointermove', onPointer);
      removeEventListener('pointerdown', onPointer, { capture: true });
      removeEventListener('garden:bloom', onBloom);
      removeEventListener('garden:scene', onScene);
      state.clear();
      setActors([]);
    };
  }, [mode]);

  if (mode === 'still') return null;
  const draw = (actor: Actor) => (
    <div
      key={actor.id}
      ref={(node) => {
        if (node) nodes.current.set(actor.id, node);
        else nodes.current.delete(actor.id);
      }}
      className="life-actor"
      style={
        {
          transform: `translate3d(${actor.x}px, ${
            actor.y - (actor.clip?.side === 'below' ? actor.clip.line : 0)
          }px, 0)`
        } as CSSProperties
      }
    >
      <Sprite frames={actor.frames} fps={actor.fps ?? 4} scale={2} flip={actor.flip ?? false} />
    </div>
  );
  const groups = new Map<string, { clip?: Clip; actors: Actor[] }>();
  for (const actor of actors) {
    const key = clipKey(actor.clip);
    const group = groups.get(key) ?? { ...(actor.clip ? { clip: actor.clip } : {}), actors: [] };
    group.actors.push(actor);
    groups.set(key, group);
  }
  return (
    <div className="life-layer" aria-hidden="true">
      {[...groups.entries()].map(([key, group]) =>
        group.clip ? (
          <div
            key={key}
            className="life-clip"
            style={
              group.clip.side === 'below'
                ? { top: group.clip.line, bottom: 0 }
                : { top: 0, height: group.clip.line }
            }
          >
            {group.actors.map(draw)}
          </div>
        ) : (
          <div key={key} className="life-free">
            {group.actors.map(draw)}
          </div>
        )
      )}
    </div>
  );
}
