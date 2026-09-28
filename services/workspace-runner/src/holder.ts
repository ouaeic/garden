import type { DesktopHolder } from '@garden/contracts';

/**
 * Who holds the machine, and the one object that answers it.
 *
 * The desktop and the browser are two surfaces onto the same screen - `BROWSER_USE_DESKTOP_DISPLAY`
 * runs Chromium on the workspace's own X server - and each grew its own takeover. They disagreed:
 * the browser kept a `holder` field on its session and the desktop kept this class, so an owner who
 * took the Computer pane and an agent that had been handed the browser could both believe they held
 * the machine, and both send input to it. There is one screen, so there is one control object; the
 * surfaces register with it rather than each keeping their own answer.
 */
export interface DesktopControlState {
  holder: DesktopHolder;
  holderSince: number;
  generation: number;
}

interface PendingInput {
  actor: DesktopHolder;
  execute: () => Promise<void>;
  cancel: (error: Error) => void;
}

/**
 * One surface driving the shared screen.
 *
 * Registered with `attach` rather than passed to the constructor, because which surfaces exist is
 * not known when the control is made: the desktop session mints the control, and the browser joins
 * it later - or never, on a host with no X server, where the browser mints its own.
 */
export interface ControlSurface {
  /**
   * Lifts every latched key and button on this surface. Runs on every holder transition, no
   * exceptions - a takeover that leaves a key held down is a stuck modifier on the owner's screen,
   * and every keystroke they type afterwards is silently a chord.
   */
  release: () => Promise<void>;
  /** Told after every holder transition, so the surface can republish its own stream state. */
  onChange?: ((state: DesktopControlState) => void) | undefined;
}

export interface DesktopControlOptions {
  /** Releases every latched key and button. Runs on every holder transition, no exceptions. */
  release?: (() => Promise<void>) | undefined;
  onChange?: ((state: DesktopControlState) => void) | undefined;
  now?: () => number;
  /** How long an in-flight atomic transaction (a drag) may finish before it is aborted. */
  settleMs?: number;
  /**
   * How a refusal names this control to the caller. The desktop and the browser refuse in their
   * own words even when they share one instance, because "Browser control is held by user" is what
   * the agent can act on and "the desktop" is not a thing a browser tool call knows about.
   */
  subject?: string;
}

/**
 * The single serialization point for desktop input.
 *
 * Authorization is checked inside the queue slot rather than by the caller, so
 * check-then-act is atomic: a transaction admitted before a takeover cannot execute after
 * it. Takeover is preemptive - queued work from the outgoing holder is discarded, an
 * over-running transaction is aborted, and every held key and button is released before the
 * new holder's first event.
 */
export class DesktopControl {
  #holder: DesktopHolder = 'agent';
  #holderSince: number;
  #generation = 1;
  #queue: PendingInput[] = [];
  #active: AbortController | null = null;
  #draining = false;
  #idle: Array<() => void> = [];
  #transfers: Promise<unknown> = Promise.resolve();
  #surfaces = new Set<ControlSurface>();
  /**
   * The release currently unlatching every surface, if one is.
   *
   * The barrier half of the ordering repair below: the new holder is recorded before the release
   * runs, so their own work would otherwise be authorized to start while the keys the outgoing
   * holder left down are still being lifted - which is the very thing the release exists to
   * prevent. Nothing executes while this is set.
   */
  #releasing: Promise<void> | null = null;

  constructor(private readonly options: DesktopControlOptions = {}) {
    this.#holderSince = (options.now ?? Date.now)();
  }

  get holder(): DesktopHolder {
    return this.#holder;
  }

  get holderSince(): number {
    return this.#holderSince;
  }

  get generation(): number {
    return this.#generation;
  }

  get pending(): number {
    return this.#queue.length;
  }

  get busy(): boolean {
    return this.#active !== null || this.#queue.length > 0 || this.#releasing !== null;
  }

