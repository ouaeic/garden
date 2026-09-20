import { readTablePage } from './table-preview.js';
import { openDownloadFile } from './open-download-file.js';
export { openDownloadFile } from './open-download-file.js';
import { constants, type ReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import { requireScope } from './auth.js';
import type { RunnerConfig } from './config.js';
import { assertOpenedInPlace, assertUserDataPath, resolveInside, workspacePath } from './files.js';
import { listDirectory } from './directories.js';
import { directoryArchive } from './directory-archive.js';

export const BUNDLE_FILE_LIMIT = 1_000;
const BundleRequest = z.object({
  paths: z.array(z.string().min(1).max(1_024)).max(BUNDLE_FILE_LIMIT).default([]),
  directories: z.array(z.string().min(1).max(1_024)).max(4).default([]),
  instructions: z.string().max(20_000).optional()
});
const SOURCE_ENVIRONMENTS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const verifiedDownloads = new Map<string, string>();

export const sourceManifest = async (root: string, paths: string[], directories: string[] = []) => {
  const requested = BundleRequest.parse({ paths, directories });
  const files = new Set(requested.paths.map((p) => assertUserDataPath(root, p)));
  const visited = new Set<string>();
  const excluded: string[] = [];
  let entries = 0;
  const visit = async (relative: string, depth = 0): Promise<void> => {
    if (depth >= 64 || relative.length > 1_024)
      throw new Error('Source bundle directory depth limit exceeded');
    if (visited.has(relative)) return;
    visited.add(relative);
    const target = resolveInside(root, relative);
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      await assertOpenedInPlace(root, target, handle);
      if (!(await handle.stat()).isDirectory())
        throw new Error('A declared output directory is not a directory');
      for await (const entry of await opendir(target, { bufferSize: 32 })) {
        if (++entries > BUNDLE_FILE_LIMIT * 4)
          throw new Error('Source bundle directory traversal limit exceeded');
        const nested = path.join(relative, entry.name);
        if (entry.name === '.git' || (entry.isDirectory() && SOURCE_ENVIRONMENTS.has(entry.name))) {
          excluded.push(nested);
          continue;
        }
        if (entry.isSymbolicLink()) throw new Error('Source bundles cannot include symbolic links');
        if (entry.isDirectory()) await visit(nested, depth + 1);
        else if (entry.isFile()) files.add(nested);
        else throw new Error('Source bundles contain only regular files');
        if (files.size > BUNDLE_FILE_LIMIT)
          throw new Error('Source bundle file count limit exceeded');
      }
      await assertOpenedInPlace(root, target, handle);
    } finally {
      await handle.close();
    }
  };
  for (const asked of requested.directories) {
    const relative = assertUserDataPath(root, asked);
    if (!relative.startsWith(`workspace${path.sep}`))
      throw new Error('Declare a project directory inside workspace');
    await visit(relative);
  }
  if (!files.size) throw new Error('No source files exist at the declared output paths');
  if ([...files].some((p) => !p.startsWith(`workspace${path.sep}`)))
    throw new Error('Source bundles contain only workspace files');
  return { paths: [...files].sort(), excluded };
};

export const byteRange = (
  value: string | undefined,
  size: number
): { start: number; end: number } | null => {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new Error('Invalid byte range');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  )
    throw new Error('Invalid byte range');
  return { start, end };
};

