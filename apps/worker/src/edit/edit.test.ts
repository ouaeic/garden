import { beforeEach, describe, expect, it } from 'vitest';
import { applyEdit } from './apply.js';
import { blockAt } from './block.js';
import { normaliseLine, renderNumbered, sameLine, toLines } from './format.js';
import { parseEdit } from './parse.js';
import { EDIT_FORMAT_SPEC } from './prompt.js';
import {
  displayedRanges,
  firstUnshownLine,
  forgetReads,
  readsOf,
  recordRead,
  recordWrite,
  SNAPSHOTS_PER_PATH
} from './snapshots.js';

const TASK = 'task-1';
const PATH = 'workspace/queue.ts';

const FILE = [
  'export const drain = (queue: Job[]) => {',
  '  const job = queue.shift();',
  '  if (!job) return null;',
  '  return job.payload;',
  '};',
  '',
  'export const size = (queue: Job[]) => {',
  '  if (!queue) return null;',
  '  return queue.length;',
  '};'
].join('\n');

/** A read, exactly as `file_read` performs one: number the lines, remember what was shown. */
const read = (text = FILE, path = PATH, startLine = 1): string => {
  const lines = toLines(text).slice(startLine - 1);
  recordRead(TASK, path, startLine, lines.join('\n'));
  return renderNumbered(lines, startLine);
};

const apply = (patch: string, live = FILE, path = PATH) =>
  applyEdit(path, patch, live, readsOf(TASK, path));

const applied = (patch: string, live = FILE, path = PATH): string => {
  const result = apply(patch, live, path);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.text;
};

/** A patch, exactly as `file_patch` performs one: apply it, then record what it authored. */
const patched = (patch: string, live = FILE, path = PATH): string => {
  const result = apply(patch, live, path);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  recordWrite(TASK, path, result.text, result.changed);
  return result.text;
};

const refused = (patch: string, live = FILE, path = PATH): string => {
  const result = apply(patch, live, path);
  if (result.ok) throw new Error(`applied when it should have refused:\n${result.text}`);
  return result.refusal.message;
};

beforeEach(() => forgetReads());

describe('the read side', () => {
  it('numbers every line from one, which is what the format addresses', () => {
    expect(read().split('\n')[0]).toBe('1:export const drain = (queue: Job[]) => {');
    expect(read().split('\n')[9]).toBe('10:};');
  });

  it('numbers a window by its own start, so a partial read is still addressable', () => {
    expect(read(FILE, PATH, 7).split('\n')[0]).toBe('7:export const size = (queue: Job[]) => {');
  });

  it('keeps the trailing empty line a file ending in a newline has', () => {
    // The runner's ranged reader says so explicitly, and an applier that disagreed with it would be
    // off by one on every edit near the end of a file.
    expect(toLines('a\nb\n')).toEqual(['a', 'b', '']);
    expect(renderNumbered(toLines('a\nb\n'), 1)).toBe('1:a\n2:b\n3:');
  });
});

describe('the canonical dialect', () => {
  it('replaces a range, emitting only the new text', () => {
    read();
    expect(
      applied(
        'PUT 3.=4:\n-  if (!job) return null;\n+  if (!job) return undefined;\n+  return job.payload ?? null;'
      )
    ).toBe(
      FILE.replace(
        '  if (!job) return null;\n  return job.payload;',
        '  if (!job) return undefined;\n  return job.payload ?? null;'
      )
    );
  });

  it('replaces one line inside a repeated stanza, which is the case the quote was worst at', () => {
    // Line 8 is byte-identical to line 3. A quoted editor has to grow its quote past both of them;
    // the number is the whole address.
    read();
    const out = toLines(applied('PUT 8:\n-  if (!queue) return null;\n+  if (!queue) return 0;'));
    expect(out[2]).toBe('  if (!job) return null;');
    expect(out[7]).toBe('  if (!queue) return 0;');
  });

  it('inserts before and after a line without repeating it', () => {
    read();
    expect(
      toLines(applied('PUT <1:\n-export const drain = (queue: Job[]) => {\n+// header'))[0]
    ).toBe('// header');
    expect(toLines(applied('PUT >5:\n-};\n+// tail'))[5]).toBe('// tail');
  });

  it('deletes a range with CUT, and with a PUT that has no body', () => {
    read();
    expect(toLines(applied('CUT 6\n-')).length).toBe(9);
    expect(toLines(applied('PUT 6:\n-')).length).toBe(9);
  });

  it('replaces the whole block that opens at a line', () => {
    read();
    const out = toLines(
      applied('PUT 7*:\n-export const size = (queue: Job[]) => {\n+export const size = () => 0;')
    );
    expect(out.slice(6)).toEqual(['export const size = () => 0;']);
  });

  it('moves a block with one copy of it on the wire', () => {
    read();
    const out = applied(
      'CUT 7.=10 @size\n-export const size = (queue: Job[]) => {\nPUT <1 @size\n-export const drain = (queue: Job[]) => {'
    );
    expect(toLines(out)[0]).toBe('export const size = (queue: Job[]) => {');
    expect(out).not.toContain('export const size = (queue: Job[]) => {\n  const job');
    // The saving is the whole reason the operation exists: the moved lines are named, not typed.
    expect('CUT 7.=10 @size\nPUT <1 @size'.length).toBeLessThan(40);
  });

  it('resolves every range against the file as READ, not against its own earlier hunks', () => {
    read();
    const out = toLines(
      applied(
        'PUT 1:\n-export const drain = (queue: Job[]) => {\n+A\n+B\nPUT 9:\n-  return queue.length;\n+  return 0;'
      )
    );
    // The first hunk added a line. A front-to-back applier would put the second one at line 8.
    expect(out[9]).toBe('  return 0;');
  });
});

