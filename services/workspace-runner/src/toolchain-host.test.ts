import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCUMENT_TOOLCHAIN,
  hostPackages,
  installAdvice,
  type HostPackages,
  type ToolchainCapability
} from './toolchain.js';

/**
 * What a missing document capability is closed with, on a host that is not Ubuntu.
 *
 * The report is the one sentence an agent gets telling it how to fix a gap, and it named
 * `apt-get install -y ...` whatever the box was. On the three other families this computer
 * installs on, that sentence named a binary the host has never had and packages under spellings
 * its repositories do not carry - so an agent told what to do could not do it, and would spend a
 * turn finding that out in front of the owner.
 *
 * The table in scripts/garden-host.sh already holds the per-family names for the installer and
 * for `garden doctor`. These tests read the real table, as four different hosts, which is the
 * only way a machine running one family can check the columns for the other three.
 */

const repositoryRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const realTable = path.join(repositoryRoot, 'scripts', 'garden-host.sh');

let workingDirectory: string;

/**
 * The real table, read as a host of our choosing. Only `garden_detect_host` is replaced - the
 * package rows, the awk that reads them and the dash convention are all the shipped ones, so a row
 * that loses a column fails here rather than on somebody's Fedora box.
 */
const asHost = async (family: string, manager: string): Promise<string> => {
  const definitions = path.join(workingDirectory, `${family}.sh`);
  await writeFile(
    definitions,
    `. ${JSON.stringify(realTable)}\ngarden_detect_host() { garden_family=${family}; garden_pm=${manager}; return 0; }\n`
  );
  return definitions;
};

const withHost = (host: HostPackages | undefined): HostPackages => {
  expect(host, 'the host table could not be read as this family').toBeTruthy();
  return host as HostPackages;
};

const capability = (overrides: Partial<ToolchainCapability>): ToolchainCapability => ({
  id: 'test',
  purpose: 'test',
  binaries: [],
  pythonModules: [],
  fonts: [],
  install: 'the host-neutral sentence',
  ...overrides
});

beforeAll(async () => {
  workingDirectory = await mkdtemp(path.join(tmpdir(), 'garden-host-'));
});
afterAll(async () => rm(workingDirectory, { recursive: true, force: true }));

describe('reading the host package table', () => {
  it('answers with the names each family actually uses', async () => {
    const debian = withHost(
      await hostPackages(['imagemagick', 'python-pillow'], await asHost('debian', 'apt-get'))
    );
    expect(debian.manager).toBe('apt-get');
    expect(debian.packages.get('imagemagick')).toBe('imagemagick');
    expect(debian.packages.get('python-pillow')).toBe('python3-pil');

    // The same two capabilities, spelled the way Fedora spells them. A report that answered
    // `imagemagick` here would name a package this host's repositories do not have.
    const rhel = withHost(
      await hostPackages(['imagemagick', 'python-pillow'], await asHost('rhel', 'dnf'))
    );
    expect(rhel.manager).toBe('dnf');
    expect(rhel.packages.get('imagemagick')).toBe('ImageMagick');
    expect(rhel.packages.get('python-pillow')).toBe('python3-pillow');

    const arch = withHost(
      await hostPackages(['office-writer', 'python-pillow'], await asHost('arch', 'pacman'))
    );
    expect(arch.packages.get('office-writer')).toBe('libreoffice-still');

    const suse = withHost(
      await hostPackages(['poppler', 'python-pillow'], await asHost('suse', 'zypper'))
    );
    expect(suse.packages.get('poppler')).toBe('poppler-tools');
    expect(suse.packages.get('python-pillow')).toBe('python3-Pillow');
  });

  it('reports a dash as no package rather than as a package called nothing', async () => {
    const arch = withHost(await hostPackages(['ocrmypdf'], await asHost('arch', 'pacman')));
    expect(arch.packages.has('ocrmypdf')).toBe(false);
    expect(arch.unavailable.has('ocrmypdf')).toBe(true);
  });

  it('says nothing at all rather than guessing when the table cannot be read', async () => {
    expect(
      await hostPackages(['ffmpeg'], path.join(workingDirectory, 'absent.sh'))
    ).toBeUndefined();
    // A file that exists but cannot say what this host is - which is what a laptop and a container
    // without an /etc/os-release both look like.
    const silent = path.join(workingDirectory, 'silent.sh');
    await writeFile(silent, 'garden_detect_host() { return 1; }\n');
    expect(await hostPackages(['ffmpeg'], silent)).toBeUndefined();
  });
});

