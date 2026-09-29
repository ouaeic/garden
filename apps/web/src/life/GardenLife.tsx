import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Sprite } from './Sprite';
import {
  bat,
  batHanging,
  butterfly,
  frog,
  ladybird,
  ladybirdFlying,
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
  kind: 'bird' | 'owl' | 'bat' | 'butterfly' | 'monkey' | 'frog' | 'ladybird' | 'snail';
  frames: Frames;
  x: number;
  y: number;
  flip?: boolean;
  fps?: number;
  /** Degrees the sprite is turned, for the one seen from above that walks along an edge. */
  turn?: number;
  clip?: Clip | undefined;
}

type Signal = { cancelled: boolean };
class Cancelled extends Error {}
const wait = (ms: number, signal: Signal) =>
  new Promise<void>((done, fail) =>
    setTimeout(() => (signal.cancelled ? fail(new Cancelled()) : done()), ms)
  );
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
const between = (low: number, high: number) => low + Math.random() * (high - low);
const chance = (share: number) => Math.random() < share;
const isNight = (date = new Date()) => date.getHours() >= 20 || date.getHours() < 6;
const clipKey = (clip?: Clip) => (clip ? `${clip.side}:${Math.round(clip.line)}` : 'free');
/** Just past the left or right edge of the screen, where a visitor comes from and goes back to. */
const offscreen = (left: boolean) => (left ? -48 : innerWidth + 48);
/** How long a flight takes at a creature's own speed, in pixels a millisecond. */
const flight = (from: { x: number; y: number }, x: number, y: number, speed: number) =>
  Math.max(600, Math.hypot(x - from.x, y - from.y) / speed);

/** An edge a creature can stand on or hide behind, with the element it belongs to. */
type Ledge = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  element: Element;
};

/**
 * An element whose top edge is really on show: inside the window, and not covered by a sheet or a
 * panel or scrolled out of its own card. Checked where a creature would stand, by asking the page
 * what is at three points just under the edge and just over it - so an edge behind a dialog, or
 * one a scroller has clipped away, is never somewhere to go.
 */
function visible(element: Element | null, edge: 'top' | 'bottom' = 'top'): Ledge | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.bottom <= 0 || box.top >= innerHeight) return null;
  for (const share of [0.2, 0.5, 0.8]) {
    const x = box.left + box.width * share;
    const y = edge === 'top' ? box.top : box.bottom;
    const under = document.elementFromPoint(x, edge === 'top' ? y + 0.5 : y - 0.5);
    if (!under || !(under === element || element.contains(under))) return null;
    const over = document.elementFromPoint(x, Math.max(0, edge === 'top' ? y - 8 : y + 8));
    if (over?.closest('dialog, [role="dialog"], [aria-modal="true"]')) return null;
  }
  const { left, top, right, bottom, width } = box;
  return { left, top, right, bottom, width, element };
}

/** A layout box is a perch only where its own border is painted and unobscured. */
function paintedEdge(element: Element | null, edge: 'top' | 'bottom' = 'top'): Ledge | null {
  const box = visible(element, edge);
  if (!element || !box) return null;
  const style = getComputedStyle(element);
  const width = parseFloat(style.getPropertyValue(`border-${edge}-width`));
  const line = style.getPropertyValue(`border-${edge}-style`);
  const color = style.getPropertyValue(`border-${edge}-color`);
  const alpha = color.includes('/')
    ? color.split('/')[1]
    : color.startsWith('rgba(')
      ? color.split(',')[3]
      : '1';
  if (
    !(width > 0) ||
    line === 'none' ||
    line === 'hidden' ||
    color === 'transparent' ||
    !(parseFloat(alpha ?? '1') > 0)
  )
    return null;
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const paint = getComputedStyle(parent);
    if (paint.visibility !== 'visible' || Number(paint.opacity) === 0) return null;
  }
  // A midpoint hit on a one-pixel line can round into the adjacent child content.
  const y =
    edge === 'top' ? box.top + Math.min(width / 2, 0.01) : box.bottom - Math.min(width / 2, 0.01);
  if (
    [0.2, 0.5, 0.8].some(
      (share) => document.elementFromPoint(box.left + box.width * share, y) !== element
    )
  )
    return null;
  return box;
}