const attachment = (filename: string): string =>
  `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

export const sourceBundle = async (
  root: string,
  requested: string[],
  directories: string[] = [],
  instructions?: string
) => {
  const { paths: files, excluded } = await sourceManifest(root, requested, directories);
  // Validate every member before sending headers; open again safely when its bytes are needed.
  const members = [];
  for (const relative of files) {
    const opened = await openDownloadFile(root, relative);
    await opened.handle.close();
    members.push({
      relative,
      size: opened.stat.size,
      mtime: opened.stat.mtime,
      mtimeMs: opened.stat.mtimeMs,
      ctimeMs: opened.stat.ctimeMs,
      ino: opened.stat.ino,
      dev: opened.stat.dev,
      mode: opened.stat.mode
    });
  }
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  let active: ReadStream | undefined;
  let closed = false;
  zip.on('error', (error: Error) => output.destroy(error));
  output.once('close', () => {
    closed = true;
    active?.destroy();
  });
  if (instructions || excluded.length) {
    let name = 'garden-download.txt';
    while (files.includes(`workspace/${name}`)) name = `_${name}`;
    zip.addBuffer(
      Buffer.from(
        [
          instructions,
          excluded.length
            ? `Environment directories omitted; recreate these using the project's dependency instructions:\n${excluded.join('\n')}`
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      ),
      name
    );
  }
  for (const member of members) {
    zip.addReadStreamLazy(
      member.relative.slice('workspace/'.length).split(path.sep).join('/'),
      {
        size: member.size,
        mtime: member.mtime,
        mode: member.mode,
        compressionLevel: 1
      },
      (callback) => {
        void openDownloadFile(root, member.relative)
          .then(async (opened) => {
            if (closed) {
              await opened.handle.close();
              callback(new Error('Download was closed'), Readable.from([]));
              return;
            }
            if (
              opened.stat.size !== member.size ||
              opened.stat.mtimeMs !== member.mtimeMs ||
              opened.stat.ctimeMs !== member.ctimeMs ||
              opened.stat.ino !== member.ino ||
              opened.stat.dev !== member.dev
            ) {
              await opened.handle.close();
              callback(
                new Error('A source file changed while the bundle was being prepared'),
                Readable.from([])
              );
              return;
            }
            active = opened.handle.createReadStream({ autoClose: true });
            active.on('error', (error) => output.destroy(error));
            callback(null, active);
          })
          .catch((error: Error) => callback(error, Readable.from([])));
      }
    );
  }
  zip.end();
  return output;
};

export const registerFileDownloadRoutes = (
  app: FastifyInstance,
  config: Pick<RunnerConfig, 'WORKSPACE_ROOT'>
): void => {
  registerFileReadRoutes(app, '/v1/workspaces/:workspaceId', async (request) =>
    workspacePath(config.WORKSPACE_ROOT, (request.params as { workspaceId: string }).workspaceId)
  );
  app.post<{ Params: { workspaceId: string }; Body: z.input<typeof BundleRequest> }>(
    '/v1/workspaces/:workspaceId/bundle',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      const { paths, directories, instructions } = BundleRequest.parse(request.body);
      const stream = await sourceBundle(root, paths, directories, instructions);
      return reply
        .type('application/zip')
        .header('content-disposition', attachment('garden-source.zip'))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(stream);
    }
  );
  app.post<{ Params: { workspaceId: string }; Body: z.input<typeof BundleRequest> }>(
    '/v1/workspaces/:workspaceId/bundle-manifest',
    async (request) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      const { paths, directories } = BundleRequest.parse(request.body);
      const manifest = await sourceManifest(root, paths, directories);
      for (const file of manifest.paths) {
        const opened = await openDownloadFile(root, file);
        await opened.handle.close();
      }
      return { fileCount: manifest.paths.length, excluded: manifest.excluded };
    }
  );
};

