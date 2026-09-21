#!/usr/bin/env node
/**
 * The gate over the parts of this repository that TypeScript never compiles and vitest never runs.
 *
 * Three classes of thing used to be able to rot silently. A shell or Python script that ships to an
 * owner's box - `athanor-ddns` refreshing a hostname from a systemd timer, `athanor-certificate`
 * renewing TLS - is never parsed by anything in a normal build, so a syntax error in one reaches an
 * installation and fails at three in the morning rather than in CI. The skill library is read by the
 * model rather than by a compiler, so a malformed sidecar or a description that never says when the
 * skill does not apply is only discovered by an agent halfway through a job. And `.env.example` is
 * copied to `.env` by every developer following the README, so a value left behind there overrides
 * the default the code declares: it shipped `TASK_MAX_STEPS=60` for a while after the shared
 * declaration had moved to 120, which is the exact number that change existed to eliminate.
 *
 * Everything here is discovered rather than listed. A new script is covered the moment it has a
 * shebang, because a gate with a hand-maintained list of files is a gate the next file escapes.
 *
 * Usage: node scripts/check-repository.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const failures = [];
const fail = (message) => failures.push(message);
const say = (message) => process.stdout.write(`${message}\n`);
const read = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

// --- what ships to a box ----------------------------------------------------------------------

/** Files that are executed on an owner's server, wherever they live in the tree. */
const shippedFiles = () => {
  const found = ['install.sh'];
  for (const directory of ['scripts', 'infra/native']) {
    for (const entry of readdirSync(path.join(repositoryRoot, directory)).sort()) {
      const relativePath = `${directory}/${entry}`;
      if (statSync(path.join(repositoryRoot, relativePath)).isFile()) found.push(relativePath);
    }
  }
  return found;
};

/**
 * What interpreter a file is for, taken from the file itself. A systemd unit, an Nginx include and
 * a requirements list have no shebang and are not programs, so they are simply not classified.
 */
