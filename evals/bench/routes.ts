/**
 * The route vocabulary this rig speaks, and the hard failure that stops a missing one from
 * looking like a bad model.
 *
 * WHY THIS FILE EXISTS AT ALL. garden's loop reaches its workspace through exactly one client
 * (`apps/worker/src/runner-client.ts`, constructed at `apps/worker/src/agent.ts:291` from the one
 * global `WORKSPACE_RUNNER_URL`). Point that URL at a shim and the whole loop runs against a
 * benchmark container with no change to the core. The failure that route buys, and which this file
 * is built to make impossible, is that a shim missing a route garden needs DOES NOT THROW. Three
 * production sites swallow the miss by design:
 *
 *   apps/worker/src/agent.ts:1301  `#toolchainSummary`  `.catch(() => null)` - the runtime block
 *                                   loses a line describing what the box can do with documents.
 *   apps/worker/src/agent.ts:1327  `#machineSummary`    `.catch(() => null)` - the runtime block
 *                                   loses the three numbers that decide how a job is sized.
 *   apps/worker/src/agent.ts:1354  `#workspaceSurfaces` falls back to `UNKNOWN_SURFACES`, and
 *                                   unknown means the FULL catalogue: about 11.7 kB of browser and
 *                                   desktop schemas on every request of every turn.
 *
 * Each of those is the right decision for a product - a task that will not start is worse than a
 * task missing a line. Each of them is a catastrophe for a benchmark row: the run completes, the
 * score is real, and the configuration it was measured under is not the one the row declares. The
 * third one is worse than a missing line, because it silently moves the arm: a row labelled with a
 * bare catalogue would have been measured with the provisioned one.
 *
 * THIS IS NOT HYPOTHETICAL IN THIS TREE. `GET /v1/workspaces/:workspaceId/machine` was added to
 * the loop in 89185c6 and `evals/harness.ts`'s runner stub does not answer it, so at 8d701a0 every
 * fixture that reaches it measures a 404. `evals/report.ts:165` catches it only because that rig
 * has an explicit never-declarable assertion on `unstubbedRoutes`. A benchmark harness written
 * without the same assertion would have reported a number.
 *
 * So: routes are canonicalised here, the set the shim implements is declared here, and asking for
 * anything outside it is a recorded miss that refuses the run rather than a 404 somebody's
 * `.catch` absorbs. See `shim.ts` for the refusal and `README.md` for what it costs.
 */

/**
 * A route named the way a person has to implement it: the method, and the path with ids and query
 * removed.
 *
 * Deliberately the same shape `routeName` in `evals/harness.ts` produces, so the observed set
 * this rig reads out of the fixture sweep and the implemented set declared below are comparable
 * strings rather than two spellings of the same idea. The difference is that this one does not
 * know the fixture workspace id, so it recognises a uuid wherever one appears.
 *
 * A path segment counts as an id when it is a uuid, or a runner-minted session id (`proc_`/`svc_`
 * plus a uuid, `services/workspace-runner/src/server.ts:769`), or a checkpoint id. Anything else
 * is a literal segment and stays, because a shim that collapsed `/toolchain/probe` into
 * `/toolchain/:id` would report itself as implementing a route it does not.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^(proc|svc)_[0-9a-f-]{8,}$/i;

const idLike = (segment: string): boolean => UUID.test(segment) || SESSION.test(segment);

export const canonicalRoute = (method: string, url: string): string => {
  const path = (() => {
    try {
      return new URL(url, 'http://runner.invalid').pathname;
    } catch {
      return url.split('?')[0] ?? url;
    }
  })();
  const segments = path.split('/').map((segment, index, all) => {
    const before = all[index - 1];
    /*
     * Two places where the runner's own route takes WHATEVER segment arrives, so the fold has to
     * as well, or a value the model made up voids a row for a route the runner would have
     * answered. `/processes/:id` is a fastify parameter: a session id nobody minted gets a 404,
     * which the loop reads as "no such process" and carries on. Measured on the box: a model that
     * polled `processes/bg-started` produced a miss and no row for the whole arm, while the real
     * runner would have said not found. `/preview-check/:port` is the same shape with a number.
     */
    if (before === 'processes' && segment !== 'start' && segment !== 'stop-owner' && segment !== '')
      return ':id';
    if (before === 'preview-check' && segment !== '') return ':port';
    if (!idLike(segment)) return segment;
    // The workspace id is the segment after `workspaces`; everything else id-shaped is whatever
    // the route before it named. Distinguished so the two do not collapse into one another and
    // hide a route with two ids in it.
    return before === 'workspaces' ? ':workspaceId' : ':id';
  });
  return `${method.toUpperCase()} ${segments.join('/')}`;
};