describe('forgiveness - a dropped or malformed header', () => {
  it('needs no header at all, because the path is a field of the call', () => {
    read();
    expect(apply('PUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;').ok).toBe(
      true
    );
  });

  it('accepts and drops a [path#tag] header a model brought from another dialect', () => {
    read();
    const result = apply(
      '[workspace/queue.ts#3f9a]\nPUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes.join(' ')).toMatch(/dropped a \[path\] section header/);
  });

  it('accepts a header naming a different file without letting it choose the file', () => {
    // The path in the call is the authority. A header that disagreed with it used to be the one way
    // a patch could be applied to a file the approval card had never named.
    read();
    const out = applied(
      '[some/other/file.ts]\nPUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;'
    );
    expect(toLines(out)[2]).toBe('  if (!job) return undefined;');
  });
});

describe('forgiveness - a misspelt operation', () => {
  const bodies =
    '\n-  if (!job) return null;\n+  if (!job) return undefined;\n+  return job.payload ?? null;';
  for (const spelling of [
    'PUT 3.=4:',
    'PUT 3-4:',
    'PUT 3..4:',
    'PUT 3,4:',
    'PUT 3 to 4:',
    'PUT 3.=4',
    'put 3.=4:',
    'PUT 4.=3:',
    /*
     * Runs of separator characters, because the list above was a list of the spellings someone
     * thought of. Measured on the box: `PUT 40.:=42:` was refused with "unexpected `.:=` after the
     * range" - the model had blended two spellings this file already accepted separately. Between
     * two numbers there is nothing else a run of these can mean.
     */
    'PUT 3.:=4:',
    'PUT 3:=4:',
    'PUT 3=4:',
    'PUT 3...4:',
    'PUT 3 . = 4:'
  ])
    it(`reads "${spelling}" as PUT 3.=4:`, () => {
      read();
      const out = toLines(applied(spelling + bodies));
      expect(out[2]).toBe('  if (!job) return undefined;');
      expect(out[3]).toBe('  return job.payload ?? null;');
      expect(out.length).toBe(10);
    });

  /*
   * THE COUNTER-DIRECTION, and the property that makes the run above safe to accept: a separator is
   * only ever consumed when digits follow it. `PUT 40:` is the single line 40 with a terminator, and
   * widening the separator must not turn its colon into the start of a range with a missing end.
   */
  it('still reads a terminator as a terminator, not as a separator with no number', () => {
    read();
    const out = toLines(applied('PUT 3:\n-  if (!job) return null;\n+  only this line'));
    expect(out[2]).toBe('  only this line');
    expect(out.length).toBe(10);
  });

  it('says which spellings it forgave, so the next patch is written the short way', () => {
    read();
    const result = apply('put 3-4:' + bodies);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes.join(' ')).toMatch(/as 3\.=4/);
  });

  it('refuses an unreadable operation by naming the row and the shapes that exist', () => {
    read();
    const message = refused('REPLACE 3 WITH X');
    expect(message).toMatch(/not an operation/);
    expect(message).toMatch(/PUT N\.=M:/);
  });

  it('points a REM or an MV at the tool that can actually do it', () => {
    read();
    expect(refused('REM')).toMatch(/cannot delete one\. Use shell/);
    expect(refused('MV workspace/other.ts')).toMatch(/cannot rename or move one\. Use shell/);
  });
});

