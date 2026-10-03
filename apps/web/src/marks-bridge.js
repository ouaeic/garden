/*
 * Where a comment points, worked out from the content itself, and where to draw it again.
 *
 * One file, two homes. The interface imports it to comment on what it renders itself, and the same
 * source runs inside a drawn view's frame and inside a live app (the preview gateway adds it to the
 * app's page), so a pin means one thing everywhere. Anchors are words and structure, never pixels:
 * a point records the element under it, that element's own words and the heading it sits under.
 * The pin finds its way back after a scroll, a resize or a re-render, and the model reads where it
 * is without being shown a picture.
 */

const MEANINGFUL =
  'a,button,img,input,select,textarea,td,th,li,dt,dd,h1,h2,h3,h4,h5,h6,p,label,figcaption,caption,legend,blockquote,pre,code,text,[role],[aria-label],[data-label],[title]';
const HEADING = 'h1,h2,h3,h4,h5,h6,legend,caption,figcaption,[role="heading"]';
const MEDIA = new Set(['img', 'canvas', 'video', 'iframe', 'svg', 'object', 'embed']);
const OURS = '[data-garden-pins],[data-garden-ui]';

const squish = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
const flat = (text, limit) => {
  const line = squish(text);
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const tag = (element) => element.tagName.toLowerCase();
const isSvg = (element) => element.namespaceURI === 'http://www.w3.org/2000/svg';

/** The element's own words: what a person would call it. */
export function labelOf(element) {
  if (!element || element.nodeType !== 1) return '';
  const named =
    element.getAttribute('data-label') ||
    element.getAttribute('aria-label') ||
    element.getAttribute('alt') ||
    element.getAttribute('title') ||
    (/^(input|select|textarea)$/.test(tag(element))
      ? element.value || element.getAttribute('placeholder')
      : '');
  if (named) return flat(named, 160);
  if (isSvg(element)) {
    // A chart's marks have no words of their own; its tick labels are not theirs to borrow.
    const title = [...element.children].find((child) => tag(child) === 'title');
    if (title) return flat(title.textContent, 160);
    return /^(text|tspan)$/.test(tag(element)) ? flat(element.textContent, 160) : '';
  }
  if (MEDIA.has(tag(element))) return '';
  return flat(element.innerText ?? element.textContent, 160);
}

function columnHeader(cell) {
  const table = cell.closest('table');
  if (!table || !cell.parentElement) return '';
  const index = [...cell.parentElement.children].indexOf(cell);
  const head = table.querySelector('thead tr') || table.querySelector('tr');
  const header = head && head.children[index];
  return header && header !== cell ? labelOf(header) : '';
}

/** The heading or label this element sits under, read upwards through the document. */
export function contextOf(element, root) {
  const cell = element.closest('td,th');
  if (cell && root.contains(cell)) {
    const header = columnHeader(cell);
    if (header) return flat(header, 200);
  }
  for (let node = element; node && node !== root; node = node.parentElement) {
    if (node !== element && node.matches(HEADING)) return flat(labelOf(node), 200);
    for (
      let sibling = node.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    ) {
      if (sibling.matches(HEADING)) return flat(labelOf(sibling), 200);
      const inner = sibling.querySelectorAll(HEADING);
      if (inner.length) return flat(labelOf(inner[inner.length - 1]), 200);
    }
    const named =
      node !== element && (node.getAttribute('aria-label') || node.getAttribute('data-label'));
    if (named) return flat(named, 200);
  }
  return '';
}

/** A selector from the root to the element, short enough to read and exact enough to resolve. */
export function pathOf(element, root) {
  const parts = [];
  for (let node = element; node && node !== root && parts.length < 8; node = node.parentElement) {
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const parent = node.parentElement;
    const same = parent
      ? [...parent.children].filter((child) => child.tagName === node.tagName)
      : [];
    const classes = [...node.classList]
      .filter((name) => /^[A-Za-z][\w-]*$/.test(name))
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('');
    const name = isSvg(node) ? tag(node) : `${tag(node)}${classes}`;
    parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(node) + 1})` : name);
  }
  return parts.join(' > ');
}

const query = (root, selector) => {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
};

/** The element a path names, or failing that the one that still says the same words. */
function resolve(root, path, label) {
  const found = path ? query(root, `:scope > ${path}`) || query(root, path) : null;
  if (found && (!label || labelOf(found) === label)) return found;
  if (label)
    for (const candidate of root.querySelectorAll('*'))
      if (!candidate.closest(OURS) && labelOf(candidate) === label) return candidate;
  return found;
}

const clamp = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const within = (box, x, y) => ({
  x: Math.round(clamp((x - box.left) / (box.width || 1)) * 1000) / 1000,
  y: Math.round(clamp((y - box.top) / (box.height || 1)) * 1000) / 1000
});

/** The nearest thing worth naming: what is under the pointer, or what contains it. */
function meaningful(hit, root) {
  for (let node = hit; node && node !== root; node = node.parentElement) {
    if (MEDIA.has(tag(node)) && !isSvg(node.parentElement || node)) return node;
    if (node.matches(MEANINGFUL) && labelOf(node)) return node;
  }
  for (let node = hit; node && node !== root; node = node.parentElement)
    if (labelOf(node)) return node;
  return hit;
}

/** What a press at a point inside the root refers to. */
export function anchorAt(root, clientX, clientY) {
  const hit = root.ownerDocument.elementFromPoint(clientX, clientY);
  if (!hit || !root.contains(hit) || hit === root || hit.closest(OURS)) return null;
  const page = hit.closest('[data-page]');
  if (page && root.contains(page)) {
    const near = flat(hit === page ? '' : labelOf(hit), 300);
    return {
      kind: 'page',
      page: Number(page.getAttribute('data-page')) || 1,
      ...within(page.getBoundingClientRect(), clientX, clientY),
      ...(near ? { text: near } : {})
    };
  }
  const cell = hit.closest('td');
  const body = cell && cell.closest('tbody');
  if (cell && body && root.contains(body)) {
    const index = [...cell.parentElement.children].indexOf(cell);
    return {
      kind: 'cell',
      row: Math.max(0, [...body.rows].indexOf(cell.parentElement)),
      column: flat(columnHeader(cell) || `column ${index + 1}`, 200),
      value: flat(labelOf(cell), 500)
    };
  }
  const element = meaningful(hit, root);
  const box = element.getBoundingClientRect();
  const label = labelOf(element);
  // On a picture, where within it is the point; its caption says nothing about which part.
  if (!label || MEDIA.has(tag(element)))
    return { kind: 'spot', path: pathOf(element, root), ...within(box, clientX, clientY) };
  const context = contextOf(element, root);
  return {
    kind: 'point',
    path: pathOf(element, root),
    label,
    ...(context && context !== label ? { context } : {}),
    ...within(box, clientX, clientY)
  };
}

const around = (root, range, toEnd) => {
  try {
    const probe = root.ownerDocument.createRange();
    probe.selectNodeContents(root);
    if (toEnd) probe.setStart(range.endContainer, range.endOffset);
    else probe.setEnd(range.startContainer, range.startOffset);
    const text = squish(probe.toString());
    return toEnd ? text.slice(0, 80) : text.slice(-80);
  } catch {
    return '';
  }
};

/** A highlighted passage, with a little either side so a repeated phrase finds its own place. */
export function anchorForRange(root, range) {
  const quote = squish(range.toString()).slice(0, 4000);
  if (!quote || !root.contains(range.commonAncestorContainer)) return null;
  const node = range.commonAncestorContainer;
  if ((node.nodeType === 1 ? node : node.parentElement)?.closest(OURS)) return null;
  const before = around(root, range, false);
  const after = around(root, range, true);
  return { kind: 'text', quote, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** The live range a text anchor refers to, preferring the occurrence its context matches. */
export function rangeFor(root, anchor) {
  const doc = root.ownerDocument;
  const nodes = [];
  let text = '';
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement && node.parentElement.closest(`${OURS},script,style`)) continue;
    nodes.push({ node, start: text.length });
    text += node.nodeValue;
  }
  // Searched with runs of white space folded, as the quote was, mapped back to real offsets.
  const map = [];
  let folded = '';
  for (let index = 0; index < text.length; index++) {
    const space = /\s/.test(text[index]);
    if (space && index > 0 && /\s/.test(text[index - 1])) continue;
    map.push(index);
    folded += space ? ' ' : text[index];
  }
  const quote = anchor.quote;
  const tail = (anchor.before || '').slice(-24);
  let best = -1;
  for (let at = folded.indexOf(quote); at >= 0; at = folded.indexOf(quote, at + 1)) {
    if (best < 0) best = at;
    if (tail && folded.slice(Math.max(0, at - tail.length - 4), at).includes(tail)) {
      best = at;
      break;
    }
  }
  if (best < 0) return null;
  const place = (index) => {
    for (let i = nodes.length - 1; i >= 0; i--)
      if (nodes[i].start <= index)
        return {
          node: nodes[i].node,
          offset: Math.min(index - nodes[i].start, nodes[i].node.nodeValue.length)
        };
    return null;
  };
  const start = place(map[best]);
  const end = place(map[best + quote.length - 1] + 1);
  if (!start || !end) return null;
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

const found = new Map();
/** Forgets where anchors were found; called when the content changes under them. */
export function forget() {
  found.clear();
}
const cached = (root, anchor, locate) => {
  const key = JSON.stringify(anchor);
  const hit = found.get(key);
  const alive =
    hit &&
    (hit.collapsed === undefined
      ? root.contains(hit)
      : !hit.collapsed && root.contains(hit.startContainer));
  if (alive) return hit;
  const fresh = locate();
  if (fresh) found.set(key, fresh);
  return fresh;
};

const at = (element, x, y) => {
  const box = element.getBoundingClientRect();
  return { x: box.left + x * box.width, y: box.top + y * box.height, node: element };
};

/** Where an anchor's pin goes now, in viewport coordinates, with the node it hangs from. */
export function placeOf(root, anchor) {
  if (!anchor) return null;
  if (anchor.kind === 'text') {
    const range = cached(root, anchor, () => rangeFor(root, anchor));
    if (!range) return null;
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] || range.getBoundingClientRect();
    const end = range.endContainer;
    return {
      x: last.right,
      y: last.top,
      node: end.nodeType === 1 ? end : end.parentElement,
      range
    };
  }
  if (anchor.kind === 'point' || anchor.kind === 'spot') {
    const element = cached(root, anchor, () => resolve(root, anchor.path, anchor.label));
    return element ? at(element, anchor.x, anchor.y) : null;
  }
  if (anchor.kind === 'cell') {
    const cell = cached(root, anchor, () => {
      const row = root.querySelectorAll('tbody tr')[anchor.row];
      if (!row) return null;
      const cells = [...row.children];
      return (
        cells.find((candidate) => flat(columnHeader(candidate), 200) === anchor.column) ||
        cells.find((candidate) => flat(labelOf(candidate), 500) === anchor.value) ||
        null
      );
    });
    if (!cell) return null;
    const box = cell.getBoundingClientRect();
    return { x: box.right - 6, y: box.top + 4, node: cell };
  }
  if (anchor.kind === 'page') {
    const page = cached(root, anchor, () => root.querySelector(`[data-page="${anchor.page}"]`));
    return page ? at(page, anchor.x, anchor.y) : null;
  }
  return null;
}

/** Whether a point on a node is on screen, rather than scrolled out of a box that holds it. */
export function shown(node, root, x, y) {
  const view = root.ownerDocument.defaultView;
  for (let box = node; box && box !== root.parentElement; box = box.parentElement) {
    const style = view.getComputedStyle(box);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (box === node || (style.overflowX === 'visible' && style.overflowY === 'visible')) continue;
    const rect = box.getBoundingClientRect();
    if (x < rect.left - 1 || x > rect.right + 1 || y < rect.top - 1 || y > rect.bottom + 1)
      return false;
  }
  return true;
}

/*
 * Inside a frame. The page that embeds this source sets `__gardenFrame` to 'view' or 'app' first;
 * imported by the interface, or opened anywhere but inside garden, nothing below runs.
 */
const mode = typeof window === 'undefined' ? '' : window.__gardenFrame;
if ((mode === 'view' || mode === 'app') && window.parent !== window) {
  const post = (message) => window.parent.postMessage({ garden: 1, ...message }, '*');
  const root = () => document.body || document.documentElement;
  let commenting = false;
  let pins = [];
  let focus = 0;
  const layer = document.createElement('div');
  layer.setAttribute('data-garden-pins', '');
  const style = document.createElement('style');
  style.textContent = `
[data-garden-pins]{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647}
[data-garden-pins] b{position:absolute;transform:translate(-1px,-100%);min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;display:grid;place-items:center;font:600 11px/1 ui-monospace,Menlo,monospace;color:var(--pin-paper);background:var(--pin-ink);border-radius:9px 9px 9px 0;box-shadow:0 0 0 1px var(--pin-paper);pointer-events:auto;cursor:default}
[data-garden-pins] b.is-focus{box-shadow:0 0 0 1px var(--pin-paper),0 0 0 4px var(--pin-ink)}
::highlight(garden-comments){background-color:color-mix(in srgb,var(--pin-ink,#18280f) 22%,transparent)}
html.garden-commenting,html.garden-commenting *{cursor:crosshair!important}`;
  const paint = (ink, paper) => {
    document.documentElement.style.setProperty('--pin-ink', ink || '#18280f');
    document.documentElement.style.setProperty('--pin-paper', paper || '#c4cf8f');
  };
  paint();
  let queued = false;
  const draw = () => {
    queued = false;
    if (!layer.isConnected) root().append(layer);
    const origin = layer.getBoundingClientRect();
    const badges = [];
    const ranges = [];
    for (const pin of pins) {
      const place = placeOf(root(), pin.anchor);
      if (!place || !shown(place.node, root(), place.x, place.y)) continue;
      const badge = document.createElement('b');
      badge.textContent = String(pin.n);
      badge.title = pin.text || '';
      badge.style.left = `${place.x - origin.left}px`;
      badge.style.top = `${place.y - origin.top}px`;
      if (pin.n === focus) badge.className = 'is-focus';
      badges.push(badge);
      if (place.range) ranges.push(place.range);
    }
    layer.replaceChildren(...badges);
    if (window.CSS && CSS.highlights && window.Highlight)
      CSS.highlights.set('garden-comments', new Highlight(...ranges));
  };
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };
  const size = () => {
    if (mode === 'view')
      post({
        type: 'height',
        value: Math.ceil(document.documentElement.getBoundingClientRect().height)
      });
  };
  const start = () => {
    document.head.append(style);
    root().append(layer);
    new ResizeObserver(() => {
      size();
      redraw();
    }).observe(document.documentElement);
    new MutationObserver((records) => {
      if (records.some((record) => record.target !== layer && !layer.contains(record.target))) {
        forget();
        redraw();
      }
    }).observe(root(), { childList: true, subtree: true, characterData: true });
    size();
    post({ type: 'ready' });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start);
  else start();
  addEventListener('load', size);
  addEventListener('scroll', redraw, true);
  addEventListener('resize', redraw);
  addEventListener('message', (event) => {
    const data = event.data || {};
    if (event.source !== window.parent || data.garden !== 1) return;
    if (data.type === 'unselect') getSelection()?.removeAllRanges();
    if (data.type !== 'comments') return;
    commenting = Boolean(data.commenting);
    document.documentElement.classList.toggle('garden-commenting', commenting);
    pins = Array.isArray(data.pins) ? data.pins : [];
    focus = Number(data.focus) || 0;
    paint(data.ink, data.paper);
    redraw();
  });
  const selecting = () => {
    const selection = getSelection();
    return selection && !selection.isCollapsed && selection.rangeCount ? selection : null;
  };
  const offer = () => {
    // A drawn view takes comments on its words at any time; an app only while commenting, since
    // selecting text is also how an app is used.
    if (mode === 'app' && !commenting) return;
    const selection = selecting();
    const anchor = selection && anchorForRange(root(), selection.getRangeAt(0));
    if (!anchor) return post({ type: 'unselect' });
    const box = selection.getRangeAt(0).getBoundingClientRect();
    post({ type: 'select', anchor, at: { x: box.right, y: box.bottom } });
  };
  const hold = (event) => {
    if (!commenting || (event.target.closest && event.target.closest(OURS))) return;
    event.stopPropagation();
    // Pressing still has to start a selection, so only what follows it is cancelled.
    if (event.type !== 'mousedown' && event.type !== 'pointerdown') event.preventDefault();
  };
  for (const type of [
    'pointerdown',
    'mousedown',
    'pointerup',
    'touchstart',
    'touchend',
    'dblclick'
  ])
    addEventListener(type, hold, true);
  addEventListener(
    'mouseup',
    (event) => {
      setTimeout(offer, 0);
      hold(event);
    },
    true
  );
  addEventListener('keyup', (event) => {
    if (event.shiftKey) offer();
  });
  addEventListener('keydown', (event) => {
    if (commenting && event.key === 'Escape') post({ type: 'escape' });
  });
  addEventListener(
    'click',
    (event) => {
      if (commenting) {
        hold(event);
        if (selecting() || (event.target.closest && event.target.closest(OURS))) return;
        const anchor = anchorAt(root(), event.clientX, event.clientY);
        if (anchor) post({ type: 'point', anchor, at: { x: event.clientX, y: event.clientY } });
        return;
      }
      if (mode !== 'view') return;
      const link = event.target.closest && event.target.closest('a[href]');
      const href = link && link.getAttribute('href');
      if (href && !href.startsWith('#')) {
        event.preventDefault();
        post({ type: 'open', href: link.href });
      }
    },
    true
  );
}
