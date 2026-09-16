#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const { capabilityAudience, signCapabilityToken } = await import(
  new URL('../packages/core/dist/index.js', import.meta.url).href
);

const secret = process.env.RUNNER_SHARED_SECRET;
if (!secret || secret.length < 32) {
  throw new Error('RUNNER_SHARED_SECRET must be available in the runner environment');
}

const runnerUrl = process.env.WORKSPACE_RUNNER_URL ?? 'http://127.0.0.1:4300';
const workspaceId = process.env.ATHANOR_DRILL_WORKSPACE ?? randomUUID();
const subject = 'athanor-release-drill';

const token = (scopes, method, path) =>
  signCapabilityToken(
    {
      sub: subject,
      workspaceId,
      role: 'agent',
      scopes,
      aud: capabilityAudience(method, path),
      nonce: randomUUID()
    },
    secret,
    120
  );

const request = async (path, { method = 'GET', scopes = ['*'], body, binary = false } = {}) => {
  const response = await fetch(`${runnerUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token(scopes, method, path)}`,
      ...(body === undefined
        ? {}
        : { 'content-type': binary ? 'application/octet-stream' : 'application/json' })
    },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000)
  });
  const contentType = response.headers.get('content-type') ?? '';
  const value = contentType.includes('application/json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${
        Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value)
      }`
    );
  }
  return { response, value };
};

const check = (condition, label, details = '') => {
  if (!condition) throw new Error(`FAIL ${label}${details ? `: ${details}` : ''}`);
  console.log(`ok  ${label}${details ? ` - ${details}` : ''}`);
};

const root = `/v1/workspaces/${workspaceId}`;

const unauthenticated = await fetch(`${runnerUrl}${root}`, {
  method: 'PUT',
  signal: AbortSignal.timeout(10_000)
});
check(!unauthenticated.ok, 'runner rejects unauthenticated control');

let workspaceCreated = false;
let summary;
try {
  await request(root, { method: 'PUT', scopes: ['workspace.manage'] });
  workspaceCreated = true;
  check(true, 'persistent native workspace initialized');

  const exec = async (executable, args, options = {}) =>
    (
      await request(`${root}/exec`, {
        method: 'POST',
        scopes: options.scopes ?? ['exec'],
        body: {
          executable,
          args,
          cwd: 'workspace',
          env: {},
          timeoutSeconds: options.timeoutSeconds ?? 90,
          network: options.network ?? false,
          maxOutputBytes: 1024 * 1024
        }
      })
    ).value;

  const packageName = process.env.ATHANOR_DRILL_PACKAGE;
  if (packageName) {
    check(/^[a-z0-9][a-z0-9+.-]*$/i.test(packageName), 'package drill input is a package name');
    const installed = await exec('apt-get', ['install', '-y', packageName], {
      network: true,
      timeoutSeconds: 300,
      scopes: ['exec', 'system.packages']
    });
    check(installed.exitCode === 0, 'approved native system package installation', packageName);
  }

  // Every binary, Python module and font the built-in skills name, and the one interpreter they
  // name it through. A procedure that opens with "run build_deck.py" is confident and specific, so
  // a box missing python-pptx does not fail here - it fails in front of the owner, three shell
  // calls into a job they asked for. Kept as one list so a skill cannot quietly grow a requirement
  // the drill does not assert.
  const ATHANOR_PYTHON = '/usr/local/lib/athanor/python/bin/python3';
  const REQUIRED_BINARIES = [
    'garden-run',
    'athanor-office-convert',
    'athanor-pdf-tables',
    'dot',
    'ffmpeg',
    'ffprobe',
    'fc-list',
    'gs',
    'git',
    'img2pdf',
    'libreoffice',
    'magick',
    'ocrmypdf',
    'pdffonts',
    'pdfimages',
    'pdfinfo',
    'pdftoppm',
    'pdftotext',
    'qpdf',
    'soffice',
    'tesseract',
    'typst',
    'unzip',
    'xauth',
    'xdpyinfo',
    'xprop',
    'xrandr',
    'zip'
  ];
  const REQUIRED_MODULES = [
    'PIL',
    'docx',
    'matplotlib',
    'numpy',
    'openpyxl',
    'pandas',
    'pyarrow',
    'pptx',
    'pypdf',
    'scipy',
    'statsmodels'
  ];
  // Carlito and Caladea are the Calibri and Cambria metrics; the rest are what a typeset document
  // and a rendered slide fall back to, and a missing fallback is a silent substitution.
  const REQUIRED_FONTS = [
    'Carlito',
    'Caladea',
    'Liberation Sans',
    'Liberation Serif',
    'DejaVu Sans'
  ];

  const native = await exec('/bin/sh', [
    '-lc',
    [
      'set -eu',
      // athanor-agent, not athanor: an agent command runs as its own account, separate from the one
      // the runner itself runs as. This asserted the runner's account until the sandbox landed, and
      // then kept passing on nothing - `set -eu` makes a failed test exit silently, so the whole
      // toolchain check reported "exit=1" with neither stream to say why.
      'test "$(id -un)" = "athanor-agent"',
      `test -x ${ATHANOR_PYTHON}`,
      `for binary in ${REQUIRED_BINARIES.join(' ')}; do command -v "$binary" >/dev/null || { echo "missing binary: $binary" >&2; exit 1; }; done`,
      `for module in ${REQUIRED_MODULES.join(' ')}; do ${ATHANOR_PYTHON} -c "import $module" 2>/dev/null || { echo "missing python module: $module" >&2; exit 1; }; done`,
      `for font in ${REQUIRED_FONTS.map((font) => `'${font}'`).join(' ')}; do fc-list | grep -qi "$font" || { echo "missing font: $font" >&2; exit 1; }; done`,
      "printf 'durable-agent-computer\\n' > release-drill-state.txt",
      `printf 'user=%s python=%s libreoffice=%s typst=%s\\n' "$(id -un)" "$(${ATHANOR_PYTHON} --version 2>&1)" "$(libreoffice --version | head -n 1)" "$(typst --version)"`
    ].join('; ')
  ]);
  check(
    native.exitCode === 0,
    'document toolchain complete: every binary, module and font the skills name',
    [native.stdout.trim(), native.stderr.trim(), `exit=${native.exitCode}`]
      .filter(Boolean)
      .join(' | ')
  );

  // The toolchain being installed is not the same claim as the toolchain working. This builds a
  // one-page CV, a report, a deck, a workbook and a Word document in the workspace and measures the
  // files that come out - page counts, embedded fonts, recalculated values, words that survived the
  // render - and --require-all makes a job that cannot run for want of a tool a failure rather than
  // a note, because on this machine everything is meant to be there.
  const documents = await exec(
    ATHANOR_PYTHON,
    [
      '/usr/local/lib/athanor/athanor-document-proof',
      '--json',
      '--require-all',
      '--workdir',
      'document-proof'
    ],
    { timeoutSeconds: 900 }
  );
  let proof;
  try {
    proof = JSON.parse(documents.stdout);
  } catch {
    proof = undefined;
  }
  check(
    proof?.ok === true && proof.skipped.length === 0,
    'documents build and measure correctly: CV, report, deck, workbook, letter',
    proof
      ? [
          `passed: ${proof.passed.join(', ') || 'none'}`,
          ...proof.jobs
            .filter((job) => job.failure)
            .map((job) => `${job.id} failed: ${job.failure}`),
          ...(proof.skipped.length ? [`skipped: ${proof.skipped.join(', ')}`] : [])
        ].join(' | ')
      : [documents.stdout.trim(), documents.stderr.trim()].filter(Boolean).join(' | ').slice(0, 600)
  );

  const fileBody = Buffer.from('# Athanor release drill\n\nfile round-trip is healthy\n');
  const written = await request(`${root}/file?path=workspace/release-drill.md`, {
    method: 'PUT',
    scopes: ['files.write'],
    body: fileBody,
    binary: true
  });
  check(written.value.sizeBytes === fileBody.length, 'workspace file write');
  const read = await request(`${root}/file?path=workspace/release-drill.md`, {
    scopes: ['files.read']
  });
  check(
    Buffer.isBuffer(read.value) && read.value.equals(fileBody),
    'workspace file read and byte integrity'
  );
  const listing = await request(`${root}/files?path=workspace`, { scopes: ['files.read'] });
  check(
    listing.value.entries.some((entry) => entry.name === 'release-drill.md'),
    'workspace file listing'
  );

  const escape = await fetch(`${runnerUrl}${root}/file?path=../../etc/passwd`, {
    headers: { authorization: `Bearer ${token(['files.read'], 'GET', `${root}/file`)}` },
    signal: AbortSignal.timeout(10_000)
  });
  const escapeError = await escape.json();
  check(
    !escape.ok && escapeError.error?.message === 'Path escapes workspace',
    'workspace path traversal rejected by the filesystem boundary',
    escapeError.error?.message ?? 'missing rejection reason'
  );

  await request(`${root}/browser/action`, {
    method: 'POST',
    scopes: ['browser.control'],
    body: { type: 'navigate', url: 'https://example.com/' }
  });
  const browser = await request(`${root}/browser/snapshot`, {
    method: 'POST',
    scopes: ['browser.read'],
    body: {}
  });
  check(
    browser.value.title === 'Example Domain' &&
      browser.value.text.includes('Example Domain') &&
      Buffer.from(browser.value.screenshotBase64, 'base64').length > 5_000,
    'Chromium navigation, visual snapshot, and text extraction',
    browser.value.title
  );
  const parallel = await request(`${root}/browser/read-many`, {
    method: 'POST',
    scopes: ['browser.read'],
    body: {
      urls: ['https://example.com/', 'https://www.iana.org/help/example-domains'],
      maxCharactersPerPage: 4_000
    }
  });
  check(
    parallel.value.sources.filter((source) => !source.error).length === 2,
    'parallel public-web reading with SSRF controls'
  );

  await request(`${root}/desktop/launch`, {
    method: 'POST',
    scopes: ['desktop.control'],
    body: {
      executable: '/usr/lib/libreoffice/program/soffice',
      args: ['--writer', '--norestore'],
      cwd: 'workspace',
      env: { SAL_USE_VCLPLUGIN: 'gtk3' }
    }
  });
  let desktop;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    desktop = (
      await request(`${root}/desktop/snapshot`, {
        method: 'POST',
        scopes: ['desktop.read'],
        body: {}
      })
    ).value;
    // Waits for the accessibility tree, not just for a window: LibreOffice paints its frame before
    // it joins the accessibility bus, so stopping at the first window catches it mid-start.
    if (desktop.windows.length > 0 && desktop.mode === 'semantic_and_visual') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // 1440x900 is the ceiling the action contract puts on the agent's still, not the size of the
  // screen: a 1280x800 desktop is sent at 1280x800 and only a larger one is scaled down. Asserting
  // the ceiling as though it were the display passed on a machine with no desktop at all and failed
  // on the first real one. What matters is that the still is within the contract's bounds, that it
  // carries the whole display, and that the accessibility tree came back - a desktop the agent can
  // only photograph is a worse desktop than one it can read.
  check(
    desktop.available === true &&
      desktop.width <= 1440 &&
      desktop.height <= 900 &&
      desktop.displayWidth === 1280 &&
      desktop.displayHeight === 800 &&
      desktop.mode === 'semantic_and_visual' &&
      desktop.windows.length > 0 &&
      Buffer.from(desktop.screenshotBase64, 'base64').length > 5_000,
    'Linux GUI launch and visual desktop observation',
    `${desktop.mode}, ${desktop.windows.length} window(s), ${desktop.width}x${desktop.height} of ${desktop.displayWidth}x${desktop.displayHeight}, screenshot ${Buffer.from(desktop.screenshotBase64 ?? '', 'base64').length} bytes${desktop.message ? `, ${desktop.message}` : ''}`
  );

  const x11Denied = await exec('/usr/bin/python3', [
    '-c',
    `