describe('forgiveness - a model that reached for a unified diff', () => {
  it('takes - rows as evidence and applies the edit', () => {
    read();
    const result = apply(
      'PUT 3.=4:\n-  if (!job) return null;\n-  return job.payload;\n+  return job?.payload ?? null;'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  return job?.payload ?? null;');
      expect(result.notes.join(' ')).toMatch(/unified-diff hunk/);
    }
  });

  it('applies a whole @@ hunk with context rows and no PUT at all', () => {
    read();
    const out = toLines(
      applied(
        '@@ -2,3 +2,3 @@\n   const job = queue.shift();\n-  if (!job) return null;\n+  if (!job) return undefined;\n   return job.payload;'
      )
    );
    expect(out[1]).toBe('  const job = queue.shift();');
    expect(out[2]).toBe('  if (!job) return undefined;');
    expect(out[3]).toBe('  return job.payload;');
    expect(out.length).toBe(10);
  });

  it('refuses a space-prefixed row when nothing says it is context, and says why', () => {
    // The one place leniency is refused on purpose: a leading space is either a context marker or a
    // + the model dropped, and the two readings put different text in the file.
    read();
    expect(refused('PUT 3:\n+  if (!job) return undefined;\n   return job.payload;')).toMatch(
      /either unchanged context or a line whose \+ was dropped/
    );
  });

  it('refuses + rows under a CUT rather than quietly throwing them away', () => {
    read();
    expect(refused('CUT 3.=4\n+  return null;')).toMatch(/only deletes/);
  });

  /*
   * A body row that begins with none of `+ - space`, in the MIDDLE of a body with at least one `+`
   * row after it, has exactly one reading: a `+` the model dropped. Forgiving it changes nothing
   * about which lines are touched, so it lands with a note. Watched live, three times in one turn
   * from a cheap model, with blank `+` rows above it and a docstring row below it.
   */
  it('forgives a mid-body row whose + was dropped when + rows follow it, and says so', () => {
    read();
    const result = apply(
      'PUT >4:\n-  return job.payload;\n+\n+\ndef nth_prime(n):\n+    """Return the n-th prime."""'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = toLines(result.text);
      expect(out.slice(4, 8)).toEqual([
        '',
        '',
        'def nth_prime(n):',
        '    """Return the n-th prime."""'
      ]);
      expect(out).toHaveLength(14);
      expect(result.notes.join(' ')).toMatch(/patch row 5 .*dropped/);
    }
  });

  it('still refuses an unmarked row at the END of a body, where prose after a patch lives', () => {
    read();
    expect(
      refused('PUT 3:\n+  if (!job) return undefined;\nThat replaces the null return.')
    ).toMatch(/not an operation: That replaces/);
  });

  it('still reads a mid-body row that is a real operation as the next operation', () => {
    read();
    const out = toLines(
      applied(
        'PUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;\nPUT 8:\n-  if (!queue) return null;\n+  if (!queue) return 0;'
      )
    );
    expect(out[2]).toBe('  if (!job) return undefined;');
    expect(out[7]).toBe('  if (!queue) return 0;');
    expect(out).toHaveLength(10);
    // A CUT and a paste are operations too, whatever follows them: the CUT owns the + row under
    // it and refuses it, and the paste takes no body, so the + row under it is an orphan.
    expect(refused('PUT 3:\n+  a;\nCUT 8.=9\n+  b;')).toMatch(/only deletes/);
    expect(refused('PUT 3:\n+  a;\nPUT >8 @none\n+  b;')).toMatch(/no replacement body/);
  });

  /*
   * The next operation, misspelt. `PUT line 15:` is an operation the model reached for and got
   * wrong, and a body that swallowed it would land the words as text on line 4, leave line 15
   * untouched and report success - visible only in the write echo. A row whose verb is upper-case
   * and stands alone or before whitespace is an operation attempt, and it is refused by name at
   * its own row, exactly as it is when it stands under nothing.
   */
  it('still refuses a malformed operation under a body by name, rather than landing it as text', () => {
    read();
    expect(refused('PUT 3:\n+a\nPUT line 15:\n+b')).toMatch(/PUT needs a line number/);
    expect(refused('PUT 3:\n+a\nPUT L15:\n+b')).toMatch(/PUT needs a line number/);
    expect(refused('PUT 3:\n+a\nPUT\n+b')).toMatch(/PUT needs a line number/);
    expect(refused('PUT 3:\n+a\nPUT15:\n+b')).toMatch(/not an operation: PUT15:/);
    expect(refused('PUT 3:\n+a\nREM 5\n+b')).toMatch(/cannot delete one/);
    expect(refused('PUT 3:\n+a\nDEL 5\n+b')).toMatch(/cannot delete one/);
    expect(refused('PUT 3:\n+a\nMV a b\n+b')).toMatch(/cannot rename or move one/);
    const result = parseEdit('PUT 3:\n+a\nPUT line 15:\n+b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.row).toBe(3);
  });

  it('still forgives a code row that merely begins with a verb', () => {
    read();
    for (const row of ['put(x)', 'cut = 3', 'del cache[key]', 'rm_stale = True', 'move(a, b)']) {
      const out = toLines(applied(`PUT 3:\n-  if (!job) return null;\n+a\n${row}\n+b`));
      expect(out.slice(2, 5), row).toEqual(['a', row, 'b']);
    }
  });

  it('still ends a body at a blank row, which is how operations are spaced out', () => {
    read();
    expect(refused('PUT 3:\n+  a;\n\n+  b;')).toMatch(/a body row with no operation above it/);
  });
});

describe('forgiveness - a model that pasted the whole diff', () => {
  it('drops the git diff preamble and applies the hunk under it', () => {
    /*
     * A bare `@@` hunk was forgiven and a whole `git diff` was not, which is backwards: the whole
     * diff is what the tool a model has seen a million times actually prints. `--- a/path` begins
     * with a minus, so it was refused as "a body row with no operation above it" - a message about
     * bodies for a fault about headers, which never named the row that caused it.
     */
    read();
    const result = apply(
      [
        'diff --git a/workspace/queue.ts b/workspace/queue.ts',
        'index 1a2b3c4d..5e6f7a8b 100644',
        '--- a/workspace/queue.ts',
        '+++ b/workspace/queue.ts',
        '@@ -3,1 +3,1 @@',
        '-  if (!job) return null;',
        '+  if (!job) return undefined;'
      ].join('\n')
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(result.notes.join(' ')).toMatch(/dropped the git diff header rows/);
    }
  });

  it('does not let a preamble naming another file move the edit to it', () => {
    // The same guarantee the `[path]` header gets: the path is a field of the call, and nothing in
    // the patch text may choose a different one.
    read();
    const out = applied(
      '--- a/some/other/file.ts\n+++ b/some/other/file.ts\nPUT 3:\n-  if (!job) return null;\n+  changed;'
    );
    expect(toLines(out)[2]).toBe('  changed;');
  });

  it('reads a space-separated range, which the header comment already promised', () => {
    // A comment that lies about behaviour is the same defect as behaviour that lies about itself,
    // and of the two spellings the cheaper one to fix is the one that costs a round trip.
    read();
    const out = toLines(applied('PUT 3 4:\n-  if (!job) return null;\n+  a;\n+  b;'));
    expect(out[2]).toBe('  a;');
    expect(out[3]).toBe('  b;');
    expect(out.length).toBe(10);
  });
});

describe('forgiveness - a miscounted anchor', () => {
  it('corrects an off-by-one when the model quoted what it meant to replace', () => {
    read();
    // Addressed line 4, quoted line 3. The quote is a statement of intent the harness can check.
    const result = apply('PUT 4:\n-  if (!job) return null;\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(toLines(result.text)[3]).toBe('  return job.payload;');
      expect(result.notes.join(' ')).toMatch(/off by 1/);
    }
  });

  it('corrects an off-by-one on a file that repeats the quoted line, which is the case bought', () => {
    const repetitive = [
      'export const a = (q: Job[]) => {', //  1
      '  const job = q.shift();', //         2
      '  if (!job) return null;', //         3
      '  return job;', //                    4
      '};', //                               5
      '', //                                 6
      'export const b = (q: Job[]) => {', // 7
      '  const job = q[0];', //              8
      '  if (!job) return null;', //         9
      '  return job;', //                   10
      '};', //                              11
      '', //                                12
      'export const c = (q: Job[]) => {', //13
      '  const job = q.pop();', //          14
      '  if (!job) return null;', //        15
      '  return job;', //                   16
      '};' //                               17
    ].join('\n');
    read(repetitive);
    // Addressed line 8, quoted line 9 - and that quote is in the file three times.
    const result = apply(
      'PUT 8:\n-  if (!job) return null;\n+  if (!job) return undefined;',
      repetitive
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[8]).toBe('  if (!job) return undefined;');
      // The other two stanzas are untouched: the correction reaches three lines, never the file.
      expect(toLines(result.text)[2]).toBe('  if (!job) return null;');
      expect(toLines(result.text)[14]).toBe('  if (!job) return null;');
      expect(result.notes.join(' ')).toMatch(/off by 1/);
    }
  });

  it('still refuses when the quoted line repeats INSIDE the window it may correct within', () => {
    // The bound the case above rests on. Two identical lines three apart leave the harness no
    // unambiguous answer, and an ambiguous correction is how a format like this corrupts code.
    const twins = ['const x = 1;', '  same();', '  same();', 'const y = 2;'].join('\n');
    read(twins);
    const message = refused('PUT 1:\n-  same();\n+  same(2);', twins);
    // Both candidates are named, and neither is chosen: nearest is a guess.
    expect(message).toMatch(/2 and 3/);
    expect(message).toMatch(/1:const x = 1;/);
    // Untouched, which is the assertion that matters: an ambiguous correction writes nothing.
    expect(
      applyEdit(PATH, 'PUT 1:\n-const x = 1;\n+const x = 2;', twins, readsOf(TASK, PATH)).ok
    ).toBe(true);
  });

  it('refuses when the quoted text is too far from the anchor to be a miscount', () => {
    read();
    const message = refused('PUT 1:\n-  return queue.length;\n+  return queue.length ?? 0;');
    expect(message).toMatch(/too far to correct without guessing/);
    expect(message).toMatch(/1:export const drain/);
  });

  it('refuses when the quoted text is nowhere, and shows what is actually there', () => {
    read();
    const message = refused(
      'PUT 3:\n-  if (!job) throw new Error();\n+  if (!job) return undefined;'
    );
    expect(message).toMatch(/is not in workspace\/queue\.ts at all/);
    expect(message).toMatch(/3: {2}if \(!job\) return null;/);
  });

  it('refuses an unanchored off-by-one even when the line number is valid', () => {
    read();
    const result = apply('PUT 4:\n+  if (!job) return undefined;');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.message).toContain('no content anchor');
  });
});

