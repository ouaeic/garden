import { z } from 'zod';
import { DATA_MASTER_KEY_REQUIRED } from '@garden/core';

const Config = z.object({
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  DATABASE_DRIVER: z.enum(['pglite', 'postgres']).default('pglite'),
  DATABASE_URL: z.string().default('postgres://garden:garden@localhost:5432/garden'),
  PGLITE_PATH: z.string().default('.garden/postgres'),
  DATA_MASTER_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional()
  ),
  RUNNER_SHARED_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).optional()
  ),
  WORKSPACE_RUNNER_URL: z.string().url().default('http://127.0.0.1:4300'),
  PREVIEW_BASE_URL: z.string().url().default('http://preview.localhost:4400'),
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
  /**
   * Takes provider-side web search and fetch off this box for every task, whatever route a
   * conversation was started on. Read here as well as in the API because the worker is what puts
   * the tools on the wire: the settings page states the verdict, this decides it.
   */
  AI_FORCE_INHOUSE_WEB: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  ALLOW_INSECURE_PROVIDER_URLS: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
  CONNECTOR_ALLOWED_HOST_SUFFIXES: z.string().default(''),
  WORKER_HEALTH_HOST: z.string().default('127.0.0.1'),
  /**
   * How many tasks this worker runs at once.
   *
   * Almost all of a step is spent waiting on the model provider or the workspace runner, so a
   * second slot costs little and stops one long build or one stalled provider from holding the
   * whole queue - scheduled runs and the conversation the owner is having right now compete for
   * the same worker. It stays deliberately low because each in-flight task also holds a full
   * context window in memory on a machine that is running everything else too.
   */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4201),
  /**
   * How many model calls one turn may spend before the harness takes the last word.
   *
   * Sixty was chosen when a turn was a conversation. It is not what a real job costs: a job
   * application is a posting capture, a dossier read, two tailored documents, a render proof and
   * twenty-five form fields read back one at a time; a sourced report is a search, a dozen source
   * reads and a written draft. Both cleared sixty on the first honest measurement, and the ceiling
   * was a crash rather than a stop, so the owner paid for the whole trajectory and got a red error
   * mid-form. A turn is bounded by the compute budget and the spend caps as well, both of which are
   * the owner's own numbers - this one is a runaway guard, and it was set tight enough to cut off
   * ordinary work instead.
   */
  TASK_MAX_STEPS: z.coerce.number().int().min(1).max(400).default(120),
  /** Automatic continuation never increases the owner's spending or compute allowance. */
  TASK_MAX_SELF_CONTINUATIONS: z.coerce.number().int().min(0).max(500).default(60)
});

export type WorkerConfig = z.infer<typeof Config>;
export const loadConfig = (): WorkerConfig => {
  const config = Config.parse(process.env);
  if (!config.DATA_MASTER_KEY) throw new Error(DATA_MASTER_KEY_REQUIRED);
  if (!config.RUNNER_SHARED_SECRET) throw new Error('RUNNER_SHARED_SECRET is required');
  const provider = new URL(config.AI_BASE_URL);
  const privateHttp =
    provider.protocol === 'http:' &&
    (provider.hostname === 'localhost' ||
      provider.hostname === '127.0.0.1' ||
      provider.hostname === '::1' ||
      /^10\./.test(provider.hostname) ||
      /^192\.168\./.test(provider.hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(provider.hostname));
  if (provider.protocol !== 'https:' && !(config.ALLOW_INSECURE_PROVIDER_URLS && privateHttp)) {
    throw new Error(
      'AI_BASE_URL must use HTTPS unless ALLOW_INSECURE_PROVIDER_URLS=true for a private address'
    );
  }
  return config;
};
