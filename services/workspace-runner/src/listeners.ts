/**
 * What a running service is actually listening on, read off the kernel rather than off the command
 * that started it.
 *
 * `statedBindReach` (apps/worker/src/command-classification.ts) answers the same question from the
 * invocation, before the process exists, and that is the half that can be put on an approval card.
 * It cannot answer the commonest spelling of the case: `python3 -m http.server 8099` states no
 * address at all and binds every interface, and so do a good many dev servers whose default came
 * from a container image. A parser cannot know that without a table of every server's defaults,
 * which would be wrong the week after it was written.
 *
 * So the other half is measured. `/proc/net/tcp` and `/proc/net/tcp6` say which sockets are in
 * LISTEN and which inode each belongs to; `/proc/<pid>/fd` says which process holds that inode.
 * Nothing here guesses.
 *
 * NOT AVAILABLE EVERYWHERE, and that is a normal answer rather than an error. macOS has no `/proc`,
 * so every read below fails ENOENT and the result is an empty list - which callers must read as
 * "not observed", never as "nothing is listening". The parsers are separated from the reads for
 * exactly this reason: they are the part that can be held to fixtures on a developer's laptop.
 */
import { readFile, readdir, readlink } from 'node:fs/promises';

/** The `st` column of /proc/net/tcp for a socket in LISTEN. */
const LISTEN = '0A';

export interface ListeningSocket {
  address: string;
  port: number;
  inode: string;
  /** The account that opened it. The only attribution available where `/proc/<pid>` is hidden. */
  uid: number;
}

/**
 * One 32-bit word of a /proc address, which is written in the host's byte order.
 *
 * Both files spell an address as 8 hex characters per word with the bytes reversed, so `0100007F`
 * is 127.0.0.1 and not 1.0.0.127. Getting this backwards is silent and total: every loopback bind
 * reads as a public address and every public one reads as reserved.
 */
const reversedBytes = (word: string): number[] => {
  const bytes: number[] = [];
  for (let at = word.length - 2; at >= 0; at -= 2)
    bytes.push(Number.parseInt(word.slice(at, at + 2), 16));
  return bytes;
};

/** `0100007F` -> `127.0.0.1`; the 32-character form -> a compressible IPv6 literal. */
export const procHexAddress = (hex: string): string | null => {
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length === 8) {
    const bytes = reversedBytes(hex);
    return bytes.length === 4 ? bytes.join('.') : null;
  }
  if (hex.length !== 32) return null;
  const bytes: number[] = [];
  for (let word = 0; word < 4; word += 1)
    bytes.push(...reversedBytes(hex.slice(word * 8, word * 8 + 8)));
  const groups: string[] = [];
  for (let at = 0; at < 16; at += 2)
    groups.push((((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)).toString(16));
  return compressIpv6(groups);
};

/**
 * The `::` run, because an address printed in full is one nobody recognises: `0:0:0:0:0:0:0:0` is
 * the unspecified address that this whole file exists to notice, and it has to arrive at
 * `reachOfBindAddress` in a spelling that reader knows.
 */
const compressIpv6 = (groups: readonly string[]): string => {
  let bestAt = -1;
  let bestRun = 0;
  let at = 0;
  while (at < groups.length) {
    if (groups[at] !== '0') {
      at += 1;
      continue;
    }
    let end = at;
    while (end < groups.length && groups[end] === '0') end += 1;
    if (end - at > bestRun) {
      bestRun = end - at;
      bestAt = at;
    }
    at = end;
  }
  if (bestRun < 2) return groups.join(':');
  const head = groups.slice(0, bestAt).join(':');
  const tail = groups.slice(bestAt + bestRun).join(':');
  return `${head}::${tail}`;
};

/**
 * The LISTEN rows of one /proc/net/tcp file, by socket inode.
 *
 * Only LISTEN: an established connection to a loopback port is not an exposure, and counting one
 * would report every request the preview proxy makes as a new opening.
 */
export const parseListeningSockets = (text: string): ListeningSocket[] => {
  const found: ListeningSocket[] = [];
  for (const line of text.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) continue;
    const [addressHex, portHex] = (columns[1] ?? '').split(':');
    if (columns[3] !== LISTEN || !addressHex || !portHex) continue;
    const address = procHexAddress(addressHex);
    const port = Number.parseInt(portHex, 16);
    const uid = Number.parseInt(columns[7] ?? '', 10);
    const inode = columns[9];
    if (address === null || !Number.isInteger(port) || !Number.isInteger(uid) || !inode) continue;
    found.push({ address, port, inode, uid });
  }
  return found;
};

/** The `socket:[12345]` form a listening file descriptor points at. */
export const socketInode = (link: string): string | null =>
  link.match(/^socket:\[(\d+)\]$/)?.[1] ?? null;

