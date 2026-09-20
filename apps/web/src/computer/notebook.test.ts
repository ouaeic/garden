import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  NOTEBOOK_PREVIEW_BYTES,
  notebookAttachments,
  notebookImage,
  notebookText,
  parseNotebook,
  readNotebookResponse
} from './notebook';
import { notebookHtml } from './notebook-html';
import { NotebookDocument } from './NotebookPreview';
import Markdown from '../MarkdownBody';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l5kAAAAASUVORK5CYII=';
const render = (cells: unknown[]) => {
  const content = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python' } },
    cells
  });
  return renderToStaticMarkup(
    createElement(NotebookDocument, { notebook: parseNotebook(content), content })
  );
};

describe('recorded notebook cells', () => {
  it('reads split lines, unknown metadata and an empty notebook without inventing execution', () => {
    expect(notebookText(['a\n', 'b'])).toBe('a\nb');
    expect(notebookText(['a', 2])).toBeNull();
    const html = render([]);
    expect(html).toContain('0 cells');
    expect(html).toContain('Python');
    expect(html).toContain('Saved outputs may be stale');
    expect(html).toContain('This notebook has no cells');
  });

  it('renders Markdown, code, raw text, streams, JSON and images from real output shapes', () => {
    const html = render([
      { cell_type: 'markdown', source: ['# Analysis\n', 'A **recorded** result'], metadata: {} },
      { cell_type: 'raw', source: '<raw data>', metadata: {} },
      {
        cell_type: 'code',
        source: ['print(42)'],
        execution_count: 7,
        metadata: {},
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['Answer: ', '42\n'] },
          { output_type: 'display_data', data: { 'application/json': { gc: 0.44 } }, metadata: {} },
          {
            output_type: 'execute_result',
            execution_count: 7,
            data: { 'image/png': png, 'text/plain': 'GC plot' },
            metadata: {}
          }
        ]
      }
    ]);
    expect(html).toContain('<h1>Analysis</h1>');
    expect(html).toContain('<strong>recorded</strong>');
    expect(html).toContain('&lt;raw data&gt;');
    expect(html).toContain('Execution 7');
    expect(html).toContain('Answer: 42');
    expect(html).toContain('&quot;gc&quot;: 0.44');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('GC plot');
  });

  it('retains malformed cells, unknown outputs and error records visibly', () => {
    const html = render([
      { cell_type: 'future', source: 'retained-unknown' },
      null,
      { cell_type: 'code', source: 123, outputs: [] },
      {
        cell_type: 'code',
        source: '',
        outputs: [
          { output_type: 'future_output', payload: 'retained-output' },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'bad',
            traceback: ['Traceback:', 'ValueError: bad']
          }
        ]
      },
      { cell_type: 'code', source: '', outputs: 'malformed' }
    ]);
    expect(html).toContain('retained-unknown');
    expect(html).toContain('retained-output');
    expect(html).toContain('Cell source is missing or malformed');
    expect(html).toContain('Recorded error');
    expect(html).toContain('ValueError: bad');
    expect(html).toContain('no valid output list');
  });

  it('bounds the initial cell, output and source rendering and defers hidden JSON', () => {
    const cells = Array.from({ length: 45 }, (_, index) => ({
      cell_type: 'code',
      source: `source-${index}-` + 'x'.repeat(40000),
      outputs: Array.from({ length: 30 }, (_, output) => ({
        output_type: 'stream',
        text: `stream-${index}-${output}`
      }))
    }));
    const html = render(cells);
    expect(html.match(/<article /g)).toHaveLength(20);
    expect(html).toContain('Page 1 of 3');
    expect(html).toContain('stream-0-9');
    expect(html).not.toContain('stream-0-10');
    expect(html).not.toContain('source-20-');
    const renderedSources = Array.from(html.matchAll(/<code>(source-\d+-x+)<\/code>/g));
    expect(renderedSources).toHaveLength(20);
    for (const source of renderedSources) expect(source[1]).toHaveLength(16000);
    expect(html).not.toContain('&quot;cell_type&quot;');
  });

  it('rejects invalid and unsupported envelopes explicitly', () => {
    for (const text of [
      'null',
      '[]',
      '{"nbformat":3,"worksheets":[]}',
      '{"nbformat":4,"cells":{}}'
    ])
      expect(() => parseNotebook(text)).toThrow('version-4');
    expect(() => parseNotebook('{"nbformat":4')).toThrow('valid JSON');
  });
});

