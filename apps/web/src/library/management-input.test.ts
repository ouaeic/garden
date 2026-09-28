import { describe, expect, it } from 'vitest';
import {
  CreateConnectorRequest,
  CreateTaskScheduleRequest,
  UpdateTaskScheduleRequest
} from '@garden/contracts';
import { connectionInput, oauthCompletion, secretValue } from './connection-input.js';
import { watchInput } from './watch-input.js';

const form = (fields: Record<string, string | string[]>): FormData => {
  const result = new FormData();
  for (const [key, values] of Object.entries(fields))
    for (const value of Array.isArray(values) ? values : [values]) result.append(key, value);
  return result;
};
const workspaceId = 'cbda9e82-4c6a-4915-a510-cf775a21b8c3';
const watch = () =>
  form({
    title: 'My briefing',
    prompt: 'Summarize my saved project notes.',
    credits: '1',
    spend: '',
    timezone: 'Africa/Johannesburg',
    time: '09:00',
    privacyRoute: 'provider_zdr',
    modelId: ''
  });

describe('watch requests against the server contract', () => {
  it('lets creation inherit the account cap and route against the actual instruction', () => {
    const input = watchInput(watch(), 'daily', workspaceId, false);
    expect(CreateTaskScheduleRequest.safeParse(input).success).toBe(true);
    expect(input).not.toHaveProperty('maxSpendUsd');
    expect(input).not.toHaveProperty('modelId');
    expect(input).toMatchObject({
      privacyRoute: 'provider_zdr',
      spec: { kind: 'daily', timeZone: 'Africa/Johannesburg', localTime: '09:00' }
    });
  });
  it('clears an edited cap explicitly while preserving immutable model, privacy and trigger settings', () => {
    const values = watch();
    values.set('modelId', 'stale-model-selection');
    values.set('privacyRoute', 'external');
    values.set('trigger', 'on');
    values.set('minGap', '15');
    const input = watchInput(values, 'daily', workspaceId, true);
    expect(UpdateTaskScheduleRequest.safeParse(input).success).toBe(true);
    expect(input).toHaveProperty('maxSpendUsd', null);
    expect(input).not.toHaveProperty('modelId');
    expect(input).not.toHaveProperty('privacyRoute');
    expect(input).not.toHaveProperty('trigger');
  });
  it('does not carry an inactive trigger into a once-only schedule', () => {
    const values = watch();
    values.set('runAt', '2030-01-15T09:00:00Z');
    values.set('trigger', 'on');
    values.set('minGap', '15');
    const input = watchInput(values, 'once', workspaceId, false);
    expect(CreateTaskScheduleRequest.safeParse(input).success).toBe(true);
    expect(input).not.toHaveProperty('trigger');
    expect(input.spec).toEqual({ kind: 'once', runAt: '2030-01-15T09:00:00.000Z' });
  });
  it('requires weekday intent and sends all selected days with their timezone', () => {
    const values = watch();
    expect(() => watchInput(values, 'weekly', workspaceId, false)).toThrow('weekday');
    values.append('weekday', '1');
    values.append('weekday', '5');
    const input = watchInput(values, 'weekly', workspaceId, false);
    expect(CreateTaskScheduleRequest.safeParse(input).success).toBe(true);
    expect(input.spec).toEqual({
      kind: 'weekly',
      localTime: '09:00',
      timeZone: 'Africa/Johannesburg',
      weekdays: [1, 5]
    });
  });
});

describe('connection credentials and access boundaries', () => {
  it('keeps significant password whitespace while trimming the service address and label', () => {
    const values = form({
      label: ' My files ',
      baseUrl: ' https://dav.example.com/ ',
      username: 'owner',
      password: ' secret with spaces ',
      scope: ['webdav:files.read']
    });
    const input = connectionInput(values, 'webdav', ['webdav:files.read']);
    expect(CreateConnectorRequest.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      label: 'My files',
      baseUrl: 'https://dav.example.com/',
      password: ' secret with spaces '
    });
    expect(secretValue(form({ clientSecret: ' oauth secret ' }), 'clientSecret')).toBe(
      ' oauth secret '
    );
  });
  it('refuses permissions left over from another service and never copies its credentials', () => {
    const values = form({
      label: 'My repository',
      token: 'github-token',
      password: 'old-password',
      baseUrl: 'https://old.example.com',
      smtpHost: 'smtp.old.example.com',
      scope: 'webdav:files.read'
    });
    expect(() => connectionInput(values, 'github', ['github:repository.read'])).toThrow(
      'access choices changed'
    );
    values.set('scope', 'github:repository.read');
    const input = connectionInput(values, 'github', ['github:repository.read']);
    expect(CreateConnectorRequest.safeParse(input).success).toBe(true);
    expect(input).toEqual({
      kind: 'github',
      label: 'My repository',
      token: 'github-token',
      scopes: ['github:repository.read']
    });
  });
  it('accepts an OAuth verdict only from the opened window at this application origin', () => {
    const popup = {};
    const origin = 'https://my-computer.example.com';
    const message = {
      origin,
      source: popup,
      data: { source: 'garden-mcp-oauth', ok: true, message: 'Connected' }
    };
    expect(oauthCompletion(message, popup, origin)).toEqual({ ok: true, message: 'Connected' });
    expect(
      oauthCompletion({ ...message, origin: 'https://other.example.com' }, popup, origin)
    ).toBeNull();
    expect(oauthCompletion({ ...message, source: {} }, popup, origin)).toBeNull();
    expect(oauthCompletion({ ...message, source: null }, null, origin)).toBeNull();
    expect(
      oauthCompletion({ ...message, data: { ...message.data, ok: 'false' } }, popup, origin)
    ).toBeNull();
    expect(
      oauthCompletion(
        { ...message, data: { ...message.data, source: 'other-service' } },
        popup,
        origin
      )
    ).toBeNull();
  });
});
