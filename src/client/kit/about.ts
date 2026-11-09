// Selfhost Kit: the About sheet's words and links, the same in every app.
// Synced from tyler-class/selfhost-kit (kit/client/about.ts). Edit it there, not here.
//
// Every app's About sheet: title "About <App>", "Version x.y.z" under it, the app's own
// one-paragraph description, BUILT_BY, then these links in this order, each a full-width row
// whose label underlines on hover. No update actions here: those live in Settings → Updates.

export const BUILT_BY = 'Built by Tyler Class.';

export type AboutLinkKind = 'github' | 'email' | 'coffee' | 'site';

export interface AboutLink {
  kind: AboutLinkKind;
  href: string;
  label: string;
  /** Opens in a new tab (everything but email). */
  external: boolean;
}

/** The About links for an app, e.g. aboutLinks({ title: 'Duffel', repo: 'tyler-class/Duffel', email: 'duffel@tylerclass.net' }). */
export function aboutLinks(o: { title: string; repo: string; email?: string }): AboutLink[] {
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
      label: `${o.title} is free. Buy me a coffee ☕`,
      external: true,
    },
    { kind: 'site', href: 'https://tylerclass.net', label: 'tylerclass.net', external: true },
  );
  return links;
}
