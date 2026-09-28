import { describe, expect, it } from 'vitest';
import { apiBaseUrl, loadConfig, masterKeyBytes } from './config.js';

const base = {
  DATABASE_DRIVER: 'postgres',
  DATABASE_URL: 'postgres://garden:garden@localhost:5432/garden'
};

const key = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');

describe('the workspace decryption key', () => {
  it('is read from the same environment file every other service reads it from', () => {
    // Without this the sender asks the data layer for pending rows and gets every title back as
    // null, so every notification on every device reads "Untitled conversation". The key was not
    // merely unpassed before this: the schema had no field for it, so it was unobtainable.
    const config = loadConfig({ ...base, DATA_MASTER_KEY: key(32) });
    expect(config.DATA_MASTER_KEY).toBe(key(32));
    expect(masterKeyBytes(config)).toHaveLength(32);
  });

  it('is optional, because a box with no key still delivers untitled notifications', () => {
    const config = loadConfig(base);
    expect(config.DATA_MASTER_KEY).toBeUndefined();
    expect(masterKeyBytes(config)).toBeUndefined();
  });

  it('refuses a key of the wrong size rather than quietly sending untitled notifications', () => {
    // The failure this whole field exists to stop is a key that is present and does not reach the
    // decryption, and a malformed value that was tolerated would reproduce it exactly - the same
    // "Untitled conversation" on every device, with the key sitting right there in control.env.
    expect(() => loadConfig({ ...base, DATA_MASTER_KEY: key(16) })).toThrow();
    expect(() => loadConfig({ ...base, DATA_MASTER_KEY: 'not base64 at all !!' })).toThrow();
  });

  it('treats an empty or blank value as absent, which is how an unset line in control.env reads', () => {
    expect(loadConfig({ ...base, DATA_MASTER_KEY: '' }).DATA_MASTER_KEY).toBeUndefined();
    expect(loadConfig({ ...base, DATA_MASTER_KEY: '   ' }).DATA_MASTER_KEY).toBeUndefined();
  });
});

describe('the phone transport settings', () => {
  it('default to the real bot API and the longest long poll the service allows', () => {
    const config = loadConfig(base);
    // Absent means the real address, resolved where the client is built rather than here, so a
    // record built by hand in a test need not name it. The API declares the key the same way.
    expect(config.TELEGRAM_API_BASE_URL).toBeUndefined();
    expect(config.NOTIFICATION_INBOUND_POLL_TIMEOUT_S).toBe(50);
    // The two keys the API declares, read here with the same defaults, so the loopback address
    // an answer is posted to is the one the API actually listens on.
    expect(apiBaseUrl(config)).toBe('http://127.0.0.1:4100');
    expect(apiBaseUrl(loadConfig({ ...base, API_HOST: '::1', API_PORT: '4111' }))).toBe(
      'http://[::1]:4111'
    );
  });

  it('can be pointed at a stub for a test, and refuses a poll longer than the service allows', () => {
    expect(
      loadConfig({ ...base, TELEGRAM_API_BASE_URL: 'http://127.0.0.1:9' }).TELEGRAM_API_BASE_URL
    ).toBe('http://127.0.0.1:9');
    expect(() => loadConfig({ ...base, TELEGRAM_API_BASE_URL: 'not a url' })).toThrow();
    expect(() => loadConfig({ ...base, NOTIFICATION_INBOUND_POLL_TIMEOUT_S: '51' })).toThrow();
    expect(() => loadConfig({ ...base, NOTIFICATION_INBOUND_POLL_TIMEOUT_S: '0' })).toThrow();
  });
});
