/**
 * What `code_diagnostics` will actually run: fifteen languages, the marker each is recognised by,
 * the one command each resolves to, and - `diagnosticsSelection` at the foot of this file - the
 * project file that command has to be pointed at before it is a diagnostic rather than a usage
 * page. `docs/design/itself/DIAGNOSTICS.md` has the measurements behind that last one.
 *
 * ── What stops a cloned repository's build recipe, and what does not ───────────────────────────
 *
 * Stated here plainly rather than asked on an approval card, because a stated limit is worth more
 * than a card that asks about one of two doors.
 *
 * Nine of these fifteen commands are the project's own build or test recipe, so what executes is a
 * file whoever wrote the repository chose: `cargo check` compiles and runs `build.rs` and the
 * crate's procedural macros; `go test ./...` builds and runs the repository's tests; `make -s` runs
 * a Makefile target; `mvn compile` and `dotnet build` run the plugins and tasks the project file
 * names; `gradle` evaluates `build.gradle` as a program, and the `gradlew` form runs a script that
 * is itself in the tree; `swift build` compiles and runs `Package.swift`; `Rscript` sources an
 * `.Rprofile` from the working directory before it reaches the parse loop; `terraform validate`
 * launches the provider plugins under `.terraform`. The other six - TypeScript, Python, Julia,
 * Ruby, PHP, Dart - name a fixed parser or type-checker over files the repository supplies as data.
 *
 * WHAT STOPS IT: nothing in the approval floor, and that is deliberate. `shell` runs the identical
 * nine commands with no card in balanced or autonomous, so a card would ask about a shape the model
 * reaches unasked one line over; `npm install` makes every
 * project's dependency tree foreign and the build then runs it, so a rule honest enough to call
 * `node_modules` a stranger's would card every build there is. Running someone else's code is the
 * job here, not the exception.
 *
 * WHAT DOES STOP IT: two bounds and one limit, none of them a question.
 *   1. The turn takes an undo point first. `code_diagnostics` is subtracted from
 *      `CHECKPOINT_EXEMPT_TOOLS` (`turn-bounds.ts`) by name, in every language, so the writes
 *      measured below are rewindable. This is the repair a card would only stand in for.
 *   2. It runs under a bounded timeout - `clampNumber(timeoutSeconds, 10..1800, 300)` in the
 *      dispatch arm - and under `cwd: path`, whose default is `workspace`. Say what that confinement
 *      is and is not, because the difference decides whether bound 1 reaches: the runner's
 *      `resolveInside` refuses a path outside the CONTAINER HOME, not outside `workspace`, and
 *      `isUserData` is not applied to an exec cwd. So the ordinary call - `workspace`, or a
 *      directory under it - runs inside `CHECKPOINT_CONTENT` and is fully rewindable, and a call
 *      naming `.garden/browser` would not be, since the roots pick that up only when
 *      `CHECKPOINT_INCLUDE_BROWSER_PROFILE` is on and it ships off - though on a box that reports
 *      Landlock the command cannot write there at all. Where the command writes once it has
 *      started is a separate question; it is rung 3.
 *   3. And the limit, which is a boundary with a hole in it.
 *      The sandbox is an identity boundary AND, where the kernel can apply one, a filesystem one.
 *      `scripts/garden-sandbox run ... confine $ROOT` is `setpriv --reuid --regid --clear-groups
 *      --no-new-privs` plus a Landlock ruleset: read and execute over the system hierarchies
 *      (/usr /bin /lib /lib64 /sbin /opt /etc /var /srv /run /proc /sys), write over
 *      `$ROOT/workspace`, `$ROOT/.home`, /tmp, /var/tmp and /dev/shm, and a device list over /dev.
 *      /home is granted nowhere, which is the whole boundary: every workspace on the box is mode
 *      2770 with the agent account's group, so without it a build recipe run for this task could
 *      read and rewrite every other task's tree, and `$ROOT/.garden` - the checkpoints, the
 *      browser profile, the artifacts - sits one level above the only directory it needs.
 *      Traversal is not restricted by Landlock, so the command still reaches its own
 *      `$ROOT/workspace` through a `$ROOT` it may not read, list, write or rename.
 *
 *      IT IS REPORTED RATHER THAN ASSUMED, and `filesystem=none` is a real answer on a real box.
 *      `garden-sandbox check` applies the shipped read rules to `/bin/sh -c :` and prints
 *      `filesystem=landlock` or `filesystem=none`. The probe program is a shell and not `/bin/true`
 *      because POSIX pins a shell at `/bin/sh` and pins nothing at `/bin/true`: on a host carrying
 *      it only at `/usr/bin/true` the probe would answer about its own missing binary rather than
 *      about the kernel. The installer writes `CONFINE_AGENT_FILESYSTEM` from that line, and
 *      `sandboxedInvocation` asks the helper for `open` when it is off, so a kernel or a util-linux
 *      without Landlock runs these commands with the identity boundary only. A box with no helper
 *      configured at all has neither boundary. Read what the box answered before relying on either.
 *
 *      WHAT BOUND 1 CANNOT REWIND. `execution.ts` sets `HOME` to `$ROOT/.home` at the container
 *      root, and the ruleset grants it write precisely because pip, cargo, npm and the coding CLIs
 *      have to write there. `CHECKPOINT_CONTENT` is `['workspace', '.garden/artifacts']`, so a
 *      recipe that writes `$HOME/.cargo` or `$HOME/.gradle` writes where a rewind will not reach
 *      it, and that is chosen rather than overlooked: a home inside the checkpoint would be walked
 *      and hashed every turn against `CHECKPOINT_MAX_FILES` of 250,000, and a Rust toolchain alone
 *      is 88,021 files - crossing it throws and the turn loses the undo point that bound 1 is.
 *
 *      Two things the ruleset deliberately does not cover. The owner's own interactive terminal
 *      goes through the helper's `shell` mode, which has no confine word and never will: that is
 *      the owner at their own computer, reaching files the file browser hands them anyway. And
 *      `ISOLATE_AGENT_NETWORK` ships false, so the recipe has the host's ordinary network access
 *      whatever the call declared. `docs/design/floor/DIAGNOSTICS.md` argues the rest.
 *
 * Measured on this machine rather than assumed, and it is why the bound is unconditional rather
 * than per-language: `make -s` on a Makefile whose target writes a file wrote it; `cargo check` on
 * a crate with a writing `build.rs` left 50 new paths and on a crate with NO `build.rs` at all
 * still left 16; and two of the six "parse only" languages write too - `python3 -I -m compileall`
 * leaves `__pycache__`, `tsc --noEmit` under `incremental` leaves a `.tsbuildinfo`. The nine/six
 * split is a fact about whose program runs. It is not the write/no-write split, and no bound
 * should be keyed to it.
 *
 * ── Why this is its own module ────────────────────────────────────────────────────────────────
 *
 * A leaf rather than an export from `repository.ts`, which is the only caller that runs these
 * commands: `repository.ts` imports `tool-dispatch.js`, so a test that wanted to ask what a
 * `Cargo.toml` resolves to would drag the dispatch table and the runner client in behind it. The
 * ladder and the table are the subject of their own suite and of the design note above, and they
 * are worth reading without that. The same answer `CODE_SEARCH_COLLAPSE_LINES` records one file
 * over.
 */

