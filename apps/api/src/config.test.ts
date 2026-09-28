import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';

const productionEnvironment = () => {
  vi.stubEnv('DEPLOYMENT_MODE', 'production');
  vi.stubEnv('PUBLIC_APP_URL', 'https://ai.acme.com');
  vi.stubEnv('PUBLIC_SOURCE_URL', 'https://code.acme.com/garden');
  vi.stubEnv('PUBLIC_PRIVACY_URL', 'https://ai.acme.com/legal/privacy');
  vi.stubEnv('PREVIEW_BASE_URL', 'https://preview.ai.acme.com');
  vi.stubEnv('WEBAUTHN_ORIGIN', 'https://ai.acme.com');
  vi.stubEnv('WEBAUTHN_RP_ID', 'ai.acme.com');
  vi.stubEnv('ALLOW_INSECURE_DEV_AUTH', 'false');
  vi.stubEnv('REGISTRATION_BOOTSTRAP_TOKEN', 'pairing-token-with-at-least-20-characters');
  vi.stubEnv('REGISTRATION_BOOTSTRAP_EXPIRES_AT', String(Math.floor(Date.now() / 1000) + 86_400));
  vi.stubEnv('WORKSPACE_IMAGE_REVISION', `sha256:${'a'.repeat(64)}`);
  vi.stubEnv('DATA_MASTER_KEY', Buffer.alloc(32, 1).toString('base64'));
  vi.stubEnv('SESSION_SIGNING_KEY', 's'.repeat(32));
  vi.stubEnv('RUNNER_SHARED_SECRET', 'r'.repeat(32));
};

afterEach(() => vi.unstubAllEnvs());

describe('production configuration', () => {
  it('requires a separate preview origin and accepts an isolated TLS port on the same host', () => {
    productionEnvironment();
    vi.stubEnv('PREVIEW_BASE_URL', 'https://ai.acme.com/__garden/preview');
    expect(() => loadConfig()).toThrow('separate HTTPS origin');
    vi.stubEnv('PREVIEW_BASE_URL', 'https://ai.acme.com:8443/__garden/preview');
    expect(loadConfig().PREVIEW_BASE_URL).toBe('https://ai.acme.com:8443/__garden/preview');
    expect(loadConfig().RESERVED_PREVIEW_PORTS.split(',')).toContain('8443');
  });
  it('requires one HTTPS WebAuthn boundary and a first-owner pairing token', () => {
    productionEnvironment();
    expect(loadConfig()).toMatchObject({
      DEPLOYMENT_MODE: 'production',
      PUBLIC_APP_URL: 'https://ai.acme.com',
      WORKSPACE_IMAGE_REVISION: `sha256:${'a'.repeat(64)}`
    });

    vi.stubEnv('PUBLIC_APP_URL', 'http://ai.acme.com');
    expect(() => loadConfig()).toThrow('Production self-hosting requires HTTPS');

    vi.stubEnv('PUBLIC_APP_URL', 'https://ai.acme.com');
    vi.stubEnv('REGISTRATION_BOOTSTRAP_TOKEN', '');
    expect(() => loadConfig()).toThrow('first-owner pairing token');
  });

  it('offers exactly two deployment modes, and refuses a third that once meant nothing', () => {
    productionEnvironment();
    // 'selfhost' was a third value whose behaviour was identical to 'production'. It is refused
    // rather than silently accepted, so an operator carrying it forward is told, not guessed at.
    vi.stubEnv('DEPLOYMENT_MODE', 'selfhost');
    expect(() => loadConfig()).toThrow();

    vi.stubEnv('DEPLOYMENT_MODE', 'production');
    expect(loadConfig()).toMatchObject({ DEPLOYMENT_MODE: 'production' });

    vi.stubEnv('DEPLOYMENT_MODE', 'development');
    expect(loadConfig()).toMatchObject({ DEPLOYMENT_MODE: 'development' });
  });

  it('rejects a non-official OpenRouter endpoint even in development', () => {
    productionEnvironment();
    vi.stubEnv('DEPLOYMENT_MODE', 'development');
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://127.0.0.1:11434');
    expect(() => loadConfig()).toThrow('OPENROUTER_BASE_URL');
  });

  it('does not require paid-service or provider-resale evidence', () => {
    productionEnvironment();
    expect(loadConfig()).not.toHaveProperty('OPENROUTER_MANAGEMENT_KEY');
    expect(loadConfig()).not.toHaveProperty('OPENROUTER_COMMERCIAL_APPROVAL_REF');
  });

  /**
   * The API and the worker are separate units started from one control.env, and this key bounds
   * the same thing in both: how many model calls one turn may spend. It was capped at 200 here and
   * 400 in the worker, so `TASK_MAX_STEPS=300` gave an operator a worker that ran and an API that
   * would not start. Both now read the single declaration in @garden/contracts/env.
   */
  it('accepts every step ceiling the worker accepts', () => {
    productionEnvironment();
    expect(loadConfig().TASK_MAX_STEPS).toBe(120);

    vi.stubEnv('TASK_MAX_STEPS', '300');
    expect(loadConfig().TASK_MAX_STEPS).toBe(300);

    vi.stubEnv('TASK_MAX_STEPS', '401');
    expect(() => loadConfig()).toThrow();
  });

  /**
   * Share links are on unless the operator writes the one word that turns them off. The empty
   * spelling matters: a templated control.env can list the key with nothing after it, and that
   * must read as absent rather than as "not true", or the template closes every link on the box.
   */
  it('reads SHARING_ENABLED as on when absent or empty, and off only when written false', () => {
    productionEnvironment();
    expect(loadConfig().SHARING_ENABLED).toBeUndefined();

    vi.stubEnv('SHARING_ENABLED', '');
    expect(loadConfig().SHARING_ENABLED).toBeUndefined();

    vi.stubEnv('SHARING_ENABLED', 'true');
    expect(loadConfig().SHARING_ENABLED).toBe(true);

    vi.stubEnv('SHARING_ENABLED', 'false');
    expect(loadConfig().SHARING_ENABLED).toBe(false);
  });

  it('fails closed without installation secrets', () => {
    productionEnvironment();
    vi.stubEnv('DATA_MASTER_KEY', '');
    // The file has to be named, or the owner who reaches this invents a key rather than recovering
    // the one he has - and a key that did not encrypt this database seals off everything in it.
    expect(() => loadConfig()).toThrow('/etc/garden/control.env');

    vi.stubEnv('DATA_MASTER_KEY', Buffer.alloc(32, 1).toString('base64'));
    vi.stubEnv('RUNNER_SHARED_SECRET', '');
    expect(() => loadConfig()).toThrow('RUNNER_SHARED_SECRET');
  });
});