describe('the sentence a missing capability is closed with', () => {
  it('is a command line this host will actually accept, per family', async () => {
    const media = capability({ id: 'media', packages: ['ffmpeg'] });
    const expectations: [string, string, string][] = [
      ['debian', 'apt-get', 'apt-get install -y ffmpeg'],
      ['rhel', 'dnf', 'dnf install -y ffmpeg-free'],
      ['arch', 'pacman', 'pacman -S --noconfirm ffmpeg'],
      ['suse', 'zypper', 'zypper install -y ffmpeg']
    ];
    for (const [family, manager, expected] of expectations) {
      const host = withHost(await hostPackages(['ffmpeg'], await asHost(family, manager)));
      expect(installAdvice(media, host), `${family} is told to run something it cannot`).toBe(
        expected
      );
    }
  });

  it('falls back to the host-neutral sentence when there is no host to ask', () => {
    expect(installAdvice(capability({ packages: ['ffmpeg'] }), undefined)).toBe(
      'the host-neutral sentence'
    );
    // A capability with nothing in the table - the pinned typst release, the pinned Python
    // environment - has only ever had the neutral sentence, and a resolvable host must not lose it.
    const pinned = capability({ install: 'reinstall the pinned document Python environment' });
    expect(
      installAdvice(pinned, { manager: 'dnf', packages: new Map(), unavailable: new Set() })
    ).toBe('reinstall the pinned document Python environment');
  });

  it('says what this family packages nothing for instead of leaving it out', async () => {
    const extraction = capability({
      id: 'pdf-extraction',
      packages: ['poppler', 'ocrmypdf', 'tesseract']
    });
    const host = withHost(
      await hostPackages(['poppler', 'ocrmypdf', 'tesseract'], await asHost('arch', 'pacman'))
    );
    const advice = installAdvice(extraction, host);
    expect(advice).toContain('pacman -S --noconfirm poppler tesseract');
    expect(advice).toContain("this host's distribution packages nothing for ocrmypdf");
  });

  it('keeps the half no package name expresses', async () => {
    const authoring = capability({
      packages: ['python-docx'],
      beyondPackages: 're-run the garden installer'
    });
    const host = withHost(await hostPackages(['python-docx'], await asHost('rhel', 'dnf')));
    expect(installAdvice(authoring, host)).toBe(
      'dnf install -y python3-docx; re-run the garden installer'
    );
  });
});

describe('the shipped capability list', () => {
  it('names only capabilities the host table has a row for', async () => {
    const table = await readFile(realTable, 'utf8');
    const rows = new Set(
      table
        .split('\n')
        .filter((line) => /^[a-z][a-z0-9-]*\t/.test(line))
        .map((line) => line.split('\t')[0] ?? '')
    );
    expect(rows.size, 'the host table could not be read').toBeGreaterThan(20);
    for (const declared of DOCUMENT_TOOLCHAIN)
      for (const key of declared.packages ?? [])
        expect(
          rows.has(key),
          `${declared.id} names ${key}, which is in no row of the host package table, so this host is told to install nothing for it`
        ).toBe(true);
  });

  /**
   * The regression in one line. Every one of these sentences used to name apt, and this list is
   * read by the model on a box that may have no apt at all. Whatever a family is called, it is the
   * table's job to say so, and never this file's.
   */
  it('names no package manager in a sentence meant for every host', () => {
    expect(DOCUMENT_TOOLCHAIN.length).toBeGreaterThan(0);
    for (const declared of DOCUMENT_TOOLCHAIN)
      for (const sentence of [declared.install, declared.beyondPackages ?? ''])
        expect(
          sentence,
          `${declared.id} names a package manager in a sentence shown to every host`
        ).not.toMatch(/\b(?:apt|apt-get|aptitude|dnf5?|yum|zypper|pacman|apk)\b/);
  });

  it('gives every capability a way out of being missing, resolved or not', () => {
    expect(DOCUMENT_TOOLCHAIN.length).toBeGreaterThan(0);
    for (const declared of DOCUMENT_TOOLCHAIN) {
      expect(installAdvice(declared, undefined).length).toBeGreaterThan(0);
      expect(declared.packages?.length ?? declared.install.length).toBeGreaterThan(0);
    }
  });
});
