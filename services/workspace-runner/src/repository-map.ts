import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireScope } from './auth.js';
import { assertOpenedInPlace, assertUserDataPath, resolveInside, workspacePath } from './files.js';
import { execute, type ExecutionOptions } from './execution.js';
import type { ParsedSource, SourceDefinition } from './repository-parser.js';

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.r': 'r',
  '.R': 'r',
  '.c': 'cpp',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp'
};
const MAX_FILE_BYTES = 512 * 1024,
  MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024,
  MAX_SCAN_FILES = 2_000;
const Request = z
  .object({
    path: z.string().min(1).max(4_096),
    query: z.string().max(2_000).default(''),
    maxSymbols: z.number().int().min(1).max(300).default(120)
  })
  .strict();
type Indexed = { path: string; hash: string; parsed: ParsedSource };
type Definition = SourceDefinition & { path: string; hash: string };
export interface RepositoryMap {
  engine: 'tree-sitter';
  parsedPaths: string[];
  importantSymbols: Array<
    Definition & { candidateCallers: Array<{ path: string; line: number; caller?: string }> }
  >;
  symbolCount: number;
  symbolsTruncated: boolean;
  filesRepresented: number;
  coverage: {
    filesParsed: number;
    sourceFiles: number;
    unsupportedSourceFiles: number;
    scanComplete: boolean;
    parseErrorCount: number;
    truncatedFileCount: number;
    skippedCount: number;
    parseErrors: string[];
    truncatedFiles: string[];
    skipped: Array<{ path: string; reason: string }>;
    cacheHits: number;
  };
}

/** Short-lived parser workers receive source text, never paths, credentials or executable code. */
class ParseWorker {
  #worker: Worker | undefined;
  async parse(language: string, source: string): Promise<ParsedSource> {
    const worker = (this.#worker ??= new Worker(
      new URL(
        import.meta.url.endsWith('.ts') ? './repository-parser.ts' : './repository-parser.js',
        import.meta.url
      ),
      { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } }
    ));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        finish(new Error('Parser exceeded its time budget'));
      }, 5_000);
      const message = (response: { value?: ParsedSource; error?: string }) =>
        response.value
          ? finish(null, response.value)
          : finish(new Error(response.error ?? 'Parser returned no result'));
      const error = (cause: Error) => {
        this.close();
        finish(cause);
      };
      const exited = () => finish(new Error('Parser exited before returning a result'));
      const finish = (cause: Error | null, value?: ParsedSource) => {
        clearTimeout(timer);
        worker.off('message', message);
        worker.off('error', error);
        worker.off('exit', exited);
        if (cause) reject(cause);
        else resolve(value!);
      };
      worker.once('message', message);
      worker.once('error', error);
      worker.once('exit', exited);
      worker.postMessage({ language, source });
    });
  }
  close(): void {
    void this.#worker?.terminate();
    this.#worker = undefined;
  }
}

