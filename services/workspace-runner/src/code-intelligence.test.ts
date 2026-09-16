import { mkdtemp, realpath, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Execution from './execution.js';
vi.mock('./execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Execution>()),
  prepareInvocation: vi.fn(
    async (root: string, request: { executable: string; args: string[]; cwd: string }) => ({
      executable: request.executable,
      args: request.args,
      cwd: path.join(root, request.cwd),
      env: process.env
    })
  )
}));
import { prepareInvocation } from './execution.js';
import { ensureWorkspace } from './files.js';
import { CodeIntelligenceManager, CODE_SESSION_IDLE_MS } from './code-intelligence.js';

const fixtures: Array<{ root: string; manager: CodeIntelligenceManager }> = [];
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'garden-code-')));
  await ensureWorkspace(root);
  let now = Date.now();
  const manager = new CodeIntelligenceManager(
    { isolateNetwork: false, systemPackages: { mode: 'refused', helper: undefined } },
    () => now
  );
  fixtures.push({ root, manager });
  const write = (name: string, text: string) => writeFile(path.join(root, 'workspace', name), text);
  return {
    root,
    manager,
    write,
    advance: () => {
      now += CODE_SESSION_IDLE_MS + 1;
    }
  };
}
afterEach(async () => {
  for (const { root, manager } of fixtures.splice(0)) {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe('native code intelligence', () => {
  it('drains a pending launch before workspace replacement without starting a late child', async () => {
    const { root, manager } = await fixture();
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(prepareInvocation).mockImplementationOnce(async () => {
      entered = true;
      await gate;
      return {
        executable: process.execPath,
        args: ['-e', 'process.exit(1)'],
        cwd: root,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
      };
    });
    const starting = manager.act(root, 'task', { action: 'start', language: 'typescript' });
    await expect.poll(() => entered).toBe(true);
    expect(manager.isWorkspaceBusy(root)).toBe(true);
    const refused = expect(starting).rejects.toThrow('Workspace changed');
    const stopped = manager.quiesceWorkspace(root);
    release();
    await Promise.all([refused, stopped]);
    expect(manager.isWorkspaceBusy(root)).toBe(false);
    expect(
      await manager.act(root, 'task', { action: 'status', language: 'typescript' })
    ).toMatchObject({ running: false });
  });

  it.each(['current', 'unversioned', 'stale'] as const)(
    'reports %s push diagnostics without inventing a verified version',
    async (mode) => {
      const { root, manager, write } = await fixture();
      await write('input.py', 'answer = missing\n');
      const script = `let buffer=Buffer.alloc(0);const send=x=>{const body=Buffer.from(JSON.stringify(x));process.stdout.write('Content-Length: '+body.length+'\\r\\n\\r\\n');process.stdout.write(body)};
      process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const length=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+length)return;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);
      if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{capabilities:{textDocumentSync:1}}});
      else if(message.method==='textDocument/didOpen'){const document=message.params.textDocument;send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:document.uri,${mode === 'unversioned' ? '' : `version:${mode === 'current' ? 'document.version' : 'document.version-1'},`}diagnostics:[{range:{start:{line:0,character:9},end:{line:0,character:16}},severity:1,message:'Unknown variable'}]}})}
      else if(message.method==='shutdown')send({jsonrpc:'2.0',id:message.id,result:null});else if(message.method==='exit')process.exit(0);
      }});`;
      vi.mocked(prepareInvocation).mockImplementationOnce(async () => ({
        executable: process.execPath,
        args: ['-e', script],
        cwd: root,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
      }));
      await manager.act(root, 'task', { action: 'start', language: 'python' });
      const result = await manager.act(root, 'task', {
        action: 'diagnostics',
        language: 'python',
        path: 'workspace/input.py'
      });
      expect(result).toMatchObject({
        complete: mode === 'current',
        total: mode === 'stale' ? 0 : 1
      });
    }
  );

  it.each(['typescript', 'python'] as const)(
    'uses the installed %s language server for diagnostics, cross-file definitions/references and rename previews',
    async (language) => {
      const { root, manager, write } = await fixture();
      const python = language === 'python';
      await write(
        python ? 'maths.py' : 'maths.ts',
        python
          ? 'def twice(value: int) -> int:\n    return value * 2\n'
          : 'export function twice(value: number) { return value * 2; }\n'
      );
      await write(
        python ? 'use.py' : 'use.ts',
        python
          ? 'from maths import twice\nanswer: str = twice(4)\n'
          : "import { twice } from './maths';\nconst answer: string = twice(4);\n"
      );
      if (!python)
        await write('tsconfig.json', '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
      const call = (args: Record<string, unknown>) =>
        manager.act(root, 'task-1', { language, ...args });
      await expect(
        call({
          action: 'definition',
          path: python ? 'use.py' : 'use.ts',
          line: 2,
          column: python ? 15 : 24
        })
      ).rejects.toThrow('No active language session');
      const started = await call({ action: 'start' });
      expect(prepareInvocation).toHaveBeenLastCalledWith(
        root,
        expect.objectContaining({ network: false, requireNetworkIsolation: true }),
        expect.any(Object)
      );
      expect(started).toMatchObject({
        running: true,
        capabilities: { definition: true, references: true, rename: true, diagnostics: true }
      });
      const definition = await call({
        action: 'definition',
        path: python ? 'use.py' : 'use.ts',
        line: 2,
        column: python ? 15 : 24
      });
      expect(definition).toMatchObject({
        entries: [
          expect.objectContaining({ path: python ? 'workspace/maths.py' : 'workspace/maths.ts' })
        ]
      });
      const hover = await call({
        action: 'hover',
        path: python ? 'use.py' : 'use.ts',
        line: 2,
        column: python ? 15 : 24
      });
      expect(hover).toMatchObject({
        text: expect.stringContaining('twice') as unknown,
        truncated: false
      });
      const outline = await call({ action: 'symbols', path: python ? 'maths.py' : 'maths.ts' });
      expect(outline).toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ name: 'twice' })]) as unknown
      });
      const references = await call({
        action: 'references',
        path: python ? 'maths.py' : 'maths.ts',
        line: 1,
        column: python ? 5 : 18
      });
      expect(references).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: python ? 'workspace/use.py' : 'workspace/use.ts' })
        ]) as unknown
      });
      const diagnostics = await call({ action: 'diagnostics', path: python ? 'use.py' : 'use.ts' });
      expect(diagnostics).toMatchObject({
        complete: true,
        diagnostics: expect.arrayContaining([expect.objectContaining({ severity: 1 })]) as unknown
      });
      const before = await readFile(
        path.join(root, 'workspace', python ? 'use.py' : 'use.ts'),
        'utf8'
      );
      const preview = await call({
        action: 'rename',
        path: python ? 'maths.py' : 'maths.ts',
        line: 1,
        column: python ? 5 : 18,
        newName: 'doubleValue'
      });
      expect(preview).toMatchObject({
        preview: true,
        applied: false,
        files: expect.arrayContaining([
          expect.objectContaining({
            path: python ? 'workspace/use.py' : 'workspace/use.ts',
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
            edits: expect.arrayContaining([
              expect.objectContaining({ newText: 'doubleValue' })
            ]) as unknown
          })
        ]) as unknown
      });
      expect(
        await readFile(path.join(root, 'workspace', python ? 'use.py' : 'use.ts'), 'utf8')
      ).toBe(before);
      await write(
        python ? 'use.py' : 'use.ts',
        python
          ? 'from maths import twice\nanswer: int = twice(4)\n'
          : "import { twice } from './maths';\nconst answer: number = twice(4);\n"
      );
      const corrected = (await call({
        action: 'diagnostics',
        path: python ? 'use.py' : 'use.ts'
      })) as { complete: boolean; diagnostics: Array<{ severity: number }> };
      expect(corrected.complete).toBe(true);
      expect(corrected.diagnostics.filter((entry) => entry.severity === 1)).toEqual([]);
      const stale = preview as { previewId: string; paths: string[] };
      expect(
        await call({ action: 'apply', previewId: stale.previewId, paths: stale.paths })
      ).toMatchObject({ applied: false });
      const fresh = (await call({
        action: 'rename',
        path: python ? 'maths.py' : 'maths.ts',
        line: 1,
        column: python ? 5 : 18,
        newName: 'doubleValue'
      })) as { previewId: string; paths: string[] };
      await call({ action: 'stop' });
      const applied = await call({
        action: 'apply',
        previewId: fresh.previewId,
        paths: fresh.paths
      });
      expect(applied).toMatchObject({ applied: true });
      for (const name of [python ? 'maths.py' : 'maths.ts', python ? 'use.py' : 'use.ts']) {
        const text = await readFile(path.join(root, 'workspace', name), 'utf8');
        expect(text).toContain('doubleValue');
        expect(text).not.toContain('twice');
      }
    },
    60_000
  );

  it('isolates task sessions and expires idle analysis without silently restarting', async () => {
    const { root, manager, advance } = await fixture();
    await manager.act(root, 'a', { action: 'start', language: 'typescript' });
    expect(
      await manager.act(root, 'b', { action: 'status', language: 'typescript' })
    ).toMatchObject({ running: false });
    advance();
    manager.sweep();
    expect(
      await manager.act(root, 'a', { action: 'status', language: 'typescript' })
    ).toMatchObject({ running: false });
    await expect(
      manager.act(root, 'a', { action: 'diagnostics', language: 'typescript', path: 'a.ts' })
    ).rejects.toThrow('No active language session');
  });

  it('refuses source and project symlinks outside the approved workspace', async () => {
    const { root, manager } = await fixture();
    await symlink(path.dirname(root), path.join(root, 'workspace', 'outside'));
    await expect(
      manager.act(root, 'a', { action: 'start', language: 'typescript', root: 'outside' })
    ).rejects.toThrow('real directory');
    await manager.act(root, 'a', { action: 'start', language: 'typescript' });
    await expect(
      manager.act(root, 'a', {
        action: 'diagnostics',
        language: 'typescript',
        path: 'outside/secret.ts'
      })
    ).rejects.toThrow();
  });
});
