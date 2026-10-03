import { describe, expect, it } from 'vitest';
import { agentTools } from '../tool-catalogue.js';
import { CHECKPOINT_EXEMPT_TOOLS, REPEATABLE_TOOLS } from '../turn-bounds.js';
import {
  POST_EDIT_CHECKED_LANGUAGES,
  diagnosticsCommand,
  diagnosticsLanguage,
  diagnosticsSelection,
  nearestProject,
  postEditDiagnostics,
  postEditLanguage
} from './diagnostics.js';

const catalogueLanguages = (): string[] => {
  const diagnostics = agentTools.find((tool) => tool.name === 'code_diagnostics');
  const properties = diagnostics?.parameters.properties as
    | Record<string, { enum?: string[] }>
    | undefined;
  return (properties?.language?.enum ?? []).filter((language) => language !== 'auto');
};

describe('what a diagnostic actually runs', () => {
  it('names a command for every language it offers, so none of them resolves to nothing', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThanOrEqual(15);
    for (const language of offered)
      expect(diagnosticsCommand(language, new Set()), language).toBeDefined();
  });

  /**
   * The bound on this tool, asserted where the fifteen commands are written down, because that is
   * the only place a sixteenth will be added.
   *
   * A tool safe to replay is not a tool that changed nothing. Measured on this machine, every
   * command in the table below can write: `make -s` wrote its target's file; `cargo check` left 50
   * new paths on a crate with a writing `build.rs` and still left 16 - `Cargo.lock` and `target/` -
   * on a crate with no `build.rs` at all; `python3 -I -m compileall` leaves `__pycache__`;
   * `tsc --noEmit` under `incremental` leaves a `.tsbuildinfo`. Two of those four are languages
   * that only parse, which is why the bound is the tool and not a list of languages.
   *
   * Both halves are asserted. Repeatable - a second `make -s` tells the owner nothing new, which is
   * what keeps this tool batchable and replayable - and not exempt from the undo point, so a turn
   * of nothing but diagnostics has something to rewind to. A language added to the catalogue
   * inherits the bound with no further decision, which is the point of keying it to the tool.
   */
  it('takes the turn’s undo point, in every language, because every one of them can write', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThanOrEqual(15);
    expect(REPEATABLE_TOOLS.has('code_diagnostics')).toBe(true);
    expect(CHECKPOINT_EXEMPT_TOOLS.has('code_diagnostics')).toBe(false);
  });

  /**
   * The nine whose command is the project's own build or test recipe, each named by the command
   * rather than by a label. Nothing keys a card to this list - `shell` runs the identical nine for
   * free, so a card would be a toll on the phrasing - but the commands themselves are the
   * product's promise about what a diagnostic does, and a silent change to one of them would change
   * what runs on a stranger's tree.
   */
  it('runs the project’s own build for the languages whose recipe the repository writes', () => {
    const commands = {
      rust: 'cargo check --message-format short',
      go: 'go test ./...',
      java: 'mvn -q -DskipTests compile',
      kotlin: 'gradle compileKotlin --console=plain',
      csharp: 'dotnet build --nologo',
      cpp: 'make -s',
      swift: 'swift build',
      terraform: 'terraform validate -no-color'
    };
    for (const [language, expected] of Object.entries(commands)) {
      const markers = language === 'java' ? new Set(['pom.xml']) : new Set<string>();
      const command = diagnosticsCommand(language, markers);
      expect([command?.executable, ...(command?.args ?? [])].join(' '), language).toBe(expected);
    }
  });

  /**
   * The gradle wrapper is the worst shape in the table and the one most easily lost: the executable
   * is `bash`, and the program is a file in the repository being diagnosed.
   */
  it('reaches for a script inside the repository when a gradle wrapper is present', () => {
    const command = diagnosticsCommand('java', new Set(['build.gradle', 'gradlew']));
    expect([command?.executable, ...(command?.args ?? [])].join(' ')).toBe(
      'bash ./gradlew compileJava --console=plain'
    );
  });

  /**
   * Isolated mode, asserted as the flag rather than as a comment about it.
   *
   * Without `-I`, `python3 -m compileall` puts the working directory at the front of `sys.path` and
   * a repository holding a `compileall.py` has that file imported and run. Measured on CPython
   * 3.10.10: the repository's file produced its output and the command still exited 0. With `-I`
   * the same tree compiles and the repository's file is left alone. It is the one hole in this
   * table that was closed rather than described, and a flag is the only kind of answer that keeps
   * costing nothing - so the flag is the thing being checked.
   */
  it('byte-compiles Python without putting the repository on the import path', () => {
    const command = diagnosticsCommand('python', new Set());
    expect([command?.executable, ...(command?.args ?? [])].join(' ')).toBe(
      'python3 -I -m compileall -q .'
    );
  });

  it('type-checks TypeScript with the workspace’s own package manager and emits nothing', () => {
    const pnpm = diagnosticsCommand('typescript', new Set(['package.json', 'pnpm-lock.yaml']));
    expect([pnpm?.executable, ...(pnpm?.args ?? [])].join(' ')).toBe(
      'pnpm exec tsc --noEmit --pretty false'
    );
    const npx = diagnosticsCommand('typescript', new Set(['package.json']));
    expect([npx?.executable, ...(npx?.args ?? [])].join(' ')).toBe(
      'npx --no-install tsc --noEmit --pretty false'
    );
  });

  it('picks the language from the marker file the directory holds', () => {
    const markers: Array<[string, string]> = [
      ['package.json', 'typescript'],
      ['pyproject.toml', 'python'],
      ['Cargo.toml', 'rust'],
      ['go.mod', 'go'],
      ['pom.xml', 'java'],
      ['Makefile', 'cpp'],
      ['Package.swift', 'swift'],
      ['main.tf', 'terraform']
    ];
    expect(markers.length).toBeGreaterThan(0);
    for (const [marker, language] of markers)
      expect(diagnosticsLanguage('auto', new Set([marker])), marker).toBe(language);
  });

  /**
   * A directory with nothing to recognise resolves to nothing, and that is an answer rather than a
   * gap: the dispatch arm returns `available: false` and executes no command at all.
   */
  it('resolves to no language, and so to no command, in a directory with no project marker', () => {
    expect(diagnosticsLanguage('auto', new Set(['notes.md']))).toBe('');
    expect(diagnosticsCommand('', new Set(['notes.md']))).toBeUndefined();
  });

  it('lets an explicitly named language stand rather than re-deriving it from the directory', () => {
    expect(diagnosticsLanguage('go', new Set(['package.json']))).toBe('go');
  });
});

