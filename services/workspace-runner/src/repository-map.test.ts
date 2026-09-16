import { execFileSync } from 'node:child_process';
import { execute, ExecRequest } from './execution.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RepositoryMapper } from './repository-map.js';
import { parseRepositorySource } from './repository-parser.js';

const rgBinary = execFileSync('/usr/bin/which', ['rg'], { encoding: 'utf8' }).trim();
const nativeMapper = () =>
  new RepositoryMapper((root, input, options) => {
    const request = ExecRequest.parse(input);
    return execute(
      root,
      { ...request, executable: request.executable === 'rg' ? rgBinary : request.executable },
      options
    );
  });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'garden-repository-')));
  roots.push(root);
  await mkdir(path.join(root, 'workspace'));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, 'workspace', name)), { recursive: true });
    await writeFile(path.join(root, 'workspace', name), source);
  }
  return root;
}
const sources = {
  typescript: {
    code: '/* function bogus() {} */\nexport const add = (a: number, b: number) => a + b;\nexport class Sum {\n  compute() { return add(2, 3); }\n}',
    definitions: ['add', 'Sum', 'compute'],
    caller: 'Sum.compute',
    called: 'add'
  },
  python: {
    code: 'text = """\ndef bogus(): pass\n"""\ndef add(\n a,\n b\n):\n return a+b\nclass Sum:\n def compute(self):\n  return add(2,3)\n',
    definitions: ['text', 'add', 'Sum', 'compute'],
    caller: 'Sum.compute',
    called: 'add'
  },
  r: {
    code: '# fake <- function(x) x\nadd <- function(x, y) { x+y }\ncompute <- function() { add(2,3) }\n',
    definitions: ['add', 'compute'],
    caller: 'compute',
    called: 'add'
  },
  cpp: {
    code: '// int bogus() { return 0; }\nint add(int a, int b) { return a+b; }\nclass Sum { public: int compute() { return add(2,3); } };\n',
    definitions: ['add', 'Sum', 'compute'],
    caller: 'Sum.compute',
    called: 'add'
  }
};

describe('structural definitions and call locations', () => {
  it.each(Object.entries(sources))(
    'parses %s declarations and callers without treating comments or strings as code',
    async (language, sample) => {
      const result = await parseRepositorySource(language, sample.code);
      expect(result.errors).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.definitions.map((item) => item.name)).toEqual(sample.definitions);
      expect(result.calls).toContainEqual(
        expect.objectContaining({ name: sample.called, caller: sample.caller })
      );
      expect(result.definitions.length).toBeGreaterThan(0);
      for (const item of result.definitions) {
        expect(item.line).toBeGreaterThan(0);
        expect(item.endLine).toBeGreaterThanOrEqual(item.line);
      }
    }
  );

  it('retains import aliases and distinguishes qualified calls', async () => {
    const result = await parseRepositorySource(
      'typescript',
      'import {\n add as combine\n} from "./maths.js";\nfunction run() { combine(2,3); other.add(4,5); }'
    );
    expect(result.imports).toEqual([{ name: 'add', alias: 'combine', from: './maths.js' }]);
    expect(result.calls).toContainEqual(
      expect.objectContaining({ name: 'add', qualifier: 'other', caller: 'run' })
    );
    const python = await parseRepositorySource(
      'python',
      'from maths import add as combine\ndef run():\n return obj.method(combine(1,2))'
    );
    expect(python.imports).toEqual([{ name: 'add', alias: 'combine', from: 'maths' }]);
    expect(python.calls).toContainEqual(
      expect.objectContaining({ name: 'method', qualifier: 'obj' })
    );
  });

  it('reports syntax errors and bounds oversized source', async () => {
    expect((await parseRepositorySource('typescript', 'function broken( {')).errors).toBe(true);
    await expect(parseRepositorySource('typescript', 'x'.repeat(512 * 1024 + 1))).rejects.toThrow(
      'per-file'
    );
  });
});

