/*
 * What is left of tools.test.ts after the split, and it is left here on purpose.
 *
 * The catalogue's own tests went to tool-catalogue.test.ts and the approval floor's to
 * approval-policy.test.ts. These three blocks belong to neither: every one of them holds something
 * the catalogue DECLARES against the code that has to READ it - a verb the classifiers judge, a
 * field the runtime honours, a path the quarantine covers - and the whole class of defect they
 * were written for is a declaration nobody reads. Filed under either module alone, half of each
 * pair would have gone out of sight of the other, which is exactly how those eight silent no-ops
 * survived in the first place.
 *
 * The subject is the seam, so the file is named for the seam. Nothing here imports ./tools.js: the
 * re-export list left there is for agent.ts, not for tests.
 */
import { describe, expect, it } from 'vitest';
import { agentToolsFor } from './tool-catalogue.js';
import { approvalRequirement, memoryApprovalReason } from './approval-policy.js';
import {
  isDestructiveScript,
  isQuarantinedDownloadPath,
  untrustedShellOrigin
} from './command-classification.js';
import { isMutatingToolCall, writtenPaths } from './write-classification.js';
import {
  SUBSCRIPTION_AGENTS,
  SUBSCRIPTION_AGENTS_HONOURING_MAX_TURNS,
  subscriptionAgentName
} from './subscription-agent.js';

// Assembled rather than written whole, the way packages/core/src/redaction.test.ts does it
// and for the reason stated there: the run-time value is exactly the shape a credential
// scanner hunts for, which is the point of the fixture, and a literal of that shape in a
// public repository is an alert somebody has to dismiss.
const shapedSecret = (...parts: string[]): string => parts.join('');

