import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureWorkspace } from './files.js';
import { codeOffset, codeSource, codeUriPath, workspaceEdits } from './code-intelligence-source.js';

describe('source-linked language results', () => {
  it('validates UTF-16 offsets and refuses ranges beyond a line', () => {
    expect(codeOffset('🌿x\r\ny', { line: 0, character: 2 })).toBe(2);
    expect(() => codeOffset('🌿x', { line: 0, character: 1 })).toThrow('Unicode');
    expect(codeOffset('🌿x\r\ny', { line: 1, character: 1 })).toBe(6);
    expect(() => codeOffset('x\ny', { line: 0, character: 2 })).toThrow('outside');
  });
  it('rejects network links, escapes, symlinks and resource-changing rename plans', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'garden-source-')));
    await ensureWorkspace(root);
    try {
      const project = path.join(root, 'workspace');
      await writeFile(path.join(root, '.home', 'secret.py'), 'private = True');
      await symlink(path.join(root, '.home', 'secret.py'), path.join(project, 'linked.py'));
      expect(() => codeUriPath(root, project, 'https://example.test/code')).toThrow('non-local');
      expect(() =>
        codeUriPath(root, project, pathToFileURL(path.join(root, '.home/secret.py')).href)
      ).toThrow('escapes');
      expect(() =>
        codeUriPath(
          root,
          path.join(project, 'one'),
          pathToFileURL(path.join(project, 'two.py')).href
        )
      ).toThrow('escapes');
      await expect(codeSource(root, project, 'linked.py')).rejects.toThrow();
      expect(() =>
        workspaceEdits({
          documentChanges: [{ kind: 'delete', uri: pathToFileURL(path.join(project, 'a.py')).href }]
        })
      ).toThrow();
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      expect(() =>
        workspaceEdits({
          changes: { 'file:///a.py': Array.from({ length: 501 }, () => ({ range, newText: 'z' })) }
        })
      ).toThrow('bounded preview');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