/** Field 5 of /proc/<pid>/stat is the process group, and the command in field 2 may contain spaces. */
export const processGroupOf = (stat: string): number | null => {
  const after = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const pgrp = Number.parseInt(after[2] ?? '', 10);
  return Number.isInteger(pgrp) ? pgrp : null;
};

const unreadable = async <T>(work: Promise<T>, fallback: T): Promise<T> =>
  work.catch(() => fallback);

/**
 * Every socket in LISTEN held by any process in `pgid`'s group.
 *
 * The process group rather than the pid, because a service is started detached as its own group
 * leader and the thing that actually binds is frequently a child: `npm start` execs a shell which
 * execs node, and the pid on the record is the shell.
 *
 * Every read is allowed to fail. A pid that exits mid-walk, a `/proc` that is not there, an fd
 * directory this process may not open - none of them is an error worth failing a listing over, and
 * the caller is told "not observed" by the empty list rather than by an exception.
 */
export const listeningSocketsOfGroup = async (
  pgid: number,
  procRoot = '/proc'
): Promise<{ address: string; port: number }[]> => {
  const [tcp, tcp6, entries] = await Promise.all([
    unreadable(readFile(`${procRoot}/net/tcp`, 'utf8'), ''),
    unreadable(readFile(`${procRoot}/net/tcp6`, 'utf8'), ''),
    unreadable(readdir(procRoot), [] as string[])
  ]);
  const sockets = [...parseListeningSockets(tcp), ...parseListeningSockets(tcp6)];
  if (sockets.length === 0) return [];
  const byInode = new Map(sockets.map((socket) => [socket.inode, socket]));

  const pids = (
    await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          const stat = await unreadable(readFile(`${procRoot}/${entry}/stat`, 'utf8'), '');
          return stat && processGroupOf(stat) === pgid ? entry : null;
        })
    )
  ).filter((entry): entry is string => entry !== null);

  const held = new Map<string, { address: string; port: number }>();
  await Promise.all(
    pids.map(async (pid) => {
      const fds = await unreadable(readdir(`${procRoot}/${pid}/fd`), [] as string[]);
      await Promise.all(
        fds.map(async (fd) => {
          const link = await unreadable(readlink(`${procRoot}/${pid}/fd/${fd}`), '');
          const inode = link ? socketInode(link) : null;
          const socket = inode ? byInode.get(inode) : undefined;
          if (socket)
            held.set(`${socket.address}:${socket.port}`, {
              address: socket.address,
              port: socket.port
            });
        })
      );
    })
  );
  return [...held.values()].sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
};

/**
 * The account agent commands run as, or this process's own where there is no second account.
 *
 * The name is fixed rather than configured, for the same reason `scripts/garden-sandbox` fixes it:
 * the helper's whole property is that a caller gains nothing by lying to it, so neither end reads
 * the account it drops to out of anything a caller can influence. A developer's laptop has no such
 * account and runs agent commands as the runner itself, which is exactly what the fallback says.
 */
export const agentAccountUid = async (
  account = 'garden-agent',
  passwdPath = '/etc/passwd'
): Promise<number> => {
  const own = process.getuid?.() ?? 0;
  const passwd = await unreadable(readFile(passwdPath, 'utf8'), '');
  for (const line of passwd.split('\n')) {
    const fields = line.split(':');
    if (fields[0] !== account) continue;
    const uid = Number.parseInt(fields[2] ?? '', 10);
    return Number.isInteger(uid) ? uid : own;
  }
  return own;
};

/**
 * Every port an agent-owned process has open on this computer.
 *
 * NOT the process-group walk above, because that walk cannot run where garden ships.
 * `infra/native/garden-runner.service` sets `ProtectProc=invisible`, and agent commands run as a
 * different account than the runner - measured on a live box: `/proc/<pid>` for the service and for
 * its root `sudo` wrapper were both hidden from the runner's namespace, and `/proc/<pid>/fd` was
 * denied, while `/proc/net/tcp` stayed readable. Attribution by file descriptor is therefore
 * unavailable to the runner by design, and weakening `ProtectProc` to buy it back would be trading
 * isolation for observability, which is the wrong direction.
 *
 * The uid column is what remains, and it is enough for the question that matters. It cannot say
 * WHICH service opened a port when several are up; it can say that a process running as the agent
 * account has one open, and on what address - which is the fact the owner was never told.
 */
export const agentListeningSockets = async (
  agentUid: number,
  procRoot = '/proc'
): Promise<{ address: string; port: number }[]> => {
  const [tcp, tcp6] = await Promise.all([
    unreadable(readFile(`${procRoot}/net/tcp`, 'utf8'), ''),
    unreadable(readFile(`${procRoot}/net/tcp6`, 'utf8'), '')
  ]);
  const held = new Map<string, { address: string; port: number }>();
  for (const socket of [...parseListeningSockets(tcp), ...parseListeningSockets(tcp6)])
    if (socket.uid === agentUid)
      held.set(`${socket.address}:${socket.port}`, { address: socket.address, port: socket.port });
  return [...held.values()].sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
};