/**
 * What the shim answers, and nothing else.
 *
 * This list is the CONTRACT, not a convenience: `shim.ts` dispatches on it and refuses everything
 * outside it. Adding a line here without adding the handler is caught by `selftest.ts`, which
 * drives one request at every route in this list through a shim over a temporary directory and
 * fails on any that comes back a miss - because a declared route with no handler is the same
 * defect as an undeclared one, wearing the contract's clothes.
 *
 * Chosen as the union of what the fixture sweep observed (`routes.json`) and what a coding
 * benchmark needs beyond what those fixtures happen to drive. It does NOT include the browser,
 * desktop, audio, preview, snapshot or export routes: this shim answers `/surfaces` with a box
 * that has neither a browser nor a screen, which is what a Terminal-Bench container is, and the
 * catalogue gate at `apps/worker/src/turn/claim.ts:225` then withdraws the seven tools that would
 * have reached them. If a run ever asks for one anyway, that is a real finding about the gate and
 * it must arrive as a refused run rather than as a 404 the loop shrugs off.
 */
export const IMPLEMENTED_ROUTES: readonly string[] = [
  // The workspace itself. `PUT` is `ensure`; the agent's own tools call it through `delegate.ts`
  // and `tools/workspace.ts` before anything else happens.
  'PUT /v1/workspaces/:workspaceId',
  'GET /v1/workspaces/:workspaceId',
  // The one that matters. Everything a coding benchmark scores comes back through here.
  'POST /v1/workspaces/:workspaceId/exec',
  // Files, in the four shapes the client asks for them: a listing, a read, a write, a delete.
  'GET /v1/workspaces/:workspaceId/files',
  'GET /v1/workspaces/:workspaceId/file',
  'PUT /v1/workspaces/:workspaceId/file',
  'DELETE /v1/workspaces/:workspaceId/file',
  'POST /v1/workspaces/:workspaceId/files/folder',
  'POST /v1/workspaces/:workspaceId/files/rename',
  // What this box is, which decides the runtime block and - through `/surfaces` - the catalogue.
  // These three are the routes whose absence is silent, so they are the reason for the whole file.
  'GET /v1/workspaces/:workspaceId/toolchain',
  'POST /v1/workspaces/:workspaceId/toolchain/probe',
  'GET /v1/workspaces/:workspaceId/machine',
  'GET /v1/workspaces/:workspaceId/surfaces',
  // Storage, read back after a write to keep the workspace's own figure current.
  'GET /v1/workspaces/:workspaceId/usage',
  // Background commands. A long build or a test server is the ordinary shape of a benchmark task.
  'POST /v1/workspaces/:workspaceId/processes/start',
  'GET /v1/workspaces/:workspaceId/processes',
  'POST /v1/workspaces/:workspaceId/processes/stop-owner',
  'POST /v1/workspaces/:workspaceId/processes/:id',
  // Whether something answers on a port inside the box, which is what the loop asks after a
  // task starts a server. Reached on the box by a task that started one; a miss here voided a
  // resolved row.
  'GET /v1/workspaces/:workspaceId/preview-check/:port',
  // Checkpoints. Answered as a real content checkpoint over the backend, because a turn that
  // cannot check point cannot roll back, and a stub answer here would make a rollback look done.
  'GET /v1/workspaces/:workspaceId/checkpoints',
  'POST /v1/workspaces/:workspaceId/checkpoints',
  /*
   * One picture, which is NOT the file route and had to be found by the sweep rather than
   * reasoned about. `image_read` GETs `/image?path=…`, and `image_read` is not one of the seven
   * tools a bare box withdraws (`apps/worker/src/tool-catalogue.test.ts:688-700`), so a benchmark
   * container with no browser and no screen can still be asked to look at a PNG the task shipped.
   * Four of the 73 fixtures reach it.
   */
  'GET /v1/workspaces/:workspaceId/image',
  // The parse-only check of the agent's own Python acceptance commands. The runner answers it on
  // its own host and never in the workspace, so the shim answers it on this one, with the same
  // function. A miss here voided every run whose acceptance check was written in Python.
  'POST /v1/workspaces/:workspaceId/acceptance/inspect',
  // An acceptance check written as JSON assertions over a file. Answered with the runner's own
  // comparison over the file the box holds; a miss here voided every run that declared one.
  'POST /v1/workspaces/:workspaceId/json-proof'
];

const IMPLEMENTED = new Set(IMPLEMENTED_ROUTES);

export const isImplemented = (route: string): boolean => IMPLEMENTED.has(route);

