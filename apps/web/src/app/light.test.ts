import { describe, expect, it } from 'vitest';
import { rgba } from './Light';

describe('the light’s colours', () => {
  it('reads a theme colour whichever length the build wrote it in', () => {
    expect(rgba('#ffffff', 0.5)).toBe('rgba(255,255,255,0.5)');
    expect(rgba('#fff', 0.5)).toBe('rgba(255,255,255,0.5)');
    expect(rgba('#1e6a49', 0.34)).toBe('rgba(30,106,73,0.34)');
  });
});
