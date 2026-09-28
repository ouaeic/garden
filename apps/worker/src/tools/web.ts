import { browserActionRequestId } from '../browser-action-receipts.js';
import { type ParallelWebReadResult } from '@garden/contracts';
import { type ModelToolCall } from '@garden/model-gateway';
import { textValue } from '../values.js';
import { perPartOutputChars } from '../context.js';
import { surfaceActionRequest } from '../tools.js';
import { type ToolContext } from '../tool-dispatch.js';
import { clampNumber } from './numbers.js';
import { SECURITY_MODE_FLOOR } from '../approval-common.js';

/**
 * The surface tools: the browser and the desktop, the two things on this computer that are looked at
 * rather than read.
 *
 * The desktop arms are here rather than with the workspace tools because they share what makes this
 * group a group: a read half and a control half, the control half escalating to a second capability
 * scope when the owner has approved the consequential form of the call, and both halves speaking
 * through `surfaceActionRequest`. `web_search` is the one arm in the table with two answerers, and
 * which one it gets is the run's pinned route rather than anything about the call.
 */
export async function executeSurfaceTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, consequentialApproved, webPlan, state } = context;
  // Authority comes from the persisted owner choice or an approved call, never model arguments.
  const surfaceAuthorized =
    consequentialApproved || SECURITY_MODE_FLOOR[task.securityMode].authorizesSurfaceActions;
  const root = `/v1/workspaces/${task.workspaceId}`;
  switch (call.name) {
    case 'browser_snapshot':
      return context.runner.call(
        task.workspaceId,
        task.id,
        'browser.read',
        `${root}/browser/snapshot`,
        {
          ...(typeof call.arguments.offset === 'number' ? { offset: call.arguments.offset } : {}),
          ...(textValue(call.arguments.sha256) ? { sha256: textValue(call.arguments.sha256) } : {})
        }
      );
    case 'read_elements':
      return context.runner.call(
        task.workspaceId,
        task.id,
        'browser.read',
        `${root}/browser/elements`,
        {
          ...(textValue(call.arguments.selector)
            ? { selector: textValue(call.arguments.selector) }
            : {}),
          ...(textValue(call.arguments.tabId) ? { tabId: textValue(call.arguments.tabId) } : {})
        }
      );
    case 'print_pdf':
      return context.runner.call(
        task.workspaceId,
        task.id,
        ['browser.read', 'files.write'],
        `${root}/browser/print-pdf`,
        {
          path: textValue(call.arguments.path),
          format: textValue(call.arguments.format, 'A4'),
          landscape: call.arguments.landscape === true,
          printBackground: call.arguments.printBackground !== false,
          ...(textValue(call.arguments.tabId) ? { tabId: textValue(call.arguments.tabId) } : {})
        }
      );
    // One vetted route, on the runner side of the same boundary every other web read crosses. It
    // is scoped `browser.read` for exactly that reason: a search is a read of a public page whose
    // address the agent did not choose, which is the trust class parallel_web_read already has.
    //
    // Which side of that boundary the query goes out from is the run's pinned route and not this
    // call's decision - the owner was told once, for the whole run, where their queries go. Both
    // answers come back in one shape, so everything downstream of here - the taint floor, the
    // origins the turn has been to, the row the timeline draws - reads a search the same way
    // whoever ran it.
    case 'web_search':
      if (webPlan.mode === 'server') return context.providerWebSearch(task, call, webPlan, state);
      return context.runner.call(
        task.workspaceId,
        task.id,
        'browser.read',
        `${root}/browser/search`,
        {
          query: textValue(call.arguments.query),
          // The third of the three clamps that already defended against `NaN`, by way of a `||`
          // that also swallowed a deliberate zero and answered it with ten. A zero is a number the
          // model meant, so it now lands on the floor of one like every other out-of-range value,
          // and only an unreadable or absent limit gets the default.
          limit: clampNumber(call.arguments.limit, { min: 1, max: 10, fallback: 10, integer: true })
        }
      );
    case 'parallel_web_read': {
      const urls = Array.isArray(call.arguments.urls)
        ? call.arguments.urls.map(String).slice(0, 12)
        : [];
      const asked = clampNumber(call.arguments.maxCharactersPerPage, {
        min: 1_000,
        max: 20_000,
        fallback: 12_000
      });
      // Never more than this page's share of the window it has to arrive through: twelve pages
      // at the full allowance is 214,670 characters against a 24,000-character result cut from
      // the middle, and what came back was page one and nothing else - not even the other eleven
      // URLs. A single-URL read is unaffected, because one page's share is larger than the most
      // it may ask for.
      const perPage = Math.min(asked, perPartOutputChars(urls.length));
      const read = await context.runner.call<ParallelWebReadResult>(
        task.workspaceId,
        task.id,
        'browser.read',
        `${root}/browser/read-many`,
        { urls, maxCharactersPerPage: perPage }
      );
      // A page is cut without a mark, so a shortened one reads as a page that simply did not
      // mention the thing - and a model reasons from what a source does not say. Saying what
      // each page was allowed, in the result rather than in the prompt, costs nothing that is
      // cached and turns an invisible cut into one more read.
      return perPage < asked
        ? {
            ...read,
            charactersPerPage: perPage,
            note: `Each page was read to ${perPage.toLocaleString()} characters so that all ${urls.length} fit one result. Read a URL on its own for more of it.`
          }
        : read;
    }
    case 'browser_action': {
      const request = surfaceActionRequest(call.arguments);
      // A screenshot writes a workspace file, so it carries the write scope a printed PDF carries;
      // the runner refuses the write without it, whether the step is on its own or in a batch.
      const writes =
        request.type === 'screenshot' ||
        (Array.isArray(request.actions) &&
          request.actions.some(
            (step) => (step as { type?: unknown } | null)?.type === 'screenshot'
          ));
      return context.runner.call(
        task.workspaceId,
        task.id,
        [
          'browser.control',
          ...(surfaceAuthorized ? ['browser.consequential'] : []),
          ...(writes ? ['files.write'] : [])
        ],
        `${root}/browser/action`,
        { ...request, requestId: browserActionRequestId(task.id, state, call.id) }
      );
    }
    case 'desktop_observe':
      return context.runner.call(
        task.workspaceId,
        task.id,
        'desktop.read',
        `${root}/desktop/snapshot`,
        {}
      );
    case 'desktop_launch':
      return context.runner.call(
        task.workspaceId,
        task.id,
        'desktop.control',
        `${root}/desktop/launch`,
        call.arguments
      );
    case 'desktop_action':
      return context.runner.call(
        task.workspaceId,
        task.id,
        surfaceAuthorized ? ['desktop.control', 'desktop.consequential'] : 'desktop.control',
        `${root}/desktop/action`,
        surfaceActionRequest(call.arguments)
      );
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
