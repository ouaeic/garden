import { spawn, type SpawnOptions } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface GuiLease {
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  release(): Promise<void>;
}

export interface GuiNamespace {
  readonly environment: NodeJS.ProcessEnv;
  stop(): Promise<void>;
}

class GuiCleanupError extends Error {
  constructor(
    readonly namespace: GuiNamespace,
    cause: unknown
  ) {
    super('GUI startup cleanup failed', { cause });
  }
}

type Entry = { namespace: GuiNamespace; references: number; stopping?: boolean };

/** Leases share X11/IPC within a project, and retain failed teardown before any replacement. */
export class GuiNamespaceManager {
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<unknown>>();
  #closed = false;

  constructor(
    readonly executable: string,
    private readonly start: (root: string) => Promise<GuiNamespace> = (root) =>
      startGuiNamespace(root)
  ) {}

  #serial<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.#pending.get(root) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.#pending.set(root, pending);
    void pending
      .finally(() => {
        if (this.#pending.get(root) === pending) this.#pending.delete(root);
      })
      .catch(() => undefined);
    return pending;
  }

  acquire(root: string): Promise<GuiLease> {
    if (!path.isAbsolute(root) || path.resolve(root) !== root)
      return Promise.reject(new Error('GUI workspace root must be canonical'));
    return this.#serial(root, async () => {
      if (this.#closed) throw new Error('GUI namespace manager is closed');
      let entry = this.#entries.get(root);
      if (entry && (entry.references === 0 || entry.stopping)) {
        await entry.namespace.stop();
        this.#entries.delete(root);
        entry = undefined;
      }
      if (!entry) {
        try {
          entry = { namespace: await this.start(root), references: 0 };
        } catch (cause) {
          if (cause instanceof GuiCleanupError)
            this.#entries.set(root, { namespace: cause.namespace, references: 0 });
          throw cause;
        }
        this.#entries.set(root, entry);
      }
      entry.references += 1;
      const held = entry;
      let released = false;
      return {
        executable: this.executable,
        environment: { ...held.namespace.environment, GARDEN_GUI_HELPER: this.executable },
        release: () =>
          this.#serial(root, async () => {
            if (!released) {
              released = true;
              held.references -= 1;
            }
            if (held.references === 0 && this.#entries.get(root) === held) {
              await held.namespace.stop();
              this.#entries.delete(root);
            }
          })
      };
    });
  }

  async acquireTemporary(root: string): Promise<GuiLease> {
    if ((await realpath(root)) !== root) throw new Error('GUI workspace root must be canonical');
    const parent = await directory(root, '.garden/gui/research');
    const temporary = await mkdtemp(path.join(parent, 'session-'));
    try {
      const lease = await this.acquire(temporary);
      return {
        ...lease,
        release: async () => {
          await lease.release();
          await rm(temporary, { recursive: true, force: true });
        }
      };
    } catch (cause) {
      await this.closeRoot(temporary);
      await rm(temporary, { recursive: true, force: true });
      throw cause;
    }
  }

  async closeRoot(root: string): Promise<void> {
    const matching = [...new Set([...this.#entries.keys(), ...this.#pending.keys()])].filter(
      (key) => key === root || key.startsWith(`${root}${path.sep}`)
    );
    const results = await Promise.allSettled(
      matching.map((key) =>
        this.#serial(key, async () => {
          const entry = this.#entries.get(key);
          if (!entry) return;
          entry.stopping = true;
          await entry.namespace.stop();
          this.#entries.delete(key);
        })
      )
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result): unknown => result.reason),
        'GUI project cleanup failed'
      );
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#pending.values()]);
    const results = await Promise.allSettled(
      [...this.#entries].map(([root, entry]) =>
        this.#serial(root, async () => {
          await entry.namespace.stop();
          this.#entries.delete(root);
        })
      )
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result): unknown => result.reason),
        'GUI namespace cleanup failed'
      );
  }
}

