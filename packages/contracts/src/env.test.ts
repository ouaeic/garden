import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sharedEnv } from './env.js';

/**
 * The audit that makes `sharedEnv` mean something.
 *
 * Every garden unit parses its environment with its own zod schema, and on a packaged install all
 * of them are started from the same control.env. Two schemas that disagree about one key is a box
 * that half starts: the operator raises TASK_MAX_STEPS, the worker accepts the number, the API
 * refuses to boot, and nothing in either message mentions the other. This walks the config schemas
 * and fails if a shared key has drifted from the single declaration - which is the only check that
 * can catch it, because the two processes never compare notes at runtime.
 */
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

const readOrNull = (relativePath: string): string | null => {
  try {
    return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
  } catch {
    return null;
  }
};

/**
 * Every file in this repository that parses an environment into a zod schema.
 *
 * A unit normally keeps its schema in `src/config.ts`. `services/model-registry` has no config
 * module - it is one loop with no exported surface - and declares its schema inline in
 * `src/index.ts`, so an index is read as well, but only where the unit has no `config.ts` and the
 * file both builds a zod object and parses `process.env`. That pair is what separates an
 * environment schema from `packages/contracts/src/index.ts`, which is full of zod objects and
 * reads no environment at all.
 *
 * This looked at `config.ts` and nothing else, which meant the registry's twelve keys had never
 * been compared with anybody's - and three of them had drifted, including an AI_PROVIDER value the
 * API and the worker both refuse to start on. A walk that misses a schema is not a narrower audit,
 * it is a green light for the one file nobody is reading.
 */
