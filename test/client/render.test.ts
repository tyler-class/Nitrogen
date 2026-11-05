import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { Markdown } from '../../src/client/components/Markdown';

const render = (source: string) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(Markdown, {
        source,
        titles: new Map([['search notes', { id: 'x1', title: 'Search Notes' }]]),
      }),
    ),
  );

describe('Markdown', () => {
  it('renders wikilinks, missing pages and #tags with their classes', () => {
    const html = render('See [[Search Notes]], [[Nope]] and #ideas.');
    expect(html).toContain('<a class="wikilink" href="/p/x1/search-notes"');
    expect(html).toContain('class="wikilink missing"');
    expect(html).toContain('<a class="tag" href="/tags/ideas"');
  });
});
