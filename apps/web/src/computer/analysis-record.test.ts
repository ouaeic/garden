import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { analysisFilePath, readAnalysisRecord } from './analysis-record';
import AnalysisRunPreview from './AnalysisRunPreview';

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
