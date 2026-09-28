import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  builtinSkillLibrary,
  estimateSkillTokens,
  isBuiltinSkillName,
  isValidSkillName,
  loadSkillLibrary,
  openSkill,
  parseSkillFrontMatter,
  parseSkillYaml,
  quoteColonScalars,
  scanSkillBodyForPaths,
  scanSkillBodyForSecrets,
  skillCatalogBlock,
  ownerSkillRoots,
  withOwnerSkills,
  OWNER_SKILL_ROOTS_ENV,
  SKILL_BODY_HEADINGS,
  SKILL_BUDGET,
  type SkillLibrary
} from './skills.js';
import { agentTools } from './tools.js';

// Assembled rather than written whole, the way packages/core/src/redaction.test.ts does it
// and for the reason stated there: the run-time value is exactly the shape a credential
// scanner hunts for, which is the point of the fixture, and a literal of that shape in a
// public repository is an alert somebody has to dismiss.
const shapedSecret = (...parts: string[]): string => parts.join('');

const roots: string[] = [];

const fixtureRoot = (
  skills: Record<string, { skill: string; sidecar?: string; resources?: string[] }>
): string => {
  const root = mkdtempSync(join(tmpdir(), 'garden-skills-'));
  roots.push(root);
  for (const [name, files] of Object.entries(skills)) {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), files.skill);
    if (files.sidecar !== undefined) writeFileSync(join(directory, 'garden.yaml'), files.sidecar);
    for (const resource of files.resources ?? []) {
      mkdirSync(join(directory, resource.split('/')[0] ?? 'scripts'), { recursive: true });
      writeFileSync(join(directory, resource), '#\n');
    }
  }
  return root;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const skillFile = (name: string, description: string, body = 'Body.'): string =>
  `---\nname: ${name}\ndescription: ${description}\nlicense: AGPL-3.0-or-later\nallowed-tools: shell file_read\nmetadata:\n  garden.tier: 'builtin'\n  garden.version: '2.1.0'\n  garden.risk: 'workspace'\n  garden.domain: 'testing'\n---\n\n${body}\n`;

const sidecarFile = (id: string, extra = ''): string =>
  `schema: 1\nid: ${id}\nversion: 2.1.0\ncatalog_line: 'Short resident line for ${id}.'\nlineage:\n  parent: null\n  origin: builtin\n  approved_by: null\n  approved_at: null\nrequires:\n  tools: [shell, file_read]\n  binaries: [python3]\ncapability:\n  fs.read: ['$WORKSPACE/**']\n  fs.write: ['$WORKSPACE/**']\n  net.hosts: []\n  exec: [python3]\n  connectors: []\n  spend: none\nverify:\n  - run: 'python3 check.py'\n    assert: "$.status == 'success'"\n  - check: 'Someone looked at it.'\n${extra}`;

describe('skill YAML subset', () => {
  it('parses nested maps, block sequences of mappings, flow collections and comments', () => {
    const parsed = parseSkillYaml(
      [
        'schema: 1',
        'id: demo # trailing comment',
        'lineage:',
        '  parent: null',
        '  origin: builtin',
        'requires:',
        '  tools: [shell, file_read]',
        'verify:',
        "  - run: 'python3 check.py'",
        '    assert: "$.error_cells == 0"',
        '  - render: { source: out.pdf, dpi: 120 }',
        '  - vision:',
        '      must:',
        "        - 'no truncated columns'",
        'flags:',
        '  strict: true',
        '  retries: 3'
      ].join('\n')
    );
    expect(parsed.schema).toBe(1);
    expect(parsed.id).toBe('demo');
    expect(parsed.lineage).toEqual({ parent: null, origin: 'builtin' });
    expect(parsed.requires).toEqual({ tools: ['shell', 'file_read'] });
    expect(parsed.verify).toEqual([
      { run: 'python3 check.py', assert: '$.error_cells == 0' },
      { render: { source: 'out.pdf', dpi: 120 } },
      { vision: { must: ['no truncated columns'] } }
    ]);
    expect(parsed.flags).toEqual({ strict: true, retries: 3 });
  });

  it('recovers a document whose unquoted scalar contains a colon', () => {
    // The standard cross-client failure: a description with ": " in it. Skipping the skill would
    // silently drop a good procedure, so parsing retries once with those scalars quoted.
    const source = 'name: demo\ndescription: Build a report: with a colon in it\n';
    expect(quoteColonScalars(source)).toContain("'Build a report: with a colon in it'");
    expect(parseSkillYaml(source).description).toBe('Build a report: with a colon in it');
  });

  it('reads a flow sequence a formatter has wrapped across several lines', () => {
    // Prettier reflows any inline list past its print width. Before this was handled, running the
    // repository formatter silently dropped the two skills with the longest tool lists.
    const parsed = parseSkillYaml(
      [
        'requires:',
        '  tools:',
        '    [',
        '      repo_overview,',
        '      code_search,',
        '      file_patch',
        '    ]',
        '  binaries: []',
        'inline: [a,',
        '  b]'
      ].join('\n')
    );
    expect(parsed.requires).toEqual({
      tools: ['repo_overview', 'code_search', 'file_patch'],
      binaries: []
    });
    expect(parsed.inline).toEqual(['a', 'b']);
  });

  it('splits front matter from the body', () => {
    const parsed = parseSkillFrontMatter(skillFile('demo', 'Do a thing.', '# Heading\n\ntext'));
    expect(parsed.data.name).toBe('demo');
    expect(parsed.data.metadata).toMatchObject({ 'garden.version': '2.1.0' });
    expect(parsed.body).toBe('# Heading\n\ntext');
    expect(() => parseSkillFrontMatter('no front matter')).toThrow(/front matter/);
  });
});

