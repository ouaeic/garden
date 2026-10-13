import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GARDEN_PYTHON,
  DOCUMENT_TOOLCHAIN,
  parseFontFamilies,
  parseImportableModules,
  probeBinaries,
  probeFonts,
  reportToolchain,
  summariseToolchain,
  toolchainReport,
  type ToolchainCapability
} from './toolchain.js';

const deck: ToolchainCapability = {
  id: 'office-authoring',
  purpose: 'Write .docx, .pptx and .xlsx as real Office files',
  binaries: ['python3'],
  pythonModules: ['pptx', 'docx'],
  fonts: [],
  install: 'apt-get install -y python3-pptx python3-docx'
};

const fonts: ToolchainCapability = {
  id: 'document-fonts',
  purpose: 'Lay out Calibri and Cambria documents at the right metrics',
  binaries: ['fc-list'],
  pythonModules: [],
  fonts: ['Carlito', 'Caladea'],
  install: 'apt-get install -y fonts-crosextra-carlito fonts-crosextra-caladea'
};

const nothing = {
  binaries: new Set<string>(),
  pythonModules: new Set<string>(),
  fonts: new Set<string>()
};

describe('document toolchain report', () => {
  it('names what is missing and the command that would provide it', () => {
    const [report] = reportToolchain([deck], {
      ...nothing,
      binaries: new Set(['python3'])
    });
    expect(report).toMatchObject({
      id: 'office-authoring',
      ready: false,
      missingBinaries: [],
      missingPythonModules: ['pptx', 'docx'],
      install: 'apt-get install -y python3-pptx python3-docx'
    });
  });

  it('reports a capability as ready only when every part of it is there', () => {
    const ready = reportToolchain([deck], {
      ...nothing,
      binaries: new Set(['python3']),
      pythonModules: new Set(['pptx', 'docx'])
    })[0];
    expect(ready).toMatchObject({ ready: true, missingPythonModules: [] });
    // Nothing to install, so nothing is suggested.
    expect(ready?.install).toBe(undefined);
  });

  it('keeps CSV analysis available when the Parquet reader is missing', () => {
    const reports = reportToolchain(DOCUMENT_TOOLCHAIN, {
      ...nothing,
      binaries: new Set([GARDEN_PYTHON]),
      pythonModules: new Set(['pandas', 'numpy', 'matplotlib'])
    });
    expect(reports.find((item) => item.id === 'data-analysis')).toMatchObject({ ready: true });
    expect(reports.find((item) => item.id === 'parquet-data')).toMatchObject({
      ready: false,
      missingPythonModules: ['pyarrow']
    });
  });

  it('checks fonts by family, which is how a document actually finds them', () => {
    const [report] = reportToolchain([fonts], {
      ...nothing,
      binaries: new Set(['fc-list']),
      fonts: new Set(['carlito', 'dejavu sans'])
    });
    expect(report).toMatchObject({ ready: false, missingFonts: ['Caladea'] });
  });

  it('leads with what works, then says what to ask for', () => {
    const summary = summariseToolchain(
      reportToolchain([deck, fonts], {
        ...nothing,
        binaries: new Set(['python3', 'fc-list']),
        pythonModules: new Set(['pptx', 'docx'])
      }),
      [deck, fonts]
    );
    // What is installed, in the names the agent will type.
    expect(summary).toMatch(/^python3; Python modules pptx, docx\./);
    expect(summary).toContain('Missing: document-fonts');
    expect(summary).toContain('fonts-crosextra-caladea');
    expect(summary).toContain('ask before installing');
  });

  it('says so plainly when the box has none of it', () => {
    expect(summariseToolchain(reportToolchain([deck], nothing))).toContain(
      'No document toolchain is installed on this computer.'
    );
  });

  it('names the everyday commands the box has, and only those', () => {
    const summary = summariseToolchain(reportToolchain([deck], nothing), [deck], ['gcc', 'git']);
    expect(summary).toMatch(/^No document toolchain is installed on this computer\./);
    expect(summary).toContain('Commands: gcc, git.');
    expect(summariseToolchain(reportToolchain([deck], nothing), [deck])).not.toContain('Commands');
  });

  it('covers every document and data job the agent is likely to need', () => {
    const ids = DOCUMENT_TOOLCHAIN.map((capability) => capability.id);
    expect(ids).toContain('office-authoring');
    expect(ids).toContain('office-conversion');
    expect(ids).toContain('typeset-pdf');
    expect(ids).toContain('data-analysis');
    expect(ids).toContain('image-work');
    // Every capability has to name a way out of being missing, or the report is only a complaint.
    for (const capability of DOCUMENT_TOOLCHAIN)
      expect(capability.install.length).toBeGreaterThan(0);
  });
});

