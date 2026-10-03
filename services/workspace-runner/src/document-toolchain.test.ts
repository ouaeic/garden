import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GARDEN_PYTHON, DOCUMENT_TOOLCHAIN } from './toolchain.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const script = (name: string) => path.join(repositoryRoot, 'scripts', name);

/**
 * The interpreter the skills name, when this runs on a provisioned computer; otherwise whatever
 * python a developer has, so the proof still exercises what it can on a laptop. The override
 * exists so a developer can point the suite at an environment that has the document libraries.
 */
const resolveInterpreter = (): string => {
  const named = process.env.GARDEN_DOCUMENT_PYTHON;
  if (named) return named;
  if (existsSync(GARDEN_PYTHON)) return GARDEN_PYTHON;
  // Resolved to an absolute path here, once, because one case below narrows PATH to hide
  // LibreOffice - and a bare `python3` would be hidden along with it, so the wrapper under test
  // would never start and the assertion would be about spawning rather than about its message.
  const found = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : 'python3';
};
const python = resolveInterpreter();

const runPython = (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync(python, args, {
    encoding: 'utf8',
    timeout: 900_000,
    cwd: options.cwd,
    env: { ...process.env, ...options.env }
  });

interface ProofCheck {
  name: string;
  detail: string;
}
interface ProofJob {
  id: string;
  status: 'passed' | 'failed' | 'skipped';
  checks: ProofCheck[];
  missing?: string[];
  notExercised?: string[];
  failure?: string;
}
interface ProofReport {
  ok: boolean;
  passed: string[];
  failed: string[];
  skipped: string[];
  jobs: ProofJob[];
}

describe('the document toolchain is declared where the drill can assert it', () => {
  it('covers every job the built-in skills prescribe, each with a way out of being missing', () => {
    const ids = DOCUMENT_TOOLCHAIN.map((capability) => capability.id);
    for (const required of [
      'office-authoring',
      'office-conversion',
      'document-fonts',
      'pdf-assembly',
      'pdf-forms',
      'pdf-extraction',
      'typeset-pdf',
      'data-analysis',
      'statistics',
      'image-work',
      'media'
    ])
      expect(ids).toContain(required);
    for (const capability of DOCUMENT_TOOLCHAIN)
      expect(capability.install.length).toBeGreaterThan(0);
  });

  it('links every runtime capability to a representative workflow contract', () => {
    const result = runPython([script('garden-document-proof'), '--manifest']);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(result.stdout) as { id: string; capabilities: string[] }[];
    expect(manifest.length).toBeGreaterThan(0);
    const declared = new Set(DOCUMENT_TOOLCHAIN.map((capability) => capability.id));
    const exercised = new Set(manifest.flatMap((job) => job.capabilities));
    expect([...exercised].sort()).toEqual([...declared].sort());
    expect(new Set(manifest.map((job) => job.id)).size).toBe(manifest.length);
    for (const job of manifest) expect(job.capabilities.length).toBeGreaterThan(0);
  });

  it('rejects an unknown workflow instead of returning an empty passing report', () => {
    const result = runPython([script('garden-document-proof'), '--only', 'nonexistent-job']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown jobs');
  });

  it('routes every Python capability through the one pinned interpreter', () => {
    // An empty declaration list routes nothing anywhere and passes this in no time at all.
    expect(DOCUMENT_TOOLCHAIN.length).toBeGreaterThan(0);
    for (const capability of DOCUMENT_TOOLCHAIN)
      if (capability.pythonModules.length) expect(capability.binaries).toContain(GARDEN_PYTHON);
  });

  it('names the two vetted commands the skills call rather than the tools underneath them', () => {
    const binaries = DOCUMENT_TOOLCHAIN.flatMap((capability) => capability.binaries);
    expect(binaries).toContain('garden-office-convert');
    expect(binaries).toContain('garden-pdf-tables');
  });
});

describe('garden-office-convert refuses to report a conversion that did not happen', () => {
  let root: string;
  let stub: string;

  const convert = (source: string, target: string, behaviour: string) =>
    runPython([script('garden-office-convert'), source, target], {
      cwd: root,
      env: { GARDEN_SOFFICE: stub, GARDEN_STUB_BEHAVIOUR: behaviour }
    });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-office-'));
    stub = path.join(root, 'soffice-stub');
    // Stands in for LibreOffice so the wrapper's failure handling is proven without one. Each
    // behaviour is a thing LibreOffice genuinely does, including exiting 0 having written nothing.
    await writeFile(
      stub,
      [
        '#!/bin/sh',
        'outdir=""',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in --outdir) outdir="$2"; shift 2 ;; *) shift ;; esac',
        'done',
        'case "$GARDEN_STUB_BEHAVIOUR" in',
        '  silent) exit 0 ;;',
        '  garbage) printf "not a pdf" > "$outdir/input.pdf"; exit 0 ;;',
        '  empty) : > "$outdir/input.pdf"; exit 0 ;;',
        '  good) printf "%%PDF-1.7\\n1 0 obj\\n" > "$outdir/input.pdf"; exit 0 ;;',
        'esac',
        'exit 1'
      ].join('\n')
    );
    await chmod(stub, 0o755);
    await writeFile(path.join(root, 'input.docx'), 'PK stand-in');
  });
  afterAll(async () => rm(root, { recursive: true, force: true }));

  it('writes the file the caller asked for, at the path the caller asked for', () => {
    const result = convert('input.docx', 'proofs/renamed.pdf', 'good');
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(root, 'proofs', 'renamed.pdf'))).toBe(true);
  });

  it('fails when LibreOffice exits 0 having produced nothing, which it does', () => {
    const result = convert('input.docx', 'out-silent.pdf', 'silent');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('produced no output');
    expect(existsSync(path.join(root, 'out-silent.pdf'))).toBe(false);
  });

  it('fails when the bytes written are not the format that was asked for', () => {
    expect(convert('input.docx', 'out-garbage.pdf', 'garbage').stderr).toContain('not a valid pdf');
    expect(convert('input.docx', 'out-empty.pdf', 'empty').stderr).toContain('empty');
  });

  it('refuses a target format nobody vetted rather than guessing a filter', () => {
    const result = convert('input.docx', 'out.rtf', 'good');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not a target this computer converts to');
  });

  it('says what to install when LibreOffice is genuinely absent', () => {
    const result = runPython(
      [
        '-c',
        [
          'import runpy, sys',
          'from unittest.mock import patch',
          'sys.argv = sys.argv[1:]',
          'with patch("os.access", return_value=False), patch("shutil.which", return_value=None):',
          '    runpy.run_path(sys.argv[0], run_name="__main__")'
        ].join('\n'),
        script('garden-office-convert'),
        'input.docx',
        'out.pdf'
      ],
      { cwd: root, env: { GARDEN_SOFFICE: '' } }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('apt-get install -y libreoffice-writer');
  });
});