export interface DiagnosticsCommand {
  executable: string;
  args: string[];
}

/**
 * What the arm does with a directory: run this command, or return this sentence and run nothing.
 */
export interface DiagnosticsSelection {
  command?: DiagnosticsCommand;
  reason?: string;
}

/**
 * The project marker each language is recognised by, in the order the ladder tries them.
 *
 * Order is load-bearing and is the order the ladder always had: a repository with both a
 * `package.json` and a `Cargo.toml` is diagnosed as TypeScript, and moving `Cargo.toml` above it
 * would change which command runs on a real tree.
 */
export const diagnosticsLanguage = (requested: string, names: ReadonlySet<string>): string => {
  if (requested !== 'auto') return requested;
  if (names.has('tsconfig.json') || names.has('package.json')) return 'typescript';
  if (names.has('pyproject.toml') || names.has('requirements.txt')) return 'python';
  if (names.has('Cargo.toml')) return 'rust';
  if (names.has('go.mod')) return 'go';
  if (names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts'))
    return 'java';
  if ([...names].some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))) return 'csharp';
  if (names.has('CMakeLists.txt') || names.has('Makefile')) return 'cpp';
  if (names.has('DESCRIPTION') || names.has('renv.lock')) return 'r';
  if (names.has('Project.toml')) return 'julia';
  if (names.has('Gemfile')) return 'ruby';
  if (names.has('composer.json')) return 'php';
  if ([...names].some((name) => name.endsWith('.tf'))) return 'terraform';
  if (names.has('Package.swift')) return 'swift';
  if (names.has('pubspec.yaml')) return 'dart';
  return '';
};