describe('an anchor nobody was shown', () => {
  it('refuses a line outside the window that was read, with the real text inlined', () => {
    read(FILE, PATH, 1);
    forgetReads();
    read(FILE, PATH, 1);
    // A window read of the first four lines only.
    forgetReads();
    recordRead(TASK, PATH, 1, toLines(FILE).slice(0, 4).join('\n'));
    const message = refused('PUT 8:\n+  if (!queue) return 0;');
    expect(message).toMatch(/No read has shown you/);
    expect(message).toMatch(/8: {2}if \(!queue\) return null;/);
  });

  it('refuses when no read of the file is on record at all', () => {
    expect(refused('PUT 3:\n+x')).toMatch(/No read of .* is on record/);
  });

  it('refuses a line past the end of the file, and shows where the file ends', () => {
    read();
    const message = refused('PUT 40:\n+x');
    expect(message).toMatch(/has 10 lines, and this patch addresses line 40/);
    expect(message).toMatch(/10:};/);
  });
});

describe('a file that moved under the edit', () => {
  const shifted = `// added\n// added\n${FILE}`;

  it('follows the text when the file shifted, rather than refusing', () => {
    read();
    const result = apply(
      'PUT 3.=4:\n-  if (!job) return null;\n+  return job?.payload ?? null;',
      shifted
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[4]).toBe('  return job?.payload ?? null;');
      expect(result.notes.join(' ')).toMatch(/had moved to 5-6/);
    }
  });

  it('follows an insert too, by widening its one-line anchor', () => {
    read();
    const result = apply('PUT >4:\n-  return job.payload;\n+  // done', shifted);
    expect(result.ok).toBe(true);
    if (result.ok) expect(toLines(result.text)[6]).toBe('  // done');
  });

  it('fails closed when the lines it read are gone, and shows the file as it reads now', () => {
    read();
    const rewritten = toLines(FILE)
      .map((line, index) => (index === 2 || index === 3 ? '  // gone' : line))
      .join('\n');
    const message = refused('PUT 3.=4:\n-  if (!job) return null;\n+x', rewritten);
    expect(message).toMatch(/no longer there/);
    expect(message).toMatch(/3: {2}\/\/ gone/);
  });

  it('fails closed when the shifted lines now appear twice, so there is no unambiguous place', () => {
    read();
    const duplicated = `// added\n// added\n${FILE}\n${toLines(FILE).slice(2, 4).join('\n')}`;
    expect(refused('PUT 3.=4:\n-  if (!job) return null;\n+x', duplicated)).toMatch(
      /gone or now appears more than once/
    );
  });

  it('does not care that the text is repeated when the numbers are still live', () => {
    /*
     * The quoted editor refuses this, and refusing it is the defect the line address removes. Line 3
     * IS line 3; another copy of its text at the bottom of the file says nothing about that.
     * Uniqueness is only needed to RELOCATE, and nothing needs relocating when nothing moved.
     */
    read();
    const duplicated = `${FILE}\n${toLines(FILE).slice(2, 4).join('\n')}`;
    expect(toLines(applied('PUT 3.=4:\n-  if (!job) return null;\n+x', duplicated))[2]).toBe('x');
  });
});

