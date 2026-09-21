import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireScope } from './auth.js';
import { resolveExecutable } from './command-policy.js';
import { hostSearchPath } from './execution.js';

const Input = z
  .object({ executable: z.string().max(1024), args: z.array(z.string().max(65_536)).max(24) })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 131_072,
    'Inspection input is too large'
  );
const Result = z.object({
  inspected: z.number().int().nonnegative(),
  issues: z.array(z.string().max(400)).max(16)
});

// Only Python's parser sees the submitted program. No submitted node is evaluated or imported.
export const ASSERTION_INSPECTOR = String.raw`
import ast, json, os, re, shlex, sys

unknown = object()
def truth(node):
    if isinstance(node, ast.Constant):
        return bool(node.value)
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return bool(node.elts) if all(isinstance(x, ast.Constant) for x in node.elts) else unknown
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        value = truth(node.operand)
        return unknown if value is unknown else not value
    if isinstance(node, ast.BoolOp):
        values = [truth(x) for x in node.values]
        if isinstance(node.op, ast.Or):
            return True if True in values else (unknown if unknown in values else False)
        return False if False in values else (unknown if unknown in values else True)
    return unknown

def programs(executable, args, depth=0):
    if depth > 3:
        return
    name = os.path.basename(executable)
    if re.fullmatch(r'python(?:[23](?:\.[0-9]+)?)?', name):
        if '-c' in args and args.index('-c') + 1 < len(args):
            yield args[args.index('-c') + 1]
        return
    if name not in ('sh', 'bash', 'dash', 'zsh'):
        return
    for index, arg in enumerate(args[:-1]):
        if re.fullmatch(r'-[a-zA-Z]*c[a-zA-Z]*', arg):
            try:
                lexer = shlex.shlex(args[index + 1], posix=True, punctuation_chars=';&|()')
                lexer.whitespace_split = True
                command = []
                for token in list(lexer) + [';']:
                    if token and all(c in ';&|()' for c in token):
                        if command:
                            yield from programs(command[0], command[1:], depth + 1)
                        command = []
                    else:
                        command.append(token)
            except ValueError:
                pass
            return

request = json.load(sys.stdin)
issues, inspected = [], 0
for source in programs(request['executable'], request['args']):
    if len(source) > 65536 or inspected >= 16:
        break
    try:
        tree = ast.parse(source)
        nodes = list(ast.walk(tree))
        if len(nodes) > 20000:
            continue
        inspected += 1
        for node in nodes:
            if isinstance(node, ast.Assert) and truth(node.test) is True:
                issues.append('Python assertion on line %s always passes; remove the constant-success branch and test the actual result.' % node.lineno)
                if len(issues) >= 16:
                    break
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        continue
    if len(issues) >= 16:
        break
print(json.dumps({'inspected': inspected, 'issues': issues}))
`;

export async function inspectAcceptanceCommand(input: unknown): Promise<z.infer<typeof Result>> {
  const request = Input.parse(input);
  const python = await resolveExecutable('python3', hostSearchPath, '/');
  if (!python) return { inspected: 0, issues: [] };
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-S', '-c', ASSERTION_INSPECTOR], {
      cwd: '/',
      env: { PATH: hostSearchPath },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16_384) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes > 16_384)
        return reject(new Error('Assertion inspection could not complete'));
      try {
        resolve(Result.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch {
        reject(new Error('Assertion inspection returned an invalid result'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function registerAcceptanceInspection(app: FastifyInstance): void {
  app.post('/v1/workspaces/:workspaceId/acceptance/inspect', async (request) => {
    requireScope(request, 'files.read');
    return inspectAcceptanceCommand(request.body);
  });
}