const interpreter = (relativePath) => {
  const firstLine = read(relativePath).split('\n', 1)[0] ?? '';
  if (/^#!.*\bpython3?\b/.test(firstLine)) return 'python';
  if (/^#!.*\b(?:sh|bash|dash)\b/.test(firstLine)) return 'shell';
  if (relativePath.endsWith('.mjs')) return 'node';
  return null;
};

const shipped = shippedFiles();
const byInterpreter = { shell: [], python: [], node: [] };
for (const relativePath of shipped) {
  const kind = interpreter(relativePath);
  if (kind) byInterpreter[kind].push(relativePath);
}
if (byInterpreter.shell.length < 15 || byInterpreter.python.length < 5)
  fail(
    `only ${byInterpreter.shell.length} shell and ${byInterpreter.python.length} Python scripts were found; discovery is broken rather than the tree being that small`
  );

for (const relativePath of byInterpreter.shell) {
  const parsed = spawnSync('/bin/sh', ['-n', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (parsed.status !== 0)
    fail(`${relativePath} is not valid POSIX shell: ${parsed.stderr.trim()}`);
}

if (byInterpreter.python.length > 0) {
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import ast,pathlib,sys\nfor name in sys.argv[1:]:\n    ast.parse(pathlib.Path(name).read_text(), filename=name)\n',
      ...byInterpreter.python
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  if (parsed.status !== 0) fail(`a shipped Python script does not parse: ${parsed.stderr.trim()}`);
}

for (const relativePath of byInterpreter.node) {
  const parsed = spawnSync(process.execPath, ['--check', relativePath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  if (parsed.status !== 0) fail(`${relativePath} does not parse: ${parsed.stderr.trim()}`);
}

/**
 * shellcheck catches what `sh -n` cannot: an unquoted expansion, a `local` that is not POSIX, a
 * test that always succeeds. It is required in CI and optional on a developer's machine, because
 * refusing to run the rest of this file over a missing analyser would only teach people to skip it.
 */
const shellcheck = spawnSync('shellcheck', ['-S', 'warning', ...byInterpreter.shell], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (shellcheck.error?.code === 'ENOENT') {
  if (process.env.GITHUB_ACTIONS) fail('shellcheck is not installed on this CI runner');
  else say('  shellcheck is not installed here, so the shell scripts were only parsed');
} else if (shellcheck.status !== 0) {
  fail(`shellcheck reported problems:\n${shellcheck.stdout.trim()}`);
}

/**
 * The one shipped script whose behaviour is checked here rather than only its syntax.
 *
 * `athanor-system-packages` is the single root-privileged path on an owner's box: the agent asks
 * for a package, the owner approves it, the runner rewrites the command onto one sudoers rule, and
 * that script runs on the other side as root. Its package-name filter is a security control and
 * its dispatch decides whether an approved install reaches a package manager this host has. Both
 * were untested on every branch, which is how it came to know apt and nothing else while the
 * runner in front of it had known four families for two waves.
 *
 * Run from here rather than left to a CI job, because the value of a fixture is the number of
 * times it runs. It needs no root, no network and no real package manager - the managers are
 * recorders and every absolute path the script names is rewritten in a copy - so it costs about a
 * second and works on a developer's laptop.
 */
// Native package compilation and reconstruction run here alongside the recorder's file checks.
const analysisRuns = spawnSync('python3', ['scripts/test-reproducible-run.py'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  timeout: 120_000
});
if (analysisRuns.status !== 0) fail(`Analysis run manifests failed: ${analysisRuns.stderr}`);
else {
  say(
    'Analysis run manifests: verified execution, changed-dependency refusal and clean replay passed.'
  );
  const skipped = /OK \(skipped=(\d+)\)/.exec(analysisRuns.stderr);
  if (skipped)
    say(
      `${skipped[1]} optional native-tool analysis checks skipped; run acceptance with R and a declared micromamba executable plus C compiler.`
    );
}

const systemPackages = spawnSync('/bin/sh', ['scripts/test-system-packages.sh'], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (systemPackages.status !== 0)
  fail(
    `the root package helper does not behave as scripts/test-system-packages.sh requires:\n${[
      systemPackages.stdout,
      systemPackages.stderr
    ]
      .join('\n')
      .trim()}`
  );
else say(`Root package helper: ${(systemPackages.stdout.match(/^ok /gm) ?? []).length} checks.`);

/**
 * And the second one, for the same reason. `athanor task` is how a script drives athanor, so its
 * exit codes are a contract rather than a convenience: the caller's whole reason for existing is
 * that a wrapper which returns 0 while the work died has bitten this repository twice, and one
 * shared non-zero for every kind of ending is the same defect a step along.
 *
 * `scripts/test-task-cli.mjs` runs the real subcommand against a stand-in API on a loopback port
 * and checks that each way a run can end has its own number, that the outcome is the documented
 * object rather than prose, and that nothing answers an approval on the owner's behalf. It needs no
 * token, no model and no network beyond localhost, and costs a few seconds.
 *
 * What it cannot do is notice the API changing shape underneath it - that is what
 * `scripts/live-drill.mjs` is for, and that one costs money.
 */
const taskCli = spawnSync(process.execPath, ['scripts/test-task-cli.mjs'], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (taskCli.status !== 0)
  fail(
    `athanor task does not keep its contract:\n${[taskCli.stdout, taskCli.stderr].join('\n').trim()}`
  );
else say(taskCli.stdout.trim());

/**
 * And the third, for a contract with somebody else's code on the other end of it.
 *
 * `athanor acp` speaks Agent Client Protocol, which means the callers that matter are clients this
 * repository did not write and cannot test against. That makes two things load-bearing at once: the
 * wire shapes, because a client is a stranger and will not be forgiving, and the approval floor,
 * because ACP hands a client a permission call and a mode setter and either one could quietly
 * decide what this box stops to ask.
 *
 * `scripts/acp/test-acp-bridge.mjs` spawns the real arm, speaks the CLIENT half down its stdin, and
 * answers its HTTP calls from a stand-in API - so the thing under test is the bridge between two
 * stand-ins rather than a function called with hand-made arguments. It needs no token, no model and
 * no network beyond localhost.
 *
 * Same limit as the two above, said out loud: it stands in for the API, so it stays green if the
 * API changes shape underneath it.
 */
const acpBridge = spawnSync(process.execPath, ['scripts/acp/test-acp-bridge.mjs'], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (acpBridge.status !== 0)
  fail(
    `athanor acp does not keep its contract:\n${[acpBridge.stdout, acpBridge.stderr].join('\n').trim()}`
  );
else say(acpBridge.stdout.trim());

// Build admission and argument forwarding can be checked without mobile SDKs or signing keys.
const ciContracts = spawnSync(process.execPath, ['--test', 'scripts/check-ci.test.mjs'], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (ciContracts.status !== 0)
  fail(`CI build contracts failed:\n${[ciContracts.stdout, ciContracts.stderr].join('\n').trim()}`);
else say(ciContracts.stdout.trim());

say(
  `Shipped programs: ${byInterpreter.shell.length} shell, ${byInterpreter.python.length} Python, ${byInterpreter.node.length} Node parse.`
);

// --- the skill library ------------------------------------------------------------------------

const skills = spawnSync('/bin/sh', ['scripts/athanor-skill-check', 'skills'], {
  cwd: repositoryRoot,
  encoding: 'utf8'
});
if (skills.status !== 0)
  fail(`the skill library does not lint:\n${(skills.stderr || skills.stdout).trim()}`);
say(`Skill library: ${(skills.stdout || '').trim() || 'checked'}`);

// --- the ImageMagick 6 compatibility command ----------------------------------------------------

/**
 * The one place in athanor that knows ImageMagick has two spellings, exercised against stand-ins
 * for the ImageMagick 6 binaries. If this dispatched wrongly, `magick identify x.png` would become
 * `convert identify x.png` on every Debian 12 and Ubuntu 24.04 box and the failure would surface
 * inside a skill, in front of the owner.
 */
if (existsSync('/usr/bin/magick')) {
  say('  this host has ImageMagick 7, so the compatibility command was not exercised');
} else {
  const stubs = mkdtempSync(path.join(tmpdir(), 'athanor-magick-'));
  for (const tool of ['convert', 'identify']) {
    writeFileSync(path.join(stubs, tool), `#!/bin/sh\nprintf '${tool} %s' "$*"\n`, { mode: 0o755 });
  }
  const dispatch = (args) =>
    spawnSync('/bin/sh', ['scripts/athanor-magick', ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: `${stubs}:/usr/bin:/bin` }
    }).stdout;
  const expectations = [
    [['in.png', '-resize', '1200x', 'out.jpg'], 'convert in.png -resize 1200x out.jpg'],
    [['identify', '-format', '%wx%h', 'in.png'], 'identify -format %wx%h in.png'],
    [['convert', 'in.png', 'out.png'], 'convert in.png out.png'],
    [['-version'], 'convert -version']
  ];
  for (const [args, expected] of expectations) {
    const actual = dispatch(args);
    if (actual !== expected)
      fail(`scripts/athanor-magick turned \`magick ${args.join(' ')}\` into \`${actual}\``);
  }
  rmSync(stubs, { recursive: true, force: true });
  say(`ImageMagick compatibility: ${expectations.length} dispatches match ImageMagick 7.`);
}

// --- .env.example against the schemas that read it ----------------------------------------------

/**
 * Comments are removed a line at a time rather than by matching `//` anywhere, because a default
 * value in these files is often a URL and `postgres://…` would otherwise lose everything after the
 * scheme. Every comment in every config schema is on its own line, which is what makes this safe.
 */
const withoutComments = (source) => {
  const lines = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    lines.push(line);
  }
  return lines.join('\n');
};

/**
 * The text written against each key of a schema object, keyed by the environment variable.
 *
 * Only text that is actually a declaration counts, and the first one wins. Both rules are there for
 * the same file: services/notifications/src/config.ts declares `PUSH_VAPID_SUBJECT` in its schema
 * and then names it again at the same indentation inside a type predicate at the bottom, where the
 * value is the word `string`. Taking the last match would read the type instead of the rule.
 */
const declarations = (source) => {
  const found = new Map();
  let key = null;
  let collected = [];
  const finish = () => {
    const text = collected.join('\n').trim().replace(/,$/, '');
    const isDeclaration = /^(?:z[\s.]|sharedEnv\.|[a-z][A-Za-z0-9_]*$)/.test(text);
    if (key && isDeclaration && !found.has(key)) found.set(key, text);
    key = null;
    collected = [];
  };
  for (const line of withoutComments(source).split('\n')) {
    const start = /^ {2}([A-Z][A-Z0-9_]*):(.*)$/.exec(line);
    if (start) {
      finish();
      key = start[1];
      collected = [start[2]];
    } else if (key) {
      if (/^ {2}\S/.test(line) || /^\}/.test(line)) finish();
      else collected.push(line);
    }
  }
  finish();
  return found;
};

/** The argument of `.default(...)`, read with the parentheses balanced and quotes respected. */
const defaultArgument = (declaration) => {
  const marker = declaration.indexOf('.default(');
  if (marker < 0) return null;
  let depth = 0;
  let quote = null;
  for (let index = marker + '.default'.length; index < declaration.length; index += 1) {
    const character = declaration[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0)
        return declaration
          .slice(marker + '.default('.length, index)
          .trim()
          .replace(/,$/, '');
    }
  }
  return null;
};

/**
 * The default as an operator would have to write it in a file. A computed default - a process id, a
 * template literal - has no such spelling, so it is reported as not comparable rather than guessed
 * at, and this check says nothing about that key.
 */
const literalValue = (argument) => {
  if (argument === null) return null;
  const quoted = /^(['"])([^'"]*)\1$/.exec(argument);
  if (quoted) return quoted[2];
  if (/^-?\d[\d_]*$/.test(argument)) return String(Number(argument.replaceAll('_', '')));
  return null;
};

/**
 * Every file that parses an environment into a zod schema. Most units keep theirs in `config.ts`;
 * the model registry is one loop with no exported surface and declares its schema inline, so
 * `index.ts` is read too when it holds one. A key declared in a file this misses would be reported
 * as configuring nothing, which is the failure mode to avoid.
 */
const schemaPaths = () => {
  const found = ['packages/contracts/src/env.ts'];
  for (const group of ['apps', 'packages', 'services']) {
    for (const entry of readdirSync(path.join(repositoryRoot, group)).sort()) {
      for (const name of ['config.ts', 'index.ts']) {
        const candidate = `${group}/${entry}/src/${name}`;
        let source;
        try {
          source = read(candidate);
        } catch {
          continue; // A unit without that file declares no environment key in it.
        }
        if (source.includes('z.object({')) found.push(candidate);
      }
    }
  }
  return found;
};

const schemaSources = new Map(schemaPaths().map((file) => [file, read(file)]));
const shared = declarations(schemaSources.get('packages/contracts/src/env.ts'));

/** Resolves `sharedEnv.KEY` and a same-file alias such as `bool` down to the zod call itself. */
const resolveDeclaration = (declaration, source) => {
  const sharedReference = /^sharedEnv\.([A-Z][A-Z0-9_]*)$/.exec(declaration);
  if (sharedReference) return shared.get(sharedReference[1]) ?? declaration;
  const alias = /^[a-z][A-Za-z0-9_]*$/.exec(declaration);
  if (alias) {
    const assignment = new RegExp(`^const ${declaration} =([\\s\\S]*?);$`, 'm').exec(
      withoutComments(source)
    );
    if (assignment) return assignment[1].trim();
  }
  return declaration;
};

const declaredDefaults = new Map();
const declaredAnywhere = new Set();
for (const [file, source] of schemaSources) {
  for (const [key, declaration] of declarations(source)) {
    const resolved = resolveDeclaration(declaration, source);
    // An upper-case key that is not a zod declaration is some other object that happens to sit at
    // the same indentation, not a setting an operator can write into an environment file.
    if (!/^z[\s.]/.test(resolved)) continue;
    declaredAnywhere.add(key);
    const value = literalValue(defaultArgument(resolved));
    if (value === null) continue;
    // The shared declaration is the one an operator's control.env is read against by more than one
    // process, so where a single process deliberately differs, shared still decides.
    if (file === 'packages/contracts/src/env.ts' || !declaredDefaults.has(key))
      declaredDefaults.set(key, { value, file });
  }
}

/**
 * Where `.env.example` deliberately sets something other than what the code defaults to. An entry
 * is a statement that someone looked; anything not listed here has to match, and an entry that no
 * longer describes a real difference fails too, so this cannot become a place to park drift.
 */
const recordedDivergences = [
  {
    key: 'ALLOW_INSECURE_DEV_AUTH',
    because:
      'A checkout has no HTTPS origin, so a browser will not create a passkey against it and there would be no way in at all. apps/api/src/config.ts refuses to start with this on in any mode but development, which is what keeps it a development-only value rather than a setting someone can leave on.'
  }
];

const exampleValues = new Map();
for (const line of read('.env.example').split('\n')) {
  const entry = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (entry) exampleValues.set(entry[1], entry[2]);
}
if (exampleValues.size < 40) fail('.env.example was not parsed; the format has changed');

for (const [key, value] of exampleValues) {
  if (!declaredAnywhere.has(key)) {
    fail(
      `.env.example sets ${key}, which no config schema declares, so an operator who changes it gets silence`
    );
    continue;
  }
  const declared = declaredDefaults.get(key);
  const divergence = recordedDivergences.find((entry) => entry.key === key);
  if (!declared) continue;
  if (value === declared.value) {
    if (divergence)
      fail(
        `.env.example now agrees with ${declared.file} about ${key}; remove the recorded divergence`
      );
    continue;
  }
  if (!divergence)
    fail(
      `.env.example sets ${key}=${value}, but ${declared.file} declares ${declared.value}. A checkout copies this file over the default, so either match it or record why it differs in scripts/check-repository.mjs`
    );
}
for (const entry of recordedDivergences) {
  if (!exampleValues.has(entry.key))
    fail(`a divergence is recorded for ${entry.key}, which .env.example no longer sets`);
  if (entry.because.length < 80) fail(`the reason recorded for ${entry.key} explains nothing`);
}

say(
  `Configuration example: ${exampleValues.size} keys, ${declaredDefaults.size} comparable defaults across ${schemaSources.size} schemas.`
);

// --- the per-command memory ceiling inside the cgroup that surrounds it --------------------------

/**
 * One decision written in two files that cannot import each other, and the only pairing here where
 * agreement is an inequality rather than equality.
 *
 * `defaultMemoryLimitBytes` is the RLIMIT_DATA one agent command gets. The systemd unit's
 * `MemoryHigh` and `MemoryMax` are where the cgroup holding the runner and every command it
 * started starts reclaiming and starts killing. The fraction has to lie strictly between them, and
 * it is wrong in a different way on each side.
 *
 * At or below `MemoryHigh` it refuses what the unit deliberately allows: that file says in as many
 * words that crossing the throttle should mean a heavy build finishes slowly instead of being
 * killed, and a single large job - an assembler, an aligner - is the shape that wants to.
 *
 * At or above `MemoryMax` it can never fire at all, because the cgroup counts the runner too and
 * therefore reaches any total first. That is not a wasted limit, it is a worse failure: the
 * per-process stop makes an allocation fail, so the program reports it in its own words on the
 * stderr the result carries, while the cgroup's stop is a SIGKILL with an empty stdout, an empty
 * stderr and a null exit code. Losing the reachable one turns every single-process memory death
 * into something indistinguishable from a segfault. It shipped that way for exactly one commit,
 * at four fifths against a `MemoryMax` of 80%, which on the owner's box put the rlimit 2,457 bytes
 * above the ceiling that would always beat it.
 *
 * Compared as percentages of an arbitrary total, because that is the only form the two sides share
 * - the unit writes percentages and the source writes a fraction of whatever the host reports.
 */
{
  const unit = read('infra/native/athanor-runner.service');
  const percentage = (key) => Number(new RegExp(`^${key}=(\\d+)%$`, 'm').exec(unit)?.[1]);
  const high = percentage('MemoryHigh');
  const max = percentage('MemoryMax');
  const source = read('services/workspace-runner/src/limits.ts');
  const fraction =
    /defaultMemoryLimitBytes = \(totalMemoryBytes: number\): number =>\s*Math\.max\(GIB, Math\.floor\(\(totalMemoryBytes \* (\d+)\) \/ (\d+)\)\);/.exec(
      source
    );
  if (!Number.isFinite(high) || !Number.isFinite(max))
    fail(
      'infra/native/athanor-runner.service no longer states MemoryHigh and MemoryMax as percentages, so the per-command memory ceiling cannot be compared against them'
    );
  else if (!fraction)
    fail(
      'services/workspace-runner/src/limits.ts no longer spells defaultMemoryLimitBytes as a fraction of the host, so it cannot be compared against the cgroup in infra/native/athanor-runner.service'
    );
  else {
    const percent = (Number(fraction[1]) / Number(fraction[2])) * 100;
    if (percent <= high || percent >= max)
      fail(
        `the per-command memory ceiling in services/workspace-runner/src/limits.ts is ${percent}% of the host, which is not strictly between MemoryHigh=${high}% and MemoryMax=${max}% in infra/native/athanor-runner.service. At or below the throttle it refuses a large single job the cgroup was written to allow; at or above the kill it can never fire, and every single-process memory death becomes a SIGKILL with nothing on either stream`
      );
    else
      say(
        `Command memory ceiling: ${percent}% of the host, between MemoryHigh=${high}% and MemoryMax=${max}%.`
      );
  }
}

/**
 * Nothing this project publishes judges anybody else's software.
 *
 * The rule is absolute and it is easy to break by accident, because weighing the alternatives is
 * exactly what an honest design note does - and a design note in a tracked file is published the
 * moment the repository is, and cloned onto every owner's machine by the installer. Working notes
 * that make those comparisons are untracked for that reason; this is what stops the next one being
 * committed. Naming a product is fine - a dependency, a format, a protocol. Naming one next to a
 * judgment about it is not.
 */
// The names themselves live in an untracked file. Writing them here would have put a list of other
// people's products into the repository that exists to never discuss them - the rule applies to
// this file too. `scripts/guarded-product-names.txt` is one term per line and is gitignored, so it
// stays on the machine of whoever publishes. Without it this one rule cannot run, and says so
// rather than passing quietly.
const guardTermsPath = path.join(repositoryRoot, 'scripts/guarded-product-names.txt');
const guardTerms = existsSync(guardTermsPath)
  ? readFileSync(guardTermsPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  : [];
const NAMED_PRODUCTS = guardTerms.length
  ? new RegExp(String.raw`\b(${guardTerms.join('|')})\b`, 'i')
  : null;
const COMPARATIVE =
  /\b(better|worse|faster|slower|superior|inferior|unmaintained|abandoned|best[- ]in[- ]class|most mature|state of the art|beats|outperforms|parity|versus|vs\.?|inadequate|poor|blocky|bloated|clunky|kinder|safer|smarter|cleaner|nicer|saner|wiser|heavier|lighter|leaner)\b/i;

// Everything the repository tracks, not only the scripts it ships: a design note in docs/ is
// published exactly as surely as a README, and the installer clones the whole checkout onto the
// owner's machine.
//
// Source files are read too, and not as an afterthought. This rule used to cover prose only, and a
// comment in services/relay/src/config.ts sat for months naming another project and calling this
// project's timeout kinder than theirs. A judgment in a `//` comment is published exactly as surely
// as one in a README - more so, since the whole checkout lands on every owner's machine.
const trackedText = spawnSync(
  'git',
  [
    'ls-files',
    '-z',
    '*.md',
    '*.mdx',
    '*.txt',
    '*.html',
    '*.ts',
    '*.tsx',
    '*.mjs',
    '*.js',
    '*.css',
    '*.sh',
    '*.py',
    '*.sql',
    '*.conf',
    '*.service'
  ],
  {
    cwd: repositoryRoot,
    encoding: 'utf8'
  }
)
  .stdout.split('\0')
  .filter(Boolean);
// `git ls-files` reads the index; this rule reads the working tree. The two disagree for exactly
// as long as a deletion is unstaged, and during that window the whole repository check used to
// die on ENOENT - which meant the comparison rule was not running at all, quietly, at the moment
// a wave was deleting things. A checker that stops checking is worse than one that reports a gap,
// so a path the index still names but the disk no longer holds is skipped and counted out loud.
// On a clean checkout, and therefore in CI, the two lists are identical and nothing is skipped.
const publishedText = trackedText.filter((relativePath) =>
  existsSync(path.join(repositoryRoot, relativePath))
);
if (publishedText.length !== trackedText.length)
  say(
    `Published text: ${trackedText.length - publishedText.length} tracked file(s) are deleted in the working tree and were not read; stage the deletion so the index and the disk agree.`
  );
if (NAMED_PRODUCTS) {
  for (const relativePath of publishedText) {
    const lines = read(relativePath).split('\n');
    for (const [index, line] of lines.entries()) {
      if (NAMED_PRODUCTS.test(line) && COMPARATIVE.test(line))
        fail(
          `${relativePath}:${index + 1} weighs a named product against something - published text never does that`
        );
    }
  }
  say(
    `Published text: ${publishedText.length} files carry no comparison with anybody else's software.`
  );
} else {
  say(
    `Published text: ${publishedText.length} files unchecked - scripts/guarded-product-names.txt is absent, so the comparison rule did not run.`
  );
}

/**
 * The host table has to name every family in every row, and cover what the install actually needs.
 *
 * The same package names lived in three places before this - the installer, the runner's toolchain
 * probe and `athanor doctor` - and widening past Debian would have made it twelve. One table is only
 * an improvement while it stays complete, and a row that quietly loses a column is a host that
 * installs and then cannot make a document.
 */
const hostTable = read('scripts/athanor-host.sh')
  .split('\n')
  .slice(
    read('scripts/athanor-host.sh')
      .split('\n')
      .findIndex((line) => line.startsWith('capability\t')),
    read('scripts/athanor-host.sh')
      .split('\n')
      .findIndex((line) => line === 'TABLE')
  )
  .filter(Boolean);
const [tableHeader, ...tableRows] = hostTable;
const families = (tableHeader ?? '').split('\t').slice(1);
if (families.length < 4) fail('the host package table names fewer than four families');
for (const row of tableRows) {
  const cells = row.split('\t');
  if (cells.length !== families.length + 1)
    fail(
      `host table row "${cells[0]}" has ${cells.length - 1} entries for ${families.length} families`
    );
  if (cells.slice(1).every((cell) => cell === '-'))
    fail(`host table row "${cells[0]}" names no package on any family, so nothing can provide it`);
}
// Every family must be able to install the things a document job cannot run without. These are the
// capabilities whose absence is not a degraded install but a broken one.
const LOAD_BEARING = ['python', 'postgres-server', 'nginx', 'git', 'curl', 'openssl', 'xvfb'];
for (const capability of LOAD_BEARING) {
  const row = tableRows.find((line) => line.split('\t')[0] === capability);
  if (!row) fail(`the host table has no row for ${capability}, which every host needs`);
  else
    row
      .split('\t')
      .slice(1)
      .forEach((cell, index) => {
        if (cell === '-') fail(`${families[index]} has no package for ${capability}`);
      });
}
say(`Host packages: ${tableRows.length} capabilities across ${families.join(', ')}.`);

/*
 * There are two ways a box reaches a new release - `install.sh` on top of an existing tree, and
 * `athanor update` from the auto-update timer - and both run with no terminal attached. Two things
 * have to be true on each, and both were once true on only one: a release that removes a workspace
 * package makes pnpm want to rebuild the modules directory and stop to ask, which with nothing to
 * answer it aborts the upgrade; and systemd stops wanting a withdrawn unit without ever stopping
 * the copy already running, which then holds its port until a reboot. A fix applied to one path and
 * not the other reads as done and leaves the unattended half broken, which is exactly what
 * happened, so the two are checked against each other rather than by eye.
 */
const upgradePaths = [
  { file: 'scripts/install-native.sh', name: 'the installer' },
  { file: 'scripts/athanor', name: '`athanor update`' }
];
for (const { file, name } of upgradePaths) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const [index, line] of source.split('\n').entries()) {
    if (!/(?:^|[\s;(])pnpm\s+(?:install|-r\s+build|-r\s+run)/.test(line)) continue;
    if (!/\bCI=true\b/.test(line))
      fail(
        `${file}:${index + 1} runs pnpm without CI=true, so ${name} aborts with no terminal when a release drops a workspace package`
      );
  }
  if (!/systemctl\s+stop/.test(source) || !source.includes('list-units'))
    fail(`${file} never stops a unit a release has withdrawn, so ${name} leaves it running`);
}
say(`Upgrade paths: ${upgradePaths.length} carry the non-interactive and withdrawn-unit handling.`);

/**
 * The install command the app prints has to name a revision that exists.
 *
 * It pins a tag so a new box lands on a known release rather than on whatever `main` is in the
 * middle of, and the box's own guarded update path moves it forward from there. Nothing offline can
 * prove a tag exists on the remote - but it can prove the repository agrees with itself, which is
 * the half that actually went wrong: the string said v0.1.0 while no tag had ever been cut, so the
 * one command a new owner is handed answered 404. Cutting a release is now "bump the version, tag
 * it", and never "remember to edit a string in a React component".
 */
const declaredVersion = JSON.parse(read('package.json')).version;
const installUi = read('apps/web/src/ServerInstall.tsx');
const pinnedRefs = [
  ...installUi.matchAll(/\/(?:v)?(\d+\.\d+\.\d+)\/|ATHANOR_REF=v(\d+\.\d+\.\d+)/g)
]
  .map((match) => match[1] ?? match[2])
  .filter(Boolean);
if (!pinnedRefs.length) fail('apps/web/src/ServerInstall.tsx pins no revision for the installer');
for (const pinned of pinnedRefs)
  if (pinned !== declaredVersion)
    fail(
      `apps/web/src/ServerInstall.tsx offers v${pinned} while package.json says ${declaredVersion}; the printed command would fetch a revision this checkout is not`
    );
say(`Install command: pins v${declaredVersion}, which is what this checkout calls itself.`);

/**
 * One Node version, agreed on by the three things that have an opinion.
 *
 * `engines` said >=20.20.0 while the installer provisions 24, CI runs 24, and the pinned pnpm
 * refuses to start below 22.13 - so somebody on the version this repository blessed could not run
 * `pnpm install` at all, and what they got was `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, which
 * says nothing about Node being too old. The installer's number is the real one, because it is the
 * one that has to be true on somebody else's server.
 */
const installerNodeMajor = Number(
  /^node_required_major=(\d+)/m.exec(read('scripts/install-native.sh'))?.[1]
);
const declaredNodeMajor = Number(
  /^>=(\d+)/.exec(JSON.parse(read('package.json')).engines?.node ?? '')?.[1]
);
if (!installerNodeMajor) fail('scripts/install-native.sh no longer states node_required_major');
else if (declaredNodeMajor !== installerNodeMajor)
  fail(
    `package.json engines.node allows Node ${declaredNodeMajor} while the installer requires ${installerNodeMajor}; a contributor on the lower one cannot run this repository`
  );
else say(`Node version: engines and the installer both require ${installerNodeMajor}.`);

/**
 * Every command the box answers to is a command the README lists.
 *
 * Documentation drift is the failure this repository keeps having: a command is added and the list
 * an owner reads is not, so the one thing that would have helped them is the one thing they cannot
 * find. `athanor rollback` shipped and went unmentioned. Both sides are discovered here rather than
 * listed, so the next command is covered by existing.
 */
const dispatch = read('scripts/athanor');
const dispatchStart = dispatch.indexOf('case "$command_name" in');
const dispatchBlock = dispatchStart === -1 ? '' : dispatch.slice(dispatchStart);
const dispatchArms = new Set(
  [...dispatchBlock.matchAll(/^  ([a-z][a-z-]*)\)/gm)].map((match) => match[1])
);
const shippedCommands = new Set(dispatchArms);
// `help` is the fallback arm and `install` is run by the installer, not by an owner reading this.
for (const internal of ['help', 'install']) shippedCommands.delete(internal);
/*
 * The README plus the pages beside it, rather than the README alone.
 *
 * The rule being kept is "no command ships undocumented", and any page an owner reads answers it.
 * What forced the widening: `athanor task` is not a host operation like the rest of this dispatch -
 * it drives work over HTTP with an API token and belongs on a page about doing that, not in the
 * list of things typed to keep the box alive. Insisting on the README would have put it in the
 * wrong place or left it undocumented, which is what a gate that names a location instead of an
 * audience buys every time.
 *
 * What this no longer catches, said plainly: the README is no longer required to be the complete
 * list, so a command documented only under docs/ now passes here. The gate below is what still
 * holds the line that matters - a name any document teaches has to be one the script offers in its
 * own usage line.
 *
 * Read off disk rather than out of `publishedText`, because that list comes from `git ls-files`,
 * and the page that documents a new command is not in the index while the change is being written.
 */
const ownerFacingPages = [
  'README.md',
  ...readdirSync(path.join(repositoryRoot, 'docs'))
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => `docs/${entry}`)
];
const documented = new Set(
  ownerFacingPages
    .flatMap((relativePath) => [...read(relativePath).matchAll(/^sudo athanor ([a-z][a-z-]*)/gm)])
    .map((match) => match[1])
);
const undocumented = [...shippedCommands].filter((name) => !documented.has(name)).sort();
const imaginary = [...documented].filter((name) => !shippedCommands.has(name)).sort();
if (!shippedCommands.size) fail('scripts/athanor no longer has a recognisable command dispatch');
else if (undocumented.length)
  fail(
    `scripts/athanor answers to ${undocumented.join(', ')}, which the README and the pages in docs/ never mention`
  );
else if (imaginary.length)
  fail(
    `the README or a page in docs/ documents ${imaginary.join(', ')}, which scripts/athanor does not answer to`
  );
else
  say(
    `Server commands: ${shippedCommands.size} shipped, all of them documented across ${ownerFacingPages.length} owner-facing pages.`
  );

/**
 * And every command any document tells an owner to type is one the box still offers under that
 * name.
 *
 * The rule above is a set comparison against the README, and it is satisfied by a name the script
 * merely answers to. That is a different question from "is this what an owner should type now".
 * `spend-ceiling` was renamed to `price-ceiling` and the old arm was kept, deliberately, so that a
 * name in somebody's shell history is told what it is called rather than told it does not exist -
 * and four documents went on teaching the retired name for months with the check above green,
 * because the arm was still there.
 *
 * The usage line the script prints is the list it offers, so it is the list a document may teach
 * from. A retired name is allowed on a line that says so - `old name` is the marker, and the
 * README's rename note is the one line that carries it - because documenting the rename is the
 * point of keeping the arm.
 */
const usageOffered = new Set(
  (/'Usage: garden \{([^']*)\}'/.exec(dispatch)?.[1] ?? '')
    // The nested `[api|worker|...]` groups are arguments to a command, not commands.
    .replaceAll(/\[[^\]]*\]/g, ' ')
    .split('|')
    .map((piece) => piece.trim().split(/\s+/)[0])
    .filter((name) => /^[a-z][a-z-]*$/.test(name))
);
const documents = publishedText.filter((relativePath) => relativePath.endsWith('.md'));
const invented = [];
const retired = [];
let instructions = 0;
for (const relativePath of documents) {
  read(relativePath)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(/sudo athanor ([a-z][a-z-]*)/g)) {
        const name = match[1];
        const where = `${relativePath}:${index + 1} says "sudo athanor ${name}"`;
        instructions += 1;
        if (!dispatchArms.has(name)) invented.push(where);
        else if (!usageOffered.has(name) && !line.includes('old name')) retired.push(where);
      }
    });
}
if (!usageOffered.size) fail('scripts/athanor no longer prints a usage line naming its commands');
else if (invented.length)
  fail(`${invented.join('; ')}, which scripts/athanor does not answer to at all`);
else if (retired.length)
  fail(
    `${retired.join('; ')}, a name scripts/athanor still answers to but no longer offers; teach the name in its usage line, or mark the line as the old name`
  );
else
  say(
    `Documented commands: ${instructions} instructions across ${documents.length} documents, all of them names the box offers.`
  );

// Every server scope needs a selectable home in the access form.
const scopeEnum = /export const ApiTokenScope = z\.enum\(\[([\s\S]*?)\]\);/.exec(
  read('packages/contracts/src/index.ts')
);
const offeredScopes = /const scopes: ApiTokenScope\[\] = \[([\s\S]*?)\];/.exec(
  read('apps/web/src/settings/Access.tsx')
);
const scopeNames = (body) =>
  [...body.matchAll(/'([a-z]+:[a-z]+)'/g)].map((match) => match[1]).sort();
const enforcedScopes = scopeNames(scopeEnum?.[1] ?? '');
const renderedScopes = scopeNames(offeredScopes?.[1] ?? '');
if (!enforcedScopes.length || !renderedScopes.length)
  fail('API token scopes: the server enum or access form no longer declares a non-empty list');
else if (enforcedScopes.join(',') !== renderedScopes.join(','))
  fail(
    'API token scopes: the access form does not offer exactly the scopes enforced by the server'
  );
else say(`API token scopes: all ${enforcedScopes.length} enforced scopes are selectable.`);

/**
 * Every file a fresh install puts on a box is a file an update puts there too.
 *
 * The installer and `install_runtime_files` keep the same list twice, by hand and by nothing else,
 * and the second copy fell behind without a single test noticing: a server that had only ever been
 * updated had no athanor-backup.timer, so nothing was ever going to take the backup the interface
 * described. The comparison below is the one nobody was running. It is one-directional - the update
 * may place more, as it does for the relay directory - and the exceptions are named rather than
 * inferred, because "the update does not place this" has to be a decision somebody made.
 */
// The source contract pairs the fresh installer and required update activation with the same
// migration. The executable proxy drill owns HTTP behavior; the update drill owns rollback.
const nativePreviewRuntime = read('scripts/athanor-native-runtime');
const nativeInstaller = read('scripts/install-native.sh');
const previewSite = read('infra/native/nginx.conf');
const previewCsp = read('infra/native/nginx-app-csp.conf');
const previewActivation = nativeInstaller.indexOf(
  '"$athanor_root/scripts/athanor-native-runtime" preview-origin'
);
const previewNginxCheck = nativeInstaller.indexOf('\nnginx -t\n');
if (
  previewActivation < 0 ||
  previewNginxCheck < previewActivation ||
  !/install_policy\s+configure_preview_origin/.test(nativePreviewRuntime) ||
  !nativePreviewRuntime.includes("atomic(snippets / 'athanor-preview-origin.conf'")
)
  fail(
    'Preview deployment must generate isolated origin configuration during fresh install and required update activation before nginx starts.'
  );
if (
  !previewSite.includes('listen 8443 ssl;') ||
  !previewSite.includes('return 308 $athanor_preview_origin$request_uri;') ||
  !previewSite.includes('proxy_set_header Host $http_host;') ||
  !previewCsp.includes("frame-src 'self' $athanor_preview_origin;")
)
  fail(
    'Preview deployment must preserve redirect paths, forwarded origin and the exact configured frame origin.'
  );

const installerSource = read('scripts/install-native.sh').replace(/\\\n\s*/g, ' ');
const installerPlaces = new Set();
for (const line of installerSource.split('\n')) {
  const asset = line.match(/^\s*install_asset\s+\d+\s+(\S+)\s+(\/\S+)\s*$/);
  if (asset) installerPlaces.add(asset[2]);
  // The few the installer places without going through install_asset, because they need an owner
  // and a group, or because the source is something it downloaded rather than a file in the tree.
  const direct = line.match(/^\s*install\s+-m\s+(?:\S+\s+|-[og]\s+\S+\s+)+(\/\S+)\s*$/);
  if (direct) installerPlaces.add(direct[1]);
}
const updateSource = read('scripts/athanor');
const listStart = updateSource.indexOf('install_runtime_files() {');
const listBlock =
  listStart === -1 ? '' : updateSource.slice(listStart, updateSource.indexOf('\n}\n', listStart));
const updatePlaces = new Set([...listBlock.matchAll(/runtime_path (\/\S+?)\)/g)].map((m) => m[1]));
// Placed by an install and deliberately not by an update. The listen snippet is chosen from two
// assets by the host's nginx version; the HSTS snippet belongs to `athanor certificate enable` and
// an update that rewrote it would switch HSTS off on a box with a real certificate; the AppArmor
// profile needs apparmor_parser and a host that has it; the ImageMagick shim exists only where the
// host has ImageMagick 6; typst is a downloaded release binary rather than a file in this checkout.
const installOnly = new Set([
  '/etc/nginx/snippets/athanor-https-listen.conf',
  '/etc/nginx/snippets/athanor-hsts.conf',
  '/etc/apparmor.d/athanor-chromium',
  '/usr/local/bin/magick',
  '/usr/local/bin/typst'
]);
const neverUpdated = [...installerPlaces]
  .filter((target) => !updatePlaces.has(target) && !installOnly.has(target))
  .sort();