/** Preserve Node's spawn overloads, including Chromium's extra transport descriptors. */
export const spawnGui: typeof spawn = ((
  executable: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  passedOptions?: SpawnOptions
) => {
  const args = Array.isArray(argsOrOptions) ? (argsOrOptions as string[]) : [];
  const options = Array.isArray(argsOrOptions)
    ? passedOptions
    : (argsOrOptions as SpawnOptions | undefined);
  const helper = options?.env?.GARDEN_GUI_HELPER;
  return helper
    ? spawn(helper, ['--run', executable, ...(args ?? [])], options)
    : spawn(executable, args ?? [], options ?? {});
}) as typeof spawn;

const directory = async (root: string, relative: string): Promise<string> => {
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('GUI state directory is unsafe');
  }
  return current;
};

const namespaceInfo = z.object({
  protocol: z.literal(1),
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^\d+$/),
  root: z.string()
});

const readReply = (socket: Socket): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let data = '';
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timeout);
      socket.off('data', receive);
      socket.off('error', fail);
      socket.off('end', ended);
      socket.off('close', ended);
      if (error) reject(error);
      else resolve(value);
    };
    const fail = () =>
      finish(new Error('Project GUI isolation could not start. Run garden doctor.'));
    const ended = () => fail();
    const receive = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 8192) return fail();
      if (!data.endsWith('\n')) return;
      try {
        finish(undefined, JSON.parse(data));
      } catch {
        fail();
      }
    };
    const timeout = setTimeout(fail, 15_000);
    socket.on('data', receive);
    socket.once('error', fail);
    socket.once('end', ended);
    socket.once('close', ended);
    if (socket.destroyed) fail();
  });

export const startGuiNamespace = async (
  root: string,
  socketPath = '/run/garden-gui/control.sock'
): Promise<GuiNamespace> => {
  const socket = createConnection(socketPath);
  // The connection can end between setup and release when the broker restarts.
  socket.on('error', () => undefined);
  const handles: FileHandle[] = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    if (!socket.destroyed) {
      const reply = readReply(socket);
      socket.write('stop\n');
      const result = await reply;
      if (!z.object({ stopped: z.literal(true) }).safeParse(result).success)
        throw new Error('Project GUI isolation could not stop');
    }
    socket.destroy();
    // A lost socket is not itself proof that the keeper has exited.
    const held = handles[0];
    if (held) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          const stat = await open(`/proc/self/fd/${held.fd}/stat`, constants.O_RDONLY);
          await stat.close();
        } catch (cause) {
          if (['ENOENT', 'ESRCH'].includes((cause as NodeJS.ErrnoException).code ?? '')) break;
          throw cause;
        }
        if (Date.now() >= deadline) throw new Error('GUI namespace did not exit');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await Promise.all(handles.map((handle) => handle.close()));
    stopped = true;
  };
  try {
    const reply = readReply(socket);
    socket.write(`${JSON.stringify({ root })}\n`);
    const info = namespaceInfo.parse(await reply);
    if (info.root !== root) throw new Error('GUI broker selected a different project');
    const heldProcess = await open(`/proc/${info.pid}`, constants.O_RDONLY | constants.O_DIRECTORY);
    handles.push(heldProcess);
    const identity = await open(`/proc/self/fd/${heldProcess.fd}/stat`, constants.O_RDONLY);
    try {
      const stat = await identity.readFile('utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== info.startTime)
        throw new Error('GUI namespace lifetime ended');
    } finally {
      await identity.close();
    }
    handles.push(
      await open(`/proc/self/fd/${heldProcess.fd}/root`, constants.O_RDONLY | constants.O_DIRECTORY)
    );
    if (socket.destroyed) throw new Error('GUI broker exited during startup');
    return {
      environment: {
        GARDEN_GUI_NAMESPACES: JSON.stringify({
          process: `/proc/${process.pid}/fd/${handles[0]?.fd}`,
          root: `/proc/${process.pid}/fd/${handles[1]?.fd}`,
          pid: info.pid,
          startTime: info.startTime
        }),
        GARDEN_GUI_ROOT: root,
        HOME: path.join(root, '.garden/gui/home'),
        XDG_RUNTIME_DIR: '/run'
      },
      stop
    };
  } catch (cause) {
    try {
      await stop();
    } catch {
      socket.destroy();
      // Keep held descriptors until a later release confirms that the broker lease has ended.
      throw new GuiCleanupError({ environment: {}, stop }, cause);
    }
    throw cause;
  }
};