/**
 * Routes this shim answers with a NAMED REFUSAL rather than implementing or refusing to run.
 *
 * A third category, and it needs its own justification because "answer it with an error" is the
 * shape of every bad shim. The distinction is this: a MISS is silence - the loop asks, gets
 * nothing it can read, and works around a capability it was told it had. A DECLARED ABSENCE is
 * this box saying, in the tool result the model reads, that it has no browser and no microphone.
 * The model can act on the second. It cannot act on the first.
 *
 * WHY THESE THREE AND NOT THE OTHER BROWSER ROUTES. `apps/worker/src/tool-catalogue.test.ts:688`
 * names the exact seven tools a bare box withdraws - `desktop_observe`, `desktop_launch`,
 * `desktop_action`, `browser_snapshot`, `read_elements`, `browser_action`, `print_pdf` - and the
 * comment two lines below it names the two that are deliberately NOT in that bag: `web_search`,
 * because one of its two routes is answered by the provider, and `parallel_web_read`, because the
 * specialist wire is invariant. `audio_read` is not in the bag either. So on a box that answers
 * `/surfaces` with `absent, absent`, exactly these three routes remain reachable and the other
 * seven cannot be. A run that reaches one of the seven anyway means the catalogue gate did not
 * hold, which is a finding worth voiding a run for - so those stay MISSES on purpose.
 *
 * Every request to one of these is counted and reaches the artefact, as the `absent_route_requests`
 * column. A benchmark task that spent
 * a third of its steps trying to browse is a task whose score says more about the environment than
 * about the agent, and a reader deserves to see that number rather than infer it.
 */
export const ABSENT_ROUTES: Readonly<Record<string, string>> = {
  'POST /v1/workspaces/:workspaceId/browser/search':
    'This computer has no browser, so it cannot search the web.',
  'POST /v1/workspaces/:workspaceId/browser/read-many':
    'This computer has no browser, so it cannot read web pages.',
  'POST /v1/workspaces/:workspaceId/audio/prepare':
    'This computer has no audio toolchain, so it cannot prepare a recording.',
  // The runner reads documents with the managed document toolchain, which a benchmark box does not
  // have - its `/toolchain` answer says so - though `load_tools` can still put the tools in view.
  // Recorded analyses run under the runner's supervisor, which a benchmark box does not have.
  'GET /v1/workspaces/:workspaceId/computation':
    'This computer has no recorded-analysis service, so garden-run analyses cannot run here; run the analysis with the shell instead.',
  'POST /v1/workspaces/:workspaceId/computation':
    'This computer has no recorded-analysis service, so garden-run analyses cannot run here; run the analysis with the shell instead.',
  // An acceptance check that a document renders, which the same document toolchain answers.
  'POST /v1/workspaces/:workspaceId/document/render-proof':
    'This computer has no document toolchain, so a document cannot be rendered here to prove it; check the file with the shell instead.',
  'POST /v1/workspaces/:workspaceId/documents':
    'This computer has no document toolchain, so document_read and document_search cannot run here; read the file with the shell instead.'
};

/**
 * The seven tools a bare box withdraws, and the route each of them is the only caller of.
 *
 * Used to read the observation honestly rather than to excuse the shim. The sweep in `observe.ts`
 * runs against `evals/harness.ts`'s stub, which answers `/surfaces` with BOTH SURFACES AVAILABLE
 * (the `/surfaces` stub in `evals/harness.ts`, and the comment there says why), so the observed set
 * contains routes
 * that a benchmark box - which answers `absent, absent` - cannot reach at all. Subtracting them is
 * only sound because the gate is proved elsewhere: `tool-catalogue.test.ts` asserts the withdrawal
 * by name, and `apps/worker/src/turn/claim.ts:245` is the one line that applies it.
 *
 * WHAT THIS RIG HAS NOW OBSERVED, and where the limit still is. This used to say the subtraction
 * was read and never watched. `--score` closed half of it: a real `AgentWorker` runs against a shim
 * answering `/surfaces` with `absent, absent`, and `selftest.ts` asserts that the catalogue offered
 * on that turn's last request contains none of the seven tools - derived through `agentToolsFor`
 * rather than listed here, so the check cannot fall behind the product. Measured 2026-09-02: with
 * the runner pointed back at `evals/harness.ts`'s stub, whose `/surfaces` answers with both
 * surfaces available, all seven reappear in the same check.
 *
 * WHAT IS STILL READ RATHER THAN WATCHED: that a turn on that box never REACHES these routes. The
 * gate withdrawing the tools is now observed; a model determined to reach the route anyway is not,
 * because the scripted model does not try. Only a paid run with a task that wants a browser can
 * close that, and if it ever does reach one the miss voids the row, which is the point.
 */
