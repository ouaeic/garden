/*
 * The parsers, held to real /proc text.
 *
 * These are separated from the reads precisely so they can be tested anywhere: the walk itself
 * needs a Linux `/proc` and is proved on the box, but a byte order read backwards is silent and
 * total - every loopback bind would report as a public address and every public one as reserved -
 * so it is the half that must be pinned down here.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reachOfBindAddress } from '@garden/core';
import {
  agentAccountUid,
  agentListeningSockets,
  listeningSocketsOfGroup,
  parseListeningSockets,
  procHexAddress,
  processGroupOf,
  socketInode
} from './listeners.js';

const TCP_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

describe('procHexAddress', () => {
  it('reads the word back to front, which is how /proc writes it', () => {
    expect(procHexAddress('0100007F')).toBe('127.0.0.1');
    expect(procHexAddress('00000000')).toBe('0.0.0.0');
    expect(procHexAddress('3500007F')).toBe('127.0.0.53');
    expect(procHexAddress('0101A8C0')).toBe('192.168.1.1');
  });

  it('reads the four words of an IPv6 address and compresses the zero run', () => {
    expect(procHexAddress('00000000000000000000000000000000')).toBe('::');
    expect(procHexAddress('00000000000000000000000001000000')).toBe('::1');
    expect(procHexAddress('0000000000000000FFFF00000100007F')).toBe('::ffff:7f00:1');
  });

  it('refuses anything that is not one of the two widths', () => {
    for (const hex of ['', 'zz', '0100', '0100007F00']) expect(procHexAddress(hex)).toBeNull();
  });

  /*
   * The point of the whole file, asserted end to end on the two addresses that decide it. A byte
   * order read backwards turns the first of these into a public address and the second into a
   * reserved one, and nothing downstream could tell.
   */
  it('hands the reach reader an address it places correctly', () => {
    expect(reachOfBindAddress(procHexAddress('00000000') ?? '')).toBe('internet');
    expect(reachOfBindAddress(procHexAddress('0100007F') ?? '')).toBe('self');
    expect(reachOfBindAddress(procHexAddress('00000000000000000000000000000000') ?? '')).toBe(
      'internet'
    );
    expect(reachOfBindAddress(procHexAddress('00000000000000000000000001000000') ?? '')).toBe(
      'self'
    );
  });
});