const staleException = [...installOnly].filter((target) => !installerPlaces.has(target)).sort();
// A floor rather than a presence test, for the same reason the script discovery above has one: a
// comparison that quietly stops finding either list passes every time and protects nothing.
if (installerPlaces.size < 30 || updatePlaces.size < 30)
  fail(
    `only ${installerPlaces.size} installer and ${updatePlaces.size} update runtime files were found; the lists are no longer being read rather than the tree being that small`
  );
else if (neverUpdated.length)
  fail(
    `scripts/install-native.sh places ${neverUpdated.join(', ')}, which install_runtime_files never does; a server that was updated rather than reinstalled would never receive it`
  );
else if (staleException.length)
  fail(
    `${staleException.join(', ')} is listed as install-only but the installer no longer places it`
  );
else
  say(
    `Runtime files: the update places all ${installerPlaces.size - installOnly.size} the installer does, ${installOnly.size} install-only by decision.`
  );

/**
 * And every runner setting a fresh install writes is one an update writes too.
 *
 * The same defect as the runtime files, one directory over and worse: CONFINE_AGENT_FILESYSTEM was
 * written into /etc/athanor/runner.env by the installer and by nothing else, so the Landlock
 * boundary this branch built reached the owner's server present and switched OFF - `athanor-sandbox
 * check` answering `filesystem=landlock` while the runner answered `agentFilesystemConfined:
 * false`, after an update that printed "Update complete" and exited 0.
 *
 * `athanor update` now runs `scripts/install-native.sh --release-steps`, which runs the settings
 * step from the incoming release rather than from a second list. THIS IS THE GATE THAT KEEPS IT
 * THAT WAY: a key written outside `release_step_runner_settings` is a key an update does not carry,
 * and adding one fails here rather than being noticed on somebody's box a release later.
 *
 * WHAT THIS DOES NOT PROVE, and the distinction matters here more than anywhere: it does not prove
 * the update runs that step, or that the step works. It is a partition rule over one file. What
 * runs the entry point, watches the key land in a runner.env, and watches a step that fails stop
 * where it failed is `scripts/test-update.sh`.
 */