export class RepositoryMapper {
  #cache = new Map<string, { value: ParsedSource; bytes: number }>();
  #cacheBytes = 0;
  #closed = false;
  #active = new Set<ParseWorker>();
  constructor(private readonly run: typeof execute = execute) {}
  close(): void {
    this.#closed = true;
    for (const worker of this.#active) worker.close();
    this.#cache.clear();
    this.#cacheBytes = 0;
  }
  async map(
    root: string,
    value: unknown,
    options: ExecutionOptions,
    signal?: AbortSignal
  ): Promise<RepositoryMap> {
    if (this.#closed) throw new Error('Repository analysis is closed');
    if (this.#active.size >= 2) throw new Error('Repository analysis is busy; retry shortly');
    const request = Request.parse(value),
      relative = assertUserDataPath(root, request.path);
    if (relative !== 'workspace' && !relative.startsWith('workspace/'))
      throw new Error('Choose a directory inside the workspace');
    const project = resolveInside(root, relative);
    const worker = new ParseWorker();
    this.#active.add(worker);
    const abort = () => worker.close();
    signal?.addEventListener('abort', abort, { once: true });
    const started = Date.now();
    try {
      signal?.throwIfAborted();
      if ((await realpath(project)) !== project || !(await stat(project)).isDirectory())
        throw new Error('Repository path must be a real workspace directory');
      const listing = await this.run(
        root,
        {
          executable: '/usr/bin/rg',
          args: [
            '--files',
            '--null',
            '--sort',
            'path',
            '--glob',
            '!**/{node_modules,dist,build,vendor,.venv,venv,__pycache__}/**',
            '.'
          ],
          cwd: relative,
          network: false,
          timeoutSeconds: 20,
          maxOutputBytes: 1024 * 1024
        },
        { ...options, ...(signal ? { abortSignal: signal } : {}) }
      );
      if (![0, 1].includes(listing.exitCode ?? -1) || listing.timedOut)
        throw new Error(listing.stderr || 'Could not enumerate repository sources');
      const listingTruncated = listing.stdout.includes(
        ' bytes omitted from stdout; beginning and end preserved '
      );
      const allFiles = listing.stdout
        .split('\0')
        .filter(
          (file) =>
            Boolean(file) &&
            !file.includes(' bytes omitted from stdout; beginning and end preserved ')
        );
      const unsupportedSourceFiles = allFiles.filter((file) =>
        /\.(?:rs|go|java|kt|rb|php|cs|swift)$/.test(file)
      ).length;
      const files = allFiles.filter((file) => LANGUAGES[path.extname(file)]);
      const coverage: RepositoryMap['coverage'] = {
        filesParsed: 0,
        sourceFiles: files.length,
        unsupportedSourceFiles,
        scanComplete: !listingTruncated,
        parseErrorCount: 0,
        truncatedFileCount: 0,
        skippedCount: 0,
        parseErrors: [],
        truncatedFiles: [],
        skipped: [],
        cacheHits: 0
      };
      const indexed: Indexed[] = [];
      let bytes = 0,
        metadataBytes = 0;
      for (const file of files.slice(0, MAX_SCAN_FILES)) {
        signal?.throwIfAborted();
        if (this.#closed) throw new Error('Repository analysis is closed');
        if (bytes >= MAX_SCAN_BYTES || Date.now() - started > 20_000) {
          coverage.scanComplete = false;
          break;
        }
        const local = resolveInside(project, file),
          display = path.relative(project, local);
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW);
          await assertOpenedInPlace(root, local, handle);
          const before = await handle.stat();
          if (!before.isFile() || before.size > MAX_FILE_BYTES)
            throw new Error('File exceeds the structural preview budget');
          const data = Buffer.alloc(before.size + 1);
          let bytesRead = 0;
          while (bytesRead < data.length) {
            const read = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
            if (!read.bytesRead) break;
            bytesRead += read.bytesRead;
          }
          const after = await handle.stat();
          if (
            bytesRead !== before.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new Error('File changed while reading');
          const content = data.subarray(0, bytesRead);
          bytes += content.length;
          if (content.includes(0)) throw new Error('Binary content');
          const hash = createHash('sha256').update(content).digest('hex'),
            language = LANGUAGES[path.extname(file)]!;
          const cacheKey = `${language}:${hash}`;
          let parsed = this.#cache.get(cacheKey)?.value;
          if (parsed) {
            coverage.cacheHits++;
            const held = this.#cache.get(cacheKey)!;
            this.#cache.delete(cacheKey);
            this.#cache.set(cacheKey, held);
          } else {
            parsed = await worker.parse(
              language,
              new TextDecoder('utf-8', { fatal: true }).decode(content)
            );
            const size = Buffer.byteLength(JSON.stringify(parsed));
            while (this.#cache.size && this.#cacheBytes + size > MAX_CACHE_BYTES) {
              const first = this.#cache.keys().next().value!;
              this.#cacheBytes -= this.#cache.get(first)!.bytes;
              this.#cache.delete(first);
            }
            this.#cache.set(cacheKey, { value: parsed, bytes: size });
            this.#cacheBytes += size;
          }
          metadataBytes += this.#cache.get(cacheKey)!.bytes;
          if (metadataBytes > MAX_CACHE_BYTES) {
            coverage.scanComplete = false;
            break;
          }
          if (parsed.errors) {
            coverage.parseErrorCount++;
            if (coverage.parseErrors.length < 20) coverage.parseErrors.push(display);
          }
          if (parsed.truncated) {
            coverage.truncatedFileCount++;
            if (coverage.truncatedFiles.length < 20) coverage.truncatedFiles.push(display);
          }
          coverage.filesParsed++;
          indexed.push({ path: display, hash, parsed });
        } catch (cause) {
          signal?.throwIfAborted();
          coverage.skippedCount++;
          coverage.scanComplete = false;
          if (coverage.skipped.length < 30)
            coverage.skipped.push({
              path: display,
              reason: cause instanceof Error ? cause.message : 'File unavailable'
            });
        } finally {
          await handle?.close();
        }
      }
      if (coverage.filesParsed < files.length) coverage.scanComplete = false;
      return rankRepository(indexed, request.query, request.maxSymbols, coverage);
    } finally {
      signal?.removeEventListener('abort', abort);
      worker.close();
      this.#active.delete(worker);
    }
  }
}

function rankRepository(
  files: Indexed[],
  query: string,
  limit: number,
  coverage: RepositoryMap['coverage']
): RepositoryMap {
  const definitions: Definition[] = files.flatMap((file) =>
    file.parsed.definitions.map((definition) => ({
      ...definition,
      path: file.path,
      hash: file.hash
    }))
  );
  const calls = new Map<
    string,
    Array<{ path: string; line: number; caller?: string; module?: string; qualifier?: string }>
  >();
  for (const file of files)
    for (const call of file.parsed.calls) {
      const imported = !call.qualifier
        ? file.parsed.imports.find((entry) => entry.alias === call.name)
        : undefined;
      const name = imported?.name ?? call.name;
      const entries = calls.get(name) ?? [];
      entries.push({
        path: file.path,
        line: call.line,
        ...(call.caller ? { caller: call.caller } : {}),
        ...(call.qualifier ? { qualifier: call.qualifier } : {}),
        ...(imported ? { module: imported.from } : {})
      });
      calls.set(name, entries);
    }
  const terms =
    query
      .toLowerCase()
      .match(/[\p{L}\p{N}_$]+/gu)
      ?.filter((term) => term.length > 2)
      .slice(0, 30) ?? [];
  const family = (file: string) => {
    const language = LANGUAGES[path.extname(file)];
    return ['javascript', 'typescript', 'tsx'].includes(language ?? '') ? 'typescript' : language;
  };
  const names = new Map<string, number>();
  for (const definition of definitions) {
    const key = `${family(definition.path)}:${definition.name}`;
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  const ranked = definitions
    .map((definition) => {
      const callers = (calls.get(definition.name) ?? []).filter((call) => {
        if (family(call.path) !== family(definition.path)) return false;
        if (call.qualifier) {
          if (!definition.container) return false;
          const scope = definition.container.split('.').at(-1);
          if (
            call.qualifier !== scope &&
            !(
              ['this', 'self', 'cls'].includes(call.qualifier) &&
              call.path === definition.path &&
              call.caller?.startsWith(`${definition.container}.`)
            )
          )
            return false;
        }
        if (!call.module)
          return (
            call.path === definition.path ||
            (names.get(`${family(definition.path)}:${definition.name}`) ?? 0) === 1
          );
        let imported: string;
        if (family(call.path) === 'python') {
          const relative = call.module.match(/^\.+/)?.[0].length ?? 0;
          imported = path.normalize(
            path.join(
              relative ? path.dirname(call.path) : '',
              '../'.repeat(Math.max(0, relative - 1)),
              call.module.slice(relative).replaceAll('.', '/')
            )
          );
        } else {
          if (!call.module.startsWith('.')) return false;
          imported = path
            .normalize(path.join(path.dirname(call.path), call.module))
            .replace(/\.(?:[cm]?[jt]sx?|py)$/, '');
        }
        const declared = definition.path.replace(/\.(?:[cm]?[jt]sx?|py)$/, '');
        return (
          imported === declared ||
          `${imported}/${family(call.path) === 'python' ? '__init__' : 'index'}` === declared
        );
      });
      const words =
        `${definition.name} ${definition.container ?? ''} ${definition.path}`.toLowerCase();
      const relevance = terms.reduce(
        (sum, term) =>
          sum + (definition.name.toLowerCase() === term ? 40 : words.includes(term) ? 8 : 0),
        0
      );
      return {
        definition,
        callers,
        score:
          relevance +
          Math.min(20, new Set(callers.map((call) => call.path)).size) +
          (definition.container ? 0 : 1) -
          (/\.(?:test|spec)\.|(?:^|\/)tests?\//.test(definition.path) ? 5 : 0)
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.definition.path.localeCompare(b.definition.path) ||
        a.definition.line - b.definition.line
    );
  const importantSymbols: RepositoryMap['importantSymbols'] = [];
  const perFile = new Map<string, number>();
  let length = 0;
  for (const entry of ranked) {
    if (importantSymbols.length >= limit) break;
    if ((perFile.get(entry.definition.path) ?? 0) >= 12) continue;
    const item = {
      ...entry.definition,
      candidateCallers: entry.callers
        .slice(0, 3)
        .map(({ module: _module, qualifier: _qualifier, ...caller }) => caller)
    };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (length + size > 24_000) break;
    importantSymbols.push(item);
    length += size;
    perFile.set(item.path, (perFile.get(item.path) ?? 0) + 1);
  }
  return {
    engine: 'tree-sitter',
    parsedPaths: files
      .filter((file) => !file.parsed.errors && !file.parsed.truncated)
      .map((file) => file.path),
    importantSymbols,
    symbolCount: definitions.length,
    symbolsTruncated: importantSymbols.length < definitions.length,
    filesRepresented: perFile.size,
    coverage
  };
}

export function registerRepositoryMapRoute(
  app: FastifyInstance,
  workspaceRoot: string,
  mapper: RepositoryMapper,
  options: ExecutionOptions
): void {
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/repository-map',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const controller = new AbortController();
      const closed = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', closed);
      try {
        return await mapper.map(
          workspacePath(workspaceRoot, request.params.workspaceId),
          request.body,
          options,
          controller.signal
        );
      } finally {
        reply.raw.removeListener('close', closed);
      }
    }
  );
}