describe('bounded authenticated notebook responses', () => {
  it('decodes a UTF-8 character split across stream chunks', async () => {
    const bytes = new TextEncoder().encode('β-analysis');
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1));
          controller.close();
        }
      })
    );
    expect(await readNotebookResponse(response)).toBe('β-analysis');
  });
  it('cancels an oversized declared body before reading it', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(NOTEBOOK_PREVIEW_BYTES + 1) }
    });
    await expect(readNotebookResponse(response)).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('enforces actual bytes when the declared size is wrong', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(NOTEBOOK_PREVIEW_BYTES + 1));
        },
        cancel
      }),
      { headers: { 'content-length': '1' } }
    );
    await expect(readNotebookResponse(response)).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not substitute damaged UTF-8 or partial transport results', async () => {
    await expect(readNotebookResponse(new Response(new Uint8Array([0xff])))).rejects.toThrow();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('Disconnected'));
        }
      })
    );
    await expect(readNotebookResponse(response)).rejects.toThrow('Disconnected');
    await expect(readNotebookResponse(new Response(null, { status: 401 }))).rejects.toThrow();
  });
});

describe('inert embedded notebook content', () => {
  it('only admits bounded embedded PNG/JPEG images with matching signatures', () => {
    expect(notebookImage({ 'image/png': [png.slice(0, 12), '\n', png.slice(12)] })).toBe(
      `data:image/png;base64,${png}`
    );
    expect(notebookImage({ 'image/jpeg': '/9j/4AAQSkZJRg==' })).toContain('data:image/jpeg;');
    for (const bundle of [
      { 'image/svg+xml': '<svg onload="alert(1)"/>' },
      { 'image/png': '/9j/4AAQSkZJRg==' },
      { 'image/png': 'https://example.com/a.png' },
      { 'image/png': png + 'A'.repeat(6000000) }
    ])
      expect(notebookImage(bundle)).toBeNull();
  });
  it('renders named attachments but never fetches notebook Markdown images', () => {
    const images = notebookAttachments({ 'plot.png': { 'image/png': png } });
    expect(images.size).toBe(1);
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        children:
          '![plot](attachment:plot.png) ![remote](https://example.com/tracker) ![local](/v1/private) ![protocol-relative](//example.com/tracker)',
        imageSources: images
      })
    );
    expect(html).toContain('data:image/png;base64,');
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).not.toContain('example.com');
    expect(html).not.toContain('/v1/private');
    expect(html).toContain('image unavailable');
  });
  it('does not turn a protocol-relative image into a remote fetch in ordinary Markdown', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { children: '![remote](//example.com/tracker)' })
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('<a ');
  });
  it('preserves table structure and escaped text while removing active HTML and navigations', () => {
    const result = notebookHtml(
      '<meta http-equiv="refresh" content="0;url=https://example.com"><script>steal()</script><style>@import "https://example.com";</style><base href="https://example.com"><table style="background:url(https://example.com)"><tr><th colspan="2" onclick="steal()">A &amp; B</th></tr><tr><td>&lt;script&gt;</td><td><a href="https://example.com">Link text</a></td></tr></table><img src="https://example.com" onerror="steal()" alt="plot"><iframe srcdoc="bad"></iframe><svg><a>bad</a></svg><form action="https://example.com"><input autofocus onfocus="steal()"></form>'
    );
    expect(result.limited).toBe(false);
    expect(result.html).toContain('<th colspan="2">A &amp; B</th>');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('Link text');
    expect(result.html).not.toMatch(
      /example\.com|steal|<script|<meta|<base|<img|<iframe|<svg|<form|<input|onfocus|onclick|style=/
    );
  });
  it('bounds deeply nested HTML rather than overflowing the rendering stack', () => {
    expect(notebookHtml('<div>'.repeat(200) + 'nested' + '</div>'.repeat(200)).limited).toBe(true);
  });
});