describe('whitespace, tabs and line endings', () => {
  it('never lets a trailing space or a CR invalidate an anchor', () => {
    expect(sameLine('  return job.payload;  ', '  return job.payload;\r')).toBe(true);
    expect(normaliseLine('a\t \r')).toBe('a');
    // Leading whitespace is indentation and is content; only the tail may vary.
    expect(sameLine('  a', '    a')).toBe(false);
  });

  it('recovers a shifted anchor across a CRLF rewrite of the file', () => {
    read();
    const crlf = toLines(FILE)
      .map((line) => `${line}\r`)
      .join('\n');
    const result = apply(
      'PUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;',
      `// added\n${crlf}`
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(toLines(result.text)[3]).toBe('  if (!job) return undefined;');
  });
});

describe('the bounds that stop a patch corrupting a file', () => {
  it('refuses two operations that touch the same lines, and writes nothing', () => {
    read();
    expect(
      refused('PUT 3.=4:\n-  if (!job) return null;\n+a\nPUT 4:\n-  return job.payload;\n+b')
    ).toMatch(/touch the same lines/);
  });

  it('refuses a paste whose register was never cut', () => {
    read();
    expect(refused('PUT >1 @nothing\n-export const drain = (queue: Job[]) => {')).toMatch(
      /was never filled/
    );
  });

  it('shows how to write new lines and how to move read ones, at the line addressed', () => {
    read();
    const message = refused('PUT >7 @split\n-export const size = (queue: Job[]) => {');
    expect(message).toMatch(/To write NEW lines/);
    expect(message).toContain('PUT >7:');
    expect(message).toMatch(/To MOVE lines/);
    expect(message).toContain('CUT 40.=52 @split');
    expect(message).toContain('PUT >7 @split');
  });

  it('shows the before form when the patch addressed a line from before', () => {
    read();
    expect(refused('PUT <3 @body\n-  if (!job) return null;')).toContain('PUT <3:');
  });

  it('shows a whole valid patch on every parse failure, whichever rule was tripped', () => {
    read();
    for (const bad of ['PUT 3: junk after the colon', 'def test_split_empty():', 'CUT']) {
      const message = refused(bad);
      expect(message, bad).toContain('PUT 12.=14:');
      expect(message, bad).toContain('marker per body row');
    }
  });

  /*
   * Of the three shapes that earned the example above, this one is answered without it. Watched on
   * the box twice in one turn: a body on the operation's own row that does not parse leaves the
   * next real body row to be read as an operation, so one habit costs two refusals. The text after
   * the colon is the first body row, and the note says where the body belongs.
   */
  it('reads a body written on the operation row as the first body row', () => {
    read();
    const result = apply('PUT 3:-  if (!job) return null;\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(toLines(result.text)).toHaveLength(10);
      expect(result.notes.join(' ')).toMatch(/text after the colon/);
    }
    // And with more body rows below it, all of them land in order.
    const out = toLines(applied('PUT 3:-  if (!job) return null;\n+  a;\n+  b;'));
    expect(out[2]).toBe('  a;');
    expect(out[3]).toBe('  b;');
    // Only a marker may follow the colon; anything else is still not an operation.
    expect(refused('PUT 3: junk')).toMatch(/unexpected "junk"/);
  });

  it('refuses a block that does not close within the lines that were shown', () => {
    // A window that stops inside a function: claiming the rest of the file would be destructive, so
    // the scanner claims nothing and the applier says so by name.
    recordRead(TASK, PATH, 1, toLines(FILE).slice(0, 3).join('\n'));
    expect(refused('PUT 1*:\n+x')).toMatch(/does not close within the lines you have been shown/);
  });

  it('leaves the file untouched on every refusal', () => {
    read();
    for (const patch of ['PUT 3.=4:\n+a\nPUT 4:\n+b', 'PUT >1 @nothing', 'PUT 400:\n+x'])
      expect(apply(patch).ok).toBe(false);
  });
});

describe('what the store remembers, and what it forgets', () => {
  it('keeps only the last few reads of one file', () => {
    for (let version = 0; version < SNAPSHOTS_PER_PATH + 3; version += 1)
      recordRead(TASK, PATH, 1, `line ${version}`);
    expect(readsOf(TASK, PATH)).toHaveLength(SNAPSHOTS_PER_PATH);
  });

  it('does not spend that budget on identical re-reads', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) recordRead(TASK, PATH, 1, FILE);
    expect(readsOf(TASK, PATH)).toHaveLength(1);
  });

  it('lets a second edit follow the first with no read between them', () => {
    read();
    const once = patched('PUT <1:\n-export const drain = (queue: Job[]) => {\n+// header');
    // Line 4 in the NEW numbering is line 3 of the original.
    const twice = applied(
      'PUT 4:\n-  if (!job) return null;\n+  if (!job) return undefined;',
      once
    );
    expect(toLines(twice)[3]).toBe('  if (!job) return undefined;');
  });

  /*
   * WHAT A PATCH VOUCHES FOR IS THE SPAN IT WROTE. This re-recorded the entire new file on the
   * argument that a caller has seen what it authored - true of a whole-file write and false of a
   * line-addressed patch, which authors a span and reproduces the rest of a file it may have been
   * shown two hundred lines of. One successful patch therefore made every line of the file
   * editable, so an anchor the record had refused a moment earlier landed silently.
   */
  it('vouches for the span a patch wrote, and for no more of the file than the reads did', () => {
    const long = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`).join('\n');
    recordRead(TASK, PATH, 1, toLines(long).slice(0, 50).join('\n'));
    const after = patched('PUT 10:\n-line 10\n+line 10 // touched', long);

    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 50 }]);
    expect(apply('PUT 300:\n+blind', after).ok).toBe(false);
    expect(apply('PUT 20:\n-line 20\n+line 20 // also touched', after).ok).toBe(true);
  });

  /*
   * The lines a read showed keep meaning what they meant, at whatever numbers the edit moved them
   * to. Three lines replace one at line 10, so the fifty lines that were shown are now fifty-two,
   * and the last of them is line 52.
   */
  it('moves the lines a read showed by what the edit changed the length by', () => {
    const long = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`).join('\n');
    recordRead(TASK, PATH, 1, toLines(long).slice(0, 50).join('\n'));
    const after = patched('PUT 10:\n-line 10\n+one\n+two\n+three', long);

    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 52 }]);
    expect(apply('PUT 52:\n-line 50\n+line 50 // touched', after).ok).toBe(true);
    expect(apply('PUT 53:\n+blind', after).ok).toBe(false);
  });

  it('keeps one task from vouching for another task reads', () => {
    read();
    expect(readsOf('some-other-task', PATH)).toHaveLength(0);
  });

  /*
   * WHICH LINES HAVE BEEN SHOWN IS NOT A QUESTION ABOUT THE SNAPSHOTS. They carry text, so only a
   * few of them can be kept, and answering coverage off them meant a file read from its first line
   * to its last was still reported unread past the last four windows - 37 of this repository's 946
   * tracked files were long enough that no sequence of reads could ever cover them. Runs of numbers
   * cost nothing to keep, and windows that continue one another merge into one.
   */
  it('remembers every line shown, past the few windows whose text it can hold', () => {
    for (let window = 0; window < 40; window += 1)
      recordRead(TASK, PATH, window * 20 + 1, Array.from({ length: 20 }, () => 'x').join('\n'));
    expect(readsOf(TASK, PATH)).toHaveLength(SNAPSHOTS_PER_PATH);
    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 800 }]);
    expect(firstUnshownLine(displayedRanges(TASK, PATH), 800)).toBeUndefined();
    expect(firstUnshownLine(displayedRanges(TASK, PATH), 801)).toBe(801);
  });

  it('names the first line of the first gap, so a refusal can say where to read from', () => {
    expect(firstUnshownLine([], 10)).toBe(1);
    expect(firstUnshownLine([{ start: 1, end: 200 }], 8_332)).toBe(201);
    expect(firstUnshownLine([{ start: 1, end: 200 }], 200)).toBeUndefined();
    // A run that starts past the gap does not close it, and is not what the model is sent to read.
    expect(
      firstUnshownLine(
        [
          { start: 1, end: 200 },
          { start: 400, end: 900 }
        ],
        900
      )
    ).toBe(201);
  });

  /*
   * A whole-file write is the one caller for which "you have seen what you authored" is true of the
   * whole file, so it replaces the record rather than adding to it: the numbers of the version it
   * discarded describe nothing now.
   */
  it('lets a whole-file write replace the record with what it wrote', () => {
    recordRead(
      TASK,
      PATH,
      1,
      Array.from({ length: 50 }, (_, line) => `line ${line + 1}`).join('\n')
    );
    recordWrite(TASK, PATH, 'one\ntwo\nthree');
    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 3 }]);
    expect(readsOf(TASK, PATH)[0]?.lines).toEqual(['one', 'two', 'three']);
  });
});

