import { describe, expect, it } from 'vitest';
import { approvalScopeCovers, type TaskApprovalScope } from './approval-grants.js';

const network: TaskApprovalScope = {
  tool: 'shell',
  permissions: ['network'],
  programs: ['curl'],
  origins: ['https://unpkg.com', 'https://pypi.org'],
  directories: []
};
const files: TaskApprovalScope = {
  tool: 'file_write',
  permissions: ['files'],
  programs: [],
  origins: [],
  directories: ['workspace/src']
};

describe('what a conversation permission covers', () => {
  it('covers the same sites from any program when it only reaches the network', () => {
    expect(approvalScopeCovers(network, { ...network, origins: ['https://unpkg.com'] })).toBe(true);
    expect(
      approvalScopeCovers(network, {
        ...network,
        programs: ['wget'],
        origins: ['https://pypi.org']
      })
    ).toBe(true);
    expect(approvalScopeCovers(network, { ...network, origins: ['https://other.example'] })).toBe(
      false
    );
  });
  it('never covers a permission, a program or a tool it was not given for', () => {
    expect(approvalScopeCovers(network, { ...network, permissions: ['install', 'network'] })).toBe(
      false
    );
    const install: TaskApprovalScope = {
      ...network,
      permissions: ['install', 'network'],
      programs: ['pip']
    };
    expect(approvalScopeCovers(install, install)).toBe(true);
    expect(approvalScopeCovers(install, { ...install, programs: ['npm'] })).toBe(false);
    expect(approvalScopeCovers(network, { ...network, tool: 'parallel_web_read' })).toBe(false);
  });
  it('covers folders inside the ones it names and none beside or above them', () => {
    expect(approvalScopeCovers(files, { ...files, directories: ['workspace/src/lib'] })).toBe(true);
    expect(approvalScopeCovers(files, { ...files, directories: ['workspace/srcs'] })).toBe(false);
    expect(approvalScopeCovers(files, { ...files, directories: ['workspace'] })).toBe(false);
  });
});