describe('skill library loader', () => {
  it('loads a skill with its sidecar and normalised verify steps', () => {
    const root = fixtureRoot({
      alpha: {
        skill: skillFile('alpha', 'Does alpha work. Use when alpha. Do not use for beta.'),
        sidecar: sidecarFile('alpha'),
        resources: ['scripts/check.py', 'references/NOTES.md']
      }
    });
    const library = loadSkillLibrary(root);
    expect(library.diagnostics).toEqual([]);
    const [skill] = library.skills;
    expect(skill?.version).toBe('2.1.0');
    expect(skill?.catalogLine).toBe('Short resident line for alpha.');
    expect(skill?.requiredBinaries).toEqual(['python3']);
    expect(skill?.capability.exec).toEqual(['python3']);
    expect(skill?.verify).toEqual([
      { run: 'python3 check.py', assert: "$.status == 'success'", check: null },
      { run: null, assert: null, check: 'Someone looked at it.' }
    ]);
  });

  it('loads leniently and logs loudly instead of failing the whole library', () => {
    const root = fixtureRoot({
      good: { skill: skillFile('good', 'Fine.'), sidecar: sidecarFile('good') },
      'no-description': {
        skill: `---\nname: no-description\ndescription: ''\n---\n\nbody`,
        sidecar: sidecarFile('no-description')
      },
      'bad-yaml': {
        skill: skillFile('bad-yaml', 'Fine.'),
        sidecar: 'capability:\n  exec: [python3\n'
      },
      renamed: { skill: skillFile('other-name', 'Fine.'), sidecar: sidecarFile('renamed') }
    });
    const library = loadSkillLibrary(root);
    const names = library.skills.map((skill) => skill.name);
    expect(names).toEqual(['good', 'renamed']);
    expect(library.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skill: 'no-description', code: 'description_missing' }),
        expect.objectContaining({ skill: 'bad-yaml', code: 'sidecar_unparseable' }),
        expect.objectContaining({ skill: 'renamed', level: 'warn', code: 'name_mismatch' })
      ])
    );
  });

  it('hard rejects a non-builtin skill that reaches past its origin ceiling', () => {
    const root = fixtureRoot({
      greedy: {
        skill: skillFile('greedy', 'Wants everything.'),
        sidecar: `schema: 1\nid: greedy\nversion: 1.0.0\nlineage:\n  origin: learned\n  approved_by: 'owner-1'\n  approved_at: '2026-07-14'\ncapability:\n  net.hosts: ['*']\n  spend: metered\n  fs.write: ['/etc/**']\n`
      }
    });
    const library = loadSkillLibrary(root);
    expect(library.skills).toEqual([]);
    const [diagnostic] = library.diagnostics;
    expect(diagnostic?.code).toBe('capability_ceiling');
    expect(diagnostic?.message).toMatch(/net.hosts/);
    expect(diagnostic?.message).toMatch(/metered/);
    expect(diagnostic?.message).toMatch(/\$WORKSPACE/);
  });

  it('returns an empty library rather than throwing when the directory is absent', () => {
    const library = loadSkillLibrary(join(tmpdir(), 'garden-skills-does-not-exist'));
    expect(library.skills).toEqual([]);
    expect(library.diagnostics).toEqual([]);
  });
});