describe('the resident cost', () => {
  it('states the whole format in under 1,200 bytes', () => {
    expect(Buffer.byteLength(EDIT_FORMAT_SPEC)).toBeLessThan(1_200);
  });

  it('describes every operation the parser accepts, and no operation it does not', () => {
    // A spec that named an operation the parser refuses is a round trip the model cannot avoid; a
    // parser that accepts one the spec omits is a capability nothing can find by reading.
    for (const shape of [
      'PUT N:',
      'PUT N.=M:',
      'PUT N*:',
      'PUT <N:',
      'PUT >N:',
      'CUT N.=M',
      'PUT >N @x'
    ])
      expect(EDIT_FORMAT_SPEC).toContain(shape);
    expect(EDIT_FORMAT_SPEC).not.toContain('REM');
    expect(EDIT_FORMAT_SPEC).not.toContain('MV ');
  });

  it('says nothing about what the parser forgives', () => {
    /*
     * Deliberate, and the reason is that a leniency is not a feature. Documenting the unified-diff
     * hunk or the lower-case verb would spend resident bytes teaching a longer way to write the
     * same edit, and the model would then write it that way on every hunk - which is the whole
     * cost the format exists to remove. The leniency is for a model that reaches for a habit
     * anyway. The one `-` row IS taught, and it is taught because it is not a leniency: it is the
     * anchor that closes the format's one hole, and the test below holds the spec to it.
     */
    for (const leniency of ['@@', 'unified', 'lower-case', 'optional'])
      expect(EDIT_FORMAT_SPEC.toLowerCase()).not.toContain(leniency.toLowerCase());
  });

  it('teaches the one - row, as a prefix, and shows it in the example', () => {
    expect(EDIT_FORMAT_SPEC).toMatch(/Every operation requires one - row first/);
    expect(EDIT_FORMAT_SPEC).toMatch(/8\+ non-space characters/);
    expect(EDIT_FORMAT_SPEC).toContain('\n  -  if (!job) return null;\n');
  });
});

