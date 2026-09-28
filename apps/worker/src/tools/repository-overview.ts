import type { ToolContext } from '../tool-dispatch.js';
import type { ExecObservation } from '../agent-state.js';
import { asRecord, textValue } from '../values.js';
import { clampNumber } from './numbers.js';
import {
  IMPORT_SWEEP_PATTERN,
  OVERVIEW_SYMBOL_BUDGET,
  rankByReference,
  SETTLED_ORDER,
  SOURCE_GLOBS,
  strideAcross,
  SYMBOL_SWEEP_PATTERN
} from './repository-symbols.js';

/** Preserve source links and explicit coverage within one model-visible output budget. */
export function boundRepositoryOverview(result: Record<string, unknown>): Record<string, unknown> {
  const mapping = asRecord(result.mapping),
    coverage = asRecord(mapping?.coverage);
  if (coverage) {
    let detailBytes = 0;
    for (const key of ['parseErrors', 'truncatedFiles', 'skipped']) {
      if (!Array.isArray(coverage[key])) continue;
      const entries: unknown[] = [];
      for (const entry of coverage[key] as unknown[]) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (detailBytes + size > 4_000) {
          coverage.detailsTruncated = true;
          break;
        }
        entries.push(entry);
        detailBytes += size;
      }
      coverage[key] = entries;
    }
  }
  if (
    typeof result.versionControl === 'string' &&
    Buffer.byteLength(result.versionControl) > 4_000
  ) {
    while (Buffer.byteLength(result.versionControl as string) > 4_000)
      result.versionControl = (result.versionControl as string).slice(
        0,
        Math.floor((result.versionControl as string).length * 0.8)
      );
    result.versionControlTruncated = true;
  }
  const rows = ['files', 'importantSymbols', 'additionalSymbols', 'instructionFiles'];
  while (Buffer.byteLength(JSON.stringify(result)) > 24_000) {
    const key = rows
      .filter((name) => Array.isArray(result[name]) && (result[name] as unknown[]).length)
      .sort((a, b) => JSON.stringify(result[b]).length - JSON.stringify(result[a]).length)[0];
    if (!key) break;
    const values = result[key] as unknown[];
    result[key] = values.slice(0, Math.floor(values.length * 0.8));
    if (key === 'files') result.filesTruncated = true;
    else result.symbolsTruncated = true;
    result.outputTruncated = true;
  }
  result.filesRepresented = new Set(
    (result.importantSymbols as unknown[]).map((item) =>
      typeof item === 'string' ? /^(.*?):\d+:/.exec(item)?.[1] : asRecord(item)?.path
    )
  ).size;
  return result;
}

export async function repositoryOverview(
  context: ToolContext,
  args: Record<string, unknown>
): Promise<unknown> {
  const { task } = context;
  const root = `/v1/workspaces/${task.workspaceId}`;
  const path = textValue(args.path, 'workspace'),
    maxFiles = clampNumber(args.maxFiles, { min: 20, max: 1_000, fallback: 400 });
  const run = (executable: string, argv: string[]) =>
    context.runner.call<ExecObservation>(task.workspaceId, task.id, 'exec', `${root}/exec`, {
      executable,
      args: argv,
      cwd: path,
      timeoutSeconds: 90
    });
  const [git, structure, instructions] = await Promise.all([
    context.runner
      .call<{ status: string; files: string; limited: boolean; reason?: string }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/repository-git`,
        { path }
      )
      .then((value) => {
        if (
          !value ||
          typeof value.status !== 'string' ||
          typeof value.files !== 'string' ||
          typeof value.limited !== 'boolean'
        )
          throw new Error('Invalid repository metadata');
        return value;
      })
      .catch(() => ({
        status: '',
        files: '',
        limited: true,
        reason: 'Read-only Git metadata is unavailable.'
      })),
    context.runner
      .call<unknown>(task.workspaceId, task.id, 'files.read', `${root}/repository-map`, {
        path,
        query: textValue(args.query).slice(0, 2_000),
        maxSymbols: 120
      })
      .then(asRecord)
      .catch(() => null),
    run('/usr/bin/rg', [
      '--files',
      ...SETTLED_ORDER,
      '--glob',
      'GARDEN.md',
      '--glob',
      'GARDEN.md',
      '--glob',
      'OPEN_CLOUD.md',
      '--glob',
      'AGENTS.md',
      '--glob',
      'CONTRIBUTING.md',
      '--glob',
      'README*'
    ])
  ]);
  const paths = (value: string) => value.split(value.includes('\0') ? '\0' : '\n').filter(Boolean);
  let files = paths(git.files);
  if (!files.length)
    files = paths((await run('/usr/bin/rg', ['--files', '--null', ...SETTLED_ORDER])).stdout);
  const structural =
    structure?.engine === 'tree-sitter' &&
    Array.isArray(structure.importantSymbols) &&
    Array.isArray(structure.parsedPaths)
      ? structure
      : null;
  const coverage = asRecord(structural?.coverage);
  let lexical: string[] = [],
    lexicalCount = 0;
  if (
    !structural ||
    coverage?.scanComplete !== true ||
    Number(coverage?.unsupportedSourceFiles) > 0 ||
    Number(coverage?.parseErrorCount) > 0 ||
    Number(coverage?.truncatedFileCount) > 0
  ) {
    const [symbols, imports] = await Promise.all([
      run('/usr/bin/rg', [
        '--line-number',
        '--no-heading',
        ...SETTLED_ORDER,
        '--color',
        'never',
        ...SOURCE_GLOBS,
        SYMBOL_SWEEP_PATTERN,
        '.'
      ]),
      run('/usr/bin/rg', [
        '--multiline',
        '--no-filename',
        '--no-line-number',
        '--no-heading',
        ...SETTLED_ORDER,
        '--color',
        'never',
        ...SOURCE_GLOBS,
        IMPORT_SWEEP_PATTERN,
        '.'
      ])
    ]);
    const parsed = new Set((structural?.parsedPaths as string[] | undefined) ?? []);
    const lines = symbols.stdout
      .split('\n')
      .filter(Boolean)
      .filter((line) => !parsed.has((/^(.*?):\d+:/.exec(line)?.[1] ?? '').replace(/^\.\//, '')));
    lexicalCount = lines.length;
    lexical = rankByReference(lines, imports.stdout, structural ? 80 : OVERVIEW_SYMBOL_BUDGET);
  }
  return boundRepositoryOverview({
    path,
    versionControl: git.status.trim() || git.reason || 'No Git working tree detected',
    ...(git.limited ? { versionControlLimited: true, versionControlLimitation: git.reason } : {}),
    files: strideAcross(files, maxFiles),
    fileCount: files.length,
    filesTruncated: files.length > maxFiles,
    importantSymbols: structural?.importantSymbols ?? lexical,
    ...(structural && lexical.length ? { additionalSymbols: lexical } : {}),
    symbolsTruncated: Boolean(structural?.symbolsTruncated) || lexicalCount > lexical.length,
    symbolCount: Number(structural?.symbolCount ?? 0) + lexicalCount,
    mapping: structural
      ? {
          engine: 'tree-sitter',
          callLinks:
            'Syntax candidates; dynamic dispatch and overload targets require language-server confirmation.',
          coverage
        }
      : {
          engine: 'lexical',
          limitation:
            'Structural parsing is unavailable; declarations and import counts are a lexical approximation.'
        },
    instructionFiles: paths(instructions.stdout)
  });
}