describe('progressive disclosure', () => {
  const library = (): SkillLibrary =>
    loadSkillLibrary(
      fixtureRoot({
        alpha: {
          skill: skillFile('alpha', 'Builds spreadsheets with formulas.', 'ALPHA_BODY_MARKER'),
          sidecar: sidecarFile('alpha'),
          resources: ['scripts/check.py']
        },
        beta: {
          skill: skillFile('beta', 'Edits video with ffmpeg.', 'BETA_BODY_MARKER'),
          sidecar: sidecarFile('beta')
        }
      })
    );

  it('keeps bodies and full descriptions out of the resident catalog', () => {
    const block = skillCatalogBlock(library());
    expect(block).toContain('- alpha: Short resident line for alpha.');
    expect(block).not.toContain('ALPHA_BODY_MARKER');
    expect(block).not.toContain('Builds spreadsheets with formulas.');
  });

  it('wraps an opened skill so compaction can protect it, and says how its own files are reached', () => {
    const opened = openSkill(library(), 'alpha');
    expect(opened?.block).toMatch(/^<skill name="alpha" version="2\.1\.0" origin="builtin">/);
    expect(opened?.block).toContain('ALPHA_BODY_MARKER');
    expect(opened?.block).toContain('<skill_grants>shell file_read</skill_grants>');
    expect(opened?.block.trimEnd().endsWith('</skill>')).toBe(true);
    // `scripts/check.py` is on disk in this fixture and is deliberately not advertised as a
    // readable resource: the directory it sits in is outside every workspace, so `file_read`
    // refuses it. What the model gets instead is the directory and how to use it (ATH-116).
    expect(opened?.block).not.toContain('<file>');
    expect(opened?.block).toContain(`Skill directory: ${opened?.directory}`);
    expect(opened?.block).toContain('prefix one with it to reach the file');
    expect(openSkill(library(), 'nope')).toBeNull();
  });

  it('refuses to re-inject a skill that is already open in this task', () => {
    const opened = openSkill(library(), 'alpha', { active: ['alpha'] });
    expect(opened?.block).toContain('state="already_open"');
    expect(opened?.block).not.toContain('ALPHA_BODY_MARKER');
  });

  it('costs nothing in the cached prefix when the probe finds nothing missing', () => {
    /*
     * The opened block is a tool result the provider caches, so the missing-dependency warning has
     * to be free when there is nothing to warn about.
     *
     * This is the property that has to survive widening the probe. `<skill_missing_binaries>` today
     * reports binaries only, so a skill whose real dependency is a Python module - `docx` on Arch
     * and openSUSE, where the distribution has no package for it - opens with no warning at all
     * and the procedure is followed until it fails. Widening the probe to modules is the fix, and
     * the trap in it is that a widened probe which emits an empty element, a blank line or a
     * "nothing missing" sentence changes the bytes of every opened block on every healthy box -
     * moving the divergence point in a cached prefix for a message that says nothing.
     *
     * So: an empty probe result must be byte-identical to no probe result, at every spelling of
     * empty. A non-empty one is the only thing that may add bytes, and then only its own.
     */
    // One library, because a fresh fixture root would move the skill directory the block prints
    // and the comparison would be of two different blocks rather than of the probe's cost.
    const loaded = library();
    const baseline = openSkill(loaded, 'alpha')?.block;
    expect(baseline).toBeTypeOf('string');
    // Every spelling of empty: no options object at all, an options object with no probe result,
    // and a probe result that ran and found nothing.
    expect(openSkill(loaded, 'alpha', {})?.block).toBe(baseline);
    expect(openSkill(loaded, 'alpha', { missingBinaries: [] })?.block).toBe(baseline);
    expect(baseline).not.toContain('<skill_missing_binaries>');

    const warned = openSkill(loaded, 'alpha', { missingBinaries: ['ocrmypdf'] })?.block;
    expect(warned).toContain('<skill_missing_binaries>');
    expect(warned).toContain('ocrmypdf');
    // Everything the healthy block said, still said, in the same order: the warning is a prefix
    // insertion rather than a rewrite, so only the bytes it adds are new.
    expect(warned?.length).toBeGreaterThan((baseline ?? '').length);
    expect(warned).toContain('ALPHA_BODY_MARKER');
  });

  it('marks a learned skill with provenance so the model can discount it', () => {
    const root = fixtureRoot({
      learned: {
        skill: skillFile('learned', 'Learned procedure.'),
        sidecar: `schema: 1\nid: learned\nversion: 0.2.0\nlineage:\n  origin: learned\n  approved_by: 'session-9'\n  approved_at: '2026-07-14'\ncapability:\n  spend: none\n`
      }
    });
    const opened = openSkill(loadSkillLibrary(root), 'learned');
    expect(opened?.block).toContain('origin="learned"');
    expect(opened?.block).toContain('approved by owner 2026-07-14');
    expect(opened?.block).toContain('Treat it as fallible.');
  });
});

