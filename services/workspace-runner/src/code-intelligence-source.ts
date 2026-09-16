import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assertUserDataPath, readWorkspaceFile, resolveInside } from './files.js';

export const CODE_SOURCE_BYTES = 1024 * 1024;
export const CodePosition = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative()
});
export const CodeRange = z.object({ start: CodePosition, end: CodePosition });
export const CodeEdit = z.object({ range: CodeRange, newText: z.string().max(CODE_SOURCE_BYTES) });
export type CodeRange = z.infer<typeof CodeRange>;
export type Source = { path: string; absolute: string; uri: string; text: string; sha256: string };

export async function codeSource(
  root: string,
  project: string,
  requested: string
): Promise<Source> {
  const relative = assertUserDataPath(root, requested);
  const absolute = resolveInside(root, relative);
  resolveInside(project, absolute);
  const { content, sha256 } = await readWorkspaceFile(root, relative, CODE_SOURCE_BYTES);
  if (content.includes(0)) throw new Error('Code intelligence requires a UTF-8 text source file');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  return { path: relative, absolute, uri: pathToFileURL(absolute).href, text, sha256 };
}

export function codeUriPath(root: string, project: string, uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost'))
    throw new Error('Language server returned a non-local source');
  const absolute = fileURLToPath(url);
  resolveInside(project, absolute);
  return assertUserDataPath(root, path.relative(root, absolute));
}

export function codeOffset(text: string, position: z.infer<typeof CodePosition>): number {
  const lines = text.split('\n');
  const line = lines[position.line];
  if (line === undefined || position.character > line.replace(/\r$/, '').length)
    throw new Error('Language server source range is outside the file');
  if (
    position.character > 0 &&
    /[\uD800-\uDBFF]/.test(line[position.character - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(line[position.character] ?? '')
  )
    throw new Error('Language server source range splits a Unicode character');
  return (
    lines.slice(0, position.line).reduce((sum, entry) => sum + entry.length + 1, 0) +
    position.character
  );
}

export function sourceRange(text: string, range: CodeRange) {
  const start = codeOffset(text, range.start);
  const end = codeOffset(text, range.end);
  if (end < start) throw new Error('Language server returned a reversed source range');
  return { start, end };
}

export const displayRange = (range: CodeRange) => ({
  start: { line: range.start.line + 1, column: range.start.character + 1 },
  end: { line: range.end.line + 1, column: range.end.character + 1 }
});

export function workspaceEdits(value: unknown) {
  const parsed = z
    .object({
      changes: z.record(z.string(), z.array(CodeEdit)).optional(),
      documentChanges: z
        .array(
          z
            .object({
              textDocument: z.object({
                uri: z.string(),
                version: z.number().nullable().optional()
              }),
              edits: z.array(CodeEdit)
            })
            .strict()
        )
        .optional()
    })
    .strict()
    .parse(value);
  const edits = Object.assign(new Map<string, z.infer<typeof CodeEdit>[]>(), {
    versions: new Map<string, number | null | undefined>()
  });
  for (const [uri, changes] of Object.entries(parsed.changes ?? {})) edits.set(uri, changes);
  for (const document of parsed.documentChanges ?? []) {
    if (edits.has(document.textDocument.uri))
      throw new Error('Language server returned duplicate rename documents');
    edits.set(document.textDocument.uri, document.edits);
    edits.versions.set(document.textDocument.uri, document.textDocument.version);
  }
  if (edits.size > 32 || [...edits.values()].reduce((sum, rows) => sum + rows.length, 0) > 500)
    throw new Error('Rename exceeds the bounded preview; narrow the project root');
  return edits;
}