const runnerSettingsStart = installerSource.indexOf('release_step_runner_settings() {');
const runnerSettingsEnd = installerSource.indexOf('\n}\n', runnerSettingsStart);
const runnerSettingsBlock =
  runnerSettingsStart === -1 ? '' : installerSource.slice(runnerSettingsStart, runnerSettingsEnd);
// Every call to the three env writers, whatever file it names, because a gate that only recognises
// one spelling of the target is a gate one token defeats. Measured on this tree: with the pattern
// written as `"$runner_env"` alone, adding `set_env_value "$athanor_config/runner.env" NEW_KEY x`
// outside the step passed this check with the same reassuring line, and NEW_KEY would have reached
// a fresh install and no existing box - the exact defect this gate is here to refuse. So the target
// is read rather than assumed, and an unrecognised one fails below rather than being skipped.
const envWritePattern = /^\s*(?:set_env_value|set_env_default|remove_env_key)\s+(\S+)\s+(\S+)/gm;
// The three spellings that exist. `"$env_file"` is `set_env_default` forwarding to `set_env_value`
// inside the helper itself, not a setting; `"$control_env"` is the API's file, which the update
// path does not carry and this gate says nothing about. A fourth spelling is a decision, and
// whoever writes it has to come here and say which file it is.
const envWriteTargets = new Map([
  ['"$runner_env"', 'runner'],
  ['"$control_env"', 'control'],
  ['"$env_file"', 'helper']
]);
const envWritesAnywhere = [...installerSource.matchAll(envWritePattern)];
const unrecognisedEnvTargets = [
  ...new Set(envWritesAnywhere.map((m) => m[1]).filter((target) => !envWriteTargets.has(target)))
].sort();
const runnerKeysOf = (source) =>
  new Set(
    [...source.matchAll(envWritePattern)]
      .filter((m) => envWriteTargets.get(m[1]) === 'runner')
      .map((m) => m[2])
  );