/** Card edges a creature can stand on: wide enough, fully on screen, below the masthead. */
function ledges() {
  const bar = document.querySelector('.garden-masthead')?.getBoundingClientRect().bottom ?? 56;
  return [...document.querySelectorAll('[data-perch], .desk-card, .desk-work-card')]
    .filter((element) => !element.closest('dialog'))
    .map((element) => paintedEdge(element))
    .filter((box): box is Ledge =>
      Boolean(box && box.top > bar + 20 && box.width > 140 && box.right <= innerWidth - 8)
    );
}

/**
 * Who visits, and how often: each is its own chance a minute rather than a turn in a rotation, so
 * a quiet stretch, a busy minute and a rare visitor all happen the way they do outside.
 * `night` visitors come after dark.
 */
const visitors: Array<{ scene: string; perMinute: number; night?: boolean }> = [
  { scene: 'birdVisit', perMinute: 0.7 },
  { scene: 'monkeyTour', perMinute: 0.55 },
  { scene: 'butterflyVisit', perMinute: 0.55 },
  { scene: 'frogHop', perMinute: 0.3 },
  { scene: 'ladybirdWalk', perMinute: 0.3 },
  { scene: 'snailCrawl', perMinute: 0.12 },
  { scene: 'owlVisit', perMinute: 0.35, night: true },
  { scene: 'batVisit', perMinute: 0.45, night: true }
];
const TICK = 3000;
/** A creature that has just left does not come straight back. */
const COOLDOWN = 45_000;
const CROWD = 2;

