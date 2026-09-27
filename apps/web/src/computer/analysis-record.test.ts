import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { analysisFilePath, readAnalysisRecord } from './analysis-record';
import AnalysisRunPreview from './AnalysisRunPreview';
import { checkedProducer } from './analysis-producer';
import type { WorkspaceTextFile } from './workspace-file';

describe('analysis file locations', () => {
  it('resolves nested manifests inside the current workspace only', () => {
    expect(
      analysisFilePath('workspace/project/records/trial/run.json', '../..', 'data/input.fa')
    ).toBe('workspace/project/data/input.fa');
    expect(analysisFilePath('workspace/run.json', '.', 'result.json')).toBe(
      'workspace/result.json'
    );
    for (const [manifest, directory, file] of [
      ['workspace/run.json', undefined, 'result.json'],
      ['workspace/run.json', '..', 'outside'],
      ['workspace/run.json', '../workspace', 'result.json'],
      ['workspace/../run.json', '.', 'result.json'],
      ['/workspace/run.json', '.', 'result.json'],
      ['workspace/run.json', '.', '../secret'],
      ['workspace/run.json', '.', '/secret'],
      ['workspace/run.json', '.', 'bad\\path']
    ] as const)
      expect(analysisFilePath(manifest, directory, file)).toBeNull();
  });
});