/**
 * A command that fails for want of a project file is not a diagnostic, and the tool must not return
 * one as though it were.
 *
 * Measured on this machine, 2026-09-01. `pnpm exec tsc --noEmit --pretty false` at this
 * repository's own root - a `package.json`, no `tsconfig.json`, which is the shape the ladder
 * recognises as TypeScript and the shape the default `path` of `workspace` names - **exits 1 with
 * 4,994 bytes on stdout and 0 on stderr**, and the 4,994 bytes are the compiler's usage page:
 * "COMMON COMMANDS", the option list, `tsc --init`. Passed through, it would reach the model as
 * `passed: false` with output, which is what a wall of type errors looks like.
 *
 * The same shape, driven the same way in a `mktemp -d` holding only the marker named:
 *
 * | selected as | command | directory holds | exit | bytes |
 * | --- | --- | --- | --- | --- |
 * | `auto`, `package.json` | `tsc --noEmit` | no `tsconfig.json` | 1 | 4,994 |
 * | `auto`, `CMakeLists.txt` | `make -s` | no `Makefile`, no `build` | 2 | 61 |
 * | `language: 'rust'` | `cargo check` | no `Cargo.toml` | 101 | 153 |
 * | `language: 'swift'` | `swift build` | no `Package.swift` | 1 | 420 |
 *
 * And the other direction, which is why the table below is a table rather than one `if`: `ruby -e
 * Dir.glob(...)` with no `Gemfile` and `python3 -I -m compileall -q .` in an empty directory both
 * exit 0 with no output. Those commands take the DIRECTORY as their input, so requiring a project
 * file of them would refuse a diagnostic that works. R, Julia and PHP are the same recursive walk.
 */
