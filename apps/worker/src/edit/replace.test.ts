import { describe, expect, it } from 'vitest';
import { applyReplacements } from './replace.js';

const FILE = 'const a = 1;\nconst b = 2;  \nconst c = 3;\nconst b2 = 2;\n';

describe('exact-text replacement', () => {
  it('replaces a unique quote and reports the changed line span', () => {
    const result = applyReplacements(
      'f.ts',
      [{ oldText: 'const c = 3;', newText: 'const c = 4;' }],
      FILE
    );
    expect(result).toMatchObject({ ok: true, replaced: 1 });
    if (!result.ok) return;
    expect(result.text).toBe(FILE.replace('const c = 3;', 'const c = 4;'));
    expect(result.changed).toEqual([{ oldFrom: 3, oldTo: 3, newFrom: 3, newTo: 3 }]);
  });

  it('applies several replacements in order as one result', () => {
    const result = applyReplacements(
      'f.ts',
      [
        { oldText: 'const a = 1;', newText: 'const a = 10;' },
        { oldText: 'const a = 10;\n', newText: 'const a = 10;\nconst z = 0;\n' }
      ],
      FILE
    );
    expect(result.ok && result.text.startsWith('const a = 10;\nconst z = 0;\nconst b')).toBe(true);
  });

  it('refuses an ambiguous quote and names the lines, unless replaceAll is set', () => {
    const ambiguous = applyReplacements('f.ts', [{ oldText: ' = 2', newText: ' = 5' }], FILE);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.ok ? '' : ambiguous.reason).toMatch(/occurs 2 times \(lines 2, 4\)/);
    const all = applyReplacements(
      'f.ts',
      [{ oldText: ' = 2', newText: ' = 5', replaceAll: true }],
      FILE
    );
    expect(all.ok && all.text.match(/= 5/g)).toHaveLength(2);
  });

  it('accepts a quote copied with the display line numbers or without trailing spaces', () => {
    const numbered = applyReplacements(
      'f.ts',
      [{ oldText: '1:const a = 1;\n2:const b = 2;  ', newText: 'x' }],
      FILE
    );
    expect(numbered.ok && numbered.text.startsWith('x\nconst c')).toBe(true);
    const trimmed = applyReplacements(
      'f.ts',
      [{ oldText: 'const b = 2;\nconst c = 3;', newText: 'y' }],
      FILE
    );
    expect(trimmed.ok && trimmed.text).toBe('const a = 1;\ny\nconst b2 = 2;\n');
  });

  it('refuses a missing quote, an empty quote and a no-op, and writes nothing', () => {
    for (const replacement of [
      { oldText: 'const d = 4;', newText: 'x' },
      { oldText: '', newText: 'x' },
      { oldText: 'const a = 1;', newText: 'const a = 1;' }
    ])
      expect(applyReplacements('f.ts', [replacement], FILE).ok).toBe(false);
  });

  it('treats replacement text literally, including $ patterns', () => {
    const result = applyReplacements(
      'f.ts',
      [{ oldText: 'const a = 1;', newText: "s.replace('$&', '$1')" }],
      FILE
    );
    expect(result.ok && result.text.split('\n')[0]).toBe("s.replace('$&', '$1')");
  });
});
