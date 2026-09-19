import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

const blocks = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript'
]);
const elements = new Set([
  'p',
  'div',
  'span',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  's',
  'u',
  'sub',
  'sup',
  'ul',
  'ol',
  'li',
  'blockquote',
  'dl',
  'dt',
  'dd'
]);
const empty = new Set(['br', 'hr', 'col']);
const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rebuild static formatting only: no URL, event, style, form or navigation attributes survive. */
export function notebookHtml(source: string): { html: string; limited: boolean } {
  const fragment = parseFragment(source);
  let remaining = 20000;
  let limited = false;
  const render = (node: DefaultTreeAdapterMap['childNode'], depth: number): string => {
    if (--remaining < 0 || depth > 80) {
      limited = true;
      return '';
    }
    if (node.nodeName === '#text' && 'value' in node) return escape(node.value);
    if (!('tagName' in node) || blocks.has(node.tagName)) return '';
    if (node.tagName === 'img') {
      const alt = node.attrs.find((attribute) => attribute.name === 'alt')?.value;
      return escape(alt ? `[${alt}]` : '[Image omitted]');
    }
    const children = node.childNodes.map((child) => render(child, depth + 1)).join('');
    if (!elements.has(node.tagName)) return children;
    const attrs = node.attrs
      .filter(
        (attribute) =>
          ['td', 'th'].includes(node.tagName) &&
          ['colspan', 'rowspan'].includes(attribute.name) &&
          /^[1-9]\d{0,2}$/.test(attribute.value)
      )
      .map(({ name, value }) => ` ${name}="${value}"`)
      .join('');
    return `<${node.tagName}${attrs}>${empty.has(node.tagName) ? '' : `${children}</${node.tagName}>`}`;
  };
  return { html: fragment.childNodes.map((node) => render(node, 0)).join(''), limited };
}
