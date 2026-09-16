/** Deterministic lexical fallback for unsupported languages and parser failures. */
export const OVERVIEW_SYMBOL_BUDGET = 300;
export const SETTLED_ORDER = ['--sort', 'path'];
export const SOURCE_GLOBS = [
  '--glob',
  '!node_modules/**',
  '--glob',
  '!dist/**',
  '--glob',
  '!build/**',
  '--glob',
  '*.{ts,tsx,js,jsx,py,rs,go,java,kt,rb,php,cs,cpp,c,h,hpp,swift}'
];
const DECLARATION_MODIFIER =
  'export|default|declare|public|private|protected|internal|open|abstract|final|sealed|static|partial|async|suspend|override|inline|unsafe|extern|data|value|pub(?:\\([^)]*\\))?';
const DECLARATION_KEYWORD =
  'class|interface|typealias|typedef|type|function|func|fun|def|fn|const|let|var|val|struct|enum|union|trait|protocol|extension|impl|module|mod|namespace|record|object|actor';
export const SYMBOL_SWEEP_PATTERN = `^(?:(?:${DECLARATION_MODIFIER})\\s+){0,3}(?:${DECLARATION_KEYWORD})[\\s<]`;
const SYMBOL_LINE_PREFIX = /^(.*?):\d+:/;
const SYMBOL_HEAD = new RegExp(SYMBOL_SWEEP_PATTERN);
const NAME_AFTER_KEYWORD =
  /^\s*(?:<[^>\n]*>\s*)?(?:\([^)\n]*\)\s*)?(?:(?:class|struct|enum|union)\s+)?(?:self\.)?([A-Za-z_$][A-Za-z0-9_$]*)/;
export const declaredSymbol = (
  line: string
):
  | {
      file: string;
      name: string;
    }
  | undefined => {
  const prefix = SYMBOL_LINE_PREFIX.exec(line);
  if (prefix === null) return undefined;
  const source = line.slice(prefix[0].length);
  const head = SYMBOL_HEAD.exec(source);
  if (head === null) return undefined;
  const name = NAME_AFTER_KEYWORD.exec(source.slice(head[0].length - 1))?.[1];
  return name === undefined ? undefined : { file: prefix[1] as string, name };
};
const publiclyDeclared = (line: string): boolean => /:\d+:(?:export|pub|public)\s/.test(line);
export const strideAcross = <T>(items: readonly T[], budget: number): T[] => {
  if (items.length <= budget) return [...items];
  const stride = items.length / budget;
  return Array.from({ length: budget }, (_, index) => items[Math.floor(index * stride)] as T);
};
export const spreadAcrossFiles = (lines: readonly string[], budget: number): string[] => {
  const byFile = new Map<string, string[]>();
  for (const line of lines) {
    const file = /^(.*?):\d+:/.exec(line)?.[1] ?? line;
    const held = byFile.get(file);
    if (held) held.push(line);
    else byFile.set(file, [line]);
  }
  const unexported = (line: string): number => (publiclyDeclared(line) ? 0 : 1);
  for (const held of byFile.values()) held.sort((a, b) => unexported(a) - unexported(b));
  const files = [...byFile.values()];
  if (files.length > budget) return strideAcross(files, budget).map((held) => held[0] as string);
  const spread: string[] = [];
  for (let round = 0; spread.length < budget; round += 1) {
    let placed = false;
    for (const held of files) {
      const line = held[round];
      if (line === undefined) continue;
      spread.push(line);
      placed = true;
      if (spread.length === budget) return spread;
    }
    if (!placed) break;
  }
  return spread;
};
export const IMPORT_SWEEP_PATTERN =
  '(?m)^[ \\t]*(?:import|export)[ \\t]+(?:[^\\n\'"]*?|[^\\n\'"{]*\\{[A-Za-z0-9_$,\\s]*?\\}[ \\t]*)\\bfrom[ \\t]*[\'"][^\'"\\n]+[\'"]';
const IMPORT_GRAMMAR = new Set(['import', 'export', 'from', 'type', 'as', 'default']);
export const OVERVIEW_RANKED_SHARE = 2;
export const OVERVIEW_RANKED_PER_FILE = 8;
export const rankByReference = (
  symbolLines: readonly string[],
  importSweep: string,
  budget: number
): string[] => {
  const filesDeclaring = new Map<string, Set<string>>();
  const declaredAt = new Map<string, string>();
  for (const line of symbolLines) {
    const found = declaredSymbol(line);
    if (found === undefined) continue;
    const { file, name } = found;
    const seen = filesDeclaring.get(name);
    if (seen) seen.add(file);
    else filesDeclaring.set(name, new Set([file]));
    const held = declaredAt.get(name);
    if (held === undefined || (!publiclyDeclared(held) && publiclyDeclared(line)))
      declaredAt.set(name, line);
  }
  const imported = new Map<string, number>();
  const named = importSweep.replace(/'[^'\n]*'|"[^"\n]*"/g, ' ');
  for (const word of named.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const name = word[0];
    if (IMPORT_GRAMMAR.has(name) || filesDeclaring.get(name)?.size !== 1) continue;
    imported.set(name, (imported.get(name) ?? 0) + 1);
  }
  const ordered = [...imported]
    .map(([name, count]) => [declaredAt.get(name) as string, count] as const)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  const perFile = new Map<string, number>();
  const ranked: string[] = [];
  for (const [line] of ordered) {
    if (ranked.length >= Math.floor(budget / OVERVIEW_RANKED_SHARE)) break;
    const file = /^(.*?):\d+:/.exec(line)?.[1] ?? line;
    const taken = perFile.get(file) ?? 0;
    if (taken >= OVERVIEW_RANKED_PER_FILE) continue;
    perFile.set(file, taken + 1);
    ranked.push(line);
  }
  const shown = new Set(ranked.map((line) => /^(.*?):\d+:/.exec(line)?.[1] ?? line));
  const rest = symbolLines.filter((line) => !shown.has(/^(.*?):\d+:/.exec(line)?.[1] ?? line));
  return [...ranked, ...spreadAcrossFiles(rest, budget - ranked.length)];
};
