import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  packageManagerInvocation,
  privilegeEscalationBinary,
  privilegedHelperInvocation,
  resolveExecutable
} from './command-policy.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('privilege escalation detection', () => {
  it('catches escalation binaries whatever path they are spelled with', () => {
    expect(privilegeEscalationBinary({ executable: 'sudo', args: ['id'] })).toBe('sudo');
    expect(privilegeEscalationBinary({ executable: '/usr/bin/sudo', args: ['id'] })).toBe('sudo');
    expect(privilegeEscalationBinary({ executable: './sudo', args: [] })).toBe('sudo');
    expect(privilegeEscalationBinary({ executable: '  /usr/bin/su  ', args: [] })).toBe('su');
    expect(privilegeEscalationBinary({ executable: '/usr/bin/../bin/doas', args: [] })).toBe(
      'doas'
    );
    expect(privilegeEscalationBinary({ executable: 'pkexec', args: ['id'] })).toBe('pkexec');
    expect(privilegeEscalationBinary({ executable: 'runuser', args: ['-u', 'root'] })).toBe(
      'runuser'
    );
  });

  it('catches escalation smuggled through a wrapper', () => {
    const wrapped: Array<[string, string[]]> = [
      ['env', ['sudo', 'id']],
      ['/usr/bin/env', ['PATH=/usr/bin', 'sudo', 'id']],
      ['sh', ['-c', 'sudo id']],
      ['/bin/bash', ['-c', 'cd /tmp && sudo -n id']],
      ['sh', ['-c', 'echo $(sudo id)']],
      ['sh', ['-c', '/usr/bin/sudo id']],
      ['xargs', ['sudo', 'id']],
      ['nohup', ['sudo', 'id']],
      ['setsid', ['sudo', 'id']],
      ['nice', ['sudo', 'id']],
      ['timeout', ['5', 'sudo', 'id']],
      ['stdbuf', ['-o0', 'sudo', 'id']],
      ['env', ['sh', '-c', 'sudo id']]
    ];
    for (const [executable, args] of wrapped)
      expect([executable, privilegeEscalationBinary({ executable, args })]).toEqual([
        executable,
        'sudo'
      ]);
  });

  it('leaves ordinary commands alone', () => {
    expect(privilegeEscalationBinary({ executable: 'git', args: ['status'] })).toBeUndefined();
    expect(
      privilegeEscalationBinary({ executable: 'grep', args: ['sudo', '/etc/group'] })
    ).toBeUndefined();
    expect(
      privilegeEscalationBinary({ executable: 'node', args: ['-e', "console.log('sudo')"] })
    ).toBeUndefined();
    expect(privilegeEscalationBinary({ executable: 'pseudo-tty', args: [] })).toBeUndefined();
    expect(privilegeEscalationBinary({ executable: 'sh', args: ['-c', 'ls -la'] })).toBeUndefined();
  });
});

describe('package manager detection', () => {
  it('separates a direct apt run from a wrapped one', async () => {
    expect(await packageManagerInvocation({ executable: 'apt-get', args: ['install'] })).toBe(
      'direct'
    );
    expect(await packageManagerInvocation({ executable: '/usr/bin/apt', args: ['update'] })).toBe(
      'direct'
    );
    expect(
      await packageManagerInvocation({ executable: 'env', args: ['apt-get', 'install'] })
    ).toBe('wrapped');
    expect(
      await packageManagerInvocation({ executable: 'sh', args: ['-c', 'apt-get install vim'] })
    ).toBe('wrapped');
    expect(
      await packageManagerInvocation({ executable: 'ls', args: ['/etc/apt'] })
    ).toBeUndefined();
  });
});

