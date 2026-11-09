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

  it('shows an item’s due time and takes "due:…" out of its text', () => {
    const html = render(
      '- [ ] reminder: Call the dentist due:2026-11-12 14:00\n- [ ] todo: Plain due:2026-11-12',
    );
    expect(html).not.toContain('due:2026');
    expect(html).not.toContain('14:00</');
    expect(html).toMatch(/Nov 12(, 2026)?, 2:00\s?PM/);
    expect(html).toMatch(/Due Nov 12(, 2026)?<\/span>/);
  });
});