import glob, os, subprocess
sockets = glob.glob('/tmp/.X11-unix/X*')
assert sockets, 'The live desktop must provide an X11 socket for the negative control'
for socket in sockets:
    display = socket.rsplit('X', 1)[-1]
    assert display.isdigit()
    result = subprocess.run(['/usr/bin/xdpyinfo', '-display', 'unix:' + display],
        env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','XAUTHORITY':'/dev/null'},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    assert result.returncode != 0, 'Agent command reached a desktop without authorization'
print('unauthorized X11 connections refused:', len(sockets))
`
  ]);
  check(
    x11Denied.exitCode === 0 &&
      /unauthorized X11 connections refused: [1-9]/.test(x11Denied.stdout),
    'agent commands cannot bypass desktop control through X11',
    x11Denied.stdout.trim() || x11Denied.stderr.trim()
  );

  const previewProcess = await request(`${root}/processes/start`, {
    method: 'POST',
    scopes: ['exec'],
    body: {
      executable: '/usr/bin/python3',
      args: ['-m', 'http.server', '8765', '--bind', '127.0.0.1'],
      cwd: 'workspace',
      env: {},
      timeoutSeconds: 300,
      network: false,
      maxOutputBytes: 1024 * 1024
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const previewCheck = await request(`${root}/preview-check/8765`, {
    scopes: ['preview:8765']
  });
  check(previewCheck.value.available === true, 'workspace preview port detection');
  const preview = await request(`${root}/preview/8765/release-drill.md`, {
    scopes: ['preview:8765']
  });
  check(
    Buffer.isBuffer(preview.value) && preview.value.toString('utf8').includes('file round-trip'),
    'workspace preview proxy'
  );
  await request(`${root}/processes/${previewProcess.value.sessionId}`, {
    method: 'POST',
    scopes: ['exec'],
    body: { action: 'kill' }
  });

  const usage = await request(`${root}/usage`, { scopes: ['files.read'] });
  check(usage.value.storageBytes > fileBody.length, 'workspace storage accounting');
  check(
    Number.isSafeInteger(usage.value.hostStorageTotalBytes) &&
      usage.value.hostStorageTotalBytes > 0 &&
      Number.isSafeInteger(usage.value.hostStorageAvailableBytes) &&
      usage.value.hostStorageAvailableBytes > 0 &&
      usage.value.hostStorageAvailableBytes <= usage.value.hostStorageTotalBytes,
    'real host storage capacity and headroom',
    `${Math.floor(usage.value.hostStorageAvailableBytes / 1024 ** 3)} GiB free`
  );

  const snapshotId = randomUUID();
  const recoveryStatePath = `${root}/file?path=workspace/recovery-state.txt`;
  const originalRecoveryState = Buffer.from('before recovery point\n');
  await request(recoveryStatePath, {
    method: 'PUT',
    scopes: ['files.write'],
    body: originalRecoveryState,
    binary: true
  });
  const snapshot = await request(`${root}/snapshots`, {
    method: 'POST',
    scopes: ['workspace.manage'],
    body: { snapshotId }
  });
  check(
    Number.isSafeInteger(snapshot.value.sizeBytes) && snapshot.value.sizeBytes > 0,
    'private server recovery archive created'
  );
  await request(recoveryStatePath, {
    method: 'PUT',
    scopes: ['files.write'],
    body: Buffer.from('after recovery point\n'),
    binary: true
  });
  await request(`${root}/snapshots/${snapshotId}/restore`, {
    method: 'POST',
    scopes: ['workspace.manage']
  });
  const restoredRecoveryState = await request(recoveryStatePath, {
    scopes: ['files.read']
  });
  check(
    Buffer.isBuffer(restoredRecoveryState.value) &&
      restoredRecoveryState.value.equals(originalRecoveryState),
    'recovery point restores workspace state byte-for-byte'
  );
  await request(`${root}/snapshots/${snapshotId}`, {
    method: 'DELETE',
    scopes: ['workspace.manage']
  });
  check(true, 'recovery archive cleanup');

  summary = JSON.stringify({
    ok: true,
    workspaceId,
    native: native.stdout.trim(),
    browserTitle: browser.value.title,
    desktopMode: desktop.mode,
    desktopWindows: desktop.windows.length,
    storageBytes: usage.value.storageBytes
  });
} finally {
  if (workspaceCreated && process.env.ATHANOR_DRILL_KEEP !== 'true') {
    await request(root, { method: 'DELETE', scopes: ['workspace.manage'] });
    check(true, 'release-drill workspace cleanup');
  }
}
console.log(summary);
