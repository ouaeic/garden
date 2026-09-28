/**
 * Plan usage for the two subscription providers, read straight off each provider's own account
 * endpoint.
 *
 * The composer's status strip shows CPU, RAM and disk beside what the owner's plan has left; the
 * two subscription providers publish that from different routes with different shapes, and the
 * worker has no credential, so this is read server-side, once per bootstrap, and shaped into one
 * small record the strip can render for either provider.
 *
 * Every field is nullable rather than defaulted: an endpoint that will not say is a fact about the
 * provider, and a made-up zero reads as headroom the owner does not have.
 */

import { z } from 'zod';
import { GardenError } from '@garden/core';

/** What a provider's own account endpoint said about the plan. */
export const PlanUsage = z.object({
  provider: z.enum(['ollama-cloud', 'openrouter']),
  /**
   * Utilisation in the provider's own unit - a fraction for Ollama Cloud's session and weekly
   * windows, dollars for OpenRouter - with the period the number covers.
   */
  windows: z.array(
    z.object({
      label: z.string(),
      used: z.number().nullable(),
      limit: z.number().nullable(),
      /*
       * Which unit `used` and `limit` are in, stated rather than guessed.
       *
       * The strip used to infer it from `limit === 1`, which is true of Ollama Cloud's fractions
       * and of nothing else - so OpenRouter's dollars were rendered as a percentage of a plan and
       * $12.34 of spend read as "1234%". The two providers do not measure the same thing and the
       * record has to say which one it carries.
       */
      unit: z.enum(['fraction', 'usd']),
      resetsAt: z.string().nullable()
    })
  ),
  queriedAt: z.string()
});
export type PlanUsage = z.infer<typeof PlanUsage>;

const PlanUsageResponse = z.object({
  activity: z
    .object({ period: z.object({ ending_at: z.string() }).partial().optional() })
    .optional(),
  limits: z
    .object({
      session: z.object({ usage: z.number() }).partial().optional(),
      weekly: z.object({ usage: z.number() }).partial().optional()
    })
    .optional()
});

/**
 * `/api/v1/credits` and `/api/v1/key` are different routes with different field names, and this
 * asked the first for the second's.
 *
 * `/credits` publishes `total_credits` and `total_usage`; `usage` and `limit` are `/key`'s. Both
 * were declared optional, so the parse succeeded against every response and produced two nulls -
 * which the strip renders as a dash. The balance has therefore never been shown to anybody using
 * OpenRouter, and nothing failed loudly enough to say so.
 */
const OpenRouterCredits = z.object({
  data: z
    .object({
      total_credits: z.number().nullable().optional(),
      total_usage: z.number().nullable().optional()
    })
    .optional()
});

/** `/api/v1/key`: what this key in particular may still spend, which the account balance cannot say. */
const OpenRouterKey = z.object({
  data: z
    .object({
      limit: z.number().nullable().optional(),
      limit_remaining: z.number().nullable().optional(),
      usage: z.number().nullable().optional()
    })
    .optional()
});

const checkedBody = async (response: Response, who: string): Promise<unknown> => {
  if (!response.ok)
    throw new GardenError(
      'provider_unavailable',
      `${who} returned ${response.status}`,
      response.status === 401 || response.status === 403 ? 409 : 502
    );
  return response.json();
};

/**
 * Ollama Cloud's `/api/usage`: a session window and a weekly window, each carrying utilisation as
 * a fraction of the plan's allowance. No reset date is published; the period object names when the
 * rolling windows began, which is the closest honest answer.
 */
const ollamaCloudUsage = async (
  apiKey: string | undefined,
  fetchImpl: typeof fetch
): Promise<PlanUsage> => {
  const body = PlanUsageResponse.parse(
    await checkedBody(
      await fetchImpl('https://ollama.com/api/usage', {
        headers: { authorization: `Bearer ${apiKey ?? ''}` },
        signal: AbortSignal.timeout(10_000)
      }),
      'Ollama Cloud usage'
    )
  );
  const resetsAt = body.activity?.period?.ending_at ?? null;
  return {
    provider: 'ollama-cloud',
    windows: (
      [
        ['Session window', body.limits?.session?.usage ?? null],
        ['Weekly window', body.limits?.weekly?.usage ?? null]
      ] as const
    ).map(([label, used]) => ({ label, used, limit: 1, unit: 'fraction' as const, resetsAt })),
    queriedAt: new Date().toISOString()
  };
};

/**
 * What an OpenRouter account has left, and what this key in particular may still spend.
 *
 * Two routes because they answer two questions the owner asked separately. `/credits` is the
 * account: credits bought against credits used, so the balance is the difference. `/key` is the
 * credential: a key may carry a spend limit of its own, well under the balance, and a run stops on
 * whichever binds first - so a strip that showed only the balance would say there was money when
 * the key was the thing that had run out.
 *
 * The key half is optional in the result rather than required in the request: a key with no limit
 * set reports null, and "no limit on this key" is not a window worth a slot on a strip that sits
 * beside CPU and RAM. The balance is reported even when `/key` fails, because one route being
 * down is not a reason to show nothing.
 */
const openRouterUsage = async (
  apiKey: string | undefined,
  fetchImpl: typeof fetch
): Promise<PlanUsage> => {
  const authorization = { authorization: `Bearer ${apiKey ?? ''}` };
  const credits = OpenRouterCredits.parse(
    await checkedBody(
      await fetchImpl('https://openrouter.ai/api/v1/credits', {
        headers: authorization,
        signal: AbortSignal.timeout(10_000)
      }),
      'OpenRouter credits'
    )
  );
  const key = await fetchImpl('https://openrouter.ai/api/v1/key', {
    headers: authorization,
    signal: AbortSignal.timeout(10_000)
  })
    .then(async (response) =>
      response.ok ? OpenRouterKey.parse(await response.json()) : { data: undefined }
    )
    .catch(() => ({ data: undefined }) as z.infer<typeof OpenRouterKey>);
  const bought = credits.data?.total_credits ?? null;
  const spent = credits.data?.total_usage ?? null;
  const keyLimit = key.data?.limit ?? null;
  return {
    provider: 'openrouter',
    windows: [
      {
        label: 'Credit balance',
        used: spent,
        limit: bought,
        unit: 'usd' as const,
        resetsAt: null
      },
      ...(keyLimit === null
        ? []
        : [
            {
              label: 'Key limit',
              // `usage` on `/key` is this key's own all-time spend, which is what its limit is
              // measured against - not the account's, which is what `/credits` reports.
              used: key.data?.usage ?? null,
              limit: keyLimit,
              unit: 'usd' as const,
              resetsAt: null
            }
          ])
    ],
    queriedAt: new Date().toISOString()
  };
};

/**
 * What the connected provider's own account endpoint says about the plan, or null when this
 * provider publishes no such number. A failure is reported as unavailable rather than thrown:
 * the status strip renders beside every screen, and a provider outage would otherwise take the
 * whole first paint with it.
 */
export const planUsageFor = async (
  provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible',
  apiKey: string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<PlanUsage | null> => {
  try {
    if (provider === 'ollama-cloud') return await ollamaCloudUsage(apiKey, fetchImpl);
    if (provider === 'openrouter') return await openRouterUsage(apiKey, fetchImpl);
    return null;
  } catch {
    return null;
  }
};