describe('parseListeningSockets', () => {
  const row = (index: number, local: string, state: string, inode: string, uid = 0) =>
    `   ${index}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

  it('takes the LISTEN rows and leaves the rest', () => {
    const text = [
      TCP_HEADER,
      row(0, '00000000:1FA3', '0A', '84021'),
      row(1, '0100007F:1FA1', '0A', '84022'),
      // ESTABLISHED. A connection to a loopback port is not an opening, and counting one would
      // report every request the preview proxy makes as a new exposure.
      row(2, '0100007F:1F90', '01', '84023')
    ].join('\n');
    expect(parseListeningSockets(text)).toEqual([
      { address: '0.0.0.0', port: 8099, inode: '84021', uid: 0 },
      { address: '127.0.0.1', port: 8097, inode: '84022', uid: 0 }
    ]);
  });

  it('survives a header-only file and a truncated row', () => {
    expect(parseListeningSockets(TCP_HEADER)).toEqual([]);
    expect(parseListeningSockets('')).toEqual([]);
    expect(parseListeningSockets([TCP_HEADER, '   0: 00000000:1FA3 0A'].join('\n'))).toEqual([]);
  });

  it('reads the IPv6 file with the same reader', () => {
    const text = [TCP_HEADER, row(0, '00000000000000000000000000000000:1F90', '0A', '9001')].join(
      '\n'
    );
    expect(parseListeningSockets(text)).toEqual([
      { address: '::', port: 8080, inode: '9001', uid: 0 }
    ]);
  });
});

describe('socketInode', () => {
  it('takes the inode out of a socket link and refuses every other kind of fd', () => {
    expect(socketInode('socket:[84021]')).toBe('84021');
    expect(socketInode('/home/garden/workspace/notes.md')).toBeNull();
    expect(socketInode('pipe:[84021]')).toBeNull();
    expect(socketInode('anon_inode:[eventpoll]')).toBeNull();
  });
});

describe('processGroupOf', () => {
  /*
   * Field 2 is the executable name IN PARENTHESES, and it may contain spaces and parentheses of
   * its own - a shell script called `my server (old)` is a legal name. Splitting the line on
   * whitespace from the left reads the wrong field for any of them, so the scan starts after the
   * LAST close parenthesis, which is what the kernel's own documentation tells readers to do.
   */
  it('reads the process group after the command, however the command is spelled', () => {
    expect(processGroupOf('4242 (node) S 1 4242 4242 0 -1 4194560 0 0')).toBe(4242);
    expect(processGroupOf('4243 (my server (old)) S 1 4242 4242 0 -1 4194560 0 0')).toBe(4242);
    expect(processGroupOf('4244 (sh) S 1 9999 4242 0 -1 4194560 0 0')).toBe(9999);
  });

  it('answers null for a stat line it cannot read', () => {
    expect(processGroupOf('')).toBeNull();
    expect(processGroupOf('4242 (node)')).toBeNull();
  });
});

/*
 * The walk, over a `/proc` this test builds.
 *
 * `listeningSocketsOfGroup` takes its root as a parameter precisely so this is possible off Linux:
 * the matching it does - a LISTEN row's inode against the file descriptors of every process in one
 * process group - is the part with somewhere to go wrong, and it is testable anywhere.
 */
describe('listeningSocketsOfGroup', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const HEADER =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const row = (local: string, state: string, inode: string) =>
    `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0 100 0 0 10 0`;

  const buildProc = async (
    processes: readonly { pid: number; pgrp: number; sockets: readonly string[] }[],
    tcp: readonly string[],
    tcp6: readonly string[] = []
  ): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-proc-'));
    roots.push(root);
    await mkdir(path.join(root, 'net'), { recursive: true });
    await writeFile(path.join(root, 'net', 'tcp'), [HEADER, ...tcp].join('\n'));
    await writeFile(path.join(root, 'net', 'tcp6'), [HEADER, ...tcp6].join('\n'));
    for (const entry of processes) {
      const dir = path.join(root, String(entry.pid));
      await mkdir(path.join(dir, 'fd'), { recursive: true });
      await writeFile(
        path.join(dir, 'stat'),
        `${entry.pid} (node) S 1 ${entry.pgrp} ${entry.pgrp} 0 -1 0 0 0`
      );
      let fd = 3;
      for (const socket of entry.sockets) {
        // A dangling symlink, which is exactly what /proc/<pid>/fd entries are.
        await symlink(socket, path.join(dir, 'fd', String(fd)));
        fd += 1;
      }
      await symlink('/dev/null', path.join(dir, 'fd', String(fd)));
    }
    return root;
  };

  it('attributes a listening socket to the process group that holds its inode', async () => {
    const root = await buildProc(
      [{ pid: 4242, pgrp: 4242, sockets: ['socket:[84021]'] }],
      [row('00000000:1FA3', '0A', '84021')]
    );
    expect(await listeningSocketsOfGroup(4242, root)).toEqual([{ address: '0.0.0.0', port: 8099 }]);
  });

  /*
   * The child, not the leader. `npm start` execs a shell which execs node, so the pid written on
   * the service record is routinely NOT the process that binds - which is why this walks the group
   * rather than the one pid.
   */
  it('finds the socket when a child of the group holds it and the leader does not', async () => {
    const root = await buildProc(
      [
        { pid: 4242, pgrp: 4242, sockets: [] },
        { pid: 4250, pgrp: 4242, sockets: ['socket:[84021]'] }
      ],
      [row('00000000:1FA3', '0A', '84021')]
    );
    expect(await listeningSocketsOfGroup(4242, root)).toEqual([{ address: '0.0.0.0', port: 8099 }]);
  });

  it("leaves another process group's socket alone", async () => {
    const root = await buildProc(
      [
        { pid: 4242, pgrp: 4242, sockets: [] },
        { pid: 5000, pgrp: 5000, sockets: ['socket:[84021]'] }
      ],
      [row('00000000:1FA3', '0A', '84021')]
    );
    expect(await listeningSocketsOfGroup(4242, root)).toEqual([]);
  });

  it('reports both families and sorts by port', async () => {
    const root = await buildProc(
      [{ pid: 4242, pgrp: 4242, sockets: ['socket:[84021]', 'socket:[9001]'] }],
      [row('0100007F:1FA1', '0A', '84021')],
      [row('00000000000000000000000000000000:1F90', '0A', '9001')]
    );
    expect(await listeningSocketsOfGroup(4242, root)).toEqual([
      { address: '::', port: 8080 },
      { address: '127.0.0.1', port: 8097 }
    ]);
  });

  /*
   * A host with no `/proc` answers the same as a service that binds nothing, which is why the
   * caller is required to treat an empty list as "not observed" and never as "reachable from
   * nowhere". This asserts the read fails quietly rather than throwing into a listing.
   */
  it('answers empty rather than throwing when there is no proc to read', async () => {
    expect(await listeningSocketsOfGroup(4242, path.join(tmpdir(), 'garden-no-proc-here'))).toEqual(
      []
    );
  });

  it('ignores a connection that is not in LISTEN', async () => {
    const root = await buildProc(
      [{ pid: 4242, pgrp: 4242, sockets: ['socket:[84021]'] }],
      [row('0100007F:1F90', '01', '84021')]
    );
    expect(await listeningSocketsOfGroup(4242, root)).toEqual([]);
  });
});

/*
 * The reader that ships, and the reason it is not the process-group walk above.
 *
 * Measured on a live box: `ProtectProc=invisible` on the runner unit, and agent commands running
 * as a different account, put `/proc/<pid>` and `/proc/<pid>/fd` out of the runner's reach - both
 * the service and its root `sudo` wrapper were hidden - while `/proc/net/tcp` stayed readable.
 * The uid column is the only attribution left, and it is the one that answers the question the
 * owner was never asked: is a port an agent opened reachable from off this computer.
 */
describe('agentListeningSockets', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const HEADER2 =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const line = (local: string, state: string, inode: string, uid: number) =>
    `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     ${uid}        0 ${inode} 1 0 100 0 0 10 0`;

  const buildNet = async (tcp: readonly string[], tcp6: readonly string[] = []) => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-net-'));
    roots.push(root);
    await mkdir(path.join(root, 'net'), { recursive: true });
    await writeFile(path.join(root, 'net', 'tcp'), [HEADER2, ...tcp].join('\n'));
    await writeFile(path.join(root, 'net', 'tcp6'), [HEADER2, ...tcp6].join('\n'));
    return root;
  };

  it("takes the agent account's listeners and leaves the rest of the box alone", async () => {
    const root = await buildNet([
      // sshd and nginx, owned by root. The owner's own infrastructure is not agent activity.
      line('00000000:0016', '0A', '12885', 0),
      line('00000000:01BB', '0A', '5019783', 0),
      // The agent's own, on every interface: the row this exists to find.
      line('00000000:1FA0', '0A', '5637252', 997),
      // The runner's own loopback port, owned by the runner rather than the agent.
      line('0100007F:1004', '0A', '5637000', 1001)
    ]);
    expect(await agentListeningSockets(997, root)).toEqual([{ address: '0.0.0.0', port: 8096 }]);
  });

  it('reads both families and de-duplicates a port seen twice', async () => {
    const root = await buildNet(
      [line('0100007F:1FA1', '0A', '1', 997)],
      [line('00000000000000000000000000000000:1F90', '0A', '2', 997)]
    );
    expect(await agentListeningSockets(997, root)).toEqual([
      { address: '::', port: 8080 },
      { address: '127.0.0.1', port: 8097 }
    ]);
  });

  it('answers empty rather than throwing where there is no proc', async () => {
    expect(await agentListeningSockets(997, path.join(tmpdir(), 'garden-absent'))).toEqual([]);
  });
});

describe('agentAccountUid', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const passwd = async (text: string) => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-passwd-'));
    roots.push(root);
    const file = path.join(root, 'passwd');
    await writeFile(file, text);
    return file;
  };

  it('resolves the fixed agent account', async () => {
    const file = await passwd(
      [
        'root:x:0:0:root:/root:/bin/bash',
        'garden-agent:x:997:986::/nonexistent:/usr/sbin/nologin',
        'garden:x:1001:1001::/home/garden:/bin/sh'
      ].join('\n')
    );
    expect(await agentAccountUid('garden-agent', file)).toBe(997);
  });

  /*
   * A laptop has no second account and runs agent commands as the runner itself, so the runner's
   * own uid IS the agent uid there. Falling back to it keeps one reader correct in both
   * deployments rather than reporting nothing on the machine a developer is looking at.
   */
  it('falls back to this process where there is no such account', async () => {
    const file = await passwd('root:x:0:0:root:/root:/bin/bash');
    expect(await agentAccountUid('garden-agent', file)).toBe(process.getuid?.() ?? 0);
    expect(await agentAccountUid('garden-agent', '/nonexistent/passwd')).toBe(
      process.getuid?.() ?? 0
    );
  });
});
