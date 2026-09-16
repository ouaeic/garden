import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type * as TreeSitter from '@vscode/tree-sitter-wasm';
import type { Node, Language } from '@vscode/tree-sitter-wasm';

export interface SourceDefinition {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  container?: string;
  signature: string;
}
export interface SourceCall {
  name: string;
  line: number;
  caller?: string;
  qualifier?: string;
}
export interface SourceImport {
  name: string;
  alias: string;
  from: string;
}
export interface ParsedSource {
  definitions: SourceDefinition[];
  calls: SourceCall[];
  imports: SourceImport[];
  errors: boolean;
  truncated: boolean;
}

const require = createRequire(import.meta.url);
const { Parser, Language: Grammar } = require('@vscode/tree-sitter-wasm') as typeof TreeSitter;
const ready = Parser.init();
const languages = new Map<string, Language>();
const DEFINITIONS = new Set([
  'function_declaration',
  'function_definition',
  'class_declaration',
  'class_definition',
  'class_specifier',
  'struct_specifier',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'method_definition',
  'method_declaration'
]);
const FUNCTIONS = new Set([
  'function_expression',
  'arrow_function',
  'function_definition',
  'lambda'
]);
const CALLS = new Set(['call_expression', 'call']);
const clean = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 180);
const field = (node: Node, name: string) => node.childForFieldName(name);
const terminalName = (node: Node | null): string => {
  if (!node) return '';
  const child =
    field(node, 'name') ??
    field(node, 'field') ??
    field(node, 'property') ??
    field(node, 'attribute') ??
    field(node, 'declarator');
  return child && child.id !== node.id ? terminalName(child) : clean(node.text);
};

/** A shipped grammar parses text only. No project configuration or source code is executed. */
export async function parseRepositorySource(
  language: string,
  source: string
): Promise<ParsedSource> {
  if (Buffer.byteLength(source) > 512 * 1024)
    throw new Error('Source exceeds the per-file parse budget');
  await ready;
  let grammar = languages.get(language);
  if (!grammar) {
    const name =
      language === 'r'
        ? '@davisvaughan/tree-sitter-r/tree-sitter-r.wasm'
        : `@vscode/tree-sitter-wasm/wasm/tree-sitter-${language}.wasm`;
    grammar = await Grammar.load(require.resolve(name));
    languages.set(language, grammar);
  }
  const parser = new Parser();
  parser.setLanguage(grammar);
  parser.setTimeoutMicros(100_000);
  let tree;
  try {
    tree = parser.parse(source);
  } catch (error) {
    parser.delete();
    throw error;
  }
  if (!tree) {
    parser.delete();
    throw new Error('Source parsing exceeded its time budget');
  }
  const result: ParsedSource = {
    definitions: [],
    calls: [],
    imports: [],
    errors: tree.rootNode.hasError,
    truncated: false
  };
  const stack: Array<{ node: Node; container?: string }> = [{ node: tree.rootNode }];
  const named = new Set<number>();
  let visited = 0;
  try {
    while (stack.length) {
      if (++visited > 50_000) {
        result.truncated = true;
        break;
      }
      const { node, container } = stack.pop()!;
      let definition: Node | null = DEFINITIONS.has(node.type) ? node : null;
      let nameNode = definition ? (field(node, 'name') ?? field(node, 'declarator')) : null;
      const value = field(node, 'value') ?? field(node, 'rhs') ?? field(node, 'right');
      const left = field(node, 'name') ?? field(node, 'lhs') ?? field(node, 'left');
      let valueDefinition = false;
      if (
        ['variable_declarator', 'assignment', 'binary_operator', 'assignment_expression'].includes(
          node.type
        ) &&
        value &&
        left &&
        (!container || FUNCTIONS.has(value.type)) &&
        (language !== 'r' ||
          ['<-', '<<-', '='].includes(source.slice(left.endIndex, value.startIndex).trim()))
      ) {
        definition = value;
        nameNode = left;
        valueDefinition = !FUNCTIONS.has(value.type);
        named.add(value.id);
      }
      let nextContainer = container;
      if (definition && nameNode && !named.has(node.id)) {
        const name = terminalName(nameNode);
        if (name && name.length <= 180) {
          if (result.definitions.length < 500) {
            const parameters =
              field(definition, 'parameters') ??
              field(field(definition, 'declarator') ?? definition, 'parameters');
            const kind = valueDefinition
              ? 'value'
              : /class|struct|interface|enum/.test(node.type)
                ? 'type'
                : /type_alias/.test(node.type)
                  ? 'alias'
                  : 'function';
            result.definitions.push({
              name,
              kind,
              line: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              ...(container ? { container } : {}),
              signature: clean(name + (parameters?.text ?? ''))
            });
          } else result.truncated = true;
          if (!valueDefinition) nextContainer = container ? `${container}.${name}` : name;
        }
      }
      if (FUNCTIONS.has(node.type) && !named.has(node.id) && !nameNode)
        nextContainer = `${container ?? '<module>'}.<anonymous@${node.startPosition.row + 1}>`;
      if (CALLS.has(node.type)) {
        const target = field(node, 'function');
        const name = terminalName(target);
        const qualifier =
          target &&
          (field(target, 'object') ?? field(target, 'scope') ?? field(target, 'namespace'));
        if (name && name.length <= 180) {
          if (result.calls.length < 2_000)
            result.calls.push({
              name,
              line: node.startPosition.row + 1,
              ...(container ? { caller: container } : {}),
              ...(qualifier ? { qualifier: clean(qualifier.text) } : {})
            });
          else result.truncated = true;
        }
      }
      if (node.type === 'import_statement' || node.type === 'import_from_statement') {
        const from = field(node, 'source') ?? field(node, 'module_name');
        if (from) {
          const module = from.text.replace(/^['"]|['"]$/g, '');
          const entries = node
            .descendantsOfType(['import_specifier', 'aliased_import'])
            .filter((entry): entry is Node => entry !== null);
          for (const entry of entries.slice(0, 100)) {
            const name = terminalName(field(entry, 'name'));
            if (name)
              result.imports.push({
                name,
                alias: terminalName(field(entry, 'alias')) || name,
                from: module
              });
          }
          if (node.type === 'import_from_statement') {
            for (const entry of node.namedChildren.filter(
              (child): child is Node =>
                child !== null && child.type === 'dotted_name' && child.id !== from.id
            ))
              result.imports.push({ name: entry.text, alias: entry.text, from: module });
          }
        }
      }
      const children = node.namedChildren;
      for (let index = children.length - 1; index >= 0; index--)
        stack.push({
          node: children[index]!,
          ...(nextContainer ? { container: nextContainer } : {})
        });
    }
    return result;
  } finally {
    tree.delete();
    parser.delete();
  }
}

if (parentPort)
  parentPort.on('message', async (message: { language: string; source: string }) => {
    try {
      parentPort!.postMessage({
        value: await parseRepositorySource(message.language, message.source)
      });
    } catch (error) {
      parentPort!.postMessage({
        error: error instanceof Error ? error.message : 'Source parsing failed'
      });
    }
  });
