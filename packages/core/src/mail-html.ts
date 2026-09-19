import { SAXParser } from 'parse5-sax-parser';

const omitted = new Set(['script', 'style', 'title', 'template']);
const blocks = new Set([
  'p',
  'div',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'table',
  'section',
  'article',
  'ul',
  'ol'
]);
const targetOf = (value: string | undefined): string => {
  const target = value?.trim() ?? '';
  if (!target || Array.from(target).some((character) => character < ' ' || character === '\u007f'))
    return '';
  try {
    const parsed = new URL(target, 'https://relative-link.invalid/');
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(parsed.protocol) ? target : '';
  } catch {
    return '';
  }
};

/** Token streaming preserves destinations and decoded text without fetching resources or building a DOM. */
export function htmlToText(html: string): string {
  const parser = new SAXParser();
  const chunks: string[] = [];
  let suppressed: { tag: string; depth: number } | undefined;
  let anchor: { target: string; text: string } | undefined;
  const append = (text: string) => {
    if (!text) return;
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last]!.length + text.length < 8192) chunks[last] += text;
    else chunks.push(text);
  };
  const trackAnchorText = (text: string) => {
    // One extra character is enough to establish that the label is not the bare destination.
    if (anchor && anchor.text.length <= anchor.target.length)
      anchor.text += text.slice(0, anchor.target.length + 1 - anchor.text.length);
  };
  const finishAnchor = () => {
    if (anchor?.target && anchor.text.trim() !== anchor.target)
      append(anchor.text.trim() ? ` (${anchor.target})` : anchor.target);
    anchor = undefined;
  };
  parser.on('startTag', ({ tagName, attrs }) => {
    if (suppressed) {
      if (tagName === suppressed.tag) suppressed.depth++;
      return;
    }
    if (omitted.has(tagName)) {
      suppressed = { tag: tagName, depth: 1 };
      return;
    }
    if (tagName === 'a') {
      finishAnchor();
      anchor = { target: targetOf(attrs.find((attr) => attr.name === 'href')?.value), text: '' };
    }
    if (tagName === 'br') append('\n');
    if (tagName === 'li') append('\n- ');
    if (blocks.has(tagName)) append('\n\n');
    if (tagName === 'img') {
      const alt = attrs.find((attr) => attr.name === 'alt')?.value;
      if (alt) {
        append(alt);
        trackAnchorText(alt);
      }
    }
  });
  parser.on('endTag', ({ tagName }) => {
    if (suppressed) {
      if (tagName === suppressed.tag && --suppressed.depth === 0) suppressed = undefined;
      return;
    }
    if (tagName === 'a') finishAnchor();
    if (blocks.has(tagName)) append('\n\n');
    if (['td', 'th'].includes(tagName)) append(' ');
  });
  parser.on('text', ({ text }) => {
    if (suppressed) return;
    append(text);
    trackAnchorText(text);
  });
  parser.end(html);
  finishAnchor();
  parser.destroy();
  return chunks
    .join('')
    .replaceAll(/[ \t\u00a0]+/g, ' ')
    .replaceAll(/ *\n */g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}
