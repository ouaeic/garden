import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import { PassThrough, type Readable } from 'node:stream';
import pty, { type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import type { ProcessHandle } from './subprocess.js';

export interface ManagedProcess extends ProcessHandle {
  stdin: { readonly writable: boolean; write(data: string): unknown; end(): unknown };
  stdout: Readable;
  stderr: Readable;
  terminal?: { columns: number; rows: number; streams: 'combined' };
  resize?: (columns: number, rows: number) => void;
}

/** The prepared sandbox command is identical for pipes and terminals. */
export function spawnManagedProcess(
  invocation: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv },
  terminal = false
): ManagedProcess {
  if (!terminal) {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false
    });
    // A child may close stdin while its output and work continue.
    child.stdin.on('error', () => child.emit('inputError'));
    return child;
  }
  const child = pty.spawn(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    env: Object.fromEntries(
      Object.entries(invocation.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    ),
    name: 'xterm-256color',
    cols: 120,
    rows: 36
  });
  return new TerminalProcess(child);
}

class TerminalProcess extends EventEmitter implements ManagedProcess {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly terminal = { columns: 120, rows: 36, streams: 'combined' as const };
  readonly stdin;
  #ended = false;

  constructor(private readonly pty: IPty) {
    super();
    this.pid = pty.pid;
    const running = () => !this.#ended;
    this.stdin = {
      get writable() {
        return running();
      },
      write: (data: string) => {
        if (this.#ended) throw new Error('The terminal has exited');
        pty.write(data);
      },
      end: () => {
        if (!this.#ended) pty.write('\x04');
      }
    };
    pty.onData((data) => {
      if (!this.stdout.write(data)) pty.pause();
    });
    this.stdout.on('drain', () => {
      if (!this.#ended) pty.resume();
    });
    pty.onExit(({ exitCode, signal }) => {
      this.#ended = true;
      this.signalCode = signal
        ? ((Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] as
            | NodeJS.Signals
            | undefined) ?? null)
        : null;
      this.exitCode = this.signalCode ? null : exitCode;
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', this.exitCode, this.signalCode);
      queueMicrotask(() => this.emit('close', this.exitCode, this.signalCode));
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.#ended) return false;
    try {
      process.kill(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  resize(columns: number, rows: number): void {
    if (this.#ended) throw new Error('The terminal has exited');
    this.pty.resize(columns, rows);
    this.terminal.columns = columns;
    this.terminal.rows = rows;
  }
}