const runnerKeysInStep = runnerKeysOf(runnerSettingsBlock);
const runnerKeysAnywhere = runnerKeysOf(installerSource);
// And every step this file defines is a step the entry point runs. `release_steps` is the list
// `run_release_steps` walks and the list the `--release-step` arm validates against, so a
// `release_step_*` function the install body calls and that list does not name is work that reaches
// a fresh install and never an existing box - the same silence, one name over.
const releaseStepsList = installerSource.match(/^release_steps='([^']*)'$/m);
const releaseStepsNamed = new Set(releaseStepsList ? releaseStepsList[1].split(/\s+/) : []);
const releaseStepsDefined = [...installerSource.matchAll(/^(release_step_[a-z_]+)\(\) \{$/gm)].map(
  (m) => m[1]
);
const releaseStepsUnlisted = releaseStepsDefined.filter((name) => !releaseStepsNamed.has(name));
// Written by an install and deliberately not by an update. Regenerating the shared secret leaves
// the API holding one value and the runner another until both restart, and no release has a reason
// to change it. Anything else added to this set needs the same kind of sentence.
const runnerKeysInstallOnly = new Set(['RUNNER_SHARED_SECRET']);
const runnerKeysNeverUpdated = [...runnerKeysAnywhere]
  .filter((key) => !runnerKeysInStep.has(key) && !runnerKeysInstallOnly.has(key))
  .sort();
const staleRunnerKeyException = [...runnerKeysInstallOnly]
  .filter((key) => !runnerKeysAnywhere.has(key))
  .sort();
// A floor rather than a presence test, for the reason every other list here has one: an expression
// that quietly stops finding anything passes every time and protects nothing.
if (runnerKeysInStep.size < 10)
  fail(
    `only ${runnerKeysInStep.size} runner settings were found inside release_step_runner_settings; the step is no longer being read rather than being that small`
  );
else if (!releaseStepsList)
  fail(
    `scripts/install-native.sh no longer declares a release_steps list, so nothing here can tell which steps an update runs`
  );
else if (releaseStepsDefined.length < 3)
  fail(
    `only ${releaseStepsDefined.length} release_step_* functions were found in scripts/install-native.sh; the file is no longer being read rather than having that few`
  );
else if (releaseStepsUnlisted.length)
  fail(
    `scripts/install-native.sh defines ${releaseStepsUnlisted.join(', ')} but release_steps does not name it, so sudo athanor update would never run it; add it to that list or give it a name that is not release_step_*`
  );
else if (unrecognisedEnvTargets.length)
  fail(
    `scripts/install-native.sh writes environment settings into ${unrecognisedEnvTargets.join(', ')}, which this check does not recognise; name that target beside "$runner_env" here and say which file it is, or this gate cannot tell whether an update carries what it writes`
  );
else if (runnerKeysNeverUpdated.length)
  fail(
    `scripts/install-native.sh writes ${runnerKeysNeverUpdated.join(', ')} into runner.env outside release_step_runner_settings, so sudo athanor update would never write it; move it into that step or name it install-only there and here`
  );
else if (staleRunnerKeyException.length)
  fail(
    `${staleRunnerKeyException.join(', ')} is listed as an install-only runner setting but the installer no longer writes it`
  );
else
  say(
    `Runner settings: all ${runnerKeysInStep.size} an install writes are inside the step an update runs, ${runnerKeysInstallOnly.size} install-only by decision; all ${releaseStepsDefined.length} release steps are named in the list the update walks.`
  );

/*
 * Values held in two places on purpose, against the file that owns them.
 *
 * Every copy here is deliberate and says so where it is written, and the reason is always that the
 * two sides cannot reach each other: five are in the web client, which is behind a 150 kB bundle
 * gate that importing a schema library or `node:fs` would blow, and six are across the worker and
 * the runner, which are separate processes. What was missing is the thing that makes a copy safe.
 * Both sides have tests, and they assert different examples - the disk floor is checked at 400 GiB
 * on one side and 500 GiB on the other - so a changed formula fails neither.
 *
 * The drift is never cosmetic, and each pair fails its own way. `hostStorageFloorBytes` is what the
 * runner refuses a write by and what the interface draws the disk bar from, so a copy left behind
 * puts the owner in front of a bar with room on it while every write is refused: the screen
 * asserting the opposite of what the machine has already decided. `RENDERABLE_EXTENSIONS` decides
 * on the worker side which files a model may claim a render proof on and on the runner side which
 * it will actually measure, so drift either offers a clause that is refused at the finish with a
 * 415 - the late refusal the worker-side list exists to prevent - or hides a format the runner
 * could have proved all along. `journalLevelPrefix` is the difference between `journalctl -p err`
 * being an answer and being a guess. The runner holds its own copy because it can import neither
 * the package the worker keeps it in nor the one compiled into the web bundle, and a copy that
 * filed a warning at `<5>` would put a browser that lost its renderer sandbox below the priority
 * the owner filters at - which is the exact silence the runner's copy was written to end, arriving
 * by a slower route.
 *
 * The two newest entries were both found by a sweep for capability the owner had no door to, and
 * both fail silently by construction. `BROWSER_VIEWPORT` is the coordinate space the private
 * browser is launched into and the space the page stream's clicks are mapped against, in two files
 * that have never been able to see each other; the numbers agree today, so nothing is wrong, and
 * the day the runner's viewport changes every human click on that pane lands proportionally off
 * with no error, no refusal and nothing failing anywhere. `MAX_PRICE_CEILING_USD_PER_MILLION` is
 * the bound the settings form refuses a typed rate at, and the server is still the authority - so
 * a copy left low turns a rate the box would have accepted into a sentence saying it is too big,
 * and a copy left high sends a number the route answers with a 400 the form never predicted. That
 * one is the cheaper failure of the two, and it is here because a bound nothing compares is the
 * drift this check exists to catch.
 *
 * Compared as source text, because that is what has to match. Anything cleverer would need to
 * import one side, and the whole reason there are two is that importing is what nobody can do.
 */
/**
 * The names a table or a set declares, sorted, for the entries below that hold the same list in
 * two different shapes - a `Record` on one side and a `new Set([...])` on the other - and for the
 * approval-phrase check after them, which reads a `Record` against a list of branch conditions.
 *
 * Anchored to exactly two spaces of indentation, so a nested `notice:` or `clearsOnItsOwn:` is not
 * mistaken for a member. If prettier ever reindents these declarations this stops matching and
 * yields nothing, which the loop below treats as a failure rather than as agreement.
 *
 * The end of the line counts as a terminator as well as a colon or a comma, because prettier
 * leaves no trailing comma on the last member of a set - and a rule that read every member except
 * the last would report drift on two identical lists and, worse, agreement on two that differed
 * only in what each one ends with.
 */
const keysAtTopLevel = (body) =>
  [...body.matchAll(/^ {2}'?([a-z0-9][a-z0-9+._-]*)'?(?:\s*[:,]|\s*$)/gm)]
    .map((match) => match[1])
    .sort()
    .join(',');

const copiedConstants = [
  {
    what: 'the approval correction note bound',
    owner: 'packages/contracts/src/index.ts',
    copy: 'apps/web/src/approval-copy.ts',
    find: /APPROVAL_NOTE_MAX_CHARS = ([\d_]+)/
  },
  {
    what: 'the provider audio receipt reference bound',
    owner: 'packages/contracts/src/dictation.ts',
    copy: 'apps/web/src/AudioReceipts.tsx',
    find: /AUDIO_RECEIPT_REFERENCE_MAX_LENGTH = ([\d_]+)/
  },
  {
    what: 'the maximum dictation reservation',
    owner: 'packages/contracts/src/dictation.ts',
    copy: 'apps/web/src/dictation-preflight.ts',
    find: /DICTATION_MAX_COST_USD = ([\d_]+)/
  },
  ...[
    'VOICE_SAMPLE_RATE',
    'VOICE_FRAME_HEADER_BYTES',
    'VOICE_MAX_FRAME_SAMPLES',
    'VOICE_MAX_SESSION_SECONDS',
    'VOICE_MAX_SPEND_USD',
    'VOICE_PLAYBACK_BUFFER_SECONDS'
  ].map((name) => ({
    what: `the browser voice protocol ${name}`,
    owner: 'packages/contracts/src/voice.ts',
    copy: 'apps/web/src/voice/audio-constants.ts',
    find: new RegExp(`${name} = ([\\d_]+)`)
  })),
  ...['BYTES', 'SECONDS'].map((unit) => ({
    what: `the browser dictation ${unit.toLowerCase()} bound`,
    owner: 'packages/contracts/src/dictation.ts',
    copy: 'apps/web/src/composer-operations.ts',
    find: new RegExp(`DICTATION_MAX_${unit} = ([\\d_]+)`),
    findInCopy: new RegExp(`MAX_DICTATION_${unit} = ([\\d_]+)`)
  })),
  {
    what: 'the encrypted share size bounds',
    owner: 'packages/contracts/src/index.ts',
    copy: 'apps/web/src/share-crypto.ts',
    find: /SHARE_LIMITS = \{([\s\S]*?)\} as const;/,
    findInCopy: /SHARE_BOUNDS = \{([\s\S]*?)\} as const;/,
    normalise: (body) => body.replace(/\/\*[\s\S]*?\*\//g, '')
  },
  {
    what: 'the host disk floor',
    owner: 'services/workspace-runner/src/host-storage.ts',
    copy: 'apps/web/src/usage-model.ts',
    // The body only. Both files declare it with the same name and signature, so matching from the
    // arrow to the semicolon compares the arithmetic and nothing about how it is spelled.
    find: /hostStorageFloorBytes = \(hostStorageTotalBytes: number\): number =>([\s\S]*?);/
  },
  {
    what: 'the spending ceiling limits',
    owner: 'packages/contracts/src/index.ts',
    copy: 'apps/web/src/usage-model.ts',
    find: /MAX_SPEND_CAP_USD = ([\d_]+)/
  },
  {
    what: 'the per-conversation ceiling limit',
    owner: 'packages/contracts/src/index.ts',
    copy: 'apps/web/src/usage-model.ts',
    find: /MAX_TASK_SPEND_USD = ([\d_]+)/
  },
  {
    what: 'the price ceiling limit',
    owner: 'packages/contracts/src/index.ts',
    copy: 'apps/web/src/usage-model.ts',
    // The third bound the settings form refuses a number at, and the one that measures a rate
    // rather than an amount: the two above are dollars per window, this is dollars per million
    // tokens. The copy declares itself loudly and names this file; this is the other half.
    find: /MAX_PRICE_CEILING_USD_PER_MILLION = ([\d_]+)/
  },
  {
    what: 'the coordinate space the private browser works in',
    owner: 'services/workspace-runner/src/browser.ts',
    copy: 'apps/web/src/computer/transport.ts',
    // The object body, so both the width and the height are compared and neither the `as const`
    // nor the name is. The runner launches the browser at this size, publishes the screencast at
    // it and reads every agent-side coordinate off a screenshot of it; the pane divides a human
    // click by it to decide where on the page that click landed. The pane prefers the size the
    // stream reports on each state frame, so this is the answer before the first frame - which is
    // exactly why drift here is silent: the first clicks of every session land wrong and then
    // quietly start landing right.
    find: /BROWSER_VIEWPORT = \{([\s\S]*?)\} as const;/,
    findInCopy: /PAGE_VIEWPORT = \{([\s\S]*?)\};/
  },
  {
    what: 'the formats a render proof is offered on',
    owner: 'services/workspace-runner/src/render-proof.ts',
    copy: 'apps/worker/src/acceptance.ts',
    find: /RENDERABLE_EXTENSIONS[^=]*= new Set\(\[([\s\S]*?)\]\)/,
    // The runner works in the extensions `path.extname` hands it and the worker in what it splits
    // off a name itself, so one side is dotted and the other is not. That difference is spelling;
    // the set is the fact, so the leading dot comes off before the comparison.
    normalise: (body) => body.replace(/\./g, '')
  },
  {
    what: 'the priority journald files a line at',
    owner: 'apps/worker/src/log.ts',
    copy: 'services/workspace-runner/src/log.ts',
    // Arrow to semicolon, so this covers the JOURNAL_STREAM gate as well as the map. A copy that
    // kept the numbers and dropped the gate would print `<4>` at an owner running the runner in a
    // terminal, which is the same fact drifting by the other half.
    find: /journalLevelPrefix = \(level: LogLevel\): string =>([\s\S]*?);/
  },
  {
    what: 'the words that make activating a control consequential, on the desktop',
    owner: 'services/workspace-runner/src/browser.ts',
    copy: 'services/workspace-runner/src/desktop.ts',
    // The alternation only. Three documents promise that destructive operations still confirm in
    // every mode, and this list is the whole of what makes that true for a named control. The two
    // had already drifted - the desktop carried `install|uninstall` and the browser did not - which
    // is how one surface silently stopped keeping a floor the other still kept.
    find: /consequentialText =\s*\/\\b\(([^)]*)\)\\b\/i;/
  },
  {
    what: 'the words that make activating a control consequential, in the worker floor',
    owner: 'services/workspace-runner/src/browser.ts',
    copy: 'apps/worker/src/approval-policy.ts',
    // The runner reads the control's real name and the worker reads what the model said it was
    // doing, so the inputs differ on purpose - but the vocabulary must not, or the authoritative
    // floor stops asking about a word the broker would have caught, and vice versa.
    find: /consequentialText =\s*\/\\b\(([^)]*)\)\\b\/i;/
  },
  {
    what: 'the package managers the privileged helper can carry out an operation for',
    owner: 'services/workspace-runner/src/execution.ts',
    copy: 'apps/worker/src/turn-bounds.ts',
    // The runner decides which manager it can rewrite onto the root helper; the worker decides
    // which command is offered the `system.packages` capability in the first place. A worker list
    // narrower than the runner's is a command refused for a permission it would have been granted
    // - which is exactly what `dnf install` got on every non-Debian box until the wave that
    // widened both. They are two lists because the worker cannot import the runner, and this is
    // the only thing that makes them one fact.
    find: /PACKAGE_OPERATIONS: Record<[^=]*= \{([\s\S]*?)\n\};/,
    findInCopy: /HELPER_PACKAGE_MANAGERS = new Set\(\[([\s\S]*?)\]\)/,
    normalise: keysAtTopLevel
  },
  {
    what: 'the provider walls a task may be parked under',
    owner: 'apps/api/src/maintenance/provider-walls.ts',
    copy: 'apps/worker/src/agent.ts',
    // The worker parks a task under one of these codes and stops; the API's sweep is the only
    // thing that ever wakes it. A code the worker parks under and the sweep does not recognise
    // leaves the work in `awaiting_resource` for ever with nothing left to ask again - strictly
    // worse than failing, which at least tells the owner. The comment on the worker's copy named
    // the wrong file from the moment the table moved out of `server.ts` in Wave 6 until the wave
    // that added this entry, so the drift this guards against had already begun in the prose before
    // it could begin in the values.
    find: /providerWalls: Record<[^=]*= \{([\s\S]*?)\n\};/,
    findInCopy: /PARKABLE_PROVIDER_WALLS = new Set\(\[([\s\S]*?)\]\)/,
    normalise: keysAtTopLevel
  }
];
const drifted = [];
for (const {
  what,
  owner,
  copy,
  find,
  findInCopy = find,
  normalise = (value) => value
} of copiedConstants) {
  const here = read(owner).match(find);
  const there = read(copy).match(findInCopy);
  // A pattern that stops matching is the failure this check exists to prevent, wearing the costume
  // of a pass. Renaming either side has to be as loud as changing the number.
  if (!here || !there) {
    drifted.push(
      `${what} could not be read from ${!here ? owner : copy}; the comparison is no longer running`
    );
    continue;
  }
  const hereValue = normalise(here[1]).replace(/\s+/g, '').trim();
  const thereValue = normalise(there[1]).replace(/\s+/g, '').trim();
  // The same costume, one layer down: a `normalise` whose own pattern has stopped matching
  // compares "" with "" and passes. Every entry here captures something, so nothing may reduce to
  // nothing.
  if (!hereValue || !thereValue)
    drifted.push(
      `${what} normalised to nothing from ${!hereValue ? owner : copy}; the comparison is no longer running`
    );
  else if (hereValue !== thereValue)
    drifted.push(`${what} is "${hereValue}" in ${owner} and "${thereValue}" in ${copy}`);
}
if (drifted.length) for (const message of drifted) fail(message);
else
  say(
    `Copied constants: ${copiedConstants.length} held in two places still match the file that owns them.`
  );

