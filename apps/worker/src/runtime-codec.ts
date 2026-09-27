import {
  AthanorError,
  decryptBytes,
  encryptBytes,
  encryptJson,
  wrapDataKey,
  userMemoryKey,
  type EncryptedEnvelope
} from '@athanor/core';
import { interruptedResponseOf, retainInterruptedResponse } from '@athanor/model-gateway';

type Encoded =
  | null
  | boolean
  | number
  | string
  | { type: string; value?: unknown; [key: string]: unknown };
export const REPLAY_MASTER_KEY = Buffer.alloc(32, 37);
export const REPLAY_WORKSPACE_KEY = Buffer.alloc(32, 53);
const envelope = (value: Record<string, unknown>): boolean =>
  value.v === 1 && ['iv', 'tag', 'ciphertext'].every((key) => typeof value[key] === 'string');
const credentialFields = new Set([
  'connectionId',
  'label',
  'provider',
  'baseUrl',
  'modelId',
  'enforceZeroDataRetention',
  'mediaModels',
  'mediaRoutes'
]);

/** Sealed private observations contain plaintext task data, never the live keys that open it. */
export class RuntimeCodec {
  readonly secrets = new Set<string>();
  constructor(
    readonly workspaceId: string,
    private readonly workspaceKey: Buffer = REPLAY_WORKSPACE_KEY,
    private readonly masterKey: Buffer = REPLAY_MASTER_KEY,
    public ownerId?: string
  ) {}

  private clean(value: string): string {
    for (const secret of this.secrets) value = value.replaceAll(secret, '[credential]');
    return value;
  }

