import { describe, expect, it } from 'vitest';
import { toolchainWithdrawals } from './claim.js';

describe('tools a box cannot run', () => {
  it('withdraws document_read where the runner reports no document toolchain', () => {
    expect(
      toolchainWithdrawals('No document toolchain is installed on this computer. Commands: git.')
    ).toEqual(['document_read']);
  });

  it('withdraws nothing from a box that has the toolchain, or one whose probe said nothing', () => {
    expect(toolchainWithdrawals('python3, typst; Python modules pypdf.')).toEqual([]);
    expect(toolchainWithdrawals('')).toEqual([]);
  });
});
