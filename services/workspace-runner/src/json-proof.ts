import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { JsonProofRequest, type JsonProof, type JsonProofResult } from '@garden/contracts';
import { requireScope } from './auth.js';
import { assertUserDataPath, readWorkspaceFile, workspacePath } from './files.js';

// This bounds an in-memory proof, not a dataset or an analysis process.
export const JSON_PROOF_MAX_BYTES = 8 * 1024 * 1024;
const missing = Symbol('missing');

function atPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key) ||
      (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key))
    )
      return missing;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function compareJson(
  value: unknown,
  proof: JsonProof
): Pick<JsonProofResult, 'assertions' | 'failures'> {
  const failures: string[] = [];
  let assertions = 0;
  for (const [pointer, expected] of Object.entries(proof.equals ?? {})) {
    assertions++;
    if (!isDeepStrictEqual(atPointer(value, pointer), expected))
      failures.push(`${JSON.stringify(pointer)} does not equal the declared value`);
  }
  for (const [pointer, expected] of Object.entries(proof.lengths ?? {})) {
    assertions++;
    const actual = atPointer(value, pointer);
    if (!Array.isArray(actual) || actual.length !== expected)
      failures.push(`${JSON.stringify(pointer)} is not an array of length ${expected}`);
  }
  for (const [pointer, key] of Object.entries(proof.uniqueBy ?? {})) {
    assertions++;
    const actual = atPointer(value, pointer);
    const ids = new Set<string | number>();
    const valid =
      Array.isArray(actual) &&
      actual.length > 0 &&
      actual.every((row: unknown) => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, key))
          return false;
        const id: unknown = (row as Record<string, unknown>)[key];
        if ((typeof id !== 'string' && typeof id !== 'number') || ids.has(id)) return false;
        ids.add(id);
        return true;
      });
    if (!valid)
      failures.push(
        `${JSON.stringify(pointer)} needs nonempty records with distinct string or number ${JSON.stringify(key)} values`
      );
  }
  return { assertions, failures };
}

export async function proveJson(root: string, input: unknown): Promise<JsonProofResult> {
  const request = JsonProofRequest.parse(input);
  const { content, sha256 } = await readWorkspaceFile(
    root,
    assertUserDataPath(root, request.path),
    JSON_PROOF_MAX_BYTES
  );
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  const result = compareJson(value, request.json);
  return {
    ...result,
    sha256,
    passed: result.failures.length === 0,
    detail:
      `${result.assertions - result.failures.length}/${result.assertions} JSON assertions passed; sha256 ${sha256}` +
      (result.failures.length ? `; ${result.failures.slice(0, 8).join('; ')}` : '')
  };
}

export function registerJsonProofRoute(app: FastifyInstance, workspaceRoot: string): void {
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/json-proof',
    async (request) => {
      requireScope(request, 'files.read');
      return proveJson(workspacePath(workspaceRoot, request.params.workspaceId), request.body);
    }
  );
}
