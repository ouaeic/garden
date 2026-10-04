import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { resolveExecutable } from './command-policy.js';
import { agentHome, agentSearchPath, hostSearchPath } from './execution.js';
import {
  describeRenderProof,
  edgeCrossings,
  findRenderTools,
  inkFraction,
  MAX_BLANK_PROBE_PAGES,
  parseRenderedPages,
  proveRender,
  type RenderTools
} from './render-proof.js';
import { buildServer } from './server.js';

/**
 * Poppler's own answer, kept verbatim from a run against a document built for these tests, because
 * the parser's whole job is to read what poppler actually writes rather than what a reasonable
 * person would expect it to. Three pages: one with a word the render cut at the right edge - note
 * that the word text is truncated too, and that its box reaches past the page - one ordinary page,
 * and one with nothing on it at all.
 */
const POPPLER_BBOX = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml">
<head>
</head>
<body>
<doc>
  <page width="612.000000" height="792.000000">
    <word xMin="72.000000" yMin="83.384000" xMax="121.344000" yMax="94.484000">Quarterly</word>
    <word xMin="124.680000" yMin="83.384000" xMax="160.020000" yMax="94.484000">results</word>
    <word xMin="163.356000" yMin="83.384000" xMax="177.360000" yMax="94.484000">for</word>
    <word xMin="180.696000" yMin="83.384000" xMax="197.376000" yMax="94.484000">Ferrers &amp; Co</word>
    <word xMin="560.000000" yMin="383.384000" xMax="620.000000" yMax="394.484000">ThisWordR</word>
  </page>
  <page width="612.000000" height="792.000000">
    <word xMin="72.000000" yMin="83.384000" xMax="80.004000" yMax="94.484000">A</word>
  </page>
  <page width="612.000000" height="792.000000">
  </page>