describe('which calls count as changing something', () => {
  it('treats writes, external actions and consequential commands as changes', () => {
    expect(isMutatingToolCall('file_write', { path: 'a', content: 'b' })).toBe(true);
    expect(isMutatingToolCall('file_patch', {})).toBe(true);
    expect(isMutatingToolCall('browser_action', { action: 'click' })).toBe(true);
    expect(isMutatingToolCall('shell', { executable: 'rm', args: ['-rf', 'build'] })).toBe(true);
    expect(isMutatingToolCall('shell', { executable: 'git', args: ['push'] })).toBe(true);
    expect(isMutatingToolCall('schedule', { action: 'create' })).toBe(true);
  });

  it('reads the effect of a command rather than the phrasing it arrived in', () => {
    const gated = (executable: string, args: string[]) =>
      approvalRequirement('shell', { executable, args }, 'balanced')?.sideEffect;

    // Closed: a delete through a language runtime went through with no card, whatever the receiver
    // was called, while the same delete spelled `rm` stopped the task.
    expect(isDestructiveScript(`require('fs').rmSync('/home/garden',{recursive:true})`)).toBe(true);
    expect(isDestructiveScript(`const f=require('fs'); f.rmSync('/home/garden')`)).toBe(true);
    expect(isDestructiveScript(`import pathlib; pathlib.Path('x').unlink()`)).toBe(true);
    // ...without catching the `remove` every list in every language has.
    expect(isDestructiveScript(`items.remove(x); print(len(items))`)).toBe(false);

    // Closed: a wrapper is judged by what it runs.
    expect(gated('find', ['.', '-name', '*.pyc', '-exec', 'rm', '-f', '{}', '+'])).toBe(
      'external_consequential'
    );
    expect(gated('xargs', ['rm', '-f'])).toBe('external_consequential');
    expect(gated('timeout', ['30', 'rm', '-rf', 'build'])).toBe('external_consequential');
    // A wrapper around ordinary work is still ordinary work.
    expect(gated('timeout', ['600', 'pnpm', 'test'])).toBeUndefined();
    expect(gated('find', ['.', '-name', '*.md'])).toBeUndefined();

    // Removed: a discard sink destroys nothing, and stopping the task for one was very likely more
    // of the interruptions than any real delete.
    expect(isDestructiveScript('soffice --headless --convert-to pdf x.docx >/dev/null 2>&1')).toBe(
      false
    );
    expect(isDestructiveScript('typst compile a.typ b.pdf > /dev/null')).toBe(false);
    expect(isDestructiveScript('pnpm build > /tmp/build.log')).toBe(false);
    // A redirect that really does leave the workspace still counts.
    expect(isDestructiveScript('echo x > /etc/cron.d/garden')).toBe(true);
    expect(isDestructiveScript('echo x > ~/.bashrc')).toBe(true);
    expect(isDestructiveScript('echo x > ../../escape')).toBe(true);
  });

  it('does not let a window past what the shell would have stopped', () => {
    // desktop_launch spawns a program directly. The runner refuses to start a privilege escalation
    // or a package manager that way, for exactly this reason - but nothing stopped it starting a
    // destructive one, so asking for a window was a way around the card in every mode but review.
    const launched = approvalRequirement(
      'desktop_launch',
      { executable: 'bash', args: ['-c', 'rm -rf workspace'] },
      'balanced'
    );
    expect(launched?.sideEffect).toBe('external_consequential');
    // `~/.ssh` rather than `x`, because `desktop_launch` defaults its `cwd` to `workspace` exactly
    // as `shell` does, so `rm -rf x` there is `workspace/x` - inside the turn's own undo point, and
    // no longer a card by this floor's own rule. @see `insideCheckpointContent`. The claim this
    // line makes is about the window and not about the path, so the path is one nothing restores.
    expect(
      approvalRequirement(
        'desktop_launch',
        { executable: 'rm', args: ['-rf', '~/.ssh'] },
        'autonomous'
      )?.sideEffect
    ).toBe('external_consequential');
    // An ordinary application still opens without one.
    expect(
      approvalRequirement(
        'desktop_launch',
        { executable: '/usr/lib/libreoffice/program/soffice', args: ['--writer'] },
        'balanced'
      )
    ).toBeNull();
  });

  it('leaves reads and checks alone, so a verification step can still ground a finish', () => {
    // The rule exists to catch "changed a file, cited the search from four steps ago". Classifying
    // the test run as a change would make it impossible to satisfy.
    expect(isMutatingToolCall('shell', { executable: 'pnpm', args: ['test'] })).toBe(false);
    expect(isMutatingToolCall('shell', { executable: 'ls' })).toBe(false);
    expect(isMutatingToolCall('shell', { executable: 'git', args: ['-C', 'sub', 'status'] })).toBe(
      false
    );
    expect(isMutatingToolCall('code_diagnostics', {})).toBe(false);
    expect(isMutatingToolCall('file_read', { path: 'a' })).toBe(false);
    expect(isMutatingToolCall('schedule', { action: 'list' })).toBe(false);
    expect(isMutatingToolCall('web_search', { query: 'anything' })).toBe(false);
    // Sending a line to the owner's own devices changes nothing that could then be verified, and
    // counting it as a change would leave the notice itself as the only citable evidence after it.
    expect(isMutatingToolCall('notify', { headline: 'The page changed' })).toBe(false);
  });
});

/**
 * The two shell channels the taint model has to see.
 *
 * `network: true` cannot be the whole test for whether a command's output is somebody else's
 * words. It is a declaration and not a gate - the installer ships the per-command namespace off, so
 * the flag changes what the owner is asked and not what the command can reach - and trusting it
 * would make "curl the page without ticking the box" a clean way into a window the floor still
 * called clean. And a shell read of the download directory has to be labelled as the three file
 * readers label the same bytes: as quarantine.
 */