  connection(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.connection(entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (
          typeof entry === 'string' &&
          /(?:token|password|secret|api.?key|private.?key|authorization)/i.test(key)
        ) {
          if (entry) this.secrets.add(entry);
          return [key, entry ? '[credential]' : entry];
        }
        if (typeof entry === 'string' && /url$/i.test(key)) {
          try {
            const url = new URL(entry);
            if (url.username) this.secrets.add(url.username);
            if (url.password) this.secrets.add(url.password);
            if (url.username || url.password) {
              url.username = '';
              url.password = '';
            }
            for (const name of [...url.searchParams.keys()]) {
              if (/(?:token|password|secret|key|authorization)/i.test(name)) {
                const secret = url.searchParams.get(name);
                if (secret) this.secrets.add(secret);
                url.searchParams.set(name, '[credential]');
              }
            }
            return [key, url.href.replace(/\/$/, entry.endsWith('/') ? '/' : '')];
          } catch {
            throw new Error('Invalid credential endpoint');
          }
        }
        return [key, this.connection(entry)];
      })
    );
  }

  credential(value: Record<string, unknown>): Record<string, unknown> {
    if (typeof value.apiKey === 'string' && value.apiKey) this.secrets.add(value.apiKey);
    return Object.fromEntries(
      Object.entries(this.connection(value) as Record<string, unknown>).flatMap(([key, entry]) =>
        key === 'apiKey'
          ? [[key, entry ? '[credential]' : entry]]
          : credentialFields.has(key)
            ? [[key, entry]]
            : []
      )
    );
  }

  encode(value: unknown, callbacks?: Map<string, (...args: unknown[]) => unknown>): Encoded {
    if (value === undefined) return { type: 'undefined' };
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return this.clean(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Nonfinite runtime observation');
      return value;
    }
    if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
    if (typeof value === 'function') {
      if (!callbacks) throw new Error('Runtime result contains an executable value');
      const id = String(callbacks.size);
      callbacks.set(id, value as (...args: unknown[]) => unknown);
      return { type: 'callback', value: id };
    }
    if (value instanceof Date) return { type: 'date', value: value.toISOString() };
    if (value instanceof AbortSignal) return { type: 'signal', value: value.aborted };
    if (value instanceof Uint8Array) {
      if (Buffer.from(value).equals(this.workspaceKey) || Buffer.from(value).equals(this.masterKey))
        throw new Error('Key material is not a runtime observation');
      return { type: 'bytes', value: Buffer.from(value).toString('base64') };
    }
    if (value instanceof Error) {
      const partial = interruptedResponseOf(value);
      return {
        type: 'error',
        name: value.name,
        message: this.clean(value.message),
        value: this.encode(
          Object.fromEntries(
            Object.getOwnPropertyNames(value)
              .filter((key) => !['name', 'message', 'stack'].includes(key))
              .map((key) => [key, Reflect.get(value, key)])
          )
        ),
        ...(partial ? { partial: this.encode(partial) } : {})
      };
    }
    if (Array.isArray(value))
      return { type: 'array', value: value.map((entry) => this.encode(entry, callbacks)) };
    if (value instanceof Map) return { type: 'map', value: this.encode([...value], callbacks) };
    if (value instanceof Set) return { type: 'set', value: this.encode([...value], callbacks) };
    if (typeof value !== 'object') throw new Error('Unsupported runtime observation');
    const bag = value as Record<string, unknown>;
    if (envelope(bag)) {
      const sealed = bag as unknown as EncryptedEnvelope;
      let bytes: Buffer;
      let key = 'workspace';
      try {
        bytes = decryptBytes(sealed, this.workspaceKey);
      } catch {
        if (
          this.ownerId &&
          [`owner-block:${this.ownerId}`, `user-memory:${this.ownerId}`].includes(sealed.aad ?? '')
        ) {
          bytes = decryptBytes(sealed, userMemoryKey(this.masterKey, this.ownerId));
          key = 'owner';
        } else {
          bytes = decryptBytes(sealed, this.masterKey);
          key = 'master';
        }
      }
      if (key === 'master' && sealed.aad?.startsWith('inference-provider:')) {
        const secret = this.credential(
          JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
        );
        return { type: 'sealed', key, aad: sealed.aad, value: this.encode(secret) };
      }
      if (key === 'master' && this.ownerId && sealed.aad?.startsWith(`connector:${this.ownerId}:`))
        return {
          type: 'sealed',
          key,
          aad: sealed.aad,
          value: this.encode(this.connection(JSON.parse(bytes.toString('utf8'))))
        };
      if (key === 'master')
        throw new Error('Master-sealed credentials are excluded from runtime observations');
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        return { type: 'sealed_bytes', key, aad: sealed.aad, value: bytes.toString('base64') };
      }
      return { type: 'sealed', key, aad: sealed.aad, value: this.encode(parsed) };
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('Unsupported runtime object');
    return {
      type: 'object',
      value: Object.entries(bag).map(([key, entry]) => {
        if (key === 'wrappedKey' && typeof entry === 'string') {
          if (bag.id !== this.workspaceId && bag.workspaceId !== this.workspaceId)
            throw new Error('Other workspace keys are excluded from replay');
          return [key, { type: 'workspace_key', value: this.workspaceId }];
        }
        return [key, this.encode(entry, callbacks)];
      })
    };
  }

  decode(encoded: unknown, callback?: (id: string) => (...args: unknown[]) => unknown): unknown {
    if (encoded === null || typeof encoded !== 'object') return encoded;
    const row = encoded as Record<string, unknown>;
    const rows = () => {
      if (!Array.isArray(row.value)) throw new Error('Invalid runtime collection');
      return row.value as unknown[];
    };
    switch (row.type) {
      case 'undefined':
        return undefined;
      case 'bigint':
        return BigInt(String(row.value));
      case 'date':
        return new Date(String(row.value));
      case 'signal': {
        const controller = new AbortController();
        if (row.value) controller.abort();
        return controller.signal;
      }
      case 'bytes':
        return Buffer.from(String(row.value), 'base64');
      case 'callback': {
        if (!callback) throw new Error('Unexpected callback in runtime result');
        return callback(String(row.value));
      }
      case 'array':
        return rows().map((entry) => this.decode(entry, callback));
      case 'map':
        return new Map(this.decode(row.value, callback) as [unknown, unknown][]);
      case 'set':
        return new Set(this.decode(row.value, callback) as unknown[]);
      case 'object':
        return Object.fromEntries(
          rows().map((entry) => {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
              throw new Error('Invalid runtime field');
            return [entry[0], this.decode(entry[1], callback)];
          })
        );
      case 'workspace_key':
        if (row.value !== this.workspaceId) throw new Error('Wrong runtime workspace');
        return wrapDataKey(this.workspaceKey, this.masterKey, this.workspaceId);
      case 'sealed':
      case 'sealed_bytes': {
        const key =
          row.key === 'workspace'
            ? this.workspaceKey
            : row.key === 'master'
              ? this.masterKey
              : row.key === 'owner' && this.ownerId
                ? userMemoryKey(this.masterKey, this.ownerId)
                : null;
        if (!key) throw new Error('Invalid runtime key reference');
        const aad = typeof row.aad === 'string' ? row.aad : undefined;
        return row.type === 'sealed'
          ? encryptJson(this.decode(row.value), key, aad)
          : encryptBytes(Buffer.from(String(row.value), 'base64'), key, aad);
      }
      case 'error': {
        const fields = this.decode(row.value) as Record<string, unknown>;
        const error =
          row.name === 'AthanorError'
            ? new AthanorError(
                String(fields.code),
                String(row.message),
                Number(fields.statusCode),
                fields.details as Record<string, unknown> | undefined
              )
            : new Error(String(row.message));
        Object.assign(error, fields, { name: row.name });
        if (row.partial)
          retainInterruptedResponse(
            error,
            this.decode(row.partial) as Parameters<typeof retainInterruptedResponse>[1]
          );
        return error;
      }
      default:
        throw new Error('Unsupported runtime encoding');
    }
  }
}

export function replayConfig(config: Record<string, unknown>, codec: RuntimeCodec) {
  const result = { ...config };
  for (const key of [
    'AI_API_KEY',
    'OPENROUTER_API_KEY',
    'RUNNER_SHARED_SECRET',
    'DATA_MASTER_KEY'
  ]) {
    if (typeof result[key] === 'string' && result[key]) codec.secrets.add(result[key]);
    if (result[key]) result[key] = '[credential]';
  }
  result.DATABASE_URL = 'postgres://unavailable.invalid/replay';
  result.PGLITE_PATH = '/unavailable/replay';
  return codec.connection(result) as Record<string, unknown>;
}