const configPaths = (): string[] => {
  const found: string[] = [];
  for (const group of ['apps', 'packages', 'services']) {
    for (const entry of readdirSync(path.join(repositoryRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const config = `${group}/${entry.name}/src/config.ts`;
      if (readOrNull(config) !== null) {
        found.push(config);
        continue;
      }
      const index = `${group}/${entry.name}/src/index.ts`;
      const inline = readOrNull(index);
      // A package without a config schema has nothing to disagree with.
      if (inline?.includes('z.object({') && inline.includes('process.env')) found.push(index);
    }
  }
  return found.sort();
};

/**
 * The declaration written against each environment key in one file.
 *
 * Keys sit at exactly one level of indentation inside the schema object, which is what separates
 * them from the options nested inside a declaration. Comments and whitespace are stripped so that
 * comparison is between what zod is asked to enforce and nothing else - two declarations that
 * differ only in line breaks are the same rule, and prettier decides where those breaks go.
 */
const declarations = (source: string): Map<string, string> => {
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
  const found = new Map<string, string>();
  const lines = withoutComments.split('\n');
  let key: string | null = null;
  let collected: string[] = [];
  const finish = () => {
    if (key) found.set(key, collected.join('').replaceAll(/\s+/g, '').replace(/,$/, ''));
    key = null;
    collected = [];
  };
  for (const line of lines) {
    const start = /^ {2}([A-Z][A-Z0-9_]*):(.*)$/.exec(line);
    if (start) {
      finish();
      key = start[1]!;
      collected = [start[2]!];
    } else if (key) {
      if (/^ {2}\S/.test(line) || /^\}/.test(line)) finish();
      else collected.push(line);
    }
  }
  finish();
  return found;
};

/**
 * Where a shared key is deliberately, or knowingly, declared differently from `sharedEnv`.
 *
 * An entry is a statement that someone looked. Anything not listed here has to match, and a listing
 * that no longer describes a real difference fails too, so this table cannot quietly become a place
 * where divergence is parked.
 */
const recordedDivergences: Array<{ file: string; key: string; because: string }> = [
  {
    file: 'apps/worker/src/config.ts',
    key: 'WORKER_ID',
    because:
      'A process names itself. The API embeds a worker in development and the packaged install runs a separate one; a shared default would give both the same lease owner, and a lease is exactly the thing two holders must not share.'
  },
  {
    file: 'services/notifications/src/config.ts',
    key: 'DATABASE_DRIVER',
    because:
      'The notifier only ever runs from a control.env that sets this, and has no development shape that would use the embedded database, so it defaults to the packaged install driver. It also cannot import this declaration: it does not depend on @garden/contracts, and adding the dependency rewrites the lockfile.'
  },
  {
    file: 'services/notifications/src/config.ts',
    key: 'DATA_MASTER_KEY',
    because:
      'Optional in both, and stricter here on purpose: the notifier decodes the key itself rather than handing it to @garden/data, so a value that is not exactly 32 bytes of base64 does not fail somewhere legible - it decodes to the wrong length and every push silently reads "Untitled conversation", which is the defect this key was wired to end. Refusing at load is the only place that failure has a sentence. It cannot import the shared declaration for the same reason DATABASE_DRIVER and PUSH_VAPID_PUBLIC_KEY above cannot: services/notifications does not depend on @garden/contracts, and adding the dependency rewrites the lockfile.'
  },
  {
    file: 'services/notifications/src/config.ts',
    key: 'PUSH_VAPID_PUBLIC_KEY',
    because:
      'The API reads an empty value as absent; the notifier does not, so a key blanked by hand rather than removed fails its schema and crash-loops the unit, which is the failure its own comment sets out to avoid. The installer only ever writes a generated pair or aborts, so this is latent. Held by whoever owns services/notifications, which cannot import this declaration either.'
  },
  {
    file: 'services/workspace-runner/src/config.ts',
    key: 'RESERVED_PREVIEW_PORTS',
    because:
      'One name across both processes, and deliberately not one declaration: the runner reads this from its own runner.env, where the installer writes every reserved port as text because the runner can derive none of them, and parses it to numbers. The API reads control.env, derives its own listener, the gateway, the runner and the database from settings it already holds, and defaults to the three sibling health ports it cannot see. Sharing the declaration would mean sharing the default, which is empty for one and those three ports for the other.'
  },
  {
    file: 'services/workspace-runner/src/config.ts',
    key: 'RUNNER_SHARED_SECRET',
    because:
      'The runner has no path that works without this secret, so its schema requires it outright rather than accepting the key as absent and failing afterwards with a sentence. The other three units check it in loadConfig because they carry several such keys and report them together.'
  }
];

describe('shared environment declarations', () => {
  const files = configPaths();
  const perFile = new Map(
    files.map((file) => [file, declarations(readFileSync(path.join(repositoryRoot, file), 'utf8'))])
  );
  const shared = declarations(
    readFileSync(path.join(repositoryRoot, 'packages/contracts/src/env.ts'), 'utf8')
  );
  const divergence = (file: string, key: string) =>
    recordedDivergences.find((entry) => entry.file === file && entry.key === key);

  it('finds the schemas it is supposed to be auditing', () => {
    // A rename that moved a config schema elsewhere would otherwise turn this whole file into a
    // test that passes because it examined nothing.
    expect(files).toContain('apps/api/src/config.ts');
    expect(files).toContain('apps/worker/src/config.ts');
    expect(files).toContain('services/workspace-runner/src/config.ts');
    // Named because it is the one this walk used to miss: its schema is inline in index.ts, so a
    // walk of config.ts alone left it the only unit in the repository nothing compared.
    expect(files).toContain('services/model-registry/src/index.ts');
    // And no further: this file is a few hundred zod objects and reads no environment at all, so a
    // walk that took every `index.ts` would audit the request contracts as if they were settings
    // and report every one of them as a key two processes disagree about.
    expect(files).not.toContain('packages/contracts/src/index.ts');
    expect(new Set(Object.keys(sharedEnv))).toEqual(new Set(shared.keys()));
  });

  it('declares every key more than one process reads exactly once', () => {
    const readers = new Map<string, string[]>();
    for (const [file, keys] of perFile)
      for (const key of keys.keys()) readers.set(key, [...(readers.get(key) ?? []), file]);
    const unshared = [...readers]
      .filter(([key, holders]) => holders.length > 1 && !(key in sharedEnv))
      .filter(([key, holders]) => !holders.some((file) => divergence(file, key)))
      .map(([key, holders]) => `${key} (${holders.join(', ')})`);
    expect(unshared).toEqual([]);
  });

  it('holds every process to the same rule for a shared key', () => {
    const drifted: string[] = [];
    for (const [file, keys] of perFile) {
      for (const [key, declared] of keys) {
        if (!(key in sharedEnv) || divergence(file, key)) continue;
        const expected = shared.get(key)!;
        if (declared !== `sharedEnv.${key}` && declared !== expected)
          drifted.push(`${file} declares ${key} as ${declared}, not ${expected}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('keeps the record of deliberate differences honest', () => {
    const stale = recordedDivergences.filter(({ file, key }) => {
      const declared = perFile.get(file)?.get(key);
      if (declared === undefined) return true;
      return declared === `sharedEnv.${key}` || declared === shared.get(key);
    });
    expect(stale).toEqual([]);
    for (const entry of recordedDivergences) expect(entry.because.length).toBeGreaterThan(80);
  });

  it('bounds a task the same way in every process that runs one', () => {
    // The defect that produced this file: a value the worker accepted stopped the API from
    // starting. Asserted against the parsed schema rather than the source text, because it is the
    // bound and not the wording that an operator meets.
    expect(sharedEnv.TASK_MAX_STEPS.parse(undefined)).toBe(120);
    expect(sharedEnv.TASK_MAX_STEPS.parse('300')).toBe(300);
    expect(() => sharedEnv.TASK_MAX_STEPS.parse('401')).toThrow();
    expect(() => sharedEnv.TASK_MAX_STEPS.parse('0')).toThrow();
  });
});
