/**
 * What the catalogue actually weighs on the box this shim describes - measured, not argued.
 *
 * THE COUNTER-ARGUMENT THIS FILE ANSWERS WITH A NUMBER. garden is not a benchmark scaffold. It
 * ships a tool catalogue where a purpose-built coding scaffold ships one tool or none, and the
 * charge is that it pays a tax per model call for connectors, media, desktop and memory that a
 * coding task will never touch. The research put that tax at 12,508 tokens per call and 39.9% of
 * every prompt token `evals/baseline.json` bills, which is a real measurement of the WRONG BOX:
 * `evals/harness.ts` answers `/surfaces` with both surfaces available, and
 * `apps/worker/src/turn/claim.ts:212` withdraws `connector_action` outright on a box with no
 * connections. A Terminal-Bench container has no browser, no screen and no connections.
 *
 * So the honest charge is measured here, through the production function, against the four boxes
 * that matter. It is a real charge either way - the residue is still tens of kilobytes against a
 * bare-bones harness's zero - and it does not need the overstatement.
 *
 * ZERO COST. `agentToolsFor` is a pure function; nothing here calls a provider.
 */
import { COMPACT_CONTEXT_TOOL } from '../../apps/worker/src/context.js';
// The production function, not a copy of it: a second spelling of the catalogue would measure
// itself. @see apps/worker/src/tool-catalogue.test.ts:89, which weighs the wire the same way.
import { agentToolsFor } from '../../apps/worker/src/tool-catalogue.js';
import type { ConnectorKind } from '../../packages/contracts/src/index.js';

/** The wire form, byte for byte the way `tool-catalogue.test.ts:89-90` measures it. */
const bytesOf = (
  surfaces: 'available' | 'absent',
  connectors: readonly ConnectorKind[]
): number => {
  const tools = [
    ...agentToolsFor('lead', { browser: surfaces, desktop: surfaces }, connectors),
    COMPACT_CONTEXT_TOOL
  ]
    // The one withdrawal that is not `agentToolsFor`'s to make. `claim.ts:212` removes
    // `connector_action` entirely from a box with nothing connected, and leaving it in would make
    // the bare figure 6.6 kB too heavy - which is most of the gap the counter-argument turns on.
    .filter((tool) => connectors.length > 0 || tool.name !== 'connector_action');
  return Buffer.byteLength(JSON.stringify(tools), 'utf8');
};

export interface CatalogueWeight {
  readonly box: string;
  readonly bytes: number;
  /** Tokens at this repository's own measured bytes-per-token; see BYTES_PER_TOKEN. */
  readonly approxTokens: number;
}

/**
 * Bytes per catalogue token: the rule the eval suite itself bills by, and nothing more precise.
 *
 * This used to be `55_673 / 12_508 = 4.451`, described as "taken from this repository's own wire".
 * Re-derived on 2026-09-03 it was a ratio between two numbers that measure different things on
 * different boxes, and the token half was not even the right figure:
 *
 *   - `evals/baseline.json` bills catalogue tokens as `Math.ceil(bytes / 4)` over
 *     `JSON.stringify(body.tools)` of each request (`evals/harness.ts`, `wireCatalogueTokens`). It
 *     is bytes over four by construction. Its maximum per call is 12,462 - `catalogueTokens /
 *     modelCalls` over every row; 62 of the 73 rows sit exactly at it, every fixture whose calls
 *     all carry the catalogue - not 12,508, which no row carries.
 *   - That wire is the suite's OWN box, `/surfaces` both available and `listConnectors` empty, on
 *     which the harness reports the catalogue resident at 49,830 bytes when the baseline was
 *     accepted (49,903 on this checkout): the second row of the table below, not the first. The
 *     55,673 (55,363 on this checkout, measured through `pnpm eval:bench`) is the fully
 *     provisioned box, which the suite never sends.
 *
 * So the quotient was a provisioned byte count over a different box's bytes-over-four, and every
 * token figure printed from it was 11% under the rule the baseline actually uses. Four is that
 * rule, so the tokens this file prints and the tokens `baseline.json` bills now agree on the box
 * they share: 49,830 / 4 = 12,458 for the suite's wire as the baseline was accepted, against its
 * committed 12,462 (the ceil is taken per call, and the resident size differs by a few bytes
 * between fixtures); a tool description that moves the catalogue moves both together.
 *
 * It is still an approximation. The exact number depends on the tokeniser the route uses, which is
 * a property of the provider and not of this repository. What would change it: a live row now
 * carries the provider's own input count per call (`RunOutcome.providerInputTokens`), so a paid run
 * can put a measured ratio here - for the WHOLE prompt, though, not the catalogue alone, which no
 * provider counts separately.
 */
export const BYTES_PER_TOKEN = 4;

/** The four boxes, in the order that makes the argument. */
export const catalogueWeights = (): CatalogueWeight[] => {
  const rows: Array<[string, 'available' | 'absent', ConnectorKind[]]> = [
    // The five kinds a connection can be, in the enum's own spelling. `agentToolsFor`'s third
    // argument narrows `connector_action`'s action list to what the connected kinds can accept,
    // so an empty array here is not "no connectors" - it is "unknown", which describes all
    // twenty-four actions. A box with nothing connected is the last row, where `claim.ts:212`
    // takes the whole tool away.
    [
      'fully provisioned, all five connector kinds',
      'available',
      ['github', 'webdav', 'mcp_http', 'imap', 'caldav'] as ConnectorKind[]
    ],
    ['a browser and a screen, nothing connected (what the eval suite measures)', 'available', []],
    ['no browser, no screen, one connection', 'absent', ['github'] as ConnectorKind[]],
    ['no browser, no screen, nothing connected (THE BENCHMARK BOX)', 'absent', []]
  ];
  return rows.map(([box, surfaces, connectors]) => {
    const bytes = bytesOf(surfaces, connectors);
    return { box, bytes, approxTokens: Math.round(bytes / BYTES_PER_TOKEN) };
  });
};

/** The benchmark box's own figure, which is what a parity row's `catalogue_bytes` column carries. */
export const benchmarkBoxCatalogueBytes = (): number => bytesOf('absent', []);

/**
 * The tools a box with neither surface loses, DERIVED rather than listed.
 *
 * `BROWSER_SURFACE_TOOLS` and `DESKTOP_SURFACE_TOOLS` are file-local sets in
 * `apps/worker/src/tool-catalogue.ts` and nothing exports them, so a rig that wanted the seven
 * names had two choices: copy them, or take the difference the production function itself makes.
 * Copying is how a list rots - a tool added to either set would leave the copy quietly short, and
 * the check below would go on passing while describing six of seven.
 *
 * `score.ts` uses this to ask a live run whether the gate actually held, which is the one thing
 * `routes.ts` says out loud it had never observed: it read the gate's own test and the single line
 * that applies it, and never watched a turn under `absent, absent` and found the tools gone.
 */
export const surfaceGatedToolNames = (): string[] => {
  const withSurfaces = new Set(
    agentToolsFor('lead', { browser: 'available', desktop: 'available' }, []).map(
      (tool) => tool.name
    )
  );
  for (const tool of agentToolsFor('lead', { browser: 'absent', desktop: 'absent' }, []))
    withSurfaces.delete(tool.name);
  return [...withSurfaces].sort();
};