describe('what a shell command brings back from outside', () => {
  it('judges the command rather than the flag the model chose to set', () => {
    /*
     * The declaration counts for NOTHING, which is the second half of this repair and the half that
     * took a measurement to see.
     *
     * The flag stayed as a sufficient condition here after the command reader was added, so a turn
     * tainted itself installing its own dependencies: `npm run dev` with `network: true` marked the
     * window as having read somebody else's words, `npm run dev` without it did not, and the two
     * run the same program with the same access. Measured on the owner's own one-shot-app
     * trajectory, four of the six cards autonomous mode raised came from that single branch. A
     * declaration the runner ignores is not evidence that anything was read.
     */
    expect(untrustedShellOrigin({ executable: 'python3', network: true })).toBeNull();
    expect(
      untrustedShellOrigin({ executable: 'npm', args: ['run', 'dev'], network: true })
    ).toBeNull();
    // And a fetch taints whether or not it declared itself.
    expect(
      untrustedShellOrigin({ executable: 'curl', args: ['https://vendor.example/brief'] })
    ).toBe('network command output');
    expect(untrustedShellOrigin({ executable: '/usr/bin/wget', args: ['-q', 'x'] })).toBe(
      'network command output'
    );
    expect(untrustedShellOrigin({ executable: 'git', args: ['clone', 'git@host:repo.git'] })).toBe(
      'network command output'
    );
    expect(untrustedShellOrigin({ executable: 'git', args: ['-C', 'sub', 'pull'] })).toBe(
      'network command output'
    );
    expect(untrustedShellOrigin({ executable: 'pnpm', args: ['install'] })).toBe(
      'network command output'
    );
    // The interpreter is how `shell` reaches the network without naming a network client at all.
    expect(
      untrustedShellOrigin({
        executable: 'python3',
        args: ['-c', 'import urllib.request as u; print(u.urlopen("http://vendor.example").read())']
      })
    ).toBe('network command output');
    /*
     * And where the fetch went, for the clients that write their far end down.
     *
     * A health check against the dev server this turn just started reads this computer's own
     * output. `classifyDestination` has always answered `sink: false` for loopback; the taint reader
     * did not ask, so the agent doing what the resident contract tells it to do - check the app
     * came up - marked every call after it as working with hostile material.
     */
    expect(
      untrustedShellOrigin({
        executable: 'curl',
        args: ['-sS', 'http://localhost:5173/api/health'],
        network: true
      })
    ).toBeNull();
    expect(
      untrustedShellOrigin({ executable: 'bash', args: ['-lc', 'curl -s http://127.0.0.1:8080/'] })
    ).toBeNull();
    // An operand the client wrote and this could not read is not a cleared address. It comes back
    // from the address reader as one that will not parse, and unreadable fails closed.
    expect(
      untrustedShellOrigin({ executable: 'bash', args: ['-lc', 'curl -s "$U" -o p.html'] })
    ).toBe('network command output');
  });

  /*
   * The other half of that question, and the half that is easy to lose: "not somewhere data can go"
   * is a much larger set than "this computer". `isPublicHttpUrl` answers false for loopback and
   * just as false for RFC1918, link-local, `*.local`, `*.internal`, `*.home.arpa` and
   * `metadata.google.internal` - so a taint reader that asks the egress classifier whether an
   * address is a sink clears every machine on the estate LAN and the cloud metadata service along
   * with the dev server. Each of these is somebody else's bytes arriving in the window, and the
   * turn that reads one goes on to write the brief and fetch outward.
   *
   * Driven in both spellings on purpose. The rest of the flag removal is bounded by "the silent
   * spelling was already free"; this clause is not, because it took the stop away from a call that
   * carded with `network` set and without it.
   */
  it('treats a read of another machine on the network as untrusted, not merely as somewhere data cannot go', () => {
    for (const address of [
      'http://wiki.internal/runbook',
      'http://192.168.1.50/notes',
      'http://10.0.0.5/brief',
      'http://172.16.4.9/x',
      'http://printer.local/status',
      'http://box.home.arpa/f',
      // Link-local, and the one address on it that matters: the cloud metadata service.
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/'
    ]) {
      expect(untrustedShellOrigin({ executable: 'curl', args: ['-s', address] })).toBe(
        'network command output'
      );
      expect(
        untrustedShellOrigin({ executable: 'curl', args: ['-s', address], network: true })
      ).toBe('network command output');
    }
    // And the counterweight, so this cannot be satisfied by tainting everything: the loopback
    // spellings a health check really uses stay clean, including the root label and IPv6.
    for (const address of [
      'http://localhost:5173/api/health',
      'http://127.0.0.1:8080/',
      'http://127.0.0.53/status',
      'http://app.localhost/p',
      'http://[::1]:3000/health'
    ])
      expect(untrustedShellOrigin({ executable: 'curl', args: ['-s', address] })).toBeNull();
  });

  it('labels a shell read of the download directory, which the file readers already did', () => {
    expect(
      untrustedShellOrigin({ executable: 'cat', args: ['workspace/downloads/terms.txt'] })
    ).toBe('downloaded file workspace/downloads/terms.txt');
    // Absolute and dot-relative spellings of the same file, and a path reached only from inside an
    // inline script, where the whole command is one argument.
    expect(untrustedShellOrigin({ executable: 'cat', args: ['./downloads/terms.txt'] })).toBe(
      'downloaded file downloads/terms.txt'
    );
    expect(
      untrustedShellOrigin({
        executable: 'bash',
        args: ['-lc', 'grep -i clause < workspace/downloads/contract.txt']
      })
    ).toBe('downloaded file workspace/downloads/contract.txt');
  });

  it('leaves the ordinary work of a repository alone, so the floor keeps meaning something', () => {
    // A floor that rose on the build and the test run would raise a card on every task and be
    // tapped through, which is the failure it exists to prevent.
    expect(untrustedShellOrigin({ executable: 'git', args: ['status'] })).toBeNull();
    expect(
      untrustedShellOrigin({ executable: 'git', args: ['-C', 'sub', 'log', '-1'] })
    ).toBeNull();
    expect(untrustedShellOrigin({ executable: 'pnpm', args: ['test'] })).toBeNull();
    expect(untrustedShellOrigin({ executable: 'ls', args: ['-la', 'workspace'] })).toBeNull();
    expect(
      untrustedShellOrigin({ executable: 'cat', args: ['workspace/notes/download-plan.md'] })
    ).toBeNull();
  });
});