it('ranks a mixed-language tree, links aliases, and invalidates edits, renames and deletions', async () => {
  const root = await fixture({
    'maths.ts': sources.typescript.code,
    'caller.ts':
      'import { add as combine } from "./maths.js";\nexport function run() { return combine(1,2); }',
    'science.py': sources.python.code,
    'analysis.R': sources.r.code,
    'native.cpp': sources.cpp.code
  });
  const mapper = nativeMapper();
  try {
    const request = { path: 'workspace', query: 'add', maxSymbols: 40 };
    const first = await mapper.map(root, request, { maximumSeconds: 30 });
    expect(first.coverage).toMatchObject({
      filesParsed: 5,
      scanComplete: true,
      parseErrors: [],
      skipped: [],
      cacheHits: 0
    });
    const add = first.importantSymbols.find(
      (item) => item.name === 'add' && item.path === 'maths.ts'
    );
    expect(add).toBeDefined();
    expect(add!.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(add!.candidateCallers).toContainEqual({ path: 'caller.ts', line: 2, caller: 'run' });
    expect(
      first.importantSymbols
        .filter((item) => item.name === 'add')
        .map((item) => path.extname(item.path))
        .sort()
    ).toEqual(['.R', '.cpp', '.py', '.ts']);
    expect((await mapper.map(root, request, { maximumSeconds: 30 })).coverage.cacheHits).toBe(5);
    await rename(path.join(root, 'workspace/maths.ts'), path.join(root, 'workspace/moved.ts'));
    await rm(path.join(root, 'workspace/science.py'));
    await writeFile(path.join(root, 'workspace/analysis.R'), 'renamed <- function(x) x * 2\n');
    const next = await mapper.map(root, request, { maximumSeconds: 30 });
    expect(next.coverage.filesParsed).toBe(4);
    expect(next.coverage.cacheHits).toBe(3);
    expect(
      next.importantSymbols.some((item) => ['maths.ts', 'science.py'].includes(item.path))
    ).toBe(false);
    expect(next.importantSymbols.find((item) => item.path === 'analysis.R')?.name).toBe('renamed');
    expect(
      next.importantSymbols
        .find((item) => item.path === 'moved.ts' && item.name === 'add')
        ?.candidateCallers.some((call) => call.path === 'caller.ts')
    ).toBe(false);
  } finally {
    mapper.close();
  }
}, 30_000);

it('reports incomplete coverage and refuses outside roots and symbolic links', async () => {
  const root = await fixture({
    'real.ts': 'export function real() {}',
    'large.py': 'x'.repeat(512 * 1024 + 1),
    'broken.ts': 'function bad( {',
    'other.go': 'package main\nfunc main() {}'
  });
  await writeFile(path.join(root, 'private.ts'), 'function privateSecret() {}');
  await symlink('../private.ts', path.join(root, 'workspace/leak.ts'));
  const mapper = nativeMapper();
  try {
    const result = await mapper.map(root, { path: 'workspace' }, { maximumSeconds: 30 });
    expect(result.coverage.scanComplete).toBe(false);
    expect(result.coverage.unsupportedSourceFiles).toBe(1);
    expect(result.coverage.parseErrors).toContain('broken.ts');
    expect(result.coverage.skipped).toContainEqual(expect.objectContaining({ path: 'large.py' }));
    expect(result.importantSymbols.some((item) => item.name === 'privateSecret')).toBe(false);
    await expect(mapper.map(root, { path: '../' }, { maximumSeconds: 30 })).rejects.toThrow();
    await symlink(os.tmpdir(), path.join(root, 'workspace/outside'));
    await expect(
      mapper.map(root, { path: 'workspace/outside' }, { maximumSeconds: 30 })
    ).rejects.toThrow();
  } finally {
    mapper.close();
  }
}, 30_000);

it('requires file-read authority bound to the exact workspace', async () => {
  const { default: Fastify } = await import('fastify');
  const { authenticateRunnerRequest } = await import('./auth.js');
  const { registerRepositoryMapRoute } = await import('./repository-map.js');
  const { signCapabilityToken, capabilityAudience } = await import('@athanor/core');
  const { randomUUID } = await import('node:crypto');
  const workspaceId = randomUUID(),
    secret = 'repository-map-test-secret-at-least-thirty-two',
    url = `/v1/workspaces/${workspaceId}/repository-map`;
  const calls: unknown[] = [];
  const app = Fastify();
  app.addHook('preHandler', authenticateRunnerRequest(secret));
  registerRepositoryMapRoute(
    app,
    '/tmp/projects',
    {
      map: async (...args: unknown[]) => {
        calls.push(args);
        return { engine: 'tree-sitter' };
      }
    } as unknown as RepositoryMapper,
    { maximumSeconds: 30 }
  );
  const auth = (scopes: string[], workspace = workspaceId) => ({
    authorization: `Bearer ${signCapabilityToken({ sub: 'task', workspaceId: workspace, role: 'agent', scopes, nonce: randomUUID(), aud: capabilityAudience('POST', url) }, secret, 60)}`
  });
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: auth(['exec']),
          payload: { path: 'workspace' }
        })
      ).statusCode
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: auth(['files.read'], randomUUID()),
          payload: { path: 'workspace' }
        })
      ).statusCode
    ).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: auth(['files.read']),
          payload: { path: 'workspace' }
        })
      ).statusCode
    ).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([`/tmp/projects/${workspaceId}`, { path: 'workspace' }])
    );
  } finally {
    await app.close();
  }
});