describe('documents this computer produces, measured', () => {
  let report: ProofReport;
  let workdir: string;

  beforeAll(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'garden-proof-'));
    const result = runPython([
      script('garden-document-proof'),
      '--json',
      '--workdir',
      workdir,
      '--keep'
    ]);
    expect(result.error, `${python} could not run the proof`).toBe(undefined);
    expect(result.stdout, result.stderr).toBeTruthy();
    report = JSON.parse(result.stdout) as ProofReport;
  }, 900_000);
  afterAll(async () => rm(workdir, { recursive: true, force: true }));

  it('produces every document without a single failed measurement', () => {
    const failures = report.jobs
      .filter((job) => job.status === 'failed')
      .map((job) => `${job.id}: ${job.failure}`);
    expect(failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('actually ran something, rather than skipping its way to a pass', () => {
    // A machine with no document toolchain at all is a machine where this suite is meaningless,
    // and silence is how that goes unnoticed.
    expect(
      report.passed.length + report.failed.length,
      `${python} ran no document jobs: ${report.jobs
        .map((job) => `${job.id}: ${(job.missing ?? []).join(', ')}`)
        .join('; ')}. Set GARDEN_DOCUMENT_PYTHON to an environment with document libraries.`
    ).toBeGreaterThan(0);
    // On a laptop "something" is the honest floor: LibreOffice is a gigabyte nobody should have to
    // install to fix a typo. On the runner the floor is everything: `> 0` there would let three
    // of the six jobs - cv, report, tables - skip themselves on every CI run unnoticed. The job in
    // .github/workflows/verify.yml that installs their packages is what lets this be an equality.
    if (process.env.GITHUB_ACTIONS)
      expect(
        report.skipped,
        'a document job skipped itself on CI: install what it names in the `application` job of .github/workflows/verify.yml'
      ).toEqual([]);
    for (const job of report.jobs.filter((entry) => entry.status === 'passed'))
      expect(job.checks.length).toBeGreaterThan(0);
  });

  it('proves each measurement can fail, wherever the job ran', () => {
    // The jobs, not the passes: a box without the toolchain legitimately skips its way past the
    // body below, but a report with no jobs in it at all is a proof run that did not happen, and
    // that must not read the same as one where every measurement demonstrated its own failure.
    expect(report.jobs.length).toBeGreaterThan(0);
    for (const job of report.jobs) {
      if (job.status !== 'passed') continue;
      if (['report', 'tables', 'letter'].includes(job.id)) continue;
      // Every one of these three has a deliberately broken twin. Without it, "one page" and
      // "no overflow" and "zero error cells" are assertions about a document nobody stressed.
      expect(
        job.checks.map((entry) => entry.name),
        `${job.id} passed without demonstrating that its check can fail`
      ).toContain('the check can fail');
    }
  });

  it('names what it could not exercise instead of implying it did', () => {
    expect(report.jobs.length).toBeGreaterThan(0);
    for (const job of report.jobs) {
      if (job.status === 'skipped') expect(job.missing?.length).toBeGreaterThan(0);
      if (job.status === 'passed') expect(Array.isArray(job.notExercised)).toBe(true);
    }
  });
});

/**
 * The one script in this pair an agent reaches by name.
 *
 * `garden-document` is run by the worker at an absolute path it chose; `garden-pdf-tables` is run
 * by the model itself, out of the pdf-extraction skill, through `shell` - so it inherits the
 * agent's own PATH, and the agent can write to directories on it. It resolved poppler with
 * `shutil.which("pdftotext")` when /usr/bin/pdftotext was missing, which is precisely the
 * search-path execution its sibling reader forbids in as many words. A workspace that dropped a
 * file called `pdftotext` on that path had it run, on a page of the owner's own document.
 */
describe('the table reader an agent runs by name', () => {
  let root: string;
  let planted: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-pdf-tables-'));
    planted = path.join(root, 'was-run');
    // What an agent would have written: something named like poppler, on a directory it controls.
    const decoy = path.join(root, 'pdftotext');
    // Written with a redirection rather than by calling `touch`: PATH is narrowed to this
    // directory below, so a stub that shells out to a real command silently does nothing and the
    // "it was never run" assertion passes whether it ran or not.
    await writeFile(decoy, `#!/bin/sh\n: > ${JSON.stringify(planted)}\nexit 0\n`);
    await chmod(decoy, 0o755);
    await writeFile(path.join(root, 'doc.pdf'), '%PDF-1.7\n');
  });
  afterAll(async () => rm(root, { recursive: true, force: true }));

  const run = (pdftotext: string) =>
    runPython([script('garden-pdf-tables'), '--path', 'doc.pdf', '--page', '1'], {
      cwd: root,
      // The override is pointed somewhere on purpose in both cases, so the result does not depend
      // on whether the machine running this suite happens to have poppler in /usr/bin.
      env: { GARDEN_PDFTOTEXT: pdftotext, PATH: root }
    });

  it('says what to install rather than running whatever the search path offers', () => {
    const result = run(path.join(root, 'absent-poppler'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('apt-get install -y poppler-utils');
    // The whole point. A refusal that had quietly run the decoy first would pass every assertion
    // above it and still be the defect.
    expect(existsSync(planted)).toBe(false);
  });

  it('runs the binary the override names, so the refusal above is a decision and not a break', async () => {
    // Without this the case above passes on a script that can no longer run poppler at all: a
    // reader that refuses everything refuses the decoy too.
    const marker = path.join(root, 'override-was-run');
    const stub = path.join(root, 'stub-poppler');
    await writeFile(
      stub,
      `#!/bin/sh\n: > ${JSON.stringify(marker)}\necho "stub poppler declined" >&2\nexit 3\n`
    );
    await chmod(stub, 0o755);
    const result = run(stub);
    expect(existsSync(marker)).toBe(true);
    expect(result.stderr).toContain('stub poppler declined');
    expect(result.stderr).not.toContain('apt-get install -y poppler-utils');
    expect(existsSync(planted)).toBe(false);
  });
});
