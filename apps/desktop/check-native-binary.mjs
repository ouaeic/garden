import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releasePathMappings } from './release-build-env.mjs';

const desktopDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));

const nativeArtifactKinds = new Map([
  ['garden-desktop', 'desktop'],
  ['garden-desktop.exe', 'desktop'],
  ['libgarden_desktop_lib.so', 'android'],
  ['libgarden_desktop_lib.a', 'ios']
]);

function printable(value, limit = 200) {
  return value.slice(0, limit).replace(/[^\x20-\x7e]/g, '?');
}

// Read archive metadata only; member names never become filesystem paths.
function archiveMemberAt(bytes, position) {
  if (bytes.subarray(0, 8).toString('ascii') !== '!<arch>\n') return null;
  let offset = 8;
  let names = null;
  while (offset + 60 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 60);
    const sizeText = header.subarray(48, 58).toString('ascii').trim();
    if (header.subarray(58).toString('ascii') !== '`\n' || !/^\d+$/.test(sizeText)) return null;
    const size = Number(sizeText);
    const start = offset + 60;
    const end = start + size;
    if (!Number.isSafeInteger(end) || end > bytes.length) return null;
    let name = header.subarray(0, 16).toString('ascii').trim();
    let content = start;
    if (name.startsWith('#1/')) {
      const lengthText = name.slice(3);
      if (!/^\d+$/.test(lengthText)) return null;
      const length = Number(lengthText);
      if (length > size) return null;
      name = bytes
        .subarray(start, start + Math.min(length, 200))
        .toString('latin1')
        .replace(/\0+$/, '');
      content += length;
    } else if (name === '//') {
      names = bytes.subarray(start, end);
    } else if (/^\/\d+$/.test(name) && names) {
      const index = Number(name.slice(1));
      if (index >= names.length) return null;
      const terminator = names.indexOf('\n', index);
      name = names
        .subarray(index, Math.min(index + 200, terminator < 0 ? names.length : terminator))
        .toString('latin1')
        .replace(/\/$/, '');
    } else if (name.endsWith('/') && name !== '/') {
      name = name.slice(0, -1);
    }
    if (position >= offset && position < end)
      return {
        name: printable(name),
        headerOffset: offset,
        contentOffset: content,
        memberOffset: position >= content ? position - content : null,
        location: position >= content ? 'content' : 'name-or-header'
      };
    offset = end + (size % 2);
  }
  return null;
}

function pathDiagnostics(bytes, text, prefix, pattern) {
  const matches = [];
  const expression = prefix ? null : new RegExp(pattern.source, `${pattern.flags}g`);
  let cursor = 0;
  while (matches.length < 3) {
    const match = expression?.exec(text);
    const position = prefix ? text.indexOf(prefix, cursor) : (match?.index ?? -1);
    if (position < 0) break;
    let end = position;
    const knownEnd = position + (prefix?.length ?? 0);
    const pathCharacter = (offset) =>
      bytes[offset] >= 33 && bytes[offset] <= 126 && !'"\'<>|=;,'.includes(text[offset]);
    while (
      end < bytes.length &&
      end < position + 320 &&
      ((end < knownEnd && bytes[end] >= 32 && bytes[end] <= 126) || pathCharacter(end))
    )
      end++;
    matches.push({
      byteOffset: position,
      pathToken: text.slice(position, end),
      truncatedAfter: end < bytes.length && (end < knownEnd || pathCharacter(end)),
      archiveMember: archiveMemberAt(bytes, position)
    });
    cursor = Math.max(end, position + (prefix?.length ?? match[0].length));
    if (expression) expression.lastIndex = cursor;
  }
  return matches;
}

async function findReleaseExecutables(root) {
  const matches = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        const kind = nativeArtifactKinds.get(entry.name);
        if (kind && path.split(/[\\/]/).includes('release')) {
          matches.push({ kind, path });
        }
      }
    }
  }
  await visit(root);
  return matches;
}

export async function checkNativeBinaries(
  targetRoot,
  environment = process.env,
  expectedKind = 'desktop'
) {
  const artifacts = await findReleaseExecutables(targetRoot);
  const matching = artifacts.filter(({ kind }) => kind === expectedKind);
  if (matching.length === 0) {
    throw new Error(`No ${expectedKind} native release artifact found below ${targetRoot}`);
  }

  const exactPrefixes = releasePathMappings(environment).map(({ source }) => source);
  const genericHomePatterns = [
    /\/Users\/[^/\0]+\/(?:\.cargo|\.rustup|Documents)\//,
    /\/home\/[^/\0]+\/(?:\.cargo|\.rustup|work)\//,
    /[A-Za-z]:\\Users\\[^\\\0]+\\(?:\.cargo|\.rustup|source|work)\\/i
  ];

  for (const { path } of matching) {
    const details = await stat(path);
    if (details.size > 300 * 1024 * 1024) {
      throw new Error(`Refusing to scan unexpectedly large native artifact: ${path}`);
    }
    const bytes = await readFile(path);
    const text = bytes.toString('latin1');
    const leakedPrefix = exactPrefixes.find((prefix) => text.includes(prefix));
    const leakedPattern = genericHomePatterns.find((pattern) => pattern.test(text));
    if (leakedPrefix || leakedPattern) {
      throw new Error(
        `Native release artifact contains a build-machine path (${leakedPrefix ?? leakedPattern}): ${path}\nPath diagnostics: ${JSON.stringify(pathDiagnostics(bytes, text, leakedPrefix, leakedPattern))}`
      );
    }
  }

  console.log(
    `Verified ${matching.length} ${expectedKind} native release artifact(s): no build-machine home paths`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configuredRoot =
    process.argv[2] ??
    process.env.CARGO_TARGET_DIR ??
    resolve(desktopDirectory, 'src-tauri', 'target');
  await checkNativeBinaries(resolve(configuredRoot), process.env, process.argv[3] ?? 'desktop');
}