/*
 * The approval card's tool table, against the worker floor that decides what can raise one.
 *
 * The approval card is the only place the ten-item safety floor is ever cashed out to a person, and
 * `approvalToolPhrases` is the half of it that says which tool is asking. A tool with no phrase
 * does not fail: the card falls through to the reversibility class and shows the owner a generic
 * sentence over a JSON dump of the call, which is a decision made on less than the box knows. That
 * is how `audio_read` - whose entire subject is money leaving for a provider - and
 * `parallel_web_read` - whose entire subject is which addresses data leaves by - were both missing
 * for a long time while the comment above the table said it covered every tool that can raise an
 * approval. Nothing failed, because nothing was checking.
 *
 * Read out of the worker's own branches rather than from a list kept beside the table, because a
 * list kept beside the table is precisely what drifted. The floor is `approval-policy.ts` and not
 * `tools.ts`, which only re-exports.
 *
 * Compared as sets in both directions. Uncovered is the failure that reaches an owner; a phrase for
 * a tool the floor can no longer raise is only dead copy, but it is also the shape a rename takes
 * from the other side, and requiring the two to agree is what keeps a regex that has stopped
 * matching from passing this check by covering nothing.
 */
const approvalFloorPath = 'apps/worker/src/approval-policy.ts';
const approvalPhrasePath = 'apps/web/src/approval-copy.ts';
const raisesApproval = [
  ...new Set(
    [...read(approvalFloorPath).matchAll(/\bname === '([a-z_]+)'/g)].map(([, name]) => name)
  )
].sort();
const phraseTable = read(approvalPhrasePath).match(
  /approvalToolPhrases: Record<string, string> = \{([\s\S]*?)\n\};/
);
const phrasedTools = phraseTable ? keysAtTopLevel(phraseTable[1]).split(',').filter(Boolean) : [];
const unphrased = raisesApproval.filter((tool) => !phrasedTools.includes(tool));
const unraised = phrasedTools.filter((tool) => !raisesApproval.includes(tool));
/*
 * A size floor under the agreement above, and the one thing the agreement cannot say.
 *
 * The comparison is two-directional, so it already catches a pattern that narrows: the tools it
 * stops matching are still in the phrase table and come back as `unraised`. What it cannot catch is
 * the two lists shrinking *together*. Delete an approval branch from the floor and tidy its phrase
 * away in the same change, and both sides agree on the smaller set, nothing here says a word, and a
 * tool has quietly stopped asking the owner before it acts. Measured on this tree: removing
 * `audio_read` from both files leaves eighteen tools in perfect agreement and every check above
 * green.
 *
 * What it also cannot say, and what nothing in this repository says, is whether a tool that *ought*
 * to raise an approval does. Both sides of the comparison are derived from the floor, so a tool the
 * floor has never heard of is absent from both and agrees with itself.
 *
 * The floor is therefore a floor and not an equality. A tool that genuinely stops raising an
 * approval is a decision somebody makes, and lowering this number in the same commit - where it is
 * read, and argued with - is the shape that decision has to take.
 *
 * Lowered from 19 to 18 with the removal of the `code_diagnostics` branch, which is that shape.
 * That branch asked before running a repository's own build recipe. It was removed because the
 * identical nine commands run through `shell` with no card in balanced or autonomous - so it was a
 * toll on the phrasing rather than a floor - and because it charged the owner's own Rust project
 * for their own code. What replaced it is not another card: `code_diagnostics` is subtracted from
 * `CHECKPOINT_EXEMPT_TOOLS` in `apps/worker/src/turn-bounds.ts`, so the turn takes an undo point
 * before the build runs, which is the thing the card was standing in for and could not do.
 * `docs/design/floor/DIAGNOSTICS.md` is the whole of it, including what is still uncovered.
 *
 * The two named tools carry the same guarantee for the case where the count is right and the set is
 * wrong. They arrived in this file with the count, out of `apps/web/src/approval-copy.test.ts`,
 * which asserted both across a package boundary because it had nowhere better to say them; its own
 * comment had already recorded that this comparison belonged here, "so a new branch in the worker
 * fails the build rather than one client's test suite".
 */