  get state(): DesktopControlState {
    return { holder: this.#holder, holderSince: this.#holderSince, generation: this.#generation };
  }

  /**
   * Registers a surface, and hands back the way to take it off again.
   *
   * A surface that has gone - a browser session that closed - must stop being released, or every
   * later handover pays a round trip to a page that is not there and the failure it raises is the
   * owner's takeover.
   */
  attach(surface: ControlSurface): () => void {
    this.#surfaces.add(surface);
    return () => {
      this.#surfaces.delete(surface);
    };
  }

  /** Every RandR change invalidates coordinates taken from an earlier observation. */
  bumpGeneration(): number {
    this.#generation += 1;
    this.#publish();
    return this.#generation;
  }

  /**
   * Whether this actor may act, and whether what they are acting on is still there.
   *
   * `generation` was optional and, in production, never passed: the runner's routes had no field
   * to read it from, so the staleness half of this method was reachable only from a test while the
   * snapshot it is stamped on told the model its coordinates were being checked. It has a supplier
   * now - `DesktopManager.act` passes the generation the agent's last observation stamped on the
   * session - and it stays optional because the owner dragging in the Computer pane is looking at
   * the live screen and has nothing to be stale about.
   */
  authorize(actor: 'agent' | 'user', generation?: number): void {
    if (this.#holder !== actor && !(this.#holder === 'secure_input' && actor === 'user'))
      throw new Error(`${this.options.subject ?? 'Desktop control'} is held by ${this.#holder}`);
    if (generation !== undefined && generation !== this.#generation)
      throw new Error(
        `Desktop display generation ${generation} is stale; observe the desktop again`
      );
  }

  submit<T>(
    actor: 'agent' | 'user',
    task: (signal: AbortSignal) => Promise<T>,
    options: { generation?: number } = {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        actor,
        cancel: reject,
        execute: async () => {
          try {
            // A takeover that has recorded its new holder but not yet finished unlatching keys is
            // still a takeover in progress; this slot may already belong to the incoming holder,
            // and it waits for the release rather than typing over it.
            if (this.#releasing) await this.#releasing.catch(() => undefined);
            this.authorize(actor, options.generation);
            const controller = new AbortController();
            this.#active = controller;
            try {
              resolve(await task(controller.signal));
            } finally {
              this.#active = null;
            }
          } catch (cause) {
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          }
        }
      });
      void this.#drain();
    });
  }

  async transfer(holder: DesktopHolder): Promise<DesktopControlState> {
    const run = this.#transfers.then(async () => {
      const discarded = this.#queue.splice(0, this.#queue.length);
      for (const task of discarded)
        task.cancel(new Error(`Desktop control was handed to ${holder}`));
      if (!(await this.settle(this.options.settleMs ?? 500))) this.#active?.abort();
      // The new holder is recorded before the release, not after it. Everything above has already
      // evicted the outgoing side - its queue discarded, its over-running transaction aborted -
      // but `#holder` still named it for the whole of the release below, so a fresh submission
      // from the side that had just lost the machine was authorized and ran while the keys were
      // being unlatched. That window is what a takeover is for closing.
      this.#holder = holder;
      this.#holderSince = (this.options.now ?? Date.now)();
      this.#generation += 1;
      // Recording it early opens the same window at the other end, so the queue is held shut for
      // the duration of the release: the invariant this class documents is that every latched key
      // and button is lifted before the new holder's first event, and it survives the reorder.
      const releasing = this.#release();
      this.#releasing = releasing;
      try {
        await releasing;
      } finally {
        this.#releasing = null;
      }
      // Deliberately not rolled back if the release above threw. An owner reaching for the machine
      // must get it: refusing the handover because a keyup could not be delivered leaves the agent
      // holding a screen the owner is already typing on, which is strictly the worse of the two.
      this.#publish();
      return this.state;
    });
    this.#transfers = run.catch(() => undefined);
    return run;
  }

  /** Resolves true when nothing is executing, false if the timeout expired first. */
  async settle(timeoutMs: number): Promise<boolean> {
    if (!this.#draining) return true;
    return Promise.race([
      new Promise<boolean>((resolve) => this.#idle.push(() => resolve(true))),
      new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref();
      })
    ]);
  }

  /**
   * Unlatches every surface, and only then reports a failure.
   *
   * `allSettled` rather than `all` on purpose: the browser's page and the desktop's X server fail
   * independently, and a closed tab must not be the reason the modifiers stay down on the screen
   * the owner is looking at. The first failure is still raised, because a release that did not
   * happen is something the caller has to hear about.
   */
  async #release(): Promise<void> {
    const settled = await Promise.allSettled([
      this.options.release?.() ?? Promise.resolve(),
      ...[...this.#surfaces].map((surface) => surface.release())
    ]);
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  #publish(): void {
    const state = this.state;
    this.options.onChange?.(state);
    for (const surface of this.#surfaces) surface.onChange?.(state);
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const next = this.#queue.shift();
        if (!next) break;
        await next.execute();
      }
    } finally {
      this.#draining = false;
      for (const waiter of this.#idle.splice(0, this.#idle.length)) waiter();
    }
  }
}