describe('real scientific receipts', () => {
  it('retains checked producer identity from a real dependent run and links only its scoped record', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'garden-lineage-contract-'));
    const runner = resolve(import.meta.dirname, '../../../..', 'scripts/reproducible-run.py');
    try {
      const parent = resolve(directory, 'parent');
      const child = resolve(directory, 'child');
      await mkdir(parent);
      await mkdir(child);
      const base = {
        command: ['python3', 'analysis.py'],
        sources: ['analysis.py'],
        inputs: [] as unknown[],
        outputs: ['result.txt'],
        environment: {
          lockFiles: [],
          runtimeOnly: true,
          probes: [{ name: 'Python', command: ['python3', '--version'] }]
        }
      };
      await writeFile(
        resolve(parent, 'spec.json'),
        JSON.stringify({ ...base, name: 'Raw <counts>' })
      );
      await writeFile(
        resolve(parent, 'analysis.py'),
        "from pathlib import Path\nPath('result.txt').write_text('25')\n"
      );
      execFileSync('python3', [runner, 'run', '--spec', 'spec.json', '--manifest', 'run.json'], {
        cwd: parent
      });
      const upstream = await readFile(resolve(parent, 'run.json'));
      const expectedHash = createHash('sha256').update(upstream).digest('hex');
      const parentRecord = readAnalysisRecord(upstream.toString());
      expect(parentRecord).not.toBeNull();
      await copyFile(resolve(parent, 'result.txt'), resolve(child, 'renamed.txt'));
      await writeFile(resolve(child, 'previous run.json'), upstream);
      await writeFile(
        resolve(child, 'analysis.py'),
        "from pathlib import Path\nPath('result.txt').write_text(str(int(Path('renamed.txt').read_text())*2))\n"
      );
      await writeFile(
        resolve(child, 'spec.json'),
        JSON.stringify({
          ...base,
          inputs: [
            {
              path: 'renamed.txt',
              producer: {
                manifest: 'previous run.json',
                output: 'result.txt',
                sha256: expectedHash
              }
            }
          ]
        })
      );
      execFileSync('python3', [runner, 'run', '--spec', 'spec.json', '--manifest', 'run.json'], {
        cwd: child
      });
      expect(await readFile(resolve(child, 'result.txt'), 'utf8')).toBe('50');
      const record = readAnalysisRecord(await readFile(resolve(child, 'run.json'), 'utf8'));
      expect(record).not.toBeNull();
      expect(record!.before!.inputs[0]!.producer).toEqual({
        manifest: 'previous run.json',
        output: 'result.txt',
        sha256: expectedHash,
        runId: parentRecord!.id,
        name: 'Raw <counts>'
      });
      const file: WorkspaceTextFile = {
        path: 'workspace/child/previous run.json',
        text: upstream.toString(),
        original: upstream.toString(),
        sha: expectedHash,
        truncated: false,
        next: null,
        start: 1,
        end: null,
        binary: false
      };
      const input = record!.before!.inputs[0]!;
      expect(checkedProducer(file, input).id).toBe(parentRecord!.id);
      for (const changed of [
        { sha: null },
        { sha: '0'.repeat(64) },
        { truncated: true },
        { binary: true },
        { original: '{}' }
      ]) {
        expect(() => checkedProducer({ ...file, ...changed }, input)).toThrow();
      }
      for (const changed of [
        { id: '00000000-0000-4000-8000-000000000000' },
        { status: 'running' },
        { exitCode: 1 },
        { dependenciesUnchanged: false },
        { outputsMatchPrevious: false },
        { outputs: [] },
        { outputs: [...parentRecord!.outputs!, ...parentRecord!.outputs!] },
        {
          outputs: parentRecord!.outputs!.map((output) => ({ ...output, bytes: output.bytes + 1 }))
        },
        { outputs: parentRecord!.outputs!.map((output) => ({ ...output, sha256: '0'.repeat(64) })) }
      ]) {
        const content = JSON.stringify({ ...parentRecord, ...changed });
        const sha = createHash('sha256').update(content).digest('hex');
        expect(() =>
          checkedProducer(
            { ...file, original: content, sha },
            { ...input, producer: { ...input.producer!, sha256: sha } }
          )
        ).toThrow();
      }
      const html = renderToStaticMarkup(
        createElement(AnalysisRunPreview, {
          record: record!,
          location: { workspaceId: 'project', manifestPath: 'workspace/child/run.json' }
        })
      );
      expect(html).toContain('Recorded producer');
      expect(html).toContain('Raw &lt;counts&gt;');
      expect(html).toContain(parentRecord!.id);
      expect(html).toContain(expectedHash);
      expect(html).toContain('path=workspace%2Fchild%2Fprevious+run.json');
      expect(html).toContain('does not independently establish origin or result correctness');
      const unlocated = renderToStaticMarkup(
        createElement(AnalysisRunPreview, { record: record! })
      );
      expect(unlocated).not.toContain('Download current producer record');
      expect(unlocated).toContain(parentRecord!.id);
      expect(
        readAnalysisRecord(
          JSON.stringify({
            ...record,
            before: {
              ...record!.before,
              inputs: [
                {
                  ...record!.before!.inputs[0],
                  producer: {
                    ...record!.before!.inputs[0]!.producer,
                    manifest: '../outside.json'
                  }
                }
              ]
            }
          })
        )
      ).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads a native completed receipt and shows a failed replay without inventing verification', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'garden-record-contract-'));
    try {
      const spec = {
        name: 'Result contract',
        command: ['python3', 'analysis.py'],
        sources: ['analysis.py'],
        inputs: [],
        outputs: ['result.txt'],
        environment: {
          lockFiles: [],
          runtimeOnly: true,
          probes: [{ name: 'Python', command: ['python3', '--version'] }]
        }
      };
      await writeFile(resolve(directory, 'spec.json'), JSON.stringify(spec));
      await writeFile(
        resolve(directory, 'analysis.py'),
        "from pathlib import Path\nPath('result.txt').write_text('42\\n')\n"
      );
      execFileSync(
        'python3',
        [
          resolve(import.meta.dirname, '../../../..', 'scripts/reproducible-run.py'),
          'run',
          '--spec',
          'spec.json',
          '--manifest',
          'run.json'
        ],
        { cwd: directory }
      );
      const text = await readFile(resolve(directory, 'run.json'), 'utf8');
      const record = readAnalysisRecord(text);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('completed');
      expect(record!.outputs?.[0]?.bytes).toBe(3);
      const html = renderToStaticMarkup(createElement(AnalysisRunPreview, { record: record! }));
      expect(html).toContain('Recorded: completed');
      expect(html).toContain('Unchanged');
      expect(html).not.toContain('Download current file');
      expect(html).not.toContain('Exact checksum match');
      const mixed = readAnalysisRecord(
        JSON.stringify({
          ...record,
          environmentSetups: [
            { kind: 'python_wheels', directory: '.venv', status: 'ready' },
            { kind: 'r_archives', directory: '.garden/r-library', status: 'installing' },
            { kind: 'conda_packages', directory: '.garden/conda', status: 'ready' }
          ],
          spec: {
            ...record!.spec,
            environment: {
              ...record!.spec.environment,
              r: {
                interpreter: 'R',
                directory: '.garden/r-library',
                packages: [{ path: 'science.tar.gz', sha256: 'a'.repeat(64) }]
              },
              conda: {
                directory: '.garden/conda',
                manager: { path: 'manager/micromamba', sha256: 'b'.repeat(64) },
                packages: [{ path: 'native.conda', sha256: 'c'.repeat(64) }]
              }
            }
          }
        })
      );
      expect(mixed).not.toBeNull();
      const mixedHtml = renderToStaticMarkup(createElement(AnalysisRunPreview, { record: mixed! }));
      expect(mixedHtml).toContain('Python environment');
      expect(mixedHtml).toContain('R library');
      expect(mixedHtml).toContain('Native environment');
      expect(mixedHtml).toContain('Rebuilt from verified local packages');
      expect(mixedHtml).toContain('Preparation incomplete');
      expect(mixedHtml).toContain('.garden/r-library');
      expect(mixedHtml).toContain('.garden/conda');
      expect(
        readAnalysisRecord(
          JSON.stringify({
            ...mixed,
            environmentSetups: [mixed!.environmentSetups![0], mixed!.environmentSetups![0]]
          })
        )
      ).toBeNull();

      const failed = {
        ...record!,
        status: 'failed' as const,
        replayedFrom: record!.id,
        outputsMatchPrevious: false,
        error: 'Output checksums differ from the original run'
      };
      const failure = renderToStaticMarkup(
        createElement(AnalysisRunPreview, {
          record: failed,
          location: { workspaceId: 'project', manifestPath: 'workspace/run.json' }
        })
      );
      expect(failure).toContain('Recorded: failed');
      expect(failure).toContain('Different checksums');
      expect(failure).toContain('path=workspace%2Fresult.txt');
      expect(failure).toContain('contents may have changed');
      expect(
        readAnalysisRecord(text.replace('garden-analysis-run-1', 'garden-analysis-run-2'))
      ).toBeNull();
      expect(readAnalysisRecord('{"format":"garden-analysis-run-1"}')).toBeNull();
      expect(readAnalysisRecord(text + ' '.repeat(262144))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
