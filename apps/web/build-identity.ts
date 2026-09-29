import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Identical source and dependencies produce one identity, including in an unpacked checkout. */
export const webBuildId = (): string => {
  const hash = createHash('sha256');
  const visit = (path: string, relative: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child, `${relative}/${entry.name}`);
      else if (entry.isFile())
        hash
          .update(`${relative}/${entry.name}`)
          .update('\0')
          .update(readFileSync(child))
          .update('\0');
    }
  };
  visit(fileURLToPath(new URL('./src', import.meta.url)), 'src');
  visit(fileURLToPath(new URL('./public', import.meta.url)), 'public');
  visit(fileURLToPath(new URL('../../packages/contracts/src', import.meta.url)), 'contracts');
  for (const name of [
    'package.json',
    'vite.config.ts',
    'build-identity.ts',
    '../../pnpm-lock.yaml'
  ])
    hash.update(readFileSync(new URL(name, import.meta.url)));
  return hash.digest('hex');
};

export const buildIdentity = (id: string): Plugin => ({
  name: 'garden-build-identity',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ id }) });
  },
  writeBundle(options) {
    if (!options.dir) throw new Error('The garden output directory is missing');
    const worker = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
    writeFileSync(resolve(options.dir, 'sw.js'), worker.replace('__GARDEN_SHELL_BUILD__', id));
  }
});
