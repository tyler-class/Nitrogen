import GithubSlugger, { slug as ghSlug } from 'github-slugger';

/** GitHub-compatible heading slug (no de-duplication). */
export function slugify(text: string): string {
  return ghSlug(text);
}

/** Stateful slugger that de-duplicates like GitHub (`a`, `a-1`, `a-2`). */
export function createSlugger(): { slug(text: string): string } {
  const s = new GithubSlugger();
  return { slug: (t: string) => s.slug(t) };
}