it('keeps exported schema values and does not rank unrelated receiver methods as callers', async () => {
  const parsed = await parseRepositorySource(
    'typescript',
    `export const Schema = z.object({ value: z.string() });
export function validate() { return Schema.parse({ value: "x" }); }`
  );
  expect(parsed.definitions).toContainEqual(
    expect.objectContaining({ name: 'Schema', kind: 'value' })
  );
  const root = await fixture({
    'actual.ts': 'export function parse() {}',
    'use.ts': 'export function run() { return unrelated.parse(); }',
    'py.py': `def parse(): pass
def main(): parse()`
  });
  const mapper = nativeMapper();
  try {
    const result = await mapper.map(
      root,
      { path: 'workspace', query: 'parse' },
      { maximumSeconds: 30 }
    );
    expect(
      result.importantSymbols.find((symbol) => symbol.path === 'actual.ts')?.candidateCallers
    ).toEqual([]);
  } finally {
    mapper.close();
  }
});

it('resolves Python module aliases and excludes unrelated external imports', async () => {
  const root = await fixture({
    'science/maths.py': 'def normalize(x): return x',
    'other.py': 'def normalize(x): return x * 2',
    'science/run.py': 'from .maths import normalize as norm\ndef run(): return norm(1)',
    'caller.py': 'from science.maths import normalize\ndef run(): return normalize(2)',
    'local.ts': 'export function open() {}',
    'external.ts': 'import { open } from "node:fs";\nexport function run() { open("x"); }'
  });
  const mapper = nativeMapper();
  try {
    const result = await mapper.map(root, { path: 'workspace' }, { maximumSeconds: 30 });
    const symbols = result.importantSymbols;
    expect(symbols.find((symbol) => symbol.path === 'science/maths.py')?.candidateCallers).toEqual([
      { path: 'caller.py', line: 2, caller: 'run' },
      { path: 'science/run.py', line: 2, caller: 'run' }
    ]);
    expect(symbols.find((symbol) => symbol.path === 'other.py')?.candidateCallers).toEqual([]);
    expect(symbols.find((symbol) => symbol.path === 'local.ts')?.candidateCallers).toEqual([]);
  } finally {
    mapper.close();
  }
});

it('reserves concurrent scans before directory IO and releases them on failure', async () => {
  const root = await fixture({ 'source.ts': 'export const value = 1;' });
  const mapper = nativeMapper();
  const results = await Promise.allSettled([
    mapper.map(root, { path: 'workspace' }, { maximumSeconds: 30 }),
    mapper.map(root, { path: 'workspace' }, { maximumSeconds: 30 }),
    mapper.map(root, { path: 'workspace' }, { maximumSeconds: 30 })
  ]);
  try {
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = results[2];
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status !== 'rejected') throw new Error('The excess scan was admitted');
    const reason: unknown = rejected.reason;
    expect(reason).toBeInstanceOf(Error);
    expect(String(reason)).toContain('busy');
    await expect(
      mapper.map(root, { path: 'workspace/missing' }, { maximumSeconds: 30 })
    ).rejects.toThrow();
    expect(
      (await mapper.map(root, { path: 'workspace' }, { maximumSeconds: 30 })).coverage.filesParsed
    ).toBe(1);
    mapper.close();
    await expect(mapper.map(root, { path: 'workspace' }, { maximumSeconds: 30 })).rejects.toThrow(
      'closed'
    );
  } finally {
    mapper.close();
  }
});