describe('what a diagnostic refuses to run, and says instead', () => {
  /**
   * A directory that satisfies each language, so that a sixteenth cannot be added without someone
   * writing down what it needs before it will run.
   */
  const satisfied: Record<string, string[]> = {
    typescript: ['package.json', 'tsconfig.json'],
    python: ['pyproject.toml'],
    rust: ['Cargo.toml'],
    go: ['go.mod'],
    java: ['pom.xml'],
    kotlin: ['build.gradle'],
    csharp: ['app.csproj'],
    cpp: ['Makefile'],
    r: ['DESCRIPTION'],
    julia: ['Project.toml'],
    ruby: ['Gemfile'],
    php: ['composer.json'],
    terraform: ['main.tf'],
    swift: ['Package.swift'],
    dart: ['pubspec.yaml']
  };

  /**
   * The six whose command reads the directory rather than a project file. They are named here so
   * that tightening the rule onto one of them - which would refuse a diagnostic that runs today -
   * fails rather than passes quietly.
   */
  const needNoProjectFile = ['python', 'r', 'julia', 'ruby', 'php', 'dart'];

  it('runs the real command for every language it offers, given a directory that holds its project', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThanOrEqual(15);
    for (const language of offered) {
      const names = satisfied[language];
      expect(names, `${language} has no directory written down that satisfies it`).toBeDefined();
      const selection = diagnosticsSelection(language, new Set(names));
      expect(selection.reason, language).toBeUndefined();
      expect(selection.command, language).toEqual(diagnosticsCommand(language, new Set(names)));
    }
  });

  it('answers with a sentence naming the missing file, and no command, in a bare directory', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThan(0);
    for (const language of offered) {
      const selection = diagnosticsSelection(language, new Set());
      if (needNoProjectFile.includes(language)) {
        expect(selection.command, language).toBeDefined();
        continue;
      }
      expect(selection.command, language).toBeUndefined();
      expect(selection.reason, language).toContain(language);
    }
  });

  /**
   * The defect itself, in both directions, at the two conditions that produced it: the marker the
   * ladder recognises is present and the file the command reads is not.
   */
  it('will not send tsc at a package.json with no tsconfig.json beside it', () => {
    const withoutConfig = diagnosticsSelection('typescript', new Set(['package.json']));
    expect(withoutConfig.command).toBeUndefined();
    expect(withoutConfig.reason).toContain('no tsconfig.json');
    expect(withoutConfig.reason).toContain('typescript');
    // The whole command, not its executable: `pnpm` and `npx` are what run `tsc`, and naming either
    // of them alone tells the reader the wrong program failed.
    expect(withoutConfig.reason).toContain('npx --no-install tsc --noEmit --pretty false');

    const withConfig = diagnosticsSelection(
      'typescript',
      new Set(['package.json', 'tsconfig.json', 'pnpm-lock.yaml'])
    );
    expect(withConfig.reason).toBeUndefined();
    expect([withConfig.command?.executable, ...(withConfig.command?.args ?? [])].join(' ')).toBe(
      'pnpm exec tsc --noEmit --pretty false'
    );
  });

  /**
   * The second condition the ladder reaches on its own, and the one that made the rule a negation
   * of the cmake condition rather than a check for a `build` entry.
   *
   * `CMakeLists.txt` names C++, but `cmake --build build` is chosen only when a configured `build`
   * directory is there too; every other C++ directory falls through to `make -s`. Three of these
   * four cases pass a `build` or a `CMakeLists.txt` and still have nothing for `make` to read - the
   * stray-`build` row is the one that a `!names.has('build')` rule would have walked straight past.
   */
  it('will not send make at a directory with no Makefile for it to read', () => {
    const cases: Array<[string[], string | undefined]> = [
      [['CMakeLists.txt'], undefined],
      [['build'], undefined],
      [['CMakeLists.txt', 'build'], 'cmake --build build'],
      [['CMakeLists.txt', 'Makefile'], 'make -s'],
      [['Makefile'], 'make -s']
    ];
    for (const [names, expected] of cases) {
      const selection = diagnosticsSelection('cpp', new Set(names));
      const ran = selection.command
        ? [selection.command.executable, ...selection.command.args].join(' ')
        : undefined;
      expect(ran, names.join('+')).toBe(expected);
      if (!expected) expect(selection.reason, names.join('+')).toContain('Makefile');
    }
  });

  /**
   * The requirement is checked whether the language came from the ladder or from the caller.
   *
   * `diagnosticsLanguage` lets a named language stand without re-deriving it, so `cargo check` in a
   * directory with no `Cargo.toml` - exit 101, 153 bytes - is reachable by one argument even though
   * the ladder would never have chosen Rust there. Same mistake, different author.
   */
  it('checks the project file for a language the caller named, not only one the ladder chose', () => {
    const cases: Array<[string, string]> = [
      ['rust', 'Cargo.toml'],
      ['go', 'go.mod'],
      ['java', 'pom.xml'],
      ['kotlin', 'build.gradle'],
      ['csharp', '.csproj'],
      ['swift', 'Package.swift'],
      ['terraform', '.tf']
    ];
    for (const [language, wanted] of cases) {
      const language_ = diagnosticsLanguage(language, new Set(['notes.md']));
      expect(language_).toBe(language);
      const selection = diagnosticsSelection(language_, new Set(['notes.md']));
      expect(selection.command, language).toBeUndefined();
      expect(selection.reason, language).toContain(wanted);
    }
  });

  /**
   * Two absences, two sentences. A directory holding nothing recognisable is a different answer
   * from one holding a marker whose command has no project to read, and the first sentence would
   * be false in the second directory - there is a `package.json` right there.
   */
  it('tells a directory with no marker apart from one whose command has no project', () => {
    expect(diagnosticsSelection('', new Set(['notes.md'])).reason).toBe(
      'No supported project marker was found. Use the shell tool for a repository-specific diagnostic command.'
    );
    expect(diagnosticsSelection('typescript', new Set(['package.json'])).reason).not.toContain(
      'No supported project marker'
    );
  });
});