/*
 * Lowered again, from 18 to 17, when `publish_site` was folded into `publish_preview` as a `reach`
 * argument - and this one is a MERGE rather than a removal, which is the other way this number can
 * legitimately fall and the way that most resembles the failure above.
 *
 * Nothing stopped asking. The floor raises the same external_consequential card for the same act,
 * in all three security modes and on clean and tainted turns alike; it reads the reach off the call
 * (`publishReachOfCall` in apps/worker/src/approval-policy.ts) instead of reading a second tool
 * name, which is what let the two tools become one without the public half going silent. Measured
 * through `evals/cards` over ten owner scenarios and 178 calls: not one count moved, in any mode,
 * on either column. What this number counts is NAMES, and one name went.
 *
 * The order mattered and is the whole reason this is one commit: with the floor still reading
 * names, `publish_preview {reach:'public'}` raised NOTHING in balanced - the default - or in
 * autonomous, on a clean turn. Floor first, merge second.
 *
 * `apps/web/src/approval-copy.test.ts` carries the same figure over the same regex and came down in
 * the same change.
 */
const APPROVAL_FLOOR_MINIMUM = 17;
/*
 * The witnesses answer the case where the count is right and the set is wrong.
 *
 * Two rather than three since the `code_diagnostics` witness went with the branch it witnessed.
 * Both remaining names are tools that were merely unphrased for a long time while their entire
 * subject - money leaving for a provider, and which addresses data leaves by - is the thing an
 * owner most needs a card to name.
 */
