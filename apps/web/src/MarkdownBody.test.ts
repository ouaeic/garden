import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Markdown from './MarkdownBody';

const render = (children: string, artifacts = [{ id: 'immutable-id', name: 'result.json' }]) =>
  renderToStaticMarkup(createElement(Markdown, { children, artifacts }));

describe('result Markdown links', () => {
  it('uses a source link in summaries while preserving inline images in document previews', () => {
    const children = '![Recorded plot](/v1/artifacts/immutable-id/content)';
    const summary = renderToStaticMarkup(createElement(Markdown, { children, imageMode: 'links' }));
    expect(summary).toContain('href="/v1/artifacts/immutable-id/content"');
    expect(summary).toContain('Recorded plot');
    expect(summary).not.toContain('<img');
    expect(render(children)).toContain('<img');
    expect(
      renderToStaticMarkup(
        createElement(Markdown, {
          children: '![Unsafe](javascript:alert%281%29)',
          imageMode: 'links'
        })
      )
    ).not.toContain('href=');
  });
  it('turns a known artifact reference into the authenticated immutable download route', () => {
    expect(render('[result.json](artifact:result.json)')).toContain(
      'href="/v1/artifacts/immutable-id/content"'
    );
    expect(render('[result](artifact:immutable-id)')).toContain(
      'href="/v1/artifacts/immutable-id/content"'
    );
  });
  it('does not turn missing or ambiguous artifacts into links to the home page', () => {
    expect(render('[result](artifact:unknown)')).not.toContain('<a ');
    expect(
      render('[result](artifact:result.json)', [
        { id: 'a', name: 'result.json' },
        { id: 'b', name: 'result.json' }
      ])
    ).not.toContain('<a ');
    expect(render('[result](artifact:result.json)', [])).not.toContain('<a ');
  });
  it('keeps unsafe protocols blocked and ordinary research links intact', () => {
    expect(render('[bad](javascript:alert%281%29)')).not.toContain('href=');
    expect(render('[source](https://example.com/paper)')).toContain(
      'href="https://example.com/paper"'
    );
    expect(render('![do not fetch](artifact:result.json)')).not.toContain('/v1/artifacts/');
  });
});