/**
 * The walk a written file takes to find its checker, and the two output grammars it can read.
 *
 * `workspace.test.ts` drives the trigger through the shipped `file_patch` arm and counts what
 * reached the runner; that is where the bound that protects the owner's machine is pinned. This is
 * the unit underneath it: which languages are admitted, where the walk stops, and what the two
 * checkers were measured printing.
 */

/** A tree the walk can climb, listed the way the runner lists a directory. */
const listingOf =
  (tree: Record<string, readonly string[]>) =>
  async (dir: string): Promise<ReadonlySet<string>> =>
    new Set(tree[dir] ?? []);

describe('the checker a written file triggers, and the nine it may not', () => {
  /**
   * The six/nine split, asserted as a subtraction from the fifteen the manual tool offers rather
   * than as a list. Nine of those fifteen run the repository's own build recipe - `cargo check`
   * compiles and runs `build.rs`, `go test` builds and runs the tests, `gradle` evaluates
   * `build.gradle` as a program - and a trigger nobody asked for may not do that. A sixteenth
   * language added to the catalogue is out of this map by default, which is the right default.
   */
  it('admits no language whose command is somebody else’s build recipe', () => {
    const recipes = ['rust', 'go', 'java', 'kotlin', 'csharp', 'cpp', 'r', 'terraform', 'swift'];
    for (const language of recipes)
      expect(POST_EDIT_CHECKED_LANGUAGES.has(language), language).toBe(false);
    expect(postEditLanguage('workspace/crate/src/main.rs')).toBeUndefined();
    expect(postEditLanguage('workspace/pkg/notes.md')).toBeUndefined();
    expect(postEditLanguage('workspace/pkg/package.json')).toBeUndefined();
    expect(postEditLanguage('workspace/pkg/src/a.ts')).toBe('typescript');
    expect(postEditLanguage('workspace/pkg/app.py')).toBe('python');
  });

  it('climbs past directories that are not the file’s own project', async () => {
    const tree = {
      workspace: ['package.json', 'pnpm-lock.yaml'],
      'workspace/pkg': ['package.json', 'tsconfig.json'],
      'workspace/pkg/src': ['a.ts']
    };
    const found = await nearestProject('workspace/pkg/src/a.ts', listingOf(tree));
    expect(found?.dir).toBe('workspace/pkg');
    expect([found?.command.executable, ...(found?.command.args ?? [])].join(' ')).toBe(
      'npx --no-install tsc --noEmit --pretty false'
    );
  });

  /**
   * The reason branch, which is rule (b) of the walk. This is this repository's own root - a
   * `package.json`, no `tsconfig.json` - and `diagnosticsSelection` returns a sentence there
   * telling a model to point `path` somewhere else. Nobody pointed `path` anywhere; the trigger
   * fired on a write. Injecting advice for a question that was never asked is worse than silence,
   * and running the command it declines to run is worse than both.
   */
  it('says nothing where the marker names a language with no project file under it', async () => {
    const found = await nearestProject(
      'workspace/a.ts',
      listingOf({ workspace: ['package.json'] })
    );
    expect(found).toBeUndefined();
  });

  it('says nothing for a file with no marker anywhere above it', async () => {
    const tree = { workspace: ['notes.md'], 'workspace/loose': ['a.ts'] };
    expect(await nearestProject('workspace/loose/a.ts', listingOf(tree))).toBeUndefined();
  });

  /**
   * A Python package inside a JavaScript monorepo, which is why the walk stops at the first
   * directory matching the FILE's language rather than at the first directory holding any marker.
   * Stopping at the `package.json` would have run `tsc` over an edit to a `.py` file.
   */
  it('does not stop at a marker for a language the written file is not', async () => {
    const tree = {
      workspace: ['pyproject.toml', 'package.json'],
      'workspace/tools': ['package.json'],
      'workspace/tools/scripts': ['run.py']
    };
    const found = await nearestProject('workspace/tools/scripts/run.py', listingOf(tree));
    expect(found?.dir).toBe('workspace');
    expect(found?.language).toBe('python');
  });
});

