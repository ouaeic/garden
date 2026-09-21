import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectAcceptanceCommand } from './acceptance-inspection.js';

describe('Python assertion inspection', () => {
  it.each([
    'assert True',
    'assert len(rows) == 12 or True',
    'assert (len(rows) == 12 or (True and True))',
    'assert not False',
    'assert "passed"'
  ])('finds an always-passing assertion: %s', async (source) => {
    const result = await inspectAcceptanceCommand({ executable: 'python3', args: ['-c', source] });
    expect(result.inspected).toBe(1);
    expect(result.issues).toHaveLength(1);
  });
  it.each([
    'assert len(rows) == 12',
    'assert (len(rows) == 12 or True) and valid',
    'assert len(rows) == 12 or False',
    'assert False',
    'print("assert data or True") # assert True',
    'expected = "assert True"\nassert output == expected'
  ])('does not mistake data or a falsifiable condition for a tautology: %s', async (source) => {
    const result = await inspectAcceptanceCommand({
      executable: '/usr/bin/python3.12',
      args: ['-c', source]
    });
    expect(result.inspected).toBe(1);
    expect(result.issues).toEqual([]);
  });
  it('parses quoted inline programs across a shell pipeline without running them', async () => {
    const result = await inspectAcceptanceCommand({
      executable: 'bash',
      args: ['-lc', 'python3 -c "import json; assert len(rows)==12 or True" && echo okay']
    });
    expect(result).toMatchObject({
      inspected: 1,
      issues: [expect.stringContaining('always passes')]
    });
  });
  it('does not execute imports or other submitted statements', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garden-inspector-'));
    const marker = path.join(root, 'executed');
    try {
      const result = await inspectAcceptanceCommand({
        executable: 'python3',
        args: [
          '-c',
          `import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text('bad')\nassert True`
        ]
      });
      expect(result.inspected).toBe(1);
      expect(result.issues).toHaveLength(1);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reports unsupported and incomplete syntax as uninspected', async () => {
    expect(
      await inspectAcceptanceCommand({ executable: 'node', args: ['-e', 'assert(true)'] })
    ).toEqual({ inspected: 0, issues: [] });
    expect(
      await inspectAcceptanceCommand({ executable: 'python3', args: ['-c', 'assert ('] })
    ).toEqual({ inspected: 0, issues: [] });
  });
});
