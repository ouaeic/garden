/**
 * The route-fidelity observation: what garden's loop actually asks a workspace for.
 *
 * This is the deliverable the rest of the rig rests on. Before it, the set of routes a benchmark
 * shim must implement was a list somebody read off `services/workspace-runner/src/server.ts` and
 * believed - and the research lane that produced that list said so in its own limits: "I read the
 * route list and the harness stub's route matches, I did NOT drive a turn and record which routes
 * it actually hit."
 *
 * It runs the existing fixtures through `runFixture` unchanged, on the seam that already exists,
 * and unions `RunOutcome.observedRoutes`. Zero cost: no key, no network, no provider.
 *
 * WHAT THE OBSERVED SET IS AND IS NOT. It is a FLOOR. It is every route these fixtures happened to
 * drive, and a fixture suite is a set of scripted turns, not a proof of coverage. A route that
 * only a connector call or a desktop turn reaches will not appear here if no fixture scripts one.
 * `declaredButUnobserved` is the advisory complement - routes the worker's own source can build a
 * URL for that no fixture reached - and it is advisory because the extraction is a text scan and
 * several call sites build the suffix from a variable. Neither list is a ceiling and the artefact
 * says so in both directions.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtures } from '../fixtures.js';
import { identityLabel, runFixture, runIdentity, type Fixture } from '../harness.js';
import { canonicalRoute, type RouteObservation } from './routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * What `evals/harness.ts` answers `GET /surfaces` with, restated here so the artefact carries it.
 *
 * NOT A CHOICE THIS FILE MAKES - a fact about the rig it sweeps, at the `/surfaces` stub in
 * `evals/harness.ts`. If that answer ever changes, this constant becomes a false comment, which is
 * a defect ranked with a code defect in this repository. `selftest.ts` re-reads the ANSWER out of
 * that file by pattern and fails when the two disagree, so it cannot rot quietly.
 *
 * Named rather than numbered, and that is the repair rather than the style. This said
 * `evals/harness.ts:1123` and then `:1219`, and both were wrong: the first rotted when the harness
 * grew, and the second was corrected to the line the `/machine` stub had just taken rather than to
 * the `/surfaces` one seventeen lines below it. Nothing caught either, because the selftest checks
 * the answer and no check anywhere reads a line number in a comment.
 */
export const SWEEP_SURFACES = { browser: 'available', desktop: 'available' } as const;

/** Where `apps/worker/src` sits relative to this file, for the advisory scan below. */
const WORKER_SOURCE = path.resolve(here, '..', '..', 'apps', 'worker', 'src');

/**
 * Every runner URL `apps/worker/src` can be seen to construct, canonicalised.
 *
 * A TEXT SCAN, and it is honest about being one. It matches `/v1/workspaces/${...}` followed by
 * literal path segments and stops at the first interpolation after that, so a call site that
 * builds its suffix from a variable - `tools/workspace.ts:696`, `tools/web.ts:24`,
 * `approval-floor.ts:219` - contributes only its prefix and is reported as the bare workspace
 * route. It over-reports nothing and under-reports those. Its whole job is to catch a route the
 * loop can reach that no fixture happens to script, which is a real gap and a cheap one to see.
 */
export const declaredRoutes = (root = WORKER_SOURCE): string[] => {
  const found = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/\/v1\/workspaces\/\$\{[^}]*\}([A-Za-z0-9/._-]*)/g)) {
        const suffix = match[1] ?? '';
        // The method is not recoverable from the URL alone, so the scan reports the path and the
        // caller compares paths. Saying `GET` here would be an invention.
        found.add(`/v1/workspaces/:workspaceId${suffix.replace(/\/$/, '')}`);
      }
    }
  };
  walk(root);
  return [...found].sort();
};

/** One sweep over a fixture selection, unioned. */
export const observe = async (
  selection: readonly Fixture[],
  onFixture?: (id: string, routes: readonly string[]) => void
): Promise<RouteObservation> => {
  const counts = new Map<string, number>();
  const unstubbed = new Set<string>();
  const ran: string[] = [];
  for (const fixture of selection) {
    // Sequentially, like `evals/run.ts`, and for the same reason: `runFixture` installs its own
    // `globalThis.fetch` and its own clock for the duration of a run. Two at once would measure
    // each other.
    const outcome = await runFixture(fixture);
    ran.push(fixture.id);
    for (const route of outcome.observedRoutes) counts.set(route, (counts.get(route) ?? 0) + 1);
    for (const route of outcome.unstubbedRoutes) unstubbed.add(route);
    onFixture?.(fixture.id, outcome.observedRoutes);
  }
  const observed = [...counts.entries()]
    .map(([route, count]) => ({ route, fixtures: count }))
    .sort((left, right) => left.route.localeCompare(right.route));
  const observedPaths = new Set(observed.map((row) => row.route.split(' ')[1] ?? ''));
  return {
    recordedAt: new Date().toISOString(),
    garden: identityLabel(runIdentity()),
    // Read off the harness rather than assumed: its `/surfaces` stub answers with
    // both surfaces AVAILABLE, and the comment there says why - that is the box this rig models.
    // It has to travel with the observation, because a box with both surfaces reaches seven routes
    // a benchmark container cannot, and a reader comparing this sweep to one taken under a bare
    // box would otherwise see a shim gap where there is only a different computer.
    surfaces: SWEEP_SURFACES,
    fixtures: ran,
    observed,
    unstubbed: [...unstubbed].sort(),
    declaredButUnobserved: declaredRoutes().filter((route) => !observedPaths.has(route))
  };
};

export const allFixtures = (): readonly Fixture[] => fixtures;

/** The canonicaliser, re-exported so a caller comparing a live shim's log to the artefact agrees. */
export { canonicalRoute };