describe('package names in shell data', () => {
  it.each([
    "echo '== apt r-base-dev =='",
    "printf '%s\\n' 'apt-get install example'; ls -l",
    "printf -- '%s %%n %04d\\n' apt 12",
    "cat <<'EOF'\napt update\nEOF",
    'mkdir -p output && echo apt && sha256sum output/file',
    'echo "apt" | wc -c'
  ])('accepts literal output: %s', async (source) => {
    expect(
      await packageManagerInvocation({ executable: 'bash', args: ['-lc', source] })
    ).toBeUndefined();
  });
  it.each([
    'echo apt; apt-get install example',
    'echo $(apt update)',
    'cat <<EOF\n$(apt update)\nEOF',
    'echo `apt update`',
    'echo apt | sh',
    "eval 'apt update'",
    "bash -c 'apt update'",
    'x=apt; $x install example',
    'find . -exec apt update \\;',
    'printf -v command apt; $command update',
    'printf -vPATH /tmp; cat apt',
    "printf -'v' PATH /tmp; cat apt",
    'printf "$option" PATH /tmp; cat apt',
    "printf '%n' PATH; cat apt",
    "printf '%010n' PATH; cat apt",
    "printf -- '%n' PATH; cat apt",
    "printf '%s%n' apt PATH; cat apt",
    'echo apt $((PATH=1))',
    'echo ${PATH:=/tmp} apt',
    'for PATH in /tmp; do cat apt; done',
    'echo "apt $status"',
    'f(){ apt update; }; f',
    "'apt' update",
    "echo 'apt",
    'echo apt; ' + ' '.repeat(128 * 1024)
  ])('retains the conservative rule for executable or unknown content: %s', async (source) => {
    expect(await packageManagerInvocation({ executable: 'sh', args: ['-c', source] })).toBe(
      'wrapped'
    );
  });
  it('does not apply a Bash parse to other shells or remove privilege checks', async () => {
    expect(await packageManagerInvocation({ executable: 'fish', args: ['-c', 'echo apt'] })).toBe(
      'wrapped'
    );
    expect(privilegeEscalationBinary({ executable: 'bash', args: ['-c', 'echo sudo apt'] })).toBe(
      'sudo'
    );
  });
});

describe('privileged helper detection', () => {
  it('refuses a command that names one of garden own root helpers', () => {
    const helpers = [
      '/usr/local/lib/garden/garden-package-helper',
      '/usr/local/lib/garden/garden-sandbox'
    ];
    expect(
      privilegedHelperInvocation(
        { executable: '/usr/local/lib/garden/garden-package-helper', args: ['install', 'nmap'] },
        helpers
      )
    ).toBe('garden-package-helper');
    expect(
      privilegedHelperInvocation(
        { executable: 'sh', args: ['-c', 'garden-sandbox run network id'] },
        helpers
      )
    ).toBe('garden-sandbox');
    expect(privilegedHelperInvocation({ executable: 'git', args: ['status'] }, helpers)).toBe(
      undefined
    );
    expect(
      privilegedHelperInvocation({ executable: 'garden-sandbox', args: [] }, [undefined])
    ).toBeUndefined();
  });
});

describe('executable resolution', () => {
  it('follows a symbolic link so a renamed escalation binary is still recognised', async () => {
    // `ln -s /usr/bin/sudo ./s` presents a basename of `s` to a check that only reads the string
    // it was handed, which is all the argument analysis used to see.
    const root = await mkdtemp(path.join(tmpdir(), 'garden-policy-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'sudo');
    await writeFile(target, '#!/bin/sh\nexit 0\n');
    await chmod(target, 0o755);
    const link = path.join(root, 's');
    await symlink(target, link);

    const resolved = await resolveExecutable('./s', '/usr/bin', root);
    expect(resolved).toBe(await realpath(target));
    expect(privilegeEscalationBinary({ executable: './s', args: [] })).toBeUndefined();
    expect(privilegeEscalationBinary({ executable: resolved!, args: [] })).toBe('sudo');
  });

  it('finds a bare command name on the search path the command will run with', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-policy-'));
    temporaryRoots.push(root);
    const tool = path.join(root, 'workspace-tool');
    await writeFile(tool, '#!/bin/sh\nexit 0\n');
    await chmod(tool, 0o755);
    expect(await resolveExecutable('workspace-tool', `${root}:/usr/bin`, root)).toBe(
      await realpath(tool)
    );
    expect(await resolveExecutable('absent-tool', `${root}:/usr/bin`, root)).toBeUndefined();
  });
});