</doc>
</body>
</html>
`;

const page = (words: Array<[number, number, number, number]>, width = 612, height = 792) => ({
  width,
  height,
  words: words.map(([xMin, yMin, xMax, yMax], index) => ({
    text: `word${index}`,
    xMin,
    yMin,
    xMax,
    yMax
  }))
});

/** A greyscale raster in the one format `pdftoppm -gray` writes, so the reader is fed real bytes. */
const pgm = (width: number, height: number, fill: (index: number) => number): Buffer =>
  Buffer.concat([
    Buffer.from(`P5\n${width} ${height}\n255\n`),
    Buffer.from(Uint8Array.from({ length: width * height }, (_unused, index) => fill(index)))
  ]);

describe('what poppler says a rendered page holds', () => {
  it('reads the size of every page and the box of every word on it', () => {
    const pages = parseRenderedPages(POPPLER_BBOX);
    expect(pages).toHaveLength(3);
    expect(pages[0]?.width).toBe(612);
    expect(pages[0]?.height).toBe(792);
    expect(pages[0]?.words).toHaveLength(5);
    expect(pages[0]?.words[4]).toMatchObject({ text: 'ThisWordR', xMax: 620 });
    // A page with nothing on it is still a page: losing it here would move every later page number
    // in the sentence the owner reads.
    expect(pages[2]?.words).toEqual([]);
  });

  it('gives back the word as it appears on the page rather than as XML spells it', () => {
    expect(parseRenderedPages(POPPLER_BBOX)[0]?.words[3]?.text).toBe('Ferrers & Co');
  });
});

describe('text the render had to cut at an edge', () => {
  it('names the word, the edge and how far past it went', () => {
    const [crossing, ...rest] = edgeCrossings(parseRenderedPages(POPPLER_BBOX));
    expect(rest).toEqual([]);
    expect(crossing).toMatchObject({ page: 1, word: 'ThisWordR', edge: 'right' });
    expect(crossing?.overshootPoints).toBeCloseTo(8, 3);
  });

  it('stays silent on a page whose design runs text right up to all four edges', () => {
    // The hardest honest case: a full-bleed layout. Text flush against the left margin at zero, a
    // line ending exactly on the right edge, a heading whose ascenders touch the top, a footer
    // whose descenders reach the bottom, and a word half a point over from the converter's own
    // rounding. Not one of them was cut, so not one of them is a finding.
    expect(
      edgeCrossings([
        page([
          [0, 40, 120, 52],
          [400, 40, 612, 52],
          [72, 0, 300, 14],
          [72, 780, 300, 792],
          [72, 400, 612.5, 412]
        ])
      ])
    ).toEqual([]);
  });

  it('measures against the margin the job was given, when it was given one', () => {
    const inset = page([[20, 400, 300, 412]]);
    expect(edgeCrossings([inset])).toEqual([]);
    expect(edgeCrossings([inset], 36)).toMatchObject([{ edge: 'left', page: 1 }]);
  });

  it('reports a word pushed off a corner once rather than twice', () => {
    expect(edgeCrossings([page([[-6, -9, 40, 3]])])).toHaveLength(1);
  });
});

describe('a page with nothing on it', () => {
  it('separates a page that is empty from a page that is a picture', () => {
    expect(inkFraction(pgm(100, 100, () => 255))).toBe(0);
    expect(inkFraction(pgm(100, 100, (index) => (index < 2_000 ? 0 : 255)))).toBeCloseTo(0.2, 5);
  });

  it('says nothing rather than guessing when the bytes are not a raster it reads', () => {
    expect(inkFraction(Buffer.from('\x89PNG\r\n\x1a\n'))).toBeUndefined();
    expect(inkFraction(Buffer.from('P5\n10 10\n65535\n'))).toBeUndefined();
  });
});

describe('the sentence the acceptance record shows the owner', () => {
  const base = {
    pages: 12,
    unit: 'slide' as const,
    marginPoints: 0,
    crossings: [],
    blankPages: [],
    unreadablePages: [],
    unprobedPages: 0,
    words: 486
  };

  it('says what was measured, not that it looks right', () => {
    expect(describeRenderProof({ ...base, renderedFrom: 'deck.pptx' })).toEqual({
      passed: true,
      detail:
        '12 slides, 486 words placed, no text crossing a slide edge, none blank (measured on the PDF this computer rendered from deck.pptx)'
    });
  });

  it('counts the pages the owner would count', () => {
    expect(describeRenderProof({ ...base, pages: 2, unit: 'page', expectPages: 1 })).toMatchObject({
      passed: false,
      detail: 'it renders 2 pages, not the 1 page asked for'
    });
  });

  it('quotes the word that was cut and where the rest of them are', () => {
    const { passed, detail } = describeRenderProof({
      ...base,
      crossings: [
        { page: 4, word: 'Attribution', edge: 'right' as const, overshootPoints: 6.43 },
        { page: 7, word: 'modelling', edge: 'right' as const, overshootPoints: 2.1 }
      ]
    });
    expect(passed).toBe(false);
    expect(detail).toBe(
      'slide 4 of 12: “Attribution” runs 6.4pt past the right edge of the slide and is cut off there, and 1 other word crosses an edge on slide 7'
    );
  });

  it('will not call a page blank when it could not look at it', () => {
    expect(describeRenderProof({ ...base, unreadablePages: [3] }).detail).toContain(
      'could not render it'
    );
    expect(describeRenderProof({ ...base, unprobedPages: 40 }).detail).toContain(
      'cannot say whether they are blank'
    );
  });

  /**
   * The sentence above is the honest one and it is still a refusal, so how far it sits decides
   * whether this check is usable. Set too low, a twenty-page scan comes back unvouchable - the
   * ceiling describing itself rather than the document - which is a guard firing on ordinary work.
   *
   * A floor rather than an equality, because the number is a cost decision and may rise; what
   * must not happen is it quietly falling back under the documents people actually have.
   */
  it('reaches the end of a scan rather than reporting its own ceiling', () => {
    expect(MAX_BLANK_PROBE_PAGES).toBeGreaterThanOrEqual(48);
  });
});

/**
 * A PDF written by hand, because every case below needs text at a position chosen to the point and
 * no generator gives that. Helvetica is one of the base fourteen faces, so nothing has to be
 * embedded and the file stays the few hundred bytes a test can afford to build.
 */
const buildPdf = (pages: readonly string[]): Buffer => {
  const objects = new Map<number, string>();
  const kids: number[] = [];
  let next = 3;
  for (const content of pages) {
    const [stream, page] = [next, next + 1];
    objects.set(stream, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objects.set(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9999 0 R >> >> /Contents ${stream} 0 R >>`
    );
    kids.push(page);
    next += 2;
  }
  objects.set(9999, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(
    2,
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`
  );
  let file = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (const number of [...objects.keys()].sort((left, right) => left - right)) {
    offsets.set(number, file.length);
    file += `${number} 0 obj\n${objects.get(number) ?? ''}\nendobj\n`;
  }
  const startxref = file.length;
  const size = Math.max(...objects.keys()) + 1;
  file += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let number = 1; number < size; number += 1)
    file += offsets.has(number)
      ? `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  file += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(file, 'latin1');
};

const type = (x: number, y: number, body: string, size = 12): string =>
  `BT /F1 ${size} Tf ${x} ${y} Td (${body}) Tj ET\n`;
/** A filled rectangle: ink on a page with no text on it, which is what a picture looks like here. */
const block = '0 0 0 rg 100 100 300 300 re f\n';

const where = (name: string): string | undefined => {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : undefined;
};

describe('measuring a document this computer rendered', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-render-test-'));
    await mkdir(path.join(root, 'workspace'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const noTools: RenderTools = {
    pdftotext: undefined,
    pdftoppm: undefined,
    officeConvert: undefined
  };

  it.each(['deadline', 'cancellation'] as const)(
    'stops conversion descendants on %s without reporting a pass',
    async (mode) => {
      const converter = path.join(root, 'converter');
      const marker = path.join(root, 'escaped-child');
      await writeFile(path.join(root, 'workspace', 'deck.pptx'), 'pretend Office file');
      await writeFile(
        converter,
        `#!/bin/sh\n(sleep 1; touch '${marker.replaceAll("'", "'\\''")}') &\nwait\n`,
        { mode: 0o700 }
      );
      const controller = new AbortController();
      const started = Date.now();
      const timer = mode === 'cancellation' ? setTimeout(() => controller.abort(), 100) : undefined;
      try {
        await expect(
          proveRender(
            root,
            {
              path: 'workspace/deck.pptx',
              deadlineAt: started + (mode === 'deadline' ? 100 : 30_000)
            },
            { ...noTools, pdftotext: '/bin/true', officeConvert: converter },
            undefined,
            controller.signal
          )
        ).rejects.toMatchObject({ status: 408 });
        expect(Date.now() - started).toBeLessThan(2000);
        await sleep(1100);
        expect(existsSync(marker)).toBe(false);
      } finally {
        clearTimeout(timer);
      }
    }
  );

  it('refuses a file that has no rendered page at all', async () => {
    await expect(proveRender(root, { path: 'workspace/notes.md' }, noTools)).rejects.toThrow(
      /no rendered page/
    );
  });

  it('says it could not run rather than that the document is fine', async () => {
    await expect(proveRender(root, { path: 'workspace/cv.pdf' }, noTools)).rejects.toThrow(
      /no PDF page reader.*cannot say whether the document is right/s
    );
    await expect(
      proveRender(root, { path: 'workspace/deck.pptx' }, { ...noTools, pdftotext: '/bin/true' })
    ).rejects.toThrow(/no Office converter/);
  });

  const pdftotext = where('pdftotext');
  const pdftoppm = where('pdftoppm');
  const poppler: RenderTools = {
    pdftotext,
    pdftoppm,
    officeConvert: undefined
  };
  const missingPoppler = [...(pdftotext ? [] : ['pdftotext']), ...(pdftoppm ? [] : ['pdftoppm'])];
  const withPoppler = it.skipIf(missingPoppler.length > 0);

  /**
   * Every case guarded by `withPoppler` measures a page this computer actually rendered, and on a
   * host without poppler all seven of them disappeared silently into a green run. That host was
   * every CI runner: the workflow installed no packages, so the whole of this half had never once
   * executed. `scripts/check-repository.mjs:115-120` settled the shape - optional on a laptop,
   * mandatory on the runner - and this is that arm. The `application` job installs poppler-utils
   * so the assertion below is a statement about the workflow rather than about the machine.
   */
  it.runIf(process.env.GITHUB_ACTIONS)(
    'has the page reader on this CI runner, rather than skipping every measurement below',
    () => {
      expect(
        missingPoppler,
        'install poppler-utils in the `application` job of .github/workflows/verify.yml'
      ).toEqual([]);
    }
  );

  const write = async (name: string, pages: readonly string[]): Promise<string> => {
    await writeFile(path.join(root, 'workspace', name), buildPdf(pages));
    return `workspace/${name}`;
  };

  withPoppler('stays silent on a document that is laid out correctly', async () => {
    // Everything a healthy deliverable does that a careless check would call a defect: a word
    // flush against the left edge, a line that ends close to the right one, a page whose only
    // content is a picture, and a footer near the bottom.
    const file = await write('report.pdf', [
      type(0, 400, 'FlushLeft') +
        type(430, 700, 'A line ending near the right edge') +
        type(72, 20, 'Footer'),
      block,
      type(72, 700, 'Closing remarks')
    ]);
    const result = await proveRender(root, { path: file, expectPages: 3 }, poppler);
    expect(result).toMatchObject({ passed: true, pages: 3, crossings: 0, blankPages: [] });
    expect(result.detail).toContain('3 pages');
    expect(result.detail).toContain('none blank');
  });

  withPoppler('catches the word that ran off the edge of the page', async () => {
    const file = await write('deck.pdf', [
      type(72, 700, 'Quarterly results') + type(560, 400, 'ThisWordRunsOffTheEdge')
    ]);
    const result = await proveRender(root, { path: file }, poppler);
    expect(result.passed).toBe(false);
    expect(result.crossings).toBe(1);
    expect(result.detail).toMatch(/runs [\d.]+pt past the right edge of the page and is cut off/);
  });

  withPoppler('catches a document that is not the length it was asked to be', async () => {
    const file = await write('cv.pdf', [type(72, 700, 'Daniel'), type(72, 700, 'continued')]);
    const result = await proveRender(root, { path: file, expectPages: 1 }, poppler);
    expect(result).toMatchObject({ passed: false, pages: 2 });
    expect(result.detail).toContain('it renders 2 pages, not the 1 page asked for');
  });

  withPoppler('catches the page that came out empty, and only that page', async () => {
    const file = await write('deck.pdf', [type(72, 700, 'Agenda'), '', block]);
    const result = await proveRender(root, { path: file }, poppler);
    expect(result).toMatchObject({ passed: false, blankPages: [2] });
    expect(result.detail).toBe('page 2 of 3 has no text and no ink on it: it renders blank');
  });

  withPoppler('will not say a page is blank when it cannot render it', async () => {
    const file = await write('deck.pdf', [type(72, 700, 'Agenda'), block]);
    const result = await proveRender(root, { path: file }, { ...poppler, pdftoppm: undefined });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('could not render it');
  });

  withPoppler('refuses bytes that are not a document rather than passing them', async () => {
    await writeFile(path.join(root, 'workspace', 'broken.pdf'), 'not a PDF at all');
    await expect(proveRender(root, { path: 'workspace/broken.pdf' }, poppler)).rejects.toThrow(
      /could not be read as a rendered document|rendered to no pages/
    );
  });
});

/**
 * The route the harness reaches for, driven through the real server.
 *
 * Written this way because the failure worth catching is not in the arithmetic above: it is a
 * measurement that nothing calls. The reader is planted on the search path the runner actually
 * resolves against, so what is asserted is the whole path - capability, workspace path, spawn,
 * parse, sentence - rather than a function that happens to be exported.
 */
const WORKSPACE = '00000000-0000-4000-8000-0000000000d4';

const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig =>
  ({
    RUNNER_HOST: '127.0.0.1',
    RUNNER_PORT: 0,
    RUNNER_SHARED_SECRET: secret,
    WORKSPACE_ROOT: workspaceRoot,
    TAR_EXECUTABLE: '/usr/bin/tar',
    SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
    BROWSER_USE_DESKTOP_DISPLAY: false,
    BROWSER_CPU_NICE: 0,
    MAX_EXECUTION_SECONDS: 30,
    RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
    IMAGE_CONVERT_EXECUTABLE: 'magick',
    MAX_BACKGROUND_SECONDS: 120,
    COMMAND_PROCESS_LIMIT: 1024,
    COMMAND_OPEN_FILE_LIMIT: 4096,
    MAX_FILE_BYTES: 1024 * 1024,
    RESERVED_PREVIEW_PORTS: [],
    CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
    CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
    CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
    CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
    CHECKPOINT_RETAIN_TURNS: 20,
    CHECKPOINT_RETAIN_DAILY_DAYS: 14,
    CHECKPOINT_MAX_FILES: 250_000,
    CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
    ISOLATE_AGENT_NETWORK: false
  }) as RunnerConfig;

describe('the route the acceptance record calls', () => {
  const disposers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const secret = 'runner-render-test-secret-at-least-32-characters';

  /**
   * A page reader in one of the six system directories, or nothing.
   *
   * The route resolves poppler on `hostSearchPath`, so a stub the test writes into the workspace
   * cannot stand in for it - which is the point, and is asserted below. What is
   * left for the measuring case is the host's own copy, when the host has one.
   */
  const systemPdftotext = (): string | undefined =>
    hostSearchPath
      .split(path.delimiter)
      .map((directory) => path.join(directory, 'pdftotext'))
      .find((candidate) => existsSync(candidate));

  /**
   * A server holding one document, and optionally a page reader planted where an agent could put
   * one - the first entry of `agentSearchPath`.
   */
  const serve = async (options: { reader?: string; document?: Buffer }) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-render-route-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const root = path.join(workspaceRoot, WORKSPACE);
    await ensureWorkspace(root);
    await writeFile(
      path.join(root, 'workspace', 'deck.pdf'),
      options.document ?? '%PDF-1.4 pretend\n'
    );
    if (options.reader) {
      const bin = path.join(root, 'workspace', '.garden', 'tools', 'node_modules', '.bin');
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'pdftotext'), options.reader);
      await chmod(path.join(bin, 'pdftotext'), 0o755);
    }
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    return (body: unknown, scopes = ['exec']) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/document/render-proof`,
        headers: {
          authorization: `Bearer ${signCapabilityToken(
            {
              sub: 'task',
              workspaceId: WORKSPACE,
              role: 'agent',
              scopes,
              aud: capabilityAudience('POST', `/v1/workspaces/${WORKSPACE}/document/render-proof`),
              nonce: randomUUID()
            },
            secret
          )}`,
          'content-type': 'application/json'
        },
        payload: JSON.stringify(body)
      });
  };

  /**
   * A page reader planted in the workspace's own tool bin - a directory `scripts/garden-sandbox`
   * grants the agent write on - must not be run on the owner's document as the runner's own
   * account.
   *
   * The status is asserted only as "not the measurement", because which refusal arrives depends on
   * whether this host has poppler in a system directory. The marker is the assertion that matters:
   * it is written by the decoy itself and by nothing else.
   */
  it('will not run a page reader the agent left on its own search path', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'garden-render-marker-')), 'ran');
    const call = await serve({
      reader: `#!/bin/sh\n: > ${JSON.stringify(marker)}\ncat <<'PAGES'\n${POPPLER_BBOX}PAGES\n`
    });
    const response = await call({ path: 'workspace/deck.pdf', expectPages: 3 });
    expect(response.statusCode).not.toBe(200);
    expect(existsSync(marker), 'the route ran a page reader the agent wrote').toBe(false);
  });

  /**
   * And the route still measures, with the host's own reader. Skipped where there is none, which
   * on a developer's laptop is usual and on the runner is a broken install - so CI asserts the
   * skip did not happen rather than counting it as a pass.
   */
  it.skipIf(!systemPdftotext())(
    'answers with the measurement the acceptance record shows the owner',
    async () => {
      const call = await serve({
        document: buildPdf([
          type(72, 700, 'Quarterly results') + type(560, 400, 'ThisWordRunsOffTheEdge')
        ])
      });
      const response = await call({ path: 'workspace/deck.pdf', expectPages: 3 });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ passed: false, pages: 1, converted: false });
      // Two faults, both from the same one-page document: it is not the three pages the job asked
      // for, and a word runs off the right edge of the page it does have.
      const detail = response.json<{ detail: string }>().detail;
      expect(detail).toContain('not the 3 pages asked for');
      expect(detail).toContain('runs');
    }
  );

  it.runIf(process.env.GITHUB_ACTIONS)(
    'has a system page reader on this CI runner, rather than skipping the case above',
    () => {
      expect(
        systemPdftotext(),
        'install poppler-utils in the `application` job of .github/workflows/verify.yml'
      ).toBeTruthy();
    }
  );

  /*
   * The machine with no page reader, which is the only machine this arm can be asked about.
   *
   * The route builds its own tools from `findRenderTools` and takes none from the caller, so the
   * "no reader at all" branch is reachable only on a host that has none. On a host that has one -
   * every CI runner since the `application` job began installing poppler-utils, and every
   * provisioned box - the reader runs, the placeholder document is not a PDF, and the answer is
   * 422 rather than 503. Asserted unguarded this case therefore reported a different defect
   * depending on who ran it, and was red on CI while green on a laptop.
   *
   * Nothing is lost by skipping it where a reader exists: the sentence it checks is pinned on
   * every host by `says it could not run rather than that the document is fine` above, which calls
   * `proveRender` with `noTools` directly, and the measuring path on such a host is pinned by
   * `answers with the measurement the acceptance record shows the owner`. What is left here is the
   * one thing only the route can say - that the absence maps to 503 and not to a pass.
   */
  it.skipIf(systemPdftotext())(
    'says it could not measure anything rather than passing the document',
    async () => {
      const call = await serve({});
      const response = await call({ path: 'workspace/deck.pdf' });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: { message: string } }>().error.message).toContain(
        'cannot say whether the document is right'
      );
    }
  );

  it('is not a route a capability without exec can reach', async () => {
    const call = await serve({});
    expect((await call({ path: 'workspace/deck.pdf' }, ['files.read'])).statusCode).toBe(403);
  });

  it('refuses a path that leaves the owner’s own files', async () => {
    const call = await serve({});
    expect((await call({ path: '../../etc/passwd' })).statusCode).toBe(400);
  });
});

