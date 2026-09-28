import { z } from 'zod';

/** AES-256-GCM, so the key is 32 bytes and a value of any other length is a typo, not a key. */
const MASTER_KEY_BYTES = 32;

const Config = z.object({
  DATABASE_DRIVER: z.enum(['pglite', 'postgres']).default('postgres'),
  DATABASE_URL: z.string().default('postgres://garden:garden@localhost:5432/garden'),
  PGLITE_PATH: z.string().default('.garden/postgres'),
  /*
   * Web Push is optional: garden works without it, the API already reports the feature as
   * disabled when no key is present, and the client hides the control. These are therefore
   * optional here too. A service that refuses to start over absent optional configuration does
   * not fail safe - it crash-loops under systemd, turns one disabled feature into a permanently
   * failing unit, and buries the real reason in a restart counter.
   */
  PUSH_VAPID_SUBJECT: z
    .string()
    .refine(
      (value) => value.startsWith('mailto:') || value.startsWith('https://'),
      'VAPID subject must be a mailto: or HTTPS URL'
    )
    .optional(),
  PUSH_VAPID_PUBLIC_KEY: z.string().min(80).max(100).optional(),
  PUSH_VAPID_PRIVATE_KEY: z.string().min(40).max(100).optional(),
  /*
   * The owner's key, which is what makes a notification say which conversation it is about.
   *
   * The conversation's own name and the sentence an agent-raised notification carries are both
   * encrypted with a workspace key. The data layer is the only place holding both the envelope and
   * the key to unwrap it, so it decrypts them - but only when it is handed a key. This schema had
   * no field for it at all, so the sender could not have passed one, and the result was that every
   * notification on every device read "Untitled conversation" while docs/PRIVACY.md described the
   * opposite. The unit already reads the /etc/garden/control.env that carries this value.
   *
   * Optional, like the signing keys above and for the same reason: a box without it still delivers
   * notifications, worded without the title, and a service that refuses to start over absent
   * optional configuration crash-loops instead of reporting itself. A key that is present and
   * malformed is a different thing and is refused below, because tolerating it would reproduce the
   * exact failure this field exists to end - a key sitting in control.env and reaching nothing.
   */
  DATA_MASTER_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z
      .string()
      .refine(
        (value) => Buffer.from(value, 'base64').length === MASTER_KEY_BYTES,
        `DATA_MASTER_KEY must be exactly ${MASTER_KEY_BYTES} bytes in base64`
      )
      .optional()
  ),
  NOTIFICATION_POLL_MS: z.coerce.number().int().min(250).default(2000),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  /*
   * Where the phone transport's bot API answers. It has exactly one real value, and the setting
   * exists so a test can point the sender and the inbound poller at a stub on loopback instead of
   * at the internet; an operator has no reason to change it, and the API reads the same key for the
   * two calls it makes itself. Absent means the real address, resolved where the client is built.
   */
  TELEGRAM_API_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional()
  ),
  /*
   * How many seconds one inbound long-poll request is allowed to hang open waiting for the owner to
   * tap something. Fifty is the service's own ceiling and the right number on a box that is doing
   * its job: a request that stays open costs nothing while it waits, and returns the instant
   * something arrives. Shorter is only useful against a proxy that closes idle connections.
   */
  NOTIFICATION_INBOUND_POLL_TIMEOUT_S: z.coerce.number().int().min(1).max(50).default(50),
  /*
   * The address a card's "Open in garden" button carries. Web Push needs no such thing - the
   * service worker resolves a relative path against its own origin - but a message on a phone is
   * opened by a browser that knows nothing about this box. Shared with every other service, and
   * declared here rather than imported from the contracts package for the reason DATA_MASTER_KEY
   * gives above.
   */
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
  /*
   * Where this box's own API listens, for the one request this service makes to it: an answer the
   * owner types on the phone to a question the agent asked is posted to the same route the web
   * client and the command line use, so that the conversation is unparked by that route's checks
   * and idempotency rather than by a second copy of them here. Same two keys the API declares, same
   * defaults, from the same control.env.
   */
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(4100)
});

/**
 * Where the health and metrics endpoint listens. Not configurable, and deliberately so.
 *
 * Nginx is the only public listener on this box, and binding 0.0.0.0 here once published a health
 * and metrics endpoint straight onto the internet. The port is fixed for the same reason the host
 * is: `garden doctor` probes it and the runner is told it as a port a published preview may never
 * take, both as literals, so a setting that moved it could only make those two wrong.
 */
export const NOTIFICATION_HEALTH_HOST = '127.0.0.1';
export const NOTIFICATION_HEALTH_PORT = 4203;

export type NotificationConfig = z.infer<typeof Config>;
export const loadConfig = (env: unknown = process.env): NotificationConfig => Config.parse(env);

/**
 * The master key as bytes, for the one call that needs it.
 *
 * Decoded here rather than through `@garden/core`'s `decodeMasterKey` because this service's
 * dependencies are the data layer, the push library and zod, and reaching for another workspace
 * package to run four lines would mean an undeclared import at runtime. `core`'s own
 * `service-keys.ts` keeps a second private copy for the same reason. The length is already refused
 * by the schema, so this cannot hand out a key the store would fail to decrypt with.
 */
export const masterKeyBytes = (config: NotificationConfig): Uint8Array | undefined =>
  config.DATA_MASTER_KEY ? Buffer.from(config.DATA_MASTER_KEY, 'base64') : undefined;

/** Delivery needs all three; any missing one means the feature is simply off. */
export const pushConfigured = (
  config: NotificationConfig
): config is NotificationConfig & {
  PUSH_VAPID_SUBJECT: string;
  PUSH_VAPID_PUBLIC_KEY: string;
  PUSH_VAPID_PRIVATE_KEY: string;
} =>
  Boolean(
    config.PUSH_VAPID_SUBJECT && config.PUSH_VAPID_PUBLIC_KEY && config.PUSH_VAPID_PRIVATE_KEY
  );

/** The loopback address the API answers on, in the form a request needs it. */
export const apiBaseUrl = (config: NotificationConfig): string =>
  `http://${config.API_HOST.includes(':') ? `[${config.API_HOST}]` : config.API_HOST}:${config.API_PORT}`;
