import { z } from 'zod';
import { DATA_MASTER_KEY_REQUIRED } from '@athanor/core';
import { sharedEnv } from '@athanor/contracts/env';

const bool = z
  .string()
  .default('false')
  .transform((value) => value === 'true');

/**
 * Everything this process reads out of its environment.
 *
 * Keys the API is the only reader of are declared here. Keys another unit reads from the same
 * control.env come from `sharedEnv`, so the two halves cannot hold different beliefs about what is
 * allowed - see packages/contracts/src/env.ts for why that stopped being theoretical.
 */
const Config = z.object({
  /**
   * Two values, because two behaviours exist: `development` turns on the insecure local sign-in
   * and stands the production checks down, and `production` is everything else. A third value
   * `selfhost` used to sit between them and was byte-for-byte identical to `production` - which is
   * the kind of setting an operator eventually assumes means something. The installer has only
   * ever written `production`.
   */
  DEPLOYMENT_MODE: z.enum(['development', 'production']).default('development'),
  REGISTRATION_BOOTSTRAP_TOKEN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(20).max(200).optional()
  ),
  REGISTRATION_BOOTSTRAP_EXPIRES_AT: z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.coerce.number().int().positive().optional()
  ),
  PUBLIC_APP_URL: sharedEnv.PUBLIC_APP_URL,
  PUBLIC_SOURCE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional()
  ),
  PUBLIC_PRIVACY_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional()
  ),
  PREVIEW_BASE_URL: sharedEnv.PREVIEW_BASE_URL,
  API_HOST: sharedEnv.API_HOST,
  API_PORT: sharedEnv.API_PORT,
  PREVIEW_GATEWAY_HOST: z.string().default('127.0.0.1'),
  PREVIEW_GATEWAY_PORT: z.coerce.number().int().positive().default(4400),
  /**
   * Loopback ports belonging to athanor's own services that this process has no other way to learn
   * - the worker, media and notification health endpoints. A preview publishes a loopback port to
   * the internet, so anything on this list, plus the API, gateway, runner and database ports read
   * from the settings above, is refused as a preview target.
   *
   * The workspace runner reads this same name out of its own environment file for the same purpose,
   * and each process adds the ports it can already derive. One spelling across both processes and
   * the installer: the two carried transposed names for a while, which is a trap for whoever next
   * moves a port.
   */
  RESERVED_PREVIEW_PORTS: z.string().default('443,8443,4201,4203'),
  DATABASE_DRIVER: sharedEnv.DATABASE_DRIVER,
  DATABASE_URL: sharedEnv.DATABASE_URL,
  PGLITE_PATH: sharedEnv.PGLITE_PATH,
  DATA_MASTER_KEY: sharedEnv.DATA_MASTER_KEY,
  SESSION_SIGNING_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).optional()
  ),
  RUNNER_SHARED_SECRET: sharedEnv.RUNNER_SHARED_SECRET,
  WORKSPACE_RUNNER_URL: sharedEnv.WORKSPACE_RUNNER_URL,
  PUBLIC_RUNNER_URL: z.string().url().default('ws://127.0.0.1:4300'),
  WORKSPACE_IMAGE_REVISION: z.string().default('dev'),
  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_RP_NAME: z.string().default('athanor'),
  WEBAUTHN_ORIGIN: z.string().url().default('http://localhost:5173'),
  ALLOW_INSECURE_DEV_AUTH: bool,
  WORKER_ID: z.string().default(`embedded-worker-${process.pid}`),
  /**
   * Whether the agent runs inside this process. On by default for the embedded database, which is
   * the shape with no separate worker unit to run it; the packaged install runs PostgreSQL and its
   * own worker, so it never reaches this. Explicit because "is anything executing tasks here" is
   * otherwise inferred from the database driver, which is not what it says.
   */
  EMBEDDED_WORKER: z.coerce.boolean().optional(),
  WORKER_CONCURRENCY: sharedEnv.WORKER_CONCURRENCY,
  WORKER_POLL_MS: sharedEnv.WORKER_POLL_MS,
  SCHEDULER_POLL_MS: z.coerce.number().int().min(1000).default(15_000),
  TASK_MAX_STEPS: sharedEnv.TASK_MAX_STEPS,
  // Read here only because the embedded worker is built from this parse of control.env. Without it
  // the development shape ran a worker that could not be configured at all, and the packaged one
  // could - on the same file, from the same key.
  TASK_MAX_SELF_CONTINUATIONS: sharedEnv.TASK_MAX_SELF_CONTINUATIONS,
  SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /**
   * `info` is what an owner reading `athanor logs` wants: lifecycle, scheduled work, and every
   * handled failure with its code. `debug` adds a line per request, which is useful while
   * diagnosing and far too much to leave on. No level ever prints content.
   */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  OPENROUTER_BASE_URL: sharedEnv.OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY: sharedEnv.OPENROUTER_API_KEY,
  AI_PROVIDER: sharedEnv.AI_PROVIDER,
  AI_BASE_URL: sharedEnv.AI_BASE_URL,
  AI_API_KEY: sharedEnv.AI_API_KEY,
  AI_DEFAULT_MODEL: sharedEnv.AI_DEFAULT_MODEL,
  AI_REQUIRE_ZDR: sharedEnv.AI_REQUIRE_ZDR,
  AI_FORCE_INHOUSE_WEB: sharedEnv.AI_FORCE_INHOUSE_WEB,
  /** Read by services/model-registry from the same file, so the declaration is shared. */
  MODEL_CATALOG_SCOPE: sharedEnv.MODEL_CATALOG_SCOPE,
  /**
   * The non-secret connection manifest the network watcher maintains. Device enrollment reuses it
   * so a new device receives the same endpoint set and pinned identity the installer would print.
   */
  CONNECTION_MANIFEST_PATH: z.string().default('/var/lib/athanor/connection.json'),
  /**
   * Where the box writes down what went wrong with the parts of itself the API does not run.
   *
   * The certificate helper and the dynamic DNS helper both record a failure here, world-readable,
   * and until now nothing read them: renewal begins about thirty days before expiry, so a failing
   * certificate had a month in which the app was perfectly reachable and said nothing, and the
   * first the owner heard of it was every device refusing to connect at once.
   */
  ATHANOR_STATE_PATH: z.string().default('/var/lib/athanor'),
  /**
   * Durable home for the relay identity key and the relay settings. The key is this box's address
   * on every relay it has enrolled with, so it must outlive an update and a rebuild of the source
   * tree; the installer creates this directory owned by the control account and readable by nobody
   * else. Nothing is written here until an owner enrolls with a relay.
   */
  RELAY_STATE_DIR: z.string().default('.athanor/relay'),
  /**
   * Where a relayed connection is delivered on this box. TLS terminates here, not at the relay,
   * which is why the relay can only ever see byte counts and connection metadata.
   */
  RELAY_LOCAL_HOST: z.string().default('127.0.0.1'),
  RELAY_LOCAL_PORT: z.coerce.number().int().positive().max(65_535).default(443),
  /** The plaintext listener, where the relay's own :80 goes: ACME challenges and the redirect. */
  RELAY_LOCAL_HTTP_PORT: z.coerce.number().int().positive().max(65_535).default(80),
  RELAY_LOCAL_PREVIEW_PORT: z.coerce.number().int().positive().max(65_535).default(8443),
  ALLOW_INSECURE_PROVIDER_URLS: sharedEnv.ALLOW_INSECURE_PROVIDER_URLS,
  CONNECTOR_ALLOWED_HOST_SUFFIXES: sharedEnv.CONNECTOR_ALLOWED_HOST_SUFFIXES,
  PUSH_VAPID_PUBLIC_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(80).max(100).optional()
  ),
  PUSH_ENDPOINT_HOST_SUFFIXES: z
    .string()
    .default(
      'fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com,.notify.windows.com'
    ),
  /**
   * Where the phone transport's bot API answers, for the two calls this process makes to it: the
   * token check when a bot is added in Settings, and the test message. Shared with the notifier,
   * which points its sender and poller at the same address, so a test can put both on one stub.
   */
  TELEGRAM_API_BASE_URL: sharedEnv.TELEGRAM_API_BASE_URL,
  /**
   * The server-wide switch on share links. Off, every public share route answers the same 404 an
   * unknown link gets - existing links included, which come back when it is turned on again - and
   * the owner's own routes refuse to mint one. On when absent, because a single-owner box sharing
   * its owner's own conversations on the owner's say-so is the shipped shape; `false` is the one
   * spelling that turns it off. Declared as optional-with-transform rather than through `bool`
   * because that helper defaults to off, and a test that builds this record by hand should not
   * have to name a setting to get the shipped behaviour. An empty value is absent, not off: a
   * templated control.env that lists the key with nothing after it must not close every link.
   */
  SHARING_ENABLED: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .transform((value) => value === 'true')
      .optional()
  ),
  /**
   * Where the built share viewer lives - its script and stylesheet, which the API serves under
   * `/v1/shares/assets/` because that is the one path prefix the installed app's service worker
   * hands to the network instead of answering with the app shell. Defaults to the web build's own
   * output beside this package; set it when the two are deployed apart.
   */
  SHARE_VIEWER_DIR: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional()
  )
});

