import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const root = await mkdtemp(path.join(os.tmpdir(), 'athanor-document-'));
// The formats a real person's folders fill up with, kept in their own directory so the counts the
// first folder asserts stay the counts it was written for.
const shelf = await mkdtemp(path.join(os.tmpdir(), 'athanor-shelf-'));
// Scans get a third one, because recognising a page costs seconds and a search that walked the
// whole shelf would pay them for every fixture above as well.
const scans = await mkdtemp(path.join(os.tmpdir(), 'athanor-scans-'));
const executable = path.resolve('scripts/athanor-document');

const runIn = (cwd, environment, ...args) =>
  spawnSync('/usr/bin/python3', [executable, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...environment }
  });
const run = (...args) => runIn(root, {}, ...args);

/**
 * Which halves of this proof actually executed.
 *
 * Two of the three sections below are behind an `existsSync` guard, because a developer's laptop
 * has no recogniser and keeps poppler somewhere other than where the installer puts it. The
 * closing line was printed outside both guards, so a host missing either one printed "checks
 * passed" having read no PDF and recognised no page - and no CI job installed those packages, so
 * that host was every runner this repository has ever used. A count is the smallest thing that
 * cannot say that.
 */
const SECTIONS = ['extraction and private search', 'PDF text layer', 'scanned-page OCR'];
const ran = new Set([SECTIONS[0]]);

/**
 * The shape `scripts/check-repository.mjs:115-120` settled for a tool that is optional here and
 * mandatory there: absent on a developer's machine is a note and the section is skipped, absent on
 * the runner that is supposed to be the floor is a failure. `.github/workflows/verify.yml` installs
 * these packages in the `application` job for exactly this reason.
 */
const sectionRuns = (section, present, packages) => {
  if (present) {
    ran.add(section);
    return true;
  }
  if (process.env.GITHUB_ACTIONS)
    assert.fail(
      `${packages} is not installed on this CI runner, so the ${section} checks cannot run`
    );
  process.stdout.write(
    `  ${packages} is not installed here, so the ${section} checks were skipped\n`
  );
  return false;
};

const crc32 = (data) => {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};

/**
 * A zip written by hand, because both an .epub and a .docx are one and neither test may depend on
 * a library that only the provisioned computer has. Stored entries only: what is being proven is
 * the reading order and the extraction, not inflate.
 */