/**
 * The creatures that live around the interface. They visit now and then, never while you are
 * typing or reading a dialog, and never where they could take a click: the whole layer ignores
 * the pointer. Every one arrives from beyond the edge of the screen or from behind a border and
 * leaves the same way, frightened or not - nothing blinks into or out of existence. They move on
 * the compositor through the Web Animations API, so a leap is a smooth arc at the display's own
 * rate; only their sprite frames step.
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
    /** A frightened creature's scene no longer steers it; only its escape does (`force`). */
    const pose = (id: number, patch: Partial<Actor>, force = false) => {
      const actor = state.get(id);
      if (!actor || (!force && life(id).cancelled)) return;
      state.set(id, { ...actor, ...patch });
      commit();
    };
    const remove = (id: number) => {
      state.delete(id);
      escapes.delete(id);
      lives.delete(id);
      anchors.delete(id);
      commit();
    };
    /**
     * What each creature is standing on or tucked behind, and where that edge was when it got
     * there. A creature in the air has none. The watch below compares the two, so a creature never
     * goes on standing on an edge that has moved, been covered, or belongs to the page just left.
     */
    const anchors = new Map<
      number,
      { element: Element; edge: 'top' | 'bottom'; at: number; border: boolean }
    >();
    const anchor = (
      id: number,
      element: Element | null | undefined,
      edge: 'top' | 'bottom' = 'top',
      border = true
    ) => {
      if (!element || life(id).cancelled) {
        anchors.delete(id);
        return;
      }
      const box = element.getBoundingClientRect();
      anchors.set(id, { element, edge, at: edge === 'top' ? box.top : box.bottom, border });
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
    const at = (id: number) => {
      const actor = state.get(id)!;
      return { x: actor.x, y: actor.y };
    };

    /**
     * Glide to a point, arcing upward by `arc` pixels at the midpoint (downward when negative) or
     * weaving sideways by `sway`. The keyframes are computed once and the compositor interpolates
     * them. A scene's move that is interrupted throws, so the scene stops where it is and the
     * creature's escape takes over; only the escape itself moves with `force`.
     */
    const travel = async (
      id: number,
      x: number,
      y: number,
      ms: number,
      { arc = 0, easing = 'cubic-bezier(0.45, 0, 0.55, 1)', sway = 0, force = false } = {}
    ) => {
      const going = () => !world.cancelled && state.has(id) && (force || !life(id).cancelled);
      await settle();
      // Rendering can take more than one frame on a busy device.
      while (going() && !nodes.current.has(id)) await settle();
      const actor = state.get(id);
      const node = nodes.current.get(id);
      if (!actor || !node || !going()) throw new Cancelled();
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
      if (!going()) throw new Cancelled();
      state.set(id, { ...state.get(id)!, x, y });
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
    /**
     * Off at once, by the shortest way out of sight, because the place it was standing has gone:
     * back behind the border it is tucked behind, or else off the nearer side of the screen.
     */
    const evacuate = (id: number) => {
      const own = lives.get(id);
      if (!own || own.cancelled) return;
      own.cancelled = true;
      const held = anchors.get(id);
      anchors.delete(id);
      const node = nodes.current.get(id);
      const here = where(id);
      node?.getAnimations().forEach((running) => running.cancel());
      const actor = state.get(id);
      if (!actor || !here) {
        remove(id);
        return;
      }
      const clip = held && paintedEdge(held.element, held.edge) ? actor.clip : undefined;
      const leaving = { ...actor, x: here.x, y: here.y, clip };
      state.set(id, leaving);
      commit();
      if (node) node.style.transform = `translate3d(${here.x}px, ${here.y - offset(leaving)}px, 0)`;
      const height = node?.getBoundingClientRect().height ?? 24;
      const leave = clip
        ? travel(id, here.x, clip.side === 'above' ? clip.line + 2 : clip.line - height - 2, 220, {
            easing: 'cubic-bezier(0.5, 0, 0.9, 0.5)',
            force: true
          })
        : travel(id, offscreen(here.x < innerWidth / 2), here.y - 60, 450, {
            easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
            force: true
          });
      void leave.catch(() => undefined).finally(() => remove(id));
    };
    const pointer = { x: -9999, y: -9999 };
    /** Away from the pointer, and on until it is past the nearest edge of the screen. */
    const flee = (id: number, frames: Frames, ms: number, patch: Partial<Actor> = {}) => {
      escapes.set(id, async () => {
        const here = where(id);
        if (!here) return;
        pose(id, { frames, fps: 12, clip: undefined, turn: 0, ...patch }, true);
        const dx = here.x - pointer.x || 1;
        const dy = Math.min(-0.3, (here.y - pointer.y) / 100) * 100;
        const length = Math.hypot(dx, dy);
        const reach = Math.max(innerWidth, innerHeight) + 100;
        await travel(id, here.x + (dx / length) * reach, here.y + (dy / length) * reach, ms, {
          easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
          force: true
        });
      });
    };
    /** Down behind the line it stands on, the way it came. */
    const duck = (id: number, line: () => number, depth: number, ms: number) => {
      escapes.set(id, async () => {
        const here = where(id);
        if (!here) return;
        pose(id, { clip: { side: 'above', line: line() }, turn: 0 }, true);
        await travel(id, here.x, line() + depth, ms, {
          easing: 'cubic-bezier(0.5, 0, 0.9, 0.5)',
          force: true
        });
      });
    };
    const narrow = () => innerWidth < 700;
    /** Birds settle along the painted top borders of cards. */
    const perches = (height: number) =>
      ledges().map((box) => ({
        left: box.left + 12,
        right: box.right - 36,
        y: box.top - height,
        element: box.element
      }));

    const scenes: Record<string, () => Promise<void>> = {
      async birdVisit() {
        const all = perches(17);
        if (!all.length) return;
        let perch = pick(all)!;
        const fromLeft = chance(0.5);
        const id = spawn({
          kind: 'bird',
          frames: sparrow.fly,
          fps: 8,
          x: offscreen(fromLeft),
          y: perch.y - between(80, 180)
        });
        flee(id, sparrow.fly, 700);
        const own = life(id);
        let x = between(perch.left, perch.right);
        // A swoop down under the straight line, and up onto the perch.
        await travel(id, x, perch.y, flight(at(id), x, perch.y, 0.4), { arc: -between(20, 50) });
        pose(id, { frames: sparrow.perch, fps: 4 });
        anchor(id, perch.element);
        chirp('tweet');
        const potter = async (turns: number) => {
          for (let turn = 0; turn < turns; turn++) {
            const doing = pick(['hop', 'hop', 'peck', 'look', 'rest'] as const)!;
            if (doing === 'hop') {
              const hops = chance(0.4) ? 2 : 1;
              const way = chance(0.5) ? -1 : 1;
              for (let hop = 0; hop < hops; hop++) {
                const next = Math.max(perch.left, Math.min(perch.right, x + way * between(14, 36)));
                await travel(id, next, perch.y, 240, { arc: 10 });
                x = next;
              }
            } else if (doing === 'peck') {
              for (let peck = 0; peck < 2 + Math.floor(Math.random() * 2); peck++) {
                pose(id, { frames: sparrow.peck });
                await wait(170, own);
                pose(id, { frames: sparrow.perch });
                await wait(between(150, 320), own);
              }
            } else if (doing === 'look') {
              pose(id, { frames: sparrow.look, flip: chance(0.5) });
              await wait(between(600, 1400), own);
              pose(id, { frames: sparrow.perch, flip: false });
            }
            await wait(between(300, 1200), own);
          }
        };
        await potter(3 + Math.floor(Math.random() * 3));
        // Sometimes on to a second perch before leaving.
        const others = perches(17).filter((other) => Math.abs(other.y - perch.y) > 8);
        if (others.length && chance(0.45)) {
          perch = pick(others)!;
          x = between(perch.left, perch.right);
          pose(id, { frames: sparrow.fly, fps: 8 });
          anchor(id, null);
          await travel(id, x, perch.y, flight(at(id), x, perch.y, 0.35), {
            arc: between(40, 80)
          });
          pose(id, { frames: sparrow.perch, fps: 4 });
          anchor(id, perch.element);
          await potter(2 + Math.floor(Math.random() * 2));
        }
        pose(id, { frames: sparrow.fly, fps: 8 });
        anchor(id, null);
        const away = offscreen(chance(0.5));
        const high = Math.max(-40, perch.y - 220);
        await travel(id, away, high, flight(at(id), away, high, 0.45), { arc: 30 });
        remove(id);
      },
      async owlVisit() {
        if (!isNight()) return;
        const all = perches(17);
        if (!all.length) return;
        const perch = pick(all)!;
        const fromLeft = chance(0.5);
        const id = spawn({
          kind: 'owl',
          frames: owl.fly,
          fps: 3,
          x: offscreen(fromLeft),
          y: perch.y - between(60, 140)
        });
        flee(id, owl.fly, 900);
        const own = life(id);
        const x = between(perch.left, perch.right);
        // Wide and silent: a long glide in, a few slow beats, and it settles.
        await travel(id, x, perch.y, flight(at(id), x, perch.y, 0.22), { arc: -30 });
        pose(id, { frames: owl.perch, fps: 0.4 });
        anchor(id, perch.element);
        await wait(between(4000, 7000), own);
        pose(id, { flip: true });
        await wait(between(3000, 6000), own);
        pose(id, { frames: owl.fly, fps: 3, flip: false });
        anchor(id, null);
        const away = offscreen(!fromLeft);
        await travel(id, away, perch.y - 160, flight(at(id), away, perch.y - 160, 0.25), {
          arc: 20
        });
        remove(id);
      },
      async butterflyVisit() {
        const plants = [...document.querySelectorAll('.status-sprite.stage-bloom')]
          .map((element) => visible(element))
          .filter((box): box is Ledge => Boolean(box));
        const flowers = plants.length ? plants : ledges();
        const first = pick(flowers);
        if (!first) return;
        const spot = (box: Ledge) => ({
          x: box.left + box.width / 2 - 9,
          y: box.top - 12,
          element: box.element
        });
        let target = spot(first);
        const fromLeft = target.x < innerWidth / 2;
        const id = spawn({
          kind: 'butterfly',
          frames: butterfly,
          fps: 10,
          x: offscreen(fromLeft),
          y: target.y - between(40, 160)
        });
        flee(id, butterfly, 1100);
        const own = life(id);
        const visits = flowers.length > 1 && chance(0.5) ? 2 : 1;
        for (let visit = 0; visit < visits; visit++) {
          await travel(id, target.x, target.y, flight(at(id), target.x, target.y, 0.12), {
            sway: 26,
            easing: 'cubic-bezier(0.3, 0, 0.3, 1)'
          });
          // Resting: wings fold and open slowly.
          pose(id, { frames: butterfly.slice(0, 3), fps: 1.5 });
          anchor(id, target.element, 'top', !plants.length);
          await wait(between(2500, 5000), own);
          pose(id, { frames: butterfly, fps: 10 });
          anchor(id, null);
          // Only on to a flower that is still on show; otherwise straight off.
          const nextBox = pick(flowers.filter((box) => box !== first));
          const fresh = nextBox ? visible(nextBox.element) : null;
          if (!fresh) break;
          target = spot(fresh);
        }
        const away = offscreen(!fromLeft);
        const high = Math.max(-40, at(id).y - 240);
        await travel(id, away, high, flight(at(id), away, high, 0.14), {
          sway: 22,
          easing: 'ease-in'
        });
        remove(id);
      },
      async monkeyTour() {
        const masthead = document.querySelector('.garden-masthead');
        const bar = paintedEdge(masthead, 'bottom');
        const cards = ledges();
        if (!cards.length) return;
        /*
         * Out from behind one border, a leap or two between card edges, and back behind another -
         * the masthead's lower edge (it climbs up out of sight) or a card's top edge (it sinks).
         * Frightened, it takes the nearest of those at once.
         */
        type Spot = { x: number; y: number; hang: boolean; clip: Clip; box?: Ledge };
        const onCard = (box: Ledge): Spot => ({
          x: box.left + between(24, Math.max(30, box.width - 60)),
          y: box.top - 24,
          hang: false,
          clip: { side: 'above', line: box.top },
          box
        });
        const onBar = (box: Ledge): Spot => ({
          x: between(box.left + box.width * 0.3, box.left + box.width * 0.7),
          y: box.bottom - 1,
          hang: true,
          clip: { side: 'below', line: box.bottom }
        });
        const hidden = (spot: Spot) => (spot.hang ? spot.y - 30 : spot.y + 26);
        const start = bar && chance(0.5) ? onBar(bar) : onCard(pick(cards)!);
        const hold = (spot: Spot) =>
          spot.hang ? anchor(id, masthead, 'bottom') : anchor(id, spot.box?.element);
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
          const spot = where(id);
          if (!spot) return;
          chirp('ook');
          pose(id, { clip: here.clip, frames: here.hang ? monkey.hang : monkey.jump }, true);
          await travel(id, spot.x, hidden(here), 240, {
            easing: 'cubic-bezier(0.5, 0, 0.9, 0.5)',
            force: true
          });
        });
        hold(start);
        await travel(id, start.x, start.y, 520, { easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.15)' });
        await wait(900, own);
        pose(id, { frames: start.hang ? monkey.wave : monkey.blink, fps: 1 });
        chirp('ook');
        await wait(900, own);
        const leaps = 1 + Math.floor(Math.random() * 3);
        for (let leap = 0; leap < leaps; leap++) {
          // Only to an edge on show right now, not one from when the visit began.
          const now = ledges();
          const box = pick(now.filter((card) => card.element !== here.box?.element)) ?? pick(now);
          if (!box) break;
          const next = onCard(box);
          // Free of any border while it is in the air.
          pose(id, { frames: monkey.jump, clip: undefined });
          anchor(id, null);
          await travel(id, next.x, next.y, 700 + Math.abs(next.x - here.x) * 0.6, {
            arc: 70 + Math.random() * 50
          });
          here = next;
          hold(here);
          pose(id, { frames: monkey.sit, fps: 2 });
          await wait(between(700, 1400), own);
          pose(id, { frames: pick([monkey.scratch, monkey.blink, monkey.sit])!, fps: 3 });
          await wait(between(900, 1800), own);
        }
        const exitBar = paintedEdge(masthead, 'bottom');
        const exit = exitBar && chance(0.4) ? onBar(exitBar) : here;
        if (exit !== here) {
          pose(id, { frames: monkey.jump, clip: undefined });
          anchor(id, null);
          await travel(id, exit.x, exit.y, 900, { arc: 30 });
          here = exit;
          hold(here);
          pose(id, { frames: monkey.hang, fps: 2 });
          await wait(700, own);
        }
        pose(id, { clip: exit.clip, frames: exit.hang ? monkey.hang : monkey.sit });
        await travel(id, exit.x, hidden(exit), 460, { easing: 'cubic-bezier(0.5, 0, 0.8, 0.4)' });
        remove(id);
      },
      async snailCrawl() {
        const box = pick(ledges());
        if (!box) return;
        // Up over the edge, a slow crawl with a rest or two, and back down behind it.
        const rightward = chance(0.5);
        const distance = Math.min(220, box.width - 80);
        const start = rightward ? box.left + 16 : box.right - 40;
        const line = box.top;
        const id = spawn({
          kind: 'snail',
          frames: snail,
          fps: 1,
          // It faces left as drawn.
          flip: rightward,
          x: start,
          y: line + 2,
          clip: { side: 'above', line }
        });
        duck(id, () => line, 16, 600);
        anchor(id, box.element);
        const own = life(id);
        await travel(id, start, line - 13, 900, { easing: 'ease-out' });
        pose(id, { clip: undefined });
        let x = start;
        const end = start + (rightward ? distance : -distance);
        while (Math.abs(end - x) > 4) {
          const next = rightward
            ? Math.min(end, x + between(40, 90))
            : Math.max(end, x - between(40, 90));
          await travel(id, next, line - 13, Math.abs(next - x) * 110, { easing: 'linear' });
          x = next;
          pose(id, { fps: 0.5 });
          await wait(between(600, 1800), own);
          pose(id, { fps: 1 });
        }
        pose(id, { clip: { side: 'above', line } });
        await travel(id, x, line + 2, 900, { easing: 'ease-in' });
        remove(id);
      },
      async batVisit() {
        if (!isNight()) return;
        const masthead = document.querySelector('.garden-masthead');
        const bar = paintedEdge(masthead, 'bottom');
        const flit = async (id: number, fromLeft: boolean) => {
          let x = at(id).x;
          for (let leg = 0; leg < 3; leg++) {
            x += (fromLeft ? 1 : -1) * between(innerWidth * 0.18, innerWidth * 0.32);
            const y = between(70, Math.min(280, innerHeight * 0.4));
            await travel(id, x, y, between(700, 1100), {
              arc: between(-50, 50),
              sway: between(8, 20)
            });
          }
          await travel(id, offscreen(!fromLeft), between(40, 160), 900, { arc: 30 });
        };
        if (bar && !narrow() && chance(0.5)) {
          // Down from behind the masthead to hang by its feet a while, then off into the night.
          const line = bar.bottom;
          const x = between(innerWidth * 0.2, innerWidth * 0.8);
          const id = spawn({
            kind: 'bat',
            frames: batHanging,
            fps: 0.5,
            x,
            y: line - 16,
            clip: { side: 'below', line }
          });
          const own = life(id);
          escapes.set(id, async () => {
            pose(id, { clip: { side: 'below', line }, frames: batHanging }, true);
            await travel(id, x, line - 16, 260, { easing: 'ease-in', force: true });
          });
          anchor(id, masthead, 'bottom');
          await travel(id, x, line - 1, 900, { easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
          await wait(between(4000, 9000), own);
          pose(id, { frames: bat, fps: 10, clip: undefined });
          anchor(id, null);
          flee(id, bat, 600);
          await travel(id, x, line + 40, 400, { easing: 'ease-in' });
          await flit(id, x < innerWidth / 2);
          remove(id);
          return;
        }
        // An erratic loop across the top of the screen and gone.
        const fromLeft = chance(0.5);
        const id = spawn({
          kind: 'bat',
          frames: bat,
          fps: 10,
          x: offscreen(fromLeft),
          y: between(70, Math.min(260, innerHeight * 0.35))
        });
        flee(id, bat, 600);
        await flit(id, fromLeft);
        remove(id);
      },
      async frogHop() {
        const cards = ledges();
        let box = pick(cards);
        if (!box) return;
        // Eyes over a card's edge first, then up, hopping along - maybe across to another card -
        // and back down behind whichever edge it ends on.
        let line = box.top;
        let x = box.left + between(20, box.width * 0.5);
        const id = spawn({
          kind: 'frog',
          frames: frog.sit,
          x,
          y: line + 2,
          clip: { side: 'above', line }
        });
        duck(id, () => line, 16, 260);
        anchor(id, box.element);
        const own = life(id);
        await travel(id, x, line - 5, 500, { easing: 'ease-out' });
        await wait(between(900, 1800), own);
        pose(id, { frames: frog.blink });
        await wait(200, own);
        pose(id, { frames: frog.sit });
        await wait(between(400, 900), own);
        await travel(id, x, line - 14, 320, { easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });
        pose(id, { clip: undefined });
        const hopAlong = async (count: number) => {
          for (let hop = 0; hop < count; hop++) {
            await wait(between(500, 1300), own);
            if (chance(0.3)) {
              pose(id, { frames: frog.blink });
              await wait(180, own);
              pose(id, { frames: frog.sit });
            }
            const way = x > box!.right - 70 ? -1 : x < box!.left + 40 ? 1 : chance(0.65) ? 1 : -1;
            const next = Math.max(
              box!.left + 12,
              Math.min(box!.right - 30, x + way * between(28, 64))
            );
            pose(id, { frames: frog.leap });
            await travel(id, next, line - 14, 420, { arc: 22 });
            pose(id, { frames: frog.sit });
            x = next;
          }
        };
        await hopAlong(2 + Math.floor(Math.random() * 3));
        // Across only to an edge on show right now.
        const across = ledges().filter(
          (card) => card.element !== box!.element && Math.abs(card.left - x) < 600
        );
        if (across.length && chance(0.35)) {
          box = pick(across)!;
          const next = box.left + between(20, box.width * 0.6);
          await wait(between(400, 900), own);
          pose(id, { frames: frog.leap });
          anchor(id, null);
          await travel(id, next, box.top - 14, 700 + Math.abs(next - x) * 0.5, {
            arc: between(50, 90)
          });
          pose(id, { frames: frog.sit });
          anchor(id, box.element);
          x = next;
          line = box.top;
          await hopAlong(1 + Math.floor(Math.random() * 2));
        }
        await wait(700, own);
        pose(id, { clip: { side: 'above', line } });
        await travel(id, x, line + 2, 320, { easing: 'ease-in' });
        remove(id);
      },
      async ladybirdWalk() {
        const box = pick(ledges());
        if (!box) return;
        // Up over a card's edge, a walk in short bursts along it, then wings out and away.
        const line = box.top;
        let rightward = chance(0.5);
        let x = rightward ? box.left + between(16, 60) : box.right - between(40, 90);
        const id = spawn({
          kind: 'ladybird',
          frames: ladybird,
          fps: 6,
          turn: 0,
          x,
          y: line + 1,
          clip: { side: 'above', line }
        });
        duck(id, () => line, 12, 500);
        anchor(id, box.element);
        const own = life(id);
        await travel(id, x, line - 10, 900, { easing: 'ease-out' });
        pose(id, { clip: undefined, turn: rightward ? 90 : -90 });
        await travel(id, x, line - 12, 300);
        flee(id, ladybirdFlying, 1400);
        for (let burst = 0; burst < 4 + Math.floor(Math.random() * 4); burst++) {
          if (chance(0.25)) {
            rightward = !rightward;
            pose(id, { turn: rightward ? 90 : -90 });
            await wait(350, own);
          }
          const next = rightward
            ? Math.min(box.right - 30, x + between(20, 60))
            : Math.max(box.left + 12, x - between(20, 60));
          if (Math.abs(next - x) < 4) {
            rightward = !rightward;
            continue;
          }
          pose(id, { fps: 6 });
          await travel(id, next, line - 12, Math.abs(next - x) * 28, { easing: 'linear' });
          x = next;
          pose(id, { fps: 1 });
          await wait(between(300, 1200), own);
        }
        pose(id, { frames: ladybirdFlying, fps: 14, turn: 0 });
        anchor(id, null);
        await wait(500, own);
        const away = offscreen(rightward);
        await travel(id, (x + away) / 2, line - between(100, 180), 1400, { sway: 14 });
        await travel(id, away, Math.max(-40, line - between(200, 320)), 1600, { sway: 10 });
        remove(id);
      }
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

    /*
     * Four times a second, while anyone is out: a creature whose edge has moved, been covered or
     * gone - a sheet opened over it, the card scrolled, the page changed - leaves at once rather
     * than standing on nothing. A new page sends everyone off, since every edge they knew was the
     * last page's.
     */
    let page = location.href;
    const watch = setInterval(() => {
      const turned = location.href !== page;
      page = location.href;
      if (!state.size) return;
      for (const id of [...state.keys()]) {
        if (turned) {
          evacuate(id);
          continue;
        }
        const held = anchors.get(id);
        if (!held) continue;
        const box = held.element.isConnected ? held.element.getBoundingClientRect() : null;
        const edge = box ? (held.edge === 'top' ? box.top : box.bottom) : Number.NaN;
        if (
          !box ||
          !(Math.abs(edge - held.at) <= 2) ||
          !(held.border ? paintedEdge(held.element, held.edge) : visible(held.element))
        )
          evacuate(id);
      }
    }, 250);
    const active = new Set<string>();
    const left = new Map<string, number>();
    const run = (scene: string) => {
      if (active.has(scene) || !scenes[scene]) return;
      active.add(scene);
      void scenes[scene]()
        .catch(() => undefined)
        .finally(() => {
          active.delete(scene);
          left.set(scene, Date.now());
        });
    };
    // A named visitor on request, so a visit can be watched on purpose rather than waited for.
    const onScene = (event: Event) => run((event as CustomEvent<string>).detail);
    addEventListener('garden:scene', onScene);

    const quiet = () =>
      document.visibilityState !== 'visible' ||
      Date.now() - lastInput.current < 5000 ||
      Boolean(document.querySelector('dialog[open]:modal'));
    const eligible = () =>
      visitors.filter(
        (visitor) =>
          (!visitor.night || isNight()) &&
          !active.has(visitor.scene) &&
          Date.now() - (left.get(visitor.scene) ?? 0) > COOLDOWN
      );
    const pace = mode === 'lively' ? 1 : 0.15;
    const tick = setInterval(() => {
      if (quiet() || active.size >= CROWD) return;
      // Everyone gets their own roll; at most one arrives in a tick.
      for (const visitor of eligible().sort(() => Math.random() - 0.5))
        if (chance(1 - Math.exp(-(visitor.perMinute * pace * TICK) / 60_000)))
          return run(visitor.scene);
    }, TICK);
    // Someone is usually about soon after the garden opens.
    let hello: ReturnType<typeof setTimeout>;
    const greet = () => {
      if (quiet()) {
        hello = setTimeout(greet, TICK);
        return;
      }
      if (active.size) return;
      const choices = eligible();
      const total = choices.reduce((sum, visitor) => sum + visitor.perMinute, 0);
      let roll = Math.random() * total;
      for (const visitor of choices) if ((roll -= visitor.perMinute) < 0) return run(visitor.scene);
    };
    hello = setTimeout(greet, mode === 'lively' ? between(4000, 8000) : between(30_000, 60_000));
    return () => {
      world.cancelled = true;
      clearInterval(tick);
      clearInterval(watch);
      clearTimeout(hello);
      cancelAnimationFrame(measuring);
      removeEventListener('pointermove', onPointer);
      removeEventListener('pointerdown', onPointer, { capture: true });
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
      data-life={actor.id}
      data-creature={actor.kind}
      style={
        {
          transform: `translate3d(${actor.x}px, ${
            actor.y - (actor.clip?.side === 'below' ? actor.clip.line : 0)
          }px, 0)`
        } as CSSProperties
      }
    >
      <span className="life-turn" style={{ transform: `rotate(${actor.turn ?? 0}deg)` }}>
        <Sprite frames={actor.frames} fps={actor.fps ?? 4} scale={2} flip={actor.flip ?? false} />
      </span>
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