export type ApiConfig = z.infer<typeof Config>;
export const loadConfig = (): ApiConfig => {
  const config = Config.parse(process.env);
  if (!config.DATA_MASTER_KEY) throw new Error(DATA_MASTER_KEY_REQUIRED);
  if (!config.SESSION_SIGNING_KEY || !config.RUNNER_SHARED_SECRET)
    throw new Error('SESSION_SIGNING_KEY and RUNNER_SHARED_SECRET are required');
  for (const [label, raw] of [
    ['OPENROUTER_BASE_URL', config.OPENROUTER_BASE_URL],
    ['AI_BASE_URL', config.AI_BASE_URL]
  ] as const) {
    const url = new URL(raw);
    const privateHttp =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '::1' ||
        /^10\./.test(url.hostname) ||
        /^192\.168\./.test(url.hostname) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(url.hostname));
    if (url.protocol !== 'https:' && !(config.ALLOW_INSECURE_PROVIDER_URLS && privateHttp))
      throw new Error(
        `${label} must use HTTPS unless ALLOW_INSECURE_PROVIDER_URLS=true for a private address`
      );
  }
  /**
   * A self-hosted box on a public address has the production threat model in full - it is the same
   * machine, reachable the same way - so it gets the production checks. `development` is the only
   * mode that skips them, and it is the only one that cannot be reached by choosing the option that
   * sounds safest.
   */
  if (config.DEPLOYMENT_MODE !== 'development') {
    const app = new URL(config.PUBLIC_APP_URL);
    const preview = new URL(config.PREVIEW_BASE_URL);
    const webauthn = new URL(config.WEBAUTHN_ORIGIN);
    if (preview.origin === app.origin)
      throw new Error('Production previews require a separate HTTPS origin from PUBLIC_APP_URL');
    if (
      app.protocol !== 'https:' ||
      preview.protocol !== 'https:' ||
      webauthn.origin !== app.origin ||
      config.WEBAUTHN_RP_ID !== app.hostname ||
      config.ALLOW_INSECURE_DEV_AUTH ||
      !config.REGISTRATION_BOOTSTRAP_TOKEN
    ) {
      throw new Error(
        'Production self-hosting requires HTTPS, a matching WebAuthn RP ID, a first-owner pairing token, and development authentication disabled'
      );
    }
  }
  return config;
};
