import { describe, expect, it } from 'vitest';
import { newerVersion } from './UpdateNotice.js';

describe('native version notices', () => {
  it('compares numeric release versions without prompting for older or unrecognized builds', () => {
    expect(newerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(newerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(newerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(newerVersion('0.2.0', '0.3.0')).toBe(false);
    expect(newerVersion('not-a-version', '0.2.0')).toBe(false);
    expect(newerVersion('0.3.0', 'unknown')).toBe(false);
  });
});