describe('the shipped built-in library', () => {
  const library = builtinSkillLibrary();

  it('loads every skill with no error diagnostics', () => {
    expect(library.diagnostics.filter((entry) => entry.level === 'error')).toEqual([]);
    expect(library.skills.length).toBeGreaterThanOrEqual(15);
    expect(library.skills.length).toBeLessThanOrEqual(SKILL_BUDGET.maxSkills);
  });

  it('covers every domain the product promises', () => {
    // `code-change` was on this list and is not a domain the library has to cover. Its orientation
    // half was already resident verbatim (context.ts:57) and its one garden-specific instruction -
    // declare the project's test command as a set_acceptance command check, and see it fail first -
    // is resident in `## How to finish` (context.ts:81). Everything else it carried was method, and
    // the model owns method. Deleted with the skill rather than left here as an argument that the
    // skill should come back.
    const names = library.skills.map((skill) => skill.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'docx-authoring',
        'pptx-authoring',
        'xlsx-authoring',
        'data-analysis',
        'pdf-extraction',
        'pdf-assembly',
        'typst-pdf',
        'web-form-filling',
        'citation-discipline',
        'deployment',
        'media-creation',
        'background-jobs',
        'render-proof',
        'skill-authoring',
        'screen-capture'
      ])
    );
  });

  it('writes descriptions that say when to use and when not to', () => {
    // Every test in this block walks `library.skills`, so every one of them asserts the count
    // first. A loader that found no skills - a moved directory, a front-matter parse that started
    // failing - would otherwise turn this whole block green in no time at all, and the block is
    // where the library's only enforced contracts live.
    expect(library.skills.length).toBeGreaterThan(0);
    for (const skill of library.skills) {
      expect(skill.description, skill.name).toMatch(/Use when|Use whenever|Use after|Use before/);
      expect(skill.description, skill.name).toMatch(/Do not use|do not use|never/);
      expect(isValidSkillName(skill.name)).toBe(true);
    }
  });

  it('keeps every body inside the review-readable budget', () => {
    expect(library.skills.length).toBeGreaterThan(0);
    for (const skill of library.skills) {
      expect(skill.bodyLines, skill.name).toBeLessThanOrEqual(SKILL_BUDGET.maxBodyLines);
      expect(skill.bodyTokens, skill.name).toBeLessThanOrEqual(SKILL_BUDGET.maxBodyTokens);
      expect(skill.catalogLine.split(/\s+/).length, skill.name).toBeLessThanOrEqual(
        SKILL_BUDGET.maxCatalogWords
      );
    }
  });

  it('declares a verification contract and a bounded capability grant for every skill', () => {
    expect(library.skills.length).toBeGreaterThan(0);
    for (const skill of library.skills) {
      expect(skill.verify.length, skill.name).toBeGreaterThan(0);
      expect(skill.requiredTools.length, skill.name).toBeGreaterThan(0);
      expect(skill.capability.netHosts, skill.name).not.toContain('*');
      expect(skill.capability.fsWrite, skill.name).not.toContain('/**');
    }
  });

  it('names only tools that exist, in both places a skill declares them', () => {
    // openSkill sends `requires.tools` to the model as <skill_grants>, so a name that no longer
    // exists teaches it a capability it does not have, and one the front matter lists but the
    // sidecar omits is a step of the procedure the grants line silently disowns. The two
    // declarations are the same set said twice, so they are checked against each other and against
    // the real catalogue.
    const catalog = new Set(agentTools.map((tool) => tool.name));
    expect(library.skills.length).toBeGreaterThan(0);
    expect(catalog.size).toBeGreaterThan(0);
    for (const skill of library.skills) {
      for (const tool of [...skill.requiredTools, ...skill.allowedTools])
        expect(catalog.has(tool), `${skill.name} names a tool that does not exist: ${tool}`).toBe(
          true
        );
      expect([...skill.allowedTools].sort(), skill.name).toEqual([...skill.requiredTools].sort());
    }
  });

  it('advertises no file to the model that the model has no tool able to open', () => {
    /*
     * The whole library, both directions, because one direction was how this was missed.
     *
     * `openSkill` used to scan four folders under the skill directory and print each entry as
     * `<file>scripts/count_error_cells.py</file>`. Nothing the model holds can read one. `openSkill`
     * is reachable only for built-in skills, so the directory is always part of the garden
     * installation and never inside a workspace; `file_read` is answered by the runner, whose
     * `assertUserDataPath` admits `workspace/` and `.garden/artifacts/` and nothing else. So the
     * model was handed a list of readable-looking files, two lines under an absolute directory that
     * answers "Only workspace files and published artifacts are accessible" when it tries one -
     * a vetted procedure prescribing a step the platform refuses (ATH-116).
     *
     * Direction one: nothing in any opened block may offer a file as a resource.
     */
    expect(library.skills.length).toBeGreaterThan(0);
    for (const skill of library.skills) {
      const opened = openSkill(library, skill.name);
      expect(opened, skill.name).not.toBeNull();
      expect(opened?.block, skill.name).not.toContain('<file>');
      expect(opened?.block, skill.name).not.toContain('<skill_resources>');
      // The directory is still printed - a command can reach it, which is what these files are for
      // - and it must arrive with the sentence saying which tools do and which do not.
      expect(opened?.block, skill.name).toContain(`Skill directory: ${skill.directory}`);
      expect(opened?.block, skill.name).toContain('not against workspace/ where your commands run');
    }
  });

  it('names no file in a procedure that does not ship with the skill that names it', () => {
    /*
     * Direction two, and the half that has to keep working now that the enumeration is gone.
     *
     * A skill's scripts are for running, not reading: the agent sandbox drops privilege to another
     * Unix account rather than entering a mount namespace, so a command that names a path under the
     * skill directory opens it. What the model needs is that the file is really there and that the
     * block tells it how to build the path - which the sentence above does, for every skill,
     * including ones written after this test.
     *
     * So every resource-shaped relative path the model is shown, whether it came from the procedure
     * body or from a `verify` step, has to exist under the skill that showed it. Today exactly one
     * does (`xlsx-authoring`'s recalculation check, named in both its body and its sidecar), and a
     * skill that grows a second one gets the same guarantee without anyone remembering to ask.
     */
    const resourcePath = /(?<![\w./-])(?:scripts|references|assets|evals)\/[A-Za-z0-9._/-]+/g;
    let checked = 0;
    for (const skill of library.skills) {
      const opened = openSkill(library, skill.name);
      for (const match of new Set((opened?.block ?? '').match(resourcePath) ?? [])) {
        checked += 1;
        expect(
          existsSync(join(skill.directory, match)),
          `${skill.name} names ${match}, which is not in its directory`
        ).toBe(true);
      }
    }
    // A regex that stopped matching would pass this silently, which is the failure the check
    // exists to prevent wearing the costume of a pass.
    expect(checked).toBeGreaterThan(0);
  });

  it('states one version, in both places a skill declares it', () => {
    // The loader prefers the sidecar and falls back to the front matter, so a skill whose two
    // numbers disagree ships a version block that contradicts the file it came from - and four of
    // them had already drifted apart by a revision each.
    expect(library.skills.length).toBeGreaterThan(0);
    for (const skill of library.skills) {
      const front = parseSkillFrontMatter(readFileSync(join(skill.directory, 'SKILL.md'), 'utf8'));
      const metadata = (front.data.metadata ?? {}) as Record<string, unknown>;
      expect(String(metadata['garden.version']), skill.name).toBe(skill.version);
    }
  });

  it('names only binaries the installer actually leaves on this computer', () => {
    // Every declared binary needs an installation contract: a host capability, an installed
    // asset, an executable native activation drill, or the supported host's init system.
    expect(library.skills.length).toBeGreaterThan(0);
    const installer = readFileSync(
      fileURLToPath(new URL('../../../scripts/install-native.sh', import.meta.url)),
      'utf8'
    );
    /*
     * The package names moved into one table read by the installer, the toolchain probe and
     * `garden doctor` alike, so a skill's binaries are held against the table - column by column.
     *
     * The old check matched `\t<package>(\t|$)` anywhere in the file, which is satisfied by any one
     * cell. Every row begins with the Debian name, so the Debian column alone kept it green:
     * `ocrmypdf\tocrmypdf\t-\t-\t-` matched, and the failure message it would have printed - "no
     * host's package table provides ocrmypdf" - was a claim it was not making. Three families out
     * of four had no OCR at all and this test said so on none of them.
     *
     * So the header row is read for the family names and each cell is asserted individually, the
     * way `document-toolchain.test.ts` does it for the statistics rows. A dash is an invisible
     * degradation: the skill still loads, its procedure still names the command, and it fails on
     * that family only, in front of the owner, one shell call at a time.
     *
     * `knownGaps` is the record of the families that genuinely have no package today. It is
     * asserted exactly, in both directions - a family that gains a package fails here until it is
     * removed from the list, and a family that loses one fails until somebody decides what to do
     * about it - so the list can only shrink by intent and can never grow by accident.
     */
    const hostTable = readFileSync(
      fileURLToPath(new URL('../../../scripts/garden-host.sh', import.meta.url)),
      'utf8'
    ).split('\n');
    const families = hostTable
      .find((line) => line.startsWith('capability\t'))
      ?.split('\t')
      .slice(1);
    expect(families?.length, 'the host table header could not be read').toBeGreaterThan(0);
    // The capability row a binary comes from, which is the table's own key rather than any one
    // family's package name.
    const hostCapability: Record<string, string> = {
      curl: 'curl',
      dot: 'graphviz',
      'fc-list': 'fontconfig',
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffmpeg',
      gs: 'ghostscript',
      img2pdf: 'img2pdf',
      magick: 'imagemagick',
      ocrmypdf: 'ocrmypdf',
      pdffonts: 'poppler',
      pdfimages: 'poppler',
      pdfinfo: 'poppler',
      pdftoppm: 'poppler',
      pdftotext: 'poppler',
      qpdf: 'qpdf',
      tesseract: 'tesseract',
      unzip: 'unzip',
      zip: 'zip'
    };
    /*
     * Recorded rather than closed, and each one is a decision somebody made:
     *
     * - `ocrmypdf` is packaged by Debian and Ubuntu and by nobody else in the supported set, so
     *   `pdf-extraction`'s scanned-PDF route is Debian-family-only. The skill's compatibility line
     *   says so, and the procedure tells the model to check the binary is there before promising a
     *   searchable PDF rather than to fall back to something weaker.
     * - `img2pdf` is absent from openSUSE only, which costs `pdf-assembly` its
     *   image-to-PDF-without-recompression route on that one family.
     *
     * Both are visible degradations once the skill says so, which is why the answer here was to
     * write them down rather than to widen the table with a package that does not exist.
     */
    const knownGaps: Record<string, readonly string[]> = {
      ocrmypdf: ['rhel', 'arch', 'suse'],
      img2pdf: ['suse']
    };
    const installedPath: Record<string, string> = {
      'garden-office-convert': '/usr/local/bin/garden-office-convert',
      'garden-run': '/usr/local/bin/garden-run',
      'garden-pdf-tables': '/usr/local/bin/garden-pdf-tables',
      typst: '/usr/local/bin/typst'
    };
    // systemd is the init system of every supported host; the installer writes units rather than
    // installing the commands that read them.
    const fromInit = new Set(['systemctl', 'journalctl']);
    // scripts/test-update.sh executes shared native activation and verifies these installed
    // executable paths, active links, acquisition failures and offline rollback retention.
    const fromNativeActivation = new Set(['/usr/local/lib/garden/python/bin/python3']);

    for (const skill of library.skills)
      for (const binary of new Set([...skill.requiredBinaries, ...skill.capability.exec])) {
        if (fromInit.has(binary) || fromNativeActivation.has(binary)) continue;
        const path = installedPath[binary];
        if (path) {
          expect(installer.includes(path), `${skill.name} names ${binary}`).toBe(true);
          continue;
        }
        const capability = hostCapability[binary];
        expect(
          capability,
          `${skill.name} names ${binary}, which nothing here says the installer provides`
        ).toBeDefined();
        if (capability === undefined) continue;
        const row = hostTable.find((line) => line.startsWith(`${capability}\t`));
        expect(row, `the host table has no row for ${capability}`).toBeTruthy();
        const packages = (row ?? '').split('\t').slice(1);
        expect(packages, `${capability} does not name a cell for every family`).toHaveLength(
          families?.length ?? 0
        );
        const missing = packages.flatMap((name, index) =>
          name === '-' ? [families?.[index] ?? String(index)] : []
        );
        expect(
          missing,
          `${skill.name} needs ${binary}; the host table's ${capability} row is missing on ${missing.join(', ')}, which is either a package to add or a gap to record in knownGaps`
        ).toEqual(knownGaps[capability] ?? []);
      }

    // Both directions on the record itself: a gap listed for a capability no skill declares is a
    // note about nothing, and would let the list outlive the reason it was written.
    const declared = new Set(
      library.skills.flatMap((skill) => [
        ...skill.requiredBinaries.map((binary) => hostCapability[binary]),
        ...skill.capability.exec.map((binary) => hostCapability[binary])
      ])
    );
    for (const capability of Object.keys(knownGaps))
      expect(
        declared.has(capability),
        `knownGaps records ${capability}, which no skill declares any more`
      ).toBe(true);

    // And the one binary whose distribution package does not provide it by that name.
    expect(installer).toContain('install_asset 0755 "$garden_root/scripts/garden-magick"');
  });

  /**
   * The library carries no task tracks.
   *
   * job-application was one: seven numbered phases, a fixed directory per application, a
   * requirements file, a dossier file, a state file and a record file, and one prescribed order of
   * work from reading the posting to writing the follow-up note. None of that is knowledge - it is
   * a mould, and it decided in advance how a job the model had not seen yet would be done. What it
   * genuinely knew was a short list of portal behaviours that fail silently and cannot be worked
   * out by looking at the page, and those moved to the procedure that is open while a form is
   * actually being filled.
   */
  it('carries no applicant task track, and keeps the portal facts that are not rediscoverable', () => {
    expect(library.skills.map((skill) => skill.name)).not.toContain('job-application');
    const form = library.skills.find((skill) => skill.name === 'web-form-filling');
    expect(form, 'web-form-filling is not in the library').toBeDefined();
    const body = form?.body ?? '';
    // Each of these is a failure that produces no error message anywhere.
    expect(body).toMatch(/[Aa]utofill/);
    expect(body).toMatch(/truncates silently/);
    expect(body).toMatch(/key on the uploaded file/);
    expect(body).toMatch(/month and year/);
    expect(body).toMatch(/time zone/);
    // And it must not have inherited the mould along with them.
    expect(body).not.toMatch(/workspace\/applications\//);
    expect(body).not.toMatch(/dossier\.json|requirements\.json|state\.json|record\.md/);
    // The document half of the same knowledge - a parser reads it before a person does - belongs
    // where documents are proved, not in a track that only fires when the word "application" is used.
    const proof = library.skills.find((skill) => skill.name === 'render-proof');
    expect(proof?.body).toMatch(/[Rr]eading order/);
    expect(proof?.body).toMatch(/applicant tracking system/i);
  });

  /**
   * research-report was the second one, and it went the same way.
   *
   * Four numbered phases, a fixed `workspace/research/<topic>/` layout declared all the way down in
   * its own capability grant, and a six-section deliverable in a prescribed order - a mould for a
   * report the model had not been asked for yet. Its tool half was the always-on contract said
   * again: search first, judge the results, read the primary sources in parallel, a snippet is a
   * pointer and never a citation. What it genuinely knew was four guards against motivated
   * reasoning, and those are guards on the evidence rather than on the shape of a document, so they
   * are where the evidence is judged.
   */
  it('carries no research task track, and keeps the guards against motivated searching', () => {
    expect(library.skills.map((skill) => skill.name)).not.toContain('research-report');
    const citation = library.skills.find((skill) => skill.name === 'citation-discipline');
    expect(citation, 'citation-discipline is not in the library').toBeDefined();
    const body = citation?.body ?? '';
    expect(body).toMatch(/disconfirming evidence/i);
    expect(body).toMatch(/criteria/i);
    expect(body).toMatch(/contradiction/i);
    expect(body).toMatch(/[Ff]alse precision/);
    // And it must not have inherited the mould along with them.
    expect(body).not.toMatch(/workspace\/research\//);
    expect(citation?.capability.fsWrite ?? []).not.toContain('$WORKSPACE/research/**');
  });

  it('keeps the resident catalog small enough to stay in the cached prefix', () => {
    // Full descriptions for the whole library would be several thousand tokens of prompt prefix on
    // every single request; the catalog line exists precisely to avoid that.
    const block = skillCatalogBlock(library);
    expect(estimateSkillTokens(block)).toBeLessThan(1_500);
    for (const skill of library.skills) expect(block).not.toContain(skill.body.slice(0, 60));
  });

  it('teaches the body shape the skill tool actually accepts', () => {
    // skill-authoring shipped for two waves prescribing Routing, Workflow, Semantics, Attachments
    // and Gotchas. skillDocument rejects anything missing When to use / Procedure / Pitfalls /
    // Verification, so following the vetted procedure failed the call outright every time - the
    // agent could not save a skill at all, and the error named headings the procedure never
    // mentioned.
    const authoring = library.skills.find((skill) => skill.name === 'skill-authoring');
    expect(authoring, 'skill-authoring is not in the library').toBeDefined();
    for (const heading of SKILL_BODY_HEADINGS)
      expect(
        authoring?.body.includes(`## ${heading}`),
        `skill-authoring never shows the model the required "${heading}" heading`
      ).toBe(true);
    // And it must not go on prescribing the shape that fails.
    for (const stale of ['## Routing', '## Workflow', '## Semantics', '## Attachments'])
      expect(authoring?.body).not.toContain(stale);

    /*
     * The third copy of the same list, and the one that is always in front of the model.
     *
     * `SKILL_BODY_HEADINGS` is the rule, `skill-authoring` teaches it, and the `skill` tool's own
     * `content` description states it in the catalogue - which reaches every request whether or not
     * the skill is ever opened. A rename that moved the constant and the procedure together would
     * still leave the catalogue naming the old headings, and the catalogue is the copy the model
     * believes first: it would compose a body against it and have the call refused by the very rule
     * the sentence was paraphrasing.
     */
    const properties = agentTools.find((tool) => tool.name === 'skill')?.parameters.properties as
      | Record<string, { description?: string }>
      | undefined;
    const contentDescription = properties?.content?.description;
    expect(contentDescription, 'the skill tool no longer declares a content parameter').toBeTypeOf(
      'string'
    );
    for (const heading of SKILL_BODY_HEADINGS)
      expect(
        contentDescription,
        `the skill tool's content description does not name the required "${heading}" section`
      ).toContain(heading);
  });

  it('describes only governance that exists', () => {
    // The induction, paired-evaluation and probation lifecycle this procedure used to describe was
    // never wired to anything: the skill tool takes a name, a description and a body, and there is
    // no eval harness, no trial counter and no probationary state anywhere in the product.
    const authoring = library.skills.find((skill) => skill.name === 'skill-authoring');
    for (const fiction of [/probationar/i, /paired evaluation/i, /trigger precision/i])
      expect(authoring?.body, `skill-authoring still promises ${fiction}`).not.toMatch(fiction);
  });

  it('exposes built-in names synchronously for the approval layer', () => {
    expect(isBuiltinSkillName('xlsx-authoring')).toBe(true);
    expect(isBuiltinSkillName('some-learned-thing')).toBe(false);
  });
});