describe('the content anchor', () => {
  it('applies where the anchor holds at the addressed line, with no note about it', () => {
    read();
    const result = apply('PUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(result.notes).toEqual([]);
    }
  });

  it('corrects the number when the anchor is one line away, and says so', () => {
    read();
    const result = apply('PUT 4:\n-  if (!job) ret\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(toLines(result.text)[3]).toBe('  return job.payload;');
      expect(result.notes.join(' ')).toMatch(/off by 1; the edit was applied at 3/);
    }
  });

  it('reaches five lines when nothing nearer carries the anchor', () => {
    read();
    // Line 8 addressed, anchor is line 3 and nowhere else.
    const result = apply('PUT 8:\n-  if (!job) return\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(toLines(result.text)[7]).toBe('  if (!queue) return null;');
      expect(result.notes.join(' ')).toMatch(/off by 5/);
    }
  });

  it('asks the near ring first, so a second copy four lines out does not refuse an off-by-one', () => {
    // Line 3 and line 8 both begin `  if (!`; addressed 4, the anchor is one line away at 3 and
    // four lines away at 8. One wide window would see both and refuse; the near ring sees one.
    read();
    const result = apply('PUT 4:\n-  if (!\n+  changed;');
    expect(result.ok).toBe(true);
    if (result.ok) expect(toLines(result.text)[2]).toBe('  changed;');
  });

  it('shifts a range by the anchor and never widens it', () => {
    read();
    const out = toLines(applied('PUT 4.=5:\n-  if (!job) return null;\n+  merged;'));
    // 3-4 replaced, not 3-5: the range said two lines and two lines went.
    expect(out[2]).toBe('  merged;');
    expect(out[3]).toBe('};');
    expect(out).toHaveLength(9);
  });

  it('refuses two candidates in the ring, naming both, and chooses neither', () => {
    const twins = [
      'const x = 1;',
      '  return x + 1;',
      '  fill();',
      '  return x + 1;',
      'const y = 2;'
    ].join('\n');
    read(twins);
    const message = refused('PUT 3:\n-  return x + 1;\n+  return x + 2;', twins);
    expect(message).toMatch(/2 and 4/);
    expect(message).toMatch(/2: {2}return x \+ 1;/);
  });

  it('names the one line elsewhere that carries the anchor, and asks for the body against it', () => {
    read();
    const message = refused('PUT 1:\n-  return queue.length\n+  return 0;');
    expect(message).toMatch(/at 9, but you addressed 1/);
    expect(message).toMatch(/Send the same body against 9/);
    expect(message).toMatch(/1:export const drain/);
  });

  it('refuses a weak anchor whose neighbours do not read as the ledger recorded them', () => {
    read();
    // `}` is on lines 5 and 10, and the file has drifted around both: line 4 and line 9 changed.
    const drifted = toLines(FILE)
      .map((line, index) => (index === 3 || index === 8 ? '  // changed' : line))
      .join('\n');
    const message = refused('PUT 7:\n-};\n+// closed', drifted);
    expect(message).toMatch(/nothing was written/);
    expect(message).toMatch(/7:export const size/);
  });

  it('accepts a weak anchor where its neighbours still read as recorded', () => {
    read();
    const result = apply('PUT >6:\n-};\n+// after the first function');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[5]).toBe('// after the first function');
      expect(result.notes.join(' ')).toMatch(/off by 1/);
    }
  });

  it('checks the anchor where the ledger relocated the span, never around the old number', () => {
    read();
    const shifted = `// a\n// b\n// c\n${FILE}`;
    // Line 3 moved to 6; the anchor quotes line 4's text, so it disagrees where the span went.
    const message = refused('PUT 3:\n-  return job.payload;\n+  changed;', shifted);
    expect(message).toMatch(/had moved to 6/);
    expect(message).toMatch(/6: {2}if \(!job\) return null;/);
  });

  it('refuses to correct onto a line no read has shown, naming it', () => {
    recordRead(TASK, PATH, 1, toLines(FILE).slice(0, 4).join('\n'));
    const message = refused('PUT 2:\n-  return queue.length;\n+  return 0;');
    expect(message).toMatch(/9, has never been shown to you/);
    expect(message).toMatch(/2: {2}const job/);
  });

  it('refuses a corrected range that would run past the lines shown', () => {
    recordRead(TASK, PATH, 1, toLines(FILE).slice(0, 4).join('\n'));
    // 3-4 shifted by the anchor at 4 would be 4-5, and 5 was never displayed.
    const message = refused('PUT 3.=4:\n-  return job.payload;\n+  a;\n+  b;');
    expect(message).toMatch(/runs past the lines you have been shown/);
    expect(message).toMatch(/3: {2}if \(!job\) return null;/);
  });

  it('never lands where the live file carries the anchor but the ledger does not', () => {
    read();
    // Somebody wrote the anchor text onto line 2 after the read. The ledger says line 2 is
    // `const job = queue.shift();`, so line 2 is not a candidate whatever the file says now.
    const drifted = toLines(FILE)
      .map((line, index) => (index === 1 ? '  if (!job) throw new Error();' : line))
      .join('\n');
    const message = refused('PUT 3:\n-  if (!job) throw\n+  changed;', drifted);
    expect(message).toMatch(/did not when you read it/);
    expect(toLines(drifted)[1]).toBe('  if (!job) throw new Error();');
  });

  it('folds curly quotes, dashes and tabs on the anchor and never on the body', () => {
    const tabbed = 'export const run = () => {\n\tconst label = "a - b";\n\treturn label;\n};';
    read(tabbed);
    const result = apply('PUT 2:\n-  const label = “a – b”;\n+\tconst label = “a – b”;', tabbed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(toLines(result.text)[1]).toBe('\tconst label = “a – b”;');
  });

  it('reads a patch whose rows end in CR', () => {
    read();
    const out = toLines(applied('PUT 3:\r\n-  if (!job) return null;\r\n+  changed;\r\n'));
    expect(out[2]).toBe('  changed;');
    expect(out).toHaveLength(10);
  });

  it('strips a leaked line-number prefix only where the number is the row it stands at', () => {
    read();
    const result = apply('PUT 3:\n-3:  if (!job) return null;\n+3:  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(result.notes.join(' ')).toMatch(/leaked line-number prefix/);
    }
    // A different number is left byte for byte, and cannot move the edit.
    const message = refused('PUT 3:\n-2:  const job = queue.shift();\n+  changed;');
    expect(message).toMatch(/not in workspace\/queue\.ts at all/);
    const literal = applied('PUT 3:\n-  if (!job) return null;\n+2:  literal;');
    expect(toLines(literal)[2]).toBe('2:  literal;');
  });

  it('anchors a CUT, an insert and a block on line N', () => {
    read();
    expect(toLines(applied('CUT 7.=10\n-export const size'))).toHaveLength(6);
    // Addressed one line late: the range moves with the anchor and keeps its length, so 7-9 go
    // and the closing brace at 10 stays - a range is never widened to what it "must have meant".
    const late = toLines(applied('CUT 8.=10\n-export const size'));
    expect(late).toHaveLength(7);
    expect(late[6]).toBe('};');
    expect(toLines(applied('PUT <7:\n-export const size\n+// size'))[6]).toBe('// size');
    expect(toLines(applied('PUT 6*:\n-export const size\n+export const size = () => 0;'))).toEqual([
      ...toLines(FILE).slice(0, 6),
      'export const size = () => 0;'
    ]);
    // Two - rows under an insert are still the deletion nobody asked for.
    expect(refused('PUT >7:\n-a\n-b\n+c')).toMatch(/deletion nobody asked for/);
  });

  it('notes a body that already reads that way, and applies it', () => {
    read();
    const result = apply('PUT 3:\n-  if (!job) return null;\n+  if (!job) return null;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(FILE);
      expect(result.notes.join(' ')).toMatch(/already read that way/);
    }
  });

  it('requires an anchor on every operation, including later operations', () => {
    read();
    for (const patch of [
      'PUT 3:\n+  a;\nPUT 8:\n+  b;',
      'PUT 3:\n-  if (!job)\n+  a;\nPUT 8:\n+  b;',
      'CUT 7.=10 @size\n-export const size\nPUT <1 @size'
    ]) {
      const result = apply(patch);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.message).toContain('no content anchor');
    }
  });

  it('names the merged spelling when two operations overlap', () => {
    read();
    expect(
      refused('PUT 3.=4:\n-  if (!job) return null;\n+a\nPUT 4:\n-  return job.payload;\n+b')
    ).toMatch(/PUT 3\.=4:/);
  });

  it('reports the new numbering, cumulatively, so the next patch needs no read', () => {
    read();
    const result = apply(
      'PUT 3:\n-  if (!job) return null;\n+  a;\n+  b;\n+  c;\nCUT 8.=9\n-  if (!queue) return null;'
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.renumbered).toEqual([
        'lines after 3 are now +2',
        'lines after 9 are now 0',
        'net: lines after 9 are now 0'
      ]);
    const one = apply('PUT >5:\n-};\n+// tail');
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.renumbered).toEqual(['lines after 5 are now +1']);
    const none = apply('PUT 3:\n-  if (!job) return null;\n+  a;');
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.renumbered).toEqual([]);
  });

  /*
   * THE TWO-PATCH PROOF. Read lines 1-57, add a line at 12, then address line 41 in the NEW
   * numbering with an anchor and no read between: the ledger moved by the same amount the
   * result reported, so the anchor holds where the number says and nothing is corrected.
   */
  it('lets the next patch address the new numbers, anchored, with no read between', () => {
    const long = Array.from({ length: 57 }, (_, line) => `line ${line + 1} of the file;`).join(
      '\n'
    );
    read(long);
    const once = apply('PUT 12:\n-line 12 of\n+line 12 of the file;\n+line 12 and a half;', long);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.renumbered).toEqual(['lines after 12 are now +1']);
    recordWrite(TASK, PATH, once.text, once.changed);
    // Old line 40 is new line 41, and the anchor quotes what is there now.
    const twice = apply('PUT 41:\n-line 40 of the\n+line 40, changed;', once.text);
    expect(twice.ok).toBe(true);
    if (twice.ok) {
      expect(toLines(twice.text)[40]).toBe('line 40, changed;');
      expect(twice.notes).toEqual([]);
    }
  });
});

