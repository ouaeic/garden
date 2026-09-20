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
      if (
        [
          'function_definition',
          'variable_assignment',
          'unset_command',
          'declaration_command'
        ].includes(node.type)
      )
        return false;
      if (node.type === 'command') {
        commands++;
        const name = node.childForFieldName('name')?.text;
        if (!name || !DATA_COMMANDS.has(name)) return false;
        // printf -v writes shell variables that could change subsequent command resolution.
        if (
          name === 'printf' &&
          node.children.some((child) => child?.text.replace(/^["']|["']$/g, '') === '-v')
        )
          return false;
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