const APPROVAL_FLOOR_WITNESSES = ['audio_read', 'parallel_web_read'];
const missingWitnesses = APPROVAL_FLOOR_WITNESSES.filter((tool) => !raisesApproval.includes(tool));
if (!raisesApproval.length)
  fail(
    `no approval-raising tools could be read from ${approvalFloorPath}; the approval card's table is no longer being checked against anything`
  );
else if (raisesApproval.length < APPROVAL_FLOOR_MINIMUM)
  fail(
    `only ${raisesApproval.length} approval-raising tools were read from ${approvalFloorPath}, against ${APPROVAL_FLOOR_MINIMUM} expected; the pattern has narrowed and the agreement below covers a subset of the floor`
  );
else if (missingWitnesses.length)
  fail(
    `${missingWitnesses.join(', ')} is not among the tools read out of ${approvalFloorPath}; either the pattern has drifted to an older spelling and the comparison below is running against a subset of the floor, or that tool deliberately stopped raising an approval and this witness must be replaced in the same change`
  );
else if (!phrasedTools.length)
  fail(
    `approvalToolPhrases could not be read from ${approvalPhrasePath}; the approval card's table is no longer being checked against anything`
  );
else if (unphrased.length)
  fail(
    `${unphrased.join(', ')} can raise an approval in ${approvalFloorPath} and has no phrase in ${approvalPhrasePath}; the card would ask the owner to decide from the reach class and a dump of the call`
  );
else if (unraised.length)
  fail(
    `${unraised.join(', ')} has a phrase in ${approvalPhrasePath} and no longer raises an approval in ${approvalFloorPath}; either the tool was renamed and the card has stopped naming it, or the phrase is dead`
  );
else
  say(
    `Approval phrases: all ${raisesApproval.length} tools that can raise an approval are named on the card.`
  );

/**
 * The gates `pnpm check` actually runs, against the list a contributor is handed.
 *
 * Same failure as the server commands above, one directory up: a gate is added to the script and
 * the page describing it is not, so somebody reads a list of eight and runs nine, and the one that
 * fails is the one nothing prepared them for. Read from `package.json` rather than from a list kept
 * beside it, because a list kept beside it is what drifts.
 *
 * Order is checked too, and it is not a nicety. The order is the whole design of that section -
 * cheapest first, so the gate that fails is usually the one that costs least to re-run - and a page
 * that lists them in a different order is advice to run them in a more expensive one.
 */
const CONTRIBUTING_PATH = 'CONTRIBUTING.md';
const contributing = read(CONTRIBUTING_PATH);
const checkScript = JSON.parse(read('package.json')).scripts?.check ?? '';
// `pnpm license:check` and `node scripts/check-repository.mjs` reduce to the token a reader would
// search the page for. Anything else in the chain - an env assignment, a shell conditional - is a
// shape this has never had and would rather report than silently drop.
const gates = checkScript
  .split('&&')
  .map((step) => step.trim())
  .filter(Boolean)
  .map((step) => {
    const named = /^(?:pnpm|node)\s+(\S+)$/.exec(step);
    return named ? named[1] : step;
  });
if (gates.length < 5)
  fail(
    `only ${gates.length} gates could be read out of package.json's check script; the list in ${CONTRIBUTING_PATH} is no longer being checked against anything`
  );
else {
  // Named in backticks, with or without the runner in front of it: the page writes
  // `pnpm license:check` and `node scripts/check-repository.mjs`, and a reader searching for either
  // half finds the same line. Matching the bare token would miss every one of them.
  const named = (gate) =>
    contributing.search(
      new RegExp(String.raw`\`(?:(?:pnpm|node) )?${gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``)
    );
  const missingGates = gates.filter((gate) => named(gate) === -1);
  const positions = gates.map(named);
  const outOfOrder = positions.some(
    (at, index) => index > 0 && at >= 0 && positions[index - 1] >= 0 && at < positions[index - 1]
  );
  if (missingGates.length)
    fail(
      `pnpm check runs ${missingGates.join(', ')}, which ${CONTRIBUTING_PATH} never names; a contributor would meet a gate the page did not prepare them for`
    );
  else if (outOfOrder)
    fail(
      `${CONTRIBUTING_PATH} lists the gates of pnpm check in a different order from the one they run in; the order is cheapest-first and the page is advice to run them in a costlier one`
    );
  else say(`Check gates: all ${gates.length} run by pnpm check are listed, in order.`);
}

/**
 * Every shell drill on disk is a drill the contributing page names.
 *
 * These are the only cover the server's shell has - the TypeScript suites never parse it - and
 * `test-update.sh` has nothing behind it but that list, so a drill nobody is told to run is a drill
 * nobody runs. Discovered from the directory rather than listed, so the next one is covered by
 * existing.
 */
const drills = readdirSync(path.join(repositoryRoot, 'scripts'))
  .filter((name) => name.startsWith('test-') && name.endsWith('.sh'))
  .sort();
const undocumentedDrills = drills.filter((name) => !contributing.includes(`scripts/${name}`));
const imaginaryDrills = [
  ...new Set([...contributing.matchAll(/scripts\/(test-[a-z-]+\.sh)/g)].map(([, name]) => name))
].filter((name) => !drills.includes(name));
if (drills.length < 3)
  fail(
    `only ${drills.length} shell drills were found under scripts/; the directory is no longer being read rather than the set being that small`
  );
else if (undocumentedDrills.length)
  fail(
    `scripts/ carries ${undocumentedDrills.join(', ')}, which ${CONTRIBUTING_PATH} never names; the only thing that tells anyone to run a drill is that list`
  );
else if (imaginaryDrills.length)
  fail(
    `${CONTRIBUTING_PATH} tells a contributor to run ${imaginaryDrills.join(', ')}, which scripts/ does not contain`
  );
else say(`Shell drills: all ${drills.length} under scripts/ are named in ${CONTRIBUTING_PATH}.`);

/**
 * The figures `docs/EVALUATION.md` quotes, re-derived from the baseline it says it reads.
 *
 * That page carried its own numbers in prose with an instruction to re-derive them from
 * `evals/baseline.json` after any change rather than copy the sentence forward. They were copied
 * forward anyway - three times, ending in three different values for one subtraction - which is the
 * failure mode of every instruction that asks a person to do what a program could. A stale figure in
 * prose is worse than no figure, because it reads exactly like a measurement.
 *
 * So the page now carries them once, in a fenced `baseline` block, and this re-derives the whole
 * block. Accepting a new baseline fails here until the page is re-derived, and the failure names the
 * value it should now carry. Four of the lines are arithmetic over two cells rather than cells
 * themselves, and the subtraction is done here so that the claim the page makes about what a
 * compaction costs is a computation rather than a recollection.
 */
const EVALUATION_PATH = 'docs/EVALUATION.md';
const CONDENSED = 'long-a-finished-phase-is-condensed-and-nothing-is-taken-quietly';
const NEVER_DECLARED = 'long-a-finished-phase-is-never-declared';
const FLOOR_WALK = 'long-finished-phases-condense-rather-than-shred';
const evaluationBlock = /```baseline\n([\s\S]*?)```/.exec(read(EVALUATION_PATH));
const baseline = JSON.parse(read('evals/baseline.json'));
const cell = (fixture, field) => baseline[fixture]?.[field];
/** What each key in the block is worth, computed here and never read from the page. */
const derived = {
  fixtures: Object.keys(baseline).filter((key) => key !== '$stamp').length,
  'compaction.extraModelCalls': cell(CONDENSED, 'modelCalls') - cell(NEVER_DECLARED, 'modelCalls'),
  'compaction.tokensSaved': cell(NEVER_DECLARED, 'promptTokens') - cell(CONDENSED, 'promptTokens'),
  'compaction.cachePointsGivenUp':
    cell(NEVER_DECLARED, 'cachePrefix') - cell(CONDENSED, 'cachePrefix'),
  'floorWalk.cachePointsLost': cell(CONDENSED, 'cachePrefix') - cell(FLOOR_WALK, 'cachePrefix')
};
if (!evaluationBlock)
  fail(
    `${EVALUATION_PATH} no longer carries a fenced \`baseline\` block; its figures are back to being prose nothing re-derives`
  );
else {
  const quoted = evaluationBlock[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(/\s+/);
      return [key, Number(rest.join('').replace(/[,_]/g, ''))];
    });
  const drift = [];
  for (const [key, quotedValue] of quoted) {
    // Two shapes of key: a derived name computed above, and `<fixture>.<field>` read straight out
    // of the baseline. Anything else is a line nobody can check, which is the state the page was
    // in before this existed.
    let actual = derived[key];
    if (actual === undefined) {
      const at = key.lastIndexOf('.');
      actual = at === -1 ? undefined : cell(key.slice(0, at), key.slice(at + 1));
    }
    if (actual === undefined || Number.isNaN(actual))
      drift.push(`${key} names nothing in evals/baseline.json`);
    else if (actual !== quotedValue)
      drift.push(
        `${key} says ${quotedValue.toLocaleString('en-GB')} and is ${actual.toLocaleString('en-GB')}`
      );
  }
  // A block that stopped parsing would agree with everything by quoting nothing, which is this
  // check failing while it looks like it passed.
  if (quoted.length < 8)
    fail(
      `${EVALUATION_PATH}'s baseline block yielded only ${quoted.length} figure${quoted.length === 1 ? '' : 's'}; it is no longer being read rather than the page being that short`
    );
  else if (drift.length)
    fail(
      `${EVALUATION_PATH} is out of date against evals/baseline.json - ${drift.join('; ')}. Re-derive the block rather than editing the prose around it.`
    );
  else
    say(
      `Evaluation figures: all ${quoted.length} in ${EVALUATION_PATH} re-derive from evals/baseline.json.`
    );
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.map((message) => `- ${message}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  say('Repository checks passed.');
}
