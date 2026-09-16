import { expect, it } from 'vitest';
import { signatureControl } from './human-input.js';
import { classifyBrowserAction, combineBatchPreflight } from './browser.js';
import { OwnerStroke } from '@athanor/contracts';

it('hands personal signatures to the owner without interrupting ordinary account navigation', () => {
  const signatures = [
    'Sign',
    'Sign document',
    'Sign practice document',
    'Sign employment agreement',
    'Draw your signature',
    'E-sign contract',
    'Sign and submit'
  ];
  expect(signatures.length).toBeGreaterThan(0);
  for (const label of signatures) expect(signatureControl(label)).toBe(true);
  const navigation = ['Sign in', 'Sign up', 'Sign out', 'Assign work', 'Submit application'];
  expect(navigation.length).toBeGreaterThan(0);
  for (const label of navigation) expect(signatureControl(label)).toBe(false);
  const policy = classifyBrowserAction(
    { type: 'click_at', x: 1, y: 1 },
    {
      tag: 'button',
      type: 'submit',
      name: 'Sign document',
      inForm: true,
      autocomplete: '',
      formAction: ''
    }
  );
  expect(policy.handoffKind).toBe('signature');
  expect(
    combineBatchPreflight([{ index: 0, preflight: { ...policy, tabId: 'tab-2' } }])
  ).toMatchObject({ handoffKind: 'signature', tabId: 'tab-2' });
});
it('accepts a bounded complete human gesture and rejects malformed coordinates', () => {
  expect(
    OwnerStroke.parse({
      points: [
        { x: 0, y: 1 },
        { x: 20, y: 40 }
      ]
    }).points
  ).toHaveLength(2);
  expect(OwnerStroke.safeParse({ points: [{ x: 0, y: 1 }] }).success).toBe(false);
  expect(
    OwnerStroke.safeParse({
      points: [
        { x: -1, y: 1 },
        { x: 20, y: 40 }
      ]
    }).success
  ).toBe(false);
});
