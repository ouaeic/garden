import { describe, expect, it } from 'vitest';
import { htmlToText } from './mail-html.js';

describe('readable HTML mail', () => {
  it('preserves application destinations, image-only links and character references exactly once', () => {
    expect(
      htmlToText(
        '<p>Apply <a title="x > y" href="https://jobs.example/apply?a=1&amp;b=2">here</a>.</p><a href="https://docs.example/file"><img alt="Document" src="https://tracking.invalid/pixel"></a>'
      )
    ).toBe(
      'Apply here (https://jobs.example/apply?a=1&b=2).\n\nDocument (https://docs.example/file)'
    );
    expect(htmlToText('<a href="https://example.org/?x=&amp;amp;">A &amp;amp; B</a>')).toBe(
      'A &amp; B (https://example.org/?x=&amp;)'
    );
    expect(htmlToText('<a href=https://example.org/>https://example.org/</a>')).toBe(
      'https://example.org/'
    );
    expect(htmlToText('trailing plain text &copy;')).toBe('trailing plain text ©');
  });
  it('keeps mismatched labels explicit and relative links unguessed, while omitting executable destinations', () => {
    expect(htmlToText('<a href="https://other.example/">https://display.example/</a>')).toBe(
      'https://display.example/ (https://other.example/)'
    );
    expect(htmlToText('<a href="../apply">Apply</a>')).toBe('Apply (../apply)');
    expect(
      htmlToText(
        '<a href="javascript:alert(1)">Open</a> <a href="data:text/html,secret">Data</a> <a href="file:///private">File</a>'
      )
    ).toBe('Open Data File');
    expect(htmlToText('<a href="mailto:person@example.org">Contact</a>')).toBe(
      'Contact (mailto:person@example.org)'
    );
  });
  it('handles malformed anchors and nested inline markup without losing link targets', () => {
    expect(htmlToText('<p><a href="https://example.org"><b>Open</b> the document')).toBe(
      'Open the document (https://example.org)'
    );
    expect(
      htmlToText(
        '<script>"<a href=https://bad.invalid>bad</a>"</script><style>bad</style><p>Good</p><!--bad-->'
      )
    ).toBe('Good');
    expect(
      htmlToText('<template>Hidden <template>nested</template> still hidden</template> Visible')
    ).toBe('Visible');
  });
  it('retains a complete large message and deep markup without recursive traversal', () => {
    const body = 'content '.repeat(200_000);
    const output = htmlToText(
      '<div>'.repeat(3000) +
        body +
        '<a href="https://last.example/">Last</a>' +
        '</div>'.repeat(3000)
    );
    expect(output).toBe(body + 'Last (https://last.example/)');
  });
});
