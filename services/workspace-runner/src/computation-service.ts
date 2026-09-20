import { z } from 'zod';
import { ComputationRequest, ProcessHistoryQuery } from '@athanor/contracts';
import type { ComputationManager } from './computation.js';
import { supervisorRequest } from './supervisor-rpc.js';

const Workspace = z.uuid();
const Owner = z.string().min(1).max(256);
const argumentsByMethod = {
  act: z.tuple([Workspace, Owner.nullable(), ComputationRequest]),
  list: z.tuple([Workspace, Owner.nullable()]),
  history: z.tuple([
    Workspace,
    z.array(Owner).max(512).nullable(),
    ProcessHistoryQuery.nullish().transform((value) => value ?? {})
  ]),
  backgroundWork: z.tuple([]),
  refreshResources: z.tuple([]),
  isWorkspaceBusy: z.tuple([Workspace]),
  quiesceWorkspace: z.tuple([Workspace]),
  stopWorkspace: z.tuple([Workspace]),
  stopOwner: z.tuple([Workspace, Owner])
};
type Method = keyof typeof argumentsByMethod;
const Request = z
  .object({
    version: z.literal(1),
    method: z.enum(Object.keys(argumentsByMethod) as [Method, ...Method[]]),
    args: z.array(z.unknown()).max(3)
  })
  .strict();

type ServiceMethod<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R | Promise<Awaited<R>>
  : never;
export type ComputationService = {
  [K in Method | 'close']: ServiceMethod<ComputationManager[K]>;
};

/** Runtime ownership stays at the controller; the public runner supplies authenticated scope. */
export function connectComputationSupervisor(socket: string, secret: string): ComputationService {
  return new Proxy({} as ComputationService, {
    get: (_target, method: string) => {
      if (method === 'close') return async () => undefined;
      if (!Object.hasOwn(argumentsByMethod, method))
        throw new Error('Unknown computation supervisor method');
      return (...args: unknown[]) =>
        supervisorRequest(socket, secret, '/computation', { version: 1, method, args });
    }
  });
}

export async function dispatchComputation(manager: ComputationManager, input: unknown) {
  const request = Request.parse(input);
  const args = argumentsByMethod[request.method].parse(request.args);
  return { result: (await Reflect.apply(manager[request.method], manager, args)) as unknown };
}