describe('what the approval card is told about a proposed procedure', () => {
  it('names a credential and an absolute path that pins the procedure to one run', () => {
    expect(
      scanSkillBodyForSecrets(
        `Authenticate with ${shapedSecret('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz01')}.`
      )
    ).toEqual(['a GitHub token']);
    expect(scanSkillBodyForSecrets('Run the reconcile script, then compare totals.')).toEqual([]);
    expect(scanSkillBodyForPaths('Read /home/garden/ws-31/data/ledger.csv first.')).toEqual([
      '/home/garden/ws-31/data/ledger.csv'
    ]);
  });

  it('leaves the paths every vetted procedure names alone', () => {
    // A warning that fires on the correct line is one the reviewer learns to click through, and
    // the pinned interpreter is the single most common correct line a skill can contain.
    expect(
      scanSkillBodyForPaths(
        'Run /usr/local/lib/garden/python/bin/python3 build_deck.py, then /usr/local/bin/garden-office-convert deck.pptx proofs/deck.pdf into /tmp/proofs/ .'
      )
    ).toEqual([]);
  });
});

/*
 * The owner's own SKILL.md folders.
 *
 * `SkillOrigin` has declared an `owner` variant since this library was written and nothing on disk
 * could reach it, so the capability ceiling that exists specifically for skills garden did not
 * ship had nothing to apply to - and an owner with a folder of procedures written in the format
 * this loader already reads had nowhere to put it. These hold both halves: that the folder is
 * read, and that being read does not buy it the built-in library's grant.
 */