const writeZip = async (file, members) => {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, body] of Object.entries(members)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(body, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc >>> 0, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    directory.push(header, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(file, Buffer.concat([...parts, central, end]));
};

const FREE_SECTOR = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;

/**
 * A compound file written by hand, for the same reason the zip above is: an Outlook .msg is one,
 * and no library that writes one is on a developer's machine or allowed to be a dependency of this
 * test. Members are a tree of `{ name, kind, body, children }`, kind 1 being a storage and kind 2 a
 * stream, which is exactly the shape a message has - fields at the top, an attachment inside a
 * storage of its own.
 *
 * Both halves of how a compound file stores a stream are exercised: anything under the four
 * kilobyte cutoff goes into the mini stream through a table of its own, and anything at or above it
 * takes whole sectors, which is where the body of a long message actually lands.
 */
const writeCompoundFile = async (file, members) => {
  const entries = [
    { name: 'Root Entry', kind: 5, left: FREE_SECTOR, right: FREE_SECTOR, child: FREE_SECTOR }
  ];
  const attach = (parent, list) => {
    const indices = list.map((member) => {
      entries.push({ ...member, left: FREE_SECTOR, right: FREE_SECTOR, child: FREE_SECTOR });
      return entries.length - 1;
    });
    entries[parent].child = indices[0] ?? FREE_SECTOR;
    for (const [order, index] of indices.entries())
      entries[index].right = order + 1 < indices.length ? indices[order + 1] : FREE_SECTOR;
    for (const [order, member] of list.entries())
      if (member.children) attach(indices[order], member.children);
  };
  attach(0, members);

  const mini = [];
  let miniLength = 0;
  for (const entry of entries.slice(1)) {
    entry.start = FREE_SECTOR;
    entry.size = entry.kind === 2 ? entry.body.length : 0;
    if (entry.kind !== 2 || entry.body.length >= 4096) continue;
    const padded = Buffer.alloc(Math.ceil(entry.body.length / 64) * 64);
    entry.body.copy(padded);
    entry.start = miniLength / 64;
    mini.push(padded);
    miniLength += padded.length;
  }
  const miniStream = Buffer.concat(mini);
  const directorySectors = Math.ceil(entries.length / 4);
  const miniFatSectors = Math.max(1, Math.ceil(((miniStream.length / 64) * 4) / 512));
  const miniStreamSectors = Math.ceil(miniStream.length / 512);
  const directoryStart = 1;
  const miniFatStart = directoryStart + directorySectors;
  const miniStreamStart = miniFatStart + miniFatSectors;

  const fat = Buffer.alloc(512, 0xff);
  const chain = (from, count) => {
    for (let index = 0; index < count; index += 1)
      fat.writeUInt32LE(index === count - 1 ? END_OF_CHAIN : from + index + 1, (from + index) * 4);
  };
  fat.writeUInt32LE(FAT_SECTOR, 0);
  chain(directoryStart, directorySectors);
  chain(miniFatStart, miniFatSectors);
  chain(miniStreamStart, miniStreamSectors);

  const sectored = [];
  let next = miniStreamStart + miniStreamSectors;
  for (const entry of entries.slice(1)) {
    if (entry.kind !== 2 || entry.body.length < 4096) continue;
    const count = Math.ceil(entry.body.length / 512);
    entry.start = next;
    chain(next, count);
    sectored.push({ at: next, body: entry.body });
    next += count;
  }

  const miniFat = Buffer.alloc(miniFatSectors * 512, 0xff);
  let allocated = 0;
  for (const padded of mini) {
    const count = padded.length / 64;
    for (let index = 0; index < count; index += 1)
      miniFat.writeUInt32LE(
        index === count - 1 ? END_OF_CHAIN : allocated + index + 1,
        (allocated + index) * 4
      );
    allocated += count;
  }

  const directory = Buffer.alloc(directorySectors * 512, 0);
  for (const [index, entry] of entries.entries()) {
    const offset = index * 128;
    const encoded = Buffer.from(`${entry.name}\0`, 'utf16le');
    encoded.copy(directory, offset);
    directory.writeUInt16LE(encoded.length, offset + 64);
    directory.writeUInt8(entry.kind, offset + 66);
    directory.writeUInt8(1, offset + 67);
    directory.writeUInt32LE(entry.left, offset + 68);
    directory.writeUInt32LE(entry.right, offset + 72);
    directory.writeUInt32LE(entry.child, offset + 76);
    directory.writeUInt32LE(index === 0 ? miniStreamStart : entry.start, offset + 116);
    directory.writeUInt32LE(index === 0 ? miniStream.length : entry.size, offset + 120);
  }

  const header = Buffer.alloc(512, 0);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(directoryStart, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(END_OF_CHAIN, 68);
  for (let index = 0; index < 109; index += 1)
    header.writeUInt32LE(index === 0 ? 0 : FREE_SECTOR, 76 + index * 4);

  const sectors = Buffer.alloc(next * 512, 0);
  fat.copy(sectors, 0);
  directory.copy(sectors, directoryStart * 512);
  miniFat.copy(sectors, miniFatStart * 512);
  miniStream.copy(sectors, miniStreamStart * 512);
  for (const { at, body } of sectored) body.copy(sectors, at * 512);
  await writeFile(file, Buffer.concat([header, sectors]));
};

/** One MAPI property, named by the tag Outlook stores it under and stored as UTF-16. */
const messageProperty = (tag, text) => ({
  name: `__substg1.0_${tag}001F`,
  kind: 2,
  body: Buffer.from(text, 'utf16le')
});

/** A PDF assembled from numbered objects, with the cross-reference table poppler expects. */
const writePdf = async (file, objects) => {
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let offset = parts[0].length;
  for (const object of objects) {
    offsets.push(offset);
    parts.push(object);
    offset += object.length;
  }
  const table = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (const at of offsets) table.push(`${String(at).padStart(10, '0')} 00000 n \n`);
  parts.push(
    Buffer.from(
      `${table.join('')}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${offset}\n%%EOF\n`
    )
  );
  await writeFile(file, Buffer.concat(parts));
};

/**
 * A scan: one page rendered to a picture and wrapped in a PDF that carries no text at all, which is
 * what a contract that went through a scanner actually is. It is built by rendering a PDF that does
 * have text and then throwing the text away, because a fixture that only looks like a scan proves
 * nothing about reading one - the words have to survive as pixels and come back through recognition.
 */
const writeScannedPdf = async (rasteriser, source, destination, mixed = false) => {
  const prefix = path.join(path.dirname(destination), 'rendered');
  const dpi = 200;
  const rendered = spawnSync(
    rasteriser,
    ['-gray', '-r', String(dpi), '-f', '1', '-l', '1', '-singlefile', source, prefix],
    { encoding: 'buffer' }
  );
  assert.equal(rendered.status, 0, String(rendered.stderr));
  const grey = readFileSync(`${prefix}.pgm`);
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(grey.subarray(0, 64).toString('latin1'));
  assert.ok(header, 'the rasteriser did not write the greyscale page this fixture expects');
  const [matched, width, height] = header;
  const image = zlib.deflateSync(grey.subarray(matched.length));
  const across = Math.round((Number(width) * 72) / dpi);
  const down = Math.round((Number(height) * 72) / dpi);
  const content = `q ${across} 0 0 ${down} 0 0 cm /Im0 Do Q`;
  await writePdf(destination, [
    Buffer.from('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'),
    Buffer.from(
      mixed
        ? '2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj\n'
        : '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    ),
    Buffer.from(
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${across} ${down}]` +
        '/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>endobj\n'
    ),
    Buffer.from(`4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`),
    Buffer.concat([
      Buffer.from(
        `5 0 obj<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}` +
          '/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode' +
          `/Length ${image.length}>>stream\n`
      ),
      image,
      Buffer.from('\nendstream endobj\n')
    ]),
    ...(mixed
      ? [
          Buffer.from(
            '6 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 8 0 R>>>>/Contents 7 0 R>>endobj\n'
          ),
          Buffer.from(
            '7 0 obj<</Length 79>>stream\nBT /F1 12 Tf 60 700 Td (Exact native text: ACCT-0029 and 0.000314159265358979) Tj ET\nendstream endobj\n'
          ),
          Buffer.from('8 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n')
        ]
      : [])
  ]);
  await rm(`${prefix}.pgm`, { force: true });
};

try {
  await writeFile(
    path.join(root, 'notes.txt'),
    'Athanor keeps the computer persistent.\n\nBioinformatics results stay on the server.\n'
  );
  await writeFile(
    path.join(root, 'report.html'),
    '<h1>Report</h1><p>Alpha beta finding</p><script>secret noise</script>'
  );
  await writeFile(path.join(root, 'table.csv'), 'sample,value\ncontrol,7\n');
  await writeFile(
    path.join(root, 'generic.txt'),
    `${'server status '.repeat(100)}\nNo scientific analysis appears here.\n`
  );

  const read = run('read', '--path', 'report.html');
  assert.equal(read.status, 0, read.stderr);
  const readPayload = JSON.parse(read.stdout);
  assert.match(readPayload.text, /Alpha beta finding/);
  assert.doesNotMatch(readPayload.text, /secret noise/);

  const search = run('search', '--path', '.', '--query', 'bioinformatics server');
  assert.equal(search.status, 0, search.stderr);
  const searchPayload = JSON.parse(search.stdout);
  assert.equal(searchPayload.results[0].path, 'notes.txt');
  assert.match(searchPayload.results[0].excerpt, /Bioinformatics/);
  assert.match(searchPayload.method, /BM25/);
  assert.equal(searchPayload.filesConsidered, 4);

  // A folder of real documents will always contain something no parser can open, and the
  // extractors reach into third-party libraries that raise their own exception types. One such
  // file must cost the owner that file and nothing else - never the whole search.
  await writeFile(path.join(root, 'broken.xlsx'), 'this is not a workbook');
  const withBroken = run('search', '--path', '.', '--query', 'bioinformatics server');
  assert.equal(withBroken.status, 0, withBroken.stderr);
  const brokenPayload = JSON.parse(withBroken.stdout);
  assert.equal(brokenPayload.results[0].path, 'notes.txt');
  assert.equal(brokenPayload.filesConsidered, 5);
  assert.equal(brokenPayload.filesSkipped, 1);

  const largeFolder = path.join(root, 'large-folder');
  await mkdir(largeFolder);
  await Promise.all(
    Array.from({ length: 501 }, (_, i) =>
      writeFile(
        path.join(largeFolder, `${String(i).padStart(4, '0')}.txt`),
        i === 500 ? 'Hiddenquartz only appears beyond the first page.' : 'Ordinary unrelated text.'
      )
    )
  );
  const firstPage = runIn(largeFolder, {}, 'search', '--query', 'Hiddenquartz');
  assert.equal(firstPage.status, 0, firstPage.stderr);
  const limited = JSON.parse(firstPage.stdout);
  assert.equal(limited.filesConsidered, 500);
  assert.deepEqual(limited.results, []);
  assert.equal(limited.coverage.hasMore, true);
  assert.equal(limited.coverage.nextFileOffset, 500);
  assert.match(limited.note, /incomplete/);
  const lastPage = runIn(
    largeFolder,
    {},
    'search',
    '--query',
    'Hiddenquartz',
    '--file-offset',
    String(limited.coverage.nextFileOffset)
  );
  assert.equal(lastPage.status, 0, lastPage.stderr);
  const continued = JSON.parse(lastPage.stdout);
  assert.equal(continued.results.length, 1);
  assert.equal(continued.results[0].path, '0500.txt');
  assert.equal(continued.coverage.hasMore, false);
  assert.equal(continued.coverage.nextFileOffset, null);
  const exact = runIn(largeFolder, {}, 'search', '--query', 'Hiddenquartz', '--max-files', '501');
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(JSON.parse(exact.stdout).coverage.hasMore, false);
  await rm(largeFolder, { recursive: true });

  const variantsFolder = path.join(root, 'terminology');
  await mkdir(variantsFolder);
  await writeFile(
    path.join(variantsFolder, 'clinical.txt'),
    'Myocardial infarction was confirmed in the discharge note.'
  );
  await writeFile(
    path.join(variantsFolder, 'abbreviation.txt'),
    'The ECG recording is attached to the clinical archive.'
  );
  await writeFile(
    path.join(variantsFolder, 'unrelated.txt'),
    'The storage warranty expires next year.'
  );
  const plain = runIn(variantsFolder, {}, 'search', '--query', 'heart attack');
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(JSON.parse(plain.stdout).results, []);
  const expanded = runIn(
    variantsFolder,
    {},
    'search',
    '--query',
    'heart attack',
    '--alternative=myocardial infarction',
    '--alternative=ECG'
  );
  assert.equal(expanded.status, 0, expanded.stderr);
  const expandedPayload = JSON.parse(expanded.stdout);
  assert.equal(expandedPayload.filesConsidered, 3);
  assert.equal(expandedPayload.coverage.hasMore, false);
  assert.deepEqual(expandedPayload.queries, ['heart attack', 'myocardial infarction', 'ECG']);
  assert.equal(expandedPayload.results.length, 2);
  assert.deepEqual(
    expandedPayload.results.find((hit) => hit.path === 'clinical.txt').matchedQueries,
    ['myocardial infarction']
  );
  assert.deepEqual(
    expandedPayload.results.find((hit) => hit.path === 'abbreviation.txt').matchedQueries,
    ['ECG']
  );
  const repeated = runIn(
    variantsFolder,
    {},
    'search',
    '--query',
    'heart attack',
    '--alternative=myocardial infarction',
    '--alternative=ECG',
    '--alternative=ECG'
  );
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).results, expandedPayload.results);
  for (const invalid of [
    Array(5).fill('--alternative=ECG'),
    ['--alternative=!!!'],
    ['--alternative=' + 'x'.repeat(501)]
  ]) {
    assert.notEqual(
      runIn(variantsFolder, {}, 'search', '--query', 'heart attack', ...invalid).status,
      0
    );
  }
  await rm(variantsFolder, { recursive: true });

  const empty = run('search', '--path', '.', '--query', '!!!');
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /at least one word/);

  const escape = run('read', '--path', '../outside.txt');
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /inside the current workspace/);

  // The shelf: the formats that accumulate in a real person's folders. Every one of these used to
  // be absent from every answer, because the extension was not in SUPPORTED and the walk never
  // stopped at the file at all.
  await writeZip(path.join(shelf, 'field-guide.epub'), {
    'META-INF/container.xml':
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    // The spine names the chapters in reading order and the file names contradict it, which is
    // what an e-book converted from anything actually looks like. A percent-encoded href is the
    // other half: it is a URL, not a member name.
    'OEBPS/content.opf':
      '<package><manifest><item id="two" href="aa-part0002.xhtml"/>' +
      '<item id="one" href="zz%20chapter%20one.xhtml"/></manifest>' +
      '<spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    'OEBPS/zz chapter one.xhtml':
      '<html><body><h1>Chapter One</h1><p>The keeper counted herring.</p></body></html>',
    'OEBPS/aa-part0002.xhtml': '<html><body><p>Chapter two weighs the catch.</p></body></html>'
  });
  await writeFile(
    path.join(shelf, 'renewal.eml'),
    [
      'From: =?utf-8?q?Jos=C3=A9_Ram=C3=ADrez?= <jose@example.org>',
      'To: owner@example.org',
      'Subject: Lease renewal',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'The herring quota survives=20until March.',
      ''
    ].join('\n')
  );
  // A forwarded Outlook message, which is an ordinary thing to have in a folder. The fields are
  // where a real one keeps them, in streams named after the property each holds.
  await writeCompoundFile(path.join(shelf, 'forwarded.msg'), [
    messageProperty('0C1A', 'José Ramírez'),
    messageProperty('0C1F', 'jose@example.org'),
    messageProperty('0E04', 'owner@example.org'),
    messageProperty('0037', 'Lease renewal'),
    messageProperty('007D', 'Date: Tue, 4 Mar 2025 09:12:00 +0000\r\nSubject: Lease renewal\r\n'),
    messageProperty(
      '1000',
      'The herring quota survives until March.\r\nSigned, the harbour office.'
    ),
    {
      name: '__attach_version1.0_#00000000',
      kind: 1,
      children: [messageProperty('3707', 'quota-2025.pdf')]
    }
  ]);
  // The same again with a body over the four kilobyte cutoff, because that one is not in the mini
  // stream at all - it is in sectors of its own, which is the other half of the format and the half
  // every long message lands in.
  await writeCompoundFile(path.join(shelf, 'long-thread.msg'), [
    messageProperty('0037', 'Re: quota, again'),
    messageProperty('1000', `${'The herring quota was discussed at length. '.repeat(120)}`)
  ]);
  // Eight bytes that start like a compound file and are not one. Reading a format is not licence to
  // hand back a plausible-looking half of a message, so this is still refused, by this file rather
  // than by its extension, with the sentence the owner can act on.
  await writeFile(path.join(shelf, 'archived.msg'), Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  // The mail parser accepts anything - hand it a zip and it returns a message with no headers whose
  // body is the whole file decoded with replacements. That is the same mojibake .msg is refused
  // for, so it has to be refused the same way rather than indexed as prose.
  await writeZip(path.join(shelf, 'not-really.eml'), { 'a.txt': 'herring' });

  const book = runIn(shelf, {}, 'read', '--path', 'field-guide.epub');
  assert.equal(book.status, 0, book.stderr);
  const bookText = JSON.parse(book.stdout).text;
  assert.match(bookText, /Chapter One/);
  assert.ok(
    bookText.indexOf('keeper counted herring') < bookText.indexOf('weighs the catch'),
    'the book was read in file order rather than in the order its spine declares'
  );

  const mail = runIn(shelf, {}, 'read', '--path', 'renewal.eml');
  assert.equal(mail.status, 0, mail.stderr);
  const mailPayload = JSON.parse(mail.stdout);
  assert.match(mailPayload.text, /From: José Ramírez/);
  assert.match(mailPayload.text, /Subject: Lease renewal/);
  assert.match(mailPayload.text, /The herring quota survives until March\./);

  const forwarded = runIn(shelf, {}, 'read', '--path', 'forwarded.msg');
  assert.equal(forwarded.status, 0, forwarded.stderr);
  const forwardedPayload = JSON.parse(forwarded.stdout);
  // Shaped exactly like the saved .eml above: the owner cannot tell which client saved which.
  assert.match(forwardedPayload.text, /From: José Ramírez <jose@example\.org>/);
  assert.match(forwardedPayload.text, /To: owner@example\.org/);
  assert.match(forwardedPayload.text, /Date: Tue, 04 Mar 2025 09:12:00 \+0000/);
  assert.match(forwardedPayload.text, /Subject: Lease renewal/);
  assert.match(forwardedPayload.text, /The herring quota survives until March\./);
  assert.match(forwardedPayload.text, /\[1 attachment: quota-2025\.pdf\]/);

  const thread = runIn(shelf, {}, 'read', '--path', 'long-thread.msg');
  assert.equal(thread.status, 0, thread.stderr);
  const threadPayload = JSON.parse(thread.stdout);
  assert.ok(
    threadPayload.characters > 4_000,
    'a message body too large for the mini stream came back short'
  );
  assert.match(threadPayload.text, /Subject: Re: quota, again/);

  const outlook = runIn(shelf, {}, 'read', '--path', 'archived.msg');
  assert.notEqual(outlook.status, 0);
  assert.match(outlook.stderr, /not one that can be opened here/);
  assert.match(outlook.stderr, /\.eml/);

  const notMail = runIn(shelf, {}, 'read', '--path', 'not-really.eml');
  assert.notEqual(notMail.status, 0, 'a zip named .eml was decoded into text rather than refused');
  assert.match(notMail.stderr, /none of the headers/);

  const shelfSearch = runIn(shelf, {}, 'search', '--path', '.', '--query', 'herring');
  assert.equal(shelfSearch.status, 0, shelfSearch.stderr);
  const shelfPayload = JSON.parse(shelfSearch.stdout);
  assert.deepEqual([...new Set(shelfPayload.results.map((result) => result.path))].sort(), [
    'field-guide.epub',
    'forwarded.msg',
    'long-thread.msg',
    'renewal.eml'
  ]);
  // The honesty half. A file that could not be read is named with the reason, and the answer
  // carries the sentence that stops "nothing matched" being reported as the whole truth.
  assert.equal(shelfPayload.filesUnread, 2);
  assert.deepEqual(shelfPayload.unread.map((entry) => entry.path).sort(), [
    'archived.msg',
    'not-really.eml'
  ]);
  assert.match(
    shelfPayload.unread.find((entry) => entry.path === 'archived.msg').reason,
    /not one that can be opened here/
  );
  assert.match(shelfPayload.note, /could not be read as text/);

  // A pre-2007 Office file is read by converting it first. The converter is driven through a stub
  // here, so what is proven is this reader's half - that a .doc is offered to it at all, and that
  // the modern file it writes is extracted - without a 400 MB office suite in the loop.
  await writeZip(path.join(shelf, 'converted.docx'), {
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>' +
      'The 2009 minutes record a herring quota.</w:t></w:r></w:p></w:body></w:document>'
  });
  const converter = path.join(shelf, 'stub-convert');
  await writeFile(
    converter,
    [
      '#!/bin/sh',
      'case "$2" in',
      '  *.docx) cp "$ATHANOR_STUB_DOCX" "$2" ;;',
      '  *) exit 1 ;;',
      'esac',
      ''
    ].join('\n')
  );
  await chmod(converter, 0o755);
  await writeFile(path.join(shelf, 'minutes.doc'), Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const legacy = runIn(
    shelf,
    { ATHANOR_OFFICE_CONVERT: converter, ATHANOR_STUB_DOCX: path.join(shelf, 'converted.docx') },
    'read',
    '--path',
    'minutes.doc'
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(JSON.parse(legacy.stdout).text, /2009 minutes record a herring quota/);

  // No converter is not the same as a corrupt file, and the difference is the only thing the owner
  // can act on: one of them is a package they can install.
  const unconverted = runIn(
    shelf,
    { ATHANOR_OFFICE_CONVERT: path.join(shelf, 'no-such-converter') },
    'read',
    '--path',
    'minutes.doc'
  );
  assert.notEqual(unconverted.status, 0);
  assert.match(unconverted.stderr, /libreoffice-writer/);

  // Where the tools this reader runs actually are. A provisioned computer keeps every one of them
  // at the path named here; a developer's machine keeps poppler somewhere else and has no
  // recogniser at all, and the overrides are what let it run the same proof rather than skip it.
  //
  // Falling back to the search path is what makes that true without anyone being told to export
  // three variables first. Held to the same rule the reader holds itself to - an absolute path in
  // the end, never a name resolved at the moment it is run - so what the proof exercises is the
  // same thing the reader would execute.
  const whereIs = (tool, installed) => {
    if (existsSync(installed)) return installed;
    const found = spawnSync('/usr/bin/which', [tool], { encoding: 'utf8' });
    const candidate = found.status === 0 ? found.stdout.trim() : '';
    return candidate && existsSync(candidate) ? candidate : installed;
  };
  const poppler = {
    ATHANOR_PDFTOTEXT: process.env.ATHANOR_PDFTOTEXT ?? whereIs('pdftotext', '/usr/bin/pdftotext'),
    ATHANOR_PDFIMAGES: process.env.ATHANOR_PDFIMAGES ?? whereIs('pdfimages', '/usr/bin/pdfimages'),
    ATHANOR_PDFINFO: process.env.ATHANOR_PDFINFO ?? whereIs('pdfinfo', '/usr/bin/pdfinfo'),
    ATHANOR_PDFTOPPM: process.env.ATHANOR_PDFTOPPM ?? whereIs('pdftoppm', '/usr/bin/pdftoppm')
  };
  const recogniser = process.env.ATHANOR_TESSERACT ?? whereIs('tesseract', '/usr/bin/tesseract');
  const unrecognised = { ...poppler, ATHANOR_TESSERACT: path.join(scans, 'no-recogniser') };
  // One page of a lease with a real text layer. Used twice: as the document that must not be
  // recognised, and as the source the scan below is rendered from and then stripped of its text.
  const leasePage = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
      '/Resources<</Font<</F1 20 0 R>>>>/Contents 10 0 R>>endobj',
    '10 0 obj<</Length 205>>stream',
    'BT /F1 28 Tf 60 700 Td (LEASE AGREEMENT) Tj ET',
    'BT /F1 22 Tf 60 640 Td (Clause 14. Termination for convenience.) Tj ET',
    'BT /F1 22 Tf 60 600 Td (Either party may terminate on ninety days notice.) Tj ET',
    'endstream',
    'endobj',
    '20 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R/Size 21>>',
    '%%EOF',
    ''
  ].join('\n');

  if (
    sectionRuns(
      SECTIONS[1],
      existsSync(poppler.ATHANOR_PDFTOTEXT) && existsSync(poppler.ATHANOR_PDFINFO),
      'poppler-utils'
    )
  ) {
    // Short text without image content must stay searchable and must not invoke OCR.
    const pages = 3;
    const kids = Array.from({ length: pages }, (unused, index) => `${index + 3} 0 R`).join(' ');
    await writeFile(
      path.join(scans, 'stamped-lease.pdf'),
      [
        '%PDF-1.4',
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
        `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj`,
        ...Array.from(
          { length: pages },
          (unused, index) =>
            `${index + 3} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
            '/Resources<</Font<</F1 20 0 R>>>>/Contents 10 0 R>>endobj'
        ),
        '10 0 obj<</Length 46>>stream',
        'BT /F1 12 Tf 72 720 Td (Exhibit A) Tj ET',
        'endstream',
        'endobj',
        '20 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
        `trailer<</Root 1 0 R/Size ${pages + 3}>>`,
        '%%EOF',
        ''
      ].join('\n')
    );
    const scan = runIn(scans, unrecognised, 'read', '--path', 'stamped-lease.pdf');
    assert.equal(scan.status, 0, scan.stderr);
    const scanPayload = JSON.parse(scan.stdout);
    assert.ok(scanPayload.characters > 0 && scanPayload.characters < 64);
    assert.equal(scanPayload.note, undefined);
    const clause = runIn(scans, unrecognised, 'search', '--path', '.', '--query', 'exhibit');
    assert.equal(clause.status, 0, clause.stderr);
    const clausePayload = JSON.parse(clause.stdout);
    assert.ok(clausePayload.results.some((entry) => entry.path === 'stamped-lease.pdf'));
    assert.equal(clausePayload.filesUnread, 0);

    // Twenty-two pages of pictures, read through stubs standing in for the rasteriser and the
    // recogniser. What is proven here is the accounting rather than the recognition: that a long
    // scan stops at the ceiling one reading allows and names the pages it did not reach, instead of
    // running for an hour or returning twenty pages as though they were the document.
    const many = 22;
    await writeFile(
      path.join(scans, 'long-scan.pdf'),
      [
        '%PDF-1.4',
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
        `2 0 obj<</Type/Pages/Kids[${Array.from({ length: many }, (unused, index) => `${index + 3} 0 R`).join(' ')}]/Count ${many}>>endobj`,
        ...Array.from(
          { length: many },
          (unused, index) =>
            `${index + 3} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj`
        ),
        `trailer<</Root 1 0 R/Size ${many + 3}>>`,
        '%%EOF',
        ''
      ].join('\n')
    );
    const stubRasteriser = path.join(scans, 'stub-render');
    // Records that a page was asked for at all, then writes the image pdftoppm would have written
    // under the last name it was given.
    await writeFile(
      stubRasteriser,
      [
        '#!/bin/sh',
        'echo rendered >> "$ATHANOR_STUB_RENDERED"',
        'for last; do :; done',
        ': > "$last.png"',
        ''
      ].join('\n')
    );
    await chmod(stubRasteriser, 0o755);
    const stubRecogniser = path.join(scans, 'stub-recognise');
    await writeFile(
      stubRecogniser,
      ['#!/bin/sh', 'echo "The termination clause appears on this page."', ''].join('\n')
    );
    await chmod(stubRecogniser, 0o755);
    const bounded = runIn(
      scans,
      {
        ...poppler,
        ATHANOR_PDFIMAGES: path.join(scans, 'no-inspector'),
        ATHANOR_PDFTOPPM: stubRasteriser,
        ATHANOR_TESSERACT: stubRecogniser,
        ATHANOR_STUB_RENDERED: path.join(scans, 'rendered-long-scan')
      },
      'read',
      '--path',
      'long-scan.pdf',
      '--end-page',
      '25'
    );
    assert.equal(bounded.status, 0, bounded.stderr);
    const boundedPayload = JSON.parse(bounded.stdout);
    assert.equal(boundedPayload.extractor, 'OCR');
    assert.match(boundedPayload.recognitionNote, /Read by OCR/);
    assert.match(
      boundedPayload.note,
      /2 image pages were not recognised, because one reading recognises at most 20 pages/
    );

    // The same scan through a search, where the line above cannot be relied on to arrive. A search
    // hands back three excerpts chosen by score and that line is on the last page it recognised,
    // which has no reason to be one of the three - so a stack of long scans read half way through
    // would come back looking complete, and the owner would conclude a clause is not in a document
    // this never finished looking at. It is a fact about the reading, so it travels beside it.
    const half = runIn(
      scans,
      {
        ...poppler,
        ATHANOR_PDFIMAGES: path.join(scans, 'no-inspector'),
        ATHANOR_PDFTOPPM: stubRasteriser,
        ATHANOR_TESSERACT: stubRecogniser,
        ATHANOR_STUB_RENDERED: path.join(scans, 'rendered-half-scan')
      },
      'search',
      '--path',
      'long-scan.pdf',
      '--query',
      'termination clause'
    );
    assert.equal(half.status, 0, half.stderr);
    const halfPayload = JSON.parse(half.stdout);
    assert.ok(halfPayload.results.length > 0, 'the pages that were recognised did not match');
    assert.equal(halfPayload.filesUnread, 0, 'a scan that was read is being called unreadable');
    assert.deepEqual(halfPayload.partiallyRead, [
      {
        path: 'long-scan.pdf',
        reason: '2 image pages were not recognised, because one reading recognises at most 20 pages'
      }
    ]);
    assert.match(halfPayload.note, /read only as far as this search got through it/);

    // And a scan read to the end says nothing of the kind, so the sentence means something.
    const whole = runIn(
      scans,
      {
        ...poppler,
        ATHANOR_PDFIMAGES: path.join(scans, 'no-inspector'),
        ATHANOR_PDFTOPPM: stubRasteriser,
        ATHANOR_TESSERACT: stubRecogniser,
        ATHANOR_STUB_RENDERED: path.join(scans, 'rendered-whole-scan')
      },
      'search',
      '--path',
      'stamped-lease.pdf',
      '--query',
      'exhibit'
    );
    assert.equal(whole.status, 0, whole.stderr);
    assert.equal(JSON.parse(whole.stdout).partiallyRead, undefined);

    // The other half of the trade, and the half that costs the owner minutes when it is wrong: a
    // PDF that carries its own text is never rasterised and read back, because that is time spent
    // replacing exact characters with recognised ones. Proven by the rasteriser never being asked
    // for a page, rather than by the text coming back right - it would come back right either way,
    // and what is wrong in that case is the minutes, not the words.
    await writeFile(path.join(scans, 'readable-lease.pdf'), leasePage);
    const marker = path.join(scans, 'rendered-readable-lease');
    const untouched = runIn(
      scans,
      {
        ...poppler,
        ATHANOR_PDFIMAGES: path.join(scans, 'no-inspector'),
        ATHANOR_PDFTOPPM: stubRasteriser,
        ATHANOR_TESSERACT: stubRecogniser,
        ATHANOR_STUB_RENDERED: marker
      },
      'read',
      '--path',
      'readable-lease.pdf'
    );
    assert.equal(untouched.status, 0, untouched.stderr);
    const untouchedPayload = JSON.parse(untouched.stdout);
    assert.match(untouchedPayload.text, /Termination for convenience/);
    assert.equal(untouchedPayload.extractor, null);
    assert.ok(
      !existsSync(marker),
      'a PDF that carries its own text was rasterised and recognised anyway'
    );

    // The whole thing, end to end, on a computer that has the recogniser the installer puts there.
    // The fixture is a real scan: the words are rendered to pixels and the text layer thrown away,
    // so nothing but recognition can get them back.
    if (
      sectionRuns(
        SECTIONS[2],
        existsSync(poppler.ATHANOR_PDFTOPPM) && existsSync(recogniser),
        'poppler-utils and tesseract-ocr'
      )
    ) {
      const contracts = path.join(scans, 'contracts');
      await mkdir(contracts, { recursive: true });
      await writeFile(path.join(scans, 'source-page.pdf'), leasePage);
      await writeScannedPdf(
        poppler.ATHANOR_PDFTOPPM,
        path.join(scans, 'source-page.pdf'),
        path.join(contracts, 'lease-scan.pdf')
      );

      const before = runIn(contracts, unrecognised, 'read', '--path', 'lease-scan.pdf');
      assert.equal(before.status, 0, before.stderr);
      const beforePayload = JSON.parse(before.stdout);
      assert.equal(
        beforePayload.characters,
        0,
        'the fixture is not a scan at all: it came back carrying text'
      );
      assert.match(beforePayload.note, /no text was extracted/);

      const reading = { ...poppler, ATHANOR_TESSERACT: recogniser };
      const after = runIn(contracts, reading, 'read', '--path', 'lease-scan.pdf');
      assert.equal(after.status, 0, after.stderr);
      const afterPayload = JSON.parse(after.stdout);
      assert.match(afterPayload.text, /Termination for convenience/i);
      // Which text this is, said in the payload and again in the text itself, because a figure read
      // off a picture is wrong in ways a figure copied out of a document cannot be.
      assert.equal(afterPayload.extractor, 'OCR');
      assert.match(afterPayload.recognitionNote, /Read by OCR/);
      assert.equal(
        afterPayload.note,
        undefined,
        'a scan that was read is still being reported as unreadable'
      );

      await writeScannedPdf(
        poppler.ATHANOR_PDFTOPPM,
        path.join(scans, 'source-page.pdf'),
        path.join(contracts, 'mixed.pdf'),
        true
      );
      const mixed = runIn(contracts, reading, 'read', '--path', 'mixed.pdf');
      assert.equal(mixed.status, 0, mixed.stderr);
      const mixedPayload = JSON.parse(mixed.stdout);
      assert.equal(mixedPayload.pages, 2);
      assert.deepEqual(mixedPayload.recognisedPages, [1]);
      assert.match(mixedPayload.text.split('\f')[0], /Termination for convenience/i);
      assert.equal(
        mixedPayload.text.split('\f')[1],
        'Exact native text: ACCT-0029 and 0.000314159265358979'
      );
      const exact = runIn(
        contracts,
        reading,
        'search',
        '--path',
        'mixed.pdf',
        '--query',
        'ACCT-0029'
      );
      assert.equal(exact.status, 0, exact.stderr);
      assert.equal(JSON.parse(exact.stdout).results[0].page, 2);
      assert.equal(JSON.parse(exact.stdout).results[0].extractor, undefined);

      const found = runIn(
        contracts,
        reading,
        'search',
        '--path',
        '.',
        '--query',
        'termination clause'
      );
      assert.equal(found.status, 0, found.stderr);
      const foundPayload = JSON.parse(found.stdout);
      const hit = foundPayload.results.find((result) => result.path === 'lease-scan.pdf');
      assert.ok(hit, 'the clause was in the scan and the search of the folder did not find it');
      assert.equal(hit.extractor, 'OCR');
      assert.equal(foundPayload.filesUnread, 0);
      assert.match(foundPayload.note, /recognised from a picture of a page/);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(shelf, { recursive: true, force: true });
  await rm(scans, { recursive: true, force: true });
}

const skipped = SECTIONS.filter((section) => !ran.has(section));
console.log(
  `Document extraction and private search checks passed: ${ran.size} of ${SECTIONS.length} sections ran` +
    (skipped.length ? `, ${skipped.join(' and ')} skipped.` : '.')
);
