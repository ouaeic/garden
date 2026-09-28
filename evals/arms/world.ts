/**
 * One deterministic computer, and every tool is a different window onto it.
 *
 * This is the load-bearing design decision of the live half and it is worth stating why, because
 * the obvious alternative silently decides the result.
 *
 * The obvious alternative is a table of canned replies keyed by tool name. Under it, an arm that
 * holds `document_read` gets the contract's text and an arm that does not gets an apology - so the
 * table, not the model, decides which arm completes the task, and the rig reports the author's
 * expectation back to them with a decimal point on it.
 *
 * Here there is one small filesystem and one small index, and every tool reads or writes THAT. A
 * model holding `document_read` finds the renewal date through `document_search`; a model holding
 * only `shell` finds the same date through `grep`, in more calls. Both are right, and the
 * difference between them is turns and tokens - which is exactly the quantity the whole programme
 * turns on, because a strong model hides a bad harness by paying for it, and turns are what it
 * pays with.
 *
 * Two rules this file must never break:
 *   1. A result is a function of the call alone. Not of the arm, not of the step, not of the
 *      history. An oracle that can see which arm is asking is an oracle that can favour one.
 *   2. Nothing here is reachable by one arm and unreachable by another. Where a fact exists it is
 *      reachable through `shell`, because `shell` is in every arm. A fact only the full catalogue
 *      can reach is not a measurement of the catalogue, it is an assumption about it.
 */

/** The workspace, matching the one `evals/fixtures.ts` gives most of its rows. */
const FILES: Record<string, string> = {
  'workspace/notes.txt': 'Renewal is due on 14 March 2027 at the standard rate.\n',
  'workspace/contract.pdf':
    'Clause 7: either party may terminate with 60 days written notice.\nClause 8: renewal is automatic unless notice is given.\n',
  'workspace/importer.py': 'def load(rows):\n    return rows\n',
  'workspace/GARDEN.md': '# Project brief\n\nNothing recorded yet.\n'
};

const written = new Map<string, string>();

/** Reset between arms so a write in one arm cannot be read by the next. Called by the runner. */
export const resetWorld = (): void => written.clear();

const read = (path: string): string | null => {
  const key = path.replace(/^\.?\//, '');
  return written.get(key) ?? FILES[key] ?? null;
};

const allPaths = (): readonly string[] =>
  [...new Set([...Object.keys(FILES), ...written.keys()])].sort();

const grep = (needle: string): readonly string[] => {
  const hits: string[] = [];
  for (const path of allPaths())
    for (const [index, line] of (read(path) ?? '').split('\n').entries())
      if (line.toLowerCase().includes(needle.toLowerCase()))
        hits.push(`${path}:${index + 1}: ${line}`);
  return hits;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A shell that understands the four things a model actually reaches for when it has no reader.
 *
 * Not a shell. It answers `ls`, `cat`, `grep` and `find` over the same filesystem the readers see,
 * and says plainly that it does not understand anything else - which is the honest failure, and one
 * the model can recover from by trying something else. Pretending to run an arbitrary command and
 * returning a plausible empty result would let an arm "succeed" on a command that did nothing.
 */
const shell = (command: string): string => {
  const trimmed = command
    .replace(/^bash\s+-lc\s+/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  const ls = /^ls(\s+-\w+)*\s*(.*)$/.exec(trimmed);
  if (ls) return allPaths().join('\n');
  const cat = /^cat\s+(\S+)$/.exec(trimmed);
  if (cat) {
    const body = read(cat[1] as string);
    return body ?? `cat: ${cat[1]}: No such file or directory`;
  }
  const grepCall = /^grep\s+(?:-\w+\s+)*['"]?([^'"]+?)['"]?(\s+\S+)?$/.exec(trimmed);
  if (grepCall) {
    const hits = grep(grepCall[1] as string);
    return hits.length ? hits.join('\n') : '';
  }
  if (/^find\b/.test(trimmed)) return allPaths().join('\n');
  return `garden-eval: this rig's shell understands ls, cat, grep and find over the workspace, and was given: ${trimmed}`;
};

export interface OracleResult {
  readonly content: string;
  /** True only for `finish`: the turn is over and the run is scored. */
  readonly terminal: boolean;
}

const ok = (content: string): OracleResult => ({ content, terminal: false });

/**
 * The oracle. Every branch reads the same world; the fallback is deliberately an honest refusal
 * rather than a plausible success, so an arm cannot complete a task by calling something this rig
 * does not model.
 */
export const answer = (name: string, args: Record<string, unknown>): OracleResult => {
  switch (name) {
    case 'finish':
      return { content: 'Turn ended.', terminal: true };
    case 'set_plan':
    case 'set_acceptance':
      return ok('Recorded.');
    case 'shell':
      return ok(shell(text(args.command)));
    case 'files_list':
      return ok(allPaths().join('\n'));
    case 'file_read': {
      const body = read(text(args.path));
      return ok(body ?? `No such file: ${text(args.path)}`);
    }
    case 'file_write':
      written.set(text(args.path).replace(/^\.?\//, ''), text(args.content));
      return ok(`Wrote ${text(args.path)}.`);
    case 'file_patch':
      return ok(`Patched ${text(args.path)}.`);
    case 'code_search':
    case 'session_search':
    case 'document_search': {
      const hits = grep(text(args.query) || text(args.pattern));
      return ok(hits.length ? hits.join('\n') : 'No matches.');
    }
    case 'document_read': {
      const body = read(text(args.path) || text(args.documentId));
      return ok(body ?? 'No such document.');
    }
    case 'repo_overview':
      return ok(allPaths().join('\n'));
    case 'connector_list':
      return ok('No connectors are configured on this computer.');
    case 'web_search':
      return ok(
        'This rig has no network. Treat the web as unavailable and work from what is on the computer.'
      );
    case 'skill':
      return ok(
        'This rig does not open skill bodies: what is being measured is whether the index changes what the model reaches for, not what a body says once opened.'
      );
    default:
      return ok(
        `garden-eval: ${name} is not modelled by this rig. Reach the same fact another way, or finish with what you have.`
      );
  }
};

/**
 * What a runner needs from a world, so the loop is not welded to this one.
 *
 * `live.ts` drives a provider, a tool loop and a step ceiling, and none of that is specific to the
 * filesystem below. The edit arm asks the same questions of a different world - the corpus files,
 * both appliers as they ship, and a read side that carries line numbers - and copying the loop to
 * get it would produce two loops that agree until somebody fixes a bug in one of them.
 *
 * `reset` is on the interface rather than called by name because a world that has to be reset by
 * the runner is a world the runner can forget to reset, and the first symptom of that is one arm
 * reading a file the previous arm wrote.
 */
export interface Oracle {
  reset(): void;
  answer(name: string, args: Record<string, unknown>): OracleResult;
}

/** The general sample's world, as an oracle. */
export const WORLD_ORACLE: Oracle = { reset: resetWorld, answer };