/** The same streaming and range contracts apply to working files and immutable versions. */
export function registerFileReadRoutes(
  app: FastifyInstance,
  prefix: string,
  rootFor: (request: FastifyRequest) => Promise<string | { root: string; release(): Promise<void> }>
): void {
  const resolveRoot = async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const opened = await rootFor(request);
    if (typeof opened === 'string') return opened;
    if (reply.raw.destroyed) {
      await opened.release();
      throw new Error('File request was closed');
    }
    const release = () => {
      reply.raw.off('finish', release);
      reply.raw.off('close', release);
      void opened
        .release()
        .catch((err: unknown) => request.log.error({ err }, 'File reference release failed'));
    };
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
    return opened.root;
  };
  app.get<{ Querystring: { path?: string; cursor?: string } }>(
    `${prefix}/table`,
    async (request, reply) => {
      requireScope(request, 'files.read');
      reply.header('cache-control', 'private, no-store');
      const query = z
        .object({ path: z.string().min(1).max(4096), cursor: z.string().max(2048).optional() })
        .parse(request.query);
      const controller = new AbortController();
      const close = () => controller.abort();
      reply.raw.once('close', close);
      try {
        return await readTablePage(
          await resolveRoot(request, reply),
          query.path,
          query.cursor,
          100,
          controller.signal
        );
      } finally {
        reply.raw.off('close', close);
      }
    }
  );
  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string; cursor?: string } }>(
    `${prefix}/directory`,
    async (request, reply) => {
      requireScope(request, 'files.read');
      const query = z
        .object({
          path: z.string().min(1).max(4096).default('workspace'),
          cursor: z.string().max(8192).optional()
        })
        .parse(request.query);
      return listDirectory(await resolveRoot(request, reply), query.path, query.cursor);
    }
  );
  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    `${prefix}/directory.zip`,
    async (request, reply) => {
      requireScope(request, 'files.read');
      const requested = z.string().min(1).max(4096).default('workspace').parse(request.query.path);
      const stream = await directoryArchive(await resolveRoot(request, reply), requested);
      reply.raw.once('close', () => stream.destroy());
      return reply
        .type('application/zip')
        .header('content-disposition', attachment(`${path.basename(requested)}.zip`))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(stream);
    }
  );
  app.get<{ Params: { workspaceId: string }; Querystring: { path: string; sha256?: string } }>(
    `${prefix}/download`,
    async (request, reply) => {
      requireScope(request, 'files.read');
      const root = await resolveRoot(request, reply);
      const opened = await openDownloadFile(
        root,
        z.string().min(1).max(4096).parse(request.query.path)
      );
      const { stat, handle } = opened;
      const etag = `"${stat.dev.toString(16)}-${stat.ino.toString(16)}-${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-${stat.ctimeMs.toString(16)}"`;
      if (request.query.sha256 !== undefined) {
        try {
          const expected = z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(request.query.sha256);
          const identity = `${root}:${opened.relative}:${etag}`;
          if (verifiedDownloads.get(identity) !== expected) {
            const hash = createHash('sha256');
            const bytes: AsyncIterable<unknown> = handle.createReadStream({
              autoClose: false,
              start: 0
            });
            for await (const chunk of bytes) {
              if (!Buffer.isBuffer(chunk))
                throw new TypeError('A file download must contain binary bytes');
              hash.update(chunk);
            }
            const after = await handle.stat();
            if (
              hash.digest('hex') !== expected ||
              stat.size !== after.size ||
              stat.mtimeMs !== after.mtimeMs ||
              stat.ctimeMs !== after.ctimeMs
            ) {
              await handle.close();
              return reply.code(409).send({
                error: {
                  code: 'artifact_integrity_failed',
                  message: 'Artifact integrity check failed'
                }
              });
            }
            verifiedDownloads.set(identity, expected);
            while (verifiedDownloads.size > 128)
              verifiedDownloads.delete(verifiedDownloads.keys().next().value!);
          }
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      let range;
      try {
        range = byteRange(
          request.headers['if-range'] && request.headers['if-range'] !== etag
            ? undefined
            : request.headers.range,
          stat.size
        );
      } catch {
        await handle.close();
        return reply.code(416).header('content-range', `bytes */${stat.size}`).send();
      }
      reply
        .header('accept-ranges', 'bytes')
        .header('etag', etag)
        .header('last-modified', stat.mtime.toUTCString())
        .header('content-disposition', attachment(path.basename(opened.relative)))
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-length', range ? range.end - range.start + 1 : stat.size)
        .type('application/octet-stream');
      if (range)
        reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${stat.size}`);
      if (request.method === 'HEAD' || stat.size === 0) {
        await handle.close();
        return reply.send(Readable.from([]));
      }
      return reply.send(handle.createReadStream({ autoClose: true, start: 0, ...(range ?? {}) }));
    }
  );
}