/**
 * Where the three render tools are looked for, which is not where an agent command looks.
 *
 * pdftotext, pdftoppm and garden-office-convert are spawned by the runner's own account against
 * the owner's document. Both directories planted here are ones the sandbox grants the agent write
 * on, and one of them leads the list an agent command resolves against.
 */
describe('the tools a render proof spawns', () => {
  const planted = async (): Promise<{ root: string; decoy: string }> => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-render-decoy-'));
    const decoy = path.join(root, 'workspace', '.garden', 'tools', 'node_modules', '.bin');
    for (const bin of [decoy, path.join(agentHome(root), '.local', 'bin')]) {
      await mkdir(bin, { recursive: true });
      for (const name of ['pdftotext', 'pdftoppm', 'garden-office-convert']) {
        await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n');
        await chmod(path.join(bin, name), 0o755);
      }
    }
    return { root, decoy };
  };

  it('finds none of them in a directory the agent can write', async () => {
    const { root } = await planted();
    const inside = await realpath(root);
    const tools = await findRenderTools(root);
    // Asserted as "not from in there" rather than as "absent", because a provisioned host has real
    // poppler in /usr/bin and finding it is the correct answer. `realpath` first: resolveExecutable
    // returns the resolved path, and on macOS the temporary root is itself behind a symlink.
    for (const found of [tools.pdftotext, tools.pdftoppm, tools.officeConvert])
      expect(found === undefined || !found.startsWith(inside)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('would have found them on the list an agent command uses', async () => {
    const { root, decoy } = await planted();
    // The counter-direction: without it the case above passes on decoys that were never reachable.
    expect(await resolveExecutable('pdftotext', agentSearchPath(root), root)).toBe(
      await realpath(path.join(decoy, 'pdftotext'))
    );
    await rm(root, { recursive: true, force: true });
  });
});