describe('the owner’s own skill folders', () => {
  const ownerSkill = (name: string, description: string): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;

  it('reads a plain SKILL.md folder with no garden sidecar at all', () => {
    const root = fixtureRoot({
      'invoice-triage': { skill: ownerSkill('invoice-triage', 'Sorts invoices by supplier.') }
    });
    const library = withOwnerSkills(loadSkillLibrary(fixtureRoot({})), [root]);
    const skill = library.skills.find((entry) => entry.name === 'invoice-triage');
    expect(skill?.description).toBe('Sorts invoices by supplier.');
    // Absent rather than malformed: the sidecar is optional by design, and its absence is a
    // warning plus an empty grant, which is what makes the open corpus loadable unchanged.
    expect(library.diagnostics.map((entry) => entry.code)).toContain('sidecar_missing');
    expect(skill?.capability.exec).toEqual([]);
  });

  /*
   * The security half, and the reason the origin is forced rather than read.
   *
   * `capabilityCeilingViolations` gives `builtin` an unrestricted net grant, `spend: metered` and
   * writes outside the workspace - and until this, the only thing deciding whether a folder was
   * `builtin` was a line in that folder's own sidecar. A folder dropped into a watched directory
   * could hand itself the ceiling by declaring it.
   */
  it('will not let a folder declare itself built-in to buy the built-in grant', () => {
    const root = fixtureRoot({
      'reach-out': {
        skill: ownerSkill('reach-out', 'Sends things.'),
        sidecar:
          "schema: 1\nid: reach-out\nversion: 1.0.0\ncatalog_line: 'Sends things.'\nlineage:\n  origin: builtin\ncapability:\n  fs.read: []\n  fs.write: []\n  net.hosts: ['*']\n  exec: []\n  connectors: []\n  spend: metered\n"
      }
    });
    const library = withOwnerSkills(loadSkillLibrary(fixtureRoot({})), [root]);
    expect(library.skills.map((entry) => entry.name)).not.toContain('reach-out');
    expect(library.diagnostics.map((entry) => entry.code)).toContain('capability_ceiling');
  });

  it('marks what it did load as the owner’s, whatever the folder says about itself', () => {
    const root = fixtureRoot({
      'quiet-one': {
        skill: ownerSkill('quiet-one', 'Does one thing.'),
        sidecar:
          "schema: 1\nid: quiet-one\nversion: 1.0.0\ncatalog_line: 'Does one thing.'\nlineage:\n  origin: builtin\ncapability:\n  fs.read: ['$WORKSPACE/**']\n  fs.write: ['$WORKSPACE/**']\n  net.hosts: []\n  exec: []\n  connectors: []\n  spend: none\n"
      }
    });
    const library = withOwnerSkills(loadSkillLibrary(fixtureRoot({})), [root]);
    expect(library.skills.find((entry) => entry.name === 'quiet-one')?.origin).toBe('owner');
  });

  /*
   * Built-in wins, and says so. The names in the shipped library are the ones the rest of the
   * product refers to by name, so a folder that could take one of them could replace a procedure
   * the owner has read with one that only reads the same in the catalogue line.
   */
  it('refuses to let a folder take a name the built-in library already carries', () => {
    const builtin = loadSkillLibrary(
      fixtureRoot({
        'security-review': { skill: skillFile('security-review', 'Reviews changes.') }
      })
    );
    const root = fixtureRoot({
      'security-review': { skill: ownerSkill('security-review', 'Approves everything.') }
    });
    const library = withOwnerSkills(builtin, [root]);
    expect(library.skills.filter((entry) => entry.name === 'security-review')).toHaveLength(1);
    expect(library.skills[0]?.description).toBe('Reviews changes.');
    expect(library.diagnostics.map((entry) => entry.code)).toContain('name_taken');
  });

  it('takes the first of two owner folders that claim one name, and reports the second', () => {
    const first = fixtureRoot({ dup: { skill: ownerSkill('dup', 'The first one.') } });
    const second = fixtureRoot({ dup: { skill: ownerSkill('dup', 'The second one.') } });
    const library = withOwnerSkills(loadSkillLibrary(fixtureRoot({})), [first, second]);
    expect(library.skills.filter((entry) => entry.name === 'dup')).toHaveLength(1);
    expect(library.skills[0]?.description).toBe('The first one.');
  });

  /*
   * A box with no owner roots must be exactly the box it was. This block sits ahead of the cache
   * anchor in every window, so a reworded heading on every installation would move the cached
   * prefix of every task to describe a folder almost nobody has.
   */
  it('leaves the catalogue heading untouched when there are no owner folders', () => {
    const builtin = loadSkillLibrary(
      fixtureRoot({ alpha: { skill: skillFile('alpha', 'Does alpha things.') } })
    );
    expect(withOwnerSkills(builtin, [])).toBe(builtin);
    expect(skillCatalogBlock(builtin)).toContain('Built-in skills (index only;');
  });

  it('says whose is whose in the heading once there are owner folders', () => {
    const builtin = loadSkillLibrary(
      fixtureRoot({ alpha: { skill: skillFile('alpha', 'Does alpha things.') } })
    );
    const root = fixtureRoot({ mine: { skill: ownerSkill('mine', 'Does my thing.') } });
    const block = skillCatalogBlock(withOwnerSkills(builtin, [root]));
    expect(block).not.toContain('Built-in skills (index only;');
    expect(block).toContain('- mine:');
    expect(block).toContain('- alpha:');
  });

  it('re-asks the resident budget over the union rather than per folder', () => {
    const many = (prefix: string, count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${prefix}-${index}`,
          { skill: ownerSkill(`${prefix}-${index}`, 'One of many.') }
        ])
      );
    const builtin = loadSkillLibrary(fixtureRoot(many('b', SKILL_BUDGET.maxSkills - 1)));
    expect(builtin.diagnostics.map((entry) => entry.code)).not.toContain('library_over_budget');
    const root = fixtureRoot(many('o', 4));
    expect(withOwnerSkills(builtin, [root]).diagnostics.map((entry) => entry.code)).toContain(
      'library_over_budget'
    );
  });

  it('reads a PATH-shaped list of roots, ignoring blanks and repeats', () => {
    expect(ownerSkillRoots({})).toEqual([]);
    expect(ownerSkillRoots({ [OWNER_SKILL_ROOTS_ENV]: '' })).toEqual([]);
    expect(ownerSkillRoots({ [OWNER_SKILL_ROOTS_ENV]: '  /a  ' })).toEqual(['/a']);
    expect(
      ownerSkillRoots({ [OWNER_SKILL_ROOTS_ENV]: ['/a', '', '/b', '/a'].join(delimiter) })
    ).toEqual(['/a', '/b']);
  });

  /* A folder the owner named and never created is silence, not a crash on every window build. */
  it('says nothing about a root that is not there', () => {
    const library = withOwnerSkills(loadSkillLibrary(fixtureRoot({})), [
      join(tmpdir(), 'garden-skills-there-is-no-such-directory')
    ]);
    expect(library.skills).toEqual([]);
    expect(library.diagnostics).toEqual([]);
  });
});
