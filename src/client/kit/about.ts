// Selfhost Kit: the About sheet's words and links, the same in every app.
// Synced from tyler-class/selfhost-kit (kit/client/about.ts). Edit it there, not here.
//
// Every app's About sheet: title "About <App>", "Version x.y.z" under it, the app's own
// one-paragraph description, BUILT_BY, then these links in this order, each a full-width row
// whose label underlines on hover. No update actions here: those live in Settings → Updates.

export const BUILT_BY = 'Built by Tyler Class.';

export type AboutLinkKind = 'github' | 'email' | 'coffee' | 'site';

/** The About links' icons (HSA Locker's), as SVG markup on a 24px grid, stroke 1.6, round caps.
 *  Every app draws these, not its own icon set, so the four look identical everywhere. */
export const ABOUT_ICONS: Record<AboutLinkKind, string> = {
  github:
    '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6 8.5-6"/>',
  coffee:
    '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3.5v2.5M12 3.5v2.5"/>',
  site: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};

export interface AboutLink {
  kind: AboutLinkKind;
  href: string;
  label: string;
  /** Opens in a new tab (everything but email). */
  external: boolean;
}

/** The About links for an app, e.g. aboutLinks({ title: 'Duffel', repo: 'tyler-class/Duffel', email: 'duffel@tylerclass.net' }). */
export function aboutLinks(o: {
  title: string;
  repo: string;
  email?: string;
  /** The app's own short, witty coffee line (one line on desktop), instead of the standard one. */
  coffee?: string;
}): AboutLink[] {
  const links: AboutLink[] = [
    {
      kind: 'github',
      href: `https://github.com/${o.repo}`,
      label: `${o.title} on GitHub`,
      external: true,
    },
  ];
  if (o.email)
    links.push({
      kind: 'email',
      href: `mailto:${o.email}`,
      label: `Questions or help? ${o.email}`,
      external: false,
    });
  links.push(
    {
      kind: 'coffee',
      href: 'https://ko-fi.com/tylerclass',
      // Short enough for one line in the sheet on a desktop.
      label: o.coffee ?? `${o.title} is free. Buy me a coffee ☕`,
      external: true,
    },
    { kind: 'site', href: 'https://tylerclass.net', label: 'tylerclass.net', external: true },
  );
  return links;
}