describe('the anchor against a file that moved, and the rows that only look like a display', () => {
  it('applies a correct anchor where the ledger followed the addressed lines', () => {
    read();
    // Two lines prepended: line 3 is now line 5, and the anchor quotes exactly what was read at 3.
    const shifted = `// added\n// added\n${FILE}`;
    const result = apply(
      'PUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;',
      shifted
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[4]).toBe('  if (!job) return undefined;');
      expect(result.notes.join(' ')).toMatch(/3 had moved to 5/);
    }
  });

  it('applies a weak anchor on an insert where the ledger followed the line it hangs off', () => {
    read();
    const shifted = `// added\n${FILE}`;
    const result = apply('PUT >5:\n-};\n+// after drain', shifted);
    expect(result.ok).toBe(true);
    if (result.ok) expect(toLines(result.text)[6]).toBe('// after drain');
  });

  it('follows the target past a same-prefix line inserted directly above it', () => {
    read();
    const grown = toLines(FILE);
    grown.splice(2, 0, '  if (!job) log();');
    const result = apply('PUT 3:\n-  if (!job) return null;\n+  changed;', grown.join('\n'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) log();');
      expect(toLines(result.text)[3]).toBe('  changed;');
    }
  });

  it('names both braces when the one meant has a stale neighbour and a further one has not', () => {
    const braces = [
      'function a() {',
      '  if (x) {',
      '    y();',
      '    z();',
      '  }',
      '  if (w) {',
      '    v();',
      '  }',
      '}'
    ].join('\n');
    read(braces);
    const drifted = braces.replace('    z();', '    z(1);');
    const result = apply('PUT 6:\n-  }\n+  } // end if x', drifted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.message).toMatch(/lines 5 and 8 near 6/);
      expect(result.refusal.message).toMatch(/beside 5 the file has changed/);
      expect(result.refusal.message).toMatch(/8: {2}}/);
    }
    expect(toLines(drifted)[7]).toBe('  }');
  });

  it('leaves the leading digits of a row alone where the file begins that line with digits', () => {
    const schedule = '1:00 open\n2:00 standup\n3:00 review\n4:00 lunch\n5:00 close';
    read(schedule);
    const result = apply('PUT 4:\n-4:00 lunch\n+4:15 lunch', schedule);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[3]).toBe('4:15 lunch');
      expect(result.notes.join(' ')).not.toMatch(/leaked/);
    }
    const grid = '1|a|b\n2|c|d\n3|e|f';
    read(grid);
    expect(toLines(applied('PUT 2:\n-2|c|d\n+2|C|D', grid))[1]).toBe('2|C|D');
    const tabs = '1\tone\n2\ttwo';
    read(tabs);
    expect(toLines(applied('PUT 2:\n-2\ttwo\n+2\tTWO', tabs))[1]).toBe('2\tTWO');
  });

  it('keeps a CRLF file CRLF on the rows it inserts, and bare on a last line with no newline', () => {
    read();
    const crlf = FILE.replace(/\n/g, '\r\n');
    const result = apply(
      'PUT 3:\n-  if (!job) return null;\n+  if (!job) return undefined;\n+  // two rows',
      crlf
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rows = result.text.split('\n');
      expect(rows[2]).toBe('  if (!job) return undefined;\r');
      expect(rows[3]).toBe('  // two rows\r');
      expect(rows.slice(0, -1).every((row) => row.endsWith('\r'))).toBe(true);
      expect(rows[rows.length - 1]).toBe('};');
    }
    // No trailing newline: the last line carries no CR, so the new last line carries none.
    const short = 'alpha\r\nbeta\r\ngamma';
    read(short);
    expect(applied('PUT 3:\n-gamma\n+GAMMA', short)).toBe('alpha\r\nbeta\r\nGAMMA');
    // A last line that ends in a bare CR is the file's own, and an edit above it leaves it alone.
    const bareTail = 'alpha\r\nbeta\r';
    read(bareTail);
    expect(applied('PUT 1:\n-alpha\n+ALPHA', bareTail)).toBe('ALPHA\r\nbeta\r');
    // Appending after the last line of a CRLF file that ends in a newline.
    const ending = 'alpha\r\nbeta\r\n';
    read(ending);
    expect(applied('PUT >2:\n-beta\n+gamma', ending)).toBe('alpha\r\nbeta\r\ngamma\r\n');
    // A file that already mixes its endings is left to mix them.
    const mixed = 'alpha\r\nbeta\ngamma\r\n';
    read(mixed);
    expect(applied('PUT 2:\n-beta\n+BETA', mixed)).toBe('alpha\r\nBETA\ngamma\r\n');
  });

  it('refuses a whole quote whose corrected range runs past the lines shown', () => {
    recordRead(TASK, PATH, 1, toLines(FILE).slice(0, 4).join('\n'));
    // Quoting lines 4 and 5 under PUT 3.=4: the correction would end on 5, never displayed.
    const message = refused('PUT 3.=4:\n-  return job.payload;\n-};\n+  merged;');
    expect(message).toMatch(/4-5 runs past the lines you have been shown/);
    expect(message).toMatch(/3: {2}if \(!job\) return null;/);
  });

  it('refuses a whole quote that matches the live file where the ledger read differently', () => {
    read();
    const drifted = toLines(FILE)
      .map((line, index) => (index === 4 ? '}; // rewritten' : line))
      .join('\n');
    const message = refused('PUT 3.=4:\n-  return job.payload;\n-}; // rewritten\n+  x;', drifted);
    expect(message).toMatch(/did not read that way when you read it/);
    expect(message).toMatch(/5:}; \/\/ rewritten/);
  });

  it('refuses a whole quote that disagrees with where the ledger followed the lines', () => {
    read();
    const shifted = `// added\n// added\n${FILE}`;
    const message = refused('PUT 3.=4:\n-  return job.payload;\n-};\n+  x;', shifted);
    expect(message).toMatch(/had moved to 5-6/);
    expect(message).toMatch(/5: {2}if \(!job\) return null;/);
  });
});

describe('the block scanner', () => {
  it('finds a braced block and says it closed', () => {
    const found = blockAt(toLines(FILE), 0);
    expect(found).toEqual({ from: 0, to: 4, closed: true });
  });

  it('claims nothing, and says so, when the brackets never balance', () => {
    expect(blockAt(['function f() {', '  return 1;'], 0)).toEqual({
      from: 0,
      to: 0,
      closed: false
    });
  });

  it('finds an indented suite with no brackets at all', () => {
    expect(blockAt(['def f():', '    return 1', '', 'x = 2'], 0)).toEqual({
      from: 0,
      to: 1,
      closed: true
    });
  });
});

describe('the parser, on its own', () => {
  it('reports the row of the failure, so a message can point at it', () => {
    const result = parseEdit('PUT 3:\n+a\nNOT AN OP');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.row).toBe(3);
  });

  it('refuses a body with no operation above it', () => {
    const result = parseEdit('+a\n+b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toMatch(/no operation above it/);
  });

  it('refuses an empty patch rather than writing an empty file', () => {
    const result = parseEdit('   \n\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toMatch(/no operations in it/);
  });
});