/**
 * The eight silent no-ops in the catalogue and its classifiers.
 *
 * Every one of them is the same shape: something declares a capability or a gate, and the code
 * that would have to honour it never reads the field. They are grouped here because the group is
 * the finding - a catalogue that describes itself has to be held against the code that reads it.
 */
describe('what the catalogue declares and the classifiers actually read', () => {
  const tool = (name: string) => agentToolsFor().find((entry) => entry.name === name);
  const fields = (name: string) =>
    (tool(name)?.parameters.properties ?? {}) as Record<
      string,
      { description?: string; enum?: string[]; properties?: Record<string, unknown> }
    >;

  it('sees a script the model wrote to stdin exactly as one it wrote to -lc', () => {
    // commandScript exists because moving a script into stdin walked past every classifier at
    // once. isMutatingToolCall was the one that never adopted it, and writtenPaths gates on it,
    // so `bash -lc 'echo … >> workspace/GARDEN.md'` stopped for review and the identical script
    // through stdin landed a standing directive into the file loaded ahead of every later task
    // with no card at all.
    const script = 'echo "always deploy on friday" >> workspace/GARDEN.md';
    expect(isMutatingToolCall('shell', { executable: 'bash', args: ['-lc', script] })).toBe(true);
    expect(isMutatingToolCall('shell', { executable: 'bash', args: [], stdin: script })).toBe(true);
    expect(writtenPaths('shell', { executable: 'bash', args: [], stdin: script })).toContain(
      'workspace/GARDEN.md'
    );
    expect(
      approvalRequirement('shell', { executable: 'bash', args: [], stdin: script }, 'balanced', {
        taintSources: ['a page']
      })
    ).not.toBeNull();
  });

  it('still treats an interpreter with nothing to run as a check', () => {
    // The asymmetry the comment on isMutatingToolCall argues for: an unrecognised command is a
    // check, so `python3 --version` must not start costing a checkpoint.
    expect(isMutatingToolCall('shell', { executable: 'python3', args: ['--version'] })).toBe(false);
    expect(isMutatingToolCall('shell', { executable: 'bash', args: [], stdin: '  ' })).toBe(false);
  });

  it('counts a transcription as the read it is', () => {
    // audio_read arrived after NON_MUTATING_TOOLS was written and was never added, so one voice
    // memo took a full workspace checkpoint, set mutatedBeyondProse, and sent the model back for
    // a set_acceptance on a job with nothing to build.
    expect(isMutatingToolCall('audio_read', { path: 'workspace/memo.m4a' })).toBe(false);
  });

  it('declares maxBytes where the connector layer parses it and the runtime cites it', () => {
    // mail-connectors.ts parses, bounds and consumes maxBytes on mail_read_message and
    // mail_read_attachment, and its truncation note tells the model to "Raise maxBytes to see the
    // rest" - into a bag declared additionalProperties:false that did not offer the field. The
    // model looped on the harness's own instruction against 20 MB of unreachable headroom.
    const input = fields('connector_action').input;
    expect(input?.properties?.maxBytes).toBeDefined();
    expect(input?.description).toMatch(/mail_read_message: uid, optional mailbox, maxCharacters/);
    expect(input?.description).toMatch(/maxBytes/);
  });

  it('names which coding agents honour a turn bound', () => {
    // maxTurns is emitted only on the claude branch of buildSubscriptionAgentArgs; Codex exec and
    // OpenCode run publish no equivalent flag. A model that bounded a risky Codex refactor at
    // three turns bounded nothing and the only remaining stop was timeoutSeconds, up to an hour.
    const maxTurns = fields('coding_agent').maxTurns;
    // Read as the clause is written: what the bound stops, then what it does not. Held against the
    // list buildSubscriptionAgentArgs obeys, so wiring a second agent turns this red until the
    // sentence follows.
    const [bounded = '', unbounded = ''] = (maxTurns?.description ?? '').split(';');
    for (const agent of SUBSCRIPTION_AGENTS) {
      const honoured = SUBSCRIPTION_AGENTS_HONOURING_MAX_TURNS.includes(agent);
      const name = subscriptionAgentName(agent);
      expect(bounded.includes(name), `${name} on the bounded side`).toBe(honoured);
      expect(unbounded.includes(name), `${name} on the unbounded side`).toBe(!honoured);
    }
    expect(unbounded).toMatch(/timeoutSeconds/);
    // And the enum the clause talks about is the same list, not a second copy of it.
    expect(fields('coding_agent').agent?.enum).toEqual(['garden', ...SUBSCRIPTION_AGENTS]);
  });

  it('quarantines the directory the operating contract routes attachments through', () => {
    // context.ts tells the model to "save an attachment into the workspace before reading it
    // there" and agent.ts writes those attachments to workspace/mail. Reading one back in a later
    // task was classified as a read of the owner's own computer, so the turn was judged clean and
    // every sink on it was ungated.
    expect(isQuarantinedDownloadPath('workspace/mail/4711-invoice.pdf')).toBe(true);
    expect(isQuarantinedDownloadPath('./workspace/mail/4711-invoice.pdf')).toBe(true);
    expect(isQuarantinedDownloadPath('workspace/notes/plan.md')).toBe(false);
  });

  it('does not name a memory scope on the two actions that resolve their own', () => {
    // replace and remove look the entry up by id and use the stored record's target. The card
    // printed args.target anyway, so replace{target:'user', id:<a workspace id>} headed the card
    // "Review long-term user memory" and then rewrote a workspace entry.
    const replace = approvalRequirement(
      'memory',
      { action: 'replace', target: 'user', id: 'mem_1', content: 'x' },
      'balanced'
    );
    expect(replace?.action).toBe('Review long-term memory');
    const remove = approvalRequirement(
      'memory',
      { action: 'remove', target: 'user', id: 'mem_1' },
      'balanced'
    );
    expect(remove?.action).toBe('Review long-term memory');
    // add is the one action whose target argument is the one the executor obeys, so it keeps it.
    expect(
      approvalRequirement('memory', { action: 'add', target: 'user', content: 'x' }, 'balanced')
        ?.action
    ).toBe('Review long-term user memory');
  });

  it('lets an ordinary address through and still refuses a credential', () => {
    // "Invoices go to accounts@acme.example" is exactly the stable convention memory exists for,
    // and it was refused with a card reading "which must never be stored in memory" - false as
    // policy on a product whose mail connector exists to work with addresses, and fired on
    // ordinary content, which is the card fatigue the surrounding comment was written to end.
    const soon = new Date('2026-11-01T09:00:00Z').toISOString();
    const now = new Date('2026-08-02T09:00:00Z');
    expect(
      memoryApprovalReason(
        {
          action: 'add',
          target: 'workspace',
          content: 'Invoices go to accounts@acme.example.',
          validUntil: soon
        },
        now
      )
    ).toBeNull();
    expect(
      memoryApprovalReason(
        {
          action: 'add',
          target: 'workspace',
          content: `Deploy with ${shapedSecret('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz01')}.`,
          validUntil: soon
        },
        now
      )
    ).toMatch(/never be stored in memory/);
  });

  it('claims no page links it does not return', () => {
    // BrowserSnapshotParts has url, title, holder, botWall, elements, tabs, downloads,
    // pendingDialog, consoleMessages, images, screenshotBase64 and text. It has never had links,
    // and the description promised them twice.
    expect(tool('browser_snapshot')?.description).not.toMatch(/links/);
  });
});