describe('what the checker said, read as it was measured printing it', () => {
  /**
   * Driven on this machine on 2026-09-01, `tsc --noEmit --pretty false` over a file with two
   * errors. The path is rewritten to a workspace path and the rest of the line is the compiler's
   * own words: a relative path arriving beside `filesChanged` is a path the model hands back to
   * `file_read` and is refused for.
   */
  it('reads a tsc line and rebuilds the path the model can actually open', () => {
    const output = [
      "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/a.ts(2,18): error TS2304: Cannot find name 'missingSymbol'."
    ].join('\n');
    const found = postEditDiagnostics('typescript', 'workspace/pkg', output);
    expect(found).toHaveLength(2);
    expect(found[0]?.path).toBe('workspace/pkg/src/a.ts');
    expect(found[0]?.text).toBe(
      "workspace/pkg/src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."
    );
  });

  /**
   * And `python3 -I -m compileall -q .` on an unclosed `def`, measured the same day. Only the
   * `*** Error compiling` line names the file, so the explanation under it travels with it - a
   * caret with no line number above it says nothing at all.
   */
  it('reads a compileall block as one diagnostic, explanation and all', () => {
    const output =
      "*** Error compiling './bad.py'...\n" +
      '  File "./bad.py", line 1\n' +
      '    def broken(\n' +
      '              ^\n' +
      "SyntaxError: '(' was never closed\n" +
      '\n';
    const found = postEditDiagnostics('python', 'workspace/svc', output);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('workspace/svc/bad.py');
    expect(found[0]?.text).toContain("SyntaxError: '(' was never closed");
  });

  /**
   * THE NO-FALSE-HEALTH BOUND, at the unit. Measured: `npx --no-install tsc` where TypeScript is
   * not installed exits 1 with 544 bytes of npm's own advice. Not one line of it parses, so it is
   * silence - the same answer as a clean project, which is the whole design. There is no flag
   * anywhere in this trigger that could have said otherwise.
   */
  it('reads a checker that could not run as nothing, not as a clean project', () => {
    const banner =
      'This is not the tsc command you are looking for\n\n' +
      'To get access to the TypeScript compiler, tsc, from the command line either:\n\n' +
      '- Use npm install typescript to first add TypeScript to your project before using npx\n';
    expect(postEditDiagnostics('typescript', 'workspace/pkg', banner)).toEqual([]);
    expect(postEditDiagnostics('typescript', 'workspace/pkg', '')).toEqual([]);
    // And a language with no grammar here reads as nothing rather than as anything at all.
    expect(postEditDiagnostics('rust', 'workspace/crate', 'error: whatever')).toEqual([]);
  });
});
