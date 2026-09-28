import { readFileSync } from 'node:fs';
import type { BuildIdentity } from '@garden/contracts';

/** Everything below the running file: `apps/worker/{src,dist}` sit the same distance from it. */
const checkoutRoot = new URL('../../../', import.meta.url);

const readTextFile = (file: URL): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** A directory that may be named absolutely or from where the file naming it sits. */
const directoryNamed = (name: string, from: URL): URL =>
  new URL(name.endsWith('/') ? name : `${name}/`, from);

const FULL_REVISION = /^[0-9a-f]{40}$/;

/**
 * What HEAD points at, read out of git's own files rather than by running git: this is a boot path,
 * it runs under systemd where there is barely a PATH, and the files involved are a documented
 * format that has not changed in twenty years.
 *
 * Installing at a pinned tag leaves HEAD detached, so it holds the revision itself. `garden update`
 * checks out a branch and pulls, so from then on it is a reference to a loose file. A clone that has
 * never moved has neither, and the reference is in the packed set instead. A linked worktree - which
 * is a developer's tree and never a box - keeps its HEAD apart from the refs both of them mean, and
 * says where each lives.
 */
const headRevision = (): string | null => {
  const linked = /^gitdir:\s*(.+)$/m.exec(readTextFile(new URL('.git', checkoutRoot)) ?? '')?.[1];
  const gitDirectory = linked
    ? directoryNamed(linked.trim(), checkoutRoot)
    : new URL('.git/', checkoutRoot);
  const common = readTextFile(new URL('commondir', gitDirectory))?.trim();
  const refsDirectory = common ? directoryNamed(common, gitDirectory) : gitDirectory;
  const head = readTextFile(new URL('HEAD', gitDirectory))?.trim();
  if (!head) return null;
  const reference = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!reference) return FULL_REVISION.test(head) ? head.slice(0, 7) : null;
  // A path taken out of a file and turned into another file to read is worth bounding, even where
  // the file it came from is our own.
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(reference)) return null;
  const loose = readTextFile(new URL(reference, refsDirectory))?.trim();
  if (loose && FULL_REVISION.test(loose)) return loose.slice(0, 7);
  for (const line of (readTextFile(new URL('packed-refs', refsDirectory)) ?? '').split('\n')) {
    const [revision, name] = line.trim().split(' ');
    if (name === reference && revision && FULL_REVISION.test(revision)) return revision.slice(0, 7);
  }
  return null;
};

/**
 * Which build this process is.
 *
 * Derived at runtime, deliberately, rather than stamped in by the build. `pnpm -r build` is not the
 * only way a dist directory comes to exist, and a stamp that is absent whenever the step did not run
 * spends its life reading "unknown" - an identity that is usually unknown is not an identity, and it
 * is worse than none because it looks like one. Both halves here are facts about the tree the
 * running file is sitting in, which cannot go stale: the version out of the one package.json that
 * `scripts/check-repository.mjs` already holds the printed install command to, so it names the
 * release a new box is handed rather than a number in a file; and the revision out of the checkout,
 * because `garden update` is a `git pull` and HEAD is the thing it moved.
 *
 * Worked out once. A box that has been updated in place is running the code it started with, so a
 * second reading would answer for a tree this process is no longer the product of.
 */
let identity: BuildIdentity | null = null;
export const buildIdentity = (): BuildIdentity =>
  (identity ??= { version: declaredVersion(), commit: headRevision() });

const declaredVersion = (): string => {
  try {
    const manifest = JSON.parse(readTextFile(new URL('package.json', checkoutRoot)) ?? '{}') as {
      version?: string;
    };
    return manifest.version ?? 'unknown';
  } catch {
    // Nothing about a build identity is worth taking a process down for, and a checkout whose
    // package.json will not parse has already failed at something louder than this.
    return 'unknown';
  }
};