describe('probe parsing', () => {
  it('reads fontconfig families, including the alias list on one line', () => {
    const families = parseFontFamilies('Carlito\nCaladea,Cambria\nDejaVu Sans\n');
    expect(families.has('carlito')).toBe(true);
    expect(families.has('cambria')).toBe(true);
    expect(families.has('dejavu sans')).toBe(true);
  });

  it('accepts only modules that were asked about', () => {
    const modules = parseImportableModules('pptx\nsys\ndocx\n', ['pptx', 'docx', 'openpyxl']);
    expect([...modules]).toEqual(['pptx', 'docx']);
  });
});

describe('binary probing', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-toolchain-'));
    await mkdir(path.join(root, 'workspace'), { recursive: true });
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('resolves a binary exactly as an agent command would', async () => {
    // /bin/sh is on the agent's own search path on every host this runs on.
    const found = await probeBinaries(root, ['sh', 'garden-not-a-real-binary']);
    expect(found.has('sh')).toBe(true);
    expect(found.has('garden-not-a-real-binary')).toBe(false);
  });

  it('does not count a file the agent could not execute', async () => {
    const binary = `garden-probe-${path.basename(root)}`;
    const tools = path.join(root, 'workspace', '.garden', 'tools', 'node_modules', '.bin');
    await mkdir(tools, { recursive: true });
    await writeFile(path.join(tools, binary), '#!/bin/sh\n');
    await chmod(path.join(tools, binary), 0o644);
    expect((await probeBinaries(root, [binary])).has(binary)).toBe(false);
    await chmod(path.join(tools, binary), 0o755);
    expect((await probeBinaries(root, [binary])).has(binary)).toBe(true);
  });

  // Given longer than the probe's own PROBE_TIMEOUT_MS ceiling, because this one asks the real host
  // rather than a fixture: it starts an interpreter and looks for seven modules, which under a
  // machine running the whole suite in parallel is comfortably slower than vitest's default five
  // seconds. A test that fails only when the machine is busy is a test nobody can trust.
  /*
   * The two probes in this module answer different questions and must not be merged.
   * `probeBinaries` reports what an agent command would find, which is the whole point of the
   * route it serves; `probeFonts` runs what it finds, as the runner, so it may only find what the
   * host installed. This asserts the difference in one case, from a single planted file, so that
   * putting either one back on the other's list fails here.
   */
  it('sees an agent-planted fc-list but will not run it', async () => {
    const tools = path.join(root, 'workspace', '.garden', 'tools', 'node_modules', '.bin');
    await mkdir(tools, { recursive: true });
    const marker = path.join(root, 'fc-list-was-run');
    await writeFile(
      path.join(tools, 'fc-list'),
      `#!/bin/sh\n: > ${JSON.stringify(marker)}\nprintf 'Garden Decoy Sans\\n'\n`
    );
    await chmod(path.join(tools, 'fc-list'), 0o755);

    // A name no host carries, so this half is a statement about `probeBinaries` reading the agent's
    // list rather than about whether this machine happens to have fontconfig in /usr/local/bin.
    await writeFile(path.join(tools, 'garden-planted-probe'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(tools, 'garden-planted-probe'), 0o755);
    expect((await probeBinaries(root, ['garden-planted-probe'])).has('garden-planted-probe')).toBe(
      true
    );

    const families = await probeFonts(root, ['Garden Decoy Sans']);
    expect(families.has('garden decoy sans')).toBe(false);
    expect(existsSync(marker), 'the runner executed an fc-list the agent wrote').toBe(false);
  });

  it('answers for the real host without pretending anything is there', async () => {
    const report = await toolchainReport(root);
    expect(report.capabilities).toHaveLength(DOCUMENT_TOOLCHAIN.length);
    expect(report.ready.length + report.missing.length).toBe(DOCUMENT_TOOLCHAIN.length);
    expect(report.summary.length).toBeGreaterThan(0);
    for (const capability of report.capabilities)
      expect(capability.ready).toBe(
        capability.missingBinaries.length === 0 &&
          capability.missingPythonModules.length === 0 &&
          capability.missingFonts.length === 0
      );
  }, 20_000);
});
