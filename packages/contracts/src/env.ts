import { z } from 'zod';

/**
 * The settings more than one garden process reads, declared once.
 *
 * The API, the worker, the media orchestrator and the notifier are separate units on a packaged
 * install, and systemd starts all four from the same /etc/garden/control.env. A key declared
 * twice is therefore a key two units can disagree about: TASK_MAX_STEPS was bounded at 200 in the
 * API and 400 in the worker, so an operator who raised it to 300 got a worker that accepted the
 * number and an API that refused to start, with nothing in either message to say the other half
 * had a different opinion. The same file, read two ways, is the whole failure.
 *
 * Only genuinely shared keys belong here. A process keeps the settings only it reads - the API's
 * listener and WebAuthn boundary, the runner's executable paths, the notifier's signing keys -
 * because a declaration nobody else consults is not a contract, it is just configuration.
 *
 * packages/contracts/src/env.test.ts is what keeps this true: it reads each unit's config schema -
 * `src/config.ts`, or an inline schema in `src/index.ts` for a unit that has no config module -
 * finds each key declared in more than one of them, and fails if a declaration has drifted from
 * the one below. It read only `src/config.ts` until services/model-registry turned out to be
 * declaring eight of these keys inline, three of them differently.
 */
export const sharedEnv = {
  /**
   * Where the data lives. `pglite` is an embedded database inside the process, which is what a
   * checkout gets with no PostgreSQL to install; a packaged install writes `postgres` and a real
   * connection string.
   */
  DATABASE_DRIVER: z.enum(['pglite', 'postgres']).default('pglite'),
  DATABASE_URL: z.string().default('postgres://garden:garden@localhost:5432/garden'),
  PGLITE_PATH: z.string().default('.garden/postgres'),
  /**
   * The key every workspace key is wrapped under. Optional here and required by each process at
   * load, so the failure is one sentence naming the key rather than a schema dump.
   */
  DATA_MASTER_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional()
  ),
  /** Authenticates every call between an garden process and the workspace runner. */
  RUNNER_SHARED_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).optional()
  ),
  WORKSPACE_RUNNER_URL: z.string().url().default('http://127.0.0.1:4300'),
  PREVIEW_BASE_URL: z.string().url().default('http://preview.localhost:4400'),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(20).optional()
  ),
  AI_PROVIDER: z.enum(['openrouter', 'openai-compatible']).default('openrouter'),
  AI_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  AI_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional()
  ),
  AI_DEFAULT_MODEL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).max(300).optional()
  ),
  AI_REQUIRE_ZDR: z
    .string()
    .default('true')
    .transform((value) => value === 'true'),
  /** Whether a turn opens with the harness's own reads of what the request names. */
  OPENING_READS: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /**
   * Takes provider-side web search and fetch off this box for every task, whatever route a
   * conversation was started on.
   *
   * Separate from AI_REQUIRE_ZDR because it answers a different question. Zero retention is about
   * what the provider keeps of an inference request; this is about whether a search query is sent
   * to a search service at all. An operator who is content for inference to be retained may still
   * not want the questions they ask leaving the machine, and the provider's own zero-retention
   * enforcement explicitly does not cover tools, so one setting could not honestly stand for both.
   */
  AI_FORCE_INHOUSE_WEB: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Which models this box will offer at all.
   *
   * `provider_catalog` offers every chat model the owner's provider account can reach, so models
   * released after this build appear without an garden update. `reviewed_open_weight` restricts
   * selection to models carrying a current independent weight-licence review and fails closed when
   * one lapses.
   *
   * Shared because two units read it out of the same control.env and both write the catalogue with
   * it: apps/api on a provider key being saved and on the repair pass behind it, and
   * services/model-registry on every hourly refresh. A box where the two disagree has each of them
   * undoing the other's answer about which models exist.
   */
  MODEL_CATALOG_SCOPE: z
    .enum(['provider_catalog', 'reviewed_open_weight'])
    .default('provider_catalog'),
  ALLOW_INSECURE_PROVIDER_URLS: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * A deployment restriction on which hosts a connector may reach at all. Empty is the default and
   * means the owner's own choice stands.
   */
  CONNECTOR_ALLOWED_HOST_SUFFIXES: z.string().default(''),
  /**
   * How many tasks one worker runs at once.
   *
   * Almost all of a step is spent waiting on the model provider or the workspace runner, so a
   * second slot costs little and stops one long build or one stalled provider from holding the
   * whole queue. It stays deliberately low because each in-flight task also holds a full context
   * window in memory on a machine that is running everything else too.
   */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /**
   * The floor under an idle worker's re-check. Pickup itself is signalled by the write, so this
   * only bounds how long a task that became leasable without one - an expired lease - waits.
   */
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  /**
   * How many model calls one turn may spend before the harness takes the last word.
   *
   * Sixty was chosen when a turn was a conversation. It is not what a real job costs: a job
   * application is a posting capture, a dossier read, two tailored documents, a render proof and
   * twenty-five form fields read back one at a time. Both that and a sourced report cleared sixty
   * on the first honest measurement, and the ceiling was a crash rather than a stop, so the owner
   * paid for the whole trajectory and got a red error mid-form. A turn is bounded by the compute
   * budget and the spend caps as well, both of which are the owner's own numbers - this one is a
   * runaway guard, and it was set tight enough to cut off ordinary work instead.
   */
  TASK_MAX_STEPS: z.coerce.number().int().min(1).max(400).default(120),
  /** Automatic continuation never increases the owner's spending or compute allowance. */
  TASK_MAX_SELF_CONTINUATIONS: z.coerce.number().int().min(0).max(500).default(60),
  /**
   * Where this box's own API listens. The API binds it; the notifier posts an answer the owner
   * types on the phone to the same task-message route the web client and the command line use, so
   * the conversation is unparked by that route's checks and idempotency rather than by a second
   * copy of them. One declaration, because two units reading one control.env must agree on where
   * the API is.
   */
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(4100),
  /**
   * Where the phone transport's bot API answers. It has exactly one real value; the setting exists
   * so a test can point the sender, the inbound poller and the API's own token check at a stub on
   * loopback instead of at the internet. An operator has no reason to change it, which is why it is
   * optional and absent means the real address: a test that builds a config record by hand should
   * not have to name it.
   */
  TELEGRAM_API_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional()
  )
};