export const SURFACE_GATED_ROUTES: Readonly<Record<string, 'browser' | 'desktop'>> = {
  'POST /v1/workspaces/:workspaceId/browser/snapshot': 'browser',
  'POST /v1/workspaces/:workspaceId/browser/elements': 'browser',
  'POST /v1/workspaces/:workspaceId/browser/action': 'browser',
  'POST /v1/workspaces/:workspaceId/browser/print-pdf': 'browser',
  'POST /v1/workspaces/:workspaceId/desktop/snapshot': 'desktop',
  'POST /v1/workspaces/:workspaceId/desktop/launch': 'desktop',
  'POST /v1/workspaces/:workspaceId/desktop/action': 'desktop'
};

export const isAbsent = (route: string): boolean =>
  Object.prototype.hasOwnProperty.call(ABSENT_ROUTES, route);

/** The observed-route artefact, as `routes.json` holds it. */
export interface RouteObservation {
  readonly recordedAt: string;
  readonly garden: string;
  /** Every fixture the sweep ran, by id, so a later sweep can be compared against the same set. */
  readonly fixtures: readonly string[];
  /** Route, and how many of those fixtures reached it at least once. */
  readonly observed: ReadonlyArray<{ readonly route: string; readonly fixtures: number }>;
  /**
   * Routes the fixture stub itself does not model, which is a defect in `evals/harness.ts` rather
   * than in this rig - recorded here because it is the same evidence and it should not be found
   * twice.
   */
  readonly unstubbed: readonly string[];
  /**
   * Routes `apps/worker/src` can construct that no fixture in the sweep reached.
   *
   * ADVISORY, and it has to be, because the extraction is a text scan of template literals and
   * several call sites build the suffix from a variable (`tools/workspace.ts:696`,
   * `tools/web.ts:24`). It over-reports and under-reports. It is here because the observed set is
   * a FLOOR - it is what these fixtures happened to drive, not what the loop can drive - and a
   * reader who mistakes a floor for a ceiling is exactly the reader this rig is written for.
   */
  readonly declaredButUnobserved: readonly string[];
  /**
   * What the sweep's `/surfaces` answer was, because it decides which routes could appear at all.
   *
   * An observation that did not carry this would be unreadable: the same suite under
   * `absent, absent` reaches a strictly smaller set, and a reader comparing two sweeps would see a
   * shim gap where there was only a different box.
   */
  readonly surfaces: { readonly browser: string; readonly desktop: string };
}

/**
 * What the shim is missing against an observation, what it declares absent, what the box the shim
 * describes could never have asked for, and what it implements that nothing asked for.
 *
 * All four, because three of them are defects and only one is loud. A missing route scores 0 with
 * no error. A surplus route is a handler nobody drives, which is this programme's
 * computed-and-unwired shape: it will be believed and it has never run. A gated route is neither,
 * and folding it into `missing` would make the shim look broken for refusing a browser it correctly
 * does not have - which is the fastest way to get a real miss ignored among false ones.
 */
export const coverageOf = (
  observation: RouteObservation
): {
  readonly missing: string[];
  readonly absent: string[];
  readonly gatedOut: string[];
  readonly unexercised: string[];
} => {
  const observed = new Set(observation.observed.map((row) => row.route));
  /*
   * Only when the sweep itself ran with the surface THIS ROUTE NEEDS and this shim's box lacks.
   *
   * Per route rather than per sweep, and the correction matters in both directions. This asked
   * `observation.surfaces.browser !== 'absent'` and applied the answer to all seven, including the
   * three desktop routes - so a sweep on a box with a screen and no browser had its desktop routes
   * reported as MISSES the shim ought to implement, and a sweep on a box with a browser and no
   * screen would have excused desktop routes that could not have been reached at all, hiding a real
   * miss behind a surface the box did not have. `agentToolsFor` gates the two families
   * independently - `apps/worker/src/tool-catalogue.ts:1866-1867` filters `BROWSER_SURFACE_TOOLS`
   * on `surfaces.browser` and `DESKTOP_SURFACE_TOOLS` on `surfaces.desktop`, in two separate
   * clauses - so reading one answer for both was never a fair reading of the gate.
   *
   * It is invisible on the committed observation, whose sweep box has BOTH surfaces: the two
   * spellings agree there, which is exactly why this needed a constructed observation to go red
   * against rather than the artefact in the repository. See `selftest.ts`.
   */
  const gatedOut = [...observed]
    .filter((route) => {
      const surface = SURFACE_GATED_ROUTES[route];
      return surface !== undefined && observation.surfaces[surface] !== 'absent';
    })
    .sort();
  const excused = new Set(gatedOut);
  return {
    missing: [...observed]
      .filter((route) => !IMPLEMENTED.has(route) && !isAbsent(route) && !excused.has(route))
      .sort(),
    absent: [...observed].filter((route) => isAbsent(route)).sort(),
    gatedOut,
    unexercised: [...IMPLEMENTED].filter((route) => !observed.has(route)).sort()
  };
};