export const diagnosticsCommand = (
  language: string,
  names: ReadonlySet<string>
): DiagnosticsCommand | undefined => {
  if (language === 'typescript')
    return names.has('pnpm-lock.yaml')
      ? { executable: 'pnpm', args: ['exec', 'tsc', '--noEmit', '--pretty', 'false'] }
      : { executable: 'npx', args: ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'] };
  /*
   * `-I` is not decoration, and it is the one place in this table where a hole was closed instead
   * of described.
   *
   * `python3 -m compileall` puts the working directory at the front of `sys.path`, so a repository
   * with a `compileall.py` at its root has that file imported and executed instead of the standard
   * library's - measured on this machine against CPython 3.10.10, where a `compileall.py` writing to
   * stderr produced its line and exit 0. `-I` is isolated mode: neither the script directory nor the
   * user site directory is on `sys.path`, and the same run leaves the repository's file alone.
   * Without it Python would be running a stranger's program the way `make` and `cargo` do, and no
   * amount of asking the owner about it would have been as good as the flag.
   *
   * The `__pycache__` entries for the real sources are still written, which is why Python does not
   * escape the undo point either: see `REPEATABLE_TOOLS_THAT_WRITE`.
   */
  if (language === 'python')
    return { executable: 'python3', args: ['-I', '-m', 'compileall', '-q', '.'] };
  if (language === 'rust')
    return { executable: 'cargo', args: ['check', '--message-format', 'short'] };
  if (language === 'go') return { executable: 'go', args: ['test', './...'] };
  if (language === 'java')
    return names.has('pom.xml')
      ? { executable: 'mvn', args: ['-q', '-DskipTests', 'compile'] }
      : names.has('gradlew')
        ? { executable: 'bash', args: ['./gradlew', 'compileJava', '--console=plain'] }
        : { executable: 'gradle', args: ['compileJava', '--console=plain'] };
  if (language === 'kotlin')
    return names.has('gradlew')
      ? { executable: 'bash', args: ['./gradlew', 'compileKotlin', '--console=plain'] }
      : { executable: 'gradle', args: ['compileKotlin', '--console=plain'] };
  if (language === 'csharp') return { executable: 'dotnet', args: ['build', '--nologo'] };
  if (language === 'cpp')
    return names.has('CMakeLists.txt') && names.has('build')
      ? { executable: 'cmake', args: ['--build', 'build'] }
      : { executable: 'make', args: ['-s'] };
  if (language === 'r')
    return {
      executable: 'Rscript',
      args: [
        '-e',
        'files <- list.files(".", pattern="\\\\.[Rr]$", recursive=TRUE, full.names=TRUE); files <- files[!grepl("/(renv|\\\\.git)/", files)]; invisible(lapply(files, function(file) parse(file=file))); cat(length(files), "R files parsed\\n")'
      ]
    };
  if (language === 'julia')
    return {
      executable: 'julia',
      args: [
        '--project=.',
        '-e',
        'for (root, dirs, files) in walkdir("."); filter!(name -> name != ".git", dirs); for file in files; endswith(file, ".jl") && Meta.parseall(read(joinpath(root, file), String)); end; end'
      ]
    };
  if (language === 'ruby')
    return {
      executable: 'ruby',
      args: [
        '-e',
        'Dir.glob("**/*.rb").reject { |file| file.start_with?("vendor/") }.each { |file| RubyVM::InstructionSequence.compile_file(file) }'
      ]
    };
  if (language === 'php')
    return {
      executable: 'php',
      args: [
        '-r',
        '$files=new RecursiveIteratorIterator(new RecursiveDirectoryIterator(".")); foreach($files as $file){if($file->isFile() && $file->getExtension()==="php"){token_get_all(file_get_contents($file->getPathname()), TOKEN_PARSE);}}'
      ]
    };
  if (language === 'terraform') return { executable: 'terraform', args: ['validate', '-no-color'] };
  if (language === 'swift') return { executable: 'swift', args: ['build'] };
  if (language === 'dart') return { executable: 'dart', args: ['analyze'] };
  return undefined;
};

/**
 * The project file the chosen command has to be pointed at, when the directory does not hold it.
 *
 * ── The defect this closes ────────────────────────────────────────────────────────────────────
 *
 * The ladder recognises TypeScript by `tsconfig.json` OR `package.json`, and the command it
 * resolves to is `tsc --noEmit`, which reads `tsconfig.json` and nothing else. So a directory with
 * a `package.json` and no `tsconfig.json` - which on this repository is the root itself, and the
 * default `path` of `workspace` - ran `tsc` with no project to check. Measured here on 2026-09-01,
 * `pnpm exec tsc --noEmit --pretty false` at the repository root: **exit 1, 4,994 bytes on stdout,
 * 0 on stderr**, and every byte of it is the compiler's own usage - "COMMON COMMANDS", the option
 * list, `tsc --init`. The arm returned that as `passed: false` with 4,994 bytes of output, which is
 * the exact shape of a wall of type errors and says nothing whatever about the code.
 *
 * ── The same shape in the other fourteen ──────────────────────────────────────────────────────
 *
 * A command that runs and fails for want of a project file rather than for a defect in the code.
 * Driven on this machine rather than reasoned about, in a `mktemp -d` holding only the marker:
 *
 *   `make -s`, `CMakeLists.txt` and no `Makefile`  - exit 2, 61 bytes, "No targets specified and
 *     no makefile found". The second auto-selected condition: the ladder recognises C++ by
 *     `CMakeLists.txt` OR `Makefile`, but `cmake --build build` is chosen only when a `build`
 *     directory is already configured, so `CMakeLists.txt` alone falls through to `make`.
 *   `cargo check --message-format short`, no `Cargo.toml` - exit 101, 153 bytes.
 *   `swift build`, no `Package.swift` - exit 1, 420 bytes.
 *
 * Those last two are not reachable from `auto` - the ladder names Rust only for a `Cargo.toml` and
 * Swift only for a `Package.swift` - but `language` is an argument, and a named language stands
 * without being re-derived from the directory. So the requirement is checked whether the language
 * came from the ladder or from the caller; the two are the same mistake with a different author.
 *
 * The languages absent from this table are absent because their command takes the DIRECTORY as its
 * input and no project file at all: Python, R, Julia, Ruby, PHP each glob the tree from `.`.
 * Measured for the two whose interpreter is installed here - `ruby -e Dir.glob(...)` and
 * `python3 -I -m compileall -q .` in an empty directory both exit 0 with no output - and true by
 * construction for the other three, whose argument is the same recursive walk.
 *
 * WHAT THIS DOES NOT COVER, said rather than implied: `terraform validate` needs `terraform init`
 * to have run, and `.terraform` is written by a command rather than by whoever wrote the tree, so a
 * `.tf` file is a project and an uninitialised directory is still a real failure to report. It is a
 * different condition from a missing project file and Terraform is not installed on this machine to
 * measure it, so it is left alone rather than guessed at. `dart analyze` reads loose files as well
 * as a package, so `pubspec.yaml` is not required either.
 */
const missingProjectFile = (language: string, names: ReadonlySet<string>): string | undefined => {
  const anyName = (matches: (name: string) => boolean) => [...names].some(matches);
  if (language === 'typescript' && !names.has('tsconfig.json')) return 'tsconfig.json';
  if (language === 'rust' && !names.has('Cargo.toml')) return 'Cargo.toml';
  if (language === 'go' && !names.has('go.mod')) return 'go.mod';
  if (
    (language === 'java' || language === 'kotlin') &&
    !names.has('pom.xml') &&
    !names.has('build.gradle') &&
    !names.has('build.gradle.kts')
  )
    return 'pom.xml or build.gradle';
  if (
    language === 'csharp' &&
    !anyName((name) => name.endsWith('.sln') || name.endsWith('.csproj'))
  )
    return '.sln or .csproj';
  /*
   * Keyed to the command the table actually chose, not to the marker that named the language.
   * `cmake --build build` is chosen only when BOTH `CMakeLists.txt` and a configured `build`
   * directory are there; every other C++ directory falls through to `make -s`, which reads a
   * `Makefile`. Written as the negation of the cmake condition rather than as `!names.has('build')`,
   * which a directory holding a stray `build` and no `CMakeLists.txt` would have walked straight
   * through into a `make` that has nothing to run.
   */
  if (
    language === 'cpp' &&
    !names.has('Makefile') &&
    !(names.has('CMakeLists.txt') && names.has('build'))
  )
    return names.has('CMakeLists.txt') ? 'configured build directory, and no Makefile' : 'Makefile';
  if (language === 'swift' && !names.has('Package.swift')) return 'Package.swift';
  if (language === 'terraform' && !anyName((name) => name.endsWith('.tf'))) return '.tf file';
  return undefined;
};

/**
 * What runs here, or the one sentence saying why nothing does.
 *
 * Two different absences and two different sentences, because they are two different answers and
 * collapsing them would have been the same evasion as the help text. Nothing recognisable at all
 * is "no marker"; a marker whose command has no project to read is named by the file it wanted.
 * Neither is a question: an unrunnable command is not a decision for the owner to take, and
 * `docs/design/floor/DIAGNOSTICS.md` records in full why this tool raises no card.
 */
export const diagnosticsSelection = (
  language: string,
  names: ReadonlySet<string>
): DiagnosticsSelection => {
  const command = diagnosticsCommand(language, names);
  if (!command)
    return {
      reason:
        'No supported project marker was found. Use the shell tool for a repository-specific diagnostic command.'
    };
  const missing = missingProjectFile(language, names);
  if (missing)
    return {
      /*
       * The whole command rather than its executable. `pnpm` is what runs `tsc` here, and "running
       * pnpm would fail" names the wrong program to whoever reads it; the nine languages this
       * branch can reach all spell out in a handful of words.
       */
      reason: `This directory has no ${missing}, so there is no ${language} project here to check. Running ${[command.executable, ...command.args].join(' ')} would fail for want of one rather than report anything about the code. Point path at a directory that holds it, or use the shell tool for this project's own command.`
    };
  return { command };
};

/**
 * ── The post-edit trigger: the same tables, reached without the model asking ───────────────────
 *
 * Everything above answers a question the model put: `code_diagnostics` names a path and a
 * language and this file says what runs there. What follows answers no question at all. It is the
 * trigger `file_patch` fires on the files it just wrote, and it exists because the manual route is
 * measurably worse than it looks: `code_diagnostics` at its own default path - `workspace`, this
 * repository's root - resolves to TypeScript by `package.json`, finds no `tsconfig.json`, and
 * returns the refusal sentence and no command. A model that does the right thing at the default
 * path learns nothing about the code it just changed.
 *
 * Nothing here is a second copy of the ladder. `nearestProject` walks up from a written file and
 * hands each directory's listing to `diagnosticsLanguage` and `diagnosticsSelection` unchanged, so
 * a repository that resolves one way under `code_diagnostics` resolves the same way here. Two
 * rules are added by the walk and both of them are subtractive.
 */

/**
 * The languages a written file may trigger a checker for, and the extensions that name each.
 *
 * RULE (a) OF THE WALK, and it is the one that protects the owner's machine. Nine of the fifteen
 * commands in the table above are the project's own build recipe - the header of this file lists
 * which and why - and a build recipe is a program somebody else wrote. `code_diagnostics` runs
 * them because the model asked for them by name; a trigger that fires on every edit did not ask
 * anybody, so it may not compile and execute a `build.rs`, evaluate a `build.gradle`, or run a
 * repository's test suite. The six that remain - TypeScript, Python, Julia, Ruby, PHP, Dart -
 * name a fixed parser or type-checker over files the repository supplies as data.
 *
 * WHAT IS NOT HERE, and it is four of those six. Julia, Ruby, PHP and Dart are admissible by the
 * rule and absent from this map anyway, because a trigger has to PARSE what its checker printed
 * and `postEditDiagnostics` below carries two measured grammars, not six. An unparsed checker is
 * not a quiet checker: it is a run whose whole output either reaches the model as noise or is
 * dropped as silence, and silence dropped from a real error is the false health this whole trigger
 * is written to avoid. They come back when their output has been driven on a real tree the way
 * TypeScript's and Python's were, and the rest of the machinery is already language-agnostic.
 *
 * Extensions rather than a content sniff, because the alternative is reading the file a second
 * time to guess at what its own name already says. `.js` and its four spellings are here because
 * `tsc` under `allowJs` checks them and a repository that has turned that off simply reports
 * nothing about them, which is the cheap failure of the two.
 */
export const POST_EDIT_CHECKED_LANGUAGES: ReadonlyMap<string, readonly string[]> = new Map([
  ['typescript', ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']],
  ['python', ['.py', '.pyi']]
]);

/** Which of the admitted languages this file's name claims to be, if any. */
export const postEditLanguage = (path: string): string | undefined => {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = path.slice(dot).toLowerCase();
  for (const [language, extensions] of POST_EDIT_CHECKED_LANGUAGES)
    if (extensions.includes(extension)) return language;
  return undefined;
};

/**
 * How far up the tree the walk may look before it gives up.
 *
 * CHOSEN at 16, from the tree rather than from taste: the deepest path tracked in this repository
 * is 13 directories - `apps/desktop/src-tauri/gen/android/app/...` - and every workspace path
 * carries one more segment above that for `workspace` itself. 16 clears the deepest real file here
 * with room, and it is a bound rather than a limit anybody should hit: each rung is one `files`
 * round trip to the runner, so an unbounded walk on a pathological path is unbounded latency on a
 * check nobody asked for. A file deeper than this reports nothing, which is the same answer as a
 * file with no project above it.
 */
const NEAREST_PROJECT_MAX_DEPTH = 16;

/**
 * Whether this directory holds a marker for THIS language, asked of the ladder one name at a time.
 *
 * `diagnosticsLanguage` over the whole listing answers a different question, and answering it here
 * was measured getting a real tree wrong: its order is load-bearing and deliberate - a directory
 * with both a `package.json` and a `Cargo.toml` is TypeScript - because it is resolving ambiguity
 * for a caller who named no language at all. Here the file's own extension has already named one,
 * so there is no ambiguity to resolve, and asking the ordered ladder means a `pyproject.toml`
 * beside a `package.json` reports TypeScript and the Python package it is sitting in is never
 * found.
 *
 * One name at a time is the same table read without its precedence: a set of one has nothing to
 * come before it. No copy of the marker list is made here, which is the point - a marker added to
 * the ladder is admitted by this with no further edit.
 */
const holdsMarkerFor = (language: string, names: ReadonlySet<string>): boolean =>
  [...names].some((name) => diagnosticsLanguage('auto', new Set([name])) === language);

export interface NearestProject {
  /** The directory the command runs in, as a workspace path. */
  readonly dir: string;
  readonly language: string;
  readonly command: DiagnosticsCommand;
}

/**
 * The project a just-written file belongs to, or nothing.
 *
 * Walks up from the file's own directory to the first one holding a marker for the SAME language
 * the file's extension named, and asks `diagnosticsSelection` what runs there. The walk stops at
 * the first directory that matches rather than at the first directory holding any marker at all: a
 * Python package inside a JavaScript monorepo has a `package.json` between it and its
 * `pyproject.toml`, and stopping there would either run `tsc` over an edit to a `.py` file or
 * report nothing about a project that has a perfectly good checker two rungs up.
 *
 * RULE (b) OF THE WALK: a `reason` produces NOTHING. `diagnosticsSelection` returns a sentence
 * where it cannot return a command - "This directory has no tsconfig.json, so there is no
 * typescript project here to check" - and that sentence is advice, addressed to a model that asked
 * a question and pointed at the `path` argument it should have used. Nobody asked this. Injecting
 * it after an edit would be the harness talking to itself in the model's context window, and on
 * this repository's root it would be doing so after every single patch.
 *
 * `listing` is handed in rather than taken, because this module imports nothing and is worth
 * keeping that way: the runner client and the dispatch table stay on the other side of it. The
 * caller is expected to memoise it - one patch of four files in one package asks about the same
 * directories four times otherwise.
 */
export const nearestProject = async (
  path: string,
  listing: (dir: string) => Promise<ReadonlySet<string>>
): Promise<NearestProject | undefined> => {
  const language = postEditLanguage(path);
  if (!language) return undefined;
  const segments = path.split('/').filter(Boolean);
  // The file's own directory is the first rung; a bare `workspace/a.ts` leaves `workspace`.
  segments.pop();
  for (let rung = 0; rung < NEAREST_PROJECT_MAX_DEPTH && segments.length; rung += 1) {
    const dir = segments.join('/');
    let names: ReadonlySet<string>;
    try {
      names = await listing(dir);
    } catch {
      // A directory that cannot be listed is not a project and is not an error worth reporting to
      // anybody: the patch it followed has already succeeded and said so.
      return undefined;
    }
    if (holdsMarkerFor(language, names)) {
      const { command } = diagnosticsSelection(language, names);
      return command ? { dir, language, command } : undefined;
    }
    segments.pop();
  }
  return undefined;
};

/** One line of a checker's output that names a file and says something about it. */
export interface PostEditDiagnostic {
  /** The workspace path, rebuilt from the project directory the checker printed relative to. */
  readonly path: string;
  readonly text: string;
}

/**
 * What the checker actually said, or nothing at all.
 *
 * THIS FUNCTION IS THE NO-FALSE-HEALTH BOUND, and it is worth saying where the property lives
 * because it does not live in a flag: there is no vocabulary anywhere in this trigger for a check
 * that passed. A run reaches the model only through the lines this parser recognised, so exit 0,
 * a checker that is not installed, a checker killed by its timeout and a checker whose output
 * changed shape all produce the identical answer - an empty array, and therefore silence. The
 * failure mode that leaves is "garden did not tell me about an error", which a model repairs by
 * running the tool. The failure mode it forecloses is "garden told me this file was clean", which
 * a model does not repair at all.
 *
 * The two grammars were driven on this machine on 2026-09-01 rather than recalled:
 *
 *   `tsc --noEmit --pretty false` on a file with two errors printed exactly
 *     `src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`
 *   and exited 2. One line per diagnostic, path first, always relative to the project directory.
 *
 *   `python3 -I -m compileall -q .` on an unclosed `def` printed a four-line block -
 *     `*** Error compiling './bad.py'...`, then `  File "./bad.py", line 1`, the source line, a
 *   caret line, and `SyntaxError: '(' was never closed` - and exited 1. Only the first line names
 *   the file, so the block is gathered up to its blank line and reported as one diagnostic;
 *   `compileall` reports at most one syntax error per file, so a block is a file.
 *
 * And the case that proves the rule, measured the same day: `npx --no-install tsc` where
 * TypeScript is not installed exits 1 with 544 bytes of "This is not the tsc command you are
 * looking for" and npm's install advice. Not one line of it matches either grammar, so it is
 * silence. That is the same shape as the 4,994-byte usage page the header of `diagnosticsSelection`
 * records being returned as `passed: false`; the difference is that this trigger has no `passed`
 * to return it as.
 */
export const postEditDiagnostics = (
  language: string,
  dir: string,
  output: string
): readonly PostEditDiagnostic[] => {
  const found: PostEditDiagnostic[] = [];
  const under = (relative: string): string => `${dir}/${relative.replace(/^\.\//, '')}`;
  const lines = output.split('\n');
  if (language === 'typescript') {
    for (const line of lines) {
      const match = /^(\S[^(]*)\(\d+,\d+\): (?:error|warning) TS\d+: /.exec(line);
      const relative = match?.[1];
      /*
       * The compiler's line with its path rewritten to a workspace path, and it is the one thing
       * here that is not verbatim. `tsc` prints `src/a.ts(1,14): ...` relative to the directory it
       * ran in, and this block arrives beside `filesChanged`, `wrote` and every other path the
       * model has been handed this turn, all of which are workspace paths. A relative path in that
       * company is one the model will hand straight back to `file_read` and be refused for.
       */
      if (relative)
        found.push({
          path: under(relative),
          text: `${under(relative)}${line.slice(relative.length)}`.trimEnd()
        });
    }
    return found;
  }
  if (language === 'python') {
    for (let index = 0; index < lines.length; index += 1) {
      const relative = /^\*\*\* Error compiling '(.+)'\.\.\.$/.exec(lines[index] ?? '')?.[1];
      if (!relative) continue;
      const block: string[] = [];
      // The compiler's own explanation, which is everything up to the blank line it ends with. The
      // caret line is kept: it is the column, and a column with no line number above it is why the
      // three lines travel together.
      for (let scan = index + 1; scan < lines.length && (lines[scan] ?? '').trim(); scan += 1)
        block.push((lines[scan] ?? '').trimEnd());
      found.push({ path: under(relative), text: [`${under(relative)}:`, ...block].join('\n') });
    }
    return found;
  }
  return found;
};
