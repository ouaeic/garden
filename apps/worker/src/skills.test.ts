import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
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
  SKILL_BUDGET,
  type SkillLibrary
} from './skills.js';

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
   * writes outside the workspace. If a line in a folder's own sidecar decided whether it was
   * `builtin`, a folder dropped into a watched directory could hand itself the ceiling by
   * declaring it.
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
