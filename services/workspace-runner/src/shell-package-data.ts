import { createRequire } from 'node:module';
import type * as TreeSitter from '@vscode/tree-sitter-wasm';
import type { Language, Node } from '@vscode/tree-sitter-wasm';

const require = createRequire(import.meta.url);
let grammar: Promise<Language> | undefined;
const DATA_COMMANDS = new Set([
  'echo',
  'printf',
  'cat',
  'ls',
  'stat',
  'df',
  'du',
  'wc',
  'head',
  'tail',
  'pwd',
  'sha256sum',
  'sha512sum',
  'shasum',
  'md5sum',
  'cksum',
  'uname',
  'true',
  'false',
  'test',
  '[',
  'mkdir',
  'basename',
  'dirname',
  'readlink',
  'realpath'
]);
const DATA_SYNTAX = new Set([
  'program',
  'command',
  'command_name',
  'word',
  'raw_string',
  'string',
  'string_content',
  'concatenation',
  'list',
  'pipeline',
  'redirected_statement',
  'file_redirect',
  'file_descriptor',
  'number',
  'heredoc_redirect',
  'heredoc_start',
  'heredoc_body',
  'heredoc_content',
  'heredoc_end',
  'comment'
]);

const literalArgument = (node: Node | null | undefined): string | null => {
  if (!node) return null;
  if (node.type === 'raw_string') return node.text.slice(1, -1);
  if (node.type === 'word' && !/[\\$*?[{~]/.test(node.text)) return node.text;
  if (
    node.type === 'string' &&
    !node.text.includes('\\') &&
    node.namedChildren.every((child) => child?.type === 'string_content')
  )
    return node.text.slice(1, -1);
  return null;
};

const printfIsData = (node: Node): boolean => {
  const args = node.childrenForFieldName('argument');
  const first = literalArgument(args[0]);
  const format = first === '--' ? literalArgument(args[1]) : first;
  // Options, expansions and %n can assign shell variables and change later command resolution.
  if (format === null || (first !== '--' && format.startsWith('-'))) return false;
  for (let index = format.indexOf('%'); index >= 0; index = format.indexOf('%', index)) {
    const conversion = /^%(?:%|[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[aAbBcdeEfFgGiosuxXqQ])/.exec(
      format.slice(index)
    );
    if (!conversion) return false;
    index += conversion[0].length;
  }
  return true;
};

/** Only a complete, bounded parse of known data commands can remove a package-name false positive. */
export async function packageNamesAreData(source: string): Promise<boolean> {
  if (Buffer.byteLength(source) > 128 * 1024) return false;
  let parser: TreeSitter.Parser | undefined;
  let tree: TreeSitter.Tree | null | undefined;
  try {
    const { Parser, Language: Grammar } = require('@vscode/tree-sitter-wasm') as typeof TreeSitter;
    grammar ??= Parser.init().then(() =>
      Grammar.load(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm'))
    );
    const loaded = await grammar;
    parser = new Parser();
    parser.setLanguage(loaded);
    parser.setTimeoutMicros(50_000);
    tree = parser.parse(source);
    if (!tree || tree.rootNode.hasError) return false;
    const stack: Node[] = [tree.rootNode];
    let visited = 0,
      commands = 0;
    while (stack.length) {
      if (++visited > 20_000) return false;
      const node = stack.pop()!;
      // Unknown syntax, including expansion and loop assignments, keeps conservative classification.
      if (!DATA_SYNTAX.has(node.type)) return false;
      if (node.type === 'command') {
        commands++;
        const name = node.childForFieldName('name')?.text;
        if (!name || !DATA_COMMANDS.has(name)) return false;
        if (name === 'printf' && !printfIsData(node)) return false;
      }
      for (const child of node.namedChildren) if (child) stack.push(child);
    }
    return commands > 0;
  } catch {
    return false;
  } finally {
    tree?.delete();
    parser?.delete();
  }
}
